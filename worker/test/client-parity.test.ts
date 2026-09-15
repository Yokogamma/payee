import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
// CROSS-HALF IMPORT (deliberate — do not "fix" to a local helper): the signing
// side below is the REAL client wrapper from src/lib/crypto.ts, bundled with
// the ROOT install of @noble/ed25519, while the worker under test (SELF)
// verifies with its OWN install from worker/node_modules. One green run proves
// the two halves' noble versions produce/accept the same signatures — exactly
// the contract a noble major bump can silently break. Pattern precedent:
// scripts/derive-smoke-key.test.mjs (operator helper ↔ client parity).
import {
  deriveSigningKeypair,
  deriveOwnerHash,
  signPayload,
  bufferToBase64,
} from '../../src/lib/crypto';

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

// Fixed BIP-39 vector — deterministic, so a parity break is reproducible.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const NOTE_ID = '77777777-2222-4333-8444-555555555555'; // valid UUIDv4 shape
const C = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 bytes: the GCM tag floor
const IV = 'AAAAAAAAAAAAAAAA'; // valid base64, exactly 12 bytes

let ipCounter = 0;
const nextIp = () => `cp-${crypto.randomUUID().slice(0, 6)}-${ipCounter++}`;

function post(path: string, body: string, pkB64: string, sig: string): Promise<Response> {
  return SELF.fetch(`https://proxy.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': nextIp(),
    },
    body,
  });
}

describe('client ↔ worker signature parity (src/lib/crypto vs worker verifySignature)', () => {
  it('a /check-registration signed by the client wrapper verifies (200 allowed)', async () => {
    // Exact client flow from store.tsx: derive keypair from the seed phrase,
    // sign JSON.stringify({publicKey, timestamp}) via signPayload.
    const { privateKey, publicKey } = await deriveSigningKeypair(MNEMONIC);
    const pkB64 = bufferToBase64(publicKey);
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

    const body = JSON.stringify({ publicKey: pkB64, timestamp: Date.now() });
    const sig = await signPayload(privateKey, body);

    const r = await post('/check-registration', body, pkB64, sig);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ allowed: true });
  });

  it('an /upload signed by the client wrapper passes auth (502 at Arweave stub)', async () => {
    const { privateKey, publicKey } = await deriveSigningKeypair(MNEMONIC);
    const pkB64 = bufferToBase64(publicKey);
    const ownerHash = await deriveOwnerHash(publicKey);
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

    const body = JSON.stringify({
      data: JSON.stringify({ id: NOTE_ID, c: C, iv: IV, t: 1700000000000 }),
      tags: [
        { name: 'App-Name', value: 'EternalNotes' },
        { name: 'App-Version', value: '1' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Owner-Hash', value: ownerHash },
        { name: 'Timestamp', value: '1700000000000' },
        { name: 'Note-Id', value: NOTE_ID },
      ],
      ownerHash,
      timestamp: Date.now(),
    });
    const sig = await signPayload(privateKey, body);

    // 502 = every validation/auth stage passed (signature included) and the
    // handler reached Arweave signing, which fails under the stub JWK ('{}').
    const r = await post('/upload', body, pkB64, sig);
    expect(r.status).toBe(502);
  });

  it('control: the same client signature over a TAMPERED body is rejected (401)', async () => {
    // Guards the guard: if worker-side verification ever started accepting
    // anything, the two green tests above would prove nothing.
    const { privateKey, publicKey } = await deriveSigningKeypair(MNEMONIC);
    const pkB64 = bufferToBase64(publicKey);
    await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

    const body = JSON.stringify({ publicKey: pkB64, timestamp: Date.now() });
    const sig = await signPayload(privateKey, body);
    // Trailing space: JSON.parse still yields the identical object (so the
    // body/header and timestamp gates pass), but the signed BYTES differ.
    const tampered = `${body} `;

    const r = await post('/check-registration', tampered, pkB64, sig);
    expect(r.status).toBe(401);
    expect(await r.text()).toMatch(/Invalid signature/);
  });
});
