/**
 * Location-eligibility judge for #/scan (post-scan LLM refine pass).
 *
 * A scan row's structured location string cannot tell "remote restricted to
 * Spain" from "remote role whose office happens to be in Paris" — only the JD
 * body can. This module runs a cheap LLM pass over the ambiguous band of the
 * last scan results, tags each URL `yes | no | unsure` with verbatim evidence,
 * and caches verdicts per URL in `data/eligibility.json` (user layer).
 *
 * The eligibility criteria below are the MACHINE twin of
 * `modes/_profile.md` → "Your Location Policy" (same copy pattern as
 * `location-filter.mjs` ↔ parent `scan.mjs`). They feed BOTH the LLM prompt
 * and the SPA's help popover via `GET /api/scan/eligibility`, so the rules
 * cannot drift between the judge, the UI, and the documentation — when the
 * policy in `_profile.md` changes, this block must change with it.
 *
 * Honesty contract (mirrors llm-dispatch.mjs): no LLM provider configured →
 * the caller gets the copy-paste prompt, never a fabricated verdict. A row the
 * model cannot explain with an evidence quote stays untagged ("Not yet
 * checked"), never guessed. The pass is non-destructive: it only tags, the
 * SPA filter decides what to show.
 *
 * Resilience: rows are judged in batches of ≤15 rows AND ≤100k chars of JD
 * text (whichever comes first), each JD is fed in full up to 20k chars, up to
 * 10 judge requests run in parallel, and a row whose verdict fails verification
 * is re-queued up to `MAX_VERDICT_RETRIES` (3) times — one noisy model response
 * must not strand a row. Verdicts are cached per URL, so re-refining after a
 * new scan only touches previously unknown URLs.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { PATHS } from './paths.mjs';
import { runActiveProvider } from './llm-dispatch.mjs';
import { sanitizeJobDescription } from './security.mjs';
import { effectiveEnv } from './env-config.mjs';

// Bump whenever the criteria or the judge input changes shape: entries written
// under an older version are ignored, so a materially different policy re-judges
// every URL instead of silently serving stale verdicts from the cache.
export const ELIGIBILITY_VERSION = 2;
export const ELIGIBILITY_LABEL = 'Location eligible';

// Mirror of modes/_profile.md → "Your Location Policy". Single source for the
// LLM prompt AND the UI help popover.
export const ELIGIBILITY_CRITERIA = [
  'ELIGIBLE: the role can be performed from the candidate\'s base country — location-agnostic remote; EU/EMEA/global remote; or hybrid/on-site with the required office in the base country.',
  'NOT_ELIGIBLE: the role is bound to a place outside the base country — "remotely in <country>", "remote in <country>", "must be based in <country/city>", a country/region-scoped location ("Spain · Remote", "Berlin Office; Remotely in Germany"), country-specific payroll/residency, mandatory on-site/hybrid attendance outside the base country, in-country client/field presence (e.g. a Forward Deployed role anchored to another region), required relocation abroad, or security clearance limited to another jurisdiction.',
  'The structured LOCATION line IS authoritative when it states where the work may be performed — e.g. "Remotely in Germany; Remotely in the UK", "Remote in Spain", "Must be based in London", "Spain · Remote", or a country in the title like "Sr Agent Architect (Germany)". Such a role is NOT_ELIGIBLE; quote the restricting clause as E.',
  'The location line is NOT determinative only when it merely lists offices/geographies with no restricting phrase — e.g. "Paris, Île-de-France, France, Remote" is a remote role with a Paris office, and "Berlin Office; London Office" is an office list. In that case decide from the JOB DESCRIPTION; if that is also silent, reply UNSURE.',
  'UNSURE: use it only when neither the location line nor the job description states a work-place restriction. Never guess, never over-reject.',
  'Quote evidence verbatim: E: {the exact restricting clause, from the location line or the job description}.',
];

const REGION_TOKENS = new Set(['remote', 'remotely', 'global', 'worldwide', 'anywhere', 'eu', 'europe', 'emea', 'international']);
const CH_TOKENS = ['switzerland', 'zürich', 'zurich', 'genève', 'geneva', 'lausanne'];

/** Base country (+ city fallback) from config/profile.yml; defensive. */
export function baseCountry() {
  try {
    const parsed = yaml.load(readFileSync(PATHS.profile, 'utf8')) || {};
    const loc = parsed && parsed.location;
    if (loc && typeof loc.country === 'string' && loc.country.trim()) {
      const c = loc.country.trim();
      const city = typeof loc.city === 'string' && loc.city.trim() ? loc.city.trim() : '';
      return city ? `${c} (${city})` : c;
    }
  } catch { /* profile missing/malformed → generic fallback below */ }
  return 'your base country (see config/profile.yml → location.country)';
}

