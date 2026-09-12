/**
 * v1.33.0 (WS4) — `buildLocationFilter` location semantics (#570).
 *
 * Locks the exact semantics so a future refactor can't drift from the
 * the `portals.yml::location_filter` behaviour. web-ui's
 * en-scanner / ru-scanner run in-process (don't shell out to the
 * parent's scan.mjs), so this shared module IS the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter } from '../server/lib/location-filter.mjs';

test('no location_filter → everything passes', () => {
  const f = buildLocationFilter(null);
  assert.equal(f('Bengaluru, India'), true);
  assert.equal(f(''), true);
  assert.equal(f('Remote'), true);
  assert.equal(buildLocationFilter(undefined)('anywhere'), true);
});

test('empty/missing location → pass (don\'t penalize missing data)', () => {
  const f = buildLocationFilter({ allow: ['United States'], block: ['India'] });
  assert.equal(f(''), true);
  assert.equal(f(null), true);
  assert.equal(f(undefined), true);
});

test('block match → reject (takes precedence over allow)', () => {
  const f = buildLocationFilter({ allow: ['Remote'], block: ['India'] });
  // "Remote, India" matches BOTH — block wins.
  assert.equal(f('Remote, India'), false);
  assert.equal(f('Bengaluru, India'), false);
});

test('allow empty (after block cleared) → pass', () => {
  const f = buildLocationFilter({ block: ['India'] });
  assert.equal(f('London, UK'), true);   // not blocked, allow empty → pass
  assert.equal(f('Mumbai, India'), false); // blocked
});

test('allow non-empty → must match at least one keyword', () => {
  const f = buildLocationFilter({ allow: ['Remote', 'United States', 'Atlanta'] });
  assert.equal(f('Remote'), true);
  assert.equal(f('Atlanta, GA'), true);
  assert.equal(f('San Francisco, United States'), true);
  assert.equal(f('Berlin, Germany'), false); // no allow keyword
});

test('case-insensitive substring matching', () => {
  const f = buildLocationFilter({ allow: ['united states'], block: ['INDIA'] });
  assert.equal(f('UNITED STATES'), true);
  assert.equal(f('remote — india'), false);
});

test('malformed location_filter (non-object / non-array fields) → safe pass-all', () => {
  assert.equal(buildLocationFilter('nonsense')('x'), true);
  assert.equal(buildLocationFilter({ allow: 'notarray' })('x'), true);
  assert.equal(buildLocationFilter({ block: 42 })('x'), true);
});

test('exact parity worked-example from parent portals.example.yml', () => {
  // The commented example shipped in parent templates/portals.example.yml.
  const f = buildLocationFilter({
    allow: ['Remote', 'United States', 'USA', 'Atlanta', 'New York'],
    block: ['India', 'Bengaluru', 'United Kingdom', 'London', 'Germany'],
  });
  assert.equal(f('Remote (USA)'), true);
  assert.equal(f('New York, NY'), true);
  assert.equal(f('London, United Kingdom'), false);
  assert.equal(f('Bengaluru'), false);
  assert.equal(f('Toronto, Canada'), false); // not blocked, but not in allow
  assert.equal(f(''), true);                  // missing → pass
});

// ── Parent-parity 4-tier semantics (#next / port) ───────────────────

test('always_allow rescues a posting that ALSO lists a blocked city', () => {
  const f = buildLocationFilter({
    always_allow: ['Zürich', 'Zurich', 'Switzerland'],
    allow: ['Remote'],
    block: ['US', 'New York', 'San Francisco'],
  });
  // The user's exact concern: on-site in New York AND Zürich → keep.
  assert.equal(f('New York City, NY | Zürich, Switzerland'), true);
  assert.equal(f('San Francisco, CA; Zürich, Switzerland'), true);
  assert.equal(f('Zürich, CH'), true);
});

test('word boundaries: short codes do not fire inside longer words', () => {
  const f = buildLocationFilter({ allow: ['Remote', 'Switzerland'], block: ['US', 'USA', 'India'] });
  assert.equal(f('Remote'), true);
  assert.equal(f('Remote - US'), false);       // "US" word → blocked
  assert.equal(f('USA | Remote'), false);
  assert.equal(f('Remote, India'), false);
  // "US" as a substring must NOT fire here — Lausanne is Swiss, and matches allow.
  assert.equal(f('Lausanne, Switzerland'), true);
});

test('allow non-empty gates that have no blocked term still need an allow keyword', () => {
  const f = buildLocationFilter({ allow: ['Remote'], block: ['US', 'New York'] });
  assert.equal(f('Remote, London, UK'), true);
  assert.equal(f('Berlin, Germany · Remote'), true);
  assert.equal(f('Berlin, Germany'), false); // remote missing from location
});

test('block_hard (optional tier) cannot be overridden by always_allow', () => {
  const f = buildLocationFilter({
    always_allow: ['Porto'],
    allow: ['Remote'],
    block_hard: ['Brazil'],
  });
  assert.equal(f('Porto Alegre, Rio Grande do Sul, Brazil'), false);
  assert.equal(f('Porto, Portugal'), true);
});

test('last-resort title rescue: remote in the TITLE passes an allow-gated location', () => {
  const f = buildLocationFilter({ allow: ['Remote'], block: ['Brazil'] });
  assert.equal(f('Las Vegas, Nevada', undefined, 'Program Manager - Remote'), true);
  assert.equal(f('Bengaluru, India', undefined, 'Program Manager - Remote'), true); // no block term
  // ...but a blocked location never gets rescued by the title.
  const g = buildLocationFilter({ allow: ['Remote'], block: ['New York'] });
  assert.equal(g('New York, NY', undefined, 'Program Manager - Remote'), false);
});

test('workday-style rolled-up locations fall back to the /job/{location}/ URL hint', () => {
  const f = buildLocationFilter({ allow: ['Remote', 'Switzerland'], block: ['India'] });
  assert.equal(
    f('5 Locations', 'https://wd2.myworkdayjobs.com/Acme/job/Hyderabad-Telangana-India/Software-Engineer'),
    false,
  );
  assert.equal(
    f('5 Locations', 'https://wd2.myworkdayjobs.com/Acme/job/Zurich-Switzerland/Software-Engineer'),
    true,
  );
});
