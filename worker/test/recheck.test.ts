import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { computePublicationFp } from '../src/publication-fp';
import * as ed from '@noble/ed25519';

// Integration: server-authoritative reconciliation of a lost commit. The DO holds
// a `posted {txId, postedAt}` record; on recheck the worker reconciles using that
// SERVER txId (never a client-supplied one). Arweave status is mocked by stubbing
// the isolate's GLOBAL fetch (vitest-pool-workers ≥0.18 dropped `fetchMock`;
// with singleWorker the SELF handler shares this isolate, so the stub applies).
// Mocks are SINGLE-USE and afterEach asserts full consumption — the old
// undici-interceptor semantics (assertNoPendingInterceptors) are preserved.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

const statusRoutes = new Map<string, { status: number; body: string; calls: number }>();

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const m = url.match(/^https:\/\/arweave\.net\/tx\/([^/]+)\/status$/);
    const route = m ? statusRoutes.get(m[1]) : undefined;
    if (route && route.calls === 0) {
      route.calls++;
      return new Response(route.body, { status: route.status });
    }
    throw new Error(`unmocked or exhausted outbound fetch: ${url}`); // net-connect disabled
  });
});
afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  const pending = [...statusRoutes.entries()]
    .filter(([, r]) => r.calls === 0)
    .map(([txId]) => txId);
  statusRoutes.clear(); // clean slate either way
  expect(pending, `unconsumed status mocks for: ${pending.join(', ')}`).toEqual([]);
});

function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const NOTE_ID = '22222222-3333-4444-8555-666666666666';
const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA';

/** Exactly the outer `data` string recheckUpload publishes — the fingerprint
 *  input, so injected records can be seeded as POST-D2 rather than legacy. */
const UPLOAD_DATA = JSON.stringify({ id: NOTE_ID, c: C, iv: IV });
const UPLOAD_VERSION = '2';

/** A fixed identity so we can inject DO state for exactly this pk's shard. */
async function makeIdentity() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function recheckUpload(id: { priv: Uint8Array; pkB64: string; ownerHash: string }, ip: string) {
  const body = JSON.stringify({
    data: UPLOAD_DATA,
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: UPLOAD_VERSION },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: NOTE_ID },
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    recheck: true,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

/**
 * Seed a `posted` record for this pk's shard.
 *
 * It carries the fp of the payload `recheckUpload` sends, i.e. a record written
 * by a worker that already had semantic idempotency (D2). Without it the record
 * would be LEGACY, and every test here would exercise the publication-backfill
 * path instead of the reconciliation it is about — against fake txIds that no
 * gateway can authenticate. The legacy path has its own suite.
 */
async function injectPosted(pkB64: string, txId: string, postedAt: number) {
  const fp = await computePublicationFp(UPLOAD_VERSION, UPLOAD_DATA);
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  await runInDurableObject(stub, async (_i, state) => {
    await state.storage.put(`note:${NOTE_ID}`, { status: 'posted', token: 'srv-token', gen: 0, txId, postedAt, fp });
  });
}

async function readNote(pkB64: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  return runInDurableObject(stub, async (_i, state) =>
    state.storage.get<{ status: string; txId?: string }>(`note:${NOTE_ID}`));
}

function mockStatus(txId: string, status: number, bodyText = 'x') {
  statusRoutes.set(txId, { status, body: bodyText, calls: 0 });
}

// Recompute the server's recovery HMAC (key = SHA-256(RECOVERY_HMAC_SECRET +
// ':recovery'); the test binding is 'test-recovery-secret').
async function signRecovery(noteId: string, txId: string, postedAt: number): Promise<string> {
  const material = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-recovery-secret:recovery')));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${noteId}:${txId}:${postedAt}`));
  return b64(new Uint8Array(sig));
}

async function recoveryUpload(id: { priv: Uint8Array; pkB64: string; ownerHash: string }, recovery: unknown, ip: string) {
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
    recovery,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

describe('recheck reconciliation (server-authoritative posted state)', () => {
  it('commits an ALIVE posted TX without re-posting', async () => {
    const id = await makeIdentity();
    await injectPosted(id.pkB64, 'TX-ALIVE', Date.now() - 60_000);
    mockStatus('TX-ALIVE', 200, JSON.stringify({ block_height: 1, number_of_confirmations: 3 }));

    const r = await recheckUpload(id, `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).toBe('TX-ALIVE'); // server txId, no new post

    const rec = await readNote(id.pkB64);
    expect(rec?.status).toBe('committed');
    expect(rec?.txId).toBe('TX-ALIVE');
  });

  it('defers (503) when the posted TX status is unavailable', async () => {
    const id = await makeIdentity();
    await injectPosted(id.pkB64, 'TX-UNK', Date.now() - 60_000);
    mockStatus('TX-UNK', 500, 'gateway error');

    const r = await recheckUpload(id, `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(503);
  });

  it('defers (503) for a dropped posted TX younger than the 30-min guard', async () => {
    const id = await makeIdentity();
    await injectPosted(id.pkB64, 'TX-YOUNG', Date.now() - 60_000); // 1 min old
    mockStatus('TX-YOUNG', 404, 'not found');

    const r = await recheckUpload(id, `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(503); // too recent to re-post
  });
});

describe('recovery token (triple-failure reconciliation)', () => {
  it('reconciles an alive TX from a VALID signed recovery token (no re-post)', async () => {
    const id = await makeIdentity(); // DO has NO record for NOTE_ID
    const postedAt = Date.now() - 60_000;
    const token = await signRecovery(NOTE_ID, 'TX-REC', postedAt);
    mockStatus('TX-REC', 200, JSON.stringify({ block_height: 1, number_of_confirmations: 3 }));

    const r = await recoveryUpload(id, { txId: 'TX-REC', postedAt, token }, `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).toBe('TX-REC');
  });

  it('FAILS CLOSED (400) on a forged recovery token — no post, reservation released', async () => {
    const id = await makeIdentity();
    // Wrong signature → verifyRecovery fails → 400. It must NOT fall through to
    // a fresh paid post: the token's TX may be alive on-chain (duplicate risk).
    const r = await recoveryUpload(
      id,
      { txId: 'TX-FORGED', postedAt: Date.now() - 60_000, token: 'Zm9yZ2Vk' },
      `rc-${crypto.randomUUID().slice(0, 6)}`,
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/recovery/i);

    // The fresh reservation was released — a later legitimate upload can proceed
    // immediately (no lingering reserved slot → no 409).
    const rec = await readNote(id.pkB64);
    expect(rec?.status).not.toBe('reserved');
  });

  it('FAILS CLOSED (400) on a malformed recovery hint (wrong shape)', async () => {
    const id = await makeIdentity();
    const r = await recoveryUpload(
      id,
      { txId: 'TX-X', postedAt: 'yesterday', token: 42 }, // wrong field types
      `rc-${crypto.randomUUID().slice(0, 6)}`,
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/recovery/i);
  });

  it('rejects (400) a recovery hint sent WITHOUT recheck', async () => {
    const id = await makeIdentity();
    const postedAt = Date.now() - 60_000;
    const token = await signRecovery(NOTE_ID, 'TX-NORECHECK', postedAt);
    // recoveryUpload always sets recheck:true, so build the body manually.
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
      recovery: { txId: 'TX-NORECHECK', postedAt, token },
    });
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
    const r = await SELF.fetch('https://proxy.example.com/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': `rc-${crypto.randomUUID().slice(0, 6)}` },
      body,
    });
    expect(r.status).toBe(400);
  });
});
