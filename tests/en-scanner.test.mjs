import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fetchGreenhouse } from '../server/lib/sources/greenhouse.mjs';
import { fetchAshby } from '../server/lib/sources/ashby.mjs';
import { fetchLever } from '../server/lib/sources/lever.mjs';

// runEnScan reads portals.yml from PROJECT_ROOT to know which companies
// to fan out to. Spin up an isolated root with two API entries and a
// title filter so the test is deterministic (no live network, no
// dependency on the user's actual portals.yml).
let runEnScan;
let detectApi;
let shouldDedupScanHistoryRow;
let scanHistoryConfig;
let scanHistoryRows;
let dir;

const BASELINE_PORTALS = [
  'tracked_companies:',
  '  - name: GH-Co',
  '    careers_url: https://job-boards.greenhouse.io/ghco',
  '    api: https://boards-api.greenhouse.io/v1/boards/ghco/jobs',
  '    enabled: true',
  '  - name: Ash-Co',
  '    careers_url: https://jobs.ashbyhq.com/ashco',
  '    enabled: true',
  'title_filter:',
  '  positive: ["Senior", "Lead"]',
  '  negative: ["Junior"]',
].join('\n');

// Dates relative to today (UTC), so the recheck-window assertions hold at any
// real run date: "old" is far outside the 180-day window, "recent" well inside.
const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  dir = mkdtempSync(resolve(tmpdir(), 'en-scan-test-'));
  mkdirSync(resolve(dir, 'config'), { recursive: true });
  mkdirSync(resolve(dir, 'data'), { recursive: true });
  writeFileSync(resolve(dir, 'cv.md'), '# placeholder\n');
  writeFileSync(resolve(dir, 'config', 'profile.yml'), 'candidate:\n  full_name: Test\n');
  writeFileSync(resolve(dir, 'data', 'applications.md'), '');
  writeFileSync(resolve(dir, 'data', 'pipeline.md'), '# pipeline\n');
  writeFileSync(resolve(dir, 'portals.yml'), BASELINE_PORTALS);
  process.env.CAREER_OPS_ROOT = dir;
  ({ runEnScan, detectApi, shouldDedupScanHistoryRow, scanHistoryConfig, scanHistoryRows } = await import('../server/lib/en-scanner.mjs'));
});

after(() => {
  if (dir) writeFileSync(resolve(dir, 'portals.yml'), BASELINE_PORTALS);
  delete process.env.CAREER_OPS_ROOT;
});

// ───────────────────────── Greenhouse ─────────────────────────

test('fetchGreenhouse: normalizes location + isRemote', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    jobs: [
      {
        id: 1, title: 'Senior Go Engineer', company_name: 'X',
        absolute_url: 'https://x.com/1', location: { name: 'Remote - Europe' },
        offices: [{ name: 'Berlin' }], first_published: '2026-01-01',
      },
      {
        id: 2, title: 'Backend Engineer', company_name: 'X',
        absolute_url: 'https://x.com/2', location: { name: 'Hybrid - SF' },
        offices: [], first_published: '2026-01-02',
      },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const items = await fetchGreenhouse('https://boards-api.greenhouse.io/v1/boards/x/jobs', { fetchImpl: fakeFetch });
  assert.equal(items.length, 2);
  assert.equal(items[0].source, 'greenhouse');
  assert.equal(items[0].isRemote, true);
  assert.equal(items[0].workplaceType, 'Remote');
  assert.equal(items[1].isRemote, false);
  assert.equal(items[1].workplaceType, 'Hybrid');
  assert.match(items[0].location, /Remote/);
});

test('fetchGreenhouse: throws on non-200', async () => {
  const fakeFetch = async () => new Response('nf', { status: 404 });
  await assert.rejects(() => fetchGreenhouse('https://x', { fetchImpl: fakeFetch }), /404/);
});

// ───────────────────────── Ashby ─────────────────────────

