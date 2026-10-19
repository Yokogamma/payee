import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import type { RateLimiter } from '../src/rate-limiter';
import { CENSUS_MAX_KEYS, type RecoveryCensus } from '../src/recovery-census';
import type { RecoveryRecord } from '../src/recovery';
import { isolatedGuard, isolatedNs } from './helpers/spend-admin';

// POST /admin/recovery-census — the rollback census (runbook reader release
// §5.1, review 25.09 H3): every key that ever held access (revoked included,
// operator-registered included), each key's recovery counter, index AND a
// direct scan of its note records; a summary only — never a key, noteId or
// txId; fail-closed on any failed or malformed read.

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;
const INVITE_MANAGER = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;

const SECRET = 'census-metrics-secret-test';
const SPEND_SECRET = 'census-spend-secret-test';
const FAR = Date.now() + 1_000_000_000;
const uuid = () => crypto.randomUUID();
const pk = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** One test's world: its own InviteManager and SpendGuard, the shared per-key
 *  RateLimiter namespace (keys are random, so nothing collides). */
function world(name: string, over: Record<string, unknown> = {}) {
  const invites = isolatedNs(INVITE_MANAGER, `census-${name}`);
  const guard = isolatedGuard(`census-${name}`);
  const e = {
    ...baseEnv, INVITE_MANAGER: invites, SPEND_GUARD: guard, METRICS_ADMIN_SECRET: SECRET, SPEND_ADMIN_SECRET: SPEND_SECRET,
    RELEASE_SHA: 'c'.repeat(40), CF_VERSION_METADATA: { id: 'census-version' }, ...over,
  } as WorkerEnv;
  return { invites, guard, env: e };
}

async function registeredKey(invites: DurableObjectNamespace, opts: { revoke?: boolean } = {}) {
  const key = pk();
  const stub = invites.get(invites.idFromName('global'));
  const code = `code-${uuid().slice(0, 8)}`;
  expect((await stub.fetch('http://internal/seed-invite', { method: 'POST', body: JSON.stringify({ codes: [code] }) })).status).toBe(200);
  expect((await stub.fetch('http://internal/register', { method: 'POST', body: JSON.stringify({ inviteCode: code, publicKey: key, clientIP: '203.0.113.9' }) })).status).toBe(200);
  if (opts.revoke) expect((await stub.fetch('http://internal/revoke', { method: 'POST', body: JSON.stringify({ publicKey: key }) })).status).toBe(200);
  return key;
}

/** An ordinary (non-recovery) note of `key` — the census must not count it. */
async function ordinaryNote(key: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(key));
  const r = await stub.fetch('http://internal/check-and-reserve', {
    method: 'POST', body: JSON.stringify({ noteId: uuid(), limit: 20, fp: 'a'.repeat(64) }),
  });
  expect(r.status).toBe(200);
}

const TXID = 'T'.repeat(43);
const recoveryRecord = (): RecoveryRecord => ({
  status: 'signed', token: uuid(), gen: 0, txId: TXID, signedTx: '{}', signedAt: Date.now(), dueAt: FAR, attempts: 0,
  spendKey: `sk-${uuid()}`, reward: '10', spendRevision: 0, generation: 0,
});

/** A recovery record through the WRITER's primitive (counter, index, alarm). */
async function adopt(key: string, noteId: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(key));
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as RateLimiter).useEnvForTests(baseEnv as unknown as Parameters<RateLimiter['useEnvForTests']>[0]);
    return (instance as unknown as RateLimiter).adoptRecovery(noteId, recoveryRecord());
  });
}

async function census(e: WorkerEnv, opts: { auth?: string | null } = {}) {
  const res = await worker.fetch(new Request('https://proxy.example.com/admin/recovery-census', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.auth === null ? {} : { Authorization: opts.auth ?? `Bearer ${SECRET}` }) },
    body: '{}',
  }), e);
  const text = await res.text();
  let body: { census?: RecoveryCensus; workerVersionId?: string; releaseSha?: string } = {};
  try { body = JSON.parse(text); } catch { /* keep {} */ }
  return { status: res.status, text, body, headers: res.headers };
}

