import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeCensus } from './recovery-census.mjs';

// The operator's side of the rollback census (runbook reader release §5.1,
// review 25.09 H3): exit 0 ONLY for a complete, empty census that passes
// every check on its own; anything else is a refusal.

const HERE = dirname(fileURLToPath(import.meta.url));

const SHA = '394156d5998dbaef5b1d273898ee8006104227f8';
const VID = '41773298-9b1e-47aa-b33b-a353a8c381db';
const empty = () => ({
  workerVersionId: VID, releaseSha: SHA,
  census: {
    complete: true, verdict: 'empty',
    keys: { listed: 3, checked: 3, failed: 0 },
    legacyInvites: { unknown: 0, acknowledged: 0 },
    recovery: { count: 0, due: 0, records: 0, keysWithRecovery: 0 },
    reasons: [],
  },
});

describe('judgeCensus', () => {
  it('a complete, empty census is admissible', () => {
    const v = judgeCensus(200, empty());
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.summary).toMatch(/verdict=empty complete=true keys listed=3 checked=3 failed=0/);
  });

  it('a non-empty recovery set is refused — counter, index or scan alike', () => {
    for (const f of ['count', 'due', 'records']) {
      const b = empty();
      b.census.recovery[f] = 1;
      b.census.recovery.keysWithRecovery = 1;
      b.census.verdict = 'not_empty';
      b.census.reasons = ['recovery_present'];
      const v = judgeCensus(200, b);
      expect(v.ok, f).toBe(false);
      expect(v.problems.join('\n')).toMatch(new RegExp(`recovery\\.${f} = 1`));
    }
  });

  it('the worker saying «empty» is not enough: non-zero numbers under verdict=empty are still refused', () => {
    const b = empty();
    b.census.recovery.records = 2;
    const v = judgeCensus(200, b);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/recovery\.records = 2/);
  });

  it('an incomplete enumeration is refused — failed reads, unchecked keys, unacknowledged invites', () => {
    const failed = empty();
    Object.assign(failed.census, { complete: false, verdict: 'incomplete', reasons: ['key_read_failed'] });
    failed.census.keys = { listed: 3, checked: 2, failed: 1 };
    expect(judgeCensus(200, failed).problems.join('\n')).toMatch(/1 key\(s\) could not be read/);

    const unchecked = empty();
    unchecked.census.keys.checked = 2; // a worker that «forgot» a key but still says complete
    expect(judgeCensus(200, unchecked).problems.join('\n')).toMatch(/checked 2 of 3 listed keys/);

    const legacy = empty();
    legacy.census.legacyInvites = { unknown: 2, acknowledged: 1 };
    expect(judgeCensus(200, legacy).problems.join('\n')).toMatch(/1 old-format invite\(s\) hide a key/);
  });

  it('fewer keys than CENSUS_MIN_KEYS is refused (a misread is not an empty set); 0 is allowed only deliberately', () => {
    const none = empty();
    none.census.keys = { listed: 0, checked: 0, failed: 0 };
    expect(judgeCensus(200, none).ok).toBe(false);
    expect(judgeCensus(200, none).problems.join('\n')).toMatch(/fewer than CENSUS_MIN_KEYS=1/);
    expect(judgeCensus(200, none, { minKeys: 0 }).ok).toBe(true);
  });

  it('a non-200 answer, a missing census or a malformed one is refused — never read as empty', () => {
    expect(judgeCensus(401, { error: 'Unauthorized' }).problems).toEqual(['HTTP 401 — no census']);
    expect(judgeCensus(302, null).ok).toBe(false);
    expect(judgeCensus(200, null).problems).toEqual(['answer carries no census object']);
    expect(judgeCensus(200, { census: [] }).ok).toBe(false);
    for (const mutate of [
      (c) => { delete c.recovery.records; },
      (c) => { c.keys.failed = -1; },
      (c) => { c.recovery.count = '0'; },
      (c) => { c.verdict = 'probably_empty'; },
      (c) => { c.reasons = ['something_new']; },
      (c) => { c.complete = 'yes'; },
    ]) {
      const b = empty();
      mutate(b.census);
      const v = judgeCensus(200, b);
      expect(v.ok).toBe(false);
      expect(v.problems.join('\n')).toMatch(/census is malformed/);
    }
  });
});

