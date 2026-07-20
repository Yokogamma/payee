import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';

// Residual reviewer gaps:
// 1) invalid env config must 503 through the real /upload route (fail closed);
// 2) end-to-end commit-failure recovery: a `posted` anchor whose TX dropped and
//    aged past the 30-min guard is REDROPPED and actually re-posted (real
//    signable JWK + mocked Arweave HTTP), ending committed under a NEW txId.
//
// SELF receives its own env copy, so config/JWK overrides don't propagate to it.
// Instead we invoke the worker's fetch handler DIRECTLY with {...env, override} —
// same code path (router → handler), same live DO/KV bindings.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const NOTE_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA'; // 12 bytes

async function makeIdentity() {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function recheckRequest(id: { priv: Uint8Array; pkB64: string; ownerHash: string }, ip: string): Promise<Request> {
  const body = JSON.stringify({
    data: JSON.stringify({ id: NOTE_ID, c: C, iv: IV }),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '2' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: NOTE_ID },
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    recheck: true,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

describe('invalid env config fails closed on the real route (L6)', () => {
  it('503s /upload when MAX_BODY_BYTES is garbage (limit never disabled)', async () => {
    const r = await worker.fetch(
      new Request('https://proxy.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `cfg-${crypto.randomUUID().slice(0, 6)}` },
        body: '{}',
      }),
      { ...baseEnv, MAX_BODY_BYTES: 'not-a-number' },
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/misconfigured/i);
  });

  it('503s /upload when RATE_LIMIT_PER_HOUR is empty', async () => {
    const r = await worker.fetch(
      new Request('https://proxy.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `cfg-${crypto.randomUUID().slice(0, 6)}` },
        body: '{}',
      }),
      { ...baseEnv, RATE_LIMIT_PER_HOUR: '' },
    );
    expect(r.status).toBe(503);
  });
});

describe('mandatory RECOVERY_HMAC_SECRET (upload gate)', () => {
  // Without the secret a triple-failure has NO provable recovery hint: after the
  // reservation TTL the recheck degrades into a duplicate paid POST. So /upload
  // must refuse to post at all. fetchMock has net-connect disabled and NO
  // interceptors registered here — had the request reached the Arweave post
  // path it would have errored as 502, so a 503 proves no outbound call.
  it('503s a valid signed upload when the secret is missing', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(
      await recheckRequest(id, `sec-${crypto.randomUUID().slice(0, 6)}`),
      { ...baseEnv, RECOVERY_HMAC_SECRET: '' },
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/misconfigured/i);
  });

  it('503s when the secret is too short to be a real secret', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(
      await recheckRequest(id, `sec-${crypto.randomUUID().slice(0, 6)}`),
      { ...baseEnv, RECOVERY_HMAC_SECRET: 'short' },
    );
    expect(r.status).toBe(503);
  });
});

describe('e2e: lost commit → posted anchor → TTL → redrop → successful re-post', () => {
  it('re-posts a dropped, aged posted TX and commits under a NEW txId', async () => {
    const id = await makeIdentity();

    // The DO holds a `posted` anchor (commit was lost) from >30 min ago.
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${NOTE_ID}`, {
        status: 'posted', token: 'srv-token', gen: 0,
        txId: 'TX-DEAD', postedAt: Date.now() - 31 * 60_000,
      });
    });

    // Real signable wallet so the re-post path can run end-to-end.
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));

    // Arweave HTTP surface for the re-post: dead status, then anchor/price/post.
    // (arweave-js requires a ≥43-char base64url tx anchor.)
    const gw = fetchMock.get('https://arweave.net');
    gw.intercept({ path: `/tx/TX-DEAD/status`, method: 'GET' }).reply(404, 'not found');
    gw.intercept({ path: '/tx_anchor', method: 'GET' }).reply(200, 'A'.repeat(43));
    gw.intercept({ path: /^\/price\/\d+$/, method: 'GET' }).reply(200, '0');
    gw.intercept({ path: '/tx', method: 'POST' }).reply(200, 'OK');

    const r = await worker.fetch(
      await recheckRequest(id, `e2e-${crypto.randomUUID().slice(0, 6)}`),
      { ...baseEnv, ARWEAVE_JWK: jwk },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).toBeTruthy();
    expect(body.txId).not.toBe('TX-DEAD'); // a NEW transaction was posted

    // Server-side record reflects the recovery: committed under the new txId.
    const rec = await runInDurableObject(stub, async (_i, state) =>
      state.storage.get<{ status: string; txId?: string }>(`note:${NOTE_ID}`));
    expect(rec?.status).toBe('committed');
    expect(rec?.txId).toBe(body.txId);
  });
});