/** A namespace whose `global`/`key` object answers with `respond` instead. */
function failingFor(base: DurableObjectNamespace, name: string, respond: () => Response): DurableObjectNamespace {
  const bad = base.idFromName(name);
  return {
    idFromName: (n: string) => base.idFromName(n),
    get: (id: DurableObjectId) => (id.equals(bad) ? ({ fetch: async () => respond() } as unknown as DurableObjectStub) : base.get(id)),
    newUniqueId: () => base.newUniqueId(),
    idFromString: (s: string) => base.idFromString(s),
    jurisdiction: () => base,
  } as unknown as DurableObjectNamespace;
}

describe('auth, scope and caching', () => {
  it('503 without METRICS_ADMIN_SECRET; 401 without a bearer, with a wrong one, and with the SPEND admin bearer', async () => {
    const w = world('auth');
    expect((await census({ ...w.env, METRICS_ADMIN_SECRET: undefined } as WorkerEnv)).status).toBe(503);
    expect((await census(w.env, { auth: null })).status).toBe(401);
    expect((await census(w.env, { auth: 'Bearer nope' })).status).toBe(401);
    // Read-only by construction: the spend operator's bearer is a different key.
    expect((await census(w.env, { auth: `Bearer ${SPEND_SECRET}` })).status).toBe(401);
  });

  it('every answer on the path is no-store, and a successful one names the worker it was read from', async () => {
    const w = world('cache');
    for (const r of [await census(w.env, { auth: null }), await census(w.env)]) {
      expect(r.headers.get('Cache-Control')).toMatch(/no-store/);
    }
    const ok = await census(w.env);
    expect(ok.status).toBe(200);
    expect(ok.body.workerVersionId).toBe('census-version');
    expect(ok.body.releaseSha).toBe('c'.repeat(40));
  });
});

