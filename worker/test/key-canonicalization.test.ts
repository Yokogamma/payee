import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { warmUpInviteManager } from './warmup';

// Round-20 HIGH: every route that KEYS state by the public-key string must
// accept only the canonical base64 spelling. The unpadded 43-char form decodes
// to the same 32 bytes and passes signature verification, but it addresses a
// DIFFERENT `pk:` entry than the canonical one — a key registered that way
// could never be reached by /admin/revoke (canonical-only).

beforeAll(() => warmUpInviteManager());

const INVITE_MANAGER = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;

function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Canonical base64 of a 32-byte key ends in '='; strip it → same bytes, different string. */
async function makeKeys() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const canonical = b64(pub);
  const nonCanonical = canonical.replace(/=+$/, '');
  return { priv, pub, canonical, nonCanonical };
}

async function signedFetch(path: string, pkB64: string, priv: Uint8Array, payload: object) {
  const body = JSON.stringify(payload);
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
  return SELF.fetch(`https://proxy.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': `canon-${crypto.randomUUID().slice(0, 6)}`,
    },
    body,
  });
}

describe('canonical public-key enforcement', () => {
  it('sanity: the non-canonical form decodes to the SAME key', async () => {
    const { canonical, nonCanonical } = await makeKeys();
    expect(nonCanonical).not.toBe(canonical);
    expect(atob(nonCanonical)).toBe(atob(canonical)); // identical 32 bytes
  });

  it('/register rejects a non-canonical key (400) — no unrevocable entry created', async () => {
    const { priv, nonCanonical } = await makeKeys();
    const r = await signedFetch('/register', nonCanonical, priv, {
      inviteCode: 'whatever', publicKey: nonCanonical, timestamp: Date.now(),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/canonical/i);

    // Nothing was written under either spelling.
    const stub = INVITE_MANAGER.get(INVITE_MANAGER.idFromName('global'));
    const stored = await runInDurableObject(stub, (_i, state) => state.storage.get(`pk:${nonCanonical}`));
    expect(stored).toBeUndefined();
  });

  it('/check-registration rejects a non-canonical key (400)', async () => {
    const { priv, nonCanonical } = await makeKeys();
    const r = await signedFetch('/check-registration', nonCanonical, priv, {
      publicKey: nonCanonical, timestamp: Date.now(),
    });
    expect(r.status).toBe(400);
  });

  it('/upload rejects a non-canonical key (400) before any allowlist work', async () => {
    const { priv, pub, nonCanonical } = await makeKeys();
    const ownerHash = b64(await sha256(pub));
    const noteId = '99999999-1111-4222-8333-444444444444';
    const r = await signedFetch('/upload', nonCanonical, priv, {
      data: JSON.stringify({ id: noteId, c: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA' }),
      tags: [
        { name: 'App-Name', value: 'EternalNotes' },
        { name: 'App-Version', value: '2' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Owner-Hash', value: ownerHash },
        { name: 'Note-Id', value: noteId },
      ],
      ownerHash,
      timestamp: Date.now(),
    });
    expect(r.status).toBe(400);
  });

  it('/admin/revoke reaches a LEGACY non-canonical entry through the PUBLIC API', async () => {
    // Simulate a key admitted by an older worker build (before the gate).
    const { nonCanonical } = await makeKeys();
    const stub = INVITE_MANAGER.get(INVITE_MANAGER.idFromName('global'));
    await runInDurableObject(stub, (_i, state) => state.storage.put(`pk:${nonCanonical}`, true));

    const r = await SELF.fetch('https://proxy.example.com/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
      body: JSON.stringify({ publicKey: nonCanonical }),
    });
    // No direct DO access needed: the worker forwards, the DO honours the exact
    // legacy match (round-21 P2).
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, wasAllowed: true });

    const stored = await runInDurableObject(stub, (_i, state) => state.storage.get(`pk:${nonCanonical}`));
    expect(stored).toBeUndefined(); // legacy entry actually removed
  });

  it('/admin/revoke still 400s a non-canonical key that was NEVER stored (typo guard)', async () => {
    const { nonCanonical } = await makeKeys();
    const r = await SELF.fetch('https://proxy.example.com/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
      body: JSON.stringify({ publicKey: nonCanonical }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/canonical/i);
  });
});

describe('body-size guards on the auth routes', () => {
  const oversized = 'x'.repeat(5000); // > AUTH_BODY_MAX_BYTES (4096)

  it('413s an oversized body sent WITHOUT Content-Length (streamed cap)', async () => {
    // A chunked/streamed body has no Content-Length to pre-check: the reader
    // must stop and cancel mid-stream instead of buffering everything.
    const big = JSON.stringify({ pad: 'y'.repeat(200_000) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 4096) {
          controller.enqueue(bytes.subarray(i, i + 4096));
        }
        controller.close();
      },
    });
    const r = await SELF.fetch('https://proxy.example.com/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `stream-${crypto.randomUUID().slice(0, 6)}` },
      body: stream,
      // @ts-expect-error — required by undici/workerd for a streaming body
      duplex: 'half',
    });
    expect(r.status).toBe(413);
  });

  it('413s an oversized /register body before signature work', async () => {
    const r = await SELF.fetch('https://proxy.example.com/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `big-${crypto.randomUUID().slice(0, 6)}` },
      body: JSON.stringify({ pad: oversized }),
    });
    expect(r.status).toBe(413);
  });

  it('413s an oversized /check-registration body', async () => {
    const r = await SELF.fetch('https://proxy.example.com/check-registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `big-${crypto.randomUUID().slice(0, 6)}` },
      body: JSON.stringify({ pad: oversized }),
    });
    expect(r.status).toBe(413);
  });

  it('rejects an over-long invite code', async () => {
    const { priv, canonical } = await makeKeys();
    const r = await signedFetch('/register', canonical, priv, {
      inviteCode: 'c'.repeat(200), publicKey: canonical, timestamp: Date.now(),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/inviteCode/i);
  });
});
