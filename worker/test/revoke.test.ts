import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { warmUpInviteManager } from './warmup';

beforeAll(() => warmUpInviteManager());

// Phase 5 / M11: allowed → revoke → denied (source of truth = InviteManager DO,
// stale KV overwritten with short-TTL denied), the admitting invite is marked
// revoked, and admin auth is constant-time (L12).

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const INVITE_MANAGER = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;

const AUTH = { Authorization: 'Bearer test-admin-secret' };

function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function mgr() {
  return INVITE_MANAGER.get(INVITE_MANAGER.idFromName('global'));
}

function mgrFetch(path: string, body: unknown): Promise<Response> {
  return mgr().fetch(`http://internal${path}`, {
    method: 'POST', body: JSON.stringify(body),
  });
}

async function seedInvite(code: string) {
  await mgrFetch('/seed-invite', { codes: [code] });
}

async function registerViaDO(inviteCode: string, publicKey: string) {
  return mgrFetch('/register', { inviteCode, publicKey, clientIP: crypto.randomUUID() });
}

async function checkAllowedDO(publicKey: string): Promise<boolean> {
  const r = await mgrFetch('/check-allowed', { publicKey });
  return ((await r.json()) as { allowed: boolean }).allowed;
}

function inMgrStorage<T>(fn: (storage: DurableObjectStorage) => Promise<T> | T): Promise<T> {
  return runInDurableObject(mgr(), (_i, state) => fn(state.storage));
}

async function adminRevoke(publicKey: unknown, auth: Record<string, string> = AUTH) {
  return SELF.fetch('https://proxy.example.com/admin/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ publicKey }),
  });
}

describe('M11 revoke-flow: allowed → revoke → denied', () => {
  it('removes the key, overwrites stale KV with denied, marks the invite revoked', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pkB64 = b64(await ed.getPublicKeyAsync(priv));
    const code = `INV-${crypto.randomUUID().slice(0, 8)}`;

    await seedInvite(code);
    expect((await registerViaDO(code, pkB64)).status).toBe(200);
    expect(await checkAllowedDO(pkB64)).toBe(true);

    // Stale positive cache that the revoke must immediately close.
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

    const r = await adminRevoke(pkB64);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; wasAllowed: boolean; inviteRevoked: boolean };
    expect(body).toEqual({ ok: true, wasAllowed: true, inviteRevoked: true });

    // DO (source of truth) no longer allows the key.
    expect(await checkAllowedDO(pkB64)).toBe(false);
    // KV now caches 'denied' (short TTL) — the stale 'allowed' is gone.
    expect(JSON.parse((await ALLOWLIST.get(`pk:${pkB64}`))!)).toEqual({ status: 'denied' });

    // The admitting invite carries the audit flags and can never re-admit.
    const invite = await inMgrStorage(storage =>
      storage.get<{ used: boolean; revoked?: boolean }>(`invite:${code}`));
    expect(invite?.revoked).toBe(true);
    expect(invite?.used).toBe(true);
    const reuse = await registerViaDO(code, 'some-other-key');
    expect(reuse.status).toBe(401);

    // The real client path sees the denial: /check-registration → allowed:false.
    const payload = JSON.stringify({ publicKey: pkB64, timestamp: Date.now() });
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(payload)), priv));
    const cr = await SELF.fetch('https://proxy.example.com/check-registration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': pkB64,
        'X-Signature': sig,
        'CF-Connecting-IP': `rv-${crypto.randomUUID().slice(0, 6)}`,
      },
      body: payload,
    });
    expect(cr.status).toBe(200);
    expect(((await cr.json()) as { allowed: boolean }).allowed).toBe(false);
  });

  it('revokes a LEGACY `true` allowlist record via the invite scan fallback', async () => {
    const pk = b64(crypto.getRandomValues(new Uint8Array(32))); // canonical 32-byte key
    const code = `LEGINV-${crypto.randomUUID().slice(0, 8)}`;
    await inMgrStorage(async storage => {
      await storage.put(`invite:${code}`, { used: true, publicKey: pk, usedAt: 1 });
      await storage.put(`pk:${pk}`, true); // legacy pre-revoke shape
    });

    const r = await adminRevoke(pk);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; wasAllowed: boolean; inviteRevoked: boolean };
    expect(body).toEqual({ ok: true, wasAllowed: true, inviteRevoked: true });

    expect(await checkAllowedDO(pk)).toBe(false);
    const invite = await inMgrStorage(storage =>
      storage.get<{ revoked?: boolean }>(`invite:${code}`));
    expect(invite?.revoked).toBe(true);
  });

  it('is idempotent: revoking an unknown (but well-formed) key still succeeds', async () => {
    const r = await adminRevoke(b64(crypto.getRandomValues(new Uint8Array(32))));
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; wasAllowed: boolean };
    expect(body.ok).toBe(true);
    expect(body.wasAllowed).toBe(false);
  });

  it('rejects anything that is not a canonical 32-byte base64 key with 400', async () => {
    expect((await adminRevoke(undefined)).status).toBe(400);
    expect((await adminRevoke(42)).status).toBe(400);
    expect((await adminRevoke('')).status).toBe(400);
    // Malformed base64 — a typo'd key must NOT get a "successful" idempotent
    // response while the real key stays allowed.
    expect((await adminRevoke('!!!not-base64!!!')).status).toBe(400);
    // Valid base64, wrong length (16 bytes ≠ Ed25519).
    expect((await adminRevoke(b64(crypto.getRandomValues(new Uint8Array(16))))).status).toBe(400);
    // Overlong value (hard length bound).
    expect((await adminRevoke('A'.repeat(100))).status).toBe(400);
  });

  it('DO itself rejects a non-canonical key (defense in depth)', async () => {
    const r = await mgrFetch('/revoke', { publicKey: 'not-a-key' });
    expect(r.status).toBe(400);
  });
});