describe('the census', () => {
  it('empty: live AND revoked keys are enumerated and read; ordinary notes are not recovery', async () => {
    const w = world('empty');
    const live = await registeredKey(w.invites);
    const revoked = await registeredKey(w.invites, { revoke: true });
    await ordinaryNote(live);
    await ordinaryNote(revoked);
    const r = await census(w.env);
    expect(r.status).toBe(200);
    expect(r.body.census).toEqual({
      complete: true, verdict: 'empty',
      keys: { listed: 2, checked: 2, failed: 0 },
      legacyInvites: { unknown: 0, acknowledged: 0 },
      recovery: { count: 0, due: 0, records: 0, keysWithRecovery: 0 },
      reasons: [],
    });
  });

  it('a REVOKED key with a recovery record → not_empty — and the answer carries no key, noteId or txId', async () => {
    const w = world('revoked-recovery');
    const live = await registeredKey(w.invites);
    const revoked = await registeredKey(w.invites, { revoke: true });
    const noteId = uuid();
    await adopt(revoked, noteId);
    const r = await census(w.env);
    expect(r.body.census).toMatchObject({
      complete: true, verdict: 'not_empty',
      keys: { listed: 2, checked: 2, failed: 0 },
      recovery: { count: 1, due: 1, records: 1, keysWithRecovery: 1 },
      reasons: ['recovery_present'],
    });
    for (const secretish of [live, revoked, noteId, TXID]) expect(r.text).not.toContain(secretish);
  });

  it('a record the counter and index do not know (drift) is still found by the scan → not_empty + counter_drift', async () => {
    const w = world('drift');
    const key = await registeredKey(w.invites);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(key));
    await runInDurableObject(stub, (_i, state) => state.storage.put(`note:${uuid()}`, { ...recoveryRecord(), status: 'redrop_pending' }));
    const r = await census(w.env);
    expect(r.body.census).toMatchObject({
      complete: true, verdict: 'not_empty',
      recovery: { count: 0, due: 0, records: 1, keysWithRecovery: 1 },
      reasons: ['counter_drift', 'recovery_present'],
    });
  });

  it('an old-format invite hides its key → incomplete until acknowledged; operator-registered keys are then read too', async () => {
    const w = world('legacy');
    await registeredKey(w.invites);
    const invites = w.invites.get(w.invites.idFromName('global'));
    await runInDurableObject(invites, (_i, state) => state.storage.put(`invite:old-${uuid().slice(0, 8)}`, true));

    const before = await census(w.env);
    expect(before.body.census).toMatchObject({
      complete: false, verdict: 'incomplete',
      legacyInvites: { unknown: 1, acknowledged: 0 },
      reasons: ['legacy_invites_unacknowledged'],
    });

    const recovered = pk();
    await adopt(recovered, uuid());
    const guard = w.guard.get(w.guard.idFromName('global'));
    const set = await guard.fetch('http://internal/legacy-keys-set', { method: 'POST', body: JSON.stringify({ keys: [recovered], acknowledgeLegacyInvites: 1 }) });
    expect(set.status).toBe(200);

    const after = await census(w.env);
    expect(after.body.census).toMatchObject({
      complete: true, verdict: 'not_empty',
      keys: { listed: 2, checked: 2, failed: 0 },
      legacyInvites: { unknown: 1, acknowledged: 1 },
      recovery: { count: 1, keysWithRecovery: 1 },
    });
  });

  it('a key whose read fails → incomplete (key_read_failed), never empty', async () => {
    const w0 = world('read-fail');
    const good = await registeredKey(w0.invites);
    const bad = await registeredKey(w0.invites);
    await ordinaryNote(good);
    for (const respond of [() => new Response('boom', { status: 500 }), () => new Response('not json', { status: 200 }), () => Response.json({ recoveryCount: 0, due: 0 })]) {
      const e = { ...w0.env, RATE_LIMITER: failingFor(RATE_LIMITER, bad, respond) } as WorkerEnv;
      const r = await census(e);
      expect(r.body.census).toMatchObject({
        complete: false, verdict: 'incomplete',
        keys: { listed: 2, checked: 1, failed: 1 },
        reasons: ['key_read_failed'],
      });
    }
  });

  it('the key list itself fails, or the registered keys cannot be read → incomplete', async () => {
    const w = world('list-fail');
    await registeredKey(w.invites);
    const noList = await census({ ...w.env, INVITE_MANAGER: failingFor(w.invites, 'global', () => new Response('x', { status: 503 })) } as WorkerEnv);
    expect(noList.body.census).toMatchObject({ complete: false, verdict: 'incomplete', reasons: ['list_keys_failed'] });

    const noGuard = await census({ ...w.env, SPEND_GUARD: failingFor(w.guard, 'global', () => Response.json({ ok: false })) } as WorkerEnv);
    expect(noGuard.body.census).toMatchObject({ complete: false, verdict: 'incomplete', reasons: ['legacy_keys_failed'] });

    const unbound = await census({ ...w.env, SPEND_GUARD: undefined } as WorkerEnv);
    expect(unbound.body.census).toMatchObject({ complete: false, verdict: 'incomplete', reasons: ['legacy_keys_failed'] });
  });

  it(`more than ${CENSUS_MAX_KEYS} keys → incomplete (too_many_keys), nothing is read`, async () => {
    const w = world('too-many');
    const many = Array.from({ length: CENSUS_MAX_KEYS + 1 }, pk);
    const e = {
      ...w.env,
      INVITE_MANAGER: failingFor(w.invites, 'global', () => Response.json({ keys: many, unknownLegacyInvites: 0 })),
    } as WorkerEnv;
    const r = await census(e);
    expect(r.body.census).toMatchObject({
      complete: false, verdict: 'incomplete',
      keys: { listed: CENSUS_MAX_KEYS + 1, checked: 0, failed: 0 },
      reasons: ['too_many_keys'],
    });
  });
});
