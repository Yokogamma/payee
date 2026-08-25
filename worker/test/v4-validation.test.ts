import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';

// Worker contract tests for App-Version=4 (safebox split envelope).
// A valid Ed25519 signature + ownerHash + allowlist entry are required to reach
// the tag/data validation, so we forge a real signed request per case.
//
// A fully-valid upload passes validation/auth and reaches the Arweave signing
// step, which fails under the stub JWK ('{}') → 502. So 502 == "validation and
// auth passed"; 400 == "the acceptor rejected the wire shape".

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

async function upload(tags: Tag[], dataObj: unknown, ip: string): Promise<Response> {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));

  const finalTags = tags.map(t => (t && t.name === 'Owner-Hash' ? { ...t, value: ownerHash } : t));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));

  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags: finalTags,
    ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));

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

const ID_V8 = '11111111-2222-8333-8444-555555555555';  // UUIDv8 (v3/v4 namespace)
const ID_V4 = '11111111-2222-4333-8444-555555555555';  // UUIDv4 (v1/v2 namespace)
const MC = 'QUFBQUFBQUFBQUFBQUFBQQ=='; // 16 bytes                 // valid base64
const SC = 'QkJCQkJCQkJCQkJCQkJCQg=='; // 16 bytes                 // valid base64
const IV12 = 'AAAAAAAAAAAAAAAA';       // valid base64, exactly 12 bytes
const IV3 = 'AAAA';                    // valid base64, 3 bytes

let ipCounter = 0;
const nextIp = () => `v4v-${crypto.randomUUID().slice(0, 6)}-${ipCounter++}`;

function v4Tags(noteId: string = ID_V8): Tag[] {
  return [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: '4' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: 'PLACEHOLDER' },
    { name: 'Note-Id', value: noteId },
  ];
}
function v4Data(id: string = ID_V8) {
  return { id, mc: MC, miv: IV12, sc: SC, siv: IV12 };
}

describe('upload validation: App-Version=4 (safebox split envelope)', () => {
  it('accepts a well-formed v4 upload past validation (502 at Arweave stage)', async () => {
    const r = await upload(v4Tags(), v4Data(), nextIp());
    expect(r.status).toBe(502);
  });

  it('rejects a v4 upload with a UUIDv4 Note-Id (namespace barrier)', async () => {
    const r = await upload(v4Tags(ID_V4), v4Data(ID_V4), nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/UUIDv8/);
  });

  it('rejects a v4 upload that carries a Timestamp tag (6 tags)', async () => {
    const tags = [...v4Tags(), { name: 'Timestamp', value: '1700000000000' }];
    const r = await upload(tags, v4Data(), nextIp());
    expect(r.status).toBe(400);
  });

  it('rejects a v4 upload missing a required tag (4 tags)', async () => {
    const tags = v4Tags().filter(t => t.name !== 'Content-Type');
    const r = await upload(tags, v4Data(), nextIp());
    expect(r.status).toBe(400);
  });

  it('rejects v4 data carrying the single-envelope c/iv keys (strict key set)', async () => {
    const r = await upload(v4Tags(), { id: ID_V8, c: MC, iv: IV12 }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid data fields/);
  });

  it('rejects v4 data with an extra smuggled field (e.g. t)', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), t: 1700000000000 } as unknown, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid data fields/);
  });

  it('rejects v4 data missing the secret half', async () => {
    const r = await upload(v4Tags(), { id: ID_V8, mc: MC, miv: IV12 }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid data fields/);
  });

  it('rejects a non-12-byte meta IV', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), miv: IV3 }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/miv must be 12 bytes/);
  });

  it('rejects a non-12-byte secret IV (both halves are validated)', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), siv: IV3 }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/siv must be 12 bytes/);
  });

  it('rejects an empty secret ciphertext', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), sc: '' }, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/sc and siv must be non-empty/);
  });

  it('rejects a ciphertext shorter than the GCM tag — BOTH halves', async () => {
    // Same reasoning as the note path, applied to each half independently: a
    // v4 record with a well-formed meta blob and a stub secret blob must never
    // reach the chain.
    for (const short of ['AAAA', 'AAAAAAAAAAAAAAAAAAAA']) { // 3 and 15 bytes
      const meta = await upload(v4Tags(), { ...v4Data(), mc: short }, nextIp());
      expect(meta.status, `mc ${short}`).toBe(400);
      expect(await meta.text()).toMatch(/mc must be at least 16 bytes/);

      const secret = await upload(v4Tags(), { ...v4Data(), sc: short }, nextIp());
      expect(secret.status, `sc ${short}`).toBe(400);
      expect(await secret.text()).toMatch(/sc must be at least 16 bytes/);
    }
  });

  it('rejects a non-string secret ciphertext', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), sc: 42 } as unknown, nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/sc, siv \(strings\) required/);
  });

  it('rejects Note-Id tag not matching data.id', async () => {
    const other = '99999999-2222-8333-8444-555555555555';
    const r = await upload(v4Tags(), v4Data(other), nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Note-Id mismatch/);
  });

  it('rejects a v4 body over the byte cap (413)', async () => {
    const r = await upload(v4Tags(), { ...v4Data(), sc: 'A'.repeat(52000) }, nextIp());
    expect(r.status).toBe(413);
  });

  // Regression: the v4 acceptor must not disturb the older versions.
  it('leaves v3 uploads working (502 at Arweave stage)', async () => {
    const tags: Tag[] = [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '3' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: 'PLACEHOLDER' },
      { name: 'Note-Id', value: ID_V8 },
    ];
    const r = await upload(tags, { id: ID_V8, c: MC, iv: IV12 }, nextIp());
    expect(r.status).toBe(502);
  });

  it('leaves v1 uploads working, still on the UUIDv4 namespace', async () => {
    const tags: Tag[] = [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '1' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: 'PLACEHOLDER' },
      { name: 'Timestamp', value: '1700000000000' },
      { name: 'Note-Id', value: ID_V4 },
    ];
    const r = await upload(tags, { id: ID_V4, c: MC, iv: IV12, t: 1700000000000 }, nextIp());
    expect(r.status).toBe(502);
  });

  it('still rejects an unsupported App-Version (5)', async () => {
    const tags = v4Tags().map(t => (t.name === 'App-Version' ? { ...t, value: '5' } : t));
    const r = await upload(tags, v4Data(), nextIp());
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Unsupported App-Version/);
  });
});
