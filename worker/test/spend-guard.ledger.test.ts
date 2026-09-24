import { describe, it, expect } from 'vitest';
import { MIN_DEPOSIT_CONFIRMATIONS, SPEND_CODES } from '../src/spend-ledger';
import { STATUS_ORIGINS, setupOutboundMock, statusUrlRe } from './helpers/outbound-mock';
import {
  METRICS_SECRET,
  bringToDone, closed, freshWallet, guardStatus, handlerWith, isolatedGuard, mockTxAll, spendEnv, statusBody, txId43,
  viaHandler, viaWorker,
} from './helpers/spend-admin';
import { balanceOnAll, makeIdentity, paidLegs, sagaEnv, upload, uploadRequest } from './helpers/spend-saga';
import { resetSpendBalanceCache } from '../src/spend-saga';
import { SPEND_LIMITS_ENV } from './helpers/spend-guard-ready';

// D10 §12 — «пополнение и маркер» (ревью #4–#6): `credit-deposit` through the
// worker route with a stubbed gateway pool — the verification at ≥2 operators
// (§4.2), the marker height as the boundary, idempotency — and the §3.4
// detector rows that belong to the upload saga (kept as todo here).

const { mockRoute } = setupOutboundMock();
const handler = handlerWith({ closeLegacySet: closed() });

/** A verified transfer INTO the worker wallet from another wallet, confirmed
 *  at both origins at the given heights. */
async function mockDeposit(txId: string, target: string, opts: { heights?: number[]; confirmations?: number[]; quantity?: string; owner?: string; quantities?: string[] } = {}) {
  const sender = opts.owner ?? (await freshWallet()).n;
  const heights = opts.heights ?? [1500, 1502];
  const conf = opts.confirmations ?? [60, 61];
  STATUS_ORIGINS.forEach((origin, i) => {
    mockRoute('GET', statusUrlRe(origin, txId), 200, statusBody(heights[i], conf[i]));
  });
  if (opts.quantities) {
    STATUS_ORIGINS.forEach((origin, i) => {
      mockRoute('GET', new RegExp('^' + origin.replace(/\./g, '\\.') + '/tx/' + txId + '$'), 200,
        JSON.stringify({ id: txId, owner: sender, target, quantity: opts.quantities![i], reward: '1' }));
    });
  } else {
    mockTxAll(mockRoute, txId, { owner: sender, target, quantity: opts.quantity ?? '500' });
  }
}

