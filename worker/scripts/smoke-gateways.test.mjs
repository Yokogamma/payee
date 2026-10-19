import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import {
  ALLOW_HISTORICAL_POOL,
  SmokeUsageError,
  checkHealth,
  expectationsFor,
  expectationsFromRepo,
  expectedFromCli,
  runAttempts,
} from './smoke-gateways.mjs';
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

// Runbook reader release §6.9: the dev deploy asserts the operator floor for a
// candidate that carries SpendGuard (scripts/operators-floor.mjs).
// Optional — a caller that names no floor (the dev smoke of a historical
// build without the field) is unaffected.
describe('checkHealth — minOperators (optional)', () => {
  it('not asked → not checked, even when the field is absent', () => {
    expect(checkHealth(healthy({ nonce: 'n' }), { ...expected, nonce: 'n' }).ok).toBe(true);
  });
  it('asked → at least that many independent operators', () => {
    expect(checkHealth(healthy({ nonce: 'n', statusOperatorsCount: 2 }), { ...expected, nonce: 'n', minOperators: 2 }).ok).toBe(true);
    expect(checkHealth(healthy({ nonce: 'n', statusOperatorsCount: 5 }), { ...expected, nonce: 'n', minOperators: 2 }).ok).toBe(true);
    for (const n of [1, 0, undefined, null, '2', 2.5]) {
      const r = checkHealth(healthy({ nonce: 'n', statusOperatorsCount: n }), { ...expected, nonce: 'n', minOperators: 2 });
      expect(r.ok, String(n)).toBe(false);
      expect(r.problems.join('\n')).toMatch(/statusOperatorsCount is .*, expected at least 2 independent operators/);
    }
  });
});

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

/**
 * The `pre-d2` profile: the PR-3a lineage, exactly as ff0954d answers /health.
 *
 * Quorum yes, fingerprinting no, uploads ON. It fits neither `normal` (which
 * demands `semanticIdempotency: 1`) nor `emergency` (which demands the old
 * single-gateway quorum and uploads OFF). Deploying ff0954d under `normal` would
 * pass every config gate and fail HERE — after activation. This profile is what
 * lets the smoke judge that build correctly, and the exact-equality rule keeps
 * it from ever admitting a modern build.
 */
describe('the pre-d2 profile judges the seed-legacy build, and only that build', () => {
  const preD2 = { ...expected, profile: 'pre-d2' };
  /** What ff0954d actually answers: everything of `normal` except the marker. */
  const ff0954d = (over = {}) => healthy({ semanticIdempotency: undefined, ...over });

  it('accepts ff0954d-shaped health — quorum present, marker absent, uploads on', () => {
    const verdict = checkHealth(ff0954d(), preD2);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  // The other half of the two-way binding, enforced by the smoke itself.
  it('REFUSES a modern build — a D2 worker reports 1, and 1 is not undefined', () => {
    const verdict = checkHealth(healthy(), preD2);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/semanticIdempotency is 1.*requires undefined/s);
  });

  it('still requires the quorum — a single-gateway build is not pre-d2', () => {
    const verdict = checkHealth(ff0954d({ statusQuorumPolicy: 'legacy-single-v0' }), preD2);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/statusQuorumPolicy/);
  });

  // Not merely «not required off»: the profile exists so seed-legacy can
  // PUBLISH. A worker with any switch off would be declared ready and then
  // refuse the seeding it was activated for.
  it('REQUIRES every upload switch ON — seed-legacy has to publish through it', () => {
    expect(checkHealth(ff0954d({ uploads: true, v3Uploads: true, v4Uploads: true }), preD2).ok).toBe(true);
  });

  it('refuses the build with ALL switches off — the reviewed reproduction', () => {
    const verdict = checkHealth(ff0954d({ uploads: false, v3Uploads: false, v4Uploads: false }), preD2);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/uploads must be true under the pre-d2 profile/);
  });

  it('refuses ANY single switch off, each on its own', () => {
    for (const flag of ['uploads', 'v3Uploads', 'v4Uploads']) {
      const verdict = checkHealth(ff0954d({ [flag]: false }), preD2);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join('; ')).toMatch(new RegExp(flag + ' must be true under the pre-d2 profile'));
    }
  });

  it('the normal profile is untouched by this — it still asserts nothing about the switches', () => {
    // Strengthening normal would be a separate decision; this change is pre-d2 only.
    expect(checkHealth(healthy({ uploads: false, v3Uploads: false, v4Uploads: false }), expected).ok).toBe(true);
  });

  // And the same ff0954d body is still refused by `normal`: the profiles are
  // disjoint, so a mislabelled dispatch cannot succeed either way.
  it('the ff0954d body FAILS the normal profile', () => {
    expect(checkHealth(ff0954d(), expected).ok).toBe(false);
  });
});

