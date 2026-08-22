#!/usr/bin/env node
/**
 * Mandatory pre-W4 staging smoke: signed v4 (safebox) upload round-trip.
 *
 * Proves the DEPLOYED worker (not just its config) accepts App-Version=4:
 * the exact 5-tag set, the SPLIT-ENVELOPE data object {id,mc,miv,sc,siv}, the
 * UUIDv8 namespace barrier, the per-owner DO path and idempotency — /health
 * alone only proves configuration.
 *
 * Usage (CLI — sends no Origin header, CORS is NOT exercised here):
 *   SMOKE_URL=https://eternal-notes-proxy-staging.<acct>.workers.dev \
 *   SMOKE_PRIVATE_KEY=<base64 32-byte Ed25519 seed of a REGISTERED staging key> \
 *   npm run smoke:v4
 *
 * The key must already be registered on staging via invite (InviteManager is
 * the source of truth — see wrangler.toml [env.staging] prerequisites).
 * NOTE: this posts a REAL (tiny) Arweave transaction paid by the staging wallet.
 *
 * Target policy lives in smoke-target.mjs (fail-closed allowlist of worker
 * origins). A non-listed target additionally needs
 * SMOKE_ALLOW_ORIGIN=<exact https origin> — record why in docs/ROLLBACK.md.
 */

import * as ed from '@noble/ed25519';
import { classifySmokeTarget } from './smoke-target.mjs';

const url = process.env.SMOKE_URL;
const privB64 = process.env.SMOKE_PRIVATE_KEY;
if (!url || !privB64) {
  console.error('SMOKE_URL and SMOKE_PRIVATE_KEY are required');
  process.exit(2);
}

// ── Target gate ─────────────────────────────────────────────────────
// Shared fail-closed classifier (see smoke-target.mjs): full-URL check,
// worker-origin allowlist, per-origin SMOKE_ALLOW_ORIGIN escape hatch,
// no remote http. Requests below are built from the returned origin.
const target = classifySmokeTarget(url, process.env.SMOKE_ALLOW_ORIGIN);
if (!target.ok) {
  console.error(`✗ ${target.reason}`);
  process.exit(2);
}
if (target.warning) console.warn(`⚠ ${target.warning}`);
const origin = target.origin;

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** Random UUIDv8 — the v3/v4 note-id namespace (version nibble 8, RFC variant). */
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
  return fetch(new URL('/upload', origin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': pkB64,
      'X-Signature': sig,
    },
    body,
  });
}

const v4Tags = (noteId) => [
  { name: 'App-Name', value: 'EternalNotes' },
  { name: 'App-Version', value: '4' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Owner-Hash', value: ownerHash },
  { name: 'Note-Id', value: noteId },
];

// ── 1. /health capability ──────────────────────────────────────────
const health = await (await fetch(new URL('/health', origin))).json();
check('health.ok', health.ok === true);
check('health.versions includes 4', Array.isArray(health.versions) && health.versions.includes('4'));
check('health.v4Uploads', health.v4Uploads === true, `got ${health.v4Uploads}`);

// ── 2. v4 round-trip + idempotency ─────────────────────────────────
const entryId = randomUuidV8();
const miv = b64(crypto.getRandomValues(new Uint8Array(12)));
const siv = b64(crypto.getRandomValues(new Uint8Array(12)));
const mc = b64(crypto.getRandomValues(new Uint8Array(96)));
const sc = b64(crypto.getRandomValues(new Uint8Array(64)));
const v4Data = { id: entryId, mc, miv, sc, siv };

const r1 = await signedUpload(v4Tags(entryId), v4Data);
const b1 = r1.ok ? await r1.json() : await r1.text();
check('v4 upload accepted', r1.status === 200 && b1.status === 'accepted' && !!b1.txId,
  `status=${r1.status} body=${JSON.stringify(b1).slice(0, 200)}`);

const r2 = await signedUpload(v4Tags(entryId), v4Data);
const b2 = r2.ok ? await r2.json() : await r2.text();
check('v4 repeat is idempotent (same txId)',
  r2.status === 200 && b2.txId === b1.txId && b2.committed === true,
  `status=${r2.status} txId1=${b1.txId} txId2=${b2.txId}`);

// ── 3. Namespace barrier: v4 tags with a UUIDv4 id must be rejected ──
const v4Uuid4Id = crypto.randomUUID();
const r3 = await signedUpload(v4Tags(v4Uuid4Id), { id: v4Uuid4Id, mc, miv, sc, siv });
check('v4 upload with UUIDv4 Note-Id rejected (400)', r3.status === 400,
  `status=${r3.status} body=${(await r3.text()).slice(0, 120)}`);

// ── 4. Strict schema: a v4 record carrying the single-envelope c/iv pair ──
const strictId = randomUuidV8();
const r4 = await signedUpload(v4Tags(strictId), { id: strictId, c: mc, iv: miv });
check('v4 upload with v2/v3 data keys rejected (400)', r4.status === 400,
  `status=${r4.status} body=${(await r4.text()).slice(0, 120)}`);

// ── 5. v3 is untouched by the v4 acceptor (regression guard) ────────
const v3Id = randomUuidV8();
const r5 = await signedUpload([
  { name: 'App-Name', value: 'EternalNotes' },
  { name: 'App-Version', value: '3' },
  { name: 'Content-Type', value: 'application/json' },
  { name: 'Owner-Hash', value: ownerHash },
  { name: 'Note-Id', value: v3Id },
], { id: v3Id, c: sc, iv: siv });
const b5 = r5.ok ? await r5.json() : await r5.text();
check('v3 upload still accepted', r5.status === 200 && b5.status === 'accepted',
  `status=${r5.status} body=${JSON.stringify(b5).slice(0, 160)}`);

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
