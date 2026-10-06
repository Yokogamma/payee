import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import worker from '../../src/index';
import { addressOfJwk } from '../../test-stubs/wallet-address';
import {
  createSpendAdminHandler, DEFAULT_SPEND_ADMIN_DEPS,
  type LegacyItem, type SpendAdminDeps, type SpendAdminEnv, type SpendAdminHandler,
} from '../../src/spend-admin';
import { STATUS_ORIGINS, statusUrlRe, type OutboundRoute } from './outbound-mock';

/**
 * Shared fixture for the `/admin/spend/*` suites (D10 spend-admin.ts):
 * an ISOLATED SpendGuard per test (the handler always addresses
 * `idFromName('global')`, so isolation is a wrapped namespace that prefixes
 * the name), a signable RSA wallet declared trusted, the operator secret, the
 * three limits, request builders and the gateway mocks the marker and the
 * deposit verification need.
 */

type WorkerEnv = Parameters<typeof worker.fetch>[1];
export const baseEnv = env as unknown as WorkerEnv;
const SPEND_GUARD = (env as unknown as { SPEND_GUARD: DurableObjectNamespace }).SPEND_GUARD;
const RUN = crypto.randomUUID().slice(0, 8);

export const SECRET = 'spend-admin-secret-test';
export const AUTH = `Bearer ${SECRET}`;
export const METRICS_SECRET = 'metrics-secret-test';
export const INVITE_SECRET = 'test-admin-secret'; // the binding's ADMIN_SECRET (vitest.direct.config.mts)

export const LIMITS_ENV = { WALLET_FLOOR_WINSTON: '100', SPEND_WINDOW_CAP_WINSTON: '100000', MAX_TX_REWARD_WINSTON: '1000' };

/** A namespace whose `global` is this test's own object. */
export function isolatedGuard(name: string): DurableObjectNamespace {
  const prefix = `sa-${name}-${RUN}`;
  return {
    idFromName: (n: string) => SPEND_GUARD.idFromName(`${prefix}:${n}`),
    get: (id: DurableObjectId) => SPEND_GUARD.get(id),
    newUniqueId: () => SPEND_GUARD.newUniqueId(),
    idFromString: (s: string) => SPEND_GUARD.idFromString(s),
    jurisdiction: () => SPEND_GUARD,
  } as unknown as DurableObjectNamespace;
}

export const guardStub = (ns: DurableObjectNamespace) => ns.get(ns.idFromName('global'));

/** The same isolation for ANY `idFromName('global')` namespace (the
 *  InviteManager of the legacy closure). */
export function isolatedNs(base: DurableObjectNamespace, name: string): DurableObjectNamespace {
  const prefix = `iso-${name}-${RUN}`;
  return {
    idFromName: (n: string) => base.idFromName(`${prefix}:${n}`),
    get: (id: DurableObjectId) => base.get(id),
    newUniqueId: () => base.newUniqueId(),
    idFromString: (s: string) => base.idFromString(s),
    jurisdiction: () => base,
  } as unknown as DurableObjectNamespace;
}

export async function guardStatus(ns: DurableObjectNamespace) {
  const res = await guardStub(ns).fetch('http://spend-guard/status');
  return (await res.json()) as {
    available: string; spentLast24h: string;
    ledger: { cycle: number; hInit: number | null; deposits: string; spent: string; pending: string };
    freeze: { active: boolean; epoch: number };
    init: { state: string; cycle: number; txId?: string; postedAt?: number; hInit?: number };
  };
}

