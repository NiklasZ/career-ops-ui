/**
 * location-eligibility — unit tests for the #/scan eligibility refine module
 * (server/lib/location-eligibility.mjs): deterministic pre-tags, the verified
 * JSON verdict parser (rank-pipeline-style "no salvage" discipline), URL keys,
 * and the offline refine path (auto-tagging never sends rows to an LLM).
 *
 * CI-isolated: CAREER_OPS_ROOT points at a throw-away mkdtemp so any cache
 * writes land in /tmp, never the user's data/eligibility.json.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod;
before(async () => {
  process.env.CAREER_OPS_ROOT = mkdtempSync(join(tmpdir(), 'eligibility-test-'));
  mod = await import('../server/lib/location-eligibility.mjs');
});

test('preTagEligibility: base-country place names are auto-eligible', () => {
  for (const loc of ['Zürich', 'Zurich', 'Switzerland', 'Geneva, Switzerland', 'Lausanne · Remote', 'Austria · Germany · Switzerland']) {
    const t = mod.preTagEligibility(loc);
    assert.ok(t && t.v === 'yes' && t.src === 'auto', `${loc} should auto-tag yes`);
  }
});

test('preTagEligibility: unrestricted/region remote is auto-eligible', () => {
  for (const loc of ['Remote', 'Remote, Global', 'EU | Remote', 'EMEA (Remote)', 'Europe · Remote']) {
    const t = mod.preTagEligibility(loc);
    assert.ok(t && t.v === 'yes', `${loc} should auto-tag yes`);
  }
});

test('preTagEligibility: country/city-pinned and ambiguous locations stay LLM-bound', () => {
  for (const loc of ['Spain · Remote', 'Remote, Germany, Cologne', 'Paris, Île-de-France, France', 'Germany · Remote', ''] ) {
    assert.equal(mod.preTagEligibility(loc), null, `${loc} must not be auto-tagged`);
  }
});

test('eligibilityUrlKey: stable normalization', () => {
  assert.equal(mod.eligibilityUrlKey('https://Job-Boards.Greenhouse.io/Acme/jobs/42?gh_jid=42#frag'), mod.eligibilityUrlKey('https://job-boards.greenhouse.io/acme/jobs/42?gh_jid=42'));
  assert.equal(mod.eligibilityUrlKey(''), '');
});

test('parseEligibilityVerdicts: clean JSON array', () => {
  const md = '[{"n":1,"v":"NO","e":"Remote in Spain","r":"anchored to Spain"},{"n":2,"v":"YES","e":"Remote role, no constraints","r":"fully remote"}]';
  const { verdicts, invalid } = mod.parseEligibilityVerdicts(md);
  assert.equal(invalid.length, 0);
  assert.equal(verdicts[1].v, 'no');
  assert.equal(verdicts[2].v, 'yes');
  assert.equal(verdicts[1].e, 'Remote in Spain');
});

test('parseEligibilityVerdicts: markdown-fenced and prose-wrapped JSON', () => {
  const fenced = '```json\n[{"n":1,"v":"YES","e":"Remote","r":"ok"}]\n```';
  const wrapped = 'Here you go:\n[{"n":2,"v":"NO","e":"Must be in Berlin","r":"on-site Berlin"}]\nHope that helps.';
  assert.deepEqual(mod.parseEligibilityVerdicts(fenced).verdicts[1], { v: 'yes', e: 'Remote', r: 'ok' });
  assert.equal(mod.parseEligibilityVerdicts(wrapped).verdicts[2].v, 'no');
});

test('parseEligibilityVerdicts: UNSURE keeps its reason without verbatim evidence', () => {
  const md = '[{"n":3,"v":"UNSURE","e":null,"r":"JD is silent on work location"}]';
  const { verdicts, invalid } = mod.parseEligibilityVerdicts(md);
  assert.equal(invalid.length, 0);
  assert.deepEqual(verdicts[3], { v: 'unsure', e: null, r: 'JD is silent on work location' });
});

test('parseEligibilityVerdicts: malformed items are dropped, never salvaged', () => {
  const md = JSON.stringify([
    { n: 0, v: 'YES', e: 'x', r: 'y' },        // n < 1
    { n: 2, v: 'maybe', e: 'x', r: 'y' },      // bad v
    { n: 3, v: 'YES', e: '', r: 'y' },         // YES without evidence
    { n: 4, v: 'UNSURE', e: null, r: '' },     // UNSURE without reason
    { n: 5, v: 'NO', e: 'Evidence here', r: 'because' },
  ]);
  const { verdicts, invalid } = mod.parseEligibilityVerdicts(md);
  assert.equal(invalid.length, 4);
  assert.deepEqual(Object.keys(verdicts), ['5']);
});

test('parseEligibilityVerdicts: non-JSON output yields nothing', () => {
  assert.deepEqual(mod.parseEligibilityVerdicts('The jobs all look fine.'), { verdicts: {}, invalid: [] });
});

test('buildEligibilityPrompt: carries policy, base country and the JSON contract', () => {
  const p = mod.buildEligibilityPrompt([{ url: 'u', title: 'T', location: 'L' }], 'Switzerland (Zürich)');
  assert.match(p, /Base country: Switzerland \(Zürich\)/);
  assert.match(p, /Output a single JSON array/);
  assert.match(p, /UNSURE requires a reason/);
  // v1.160.0+ — the location line is no longer declared non-determinative.
  assert.match(p, /IS authoritative/);
});

test('buildEligibilityPrompt: feeds the full JD up to the 20k cap (no snippet truncation)', () => {
  const long = 'x'.repeat(25000);
  const p = mod.buildEligibilityPrompt([{ url: 'u', title: 'T', location: 'L', description: long }], 'X');
  assert.match(p, /JOB DESCRIPTION:/);
  assert.ok(p.length > 20000, `expected full JD in prompt, got ${p.length} chars`);
  assert.ok(p.length < 23000, `expected 20k JD cap, got ${p.length} chars`);
});

test('chunkJobs: batches cap at 15 rows', () => {
  const jobs = Array.from({ length: 20 }, (_, i) => ({ url: `u${i}`, title: 't', location: 'l', description: '' }));
  const chunks = mod.chunkJobs(jobs);
  assert.deepEqual(chunks.map((c) => c.length), [15, 5]);
});

test('chunkJobs: batches cap at 100k chars of job text before 15 rows', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ({ url: `u${i}`, title: '', location: '', description: 'x'.repeat(30000) }));
  const chunks = mod.chunkJobs(jobs);
  assert.equal(chunks[0].length, 3, 'three 30k-char JDs fit; the fourth would exceed 100k');
});

test('refineEligibility: dispatches judge calls through a bounded parallel pool', async () => {
  assert.equal(mod.MAX_CONCURRENCY, 10);
  const jobs = Array.from({ length: 200 }, (_, i) => ({ url: `https://p.example/${i}`, title: 'Role', location: 'Berlin, Germany' }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  const dispatch = async (prompt) => {
    active += 1;
    calls += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    const count = (prompt.match(/^#\d+ /gm) || []).length;
    const verdicts = Array.from({ length: count }, (_, i) => ({ n: i + 1, v: 'NO', e: 'Berlin', r: 'pinned to Germany' }));
    return { mode: 'fake', markdown: JSON.stringify(verdicts), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r = await mod.refineEligibility(jobs, { dispatch });
  assert.equal(r.calls, Math.ceil(200 / 15), 'one call per 15-row batch');
  assert.equal(peak, mod.MAX_CONCURRENCY, `pool ran ${peak} in parallel, expected ${mod.MAX_CONCURRENCY}`);
  assert.equal(r.llm.length, 200);
  assert.equal(r.pending, 0);
});

test('retryCandidates: honours the per-row retry budget (max 3)', () => {
  const batch = [{ url: 'u1' }, { url: 'u2' }, { url: 'u3' }];
  const retried = new Map();
  const collect = (invalid) => mod.retryCandidates(batch, invalid, retried).map((j) => j.url);
  assert.deepEqual(collect([1, 2]), ['u1', 'u2']); // first failure → retry 1
  assert.deepEqual(collect([1]), ['u1']);          // second failure → retry 2
  assert.deepEqual(collect([1]), ['u1']);          // third failure → retry 3
  assert.deepEqual(collect([1]), []);              // budget exhausted → dropped
  assert.deepEqual(retried.get('u1'), 3);
});

test('retryCandidates: ignores non-mappable invalid markers', () => {
  const batch = [{ url: 'u1' }, { url: 'u2' }];
  const retried = new Map();
  assert.deepEqual(mod.retryCandidates(batch, [99, null, 'x'], retried), []);
});

test('refineEligibility: auto-taggable rows never touch the LLM and set lastRun', async () => {
  const rows = [
    { url: 'https://a.example/1', title: 'Role 1', location: 'Zürich, Switzerland' },
    { url: 'https://a.example/2', title: 'Role 2', location: 'Remote, Global' },
    { url: 'https://a.example/3', title: 'Role 3', location: 'EU | Remote' },
  ];
  const logs = [];
  let progressed = 0;
  const r = await mod.refineEligibility(rows, { onLog: (l) => logs.push(l), onProgress: () => { progressed += 1; } });
  assert.equal(r.mode, 'ok');
  assert.equal(r.calls, 0, 'no LLM call for auto-taggable rows');
  assert.equal(r.autoTagged.length, 3);
  assert.equal(r.pending, 0);
  assert.ok(progressed >= 1, 'progress was emitted');
  const run = mod.loadEligibilityRun();
  assert.ok(run && run.corpus === 3 && run.llmCalls === 0, 'lastRun persisted');
  // Caching: a second pass over the same URLs must skip everything already known.
  const r2 = await mod.refineEligibility(rows);
  assert.equal(r2.total, 0, 'known URLs are not re-sent');
  assert.equal(r2.calls, 0);
});

test('eligibilityJudgeOptions: 40k default, env-overridable, no extras by default', () => {
  const def = mod.eligibilityJudgeOptions();
  assert.equal(def.maxTokens, 40000);
  assert.equal(def.extraBody, undefined, 'no provider extras are sent unless configured');

  process.env.ELIGIBILITY_MAX_TOKENS = '12345';
  process.env.ELIGIBILITY_EXTRA_BODY = '{"chat_template_kwargs":{"enable_thinking":false}}';
  try {
    const o = mod.eligibilityJudgeOptions();
    assert.equal(o.maxTokens, 12345);
    assert.deepEqual(o.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  } finally {
    delete process.env.ELIGIBILITY_MAX_TOKENS;
    delete process.env.ELIGIBILITY_EXTRA_BODY;
  }
});

test('refineEligibility: recovers a truncated batch by splitting and retrying', async () => {
  const jobs = Array.from({ length: 15 }, (_, i) => ({ url: `https://q.example/${i}`, title: 'Role', location: 'Berlin, Germany' }));
  let call = 0;
  const logs = [];
  const dispatch = async (prompt) => {
    call += 1;
    if (call === 1) {
      // Truncated mid-array (output cap) — the old code dropped these 15 rows silently.
      return { mode: 'fake', markdown: '[{"n":1,"v":"NO","e":"Berlin","r":"x"}, {"n":2,"v":"NO"', usage: { prompt_tokens: 10, completion_tokens: 8192 } };
    }
    const count = (prompt.match(/^#\d+ /gm) || []).length;
    const verdicts = Array.from({ length: count }, (_, i) => ({ n: i + 1, v: 'NO', e: 'Berlin', r: 'pinned' }));
    return { mode: 'fake', markdown: JSON.stringify(verdicts), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r = await mod.refineEligibility(jobs, { dispatch, onLog: (l) => logs.push(l) });
  assert.equal(r.llm.length, 15, 'all rows recovered, none dropped');
  assert.equal(r.pending, 0);
  assert.equal(call, 3, 'the failed batch split into two halves and retried');
  assert.ok(logs.some((l) => /split in halves/.test(l)), 'the split is logged, not silent');
});

test('refineEligibility: rows the model omits are retried, not dropped', async () => {
  const jobs = Array.from({ length: 4 }, (_, i) => ({ url: `https://r.example/${i}`, title: 'Role', location: 'Berlin, Germany' }));
  let call = 0;
  const dispatch = async (prompt) => {
    call += 1;
    const count = (prompt.match(/^#\d+ /gm) || []).length;
    const n = call === 1 ? 1 : count; // first response returns only #1
    const verdicts = Array.from({ length: n }, (_, i) => ({ n: i + 1, v: 'NO', e: 'Berlin', r: 'pinned' }));
    return { mode: 'fake', markdown: JSON.stringify(verdicts), usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r = await mod.refineEligibility(jobs, { dispatch });
  assert.equal(r.llm.length, 4);
  assert.equal(r.pending, 0);
});