describe('D10 deposits, marker height and the balance detector', () => {
  it('counterexample review #6: marker at 1001 → a transfer at 1000 is refused (409 deposit_before_marker), one at 1002+ is credited exactly once; the amount is the quantity the operators agree on', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('dep'), wallet);
    await bringToDone(mockRoute, handler, env, [1000, 1001]); // h_init = 1001
    const below = txId43('below');
    await mockDeposit(below, wallet.address, { heights: [1000, 1000] });
    const r0 = await viaWorker('credit-deposit', env, { txId: below });
    expect(r0.status).toBe(409);
    expect(r0.body.code).toBe(SPEND_CODES.depositBeforeMarker);
    const above = txId43('above');
    await mockDeposit(above, wallet.address, { heights: [1002, 1004], quantity: '500' });
    const r1 = await viaWorker('credit-deposit', env, { txId: above });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ credited: true, amount: '500', depositHeight: 1002, witnesses: 2, deposits: '500', available: '500' });
    await mockDeposit(above, wallet.address, { heights: [1002, 1004], quantity: '500' });
    const r2 = await viaWorker('credit-deposit', env, { txId: above });
    expect(r2.body).toMatchObject({ credited: false, deposits: '500' });
    expect((await guardStatus(env.SPEND_GUARD)).available).toBe('500');
  });

  it('a transaction of the worker wallet itself (an outgoing one, or the marker) is never a deposit → 503 deposit_unverified', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('own'), wallet);
    const marker = await bringToDone(mockRoute, handler, env);
    await mockDeposit(marker, wallet.address, { owner: wallet.n, heights: [1100, 1100] });
    const r = await viaWorker('credit-deposit', env, { txId: marker });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.depositUnverified);
    expect(String(r.body.reason)).toContain('worker wallet itself');
    const outgoing = txId43('outgoing');
    await mockDeposit(outgoing, 'someone-else-address-not-ours', { heights: [1100, 1100] });
    const o = await viaWorker('credit-deposit', env, { txId: outgoing });
    expect(o.body.code).toBe(SPEND_CODES.depositUnverified);
    expect((await guardStatus(env.SPEND_GUARD)).ledger.deposits).toBe('0');
  });

  it('≥2 independent operators, each ≥ MIN_DEPOSIT_CONFIRMATIONS, heights within the skew; depositHeight = the minimum; one operator, disagreeing quantities, low confirmations or a wide skew → unverified', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('quorum'), wallet);
    await bringToDone(mockRoute, handler, env);
    const t = txId43('quorum');
    // One origin cannot read the tx → one witness.
    STATUS_ORIGINS.forEach(origin => mockRoute('GET', statusUrlRe(origin, t), 200, statusBody(1500, 60)));
    mockTxAll(mockRoute, t, { owner: (await freshWallet()).n, target: wallet.address, quantity: '5' }, { 'https://g2.test': { status: 404, body: 'nf' } });
    expect((await viaWorker('credit-deposit', env, { txId: t })).body.code).toBe(SPEND_CODES.depositUnverified);
    // Two origins of ONE operator → one voice.
    await mockDeposit(t, wallet.address);
    const oneOp = handlerWith({ closeLegacySet: closed(), operatorOf: () => 'same' });
    expect((await viaHandler(oneOp, 'credit-deposit', env, { txId: t })).body.code).toBe(SPEND_CODES.depositUnverified);
    // Quantities disagree.
    await mockDeposit(t, wallet.address, { quantities: ['500', '501'] });
    expect(String((await viaWorker('credit-deposit', env, { txId: t })).body.reason)).toContain('quantity');
    // Confirmations below the threshold at one origin → that witness is dropped → one left.
    await mockDeposit(t, wallet.address, { confirmations: [MIN_DEPOSIT_CONFIRMATIONS, MIN_DEPOSIT_CONFIRMATIONS - 1] });
    expect((await viaWorker('credit-deposit', env, { txId: t })).body.code).toBe(SPEND_CODES.depositUnverified);
    // Heights beyond MAX_STATUS_HEIGHT_SKEW.
    await mockDeposit(t, wallet.address, { heights: [1500, 1510] });
    expect(String((await viaWorker('credit-deposit', env, { txId: t })).body.reason)).toContain('heights');
    // Nothing above was credited; the clean case is, at the MINIMUM height.
    expect((await guardStatus(env.SPEND_GUARD)).ledger.deposits).toBe('0');
    await mockDeposit(t, wallet.address, { heights: [1503, 1500] });
    expect((await viaWorker('credit-deposit', env, { txId: t })).body).toMatchObject({ credited: true, depositHeight: 1500 });
  });

  it('credit-deposit before init done → 503 spend_not_initialized (after the verification); a malformed txId → 400 before any network', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('early'), wallet);
    expect((await viaWorker('credit-deposit', env, { txId: 'short' })).status).toBe(400);
    const t = txId43('early');
    await mockDeposit(t, wallet.address);
    const r = await viaWorker('credit-deposit', env, { txId: t });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.notInitialized);
  });

  it('/admin/spend/* with METRICS_ADMIN_SECRET → 403 wrong_scope', async () => {
    const env = spendEnv(isolatedGuard('scope'), await freshWallet());
    const r = await viaWorker('credit-deposit', env, { txId: txId43('scope') }, { auth: `Bearer ${METRICS_SECRET}` });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(SPEND_CODES.wrongScope);
  });

  it('prepare before init done → 503 spend_not_initialized through /upload; nothing pending, no POST', async () => {
    const wallet = await freshWallet();
    const ns = isolatedGuard('notinit');
    const env = { ...spendEnv(ns, wallet), ...SPEND_LIMITS_ENV };
    const id = await makeIdentity();
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r = await upload(await uploadRequest(id, crypto.randomUUID()), env);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.notInitialized);
    expect((await guardStatus(ns)).ledger.pending).toBe('0');
  });

  it('§3.4 detector: observedMin (minimum over ≥ MIN_BALANCE_SOURCES gateway answers) below available → 503 spend_ledger_inconsistent; fewer answers than MIN_BALANCE_SOURCES → inert, the ledger decides alone', async () => {
    const { env, wallet, status } = await sagaEnv('detector', { deposit: '1000' });
    const id = await makeIdentity();
    // Both origins say 500 while the ledger says 1000 available: an outflow
    // the ledger did not book → fail closed until reinit.
    resetSpendBalanceCache();
    balanceOnAll(mockRoute, wallet.address, '500');
    paidLegs(mockRoute, { price: '10', post: 'none' });
    const r1 = await upload(await uploadRequest(id, crypto.randomUUID()), env);
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe(SPEND_CODES.ledgerInconsistent);
    expect((await status()).observedMin).toBe('500');
    // The minimum wins when the origins disagree: 2000 and 900 → 900 < 1000.
    resetSpendBalanceCache();
    balanceOnAll(mockRoute, wallet.address, '2000', { 'https://g2.test': { status: 200, body: '900' } });
    paidLegs(mockRoute, { price: '10', post: 'none' });
    expect((await upload(await uploadRequest(id, crypto.randomUUID()), env)).body.code).toBe(SPEND_CODES.ledgerInconsistent);
    // One origin only → no quorum → the detector is inert (observedMin null)
    // and the upload proceeds on the ledger alone.
    resetSpendBalanceCache();
    balanceOnAll(mockRoute, wallet.address, '500', { 'https://g2.test': { status: 503, body: 'down' } });
    const { post } = paidLegs(mockRoute, { price: '10' });
    const r3 = await upload(await uploadRequest(id, crypto.randomUUID()), env);
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    expect(post!.calls).toBe(1);
    expect((await status()).observedMin).toBeNull();
    // A gateway balance ABOVE the ledger never raises available.
    resetSpendBalanceCache();
    balanceOnAll(mockRoute, wallet.address, '999999');
    const { post: post2 } = paidLegs(mockRoute, { price: '10' });
    await upload(await uploadRequest(id, crypto.randomUUID()), env);
    expect(post2!.calls).toBe(1);
    expect((await status()).available).toBe('980');
  });

  // DO-level rows (spend-guard.do.test.ts covers the quote binding and the
  // per-transaction isolation of the ledger); the concurrent case is the
  // storage transaction's own guarantee.
  it.todo('concurrent prepare around credit-deposit: each in its own storage transaction, no partial state, available never goes negative');
});
