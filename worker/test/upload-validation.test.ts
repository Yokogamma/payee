import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';

// Worker contract tests for version-specific upload validation (v1 vs v2).
// A valid Ed25519 signature + ownerHash + allowlist entry are required to reach
// the tag/data validation, so we forge a real signed request per case.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

interface Tag { name: string; value: string }

/** Sign and send an /upload with the given tags + data object, as an allowlisted key. */
async function upload(tags: Tag[], dataObj: unknown, ip: string): Promise<Response> {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));

  // Owner-Hash tag must match the derived value; patch it into the provided tags.
  // Guard null entries so callers can intentionally inject a malformed tag.
  const finalTags = tags.map(t => (t && t.name === 'Owner-Hash' ? { ...t, value: ownerHash } : t));

  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags: finalTags,
    ownerHash,
    timestamp: Date.now(),
  });
  const digest = await sha256(new TextEncoder().encode(body));
  const sig = b64(await ed.signAsync(digest, priv));

  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': ip,
    },
    body,
  });
}

const NOTE_ID = '11111111-2222-4333-8444-555555555555'; // valid UUID shape
const C = 'AAAA';                 // valid base64 (3 bytes)
const IV = 'AAAAAAAAAAAAAAAA';    // valid base64, exactly 12 bytes

function v1Tags(): Tag[] {
  return [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: '1' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: 'PLACEHOLDER' },
    { name: 'Timestamp', value: '1700000000000' },
    { name: 'Note-Id', value: NOTE_ID },
  ];
}
function v2Tags(): Tag[] {
  return [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: '2' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: 'PLACEHOLDER' },
    { name: 'Note-Id', value: NOTE_ID },
  ];
}

let ipCounter = 0;
const nextIp = () => `uv-${crypto.randomUUID().slice(0, 6)}-${ipCounter++}`;

/** A syntactically valid (canonical, 32-byte) key for unsigned probes: the
 *  canonical-spelling gate runs before body parsing, so a dummy like 'x' would
 *  now be rejected as a malformed key instead of reaching the shape checks. */
const DUMMY_PK = b64(crypto.getRandomValues(new Uint8Array(32)));

/** Send a raw (unsigned) body — the top-level shape/timestamp checks run BEFORE
 * signature verification, so dummy auth headers are enough to reach them. */
function rawUpload(body: string, ip: string): Promise<Response> {
  return SELF.fetch('https://proxy.example.com/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': DUMMY_PK,
      'X-Signature': 'y',
      'CF-Connecting-IP': ip,
    },
    body,
  });
}

describe('upload validation: version contract (v1/v2)', () => {
  // A fully-valid upload passes all validation/auth and reaches the Arweave
  // signing step, which fails under the stub JWK ('{}'). The handler catches it,
  // releases the reservation, and returns 502 — proving validation + auth passed.
  it('accepts a well-formed v1 upload past validation (502 at Arweave stage)', async () => {
    const r = await upload(v1Tags(), { id: NOTE_ID, c: C, iv: IV, t: 1700000000000 }, nextIp());
    expect(r.status).toBe(502);
  });

  it('accepts a well-formed v2 upload past validation (502 at Arweave stage)', async () => {
    const r = await upload(v2Tags(), { id: NOTE_ID, c: C, iv: IV }, nextIp());
    expect(r.status).toBe(502);
  });

  it('rejects a v2 upload that carries a Timestamp tag', async () => {
    const tags = [...v2Tags(), { name: 'Timestamp', value: '1700000000000' }]; // 6 tags
    const r = await upload(tags, { id: NOTE_ID, c: C, iv: IV }, nextIp());
    expect(r.status).toBe(400);
  });

  it('rejects a v2 upload whose data still includes t (strict key set)', async () => {
    const r = await upload(v2Tags(), { id: NOTE_ID, c: C, iv: IV, t: 1700000000000 }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid data fields/);
  });

  it('rejects a v1 upload missing the Timestamp tag', async () => {
    const tags = v1Tags().filter(t => t.name !== 'Timestamp'); // 5 tags
    const r = await upload(tags, { id: NOTE_ID, c: C, iv: IV, t: 1700000000000 }, nextIp());
    expect(r.status).toBe(400);
  });

  it('rejects an unsupported App-Version', async () => {
    const tags = v2Tags().map(t => (t.name === 'App-Version' ? { ...t, value: '3' } : t));
    const r = await upload(tags, { id: NOTE_ID, c: C, iv: IV }, nextIp());
    expect(r.status).toBe(400);
  });

  // ── strict wire schema (extra fields / empty / null / mismatch) ──
  it('rejects an extra data field (v2 with a smuggled property)', async () => {
    const r = await upload(v2Tags(), { id: NOTE_ID, c: C, iv: IV, timestamp: 1 } as unknown, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid data fields/);
  });

  it('rejects empty c/iv', async () => {
    const r = await upload(v2Tags(), { id: NOTE_ID, c: '', iv: '' }, nextIp());
    expect(r.status).toBe(400);
  });

  it('rejects a non-12-byte IV', async () => {
    const r = await upload(v2Tags(), { id: NOTE_ID, c: C, iv: 'AAAA' }, nextIp()); // 3 bytes
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/iv must be 12 bytes/);
  });

  it('rejects null data', async () => {
    const r = await upload(v2Tags(), null, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/must be a JSON object/);
  });

  it('rejects Note-Id tag not matching data.id', async () => {
    const r = await upload(
      v2Tags(),
      { id: '99999999-2222-4333-8444-555555555555', c: C, iv: IV },
      nextIp(),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Note-Id mismatch/);
  });

  // ── top-level request hardening (checked before signature) ──
  it('rejects a null JSON body', async () => {
    const r = await rawUpload('null', nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/must be a JSON object/);
  });

  it('rejects a non-number timestamp (anti-replay NaN bypass)', async () => {
    const body = JSON.stringify({ data: '{}', tags: [], ownerHash: 'oh', timestamp: 'soon' });
    const r = await rawUpload(body, nextIp());
    expect(r.status).toBe(401);
  });

  it('rejects a null entry inside the tags array', async () => {
    const tags = [null as unknown as Tag, ...v2Tags().slice(1)]; // 5 entries, one null
    const r = await upload(tags, { id: NOTE_ID, c: C, iv: IV }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid tag structure/);
  });

  it('releases the reservation on Arweave failure so the note can retry (M6)', async () => {
    // Reuse ONE key so both uploads hit the same RateLimiter shard + noteId.
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const pkB64 = b64(pub);
    const ownerHash = b64(await sha256(pub));
    await (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST.put(
      `pk:${pkB64}`, JSON.stringify({ status: 'allowed' }),
    );
    const tags = v2Tags().map(t => (t.name === 'Owner-Hash' ? { ...t, value: ownerHash } : t));
    const body = JSON.stringify({
      data: JSON.stringify({ id: NOTE_ID, c: C, iv: IV }),
      tags, ownerHash, timestamp: Date.now(),
    });
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
    const ip = nextIp();
    const send = () => SELF.fetch('https://proxy.example.com/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Public-Key': pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
      body,
    });

    const r1 = await send();
    expect(r1.status).toBe(502); // Arweave stub fails → reservation released
    const r2 = await send();
    expect(r2.status).toBe(502); // reservable again (NOT 409) → release worked
  });
});
