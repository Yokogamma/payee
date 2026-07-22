import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
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

// Outbound Arweave HTTP is mocked by stubbing the isolate's GLOBAL fetch
// (vitest-pool-workers ≥0.18 dropped `fetchMock`). Routes are SINGLE-USE by
// default (undici-interceptor semantics preserved): an exhausted or unmocked
// request throws, and afterEach asserts every registered route was fully
// consumed — an expected-but-never-sent request fails the test, and a
// regression that fires the same paid request twice cannot pass.
interface OutboundRoute {
  method: string;
  url: RegExp;
  status: number;
  body: string;
  times: number;
  calls: number;
}
const outboundRoutes: OutboundRoute[] = [];

function mockRoute(method: string, url: RegExp, status: number, body: string, times = 1): OutboundRoute {
  const route: OutboundRoute = { method, url, status, body, times, calls: 0 };
  outboundRoutes.push(route);
  return route;
}

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
    const route = outboundRoutes.find(r => r.method === method && r.url.test(url) && r.calls < r.times);
    if (!route) throw new Error(`unmocked or exhausted outbound fetch: ${method} ${url}`);
    route.calls++;
    return new Response(route.body, { status: route.status });
  });
});
afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  // assertNoPendingInterceptors() equivalent: every route fully consumed.
  const pending = outboundRoutes
    .filter(r => r.calls !== r.times)
    .map(r => `${r.method} ${r.url} (${r.calls}/${r.times})`);
  outboundRoutes.length = 0; // clean slate for the next test either way
  expect(pending, `unconsumed outbound mocks: ${pending.join('; ')}`).toEqual([]);
});

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
  // must refuse to post at all. The global-fetch stub has NO routes registered
  // here (any outbound call throws → 502) — a 503 proves the request never
  // reached the Arweave post path.
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

describe('revoke DO-failure injection (single-writer semantics, round 10)', () => {
  const revokeRequest = (publicKey: string) => new Request('https://proxy.example.com/admin/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
    body: JSON.stringify({ publicKey }),
  });

  it('unreachable DO → 503 with NOTHING written anywhere (retry-safe)', async () => {
    // The worker performs no KV writes of its own (a duplicate write to the
    // same key could trip KV's ~1-write/sec/key limit); a DO failure therefore
    // leaves both KV and DO storage untouched — pure retry.
    const pk = b64(crypto.getRandomValues(new Uint8Array(32)));
    const failingMgr = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO down'); } }),
    } as unknown as DurableObjectNamespace;

    const r = await worker.fetch(revokeRequest(pk), { ...baseEnv, INVITE_MANAGER: failingMgr });
    expect(r.status).toBe(503);
    expect(await ALLOWLIST.get(`pk:${pk}`)).toBeNull(); // no stray writes
  });
});

describe('IpRateLimiter DO failure injection (baseline anti-abuse must fail CLOSED)', () => {
  const request = (path: string) => new Request(`https://proxy.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `ipf-${crypto.randomUUID().slice(0, 6)}` },
    body: '{}',
  });

  it('503s protected routes when the limiter DO is UNREACHABLE (throws)', async () => {
    const failingLimiter = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO unreachable'); } }),
    } as unknown as DurableObjectNamespace;

    for (const path of ['/upload', '/check-registration', '/register']) {
      const r = await worker.fetch(request(path), { ...baseEnv, IP_RATE_LIMITER: failingLimiter });
      expect(r.status).toBe(503);
      expect(await r.text()).toMatch(/rate limiter/i);
    }
  });

  it('503s when the limiter DO responds non-ok (internal error, not 429)', async () => {
    const erroringLimiter = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    } as unknown as DurableObjectNamespace;

    const r = await worker.fetch(request('/upload'), { ...baseEnv, IP_RATE_LIMITER: erroringLimiter });
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/rate limiter/i);
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
    // arweave-js builds explicit host:443 URLs → the port is optional here.
    // All routes are single-use; postTx.calls is asserted below — the whole
    // point of this test is that the recovery performs EXACTLY ONE paid POST.
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx\/TX-DEAD\/status$/, 404, 'not found');
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, 'A'.repeat(43));
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');
    const postTx = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');

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

    // The invariant this whole file exists for: exactly ONE paid Arweave POST.
    expect(postTx.calls).toBe(1);
  });
});