/**
 * Judge call options. The classification is a fixed-policy, short-output task,
 * so it asks for a generous output budget (default 40k, override with
 * `ELIGIBILITY_MAX_TOKENS`) rather than the 8k default, and exposes an opt-in
 * `ELIGIBILITY_EXTRA_BODY` JSON passthrough for provider-specific knobs (e.g. a
 * reasoning/thinking toggle). Nothing extra is sent by default — an unsupported
 * param makes strict OpenAI-compatible routes answer 400.
 */
export function eligibilityJudgeOptions() {
  const raw = Number(effectiveEnv('ELIGIBILITY_MAX_TOKENS', PATHS.envFile));
  const maxTokens = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40000;
  const rawExtra = effectiveEnv('ELIGIBILITY_EXTRA_BODY', PATHS.envFile);
  if (rawExtra) {
    try {
      const parsed = JSON.parse(rawExtra);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { maxTokens, extraBody: parsed };
    } catch { /* malformed JSON → ignore, keep default request shape */ }
  }
  return { maxTokens };
}

/** Stable per-URL cache key: lowercase host/path, fragment and trailing slash dropped. */
export function eligibilityUrlKey(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let u;
  try {
    u = new URL(url);
  } catch {
    return url.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
  u.hash = '';
  let s = u.href;
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

function hasToken(lower, tokens) {
  return tokens.some((tk) => {
    const esc = tk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(lower);
  });
}

/**
 * Deterministic verdict for the clearly-safe cases; null = the ambiguous band,
 * which is exactly what the LLM judge is for.
 *   - a base-country place name is mentioned        → yes
 *   - remote-tagged whose remaining tokens are all  → yes
 *     unrestricted-region words ("Remote", "Remote, Global", "EU | Remote")
 */
export function preTagEligibility(location) {
  if (typeof location !== 'string' || !location.trim()) return null;
  const lower = location.toLowerCase();
  if (hasToken(lower, CH_TOKENS)) {
    return { v: 'yes', src: 'auto', e: location.trim(), r: 'lists the base country' };
  }
  if (hasToken(lower, ['remote', 'remotely'])) {
    const rest = lower
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((w) => !REGION_TOKENS.has(w));
    if (rest.length === 0) {
      return { v: 'yes', src: 'auto', e: location.trim(), r: 'unrestricted remote (no country/city pinned)' };
    }
  }
  return null;
}

// ── Cache (data/eligibility.json) ──────────────────────────────────────
export function loadEligibilityCache() {
  try {
    const d = JSON.parse(readFileSync(PATHS.eligibilityCache, 'utf8'));
    if (d && d.version === ELIGIBILITY_VERSION && typeof d.entries === 'object' && d.entries) return d.entries;
  } catch { /* missing/malformed → empty */ }
  return {};
}

/** Last refine run's cost/stats summary, or null. */
export function loadEligibilityRun() {
  try {
    const d = JSON.parse(readFileSync(PATHS.eligibilityCache, 'utf8'));
    if (d && d.version === ELIGIBILITY_VERSION && d.lastRun && typeof d.lastRun === 'object') return d.lastRun;
  } catch { /* missing/malformed → null */ }
  return null;
}

export function saveEligibilityCache(entries, lastRun = null) {
  mkdirSync(PATHS.eligibilityCache.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(PATHS.eligibilityCache, JSON.stringify({ version: ELIGIBILITY_VERSION, lastRun, entries }, null, 2));
}

export function eligibilityStats(entries) {
  const s = { total: 0, yes: 0, no: 0, unsure: 0, auto: 0, llm: 0 };
  for (const e of Object.values(entries || {})) {
    s.total += 1;
    if (e && e.v === 'yes') s.yes += 1;
    else if (e && e.v === 'no') s.no += 1;
    else if (e && e.v === 'unsure') s.unsure += 1;
    if (e && e.src === 'llm') s.llm += 1;
    else if (e) s.auto += 1;
  }
  return s;
}

// ── Prompt + verified JSON parsing ─────────────────────────────────────
export function buildEligibilityPrompt(jobs, country) {
  const lines = [
    'You judge job postings against a LOCATION ELIGIBILITY policy — whether the candidate can perform the role from the stated base country.',
    `Base country: ${country}.`,
    '',
    'Policy:',
    ...ELIGIBILITY_CRITERIA.map((c) => `- ${c}`),
    '',
    `Jobs (${jobs.length}):`,
  ];
  jobs.forEach((j, i) => {
    lines.push(`#${i + 1} ${j.title || ''}`);
    lines.push(`URL: ${j.url || ''}`);
    lines.push(`LOCATION: ${j.location || ''}`);
    const body = (j.description || j.snippet || '').trim();
    if (body) lines.push(`JOB DESCRIPTION: ${sanitizeJobDescription(body.slice(0, MAX_JD_CHARS))}`);
  });
  lines.push('');
  lines.push('Output a single JSON array, one object per job, in the EXACT job order (#1..#N). No prose, no markdown fences, nothing but the array:');
  lines.push('[{"n": 1, "v": "YES|NO|UNSURE", "e": "verbatim evidence quote from the posting", "r": "reason, at most 120 chars"}, ...]');
  lines.push('Rules: v MUST be exactly YES, NO or UNSURE. YES/NO require a non-empty verbatim evidence quote in e. UNSURE requires a reason in r and may set e to null. If the posting text cannot decide, use UNSURE — never guess, never over-reject.');
  return lines.join('\n');
}

/**
 * Verified parser for the judge's JSON output (mirrors rank-pipeline.mjs
 * `parseBatchResponse` discipline: locate the outermost array, JSON.parse,
 * strictly validate every item, drop what does not verify — never salvage).
 * Returns { verdicts, invalid }:
 *   - verdicts: { oneBasedJobNumber → { v, e, r } }
 *   - invalid:  list of job numbers that failed validation (left untagged)
 */
export function parseEligibilityVerdicts(markdown) {
  const verdicts = {};
  const invalid = [];
  const raw = String(markdown ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return { verdicts, invalid };
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { verdicts, invalid };
  }
  if (!Array.isArray(arr)) return { verdicts, invalid };
  for (const item of arr) {
    if (!item || typeof item !== 'object') { invalid.push(null); continue; }
    const n = item.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) { invalid.push(n); continue; }
    const v = typeof item.v === 'string' ? item.v.trim().toLowerCase() : '';
    if (v !== 'yes' && v !== 'no' && v !== 'unsure') { invalid.push(n); continue; }
    const e = typeof item.e === 'string' ? item.e.trim() : '';
    const r = typeof item.r === 'string' ? item.r.trim() : '';
    if (v === 'unsure') {
      // "Can't tell" is itself the verdict — a reason is required, evidence is not.
      if (!r) { invalid.push(n); continue; }
      verdicts[n] = { v, e: e || null, r };
    } else {
      // YES/NO must carry a verbatim evidence quote; otherwise the row is
      // dropped and stays "Not yet checked" — never guessed.
      if (!e) { invalid.push(n); continue; }
      verdicts[n] = { v, e, r: r || null };
    }
  }
  return { verdicts, invalid };
}

const MAX_ROWS_PER_CHUNK = 15;
const MAX_VERDICT_RETRIES = 3;
// Outbound judge requests are dispatched by a bounded pool; 10 in flight keeps
// a large scan fast without hammering the provider's rate limits.
export const MAX_CONCURRENCY = 10;
// Per-job JD budget in the prompt (the model reads the whole body up to this;
// few postings exceed it), plus the batch ceiling so 15 large JDs can't cause
// context rot — whichever limit is hit first closes the chunk.
const MAX_JD_CHARS = 20000;
const MAX_CHUNK_CHARS = 100000;

/**
 * Rows whose verdicts failed verification and still have retry budget. Mutates
 * `retried` (url → retries used). Pure + testable without an LLM.
 * @param {Array<{url: string}>} batch the jobs that were sent to the model
 * @param {Array<(number|null)>} invalid job numbers that failed verification
 * @param {Map<string, number>} retried per-url retry counts
 */
export function retryCandidates(batch, invalid, retried, max = MAX_VERDICT_RETRIES) {
  const out = [];
  for (const n of invalid) {
    const job = (typeof n === 'number' && n >= 1) ? batch[n - 1] : null;
    if (!job) continue;
    const tries = (retried.get(job.url) || 0) + 1;
    if (tries <= max) {
      retried.set(job.url, tries);
      out.push(job);
    }
  }
  return out;
}

/** Split a list in half (for retrying a batch that produced no parseable output). */
export function splitInHalves(arr) {
  const mid = Math.ceil(arr.length / 2);
  return [arr.slice(0, mid), arr.slice(mid)].filter((a) => a.length);
}

/** Char budget a job contributes to the prompt (title + location + JD body). */
function jobChars(j) {
  return ((j.title || '').length + (j.location || '').length + ((j.description || j.snippet) || '').length);
}

/**
 * Split jobs into batches of ≤15 rows AND ≤100k chars of job text (whichever
 * hits first), so neither a long list of short rows nor a few huge JDs cause
 * context rot. Exported for tests.
 */
export function chunkJobs(jobs) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const j of jobs) {
    const size = jobChars(j);
    if (cur.length && (cur.length >= MAX_ROWS_PER_CHUNK || chars + size > MAX_CHUNK_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(j);
    chars += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Run the refine pass over scan rows.
 *
 * Verdicts are cached per URL in `data/eligibility.json`; only rows without a
 * cached verdict and without a deterministic auto-tag are sent to the LLM, so
 * re-refining after a new scan cheaply skips everything already known.
 *
 * Streams progress via callbacks (`onProgress(done, total)` as rows resolve,
 * `onLog(line)` per step) so a long run stays observable.
 *
 * @param {Array<{url?: string, title?: string, location?: string, snippet?: string, description?: string}>} rows
 * @param {{ onLog?: (line: string) => void, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, dispatch?: typeof runActiveProvider }} opts
 *   `dispatch` is injectable for tests (defaults to the live provider cascade).
 * @returns summary with autoTagged/llm verdicts, chunk/call count, token usage,
 *   `manualPrompt` when the caller must copy the prompt into an LLM (never a
 *   fabricated answer), and `error` when the provider pass failed.
 */
export async function refineEligibility(rows, { onLog, onProgress, signal, dispatch } = {}) {
  const log = (line) => { if (typeof onLog === 'function') onLog(line); };
  const progress = (done, total) => { if (typeof onProgress === 'function') onProgress(done, total); };
  const aborted = () => !!(signal && signal.aborted);

  const entries = loadEligibilityCache();
  const jobs = (rows || [])
    .map((r) => ({
      url: eligibilityUrlKey(r && r.url),
      title: (r && r.title) || '',
      location: (r && r.location) || '',
      description: (r && (r.description || r.snippet)) || '',
    }))
    .filter((j) => j.url && !entries[j.url]);

  const total = jobs.length;
  const autoTagged = [];
  const pending = [];
  const when = new Date().toISOString();
  for (const j of jobs) {
    if (aborted()) break;
    const t = preTagEligibility(j.location);
    if (t) {
      entries[j.url] = { ...t, when };
      autoTagged.push({ url: j.url, v: t.v, src: t.src });
    } else {
      pending.push(j);
    }
  }
  // Persist the cheap wins immediately so an aborted/closed stream keeps them.
  saveEligibilityCache(entries);
  if (autoTagged.length) log(`auto-tagged ${autoTagged.length} rows without the LLM`);
  progress(autoTagged.length, total);

  if (pending.length === 0) {
    const lastRun = {
      at: when, corpus: total, autoTagged: autoTagged.length, llmTagged: 0,
      pending: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0,
    };
    saveEligibilityCache(entries, lastRun);
    return { mode: 'ok', autoTagged, llm: [], pending: 0, total, calls: 0, inputTokens: 0, outputTokens: 0, manualPrompt: '', error: null };
  }

  const llm = [];
  let manualPrompt = '';
  let error = null;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let verdictRetries = 0;
  let fatal = false; // a provider/transport failure stops new dispatch; in-flight batches still report
  const country = baseCountry();
  // Live provider calls request the judge's output budget (and any opt-in
  // provider extras); tests inject a `dispatch` and bypass this entirely.
  const judgeOptions = dispatch ? null : eligibilityJudgeOptions();
  const callJudge = dispatch || ((prompt) => runActiveProvider(prompt, judgeOptions));
  const retried = new Map(); // url → retries used so far
  let nextBatchId = 0;
  // Work queue processed by a bounded pool. Rows that fail verification are
  // re-queued (up to MAX_VERDICT_RETRIES each) as fresh batches, so one noisy
  // response never strands a row and batches never wait on each other.
  const queue = chunkJobs(pending).map((batch) => ({ id: ++nextBatchId, batch }));
  let inFlight = 0;

  function pump() {
    if (aborted() || fatal) return;
    while (inFlight < MAX_CONCURRENCY && queue.length) {
      const item = queue.shift();
      inFlight += 1;
      const { id, batch } = item;
      const prompt = buildEligibilityPrompt(batch, country);
      callJudge(prompt)
        .then((r) => {
          if (r.mode === 'manual') {
            manualPrompt = manualPrompt || prompt;
            if (!fatal) log('no LLM provider configured — eligibility prompt available for copying');
            fatal = true;
            return;
          }
          if (r.mode === 'too-large') {
            error = error || `prompt too large (${r.size} bytes; cap ${r.cap})`;
            log(`✗ [batch ${id}] ${error}`);
            fatal = true;
            return;
          }
          if (r.error) {
            error = error || r.error;
            log(`✗ [batch ${id}] provider error: ${r.error}`);
            fatal = true;
            return;
          }
          calls += 1;
          if (r.usage && Number.isFinite(r.usage.prompt_tokens)) inputTokens += r.usage.prompt_tokens;
          if (r.usage && Number.isFinite(r.usage.completion_tokens)) outputTokens += r.usage.completion_tokens;
          const { verdicts, invalid } = parseEligibilityVerdicts(r.markdown);
          let parsed = 0;
          const accounted = new Set();
          for (const [key, vr] of Object.entries(verdicts)) {
            const idx = Number(key);
            const job = batch[idx - 1];
            if (!job) continue;
            accounted.add(idx);
            entries[job.url] = { v: vr.v, e: vr.e, r: vr.r, when, src: 'llm' };
            llm.push({ url: job.url, v: vr.v, src: 'llm' });
            parsed += 1;
          }
          // A row is unresolved if its verdict failed validation AND if it never
          // appeared at all (a truncated/empty response yields no `invalid`
          // markers). Both get a retry — nothing may drop silently.
          const badIdx = invalid.filter((n) => typeof n === 'number' && n >= 1);
          const unresolvedIdx = [];
          for (let i = 1; i <= batch.length; i += 1) {
            if (!accounted.has(i) && !badIdx.includes(i)) unresolvedIdx.push(i);
          }
          const failedIdx = [...badIdx, ...unresolvedIdx];
          const toRetry = retryCandidates(batch, failedIdx, retried);
          verdictRetries += toRetry.length;
          if (toRetry.length) {
            // A batch with nothing parseable usually means the model hit its
            // output cap mid-JSON (a reasoning model spends the cap on
            // reasoning). Re-sending the same size repeats the failure, so
            // halve it; partial verification failures retry as one batch.
            const wholeFailure = parsed === 0;
            const groups = wholeFailure && toRetry.length > 1 ? splitInHalves(toRetry) : [toRetry];
            for (const g of groups) for (const rb of chunkJobs(g)) queue.push({ id: ++nextBatchId, batch: rb });
            log(`[batch ${id}] ${toRetry.length}/${batch.length} rows unresolved — re-queued${wholeFailure && groups.length > 1 ? ' (split in halves)' : ''} for retry (max ${MAX_VERDICT_RETRIES} attempts)`);
          } else if (failedIdx.length) {
            log(`[batch ${id}] ${failedIdx.length} rows left untagged after ${MAX_VERDICT_RETRIES} attempts (failed verification)`);
          } else if (parsed) {
            log(`[batch ${id}] ${parsed} verdicts kept`);
          } else {
            log(`[batch ${id}] no rows in batch`);
          }
          progress(Math.min(total, autoTagged.length + llm.length), total);
        })
        .catch((e) => {
          error = error || (e && e.message) || 'provider call failed';
          log(`✗ [batch ${id}] ${error}`);
          fatal = true;
        })
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  }

  log(`dispatching ${queue.length} batches · up to ${MAX_CONCURRENCY} in parallel${judgeOptions ? ` · ${judgeOptions.maxTokens} max output tokens` : ''}`);
  pump();
  // Drain: retries enqueue as batches finish, so wait until nothing is left.
  while (!aborted() && (inFlight > 0 || (queue.length && !fatal))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const lastRun = {
    at: new Date().toISOString(), corpus: total, autoTagged: autoTagged.length,
    llmTagged: llm.length, pending: pending.length - llm.length,
    llmCalls: calls, inputTokens, outputTokens, verdictRetries,
    judgeMaxTokens: judgeOptions ? judgeOptions.maxTokens : null,
  };
  saveEligibilityCache(entries, lastRun);
  return {
    mode: 'ok',
    autoTagged, llm, pending: pending.length - llm.length, total,
    calls, inputTokens, outputTokens, verdictRetries, manualPrompt, error,
  };
}

/** Attach `el` verdicts to scan-result rows and surface eligibility info. */
export function attachEligibility(snapshot) {
  const entries = loadEligibilityCache();
  const out = {};
  for (const k of ['en', 'ru']) {
    const part = snapshot[k];
    if (!part) {
      out[k] = part;
      continue;
    }
    const map = (arr) => (arr || []).map((r) => ({ ...r, el: entries[eligibilityUrlKey(r.url)] || null }));
    out[k] = { ...part, fresh: map(part.fresh), filtered: map(part.filtered) };
  }
  return {
    ...snapshot,
    ...out,
    eligibilityInfo: {
      label: ELIGIBILITY_LABEL,
      criteria: ELIGIBILITY_CRITERIA,
      baseCountry: baseCountry(),
      stats: eligibilityStats(entries),
    },
  };
}