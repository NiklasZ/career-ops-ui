/**
 * v1.33.0 (WS4) — `location_filter` support.
 *
 * `portals.yml` may carry an optional `location_filter` block. web-ui runs its
 * OWN in-process scanners (`en-scanner.mjs` / `ru-scanner.mjs`), so this module
 * implements the `buildLocationFilter` semantics directly and both scanners
 * gain the same behaviour.
 *
 * portals.yml:
 *   location_filter:
 *     always_allow: ["Zürich", "Switzerland"]
 *     allow:        ["Remote"]
 *     block:        ["US", "USA", "New York"]
 *     block_hard:   ["Brazil"]   # optional; always_allow cannot override it
 *
 * Semantics (verbatim from parent scan.mjs — this is the full 4-tier filter,
 * not the old allow/block-only subset):
 *   - No `location_filter` key            → everything passes.
 *   - Empty/missing location on a job     → pass (don't penalize missing data).
 *   - Keywords match on WORD BOUNDARIES   → "US" cannot fire inside "Lausanne".
 *   - `block_hard` match                  → reject (the ONLY tier always_allow
 *     cannot override — for country-level terms that are never a false reject).
 *   - `always_allow` match                → pass (checked before `block`, so a
 *     posting listing Zürich + New York survives; "on-site in NY and Zürich").
 *   - `block` match                       → reject.
 *   - `allow` empty                       → pass (already cleared block).
 *   - `allow` non-empty                   → must match ≥ 1 keyword.
 *   - Last resort: the posting's TITLE marking it remote ("Program Manager -
 *     Remote") can widen `allow`, never `block`.
 */

// ── Title filter ────────────────────────────────────────────────────
// v1.76.0 — title-filter matching robustness.
// Two robustness fixes over the old `title.includes(keyword)` approach:
//   1. Short all-letter acronyms (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on
//      WORD BOUNDARIES, so "COO" no longer matches "Coordinator" and "SDR" no
//      longer matches mid-word. Multi-word phrases and keywords with non-letters
//      (".NET", "SAP ", "L&D") keep fast, permissive substring matching.
//   2. Malformed config is normalized away: a null / numeric / empty entry in
//      title_filter.{positive,negative} can no longer crash the scan via
//      k.toLowerCase().

/**
 * Compile a lowercased keyword into a matcher `(lower) => boolean`.
 * @param {string} kw already-lowercased keyword
 */