describe('revoke ↔ register race hardening (allowed resurrection)', () => {
  async function selfRegister(priv: Uint8Array, pkB64: string, inviteCode: string) {
    const payload = JSON.stringify({ inviteCode, publicKey: pkB64, timestamp: Date.now() });
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(payload)), priv));
    return SELF.fetch('https://proxy.example.com/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': pkB64,
        'X-Signature': sig,
        'CF-Connecting-IP': `race-${crypto.randomUUID().slice(0, 6)}`,
      },
      body: payload,
    });
  }

  it('an alreadyRegistered /register writes NOTHING to KV — a mid-revoke denied survives', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pkB64 = b64(await ed.getPublicKeyAsync(priv));
    const code = `RACE-${crypto.randomUUID().slice(0, 8)}`;
    await seedInvite(code);

    // Fresh registration (real invite consumed) → allowed cached. Legit.
    expect((await selfRegister(priv, pkB64, code)).status).toBe(200);
    expect(JSON.parse((await ALLOWLIST.get(`pk:${pkB64}`))!)).toEqual({ status: 'allowed' });

    // Revoke step 1 just landed: KV says denied (DO delete may still be in flight).
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'denied' }));

    // The attack: signed /register spam with a garbage invite. The DO answers
    // alreadyRegistered WITHOUT validating the invite — that response must not
    // touch the cache, or the deny would be resurrected for the positive TTL.
    const r = await selfRegister(priv, pkB64, 'garbage-invite-code');
    expect(r.status).toBe(200); // idempotent OK is fine...
    expect(JSON.parse((await ALLOWLIST.get(`pk:${pkB64}`))!)).toEqual({ status: 'denied' }); // ...but deny stays
  });
});

describe('serialized cache ownership (round 9: deny wins in EVERY interleaving)', () => {
  it('refresh-allowed after a revoke returns false and leaves the denied entry intact', async () => {
    const pk = b64(crypto.getRandomValues(new Uint8Array(32)));
    const code = `SER-${crypto.randomUUID().slice(0, 8)}`;
    await seedInvite(code);
    expect((await registerViaDO(code, pk)).status).toBe(200);

    expect((await adminRevoke(pk)).status).toBe(200);

    const r = await mgrFetch('/refresh-allowed', { publicKey: pk });
    const body = await r.json() as { allowed: boolean };
    expect(body.allowed).toBe(false); // FINAL verdict honors the revoke
    expect(JSON.parse((await ALLOWLIST.get(`pk:${pk}`))!)).toEqual({ status: 'denied' });
  });

  it('a FRESH registration caches allowed from INSIDE the DO critical section', async () => {
    const pk = b64(crypto.getRandomValues(new Uint8Array(32)));
    const code = `SER2-${crypto.randomUUID().slice(0, 8)}`;
    await seedInvite(code);
    expect((await registerViaDO(code, pk)).status).toBe(200);
    // The worker wrote nothing — this entry came from the DO's serialized write.
    expect(JSON.parse((await ALLOWLIST.get(`pk:${pk}`))!)).toEqual({ status: 'allowed' });
  });

  it('CONCURRENT refresh-allowed × revoke always ends with denied cached', async () => {
    // Both operations run under the DO's blockConcurrencyWhile, so whatever
    // the interleaving, the final KV state must be `denied`: refresh-after-
    // revoke sees the key deleted (writes nothing), revoke-after-refresh
    // overwrites `allowed`. Repeat to exercise both orders.
    for (let round = 0; round < 5; round++) {
      const pk = b64(crypto.getRandomValues(new Uint8Array(32)));
      const code = `RACE9-${crypto.randomUUID().slice(0, 6)}`;
      await seedInvite(code);
      expect((await registerViaDO(code, pk)).status).toBe(200);

      const [refreshResp, revokeResp] = await Promise.all([
        mgrFetch('/refresh-allowed', { publicKey: pk }),
        adminRevoke(pk),
      ]);
      expect(refreshResp.status).toBe(200);
      expect(revokeResp.status).toBe(200);

      expect(await checkAllowedDO(pk)).toBe(false);
      expect(JSON.parse((await ALLOWLIST.get(`pk:${pk}`))!)).toEqual({ status: 'denied' });
    }
  }, 20_000);
});

describe('L12 constant-time admin auth', () => {
  it('rejects wrong secrets of ANY length with 401 (no crash on length mismatch)', async () => {
    for (const bad of ['Bearer x', `Bearer ${'a'.repeat(500)}`, 'Basic abc']) {
      const r = await adminRevoke('whatever', { Authorization: bad });
      expect(r.status).toBe(401);
    }
    // No Authorization header at all.
    const r = await SELF.fetch('https://proxy.example.com/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: 'x' }),
    });
    expect(r.status).toBe(401);
  });

  it('accepts the correct secret on /admin/seed-invite via the same check', async () => {
    const r = await SELF.fetch('https://proxy.example.com/admin/seed-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ codes: [`C-${crypto.randomUUID().slice(0, 8)}`] }),
    });
    expect(r.status).toBe(200);
  });
});