// Review of #223 (Low): an empty census without — or with mistyped — worker
// identity was accepted. A census proves something only about the worker that
// answered it.
describe('identity of the answering worker', () => {
  const judged = (mutate, opts) => { const b = empty(); mutate(b); return judgeCensus(200, b, opts); };

  it('workerVersionId missing, null, empty, non-string or oversized → refused', () => {
    for (const mutate of [
      (b) => { delete b.workerVersionId; },
      (b) => { b.workerVersionId = null; },
      (b) => { b.workerVersionId = ''; },
      (b) => { b.workerVersionId = 42; },
      (b) => { b.workerVersionId = 'x'.repeat(129); },
    ]) {
      const v = judged(mutate);
      expect(v.ok).toBe(false);
      expect(v.problems.join('\n')).toMatch(/workerVersionId is missing or not a non-empty string/);
    }
  });

  it('releaseSha missing, mistyped, short, upper-case or abbreviated → refused', () => {
    for (const mutate of [
      (b) => { delete b.releaseSha; },
      (b) => { b.releaseSha = 394156; },
      (b) => { b.releaseSha = '394156d'; },
      (b) => { b.releaseSha = SHA.toUpperCase(); },
      (b) => { b.releaseSha = `${SHA}0`; },
    ]) {
      const v = judged(mutate);
      expect(v.ok).toBe(false);
      expect(v.problems.join('\n')).toMatch(/releaseSha is not a full 40-hex SHA/);
    }
  });

  it('releaseSha null is refused by default (dev always carries RELEASE_SHA)', () => {
    const v = judged((b) => { b.releaseSha = null; });
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/releaseSha is null — admissible only for a staging/);
  });

  it('null for a staging without RELEASE_SHA: only with the allowance AND a matching expected version id', () => {
    const nullSha = (b) => { b.releaseSha = null; };
    expect(judged(nullSha, { allowNullReleaseSha: true }).problems.join('\n')).toMatch(/must be tied to an expected version id/);
    expect(judged(nullSha, { allowNullReleaseSha: true, expectVersionId: 'another-version' }).problems.join('\n'))
      .toMatch(/≠ CENSUS_EXPECT_VERSION_ID/);
    expect(judged(nullSha, { allowNullReleaseSha: true, expectVersionId: VID }).ok).toBe(true);
  });

  it('the allowance does not relax a present SHA: a malformed one is still refused', () => {
    const v = judged((b) => { b.releaseSha = 'abc'; }, { allowNullReleaseSha: true, expectVersionId: VID });
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/not a full 40-hex SHA/);
  });

  it('the allowance never outranks an expected SHA: null + allowance + matching version id + CENSUS_EXPECT_RELEASE_SHA → refused', () => {
    // Review of #223 (Low), reproduced: this combination used to pass.
    const v = judged((b) => { b.releaseSha = null; }, { allowNullReleaseSha: true, expectVersionId: VID, expectReleaseSha: SHA });
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toMatch(/releaseSha is null ≠ CENSUS_EXPECT_RELEASE_SHA/);
  });

  it('CENSUS_EXPECT_RELEASE_SHA / CENSUS_EXPECT_VERSION_ID must match when set', () => {
    expect(judgeCensus(200, empty(), { expectReleaseSha: SHA, expectVersionId: VID }).ok).toBe(true);
    expect(judgeCensus(200, empty(), { expectReleaseSha: 'b'.repeat(40) }).problems.join('\n')).toMatch(/≠ CENSUS_EXPECT_RELEASE_SHA/);
    expect(judgeCensus(200, empty(), { expectVersionId: 'other' }).problems.join('\n')).toMatch(/≠ CENSUS_EXPECT_VERSION_ID/);
  });
});

describe('CLI', () => {
  const run = (env) => spawnSync(process.execPath, [join(HERE, 'recovery-census.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });

  it('exit 2 without CENSUS_URL / METRICS_ADMIN_SECRET, with a bad CENSUS_MIN_KEYS, or for a target outside the allowlist', () => {
    expect(run({}).status).toBe(2);
    expect(run({ CENSUS_URL: 'https://eternal-notes-proxy.sopi-88c.workers.dev' }).status).toBe(2);
    expect(run({ CENSUS_URL: 'https://eternal-notes-proxy.sopi-88c.workers.dev', METRICS_ADMIN_SECRET: 's', CENSUS_MIN_KEYS: '-1' }).status).toBe(2);
    const stranger = run({ CENSUS_URL: 'https://evil.example.com', METRICS_ADMIN_SECRET: 's' });
    expect(stranger.status).toBe(2);
    expect(stranger.stdout + stranger.stderr).not.toContain('Bearer');
  });

  it('exit 2 for identity options that cannot mean anything: a bad expected SHA, a vague allowance, an allowance without a version id', () => {
    const base = { CENSUS_URL: 'https://eternal-notes-proxy.sopi-88c.workers.dev', METRICS_ADMIN_SECRET: 's' };
    const badSha = run({ ...base, CENSUS_EXPECT_RELEASE_SHA: '394156d' });
    expect(badSha.status).toBe(2);
    expect(badSha.stderr).toMatch(/CENSUS_EXPECT_RELEASE_SHA must be a full 40-hex SHA/);
    const vague = run({ ...base, CENSUS_ALLOW_NULL_RELEASE_SHA: 'yes' });
    expect(vague.status).toBe(2);
    expect(vague.stderr).toMatch(/unset or exactly 1/);
    const untied = run({ ...base, CENSUS_ALLOW_NULL_RELEASE_SHA: '1' });
    expect(untied.status).toBe(2);
    expect(untied.stderr).toMatch(/requires CENSUS_EXPECT_VERSION_ID/);
    const contradictory = run({ ...base, CENSUS_ALLOW_NULL_RELEASE_SHA: '1', CENSUS_EXPECT_VERSION_ID: VID, CENSUS_EXPECT_RELEASE_SHA: SHA });
    expect(contradictory.status).toBe(2);
    expect(contradictory.stderr).toMatch(/contradicts CENSUS_EXPECT_RELEASE_SHA/);
  });
});
