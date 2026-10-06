import { describe, it, expect } from 'vitest';
import { PREPARED_LEASE_MS, SPEND_CODES } from '../src/spend-ledger';
import { MARKER_DEAD_AGE_MS } from '../src/spend-admin';
import { deferred, setupOutboundMock } from './helpers/outbound-mock';
import {
  LIMITS_ENV,
  closed, confirmedAll, deadAll, freshWallet, guardCall, guardStatus, handlerWith, isolatedGuard, markerMocks, pendingAll,
  spendEnv, viaHandler,
} from './helpers/spend-admin';

// D10 §12 — «маркер — durable-автомат» (ревью #7 H2): every crash boundary of
// the init automaton through the REAL route (`/admin/spend/init` = «continue
// by state»), a real RSA signature, a stubbed gateway pool and the DO on real
// storage. Spec §4.1. The transition table itself is spend-ledger.test.ts §4.1.

const { mockRoute } = setupOutboundMock();
const handler = handlerWith({ closeLegacySet: closed() });

async function frozen(name: string) {
  const env = spendEnv(isolatedGuard(name), await freshWallet());
  expect((await viaHandler(handler, 'freeze', env, { active: true })).status).toBe(200);
  return env;
}

describe('D10 marker automaton on durable storage', () => {
  it('preconditions: not frozen → spend_init_not_frozen; limits missing → spend_guard_unconfigured; an open legacy set refuses with its code — no network, no state', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('pre'), wallet);
    expect((await viaHandler(handler, 'init', env)).body.code).toBe(SPEND_CODES.initNotFrozen);
    await viaHandler(handler, 'freeze', env, { active: true });
    expect((await viaHandler(handler, 'init', { ...env, WALLET_FLOOR_WINSTON: undefined })).body.code).toBe(SPEND_CODES.guardUnconfigured);
    const open = await viaHandler(handlerWith({ closeLegacySet: async () => ({ kind: 'open', code: SPEND_CODES.initLegacyOpen }) }), 'init', env);
    expect(open.status).toBe(503);
    expect(open.body.code).toBe(SPEND_CODES.initLegacyOpen);
    const unknown = await viaHandler(handlerWith({ closeLegacySet: async () => ({ kind: 'open', code: SPEND_CODES.initLegacyRewardUnknown }) }), 'init', env);
    expect(unknown.body.code).toBe(SPEND_CODES.initLegacyRewardUnknown);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('none');
  });

  it('anchor unavailable → 502 and NO begin (no signing lease left behind); a quote above MAX_TX_REWARD → spend_quote_mismatch, still none', async () => {
    const env = await frozen('preSign');
    markerMocks(mockRoute, { anchorStatus: 503, post: 'none' });
    const a = await viaHandler(handler, 'init', env);
    expect(a.status).toBe(502);
    expect(a.body.code).toBe('arweave_gateway_unavailable');
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('none');
    markerMocks(mockRoute, { price: String(BigInt(LIMITS_ENV.MAX_TX_REWARD_WINSTON) + 1n), post: 'none' });
    const p = await viaHandler(handler, 'init', env);
    expect(p.status).toBe(503);
    expect(p.body.code).toBe(SPEND_CODES.quoteMismatch);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('none');
  });

  it('the marker is ≤ MARKER_MAX_BYTES, quantity 0, tagged Spend-Guard-Init=<cycle>, reward = the quote; a rejected POST leaves `signed`; the next init RESENDS THE SAME BYTES and reaches posted → waiting → done with h_init = max', async () => {
    const env = await frozen('happy');
    const legacyHandler = handlerWith({ closeLegacySet: closed([{ txId: 'L'.repeat(43), reward: '7', source: 'journal' }]) });
    const { post } = markerMocks(mockRoute, { post: 500 });
    const first = await viaHandler(legacyHandler, 'init', env);
    expect(first.status).toBe(502);
    expect(first.body.code).toBe('arweave_rejected');
    const sent = JSON.parse(post!.lastBody!) as { id: string; quantity: string; reward: string; data_size: string; tags: Array<{ name: string; value: string }> };
    expect(sent.quantity).toBe('0');
    expect(sent.reward).toBe('10');
    expect(Number(sent.data_size)).toBeLessThanOrEqual(64);
    const tags = sent.tags.map(t => ({ name: atob(t.name.replace(/-/g, '+').replace(/_/g, '/')), value: atob(t.value.replace(/-/g, '+').replace(/_/g, '/')) }));
    expect(tags).toEqual([{ name: 'App-Name', value: 'EternalNotes' }, { name: 'Spend-Guard-Init', value: '1' }]);
    let s = await guardStatus(env.SPEND_GUARD);
    expect(s.init).toMatchObject({ state: 'signed', txId: sent.id });
    expect(s.ledger.pending).toBe('7'); // the legacy hold was registered before the marker

    // Crash after `signed` before the POST: the next call resends the SAME
    // bytes — no anchor, no price, no second signature.
    const resend = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');
    const second = await viaHandler(legacyHandler, 'init', env);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(resend.lastBody).toBe(post!.lastBody);
    // …the status probes ran in the same call (no confirmed answer mocked →
    // unmocked fetch throws → `other` votes) and the step is `waiting`.
    expect(second.body.step).toBe('waiting');
    expect(second.body.init).toMatchObject({ state: 'posted', txId: sent.id });
    s = await guardStatus(env.SPEND_GUARD);
    expect(s.init.state).toBe('posted');
    expect(typeof s.init.postedAt).toBe('number');

    // Pending on both → still waiting; confirmed ≥ 50 on both → done, h_init = max.
    pendingAll(mockRoute, sent.id);
    expect((await viaHandler(legacyHandler, 'init', env)).body.step).toBe('waiting');
    confirmedAll(mockRoute, sent.id, [1000, 1003]);
    const done = await viaHandler(legacyHandler, 'init', env);
    expect(done.body.step).toBe('done');
    s = await guardStatus(env.SPEND_GUARD);
    expect(s.init).toMatchObject({ state: 'done', hInit: 1003 });
    expect(s.ledger).toMatchObject({ hInit: 1003, deposits: '0', spent: '0', pending: '7' });
    // Idempotent: done stays done, no network.
    expect((await viaHandler(legacyHandler, 'init', env)).body.step).toBe('done');
    expect((await viaHandler(handler, 'freeze', env, { active: false })).status).toBe(200);
  });

  it('crash after the POST before `posted` (the SDK threw — outcome unknown): the record stays signed; the resend of the same bytes is idempotent on the network; 208 counts as accepted', async () => {
    const env = await frozen('unknown');
    const { post } = markerMocks(mockRoute, { post: 'none' }); // unmocked POST → the SDK throws
    void post;
    const first = await viaHandler(handler, 'init', env);
    expect(first.status).toBe(502);
    expect(first.body.code).toBe('arweave_post_unknown');
    const s = await guardStatus(env.SPEND_GUARD);
    expect(s.init.state).toBe('signed');
    const txId = s.init.txId!;
    const again = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 208, 'Already Reported');
    pendingAll(mockRoute, txId);
    const second = await viaHandler(handler, 'init', env);
    expect(second.body.step).toBe('waiting');
    expect((JSON.parse(again.lastBody!) as { id: string }).id).toBe(txId);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('posted');
  });

  it('crash in `signing`: an unexpired lease → 409 init_in_progress (no second signature); an expired lease → a new begin takes over and ONE txId ends up durable', async () => {
    const env = await frozen('lease');
    const t0 = Date.now();
    expect((await guardCall(env.SPEND_GUARD, '/init-begin', { token: 'crashed', now: t0 })).status).toBe(200);
    // Within the lease: refused before any network (no mocks registered).
    const early = await viaHandler(handler, 'init', env);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe(SPEND_CODES.initInProgress);
    // Past the lease: the new attempt owns the record.
    const late = handlerWith({ closeLegacySet: closed(), now: () => t0 + PREPARED_LEASE_MS + 1 });
    markerMocks(mockRoute);
    const r = await viaHandler(late, 'init', env);
    expect(r.body.init?.state).toBe('posted');
    const txId = r.body.init!.txId!;
    // A late `signed` with the crashed token is stale — the durable txId is unchanged.
    expect((await guardCall(env.SPEND_GUARD, '/init-signed', { token: 'crashed', txId: 'X'.repeat(43), signedTx: 'b', anchor: 'a' })).body.code).toBe(SPEND_CODES.staleToken);
    expect((await guardStatus(env.SPEND_GUARD)).init.txId).toBe(txId);
  });

  it('two concurrent init → exactly one marker signed and sent; the loser gets 409 init_in_progress', async () => {
    const env = await frozen('race');
    const gate = deferred();
    const { post } = markerMocks(mockRoute, { times: 2, hold: gate.promise });
    const a = viaHandler(handler, 'init', env);
    const b = viaHandler(handler, 'init', env);
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.code).toBe(SPEND_CODES.initInProgress);
    expect(post!.calls).toBe(1);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('posted');
  });

  it('dead marker: unanimous 404 BEFORE the age guard → waiting; AFTER it → the record returns to none and a NEW marker is signed (new txId)', async () => {
    const env = await frozen('dead');
    markerMocks(mockRoute);
    const first = await viaHandler(handler, 'init', env);
    const oldTx = first.body.init!.txId!;
    deadAll(mockRoute, oldTx);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('waiting'); // too young
    const aged = handlerWith({ closeLegacySet: closed(), now: () => Date.now() + MARKER_DEAD_AGE_MS + 1 });
    deadAll(mockRoute, oldTx);
    const dead = await viaHandler(aged, 'init', env);
    expect(dead.body.step).toBe('dead');
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('none');
    markerMocks(mockRoute);
    const fresh = await viaHandler(aged, 'init', env);
    expect(fresh.body.init?.state).toBe('posted');
    expect(fresh.body.init!.txId).not.toBe(oldTx);
  });

  it('signed, the POST keeps failing while other gateways already confirm the marker: the next init reconciles by the quorum → posted → done WITHOUT another send (review 24.09, high)', async () => {
    const env = await frozen('stuck');
    const { post } = markerMocks(mockRoute, { post: 500 });
    const first = await viaHandler(handler, 'init', env);
    expect(first.body.code).toBe('arweave_rejected');
    const txId = (await guardStatus(env.SPEND_GUARD)).init.txId!;
    expect(post!.calls).toBe(1);
    // No POST route registered: a resend would throw (post_unknown) — the
    // quorum must be asked FIRST and be enough on its own.
    confirmedAll(mockRoute, txId, [2000, 2001]);
    const second = await viaHandler(handler, 'init', env);
    expect(second.body.step, JSON.stringify(second.body)).toBe('done');
    const s = await guardStatus(env.SPEND_GUARD);
    expect(s.init).toMatchObject({ state: 'done', txId, hInit: 2001 });
  });

  it('signed and unanimously dead past the age guard → none (a new marker only from there); before the age guard the bytes are resent', async () => {
    const env = await frozen('signeddead');
    markerMocks(mockRoute, { post: 500 });
    await viaHandler(handler, 'init', env);
    const txId = (await guardStatus(env.SPEND_GUARD)).init.txId!;
    // Young: dead on both, but the guard has not passed → the same bytes go out again.
    deadAll(mockRoute, txId);
    const resend = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 500, 'nope');
    expect((await viaHandler(handler, 'init', env)).body.code).toBe('arweave_rejected');
    expect(resend.calls).toBe(1);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('signed');
    // Old: → none, and nothing is sent.
    const aged = handlerWith({ closeLegacySet: closed(), now: () => Date.now() + MARKER_DEAD_AGE_MS + 1 });
    deadAll(mockRoute, txId);
    expect((await viaHandler(aged, 'init', env)).body.step).toBe('dead');
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('none');
  });

  it('a corrupt durable record (bytes ≠ txId) is neither resent nor re-signed: 503 spend_marker_corrupt, no network', async () => {
    const env = await frozen('corrupt');
    await guardCall(env.SPEND_GUARD, '/init-begin', { token: 't' });
    await guardCall(env.SPEND_GUARD, '/init-signed', { token: 't', txId: 'Q'.repeat(43), signedTx: JSON.stringify({ id: 'R'.repeat(43), format: 2, data: '', tags: [] }), anchor: 'a' });
    const r = await viaHandler(handler, 'init', env);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.markerCorrupt);
    expect((await guardStatus(env.SPEND_GUARD)).init.state).toBe('signed');
  });

  it('a quorum needs ≥2 OPERATORS: two origins of one operator confirming is not enough (waiting); the DO test covers the freeze exception for kind=marker', async () => {
    const env = await frozen('operators');
    markerMocks(mockRoute);
    const first = await viaHandler(handler, 'init', env);
    const txId = first.body.init!.txId!;
    const oneOperator = handlerWith({ closeLegacySet: closed(), operatorOf: () => 'same-operator' });
    confirmedAll(mockRoute, txId);
    const r = await viaHandler(oneOperator, 'init', env);
    expect(r.body.step).toBe('waiting');
    expect(r.body.quorum).toMatchObject({ confirmedOperators: 1, need: 2 });
    // Heights beyond the skew are not a quorum either.
    confirmedAll(mockRoute, txId, [1000, 1010]);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('waiting');
    // Confirmations below the deposit threshold are not a quorum.
    confirmedAll(mockRoute, txId, [1000, 1001], 49);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('waiting');
    confirmedAll(mockRoute, txId, [1000, 1001], 50);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('done');
  });
});
