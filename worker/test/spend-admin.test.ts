import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { SPEND_CODES } from '../src/spend-ledger';
import { setupOutboundMock } from './helpers/outbound-mock';
import {
  AUTH, INVITE_SECRET, METRICS_SECRET, LIMITS_ENV,
  adminReq, bringToDone, closed, freshWallet, guardStatus, handlerWith, isolatedGuard, spendEnv, viaHandler, viaWorker,
} from './helpers/spend-admin';

// /admin/spend/* — routing, authentication order and scope (spec rev. 10 §5),
// freeze, status and reinit through the worker (direct dispatch, env
// overrides). The marker automaton and the deposit verification have their
// own §12 files (spend-guard.marker / spend-guard.ledger).

const { mockRoute } = setupOutboundMock();

describe('auth and config order', () => {
  it('503 spend_admin_unconfigured without SPEND_ADMIN_SECRET — checked BEFORE the bearer', async () => {
    const env = spendEnv(isolatedGuard('auth1'), await freshWallet(), { SPEND_ADMIN_SECRET: undefined });
    const r = await viaWorker('status', env);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.adminUnconfigured);
  });

  it('401 without a bearer or with an unknown one; 403 wrong_scope for the METRICS and the INVITE secrets', async () => {
    const env = spendEnv(isolatedGuard('auth2'), await freshWallet());
    expect((await viaWorker('status', env, {}, { auth: null })).status).toBe(401);
    expect((await viaWorker('status', env, {}, { auth: 'Bearer nope' })).status).toBe(401);
    const metrics = await viaWorker('status', env, {}, { auth: `Bearer ${METRICS_SECRET}` });
    expect(metrics.status).toBe(403);
    expect(metrics.body.code).toBe(SPEND_CODES.wrongScope);
    const invite = await viaWorker('freeze', env, { active: true }, { auth: `Bearer ${INVITE_SECRET}` });
    expect(invite.status).toBe(403);
    expect(invite.body.code).toBe(SPEND_CODES.wrongScope);
    // …and nothing was frozen by the refused call.
    expect((await guardStatus(env.SPEND_GUARD)).freeze.active).toBe(false);
  });

  it('every answer on the path is no-store (415 / 404 / 401 / 200 alike); GET is 405; an unknown op is 404', async () => {
    const env = spendEnv(isolatedGuard('auth3'), await freshWallet());
    const noCt = await worker.fetch(adminReq('status', {}, { contentType: null }), env);
    expect(noCt.status).toBe(415);
    expect(noCt.headers.get('Cache-Control')).toBe('no-store');
    const unknownOp = await worker.fetch(adminReq('nope'), env);
    expect(unknownOp.status).toBe(404);
    const get = await worker.fetch(adminReq('status', {}, { method: 'GET' }), env);
    expect(get.status).toBe(405);
    expect(get.headers.get('Cache-Control')).toBe('no-store');
    const unauth = await viaWorker('status', env, {}, { auth: null });
    expect(unauth.headers.get('Cache-Control')).toBe('no-store');
    const ok = await viaWorker('status', env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
  });

  it('400 for a non-object body; 413 over the body cap', async () => {
    const env = spendEnv(isolatedGuard('auth4'), await freshWallet());
    const arr = await worker.fetch(new Request('https://proxy.example.com/admin/spend/freeze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH }, body: '[]',
    }), env);
    expect(arr.status).toBe(400);
    const big = await worker.fetch(new Request('https://proxy.example.com/admin/spend/freeze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH }, body: JSON.stringify({ pad: 'x'.repeat(5000) }),
    }), env);
    expect(big.status).toBe(413);
  });
});

describe('status, freeze, reinit', () => {
  it('status reports the guard, the limits (configured or not), the wallet address and the status origins', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('status'), wallet);
    const r = await viaWorker('status', env);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      guard: { freeze: { active: false }, init: { state: 'none', cycle: 1 }, ledger: { cycle: 1, hInit: null }, available: '0' },
      limits: { configured: true, walletFloor: LIMITS_ENV.WALLET_FLOOR_WINSTON, windowCap: LIMITS_ENV.SPEND_WINDOW_CAP_WINSTON, maxTxReward: LIMITS_ENV.MAX_TX_REWARD_WINSTON },
      walletAddress: wallet.address,
      statusOrigins: ['https://arweave.net', 'https://g2.test'],
    });
    const unconfigured = await viaWorker('status', spendEnv(isolatedGuard('status'), wallet, { MAX_TX_REWARD_WINSTON: '12abc' }));
    expect(unconfigured.body.limits).toEqual({ configured: false });
  });

  it('freeze on → epoch 1; freeze off before done → 503 spend_not_initialized passed through; a non-boolean → 400', async () => {
    const env = spendEnv(isolatedGuard('freeze'), await freshWallet());
    expect((await viaWorker('freeze', env, { active: 'yes' })).status).toBe(400);
    const on = await viaWorker('freeze', env, { active: true });
    expect(on.status).toBe(200);
    expect(on.body.freeze).toMatchObject({ active: true, epoch: 1 });
    const off = await viaWorker('freeze', env, { active: false });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe(SPEND_CODES.notInitialized);
    expect((await guardStatus(env.SPEND_GUARD)).freeze).toMatchObject({ active: true, epoch: 1 });
  });

  it('reinit archives the cycle only under freeze; the marker record returns to none for the next cycle', async () => {
    const env = spendEnv(isolatedGuard('reinit'), await freshWallet());
    const handler = handlerWith({ closeLegacySet: closed() });
    await bringToDone(mockRoute, handler, env);
    const early = await viaWorker('reinit', env);
    expect(early.status).toBe(503);
    expect(early.body.code).toBe(SPEND_CODES.initNotFrozen);
    expect((await viaWorker('freeze', env, { active: true })).status).toBe(200);
    const r = await viaWorker('reinit', env);
    expect(r.status).toBe(200);
    expect(r.body.reinit).toMatchObject({ archivedCycle: 1, cycle: 2 });
    const s = await guardStatus(env.SPEND_GUARD);
    expect(s.init).toMatchObject({ state: 'none', cycle: 2 });
    expect(s.ledger).toMatchObject({ cycle: 2, hInit: null });
    // The thaw is refused again until the NEW cycle's marker is done.
    expect((await viaWorker('freeze', env, { active: false })).body.code).toBe(SPEND_CODES.notInitialized);
    // `init` on cycle 2 signs a NEW marker (nothing is reused from cycle 1).
    const { markerMocks, pendingAll } = await import('./helpers/spend-admin');
    markerMocks(mockRoute);
    const again = await viaHandler(handler, 'init', env);
    expect(again.body.init).toMatchObject({ state: 'posted', cycle: 2 });
    pendingAll(mockRoute, again.body.init!.txId!);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('waiting');
  });

  it('SpendGuard unavailable → 503 spend_guard_unavailable on every op', async () => {
    const broken = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO down'); } }),
    } as unknown as DurableObjectNamespace;
    const env = spendEnv(broken, await freshWallet());
    for (const op of ['status', 'reinit'] as const) {
      const r = await viaWorker(op, env);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe(SPEND_CODES.guardUnavailable);
    }
    const f = await viaWorker('freeze', env, { active: true });
    expect(f.body.code).toBe(SPEND_CODES.guardUnavailable);
    const i = await viaWorker('init', env);
    expect(i.body.code).toBe(SPEND_CODES.guardUnavailable);
  });
});
