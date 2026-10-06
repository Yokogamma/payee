import { env } from 'cloudflare:test';
import * as ed from '@noble/ed25519';
import { expect } from 'vitest';
import worker from '../../src/index';
import { computePublicationFp } from '../../src/publication-fp';
import { b64, sha256, statusUrlRe, STATUS_ORIGINS, type OutboundRoute } from './outbound-mock';
import { freshWallet, isolatedGuard, type Wallet } from './spend-admin';
import { spendGuardReady, spendGuardStatus, SPEND_LIMITS_ENV } from './spend-guard-ready';

/**
 * Fixture for the upload saga suites (spend-saga.ts, §8): a signed v2 upload
 * request from a registered identity, the paid-leg mocks, an ISOLATED and
 * funded guard per test, and a guard namespace wrapper that runs a hook
 * after a given DO route (the freeze-between-activate-and-permit case).
 */

type WorkerEnv = Parameters<typeof worker.fetch>[1];
export const baseEnv = env as unknown as WorkerEnv;
export const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
export const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

export const C = 'AAAAAAAAAAAAAAAAAAAAAA==';
export const IV = 'AAAAAAAAAAAAAAAA';
const nextIp = () => `saga-${crypto.randomUUID().slice(0, 8)}`;

export interface Identity { priv: Uint8Array; pkB64: string; ownerHash: string }

export async function makeIdentity(): Promise<Identity> {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

export const dataOf = (noteId: string) => JSON.stringify({ id: noteId, c: C, iv: IV });
export const fpOf = (noteId: string) => computePublicationFp('2', dataOf(noteId));

export async function uploadRequest(
  id: Identity, noteId: string,
  opts: { recheck?: boolean; operationId?: string; recovery?: { txId: string; postedAt: number; token: string } } = {},
): Promise<Request> {
  const body = JSON.stringify({
    data: dataOf(noteId),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '2' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: noteId },
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    ...(opts.recheck ? { recheck: true } : {}),
    ...(opts.operationId ? { operationId: opts.operationId } : {}),
    ...(opts.recovery ? { recovery: opts.recovery } : {}),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': nextIp() },
    body,
  });
}

export async function upload(req: Request, envOverride: WorkerEnv) {
  const res = await worker.fetch(req, envOverride);
  const text = await res.text();
  let body: Record<string, unknown> & { code?: string; txId?: string; operationId?: string; committed?: boolean };
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: res.status, body, opId: res.headers.get('X-Operation-Id') };
}

/** An isolated, initialised, funded guard and the env that uses it. */
export async function sagaEnv(name: string, opts: { deposit?: string; limits?: Partial<typeof SPEND_LIMITS_ENV>; wallet?: Wallet; ns?: DurableObjectNamespace } = {}) {
  const wallet = opts.wallet ?? await freshWallet();
  const ns = opts.ns ?? isolatedGuard(`saga-${name}`);
  await spendGuardReady({ ns, deposit: opts.deposit ?? '1000', walletAddress: wallet.address });
  const e = {
    ...baseEnv, SPEND_GUARD: ns, ARWEAVE_JWK: wallet.jwk, TRUSTED_OWNERS: wallet.address,
    ...SPEND_LIMITS_ENV, ...(opts.limits ?? {}),
  } as WorkerEnv;
  return { env: e, ns, wallet, status: () => spendGuardStatus(ns) };
}

type MockRoute = (method: string, url: RegExp, status: number, body: string, times?: number, opts?: { delayMs?: number; hold?: Promise<unknown>; makeBody?: () => BodyInit }) => OutboundRoute;

export const ANCHOR = 'A'.repeat(64);
export function paidLegs(mockRoute: MockRoute, opts: { price?: string; post?: number | 'none'; anchorHold?: Promise<unknown>; priceHold?: Promise<unknown> } = {}) {
  const anchor = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, ANCHOR, 1, opts.anchorHold ? { hold: opts.anchorHold } : {});
  const price = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, opts.price ?? '10', 1, opts.priceHold ? { hold: opts.priceHold } : {});
  const post = opts.post === 'none' ? null : mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, opts.post ?? 200, 'OK');
  return { anchor, price, post };
}

export function statusBody(height: number, confirmations: number): string {
  return JSON.stringify({ block_height: height, number_of_confirmations: confirmations });
}
export function confirmedOnAll(mockRoute: MockRoute, txId: string, height = 5000, confirmations = 10) {
  return STATUS_ORIGINS.map(o => mockRoute('GET', statusUrlRe(o, txId), 200, statusBody(height, confirmations)));
}
export function deadOnAll(mockRoute: MockRoute, txId: string) {
  return STATUS_ORIGINS.map(o => mockRoute('GET', statusUrlRe(o, txId), 404, 'not found'));
}
export function balanceOnAll(mockRoute: MockRoute, address: string, winston: string, per: Partial<Record<string, { status: number; body: string }>> = {}) {
  return STATUS_ORIGINS.map(o => {
    const re = new RegExp('^' + o.replace(/\./g, '\\.') + '/wallet/' + address + '/balance$');
    const override = per[o];
    return override ? mockRoute('GET', re, override.status, override.body) : mockRoute('GET', re, 200, winston);
  });
}

/** A namespace whose stub runs `hook` right AFTER the DO answered `afterPath`
 *  — the way to freeze the guard between `activate` and `permit-send`. */
export function guardWithHook(ns: DurableObjectNamespace, afterPath: string, hook: () => Promise<void>): DurableObjectNamespace {
  return {
    idFromName: (n: string) => ns.idFromName(n),
    get: (id: DurableObjectId) => {
      const real = ns.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const res = await real.fetch(input as string, init);
          if (new URL(url).pathname === afterPath) await hook();
          return res;
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

/** The guard's own view of a permit and the reservation it names. */
export async function guardCall(ns: DurableObjectNamespace, path: string, body: Record<string, unknown> = {}) {
  const res = await ns.get(ns.idFromName('global')).fetch(`http://spend-guard${path}`, { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> & { code?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed };
}

/** The journal record of an operation (never the token). */
export async function opRecord(pkB64: string, opId: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  const res = await stub.fetch('http://internal/op-get', { method: 'POST', body: JSON.stringify({ id: opId }) });
  const { op } = (await res.json()) as { op: { status: string; outcome?: string; code?: string; paidResult?: string; txId?: string } | null };
  expect(op).not.toBeNull();
  return op!;
}