export async function guardCall(ns: DurableObjectNamespace, path: string, body: Record<string, unknown> = {}) {
  const res = await guardStub(ns).fetch(`http://spend-guard${path}`, { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> & { code?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed };
}

export interface Wallet { jwk: string; address: string; n: string }

/** A real signable RSA wallet (as the e2e suites generate) and its address. */
export async function freshWallet(): Promise<Wallet> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const jwk = JSON.stringify(exported);
  return { jwk, address: await addressOfJwk(jwk), n: exported.n! };
}

export function spendEnv(ns: DurableObjectNamespace, wallet: Wallet, extra: Record<string, unknown> = {}): WorkerEnv & SpendAdminEnv {
  return {
    ...baseEnv,
    SPEND_GUARD: ns,
    SPEND_ADMIN_SECRET: SECRET,
    METRICS_ADMIN_SECRET: METRICS_SECRET,
    ARWEAVE_JWK: wallet.jwk,
    TRUSTED_OWNERS: wallet.address,
    ...LIMITS_ENV,
    ...extra,
  } as WorkerEnv & SpendAdminEnv;
}

export function adminReq(op: string, body: unknown = {}, opts: { auth?: string | null; contentType?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers['Content-Type'] = opts.contentType ?? 'application/json';
  if (opts.auth !== null) headers.Authorization = opts.auth ?? AUTH;
  return new Request(`https://proxy.example.com/admin/spend/${op}`, {
    method: opts.method ?? 'POST', headers, body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

export async function viaWorker(op: string, env: WorkerEnv, body: unknown = {}, opts: Parameters<typeof adminReq>[2] = {}) {
  const res = await worker.fetch(adminReq(op, body, opts), env);
  const text = await res.text();
  let parsed: Record<string, unknown> & { code?: string; step?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** The handler with an injected closure of the legacy set (and clock). */
export function handlerWith(over: Partial<SpendAdminDeps>): SpendAdminHandler {
  return createSpendAdminHandler({ ...DEFAULT_SPEND_ADMIN_DEPS, ...over });
}
export const closed = (items: LegacyItem[] = []): SpendAdminDeps['closeLegacySet'] => async () => ({ kind: 'closed', items });

export async function viaHandler(handler: SpendAdminHandler, op: string, env: SpendAdminEnv, body: unknown = {}) {
  const res = await handler(adminReq(op, body), env);
  const text = await res.text();
  let parsed: Record<string, unknown> & { code?: string; step?: string; init?: { state: string; txId?: string; cycle: number; hInit?: number; signedBytes?: number | null } };
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed };
}

// ─── Gateway mocks ──────────────────────────────────────────────────────

type MockRoute = (method: string, url: RegExp, status: number, body: string, times?: number, opts?: { delayMs?: number; hold?: Promise<unknown>; makeBody?: () => BodyInit }) => OutboundRoute;

export const ANCHOR = 'A'.repeat(64);
export const anchorRe = /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/;
export const priceRe = /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/;
export const postRe = /^https:\/\/arweave\.net(?::443)?\/tx$/;

/** anchor + price + POST for ONE marker signature and send. */
export function markerMocks(mockRoute: MockRoute, opts: { price?: string; post?: number | 'none'; anchorStatus?: number; times?: number; hold?: Promise<unknown> } = {}) {
  const times = opts.times ?? 1;
  const anchor = mockRoute('GET', anchorRe, opts.anchorStatus ?? 200, ANCHOR, times, opts.hold ? { hold: opts.hold } : {});
  const price = opts.anchorStatus && opts.anchorStatus !== 200 ? null : mockRoute('GET', priceRe, 200, opts.price ?? '10', times);
  const post = opts.post === 'none' ? null : mockRoute('POST', postRe, opts.post ?? 200, opts.post === 200 || opts.post === undefined ? 'OK' : 'nope');
  return { anchor, price, post };
}

export function statusBody(height: number, confirmations: number): string {
  return JSON.stringify({ block_height: height, number_of_confirmations: confirmations, block_indep_hash: 'B'.repeat(64) });
}

/** One status answer per configured origin (the quorum needs the whole set). */
export function mockStatusAll(mockRoute: MockRoute, txId: string, answers: Array<{ status: number; body: string }>) {
  expect(answers).toHaveLength(STATUS_ORIGINS.length);
  return STATUS_ORIGINS.map((origin, i) => mockRoute('GET', statusUrlRe(origin, txId), answers[i].status, answers[i].body));
}
export const confirmedAll = (mockRoute: MockRoute, txId: string, heights = [1000, 1001], confirmations = 60) =>
  mockStatusAll(mockRoute, txId, heights.map(h => ({ status: 200, body: statusBody(h, confirmations) })));
export const pendingAll = (mockRoute: MockRoute, txId: string) =>
  mockStatusAll(mockRoute, txId, STATUS_ORIGINS.map(() => ({ status: 202, body: 'Pending' })));
export const deadAll = (mockRoute: MockRoute, txId: string) =>
  mockStatusAll(mockRoute, txId, STATUS_ORIGINS.map(() => ({ status: 404, body: 'Not Found' })));

export function txUrlRe(origin: string, txId: string): RegExp {
  return new RegExp('^' + origin.replace(/\./g, '\\.') + '/tx/' + txId + '$');
}

export interface TxJsonMock { id?: string; owner: string; target: string; quantity: string; reward?: string }
/** `/tx/<id>` JSON at every origin (or a per-origin override). */
export function mockTxAll(mockRoute: MockRoute, txId: string, json: TxJsonMock, per: Partial<Record<string, { status: number; body: string }>> = {}) {
  return STATUS_ORIGINS.map(origin => {
    const o = per[origin];
    return o
      ? mockRoute('GET', txUrlRe(origin, txId), o.status, o.body)
      : mockRoute('GET', txUrlRe(origin, txId), 200, JSON.stringify({ id: txId, reward: '1', ...json }));
  });
}

export const txId43 = (seed: string) => (seed.replace(/[^A-Za-z0-9_-]/g, '') + 'x'.repeat(43)).slice(0, 43);

/**
 * Freeze → init all the way to `done` (one call: sign → POST → quorum
 * confirmed) → thaw. Returns the marker txId. The env's wallet signs for real.
 */
export async function bringToDone(
  mockRoute: MockRoute, handler: SpendAdminHandler, env: SpendAdminEnv, heights = [1000, 1001],
): Promise<string> {
  expect((await viaHandler(handler, 'freeze', env, { active: true })).status).toBe(200);
  // The txId is only known after signing, so the status quorum is mocked on a
  // SECOND init call.
  markerMocks(mockRoute);
  const first = await viaHandler(handler, 'init', env);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.init?.state).toBe('posted');
  const txId = first.body.init!.txId!;
  confirmedAll(mockRoute, txId, heights);
  const second = await viaHandler(handler, 'init', env);
  expect(second.body.step).toBe('done');
  expect((await viaHandler(handler, 'freeze', env, { active: false })).status).toBe(200);
  return txId;
}
