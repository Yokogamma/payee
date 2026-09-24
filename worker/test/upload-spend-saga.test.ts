import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { PREPARED_LEASE_MS, SPEND_CODES } from '../src/spend-ledger';
import { spendKeyFor } from '../src/spend-saga';
import { setupOutboundMock } from './helpers/outbound-mock';
import { SPEND_LIMITS_ENV } from './helpers/spend-guard-ready';
import {
  RATE_LIMITER,
  confirmedOnAll, deadOnAll, fpOf, guardCall, makeIdentity, opRecord, paidLegs, sagaEnv, upload, uploadRequest,
} from './helpers/spend-saga';

// D10 §12 — «интеграция потока» (§8) through the REAL /upload route (direct
// dispatch, env overrides, a stubbed gateway pool, an isolated funded guard
// per test): check-and-reserve → refresh-balance → price → refresh-price →
// prepare → sign → op-posting → activate → permit-send → POST → settle by the
// confirmed quorum. The current format has no durable `signed`; the rows that
// need it (resend of the same bytes, recovery activation) stay `todo` for the
// scheduler step of the reader release.

const { mockRoute } = setupOutboundMock();
const uuidV4 = () => crypto.randomUUID();

describe('upload → spend saga, crash after each boundary', () => {
  it('happy path: prepare holds the reward as pending, the POST happens under a permit, and the CONFIRMED quorum on recheck settles it as spent exactly once', async () => {
    const { env, ns, status } = await sagaEnv('happy', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { post } = paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(post!.calls).toBe(1);
    const txId = r.body.txId!;
    let s = await status();
    expect(s.ledger).toMatchObject({ deposits: '1000', spent: '0', pending: '10' });
    expect(s.available).toBe('990');
    // The permit names the reservation of THIS operation.
    const permit = await runInDurableObject(ns.get(ns.idFromName('global')), (_i, state) =>
      state.storage.get<{ kind: string; spendKey?: string }>(`permit:${txId}`));
    expect(permit).toMatchObject({ kind: 'upload', spendKey: await spendKeyFor(id.pkB64, noteId, r.opId!) });
    expect((await opRecord(id.pkB64, r.opId!))).toMatchObject({ status: 'finished', outcome: 'accepted', paidResult: 'accepted', txId });

    // Recheck: confirmed at both origins → settle(spent) at the confirmed height.
    confirmedOnAll(mockRoute, txId, 5000, 12);
    const rc = await upload(await uploadRequest(id, noteId, { recheck: true }), env);
    expect(rc.status).toBe(200);
    expect(rc.body).toMatchObject({ txId, deduped: true });
    s = await status();
    expect(s.ledger).toMatchObject({ spent: '10', pending: '0' });
    expect(s.spentLast24h).toBe('10');
    // A second confirmed recheck is a no-op (the lattice: same outcome twice).
    confirmedOnAll(mockRoute, txId, 5001, 13);
    await upload(await uploadRequest(id, noteId, { recheck: true }), env);
    s = await status();
    expect(s.ledger).toMatchObject({ spent: '10', pending: '0' });
    const res = await runInDurableObject(ns.get(ns.idFromName('global')), (_i, state) =>
      state.storage.get<{ state: string; settledHeight?: number }>(`res:${permit!.spendKey}`));
    expect(res).toMatchObject({ state: 'spent', settledHeight: 5000 });
  });

  it('crash after prepare (before sign): the signature fails → 502, the reservation is `prepared` with a lease, the alarm is armed, and expire-leases past the lease releases the pending; no POST', async () => {
    const { env, ns, status, wallet } = await sagaEnv('lease');
    const id = await makeIdentity();
    // Structurally complete, cryptographically broken: anchor + price are
    // spent, signing throws (the existing `arweave_throw` outcome).
    const broken = { ...env, ARWEAVE_JWK: JSON.stringify({ ...JSON.parse(wallet.jwk), d: '!!!not-base64url!!!' }) };
    paidLegs(mockRoute, { price: '7', post: 'none' });
    const r = await upload(await uploadRequest(id, uuidV4()), broken);
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('arweave_internal');
    let s = await status();
    expect(s.ledger.pending).toBe('7');
    const stub = ns.get(ns.idFromName('global'));
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(typeof alarm).toBe('number');
    expect(alarm! - Date.now()).toBeLessThanOrEqual(PREPARED_LEASE_MS);
    // Before the lease ends nothing is released; after it the alarm's work does.
    expect((await guardCall(ns, '/expire-leases', { now: Date.now() })).body).toMatchObject({ expired: 0 });
    expect((await guardCall(ns, '/expire-leases', { now: Date.now() + PREPARED_LEASE_MS + 1 })).body).toMatchObject({ expired: 1, released: '7', nextDueAt: null });
    s = await status();
    expect(s.ledger.pending).toBe('0');
  });

  it.todo('crash after sign before durable signed → the ephemeral signature is dropped; resign_violation does NOT fire on an ephemeral signature (writer format)');
  it.todo('crash after durable signed before activate → recovery activates (same {reward, revision}) and continues; a changed reward → remap under §5 checks (scheduler step)');
  it.todo('crash between activate and permit-send → recovery asks permit-send first; under freeze it is refused and the record is kept (no release) (scheduler step)');
  it.todo('crash after permit-send before POST → the same permit is returned and the same bytes are POSTed; one txId (scheduler step)');

  it('crash after POST before settle (the answer was lost): the reservation stays `active` — never released by a timer — until the quorum confirms; a gateway 5xx keeps it too', async () => {
    const { env, status } = await sagaEnv('unknown');
    const id = await makeIdentity();
    paidLegs(mockRoute, { price: '3', post: 'none' }); // unmocked POST → the SDK throws → post_unknown
    const r1 = await upload(await uploadRequest(id, uuidV4()), env);
    expect(r1.status).toBe(502);
    expect(r1.body.code).toBe('arweave_post_unknown');
    expect((await status()).ledger.pending).toBe('3');
    paidLegs(mockRoute, { price: '4', post: 500 });
    const r2 = await upload(await uploadRequest(id, uuidV4()), env);
    expect(r2.status).toBe(502);
    expect(r2.body.code).toBe('arweave_rejected');
    expect((await status()).ledger.pending).toBe('7');
  });

  it('redrop: a PROVEN dead transaction releases its reservation, phase 2 opens a NEW generation and posts under permit-send(kind: redrop2)', async () => {
    const { env, ns, status } = await sagaEnv('redrop', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const deadTx = `DEAD${noteId.replace(/-/g, '')}`.padEnd(43, 'x').slice(0, 43);
    // The old generation: a reservation activated and permitted for deadTx.
    const oldKey = await spendKeyFor(id.pkB64, noteId, uuidV4());
    const q = await guardCall(ns, '/refresh-price', { bytes: 100, reward: '10' });
    expect((await guardCall(ns, '/prepare', { spendKey: oldKey, reward: '10', revision: 0, quoteId: q.body.quoteId, bytes: 100, limits: { walletFloor: '0', windowCap: '1000000', maxTxReward: '1000' } })).status).toBe(200);
    expect((await guardCall(ns, '/activate', { spendKey: oldKey, reward: '10', revision: 0, activatedBy: '10:0' })).status).toBe(200);
    expect((await guardCall(ns, '/permit-send', { txId: deadTx, kind: 'upload', cycle: 1, spendKey: oldKey })).status).toBe(200);
    expect((await status()).ledger.pending).toBe('10');
    // The per-key record: posted 31 min ago under deadTx, with this payload's fp.
    await runInDurableObject(RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64)), async (_i, state) => {
      await state.storage.put(`note:${noteId}`, {
        status: 'posted', token: 'srv-token', gen: 0, txId: deadTx, postedAt: Date.now() - 31 * 60_000, fp: await fpOf(noteId),
      });
    });
    deadOnAll(mockRoute, deadTx);
    const { post } = paidLegs(mockRoute, { price: '12' });
    const r = await upload(await uploadRequest(id, noteId, { recheck: true }), env);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.txId).not.toBe(deadTx);
    expect(post!.calls).toBe(1);
    const s = await status();
    // Old reservation released (−10), the new generation's 12 pending.
    expect(s.ledger).toMatchObject({ spent: '0', pending: '12' });
    const stub = ns.get(ns.idFromName('global'));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<{ state: string }>(`res:${oldKey}`))).toMatchObject({ state: 'released' });
    const permit = await runInDurableObject(stub, (_i, state) => state.storage.get<{ kind: string }>(`permit:${r.body.txId}`));
    expect(permit).toMatchObject({ kind: 'redrop2' });
  });

  it('activate conflict: a reservation under this operation\'s spendKey already active for someone else → 503 activate_conflict, the journal record is aborted with that code, no POST', async () => {
    const { env, ns, status } = await sagaEnv('conflict');
    const id = await makeIdentity();
    const noteId = uuidV4();
    const opId = uuidV4();
    const key = await spendKeyFor(id.pkB64, noteId, opId);
    const q = await guardCall(ns, '/refresh-price', { bytes: 100, reward: '5' });
    await guardCall(ns, '/prepare', { spendKey: key, reward: '5', revision: 0, quoteId: q.body.quoteId, bytes: 100, limits: { walletFloor: '0', windowCap: '1000000', maxTxReward: '1000' } });
    await guardCall(ns, '/activate', { spendKey: key, reward: '5', revision: 0, activatedBy: 'someone-else' });
    paidLegs(mockRoute, { price: '5', post: 'none' });
    const r = await upload(await uploadRequest(id, noteId, { operationId: opId }), env);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.activateConflict);
    expect(r.opId).toBe(opId);
    // The refusal came from `prepare` (the reservation is not ours): the record
    // never reached `posting`, so it is closed as a plain refusal.
    expect(await opRecord(id.pkB64, opId)).toMatchObject({ status: 'finished', code: SPEND_CODES.activateConflict, paidResult: 'none' });
    expect((await status()).ledger.pending).toBe('5'); // the foreign reservation is untouched
  });

  it('floor and window cap refuse BEFORE signing: 503 spend_floor / spend_window_cap, nothing pending, no POST', async () => {
    const id = await makeIdentity();
    const floor = await sagaEnv('floor', { deposit: '100', limits: { WALLET_FLOOR_WINSTON: '95' } });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r1 = await upload(await uploadRequest(id, uuidV4()), floor.env);
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe(SPEND_CODES.floor);
    expect((await floor.status()).ledger.pending).toBe('0');
    const cap = await sagaEnv('cap', { deposit: '1000', limits: { SPEND_WINDOW_CAP_WINSTON: '9' } });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r2 = await upload(await uploadRequest(id, uuidV4()), cap.env);
    expect(r2.body.code).toBe(SPEND_CODES.windowCap);
    // …and a quote above MAX_TX_REWARD is refused the same way.
    const ceiling = await sagaEnv('ceiling', { deposit: '1000', limits: { MAX_TX_REWARD_WINSTON: '9' } });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r3 = await upload(await uploadRequest(id, uuidV4()), ceiling.env);
    expect(r3.body.code).toBe(SPEND_CODES.quoteMismatch);
    expect(SPEND_LIMITS_ENV.WALLET_FLOOR_WINSTON).toBe('0');
  });
});
