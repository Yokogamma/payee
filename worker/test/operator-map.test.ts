import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import type { RateLimiter } from '../src/rate-limiter';
import { readAnchorProof } from '../src/anchor-expiry';
import { makeEmit } from '../src/metrics';
import { DEFAULT_STATUS_OPERATORS, distinctOperators, operatorMapOf, operatorOfEnv } from '../src/operators';
import { ANCHOR_EXPIRY_BLOCKS, ANCHOR_EXPIRY_MARGIN_BLOCKS, SPEND_CODES } from '../src/spend-ledger';
import { setupOutboundMock, STATUS_ORIGINS, statusUrlRe } from './helpers/outbound-mock';
import {
  bringToDone, confirmedAll, freshWallet, guardStatus, handlerWith, closed, isolatedGuard, markerMocks, mockTxAll, spendEnv, statusBody, txId43, viaHandler, viaWorker,
} from './helpers/spend-admin';
import { RATE_LIMITER, confirmedOnAll, makeIdentity, paidLegs, sagaEnv, upload, uploadRequest } from './helpers/spend-saga';

// The operator map on the WORKER (review 25.09: a mandatory condition of the
// reader release). Every money decision of the guard counts OPERATORS, and the
// main negative test is the same on every path: two origins of ONE operator
// are not a quorum. The map comes from the env (`STATUS_OPERATORS`); the
// bindings map the two test origins to two operators, and a suite that wants
// one operator overrides the var — no dependency injection, the real path.

const { mockRoute } = setupOutboundMock();
const ONE_OPERATOR = 'https://arweave.net=same,https://g2.test=same';
const HALF_KNOWN = 'https://arweave.net=arweave'; // g2.test unknown → no vote
const ANCHOR = 'A'.repeat(64);
const ANCHOR_HEIGHT = 1000;
const EXPIRED_AT = ANCHOR_HEIGHT + ANCHOR_EXPIRY_BLOCKS + ANCHOR_EXPIRY_MARGIN_BLOCKS;
const originRe = (origin: string, path: string) => new RegExp('^' + origin.replace(/\./g, '\\.') + path.replace(/\//g, '\\/') + '$');
function chainAt(height: number) {
  for (const o of STATUS_ORIGINS) {
    mockRoute('GET', originRe(o, `/block/hash/${ANCHOR}`), 200, JSON.stringify({ indep_hash: ANCHOR, height: ANCHOR_HEIGHT }));
    mockRoute('GET', originRe(o, '/info'), 200, JSON.stringify({ height }));
  }
}
describe('operators.ts — the map from the env, the pinned default, fail-closed unknowns', () => {
  it('unset/empty → the pinned default (five origins, five operators); set → as-is; an unknown origin is null', () => {
    const def = operatorMapOf({});
    expect(def.size).toBe(5);
    expect(new Set(def.values()).size).toBe(5);
    expect(operatorMapOf({ STATUS_OPERATORS: '' }).size).toBe(5);
    expect(operatorMapOf({ STATUS_OPERATORS: 'garbage' }).size).toBe(5); // unparseable = unset
    const one = operatorOfEnv({ STATUS_OPERATORS: ONE_OPERATOR });
    expect(one('https://arweave.net')).toBe('same');
    expect(one('https://g2.test')).toBe('same');
    expect(one('https://permagate.io')).toBeNull();
    expect(operatorOfEnv({})('https://permagate.io')).toBe('permagate');
    expect(distinctOperators({ STATUS_OPERATORS: ONE_OPERATOR }, [...STATUS_ORIGINS])).toBe(1);
    expect(distinctOperators({ STATUS_OPERATORS: HALF_KNOWN }, [...STATUS_ORIGINS])).toBe(1);
    expect(distinctOperators({}, [...STATUS_ORIGINS])).toBe(1); // only arweave.net is in the default
    expect(DEFAULT_STATUS_OPERATORS.split(',')).toHaveLength(5);
  });
});

describe('deposit: two origins of one operator verify nothing', () => {
  it('the same transfer, the same answers: two operators → credited; one operator (env map) → deposit_unverified with «1 operator(s)»; a half-known map → the same', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('opmap-dep'), wallet);
    const handler = handlerWith({ closeLegacySet: closed() });
    await bringToDone(mockRoute, handler, env);
    const t = txId43('opmap');
    const oneOp = spendEnv(env.SPEND_GUARD, wallet, { STATUS_OPERATORS: ONE_OPERATOR });
    await mockDeposit(t, wallet.address, { heights: [1002, 1004], quantity: '500' });
    const r1 = await viaWorker('credit-deposit', oneOp, { txId: t });
    expect(r1.body.code).toBe(SPEND_CODES.depositUnverified);
    expect(String(r1.body.reason)).toContain('1 operator(s) verified');
    const halfKnown = spendEnv(env.SPEND_GUARD, wallet, { STATUS_OPERATORS: HALF_KNOWN });
    await mockDeposit(t, wallet.address, { heights: [1002, 1004], quantity: '500' });
    const r2 = await viaWorker('credit-deposit', halfKnown, { txId: t });
    expect(r2.body.code).toBe(SPEND_CODES.depositUnverified);
    expect(String(r2.body.reason)).toContain('no known operator');
    expect((await guardStatus(env.SPEND_GUARD)).ledger.deposits).toBe('0');
    await mockDeposit(t, wallet.address, { heights: [1002, 1004], quantity: '500' });
    expect((await viaWorker('credit-deposit', env, { txId: t })).body).toMatchObject({ credited: true, witnesses: 2 });
  });
});