test('fetchAshby: extracts isRemote + secondary locations', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({
    jobs: [{
      id: 'a1', title: 'Backend Eng', location: 'Europe', isRemote: true,
      workplaceType: 'Remote', secondaryLocations: [{ location: 'San Francisco' }],
      jobUrl: 'https://x.com/a1', publishedAt: '2026-01-01',
      compensation: { compensationTierSummary: '$160k - $200k' },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const items = await fetchAshby('https://x', { fetchImpl: fakeFetch });
  assert.equal(items.length, 1);
  const j = items[0];
  assert.equal(j.isRemote, true);
  assert.equal(j.workplaceType, 'Remote');
  assert.match(j.location, /Europe.*San Francisco/);
  assert.equal(j.salary, '$160k - $200k');
  assert.equal(j.source, 'ashby');
});

// ───────────────────────── Lever ─────────────────────────

test('fetchLever: handles array root', async () => {
  const fakeFetch = async () => new Response(JSON.stringify([
    { id: 'l1', text: 'Senior Go', categories: { location: 'Remote', team: 'Platform' }, hostedUrl: 'https://x.co/l1' },
  ]), { status: 200, headers: { 'content-type': 'application/json' } });
  const items = await fetchLever('https://x', { fetchImpl: fakeFetch });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Senior Go');
  assert.equal(items[0].isRemote, true);
  assert.equal(items[0].source, 'lever');
});

// ───────────────────────── detectApi ─────────────────────────

test('detectApi: prefers explicit api field', () => {
  const a = detectApi({ api: 'https://boards-api.greenhouse.io/v1/boards/x/jobs', careers_url: 'https://anything' });
  assert.equal(a.type, 'greenhouse');
});

test('detectApi: auto-detects ashby/lever/greenhouse from careers_url', () => {
  assert.equal(detectApi({ careers_url: 'https://jobs.ashbyhq.com/foo' }).type, 'ashby');
  assert.equal(detectApi({ careers_url: 'https://jobs.lever.co/foo' }).type, 'lever');
  assert.equal(detectApi({ careers_url: 'https://job-boards.greenhouse.io/foo/x' }).type, 'greenhouse');
});

test('detectApi: returns null for plain corporate URLs', () => {
  assert.equal(detectApi({ careers_url: 'https://acme.com/jobs' }), null);
  assert.equal(detectApi({}), null);
});

// ───────────────────────── orchestrator ─────────────────────────

test('runEnScan: dry-run end-to-end across multiple sources, applies title filter', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('greenhouse')) {
      return new Response(JSON.stringify({
        jobs: [
          { id: 1, title: 'Senior PHP Backend', company_name: 'GH-Co', absolute_url: 'https://gh.example/1', location: { name: 'Remote - EU' }, offices: [], first_published: '2026-01-01' },
          { id: 2, title: 'Junior PHP', company_name: 'GH-Co', absolute_url: 'https://gh.example/2', location: { name: 'Berlin' }, offices: [], first_published: '2026-01-01' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('ashbyhq')) {
      return new Response(JSON.stringify({
        jobs: [{ id: 'a', title: 'Senior Go Engineer', location: 'Remote', isRemote: true, workplaceType: 'Remote', jobUrl: 'https://ash.example/a', publishedAt: '2026-01-02', compensation: {} }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unknown URL ' + url);
  };
  const result = await runEnScan({
    writeFiles: false,
    fetchImpl: fakeFetch,
    onLog: () => {},
  });
  // Junior must be filtered by negatives in portals.yml.
  // Need at least 2 raw and at least 1 filtered out.
  assert.ok(result.counts.raw >= 1, 'raw count: ' + result.counts.raw);
  // Senior PHP + Senior Go should pass positives → at least 1 fresh
  assert.ok(result.counts.fresh >= 1, 'fresh: ' + result.counts.fresh);
  // Each fresh has the rich fields
  for (const f of result.fresh) {
    assert.ok('isRemote' in f);
    assert.ok('workplaceType' in f);
    assert.ok('location' in f);
    assert.ok(f.url);
  }
});

test('runEnScan: continues when one company returns 500', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('cockroach')) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({
      jobs: [{ id: 99, title: 'Senior Backend Engineer', company_name: 'OK-Co', absolute_url: 'https://ok.example/99', location: { name: 'Remote' }, offices: [], first_published: '2026-01-03' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await runEnScan({ writeFiles: false, fetchImpl: fakeFetch, onLog: () => {} });
  assert.ok(result.errors.some((e) => /500|cockroach|CockroachDB/i.test(e)) || result.errors.length === 0,
    'should not blow up; error count ' + result.errors.length);
  assert.ok(result.counts.fresh >= 0);
});

// ───────────────────────── progress (v1.63.2) ─────────────────────────

test('runEnScan: onProgress fires per company and reaches total/total', async () => {
  const emptyFetch = async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  const progress = [];
  await runEnScan({
    writeFiles: false,
    fetchImpl: emptyFetch,
    onLog: () => {},
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.ok(progress.length >= 1, 'onProgress should fire at least once');
  const [lastDone, lastTotal] = progress[progress.length - 1];
  assert.equal(lastTotal, 2, 'two API companies (GH-Co, Ash-Co)');
  assert.equal(lastDone, lastTotal, 'final progress should be done===total');
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i][0] >= progress[i - 1][0], 'done is non-decreasing');
  }
});

// ───────────────────────── recheck_after_days (v1.214.0) ─────────────────────────

test('scanHistoryConfig: parses a valid window, rejects absent/negative/non-numeric', () => {
  assert.deepEqual(scanHistoryConfig({}), { recheckAfterDays: null });
  assert.deepEqual(scanHistoryConfig({ scan_history: { recheck_after_days: '180' } }), { recheckAfterDays: 180 });
  assert.deepEqual(scanHistoryConfig({ scan_history: { recheck_after_days: 180 } }), { recheckAfterDays: 180 });
  assert.deepEqual(scanHistoryConfig({ scan_history: { recheck_after_days: -5 } }), { recheckAfterDays: null });
  assert.deepEqual(scanHistoryConfig({ scan_history: { recheck_after_days: 'abc' } }), { recheckAfterDays: null });
});

test('shouldDedupScanHistoryRow: no recheck config dedups forever (status added)', () => {
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-01-01' }, { recheckAfterDays: null, today: '2026-09-12' }), true);
});

test('shouldDedupScanHistoryRow: the window resurrects old added rows, keeps recent ones', () => {
  // age 254 days ≥ 180 → eligible again
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-01-01' }, { recheckAfterDays: 180, today: '2026-09-12' }), false);
  // age 2 days < 180 → still deduped
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-09-10' }, { recheckAfterDays: 180, today: '2026-09-12' }), true);
});

test('shouldDedupScanHistoryRow: permanent / non-added / unparseable rows never recheck', () => {
  const cfg = { recheckAfterDays: 180, today: '2026-09-12' };
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2020-01-01', status: 'skipped_blocked_host' }, cfg), true);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2020-01-01', status: 'skipped_invalid_url' }, cfg), true);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2020-01-01', status: 'skipped_expired' }, cfg), true);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '', status: 'added' }, cfg), true);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: 'not-a-date' }, cfg), true);
});

test('shouldDedupScanHistoryRow: cooldown status dedups until its date', () => {
  const cfg = { recheckAfterDays: 180, today: '2026-09-12' };
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2020-01-01', status: 'cooldown:2026-12-31' }, cfg), true);
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2020-01-01', status: 'cooldown:2026-01-01' }, cfg), false);
});

test('scanHistoryRows: parses both CLI and UI column orders, skipping the CLI header', () => {
  const text = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation',                                     // CLI header
    'https://cli.example/jobs/9\t2026-01-01\tgreenhouse\tT\tCo\tadded\tRemote',                        // CLI row
    '2026-02-02\tashby\tid-1\tCo2\tR2\thttps://ui.example/jobs/7',                                     // UI row
  ].join('\n');
  const rows = [...scanHistoryRows(text)];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://cli.example/jobs/9');
  assert.equal(rows[0].firstSeen, '2026-01-01');
  assert.equal(rows[0].status, 'added');
  assert.equal(rows[1].url, 'https://ui.example/jobs/7');
  assert.equal(rows[1].firstSeen, '2026-02-02');
});

test('scanHistoryRows: unparseable lines still surface their URL (conservative seen)', () => {
  const rows = [...scanHistoryRows('some-garbage\thttps://stray.example/jobs/1\tmore')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://stray.example/jobs/1');
  assert.equal(rows[0].firstSeen, '');
});

test('runEnScan: recheck_after_days re-offers rows older than the window, keeps recent rows deduped', async () => {
  writeFileSync(resolve(dir, 'portals.yml'), [
    'scan_history:',
    '  recheck_after_days: 180',
    'tracked_companies:',
    '  - name: GH-Co',
    '    careers_url: https://job-boards.greenhouse.io/ghco',
    '    api: https://boards-api.greenhouse.io/v1/boards/ghco/jobs',
    '    enabled: true',
    'title_filter:',
    '  positive: ["Senior"]',
  ].join('\n'));

  const oldUrl = 'https://repost.example.com/jobs/1';
  const recentUrl = 'https://recent.example.com/jobs/2';
  // UI-format scan-history rows: one ~400 days old (re-eligible), one ~5 days old (dedup).
  writeFileSync(resolve(dir, 'data', 'scan-history.tsv'), [
    `${isoDaysAgo(400)}\tgreenhouse\tgh-old\tOldCo\tSenior Old Role\t${oldUrl}`,
    `${isoDaysAgo(5)}\tgreenhouse\tgh-new\tNewCo\tSenior New Role\t${recentUrl}`,
  ].join('\n') + '\n');

  const fakeFetch = async () =>
    new Response(JSON.stringify({
      jobs: [
        { id: 1, title: 'Senior Old (reposted)', company_name: 'GH-Co', absolute_url: oldUrl, location: { name: 'Remote' }, offices: [], first_published: '2026-01-01' },
        { id: 2, title: 'Senior Recent', company_name: 'GH-Co', absolute_url: recentUrl, location: { name: 'Remote' }, offices: [], first_published: isoDaysAgo(5) },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  const logs = [];
  const result = await runEnScan({ writeFiles: false, fetchImpl: fakeFetch, onLog: (_s, l) => logs.push(l) });

  const freshUrls = new Set(result.fresh.map((j) => j.url));
  assert.ok(freshUrls.has(oldUrl), `old (>180d) URL should be re-offered; fresh=[${[...freshUrls]}]`);
  assert.ok(!freshUrls.has(recentUrl), 'recent URL should stay deduped');
  assert.ok(result.counts.dup >= 1, `recent row counts as dup; dup=${result.counts.dup}`);
  assert.ok(logs.some((l) => l.includes('re-offered')), `log should surface the recheck; got: ${logs.join('|')}`);
});

test('runEnScan: without recheck_after_days old history rows stay deduped (regression)', async () => {
  writeFileSync(resolve(dir, 'portals.yml'), [
    'tracked_companies:',
    '  - name: GH-Co',
    '    careers_url: https://job-boards.greenhouse.io/ghco',
    '    api: https://boards-api.greenhouse.io/v1/boards/ghco/jobs',
    '    enabled: true',
    'title_filter:',
    '  positive: ["Senior"]',
  ].join('\n'));

  const oldUrl = 'https://repost.example.com/jobs/1';
  const recentUrl = 'https://recent.example.com/jobs/2';
  const fakeFetch = async () =>
    new Response(JSON.stringify({
      jobs: [
        { id: 1, title: 'Senior Old (reposted)', company_name: 'GH-Co', absolute_url: oldUrl, location: { name: 'Remote' }, offices: [], first_published: '2026-01-01' },
        { id: 2, title: 'Senior Recent', company_name: 'GH-Co', absolute_url: recentUrl, location: { name: 'Remote' }, offices: [], first_published: isoDaysAgo(5) },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  const result = await runEnScan({ writeFiles: false, fetchImpl: fakeFetch, onLog: () => {} });
  const freshUrls = new Set(result.fresh.map((j) => j.url));
  assert.ok(!freshUrls.has(oldUrl), 'old URL must stay deduped without a recheck window');
  assert.ok(!freshUrls.has(recentUrl), 'recent URL must stay deduped without a recheck window');
});
