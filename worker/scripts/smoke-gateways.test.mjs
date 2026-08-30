import { describe, it, expect } from 'vitest';
import { checkHealth, runAttempts } from './smoke-gateways.mjs';
import { DEPLOY_PROFILES, EXPECTED_VERSIONS } from './smoke-target.mjs';

const HASH = 'ea0e6282b314266b';
const SHA = 'f'.repeat(40);
const VERSION_ID = '1e24e857-51da-43e7-99f6-d12f3f413d21';

const expected = {
  profile: 'normal',
  statusGatewaysHash: HASH,
  statusGatewaysCount: 5,
  releaseSha: SHA,
  workerVersionId: VERSION_ID,
};

/** A body the live worker would send for the release under test. */
const healthy = (over = {}) => ({
  ok: true,
  versions: [...EXPECTED_VERSIONS],
  uploads: true,
  v3Uploads: true,
  v4Uploads: true,
  statusQuorumPolicy: DEPLOY_PROFILES.normal.statusQuorumPolicy,
  semanticIdempotency: DEPLOY_PROFILES.normal.semanticIdempotency,
  statusGatewaysCount: 5,
  statusGatewaysHash: HASH,
  releaseSha: SHA,
  workerVersionId: VERSION_ID,
  ...over,
});

const never = () => new AbortController().signal;
const already = () => AbortSignal.abort();
const noSleep = () => Promise.resolve();

describe('checkHealth', () => {
  it('accepts the release it was given', () => {
    expect(checkHealth(healthy({ nonce: 'abc' }), { ...expected, nonce: 'abc' }))
      .toEqual({ ok: true, problems: [] });
  });

  // Freshness gates everything else: judging a stale body's fields would be
  // reporting on an answer to a question nobody asked.
  it('stops at an unechoed nonce and reports nothing else', () => {
    const stale = healthy({ nonce: 'other', ok: false, statusGatewaysCount: 99 });
    const { ok, problems } = checkHealth(stale, { ...expected, nonce: 'abc' });
    expect(ok).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/nonce/);
  });

  it('rejects a re-deploy of the same commit — SHA equal, version id different', () => {
    const { ok, problems } = checkHealth(
      healthy({ nonce: 'abc', workerVersionId: 'de305d54-0000-0000-0000-000000000000' }),
      { ...expected, nonce: 'abc' },
    );
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/workerVersionId/);
    expect(problems.join(' ')).not.toMatch(/releaseSha/);
  });

  it('rejects a gateway set the repository did not pin', () => {
    const { problems } = checkHealth(
      healthy({ nonce: 'abc', statusGatewaysHash: '0'.repeat(16) }),
      { ...expected, nonce: 'abc' },
    );
    expect(problems.join(' ')).toMatch(/statusGatewaysHash/);
  });

  // The emergency lineage is DEFINED by every switch being off; the same body
  // that is healthy under `normal` must be refused under `emergency`.
  it('refuses live uploads under the emergency profile', () => {
    const { ok, problems } = checkHealth(
      healthy({ nonce: 'abc', statusQuorumPolicy: DEPLOY_PROFILES.emergency.statusQuorumPolicy }),
      { ...expected, profile: 'emergency', nonce: 'abc' },
    );
    expect(ok).toBe(false);
    expect(problems.filter(p => /must be false/.test(p))).toHaveLength(3);
  });

  it('refuses the safe semantics under the emergency profile', () => {
    const { problems } = checkHealth(
      healthy({ nonce: 'abc', uploads: false, v3Uploads: false, v4Uploads: false }),
      { ...expected, profile: 'emergency', nonce: 'abc' },
    );
    expect(problems.join(' ')).toMatch(/statusQuorumPolicy/);
  });

  it('treats a malformed flag as malformed, not as disabled', () => {
    const { problems } = checkHealth(
      healthy({ nonce: 'abc', v3Uploads: 'false' }),
      { ...expected, nonce: 'abc' },
    );
    expect(problems.join(' ')).toMatch(/v3Uploads is not a boolean/);
  });

  it('refuses a body that is not an object', () => {
    expect(checkHealth('ok', { ...expected, nonce: 'abc' }).problems)
      .toEqual(['health body is not an object']);
  });
});