export function compileKeyword(kw) {
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = new RegExp(`\\b${kw}\\b`);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

/**
 * An AND-group: whitespace-delimited ` + ` between terms in a single
 * `title_filter.positive` entry means EVERY term must appear in the title, in
 * any order. `title_filter.positive` is otherwise a
 * hand-maintained list of literal spellings, and real titles vary in word order
 * and separators — an AND-group lets one entry require a conjunction
 * ("staff + platform") without enumerating every ordering. The surrounding
 * whitespace is REQUIRED on purpose: a bare `split('+')` would shatter "c++"
 * and "front+back" into fragments that match almost every title.
 */
const AND_SEPARATOR = /\s+\+\s+/;

/**
 * Compile one already-lowercased `positive` entry. An AND-group (` + `) becomes
 * a matcher that requires EVERY term; anything else is a plain
 * {@link compileKeyword}. Each term keeps its own word-boundary treatment, so a
 * 2–3-letter term still can't hit inside another word.
 * @param {string} kw already-lowercased keyword
 */
export function compilePositiveKeyword(kw) {
  if (!AND_SEPARATOR.test(kw)) return compileKeyword(kw);
  const matchers = kw.split(AND_SEPARATOR).map((t) => t.trim()).filter(Boolean).map(compileKeyword);
  if (matchers.length === 0) return compileKeyword(kw);
  return (lower) => matchers.every((m) => m(lower));
}

/**
 * Compile a raw keyword list (tolerating malformed entries) into an array of
 * matcher functions. Exposed so the RU scanner can compile its negative list
 * once while keeping the lowercased array for collision warnings.
 * @param {unknown} arr
 * @param {(kw: string) => (lower: string) => boolean} [compiler] per-entry
 *   compiler — {@link compileKeyword} (default) for negatives, or
 *   {@link compilePositiveKeyword} for AND-group-aware positives.
 * @returns {Array<(lower: string) => boolean>}
 */
export function compileKeywordList(arr, compiler = compileKeyword) {
  // v1.79.0 — trim BEFORE the length check:
  // a whitespace-only keyword ("  ") otherwise survives length>0 and compiles
  // into a substring matcher that matches almost everything.
  return (Array.isArray(arr) ? arr : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .map(compiler);
}

/**
 * Build a title predicate from `portals.yml::title_filter`. A job passes when it
 * matches at least one positive keyword (or there are none) AND no negative one.
 * @param {{positive?: unknown, negative?: unknown}|null|undefined} titleFilter
 * @returns {(title: string) => boolean} predicate — true = keep the job
 */
export function buildTitleFilter(titleFilter) {
  const positive = compileKeywordList(titleFilter?.positive, compilePositiveKeyword);
  const negative = compileKeywordList(titleFilter?.negative);
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((m) => m(lower));
    const hasNegative = negative.some((m) => m(lower));
    return hasPositive && !hasNegative;
  };
}

/**
 * Compile a location keyword into a word-boundary matcher.
 *
 * Unlike `compileKeyword` (title filter), location keywords ALWAYS require
 * word boundaries on both ends — a short country code like "US" must never
 * fire inside "Lausanne" or "Brussels". Word (here: contiguous alphanumeric
 * run) delimiters are any non-alphanumeric char or string end.
 *
 * Ported from parent scan.mjs `compileLocationKeyword` (#2087 word boundaries).
 * @param {string} keyword already-lowercased keyword
 * @returns {(lower: string) => boolean}
 */
export function compileLocationKeyword(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWord = /[a-z0-9]/.test(keyword[0]);
  const endsWord = /[a-z0-9]/.test(keyword[keyword.length - 1]);
  const prefix = startsWord ? '(?<![a-z0-9])' : '';
  const suffix = endsWord ? '(?![a-z0-9])' : '';
  const re = new RegExp(`${prefix}${escaped}${suffix}`);
  return (lower) => re.test(lower);
}

function compileLocationKeywordList(value) {
  return (Array.isArray(value) ? value : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .map(compileLocationKeyword);
}

/**
 * Some providers report a rolled-up display string ("5 Locations", "2
 * Locations") while the canonical URL still names the real primary location.
 * Workday is the common case: .../job/Hyderabad-Telangana-India/ shows
 * up as "5 Locations", so no `block` keyword can ever match the location
 * field. Recover that signal by reading the path segment right after
 * `/job/`. Ported from parent scan.mjs `locationHintFromUrl`.
 */
function locationHintFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const segments = pathname.split('/').filter(Boolean);
  const jobIdx = segments.lastIndexOf('job');
  if (jobIdx === -1 || jobIdx === segments.length - 1) return '';
  let segment = segments[jobIdx + 1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
    /* malformed percent-encoding — fall back to raw segment */
  }
  return segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A posting's TITLE can state the remoteness when the location field only has
 * the hiring office ("Program Manager - Remote" → "Las Vegas, Nevada"). Only an
 * unambiguous work-arrangement marker counts — "remote" followed by end-of-
 * string, a non-letter, or " in …", and not negated ("Non-Remote"). Ported
 * from parent scan.mjs (REMOTE_TITLE_RE / REMOTE_NEGATED_RE).
 */
const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;
const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

function titleSignalsRemote(title) {
  if (typeof title !== 'string' || title.trim() === '') return false;
  const lower = title.toLowerCase();
  if (REMOTE_NEGATED_RE.test(lower)) return false;
  return REMOTE_TITLE_RE.test(lower);
}

/**
 * Build the full 4-tier location predicate from `portals.yml::location_filter`.
 *
 * Signature mirrors parent scan.mjs: `(location, url?, title?) => boolean`.
 * `url` feeds the Workday `/job/{location}/` hint; `title` is the last-resort
 * "remote-in-title" rescue. Callers passing only `location` get the same
 * behaviour the parent's unit tests exercise.
 *
 * @param {{always_allow?: string[], allow?: string[], block?: string[], block_hard?: string[]}|null|undefined} locationFilter
 * @returns {(location: string, url?: string, title?: string) => boolean} true = keep
 */
export function buildLocationFilter(locationFilter) {
  if (!locationFilter || typeof locationFilter !== 'object') return () => true;
  const alwaysAllow = compileLocationKeywordList(locationFilter.always_allow);
  const allow = compileLocationKeywordList(locationFilter.allow);
  const block = compileLocationKeywordList(locationFilter.block);
  const blockHard = compileLocationKeywordList(locationFilter.block_hard);

  return (location, url, title) => {
    const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const hint = locationHintFromUrl(url);
    // Nothing to judge on either field → pass (don't penalize missing data).
    if (lower === '' && hint === '') return true;
    const matches = (m) => (lower !== '' && m(lower)) || (hint !== '' && m(hint));
    if (blockHard.length > 0 && blockHard.some(matches)) return false;
    if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
    if (block.length > 0 && block.some(matches)) return false;
    if (allow.length === 0) return true;
    if (allow.some(matches)) return true;
    // Last resort only. Deliberately placed AFTER `block` so a remote title can
    // never rescue a blocked location. This widens `allow`, never `block`.
    return titleSignalsRemote(title);
  };
}

/**
 * v1.75.0 — `content_filter` support.
 *
 * Like `location_filter` but matches against a posting's free-text
 * description/snippet rather than its location. Only sources that populate a
 * `description` (or `snippet`) field are affected — every other posting passes,
 * so enabling this never silently drops postings from sources that don't ship a
 * body.
 *
 * portals.yml:
 *   content_filter:
 *     positive: ["python", "machine learning"]
 *     negative: ["clearance", "on-site only"]
 *
 * Semantics (verbatim from parent scan.mjs):
 *   - No `content_filter` key            → everything passes.
 *   - Empty/missing description on a job → pass (don't penalize missing data).
 *   - `negative` match                   → reject.
 *   - `positive` empty                   → pass.
 *   - `positive` non-empty               → must match ≥ 1 keyword.
 *   - All matches: case-insensitive substring.
 *
 * @param {{positive?: string[], negative?: string[]}|null|undefined} contentFilter
 * @returns {(description: string) => boolean} predicate — true = keep the job
 */
export function buildContentFilter(contentFilter) {
  if (!contentFilter || typeof contentFilter !== 'object') return () => true;
  const positive = (Array.isArray(contentFilter.positive) ? contentFilter.positive : [])
    .map((k) => String(k).toLowerCase());
  const negative = (Array.isArray(contentFilter.negative) ? contentFilter.negative : [])
    .map((k) => String(k).toLowerCase());

  return (description) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();
    if (negative.length > 0 && negative.some((k) => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some((k) => lower.includes(k));
  };
}
