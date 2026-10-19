import { describe, it, expect } from 'vitest';
import { SPEND_CODES } from '../src/spend-ledger';
import { deferred, setupOutboundMock } from './helpers/outbound-mock';
import { guardCall, guardWithHook, makeIdentity, opRecord, paidLegs, sagaEnv, upload, uploadRequest } from './helpers/spend-saga';
import { pregenerateWallets } from './helpers/wallet-pool';

// D10 §12 — «барьер отправки и заморозка» (ревью #8 H2/M2, #9 H3) through
// the REAL /upload route: a freeze that becomes durable while a request is in
// flight refuses it at the guard, and no POST exists without a permit. The
// pure decisions rest in spend-ledger.test.ts (permitDecision, refusalBranch);
// the static half is worker/scripts/permit-send-static.test.mjs (root
// vitest): no `transactions.post` / `postSignedTx` outside spend-send.ts.
// Rows that need a durable `signed` (1б, 1в) wait for the scheduler step.

const { mockRoute } = setupOutboundMock();
// Every wallet the tests below take (freshWallet / sagaEnv) is generated
// before the first test — never in a test body (helpers/wallet-pool.ts).
// 4 = one per `sagaEnv`.
pregenerateWallets(4);

// Tests that are long BY NATURE carry an explicit budget instead of the 5 s
// default: RSA-signed uploads through /upload against freezes and the DO
// barrier. They take up to 1.3 s on a quiet machine, and a loaded runner
// stretches a run several times over (0.3 s was seen at 3.4 s, 0.6 s at
// 5.9 s).
const LONG_TEST_MS = 20_000;

const uuidV4 = () => crypto.randomUUID();

describe('D10 permit-send — the single path to the network', () => {
  it('(1) counterexample review #8: a request parked at the quote → freeze → resume → 503 spend_frozen, no POST, nothing pending, the record closed with the reason', async () => {
    const { env, ns, status } = await sagaEnv('parked');
    const id = await makeIdentity();
    const gate = deferred();
    paidLegs(mockRoute, { price: '10', post: 'none', priceHold: gate.promise });
    const inFlight = upload(await uploadRequest(id, uuidV4()), env);
    // The request is parked at the price leg; the freeze becomes durable now.
    expect((await guardCall(ns, '/freeze', { active: true })).status).toBe(200);
    gate.resolve();
    const r = await inFlight;
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.frozen);
    expect((await status()).ledger.pending).toBe('0');
    expect(await opRecord(id.pkB64, r.opId!)).toMatchObject({ status: 'finished', code: SPEND_CODES.frozen, paidResult: 'none' });
  }, LONG_TEST_MS);

  it('(1) the LAST line: a freeze that lands between activate and permit-send is still refused — permit-send is durable, not a flag — the journal record is aborted (`frozen`), the reservation released', async () => {
    const { env, ns, status } = await sagaEnv('lastline');
    const id = await makeIdentity();
    const hooked = guardWithHook(ns, '/activate', async () => { await guardCall(ns, '/freeze', { active: true }); });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r = await upload(await uploadRequest(id, uuidV4()), { ...env, SPEND_GUARD: hooked });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.frozen);
    expect(await opRecord(id.pkB64, r.opId!)).toMatchObject({ status: 'finished', outcome: 'audit_aborted', code: SPEND_CODES.frozen, paidResult: 'none' });
    const s = await status();
    expect(s.freeze.active).toBe(true);
    expect(s.ledger.pending).toBe('0'); // active → released: provably never sent
  }, LONG_TEST_MS);

  // (1б) and (1в) — a durable `signed` under freeze (POSTed with the answer
  // lost, or never POSTed) keeps its record, bytes and hold and is only
  // rescheduled: test/recovery-scheduler.test.ts «a frozen guard refuses the
  // resend permit».

  it('(3) under freeze uploads are refused while the marker of the current cycle is the ONE exception (spend-guard.marker.test.ts); after the thaw the upload proceeds', async () => {
    const { env, ns } = await sagaEnv('thaw');
    const id = await makeIdentity();
    await guardCall(ns, '/freeze', { active: true });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    expect((await upload(await uploadRequest(id, uuidV4()), env)).body.code).toBe(SPEND_CODES.frozen);
    await guardCall(ns, '/freeze', { active: false });
    const { post } = paidLegs(mockRoute, { price: '10' });
    expect((await upload(await uploadRequest(id, uuidV4()), env)).status).toBe(200);
    expect(post!.calls).toBe(1);
  }, LONG_TEST_MS);

  it('(5) SpendGuard unavailable (the DO does not answer) → 503 spend_guard_unavailable and not a single POST; the per-key reservation is released', async () => {
    const { env } = await sagaEnv('down');
    const id = await makeIdentity();
    const down = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO down'); } }),
    } as unknown as DurableObjectNamespace;
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const noteId = uuidV4();
    const r = await upload(await uploadRequest(id, noteId), { ...env, SPEND_GUARD: down });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.guardUnavailable);
    expect(await opRecord(id.pkB64, r.opId!)).toMatchObject({ status: 'finished', code: SPEND_CODES.guardUnavailable, paidResult: 'none' });
    // Released: the same note publishes once the guard is back.
    const { post } = paidLegs(mockRoute, { price: '10' });
    expect((await upload(await uploadRequest(id, noteId), env)).status).toBe(200);
    expect(post!.calls).toBe(1);
  }, LONG_TEST_MS);

  // (2) static: worker/scripts/permit-send-static.test.mjs (root vitest — the
  // workers pool has no node:fs). (4) repeat permit for the same txId returns
  // the same permit: spend-guard.do.test.ts. /admin/spend/freeze auth:
  // spend-admin.test.ts.
});
