/**
 * Size limits — shared by the store (hard reject) and the UI (counter,
 * disabled save button).
 *
 * The worker caps the whole /upload body at 51 200 bytes (MAX_BODY_BYTES).
 * The dominant term is the base64 ciphertext = 4/3 × (escaped text + envelope
 * overhead + GCM tag). We meter the text as the byte length of its
 * JSON-STRING-ESCAPED UTF-8 form — exactly how it ships inside the envelope —
 * so multi-byte scripts (Cyrillic = 2 B/char, emoji = 4 B/char) and
 * escape-heavy text (newlines, quotes → 2 B each) are counted honestly.
 * 30 000 escaped bytes → ≈40.3 KB base64 + ~1 KB wrapper: ~10 KB of slack.
 */

import { buildSafeboxUploadPayload, type RecoveryHint } from './arweave';
import type { EncryptedSafeboxEntry, SafeboxAttachmentDescriptor } from './crypto';

export const MAX_NOTE_JSON_BYTES = 30_000;

const encoder = new TextEncoder();

/** Byte size of the text as it will actually be serialized inside the
 *  encrypted JSON envelope: the FULL `JSON.stringify(text)` in UTF-8,
 *  surrounding quotes included — exactly the plan's contract (P3 review;
 *  no `-2` quote discount, so a 30 001-byte serialization is rejected). */
export function noteJsonByteLength(text: string): number {
  return encoder.encode(JSON.stringify(text)).length;
}

export function isNoteTooLong(text: string): boolean {
  return noteJsonByteLength(text) > MAX_NOTE_JSON_BYTES;
}

/** Typed store-level rejection — the UI must show the dedicated size message
 *  (and keep the draft) instead of the generic "save failed". */
export class NoteTooLongError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(`Note too long: ${byteLength} > ${MAX_NOTE_JSON_BYTES} bytes`);
    this.name = 'NoteTooLongError';
    this.byteLength = byteLength;
  }
}

// ─── Safebox entries (v4) ────────────────────────────────────────────
//
// A safebox entry is metered against the WHOLE signed body, not just its
// plaintext: the worker's cap covers tags + ownerHash + timestamp + the
// worst-case recheck/recovery envelope too. Metering only the plaintext would
// let an entry pass its FIRST upload and then get stuck forever on the
// recheck path (the retry body is strictly larger, so it would 413 every time).

/** The worker's MAX_BODY_BYTES (worker/wrangler.toml). Keep in sync. */
export const MAX_UPLOAD_BODY_BYTES = 51_200;

/** Worst case the body can ever grow to on a retry: recheck=true plus a full
 *  server-signed recovery hint (43-char Arweave txId, 13-digit postedAt,
 *  base64 HMAC-SHA256 = 44 chars) and a 13-digit timestamp. */
const WORST_CASE_TIMESTAMP = 9_999_999_999_999;
const WORST_CASE_RECOVERY: RecoveryHint = {
  txId: 'A'.repeat(43),
  postedAt: WORST_CASE_TIMESTAMP,
  token: 'A'.repeat(44),
};
/** base64 of a 32-byte SHA-256 digest — the ownerHash is always exactly this. */
const OWNER_HASH_PLACEHOLDER = 'A'.repeat(44);

/** Byte length of the signed /upload body for this entry, in the WORST case
 *  (recheck + recovery). This is the number the worker's cap applies to. */
export function safeboxUploadByteLength(
  entry: EncryptedSafeboxEntry,
  ownerHash: string = OWNER_HASH_PLACEHOLDER,
): number {
  const payload = buildSafeboxUploadPayload(
    entry, ownerHash, WORST_CASE_TIMESTAMP, true, WORST_CASE_RECOVERY,
  );
  return encoder.encode(JSON.stringify(payload)).length;
}

export function isSafeboxEntryTooLarge(entry: EncryptedSafeboxEntry): boolean {
  return safeboxUploadByteLength(entry) > MAX_UPLOAD_BODY_BYTES;
}

/** Typed store-level rejection — the form keeps the user's input and shows the
 *  dedicated «слишком большая запись» message. */
export class SafeboxEntryTooLargeError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(`Safebox entry too large: ${byteLength} > ${MAX_UPLOAD_BODY_BYTES} bytes`);
    this.name = 'SafeboxEntryTooLargeError';
    this.byteLength = byteLength;
  }
}

/** Plaintext the form is about to turn into an entry version. */
export interface SafeboxSizeInput {
  title: string;
  login: string;
  url: string;
  note: string;
  password: string;
  files: Array<SafeboxAttachmentDescriptor & { size: number }>;
}

/** base64 length of n raw bytes (no line breaks, padded). */
function base64Length(n: number): number {
  return 4 * Math.ceil(n / 3);
}

const GCM_TAG_BYTES = 16;
/** A canonical UUID and a 13-digit epoch — both fixed-width, so the estimate
 *  below matches the real envelope byte-for-byte. */
const ID_PLACEHOLDER = '00000000-0000-8000-8000-000000000000';

/**
 * Exact predicted body size for an entry the user is still typing — same
 * formula as `safeboxUploadByteLength`, but derived from PLAINTEXT (nothing is
 * encrypted yet). Convergence with the store-side check is pinned by a test:
 * base64 = 4·ceil(n/3), AES-GCM adds a 16-byte tag, and the wrapper overhead
 * comes from the real payload builder rather than a hand-copied constant.
 */
export function estimateSafeboxUploadByteLength(input: SafeboxSizeInput): number {
  const meta = {
    v: 1,
    id: ID_PLACEHOLDER,
    t: WORST_CASE_TIMESTAMP,
    title: input.title,
    login: input.login,
    url: input.url,
    note: input.note,
    files: input.files.map(f => ({ fid: f.fid, name: f.name, mime: f.mime, size: f.size })),
    rev: 1,
    root: ID_PLACEHOLDER,
    prev: ID_PLACEHOLDER, // worst case: a non-root version carries `prev`
  };
  const secret = {
    v: 1,
    id: ID_PLACEHOLDER,
    password: input.password,
    files: input.files.map(f => ({ fid: f.fid, data: 'A'.repeat(base64Length(f.size)) })),
  };

  const metaBytes = encoder.encode(JSON.stringify(meta)).length;
  const secretBytes = encoder.encode(JSON.stringify(secret)).length;

  const fake: EncryptedSafeboxEntry = {
    entryId: ID_PLACEHOLDER,
    metaCiphertext: 'A'.repeat(base64Length(metaBytes + GCM_TAG_BYTES)),
    metaIv: 'A'.repeat(base64Length(12)),
    secretCiphertext: 'A'.repeat(base64Length(secretBytes + GCM_TAG_BYTES)),
    secretIv: 'A'.repeat(base64Length(12)),
    createdAt: WORST_CASE_TIMESTAMP,
    v: 4,
  };
  return safeboxUploadByteLength(fake);
}

/** Remaining budget for the form counter (never negative in the UI copy). */
export function safeboxBytesRemaining(input: SafeboxSizeInput): number {
  return MAX_UPLOAD_BODY_BYTES - estimateSafeboxUploadByteLength(input);
}

/** Raw attachment budget quoted in the UI: ~20–24 KB total per entry survives
 *  the double base64 (×16/9) inside the 51 200-byte body. Enforced for real by
 *  the byte-exact estimate above — this is the pre-read guard so a huge
 *  File.size is rejected BEFORE `arrayBuffer()` is ever called. */
export const MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES = 24 * 1024;