// The pool changed on 2026-09-27 (ar-io.dev removed). A rollback to 394156d
// must still pass the post-deploy smoke of the WORKER deploy: that ONE build
// (HISTORICAL_POOLS, full SHA) is expected to attest its own pool — the hash
// its live /health reports today. But the Pages pre-publish smoke names the
// same SHA while publishing a client built on the CURRENT pool; keyed by the
// SHA alone, the exception waved that client through on top of the old worker
// (review of #226, P2). So it is an explicit flag, and only deploy-worker.yml
// passes it. The workflow steps are tested AS WRITTEN: the exception lives in
// which step says the flag.
describe('the historical pool is the worker deploy\'s explicit exception, never the Pages gate\'s (review of #226, P2)', () => {
  const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const H = '394156d5998dbaef5b1d273898ee8006104227f8';
  const H_VERSION = '41773298-9b1e-47aa-b33b-a353a8c381db';
  const H_HASH = 'ea0e6282b314266b';
  const POOL_PROBLEMS = [
    'statusGatewaysHash does not match the set configured in wrangler.toml',
    'statusGatewaysCount does not match wrangler.toml',
  ];

  /** The live 394156d /health today: its own five-origin pool, no operator count. */
  const live394156d = over => healthy({
    nonce: 'n', statusGatewaysHash: H_HASH, statusGatewaysCount: 5, releaseSha: H, workerVersionId: H_VERSION, ...over,
  });

  /** The ONE smoke step of a workflow job, as written. */
  const smokeStep = (file, job) => {
    const doc = load(readFileSync(join(ROOT, '.github/workflows', file), 'utf8'));
    const steps = doc.jobs[job].steps.filter(s => typeof s?.run === 'string' && s.run.includes('worker/scripts/smoke-gateways.mjs'));
    expect(steps).toHaveLength(1);
    return steps[0];
  };

  /**
   * What that step hands the smoke for a dispatch naming `sha` / `versionId`:
   * its `${{ }}` expressions resolved from a CLOSED table (an unknown one
   * fails the test instead of resolving to nothing), and its one shell
   * expansion ("$PROFILE") applied to the argv.
   */
  const invocation = (step, { sha, versionId, minOperators = '' }) => {
    const table = {
      'inputs.candidate': sha,
      'inputs.worker_candidate': sha,
      'inputs.profile': 'normal',
      'steps.version.outputs.version_id': versionId,
      'steps.identity.outputs.version_id': versionId,
      'steps.opfloor.outputs.min_operators': minOperators,
    };
    const env = {};
    for (const [key, value] of Object.entries(step.env ?? {})) {
      env[key] = String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
        if (!Object.hasOwn(table, expr)) throw new Error(`unresolved expression in ${key}: ${expr}`);
        return table[expr];
      });
    }
    const argv = step.run.trim().split(/\s+/);
    expect(argv.slice(0, 2)).toEqual(['node', 'worker/scripts/smoke-gateways.mjs']);
    return { args: argv.slice(2).map(a => a.replace('"$PROFILE"', env.PROFILE)), env };
  };

  const judge = async ({ args, env }, body) => checkHealth(body, { ...(await expectedFromCli(args, env)), nonce: body.nonce });

  const pages = smokeStep('deploy-pages-cf.yml', 'build-and-deploy');
  const worker = smokeStep('deploy-worker.yml', 'deploy-worker');

  it('expectationsFor: without the flag EVERY release is held to the repository — 394156d included', async () => {
    const repo = await expectationsFromRepo('');
    expect(repo.statusGatewaysCount).toBe(4);
    expect(repo.statusGatewaysHash).not.toBe(H_HASH);
    for (const allowHistorical of [undefined, false, 'yes', 1]) {
      expect(await expectationsFor({ releaseSha: H, allowHistorical }), String(allowHistorical)).toEqual(repo);
    }
  });

  it('expectationsFor with the flag: 394156d → its own five-origin pool, the hash its live /health attests', async () => {
    expect(await expectationsFor({ releaseSha: H, allowHistorical: true }))
      .toEqual({ statusGatewaysHash: H_HASH, statusGatewaysCount: 5 });
  });

  it('with the flag, a foreign full SHA, an abbreviated or upper-cased 394156d, no SHA, or a staging smoke — the repository', async () => {
    const repo = await expectationsFromRepo('');
    for (const releaseSha of ['a'.repeat(40), H.slice(0, 7), H.toUpperCase(), undefined, 'constructor']) {
      expect(await expectationsFor({ releaseSha, allowHistorical: true }), String(releaseSha)).toEqual(repo);
    }
    expect(await expectationsFor({ blockPrefix: 'env.staging.', releaseSha: H, allowHistorical: true }))
      .toEqual(await expectationsFromRepo('env.staging.'));
  });

  it('the Pages step, as written, dispatched with worker_candidate=394156d: the live 394156d is REFUSED on its pool', async () => {
    const r = await judge(invocation(pages, { sha: H, versionId: H_VERSION }), live394156d());
    // The identity matches — only the pool fails, which is exactly the point:
    // the client this run publishes is built on the current pool.
    expect(r).toEqual({ ok: false, problems: POOL_PROBLEMS });
  });

  it('the Pages step still passes a worker that attests the current pool (the release order kept)', async () => {
    const repo = await expectationsFromRepo('');
    const R = 'c'.repeat(40);
    const reader = healthy({ nonce: 'n', ...repo, releaseSha: R, workerVersionId: VERSION_ID, statusOperatorsCount: 4 });
    expect(await judge(invocation(pages, { sha: R, versionId: VERSION_ID }), reader)).toEqual({ ok: true, problems: [] });
  });

  it('the deploy-worker step, as written, rolling back to 394156d: the live 394156d PASSES', async () => {
    // opfloor prints an empty floor for a candidate without SpendGuard.
    expect(await judge(invocation(worker, { sha: H, versionId: H_VERSION }), live394156d()))
      .toEqual({ ok: true, problems: [] });
  });

  it('the flag keeps both identity checks: another SHA or another version id on the old pool is refused', async () => {
    const inv = invocation(worker, { sha: H, versionId: H_VERSION });
    const otherSha = await judge(inv, live394156d({ releaseSha: 'b'.repeat(40) }));
    expect(otherSha.ok).toBe(false);
    expect(otherSha.problems.join('\n')).toMatch(/releaseSha is "b{40}", expected the deployed candidate/);
    const otherVersion = await judge(inv, live394156d({ workerVersionId: VERSION_ID }));
    expect(otherVersion.ok).toBe(false);
    expect(otherVersion.problems.join('\n')).toMatch(/workerVersionId is .*expected the version the deploy just activated/);
  });

  it('a foreign or abbreviated SHA gets no exception even from the deploy-worker step: the old pool is refused', async () => {
    for (const sha of ['a'.repeat(40), H.slice(0, 7), H.toUpperCase()]) {
      // The body names the same SHA, so the identity passes and ONLY the pool
      // can refuse — the exception was not granted.
      const r = await judge(invocation(worker, { sha, versionId: H_VERSION }), live394156d({ releaseSha: sha }));
      expect(r, sha).toEqual({ ok: false, problems: POOL_PROBLEMS });
    }
  });

  it('only deploy-worker.yml passes the flag, in its smoke step alone — no other workflow step, nor the staging path', () => {
    const dir = join(ROOT, '.github/workflows');
    const carriers = [];
    for (const file of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
      const doc = load(readFileSync(join(dir, file), 'utf8'));
      for (const [job, def] of Object.entries(doc.jobs ?? {})) {
        for (const step of def.steps ?? []) {
          if (typeof step?.run === 'string' && step.run.includes(ALLOW_HISTORICAL_POOL)) carriers.push(`${file}:${job}:${step.name}`);
        }
      }
    }
    expect(carriers).toEqual(['deploy-worker.yml:deploy-worker:Smoke the live worker']);
    expect(pages.run).not.toContain(ALLOW_HISTORICAL_POOL);
    expect(readFileSync(join(ROOT, 'worker/scripts/deploy-staging.mjs'), 'utf8')).not.toContain(ALLOW_HISTORICAL_POOL);
  });

  it('the flag without the full identity, or with --staging, refuses to start', async () => {
    const flag = ['--profile=normal', ALLOW_HISTORICAL_POOL];
    for (const env of [{}, { EXPECT_RELEASE_SHA: H }, { EXPECT_WORKER_VERSION_ID: H_VERSION }]) {
      await expect(expectedFromCli(flag, env), JSON.stringify(env)).rejects.toThrow(SmokeUsageError);
    }
    await expect(expectedFromCli([...flag, '--staging'], { EXPECT_RELEASE_SHA: H, EXPECT_WORKER_VERSION_ID: H_VERSION }))
      .rejects.toThrow(SmokeUsageError);
  });

  it('the CLI turns a refusal to start into exit 2, before any request', () => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(EXPECT|SMOKE)_/.test(k)));
    // A 1 ms budget: were the refusal missing, the smoke would end in a fast
    // exit 1 instead of reaching the network for real.
    const run = (args, env) => spawnSync(process.execPath, ['worker/scripts/smoke-gateways.mjs', ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...inherited, SMOKE_DEADLINE_MS: '1', SMOKE_ATTEMPTS: '1', ...env },
    });
    const noIdentity = run(['--profile=normal', ALLOW_HISTORICAL_POOL], { EXPECT_RELEASE_SHA: H });
    expect(noIdentity.status).toBe(2);
    expect(noIdentity.stderr).toContain(`✗ ${ALLOW_HISTORICAL_POOL} is the rollback exception of the worker deploy`);
    const badFloor = run(['--profile=normal'], { EXPECT_MIN_OPERATORS: 'two' });
    expect(badFloor.status).toBe(2);
    expect(badFloor.stderr).toContain('✗ EXPECT_MIN_OPERATORS must be a positive integer, got "two"');
  });
});
