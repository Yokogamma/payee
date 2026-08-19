#!/usr/bin/env node
/**
 * Mandatory pre-W3 staging smoke: signed v3 upload round-trip.
 *
 * Proves the DEPLOYED worker (not just its config) accepts App-Version=3:
 * exact tag/data validation, the UUIDv8 namespace barrier, the per-owner DO
 * path and idempotency — /health alone only proves configuration.
 *
 * Usage (CLI — sends no Origin header, CORS is NOT exercised here):
 *   SMOKE_URL=https://matamata-notes-proxy-staging.<acct>.workers.dev \
 *   SMOKE_PRIVATE_KEY=<base64 32-byte Ed25519 seed of a REGISTERED staging key> \
 *   npm run smoke:v3
 *
 * The key must already be registered on staging via invite (InviteManager is
 * the source of truth — see wrangler.toml [env.staging] prerequisites).
 * NOTE: this posts a REAL (tiny) Arweave transaction paid by the staging wallet.
 */

import * as ed from '@noble/ed25519';

const url = process.env.SMOKE_URL;
const privB64 = process.env.SMOKE_PRIVATE_KEY;
if (!url || !privB64) {
  console.error('SMOKE_URL and SMOKE_PRIVATE_KEY are required');
  process.exit(2);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** Random UUIDv8 — the v3 note-id namespace (version nibble 8, RFC variant). */
function randomUuidV8() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80; // version 8
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const priv = new Uint8Array(Buffer.from(privB64, 'base64'));
const pub = await ed.getPublicKeyAsync(priv);
const pkB64 = b64(pub);
const ownerHash = b64(await sha256(pub));

async function signedUpload(tags, dataObj) {
  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags,
    ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
  return fetch(`${url}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': pkB64,
      'X-Signature': sig,
    },
    body,
  });
}

// ── 1. /health capability ──────────────────────────────────────────
const health = await (await fetch(`${url}/health`)).json();
check('health.ok', health.ok === true);
check('health.versions includes 3', Array.isArray(health.versions) && health.versions.includes('3'));
check('health.v3Uploads', health.v3Uploads === true, `got ${health.v3Uploads}`);

// ── 2. v3 round-trip + idempotency ─────────────────────────────────
const noteId = randomUuidV8();
const iv = b64(crypto.getRandomValues(new Uint8Array(12)));
const c = b64(crypto.getRandomValues(new Uint8Array(64)));
const v3Tags = [
  { name: 'App-Name', value: 'MatamataNotes' },
  { name: 'App-Version', value: '3' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Owner-Hash', value: ownerHash },
  { name: 'Note-Id', value: noteId },
];

const r1 = await signedUpload(v3Tags, { id: noteId, c, iv });
const b1 = r1.ok ? await r1.json() : await r1.text();
check('v3 upload accepted', r1.status === 200 && b1.status === 'accepted' && !!b1.txId,
  `status=${r1.status} body=${JSON.stringify(b1).slice(0, 200)}`);

const r2 = await signedUpload(v3Tags, { id: noteId, c, iv });
const b2 = r2.ok ? await r2.json() : await r2.text();
check('v3 repeat is idempotent (same txId)',
  r2.status === 200 && b2.txId === b1.txId && b2.committed === true,
  `status=${r2.status} txId1=${b1.txId} txId2=${b2.txId}`);

// ── 3. Namespace barrier: v1 tags with a v8 Note-Id must be rejected ──
const v1Tags = [
  { name: 'App-Name', value: 'MatamataNotes' },
  { name: 'App-Version', value: '1' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Owner-Hash', value: ownerHash },
  { name: 'Timestamp', value: '1700000000000' },
  { name: 'Note-Id', value: randomUuidV8() },
];
const r3 = await signedUpload(v1Tags, { id: v1Tags[5].value, c, iv, t: 1700000000000 });
check('v1 upload with UUIDv8 Note-Id rejected (400)', r3.status === 400,
  `status=${r3.status} body=${(await r3.text()).slice(0, 120)}`);

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