describe('runAttempts', () => {
  // THE REGRESSION. Right after a deploy some edges still answer from the
  // previous version; judging that first answer failed a release whose worker
  // was correct. The wait must be waited out.
  it('waits out propagation: two stale answers, then the new version', async () => {
    let call = 0;
    const result = await runAttempts({
      probeOnce: async nonce => ({
        body: call++ < 2
          ? healthy({ nonce, workerVersionId: 'older', releaseSha: 'a'.repeat(40) })
          : healthy({ nonce }),
      }),
      expected,
      deadline: never(),
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
  });

  it('recovers from a transport failure that later clears', async () => {
    let call = 0;
    const result = await runAttempts({
      probeOnce: async nonce =>
        call++ === 0 ? { error: 'fetch failed' } : { body: healthy({ nonce }) },
      expected,
      deadline: never(),
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
  });

  // A retry that reused its nonce could be satisfied by the very cached answer
  // the retry exists to get past.
  it('asks a NEW question every attempt', async () => {
    const seen = [];
    await runAttempts({
      probeOnce: async nonce => { seen.push(nonce); return { body: healthy({ nonce: 'no' }) }; },
      expected,
      deadline: never(),
      attempts: 4,
      sleep: noSleep,
    });
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('gives up after the attempt ceiling and names the real problem', async () => {
    const result = await runAttempts({
      probeOnce: async nonce => ({ body: healthy({ nonce, workerVersionId: 'older' }) }),
      expected,
      deadline: never(),
      attempts: 3,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/workerVersionId/);
  });

  // «deadline exhausted» alone told the operator nothing about what the worker
  // answered — and with every mismatch now retried, that is how real failures
  // ordinarily end.
  it('keeps the last real problem when the budget runs out', async () => {
    const deadline = new AbortController();
    const result = await runAttempts({
      probeOnce: async nonce => ({ body: healthy({ nonce, statusGatewaysCount: 1 }) }),
      expected,
      deadline: deadline.signal,
      attempts: 5,
      sleep: async () => { deadline.abort(); },
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/statusGatewaysCount/);
    expect(result.problems).toContain('deadline exhausted');
  });

  it('does not ask at all once the budget is already gone', async () => {
    let calls = 0;
    const result = await runAttempts({
      probeOnce: async () => { calls++; return { body: healthy() }; },
      expected,
      deadline: already(),
      sleep: noSleep,
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ ok: false, problems: ['deadline exhausted'] });
  });

  it('reports a thrown probe as a problem rather than crashing the smoke', async () => {
    const result = await runAttempts({
      probeOnce: async () => { throw new Error('ECONNRESET'); },
      expected,
      deadline: never(),
      attempts: 2,
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: false, problems: ['ECONNRESET'] });
  });
});

describe('the capability the release exists for (D2a)', () => {
  it('a normal build that does not claim it FAILS the smoke', () => {
    // Otherwise a deploy could report success while shipping a worker that
    // still hands out a historical txId for bytes nobody compared.
    const verdict = checkHealth(healthy({ semanticIdempotency: undefined }), expected);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/semanticIdempotency is undefined/);
  });

  it('a value other than 1 is refused, not treated as "at least"', () => {
    expect(checkHealth(healthy({ semanticIdempotency: 2 }), expected).ok).toBe(false);
    expect(checkHealth(healthy({ semanticIdempotency: true }), expected).ok).toBe(false);
    expect(checkHealth(healthy({ semanticIdempotency: '1' }), expected).ok).toBe(false);
  });

  it('an EMERGENCY build must NOT claim it', () => {
    // An emergency release is a pre-capability build. Letting it advertise the
    // marker would tell a client to trust a comparison that build never makes.
    const emergency = { ...expected, profile: 'emergency' };
    const body = healthy({
      statusQuorumPolicy: DEPLOY_PROFILES.emergency.statusQuorumPolicy,
      uploads: false, v3Uploads: false, v4Uploads: false,
      semanticIdempotency: 1,
    });
    const verdict = checkHealth(body, emergency);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/semanticIdempotency is 1/);
  });

  it('an emergency build WITHOUT it passes', () => {
    const emergency = { ...expected, profile: 'emergency' };
    const body = healthy({
      statusQuorumPolicy: DEPLOY_PROFILES.emergency.statusQuorumPolicy,
      uploads: false, v3Uploads: false, v4Uploads: false,
      semanticIdempotency: undefined,
    });
    expect(checkHealth(body, emergency)).toEqual({ ok: true, problems: [] });
  });
});
