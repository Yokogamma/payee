import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';

// Direct-dispatch suites (env-override) for the v3 upload kill switch and the
// v3 committed-idempotency e2e. Same pattern as e2e-repost.test.ts: SELF gets
// its own env copy, so gate/JWK overrides must go through worker.fetch directly.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

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
  const pending = outboundRoutes
    .filter(r => r.calls !== r.times)
    .map(r => `${r.method} ${r.url} (${r.calls}/${r.times})`);
  outboundRoutes.length = 0;
  expect(pending, `unconsumed outbound mocks: ${pending.join('; ')}`).toEqual([]);
});

function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA'; // 12 bytes

function uuidV8(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function makeIdentity() {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function v3Request(
  id: { priv: Uint8Array; pkB64: string; ownerHash: string },
  noteId: string,
  ip: string,
  version: '1' | '2' | '3' = '3',
): Promise<Request> {
  const tags = [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: version },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: id.ownerHash },
    ...(version === '1' ? [{ name: 'Timestamp', value: '1700000000000' }] : []),
    { name: 'Note-Id', value: noteId },
  ];
  const dataObj = version === '1'
    ? { id: noteId, c: C, iv: IV, t: 1700000000000 }
    : { id: noteId, c: C, iv: IV };
  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags,
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

const nextIp = () => `v3g-${crypto.randomUUID().slice(0, 8)}`;

describe('/health capability surface', () => {
  it('reports versions and the live gate state', async () => {
    const rOn = await worker.fetch(new Request('https://proxy.example.com/health'), baseEnv);
    const bOn = await rOn.json() as { ok: boolean; versions: string[]; v3Uploads: boolean };
    expect(bOn.ok).toBe(true);
    expect(bOn.versions).toEqual(['1', '2', '3']);
    expect(bOn.v3Uploads).toBe(true); // wrangler.toml vars: V3_UPLOADS_ENABLED="true"

    const rOff = await worker.fetch(
      new Request('https://proxy.example.com/health'),
      { ...baseEnv, V3_UPLOADS_ENABLED: 'false' },
    );
    const bOff = await rOff.json() as { v3Uploads: boolean };
    expect(bOff.v3Uploads).toBe(false);
  });
});

describe('v3 upload kill switch (V3_UPLOADS_ENABLED)', () => {
  // No outbound routes are registered in these tests: any Arweave attempt would
  // throw in the post path and surface as 502 — a 503 with the machine code
  // proves the request never reached the paid path.
  const gateOff = { ...baseEnv, V3_UPLOADS_ENABLED: 'false' };

  it('503s a valid signed v3 upload with the machine-readable code, before the per-owner DO', async () => {
    const id = await makeIdentity();
    const noteId = uuidV8();

    // Counting per-owner RATE_LIMITER stub: the gate must fire BEFORE any call.
    let ownerDoCalls = 0;
    const countingLimiter = {
      idFromName: (name: string) => RATE_LIMITER.idFromName(name),
      get: () => ({ fetch: async () => { ownerDoCalls++; throw new Error('must not be called'); } }),
    } as unknown as DurableObjectNamespace;

    const r = await worker.fetch(
      await v3Request(id, noteId, nextIp()),
      { ...gateOff, RATE_LIMITER: countingLimiter },
    );
    expect(r.status).toBe(503);
    expect(r.headers.get('Content-Type')).toBe('application/json');
    const body = await r.json() as { code: string };
    expect(body.code).toBe('v3_uploads_disabled');
    expect(ownerDoCalls).toBe(0); // one IP-limiter call happened; zero per-owner calls
  });

  it('fails CLOSED when the var is missing or garbage', async () => {
    const id = await makeIdentity();
    const missingEnv = { ...baseEnv } as Record<string, unknown>;
    delete missingEnv.V3_UPLOADS_ENABLED;

    const rMissing = await worker.fetch(
      await v3Request(id, uuidV8(), nextIp()), missingEnv as WorkerEnv,
    );
    expect(rMissing.status).toBe(503);
    expect(((await rMissing.json()) as { code: string }).code).toBe('v3_uploads_disabled');

    const rGarbage = await worker.fetch(
      await v3Request(id, uuidV8(), nextIp()),
      { ...baseEnv, V3_UPLOADS_ENABLED: 'yes' },
    );
    expect(rGarbage.status).toBe(503);
  });

  it('pauses even committed/reserved reconciliation and recovery — full v3 pause', async () => {
    const id = await makeIdentity();
    const noteId = uuidV8();

    // Pre-existing committed record in the DO: the gate must still 503 and the
    // record must stay untouched (no adoption/commit while disabled).
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    const committedRecord = {
      status: 'committed', txId: 'TX-COMMITTED', committedAt: Date.now() - 60 * 60_000, gen: 0,
    };
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteId}`, committedRecord);
    });

    const r = await worker.fetch(await v3Request(id, noteId, nextIp()), gateOff);
    expect(r.status).toBe(503);

    const rec = await runInDurableObject(stub, async (_i, state) =>
      state.storage.get<typeof committedRecord>(`note:${noteId}`));
    expect(rec).toEqual(committedRecord);
  });

  it('leaves v1 uploads untouched while the gate is off (502 at Arweave stub)', async () => {
    const id = await makeIdentity();
    const v4Id = crypto.randomUUID();
    const r = await worker.fetch(await v3Request(id, v4Id, nextIp(), '1'), gateOff);
    expect(r.status).toBe(502); // passed validation + gate, failed at stub JWK
  });
});

describe('v3 e2e idempotency (committed): exactly one paid POST', () => {
  it('repeat upload of the same noteId returns the same txId without a second POST', async () => {
    const id = await makeIdentity();
    const noteId = uuidV8();

    // Real signable wallet so the post path runs end-to-end.
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
    const envWithJwk = { ...baseEnv, ARWEAVE_JWK: jwk };

    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, 'A'.repeat(43));
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');
    const postTx = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');

    const r1 = await worker.fetch(await v3Request(id, noteId, nextIp()), envWithJwk);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { txId: string; status: string; committed: boolean };
    expect(b1.status).toBe('accepted');
    expect(b1.committed).toBe(true);
    expect(b1.txId).toBeTruthy();

    // Second upload, same noteId: the public contract is the ORIGINAL response
    // shape (accepted/committed:true, same txId) — 'exists' is DO-internal and
    // never surfaces. No POST route is left, so a re-post would throw → 502.
    const r2 = await worker.fetch(await v3Request(id, noteId, nextIp()), envWithJwk);
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as { txId: string; status: string; committed: boolean };
    expect(b2.status).toBe('accepted');
    expect(b2.committed).toBe(true);
    expect(b2.txId).toBe(b1.txId);

    expect(postTx.calls).toBe(1); // the financial invariant
  });
});
