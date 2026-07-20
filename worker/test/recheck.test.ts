import { env, SELF, fetchMock, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';

// Integration: server-authoritative reconciliation of a lost commit. The DO holds
// a `posted {txId, postedAt}` record; on recheck the worker reconciles using that
// SERVER txId (never a client-supplied one). Arweave status is mocked.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

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

const NOTE_ID = '22222222-3333-4444-8555-666666666666';
const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA';

/** A fixed identity so we can inject DO state for exactly this pk's shard. */
async function makeIdentity() {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function recheckUpload(id: { priv: Uint8Array; pkB64: string; ownerHash: string }, ip: string) {
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
  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

async function injectPosted(pkB64: string, txId: string, postedAt: number) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  await runInDurableObject(stub, async (_i, state) => {
    await state.storage.put(`note:${NOTE_ID}`, { status: 'posted', token: 'srv-token', gen: 0, txId, postedAt });
  });
}

async function readNote(pkB64: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  return runInDurableObject(stub, async (_i, state) =>
    state.storage.get<{ status: string; txId?: string }>(`note:${NOTE_ID}`));
}

function mockStatus(txId: string, status: number, bodyText = 'x') {
  fetchMock.get('https://arweave.net').intercept({ path: `/tx/${txId}/status`, method: 'GET' }).reply(status, bodyText);
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