describe('marker: `done` needs two operators', () => {
  it('both origins confirmed, one operator (env map) → waiting with confirmedOperators 1; the pinned two-operator env → done', async () => {
    const wallet = await freshWallet();
    const env = spendEnv(isolatedGuard('opmap-marker'), wallet);
    const handler = handlerWith({ closeLegacySet: closed() });
    expect((await viaHandler(handler, 'freeze', env, { active: true })).status).toBe(200);
    markerMocks(mockRoute);
    const first = await viaHandler(handler, 'init', env);
    const txId = first.body.init!.txId!;
    const oneOp = spendEnv(env.SPEND_GUARD, wallet, { STATUS_OPERATORS: ONE_OPERATOR });
    confirmedAll(mockRoute, txId);
    const r = await viaHandler(handler, 'init', oneOp);
    expect(r.body.step).toBe('waiting');
    expect(r.body.quorum).toMatchObject({ confirmedOperators: 1, need: 2 });
    confirmedAll(mockRoute, txId);
    expect((await viaHandler(handler, 'init', env)).body.step).toBe('done');
  });
});

describe('spend: the money index settles only under two operators', () => {
  it('a POSTed txId confirmed at both origins: one operator (env map) → the reservation stays pending; the two-operator env → spent', async () => {
    const { env, status } = await sagaEnv('opmap-spend', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status).toBe(200);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    const oneOp = { ...env, STATUS_OPERATORS: ONE_OPERATOR };
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(oneOp as Parameters<RateLimiter['useEnvForTests']>[0]));
    const entry = (await money(stub))[0];
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, entry.dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '10', spent: '0' });
    expect((await money(stub))[0]).toMatchObject({ txId: r.body.txId, attempts: 1 });
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, (await money(stub))[0].dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    expect(await money(stub)).toEqual([]);
  });

  // The recheck path of /upload (`liveOf`) settles through the same
  // `moneyQuorum(votes, operatorOfEnv(env))` — the rule itself is covered by
  // the pure test (two origins of one operator → no quorum) and by the money
  // index above; the client-recheck trigger is exercised in upload-spend-saga.
});

describe('anchor expiry: the proof needs two operators', () => {
  it('both origins answer, one operator → unavailable (anchor_height); a half-known map → the same; two operators → expired', async () => {
    const emit = makeEmit({} as Parameters<typeof makeEmit>[0]);
    const base = { STATUS_GATEWAYS: STATUS_ORIGINS.join(',') };
    chainAt(EXPIRED_AT);
    expect(await readAnchorProof({ ...base, STATUS_OPERATORS: ONE_OPERATOR }, ANCHOR, emit)).toEqual({ kind: 'unavailable', reason: 'anchor_height' });
    chainAt(EXPIRED_AT);
    expect(await readAnchorProof({ ...base, STATUS_OPERATORS: HALF_KNOWN }, ANCHOR, emit)).toEqual({ kind: 'unavailable', reason: 'anchor_height' });
    chainAt(EXPIRED_AT);
    expect(await readAnchorProof({ ...base, STATUS_OPERATORS: 'https://arweave.net=a,https://g2.test=b' }, ANCHOR, emit)).toEqual({ kind: 'expired', anchorHeight: ANCHOR_HEIGHT, chainHeight: EXPIRED_AT });
  });
});

describe('/health attests the operator count', () => {
  it('statusOperatorsCount = 2 under the bindings, 1 under a one-operator map', async () => {
    const { env } = await sagaEnv('opmap-health');
    const h = async (e: typeof env) => (await (await worker.fetch(new Request('https://proxy.example.com/health'), e)).json()) as { statusOperatorsCount: number; statusGatewaysCount: number };
    expect(await h(env)).toMatchObject({ statusGatewaysCount: 2, statusOperatorsCount: 2 });
    expect((await h({ ...env, STATUS_OPERATORS: ONE_OPERATOR })).statusOperatorsCount).toBe(1);
  });
});

// ── small helpers ─────────────────────────────────────────────────────
const uuidV4 = () => crypto.randomUUID();
/** A verifiable transfer to `target` at both origins (same as the ledger suite). */
async function mockDeposit(txId: string, target: string, opts: { heights?: number[]; quantity?: string } = {}) {
  const sender = (await freshWallet()).n;
  const heights = opts.heights ?? [1500, 1502];
  STATUS_ORIGINS.forEach((origin, i) => mockRoute('GET', statusUrlRe(origin, txId), 200, statusBody(heights[i], 60)));
  mockTxAll(mockRoute, txId, { id: txId, owner: sender, target, quantity: opts.quantity ?? '500', reward: '1' });
}
async function money(stub: DurableObjectStub) {
  const res = await stub.fetch('http://do/recovery-status', { method: 'POST', body: '{}' });
  const rs = (await res.json()) as { money: Record<string, { txId: string; dueAt: number; attempts: number }> };
  return Object.values(rs.money);
}
async function runNow(stub: DurableObjectStub, now: number) {
  return runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).runRecovery(now));
}
