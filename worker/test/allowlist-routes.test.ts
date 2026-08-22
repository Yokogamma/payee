import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { warmUpInviteManager } from './warmup';

beforeAll(() => warmUpInviteManager());

// D3 route-level: the /upload handler honours the typed allowlist model end to
// end — denied → 403, missing → 403, and a legacy 'true' KV value is re-derived
// from the DO and rewritten in the new typed format.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const INVITE_MANAGER = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;

const NOTE_ID = '11111111-2222-4333-8444-555555555555';
const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Build a validly-signed v2 upload for a fresh key. Returns pk + a sender. */
async function makeUpload(ip: string) {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  const tags = [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: '2' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: ownerHash },
    { name: 'Note-Id', value: NOTE_ID },
  ];
  const body = JSON.stringify({
    data: JSON.stringify({ id: NOTE_ID, c: C, iv: IV }),
    tags,
    ownerHash,
    timestamp: Date.now(),
  });
  const digest = await sha256(new TextEncoder().encode(body));
  const sig = b64(await ed.signAsync(digest, priv));
  const send = () =>
    SELF.fetch('https://proxy.example.com/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': pkB64,
        'X-Signature': sig,
        'CF-Connecting-IP': ip,
      },
      body,
    });
  return { pkB64, send };
}

async function seedDO(pkB64: string) {
  const stub = INVITE_MANAGER.get(INVITE_MANAGER.idFromName('global'));
  await runInDurableObject(stub, async (_inst, state) => {
    await state.storage.put(`pk:${pkB64}`, true);
  });
}

describe('/upload allowlist (D3 typed model)', () => {
  it('403s a denied key without consulting the DO', async () => {
    const { pkB64, send } = await makeUpload('al-deny-1');
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'denied' }));
    const r = await send();
    expect(r.status).toBe(403);
  });

  it('403s a key that is neither in KV nor the DO', async () => {
    const { send } = await makeUpload('al-miss-1');
    const r = await send();
    expect(r.status).toBe(403);
  });

  it('accepts a legacy "true" key via the DO and rewrites KV to typed allowed', async () => {
    const { pkB64, send } = await makeUpload('al-legacy-1');
    await ALLOWLIST.put(`pk:${pkB64}`, 'true'); // legacy value → treated as miss
    await seedDO(pkB64); // DO is the source of truth and says allowed

    // Passes the allowlist (miss → DO allowed → rewrite); the KV is rewritten
    // before the (stubbed) Arweave step fails with 502.
    const r = await send();
    expect(r.status).toBe(502);

    const rewritten = await ALLOWLIST.get(`pk:${pkB64}`);
    expect(rewritten).not.toBeNull();
    expect(JSON.parse(rewritten as string)).toEqual({ status: 'allowed' });
  });
});
