import { env, SELF, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';

// Integration: reconciliation of a lost commit (committed:false) WITHOUT a
// duplicate post. On a recheck carrying a known txId, if that TX is alive the
// worker re-records the commit instead of re-posting to Arweave.
// Outbound arweave.net status calls are mocked via fetchMock.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

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

async function recheckUpload(knownTxId: string, ip: string) {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

  const body = JSON.stringify({
    data: JSON.stringify({ id: NOTE_ID, c: C, iv: IV }),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '2' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: ownerHash },
      { name: 'Note-Id', value: NOTE_ID },
    ],
    ownerHash,
    timestamp: Date.now(),
    recheck: true,
    knownTxId,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

describe('recheck reconciliation (no duplicate post)', () => {
  it('re-records an alive TX on recheck instead of re-posting', async () => {
    fetchMock.get('https://arweave.net')
      .intercept({ path: '/tx/TX-ALIVE/status', method: 'GET' })
      .reply(200, JSON.stringify({ block_height: 1, number_of_confirmations: 3 }));

    const r = await recheckUpload('TX-ALIVE', `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).toBe('TX-ALIVE'); // the SAME tx — no new post
  });

  it('defers (503) when the known TX status is unavailable', async () => {
    fetchMock.get('https://arweave.net')
      .intercept({ path: '/tx/TX-UNK/status', method: 'GET' })
      .reply(500, 'gateway error');

    const r = await recheckUpload('TX-UNK', `rc-${crypto.randomUUID().slice(0, 6)}`);
    expect(r.status).toBe(503); // retryable — client keeps needsRecheck
  });
});
