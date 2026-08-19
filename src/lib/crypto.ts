/**
 * Matamata Notes — Core Crypto Module
 *
 * Pure cryptographic operations. No storage/persistence.
 *
 * Flow:
 *   generateMnemonic() → 12 words
 *   deriveKey(mnemonic) → CryptoKey (AES-256-GCM)
 *   encrypt(key, plaintext) → EncryptedNote { noteId, ciphertext, iv, createdAt }
 *   decrypt(key, encrypted) → plaintext
 *
 * Signing (Ed25519):
 *   deriveSigningKeypair(mnemonic) → { privateKey, publicKey }
 *   deriveOwnerHash(publicKey) → SHA-256(publicKey) base64
 *   signPayload(privateKey, payload) → signature base64
 */

import { generateMnemonic as genMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as ed25519 from '@noble/ed25519';

// ─── Types ───────────────────────────────────────────────────────────

export interface EncryptedNote {
  /** Unique ID. v1/v2: crypto.randomUUID() (UUIDv4). v3: randomUuidV8() — a
   *  DISJOINT namespace so legacy serializers can never pass a v3 record off
   *  as v1 (the worker enforces the split per App-Version). Primary key in
   *  IndexedDB and Arweave tag. */
  noteId: string;
  /** Base64-encoded ciphertext (includes GCM auth tag — integrity guaranteed) */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (unique per note) */
  iv: string;
  /** Timestamp of creation */
  createdAt: number;
  /**
   * Data format version. Absent/1 = v1: ciphertext is the raw note text and
   * noteId/createdAt live in plaintext (Arweave tags / outer JSON). 2 = v2:
   * ciphertext is an encrypted envelope {v,id,t,text}: the DATE is hidden
   * on-chain (no Timestamp tag), while the noteId stays public as the outer
   * Note-Id tag but is GCM-bound to the envelope (mismatch → rejected).
   * 3 = v3: envelope additionally carries PRIVATE version-chain metadata
   * {fmt,rev,root,prev} — same wire shape as v2 on-chain.
   */
  v?: 1 | 2 | 3;
  // No hash field. GCM auth tag inside ciphertext ensures integrity.
  // If decrypt succeeds — data is not corrupted.
}

/** v2 plaintext payload — encrypted whole so metadata is hidden + authenticated. */
interface NoteEnvelopeV2 {
  v: 2;
  id: string;
  t: number;
  text: string;
}

/** v3 plaintext payload — v2 plus the version-chain metadata. The chain graph
 *  (root/rev/prev) and the display format stay INSIDE the ciphertext: zero new
 *  on-chain tags, the version history is private. */
interface NoteEnvelopeV3 {
  v: 3;
  id: string;    // must equal the outer noteId (GCM-bound)
  t: number;     // createdAt of THIS version
  text: string;
  fmt: NoteFormat;
  rev: number;   // integer >= 1 within the chain
  root: string;  // noteId of the chain's FIRST version; rev===1 ⇒ root===id
  prev?: string; // noteId of the predecessor version (rev>=2); informational
}

export type NoteFormat = 'md' | 'plain';

/** Version-chain metadata attached to every decrypted note. For v1/v2 records
 *  it is SYNTHESIZED ({fmt:'plain', rev:1, root:noteId}) — old notes are chain
 *  roots by definition, no stored-data rewrite needed. */
export interface NoteVersionMeta {
  fmt: NoteFormat;
  rev: number;
  root: string;
  prev?: string;
}

export interface NoteData extends NoteVersionMeta {
  id: string;
  text: string;
  createdAt: number;
}

// ─── Mnemonic (Seed Phrase) ──────────────────────────────────────────

/**
 * Generate a new 12-word mnemonic (BIP-39)
 * 128 bits of entropy → 12 words
 */
export function generateMnemonic(): string {
  return genMnemonic(wordlist, 128);
}

/**
 * Validate a mnemonic phrase
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

// ─── Key Derivation ──────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM CryptoKey from a mnemonic phrase.
 *
 * mnemonic → BIP-39 seed (64 bytes) → first 32 bytes → HKDF → AES-256 key
 *
 * Deterministic: same mnemonic always produces same key.
 */
export async function deriveKey(mnemonic: string): Promise<CryptoKey> {
  return deriveAesKey(mnemonic, 'aes-256-gcm-encryption');
}

/** Shared HKDF→AES-256-GCM derivation. The SALT is fixed forever
 *  ('matamata-notes-v1'); only `info` separates the domains. Changing either
 *  constant orphans every existing record — treat as a breaking migration. */
async function deriveAesKey(mnemonic: string, info: string): Promise<CryptoKey> {
  const seed = mnemonicToSeedSync(mnemonic);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed.slice(0, 32),
    'HKDF',
    false,
    ['deriveKey']
  );

  const salt = new TextEncoder().encode('matamata-notes-v1');

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Safebox META key (`info: "safebox-meta-v1"`) — title/login/url/note and the
 * attachment DESCRIPTORS. Held in a ref only while the safebox section is
 * unlocked; restore derives it on demand straight from the mnemonic (no PIN
 * involved — correct per the threat model: the PIN is an access gate, not a
 * crypto boundary).
 */
export async function deriveSafeboxMetaKey(mnemonic: string): Promise<CryptoKey> {
  return deriveAesKey(mnemonic, 'safebox-meta-v1');
}

/**
 * Safebox SECRET key (`info: "safebox-secret-v1"`) — the password and the
 * attachment CONTENTS. Derived on demand inside reveal/copy/download/edit (and
 * in restore, to validate a candidate) and dropped immediately: it must NEVER
 * be cached in a ref, and the search path must never be able to reach it.
 */
export async function deriveSafeboxSecretKey(mnemonic: string): Promise<CryptoKey> {
  return deriveAesKey(mnemonic, 'safebox-secret-v1');
}

// ─── Ed25519 Signing ────────────────────────────────────────────────

/**
 * Derive deterministic Ed25519 keypair from mnemonic.
 * seed → HKDF(info="ed25519-signing-v1") → 32 bytes → Ed25519 private key → public key
 */
export async function deriveSigningKeypair(mnemonic: string): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const seed = mnemonicToSeedSync(mnemonic);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed.slice(0, 32),
    'HKDF',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('matamata-notes-v1'),
      info: new TextEncoder().encode('ed25519-signing-v1'),
    },
    keyMaterial,
    256
  );

  const privateKey = new Uint8Array(bits);
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);

  return { privateKey, publicKey };
}

/**
 * Derive owner hash from Ed25519 public key.
 * ownerHash = SHA-256(publicKey) — verifiable by Worker (R5).
 */
export async function deriveOwnerHash(publicKey: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', publicKey as BufferSource);
  return bufferToBase64(hashBuffer);
}

/**
 * Sign SHA-256 digest of a payload string with Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function signPayload(privateKey: Uint8Array, payload: string): Promise<string> {
  const data = new TextEncoder().encode(payload);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const signature = await ed25519.signAsync(digest, privateKey);
  return bufferToBase64(signature);
}

// ─── Encryption / Decryption ─────────────────────────────────────────

/**
 * Encrypt a plaintext note with AES-256-GCM.
 * Each note gets a unique random IV (12 bytes) and a random noteId (UUID).
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: string
): Promise<EncryptedNote> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Random 12-byte IV — MUST be unique per encryption
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // AES-256-GCM encryption (auth tag is appended to ciphertext)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    noteId: crypto.randomUUID(),
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    createdAt: Date.now(),
  };
}

/**
 * Encrypt a note as a v2 envelope: the whole {v,id,t,text} object is encrypted.
 * Privacy gain vs v1: the TIMESTAMP is hidden (it lives only inside the
 * envelope; v2 uploads carry no Timestamp tag). The note id, however, is still
 * PUBLIC on-chain — the outer Note-Id tag stays for dedup/GraphQL — but it is
 * cryptographically bound to the envelope: restore rejects any TX whose outer
 * Note-Id doesn't match the GCM-authenticated inner id.
 * Not yet wired into the write path (reader-before-writer rollout) — v2 is
 * accepted for reading first, then writes flip over.
 */
export async function encryptEnvelope(
  key: CryptoKey,
  plaintext: string
): Promise<EncryptedNote> {
  const noteId = crypto.randomUUID();
  const createdAt = Date.now();
  const envelope: NoteEnvelopeV2 = { v: 2, id: noteId, t: createdAt, text: plaintext };

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(envelope))
  );

  return {
    noteId,
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    createdAt,
    v: 2,
  };
}

/**
 * Random UUIDv8 — the id namespace for v3 note versions. DISJOINT from the
 * UUIDv4s that crypto.randomUUID() produces for v1/v2, so a stale pre-v3
 * client that re-serializes a v3 record with the legacy v1 writer is rejected
 * by the worker's per-App-Version namespace check instead of permanently
 * committing garbage ciphertext (per-noteId idempotency is forever).
 */
export function randomUuidV8(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80; // version nibble = 8
  b[8] = (b[8] & 0x3f) | 0x80; // RFC variant = 10
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Encrypt a note as a v3 envelope: v2 privacy plus version-chain metadata
 * (fmt/rev/root/prev) inside the ciphertext. Every version gets a FRESH
 * UUIDv8 noteId; the chain identity is `root` (defaults to the new noteId for
 * rev-1 roots). Gated by V3_WRITER_ENABLED at the store level.
 */
export async function encryptEnvelopeV3(
  key: CryptoKey,
  plaintext: string,
  meta: { fmt: NoteFormat; rev: number; root?: string; prev?: string },
): Promise<EncryptedNote> {
  const noteId = randomUuidV8();
  const createdAt = Date.now();
  const envelope: NoteEnvelopeV3 = {
    v: 3,
    id: noteId,
    t: createdAt,
    text: plaintext,
    fmt: meta.fmt,
    rev: meta.rev,
    root: meta.root ?? noteId,
    ...(meta.prev !== undefined ? { prev: meta.prev } : {}),
  };

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(envelope))
  );

  return {
    noteId,
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    createdAt,
    v: 3,
  };
}

/** Low-level AES-256-GCM decrypt → UTF-8 string. Throws on wrong key/tamper. */
async function aesDecrypt(key: CryptoKey, encrypted: EncryptedNote): Promise<string> {
  const ciphertext = base64ToBuffer(encrypted.ciphertext);
  const iv = base64ToBuffer(encrypted.iv);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(decrypted);
}

// Runtime validators shared by ALL versions: synthesized v1/v2 meta feeds the
// same chain grouping/sorting as v3, so a malformed legacy value must not slip
// through just because its version predates the checks.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V8_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** ECMAScript Date range ceiling (±8.64e15 ms; we require non-negative). */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

function isValidTimestamp(t: unknown): t is number {
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIMESTAMP_MS;
}

/** Thrown for a record whose `v` is not a known version. Callers must treat the
 *  record as unreadable (skip/quarantine) — NEVER fall back to the v1 raw-text
 *  path, which would render (or worse, re-upload) an unknown envelope as text. */
export class UnsupportedNoteVersionError extends Error {
  constructor(v: unknown) {
    super(`Unsupported note version: ${String(v)}`);
    this.name = 'UnsupportedNoteVersionError';
  }
}

function parseEnvelopeV3(raw: string, noteId: string): { text: string; createdAt: number; meta: NoteVersionMeta } {
  const env = JSON.parse(raw) as NoteEnvelopeV3;
  const fail = (why: string): never => {
    throw new Error(`v3 envelope integrity check failed: ${why}`);
  };

  if (env === null || typeof env !== 'object' || env.v !== 3) fail('shape');
  if (typeof env.text !== 'string') fail('text');
  if (typeof env.id !== 'string' || env.id !== noteId) fail('id mismatch');
  if (!UUID_V8_REGEX.test(env.id)) fail('id namespace');
  if (!isValidTimestamp(env.t)) fail('t');
  if (env.fmt !== 'md' && env.fmt !== 'plain') fail('fmt');
  if (!Number.isSafeInteger(env.rev) || env.rev < 1) fail('rev');
  if (typeof env.root !== 'string' || !UUID_ANY_REGEX.test(env.root)) fail('root');
  if (env.prev !== undefined && (typeof env.prev !== 'string' || !UUID_ANY_REGEX.test(env.prev))) fail('prev');
  // Linkage invariants: a root version links to nothing; a non-root version
  // must link somewhere and can be neither its own root nor its own prev.
  if (env.rev === 1 && (env.root !== env.id || env.prev !== undefined)) fail('rev-1 linkage');
  if (env.rev > 1 && (env.prev === undefined || env.prev === env.id || env.root === env.id)) fail('rev-n linkage');

  const meta: NoteVersionMeta = {
    fmt: env.fmt,
    rev: env.rev,
    root: env.root,
    ...(env.prev !== undefined ? { prev: env.prev } : {}),
  };
  return { text: env.text, createdAt: env.t, meta };
}

/**
 * Decrypt a note to its text, authoritative timestamp AND version-chain meta,
 * dispatching on an EXPLICIT version switch (fail closed — an unknown `v` must
 * never fall through to the v1 raw-text path).
 * - v1 (absent/1): ciphertext IS the text; createdAt from the record; meta
 *   synthesized (plain, rev 1, root = own noteId).
 * - v2: envelope {v,id,t,text}; inner id cross-checked against the record's
 *   noteId (defeats swapping ciphertext under a forged outer id); timestamp
 *   from the authenticated envelope; meta synthesized.
 * - v3: envelope additionally validated for fmt/rev/root/prev + linkage
 *   invariants and the UUIDv8 id namespace.
 * Throws if decryption fails or the envelope is inconsistent.
 */
export async function decryptNote(
  key: CryptoKey,
  encrypted: EncryptedNote
): Promise<{ text: string; createdAt: number; meta: NoteVersionMeta }> {
  const v = encrypted.v;
  if (v !== undefined && v !== 1 && v !== 2 && v !== 3) {
    throw new UnsupportedNoteVersionError(v);
  }

  const raw = await aesDecrypt(key, encrypted);

  if (v === 3) {
    return parseEnvelopeV3(raw, encrypted.noteId);
  }

  const legacyMeta = (noteId: string): NoteVersionMeta => ({ fmt: 'plain', rev: 1, root: noteId });

  if (v === 2) {
    const env = JSON.parse(raw) as NoteEnvelopeV2;
    if (
      env === null || typeof env !== 'object' ||
      env.v !== 2 ||
      typeof env.text !== 'string' ||
      typeof env.id !== 'string' ||
      env.id !== encrypted.noteId ||
      !UUID_V4_REGEX.test(env.id) ||
      !isValidTimestamp(env.t)
    ) {
      throw new Error('v2 envelope integrity check failed');
    }
    return { text: env.text, createdAt: env.t, meta: legacyMeta(encrypted.noteId) };
  }

  // v1 (absent/1): the id/timestamp live outside the ciphertext — still apply
  // the shared validators so garbage can't reach chain grouping/sorting.
  if (!UUID_V4_REGEX.test(encrypted.noteId)) {
    throw new Error('v1 record integrity check failed: noteId');
  }
  if (!isValidTimestamp(encrypted.createdAt)) {
    throw new Error('v1 record integrity check failed: createdAt');
  }
  return { text: raw, createdAt: encrypted.createdAt, meta: legacyMeta(encrypted.noteId) };
}

/** Decrypt a note to its text only (v1 or v2). Throws on failure/tamper. */
export async function decrypt(
  key: CryptoKey,
  encrypted: EncryptedNote
): Promise<string> {
  return (await decryptNote(key, encrypted)).text;
}

// ─── Safebox (v4) — split envelope ───────────────────────────────────
//
// One on-chain record per entry VERSION, carrying TWO independently-keyed
// AES-GCM blobs:
//   meta   (deriveSafeboxMetaKey)   — title/login/url/note + attachment
//                                     DESCRIPTORS + chain metadata; decrypted
//                                     for the whole unlocked section (search).
//   secret (deriveSafeboxSecretKey) — password + attachment CONTENTS; decrypted
//                                     ONLY at the moment of an explicit action.
// Both carry `id === entryId` and BOTH decryptors cross-check it: that is what
// defeats mix-and-match (grafting record A's secret blob onto record B's meta).

/** Attachment metadata — visible inside the unlocked section, never indexed. */
export interface SafeboxAttachmentDescriptor {
  fid: string;   // canonical UUID, unique within the entry
  name: string;
  mime: string;
  size: number;  // raw byte length; cross-checked against the decoded content
}

/** Attachment payload — lives ONLY in the secret envelope. */
export interface SafeboxAttachmentContent {
  fid: string;
  data: string; // canonical base64 of the raw bytes
}

interface SafeboxMetaEnvelope {
  v: 1;
  id: string;    // === entryId (GCM-bound)
  t: number;     // createdAt of THIS version
  title: string;
  login: string;
  url: string;
  note: string;
  files: SafeboxAttachmentDescriptor[];
  rev: number;   // integer >= 1
  root: string;  // entryId of the chain's FIRST version
  prev?: string;
}

interface SafeboxSecretEnvelope {
  v: 1;
  id: string;    // === entryId (GCM-bound)
  password: string;
  files: SafeboxAttachmentContent[];
  // Reserved for a future stage (NOT implemented): totp?: {...}
}

/** The stored/on-chain record. Deliberately its OWN type with its OWN `v: 4`:
 *  `EncryptedNote.v` stays 1|2|3 so the notes fail-closed guards keep rejecting
 *  unknown note versions. */
export interface EncryptedSafeboxEntry {
  entryId: string;
  metaCiphertext: string;
  metaIv: string;
  secretCiphertext: string;
  secretIv: string;
  /** Outer timestamp — index/ordering ONLY. Currentness always comes from the
   *  authenticated `t`/`rev` inside the meta envelope. */
  createdAt: number;
  v: 4;
}

/** Decrypted meta — what the unlocked section renders and searches. */
export interface SafeboxEntryData {
  id: string;
  createdAt: number; // authenticated `t` from the envelope
  title: string;
  login: string;
  url: string;
  note: string;
  files: SafeboxAttachmentDescriptor[];
  rev: number;
  root: string;
  prev?: string;
}

/** Decrypted secret — never stored, never published to React state. */
export interface SafeboxSecretData {
  password: string;
  files: SafeboxAttachmentContent[];
}

/** Plaintext input for a new entry version (both envelopes at once). */
export interface SafeboxEntryInput {
  title: string;
  login: string;
  url: string;
  note: string;
  password: string;
  files: Array<SafeboxAttachmentDescriptor & { data: string }>;
  rev: number;
  root?: string;
  prev?: string;
}

/** Hard caps on envelope shape. The real size gate is the worker body cap
 *  (limits.ts); these only stop absurd/hostile values from reaching the UI. */
export const MAX_SAFEBOX_FILES = 20;
export const MAX_SAFEBOX_FILENAME_CHARS = 200;
export const MAX_SAFEBOX_MIME_CHARS = 120;
/** No attachment can exceed the worker's whole-body cap, so anything larger is
 *  structurally impossible and treated as malformed. */
const MAX_SAFEBOX_ATTACHMENT_BYTES = 51_200;

export class SafeboxEnvelopeError extends Error {
  constructor(why: string) {
    super(`safebox envelope integrity check failed: ${why}`);
    this.name = 'SafeboxEnvelopeError';
  }
}

/** Base64 that round-trips EXACTLY — a non-canonical spelling of the same bytes
 *  must not pass (it would break the size cross-check and the wire contract). */
function isCanonicalBase64(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    return bufferToBase64(base64ToBuffer(s)) === s;
  } catch {
    return false;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Exact key set — extra OR missing fields are malformed (no smuggling). */
function hasExactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(o);
  return actual.length === keys.length && actual.every(k => keys.includes(k));
}

function assertDescriptors(raw: unknown): SafeboxAttachmentDescriptor[] {
  if (!Array.isArray(raw)) throw new SafeboxEnvelopeError('files');
  if (raw.length > MAX_SAFEBOX_FILES) throw new SafeboxEnvelopeError('files count');
  const seen = new Set<string>();
  const out: SafeboxAttachmentDescriptor[] = [];
  for (const f of raw) {
    if (!isPlainObject(f) || !hasExactKeys(f, ['fid', 'name', 'mime', 'size'])) {
      throw new SafeboxEnvelopeError('file descriptor shape');
    }
    const { fid, name, mime, size } = f;
    if (typeof fid !== 'string' || !UUID_ANY_REGEX.test(fid)) throw new SafeboxEnvelopeError('file fid');
    // Duplicate fids make the descriptor↔content mapping ambiguous — exactly
    // the confusion that could bind a name to someone else's bytes.
    if (seen.has(fid)) throw new SafeboxEnvelopeError('duplicate file fid');
    seen.add(fid);
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SAFEBOX_FILENAME_CHARS) {
      throw new SafeboxEnvelopeError('file name');
    }
    if (typeof mime !== 'string' || mime.length > MAX_SAFEBOX_MIME_CHARS) {
      throw new SafeboxEnvelopeError('file mime');
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_SAFEBOX_ATTACHMENT_BYTES) {
      throw new SafeboxEnvelopeError('file size');
    }
    out.push({ fid, name, mime, size: size as number });
  }
  return out;
}

function assertContents(raw: unknown): SafeboxAttachmentContent[] {
  if (!Array.isArray(raw)) throw new SafeboxEnvelopeError('secret files');
  if (raw.length > MAX_SAFEBOX_FILES) throw new SafeboxEnvelopeError('secret files count');
  const seen = new Set<string>();
  const out: SafeboxAttachmentContent[] = [];
  for (const f of raw) {
    if (!isPlainObject(f) || !hasExactKeys(f, ['fid', 'data'])) {
      throw new SafeboxEnvelopeError('secret file shape');
    }
    const { fid, data } = f;
    if (typeof fid !== 'string' || !UUID_ANY_REGEX.test(fid)) throw new SafeboxEnvelopeError('secret file fid');
    if (seen.has(fid)) throw new SafeboxEnvelopeError('duplicate secret file fid');
    seen.add(fid);
    if (!isCanonicalBase64(data)) throw new SafeboxEnvelopeError('secret file data');
    out.push({ fid, data });
  }
  return out;
}

/** AES-GCM decrypt of one safebox half → UTF-8 string. */
async function aesDecryptRaw(key: CryptoKey, ciphertextB64: string, ivB64: string): Promise<string> {
  const ciphertext = base64ToBuffer(ciphertextB64);
  const iv = base64ToBuffer(ivB64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

async function aesEncryptRaw(key: CryptoKey, plaintext: string): Promise<{ c: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { c: bufferToBase64(buf), iv: bufferToBase64(iv) };
}

/**
 * Build + encrypt BOTH halves of a new entry version. A fresh UUIDv8 `entryId`
 * per version (worker idempotency is permanent per id); the chain identity is
 * `root` inside the meta envelope.
 */
export async function encryptSafeboxEntry(
  metaKey: CryptoKey,
  secretKey: CryptoKey,
  input: SafeboxEntryInput,
): Promise<EncryptedSafeboxEntry> {
  const entryId = randomUuidV8();
  const createdAt = Date.now();

  const meta: SafeboxMetaEnvelope = {
    v: 1,
    id: entryId,
    t: createdAt,
    title: input.title,
    login: input.login,
    url: input.url,
    note: input.note,
    files: input.files.map(f => ({ fid: f.fid, name: f.name, mime: f.mime, size: f.size })),
    rev: input.rev,
    root: input.root ?? entryId,
    ...(input.prev !== undefined ? { prev: input.prev } : {}),
  };
  const secret: SafeboxSecretEnvelope = {
    v: 1,
    id: entryId,
    password: input.password,
    files: input.files.map(f => ({ fid: f.fid, data: f.data })),
  };

  // Validate what we are about to make PERMANENT: an entry that violates the
  // fid/linkage contract would be undecryptable-by-contract forever on-chain.
  assertDescriptors(meta.files);
  assertContents(secret.files);
  assertFileCorrespondence(meta.files, secret.files);
  if (!Number.isSafeInteger(meta.rev) || meta.rev < 1) throw new SafeboxEnvelopeError('rev');
  // Same v8 namespace rule as the decrypt path — never MAKE a record the
  // reader would (correctly) refuse.
  if (!UUID_V8_REGEX.test(meta.root)) throw new SafeboxEnvelopeError('root namespace');
  if (meta.prev !== undefined && !UUID_V8_REGEX.test(meta.prev)) {
    throw new SafeboxEnvelopeError('prev namespace');
  }
  if (meta.rev === 1 && (meta.root !== meta.id || meta.prev !== undefined)) {
    throw new SafeboxEnvelopeError('rev-1 linkage');
  }
  if (meta.rev > 1 && (meta.prev === undefined || meta.root === meta.id)) {
    throw new SafeboxEnvelopeError('rev-n linkage');
  }

  const [m, s] = await Promise.all([
    aesEncryptRaw(metaKey, JSON.stringify(meta)),
    aesEncryptRaw(secretKey, JSON.stringify(secret)),
  ]);

  return {
    entryId,
    metaCiphertext: m.c,
    metaIv: m.iv,
    secretCiphertext: s.c,
    secretIv: s.iv,
    createdAt,
    v: 4,
  };
}

/**
 * Decrypt + fail-closed validate the META half. Throws on a wrong key, tamper,
 * an id mismatch (mix-and-match defense) or any shape violation.
 */
export async function decryptSafeboxMeta(
  key: CryptoKey,
  entry: EncryptedSafeboxEntry,
): Promise<SafeboxEntryData> {
  if (entry.v !== 4) throw new SafeboxEnvelopeError(`unsupported version: ${String(entry.v)}`);
  const raw = await aesDecryptRaw(key, entry.metaCiphertext, entry.metaIv);

  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new SafeboxEnvelopeError('meta json');
  }
  if (!isPlainObject(env)) throw new SafeboxEnvelopeError('meta shape');
  if (!hasExactKeys(env, env.prev === undefined
    ? ['v', 'id', 't', 'title', 'login', 'url', 'note', 'files', 'rev', 'root']
    : ['v', 'id', 't', 'title', 'login', 'url', 'note', 'files', 'rev', 'root', 'prev'])) {
    throw new SafeboxEnvelopeError('meta keys');
  }
  if (env.v !== 1) throw new SafeboxEnvelopeError('meta v');
  // GCM-BOUND ID: the single check that makes a (meta, secret) pair unforgeable.
  if (typeof env.id !== 'string' || env.id !== entry.entryId) throw new SafeboxEnvelopeError('meta id mismatch');
  if (!UUID_V8_REGEX.test(env.id)) throw new SafeboxEnvelopeError('meta id namespace');
  if (!isValidTimestamp(env.t)) throw new SafeboxEnvelopeError('meta t');
  for (const field of ['title', 'login', 'url', 'note'] as const) {
    if (typeof env[field] !== 'string') throw new SafeboxEnvelopeError(`meta ${field}`);
  }
  const files = assertDescriptors(env.files);
  if (!Number.isSafeInteger(env.rev) || (env.rev as number) < 1) throw new SafeboxEnvelopeError('meta rev');
  // UUIDv8, not "any UUID": `root`/`prev` are entryIds of OTHER versions of the
  // same chain, and every safebox entryId is v8 (the worker enforces it per
  // App-Version). Notes legitimately use the looser check — a v3 note version
  // can be rooted at a legacy v1/v2 note whose id is a UUIDv4 — but the safebox
  // has no legacy predecessor, so anything outside the v8 namespace is forged
  // or corrupt.
  if (typeof env.root !== 'string' || !UUID_V8_REGEX.test(env.root)) throw new SafeboxEnvelopeError('meta root');
  if (env.prev !== undefined && (typeof env.prev !== 'string' || !UUID_V8_REGEX.test(env.prev))) {
    throw new SafeboxEnvelopeError('meta prev');
  }
  const rev = env.rev as number;
  if (rev === 1 && (env.root !== env.id || env.prev !== undefined)) throw new SafeboxEnvelopeError('rev-1 linkage');
  if (rev > 1 && (env.prev === undefined || env.prev === env.id || env.root === env.id)) {
    throw new SafeboxEnvelopeError('rev-n linkage');
  }

  return {
    id: env.id,
    createdAt: env.t as number,
    title: env.title as string,
    login: env.login as string,
    url: env.url as string,
    note: env.note as string,
    files,
    rev,
    root: env.root,
    ...(env.prev !== undefined ? { prev: env.prev as string } : {}),
  };
}

/** Descriptors ↔ contents must be a strict one-to-one mapping, and each
 *  declared size must equal the decoded byte length. */
function assertFileCorrespondence(
  descriptors: SafeboxAttachmentDescriptor[],
  contents: SafeboxAttachmentContent[],
): void {
  if (descriptors.length !== contents.length) throw new SafeboxEnvelopeError('file cardinality');
  const byFid = new Map(contents.map(c => [c.fid, c]));
  if (byFid.size !== contents.length) throw new SafeboxEnvelopeError('duplicate secret file fid');
  for (const d of descriptors) {
    const c = byFid.get(d.fid);
    if (!c) throw new SafeboxEnvelopeError('file fid mismatch');
    if (base64ToBuffer(c.data).byteLength !== d.size) throw new SafeboxEnvelopeError('file size mismatch');
  }
}

/**
 * Decrypt + fail-closed validate the SECRET half against the ALREADY-VALIDATED
 * descriptors from the meta half. Same GCM-bound id cross-check, plus the
 * one-to-one fid correspondence and the per-file size check.
 *
 * The returned plaintext must be used immediately and dropped — never stored,
 * never published to React state.
 */
export async function decryptSafeboxSecret(
  key: CryptoKey,
  entry: EncryptedSafeboxEntry,
  descriptors: SafeboxAttachmentDescriptor[],
): Promise<SafeboxSecretData> {
  if (entry.v !== 4) throw new SafeboxEnvelopeError(`unsupported version: ${String(entry.v)}`);
  const raw = await aesDecryptRaw(key, entry.secretCiphertext, entry.secretIv);

  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new SafeboxEnvelopeError('secret json');
  }
  if (!isPlainObject(env)) throw new SafeboxEnvelopeError('secret shape');
  if (!hasExactKeys(env, ['v', 'id', 'password', 'files'])) throw new SafeboxEnvelopeError('secret keys');
  if (env.v !== 1) throw new SafeboxEnvelopeError('secret v');
  if (typeof env.id !== 'string' || env.id !== entry.entryId) throw new SafeboxEnvelopeError('secret id mismatch');
  if (typeof env.password !== 'string') throw new SafeboxEnvelopeError('secret password');
  const files = assertContents(env.files);
  assertFileCorrespondence(descriptors, files);

  return { password: env.password, files };
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── PIN Encryption ─────────────────────────────────────────────────
//
// Versioned KDF. NEW blobs use Argon2id (memory-hard → far costlier to brute
// force a short PIN on a GPU). LEGACY blobs (no `kdf` field) used PBKDF2-600k and
// are still readable, then transparently re-wrapped to Argon2id on next unlock.

interface Argon2Params {
  iterations: number;
  memorySize: number;   // KiB
  parallelism: number;
  hashLength: number;
}

// Mobile-tuned starting point (~64 MiB, t=3). Revisit with device benchmarks.
const ARGON2_PARAMS: Argon2Params = { iterations: 3, memorySize: 65_536, parallelism: 1, hashLength: 32 };
const PIN_KDF_VERSION = 1;

export interface PinEncryptedSeed {
  ciphertext: string; // base64
  iv: string;         // base64
  salt: string;       // base64
  /** Absent = legacy PBKDF2-600k; 'argon2id' = memory-hard (current). */
  kdf?: 'pbkdf2' | 'argon2id';
  v?: number;
  argon2?: Argon2Params; // present iff kdf === 'argon2id'
}

/** Legacy PBKDF2 (SHA-256, 600k) key derivation — read path only. */
async function derivePinKeyPbkdf2(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Argon2id key derivation (current). Uses the hash-wasm WASM implementation. */
async function derivePinKeyArgon2(pin: string, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  const { argon2id } = await import('hash-wasm');
  const raw = await argon2id({
    password: pin,
    salt,
    iterations: params.iterations,
    memorySize: params.memorySize,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** True if the blob predates Argon2id and should be re-wrapped after unlock. */
export function isPinKdfLegacy(encrypted: PinEncryptedSeed): boolean {
  return encrypted.kdf !== 'argon2id';
}

/** The KDF ran and AES-GCM authentication failed → the PIN itself is wrong.
 *  ONLY this error may count against the attempt limit / trigger the wipe. */
export class WrongPinError extends Error {
  constructor() {
    super('Wrong PIN');
    this.name = 'WrongPinError';
  }
}

/** The PIN blob or the KDF runtime is unusable: corrupted/unknown blob, Argon2
 *  WASM load failure, out-of-memory on a weak device, WebCrypto hiccup. NOT the
 *  user's fault — callers must not spend unlock attempts on it (a correct PIN
 *  would otherwise be wiped after 10 environment failures). Seed entry works. */
export class PinUnlockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinUnlockUnavailableError';
  }
}

/**
 * Validate a stored PIN blob BEFORE running the KDF. A corrupted/hostile blob
 * must not be able to drive Argon2 into an OOM/hang via huge params, and an
 * unknown kdf must fail loudly (not silently fall back to PBKDF2).
 *
 * EXPORTED (as assertValidPinBlob) so storage.ts can apply the SAME check to
 * the blob nested inside the safebox PIN config — a shallow "three strings"
 * shape test there would accept non-base64, a wrong IV/salt length, an unknown
 * KDF or arbitrary Argon2 parameters.
 */
export function assertValidPinBlob(e: PinEncryptedSeed): void {
  if (typeof e.ciphertext !== 'string' || e.ciphertext.length === 0 ||
      typeof e.iv !== 'string' || typeof e.salt !== 'string') {
    throw new Error('Malformed PIN blob');
  }
  if (base64ToBuffer(e.iv).length !== 12) throw new Error('Malformed PIN blob: iv');
  if (base64ToBuffer(e.salt).length !== 16) throw new Error('Malformed PIN blob: salt');
  // AES-GCM output is plaintext + 16-byte tag; anything shorter is structurally
  // broken and must be reported as a storage problem, never as a wrong PIN.
  if (base64ToBuffer(e.ciphertext).length < 16) throw new Error('Malformed PIN blob: ciphertext too short');

  if (e.kdf !== undefined && e.kdf !== 'pbkdf2' && e.kdf !== 'argon2id') {
    throw new Error(`Unknown PIN kdf: ${e.kdf}`);
  }
  if (e.kdf === 'argon2id') {
    // Pin to the exact v1 profile — an untrusted blob must not be able to request
    // huge memory/iterations (OOM/hang on weak mobiles). New tuning ⇒ new version.
    if (e.v !== PIN_KDF_VERSION) throw new Error(`Unsupported PIN kdf version: ${e.v}`);
    const p = e.argon2;
    if (!p ||
        p.iterations !== ARGON2_PARAMS.iterations ||
        p.memorySize !== ARGON2_PARAMS.memorySize ||
        p.parallelism !== ARGON2_PARAMS.parallelism ||
        p.hashLength !== ARGON2_PARAMS.hashLength) {
      throw new Error('Argon2 params do not match the pinned v1 profile');
    }
  }
}

/** Encrypt raw BYTES with a PIN using Argon2id (current KDF). The string
 *  variants below are thin wrappers — one implementation, so the safebox
 *  verifier and the mnemonic blob can never drift apart. */
export async function encryptBytesWithPin(plaintext: Uint8Array, pin: string): Promise<PinEncryptedSeed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePinKeyArgon2(pin, salt, ARGON2_PARAMS);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, plaintext as BufferSource,
  );

  return {
    ciphertext: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv),
    salt: bufferToBase64(salt),
    kdf: 'argon2id',
    v: PIN_KDF_VERSION,
    argon2: ARGON2_PARAMS,
  };
}

/** Encrypt mnemonic with PIN using Argon2id (current KDF). */
export async function encryptWithPin(mnemonic: string, pin: string): Promise<PinEncryptedSeed> {
  return encryptBytesWithPin(new TextEncoder().encode(mnemonic), pin);
}

/** Which typed errors a PIN decrypt reports. The MAIN vault and the SAFEBOX
 *  have separate error classes (their attempt counters are separate), but the
 *  classification rule is ONE implementation — a copy could drift and start
 *  metering an environment failure as a wrong PIN. */
interface PinErrorFactory {
  wrong(): Error;
  unavailable(message: string): Error;
}
const MAIN_PIN_ERRORS: PinErrorFactory = {
  wrong: () => new WrongPinError(),
  unavailable: m => new PinUnlockUnavailableError(m),
};
const SAFEBOX_PIN_ERRORS: PinErrorFactory = {
  wrong: () => new SafeboxWrongPinError(),
  unavailable: m => new SafeboxPinUnavailableError(m),
};

async function decryptBytesWithPinInternal(
  encrypted: PinEncryptedSeed,
  pin: string,
  errors: PinErrorFactory,
): Promise<Uint8Array> {
  let salt: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array;
  try {
    assertValidPinBlob(encrypted);
    salt = base64ToBuffer(encrypted.salt);
    iv = base64ToBuffer(encrypted.iv);
    ciphertext = base64ToBuffer(encrypted.ciphertext);
  } catch (e) {
    throw errors.unavailable(e instanceof Error ? e.message : String(e));
  }

  let key: CryptoKey;
  try {
    key = encrypted.kdf === 'argon2id'
      ? await derivePinKeyArgon2(pin, salt, encrypted.argon2 ?? ARGON2_PARAMS)
      : await derivePinKeyPbkdf2(pin, salt);
  } catch (e) {
    // Argon2 WASM failed to load / ran out of memory / WebCrypto error — the
    // PIN was never actually checked.
    throw errors.unavailable(`KDF failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource,
    );
    return new Uint8Array(decrypted);
  } catch (e) {
    // GCM authentication failure surfaces as OperationError. It means either a
    // wrong PIN or a corrupted GCM tag — the two are cryptographically
    // indistinguishable (documented limitation), so OperationError is counted
    // as a wrong PIN. Any OTHER WebCrypto failure is an environment problem
    // and must never spend an attempt.
    if (isOperationError(e)) throw errors.wrong();
    throw errors.unavailable(`decrypt failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** WebCrypto reports a failed GCM tag as a DOMException named 'OperationError'.
 *  The NAME is the contract, not the class: when WebCrypto lives in another
 *  realm (Node's webcrypto under jsdom, an iframe) `instanceof DOMException`
 *  is false for the very same error — and misclassifying a wrong PIN as an
 *  environment failure would silently disable the attempt limiter. */
function isOperationError(e: unknown): boolean {
  return (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'OperationError')
    || (e instanceof Error && e.name === 'OperationError');
}

/** Decrypt raw BYTES with a PIN (main-vault error classes). */
export async function decryptBytesWithPin(encrypted: PinEncryptedSeed, pin: string): Promise<Uint8Array> {
  return decryptBytesWithPinInternal(encrypted, pin, MAIN_PIN_ERRORS);
}

/**
 * Decrypt mnemonic with PIN, dispatching on the blob's KDF. A missing `kdf`
 * field means a legacy PBKDF2-600k blob.
 *
 * Errors are TYPED so callers can meter the attempt limit correctly:
 *  - WrongPinError — GCM auth failure after a successful KDF (a wrong PIN);
 *  - PinUnlockUnavailableError — anything else (corrupt blob, unknown
 *    kdf/version/profile, KDF/WASM/memory failure). Never attempt-countable.
 */
export async function decryptWithPin(encrypted: PinEncryptedSeed, pin: string): Promise<string> {
  return new TextDecoder().decode(await decryptBytesWithPin(encrypted, pin));
}

// ─── Safebox PIN (separate contour — see the naming rule) ────────────

/** Wrong SAFEBOX PIN: a GCM OperationError AFTER the KDF ran. ONLY this may
 *  count against the safebox attempt limit / trigger the 10-strike wipe. */
export class SafeboxWrongPinError extends Error {
  constructor() {
    super('Wrong safebox PIN');
    this.name = 'SafeboxWrongPinError';
  }
}

/** The safebox PIN blob or the KDF runtime is unusable. NEVER attempt-countable
 *  — a correct PIN must not be wiped by 10 environment hiccups. Also raised for
 *  a malformed PIN CONFIG record (see storage.assertValidSafeboxPinConfig): a
 *  corrupted config may neither disable the lockout nor block seed recovery. */
export class SafeboxPinUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeboxPinUnavailableError';
  }
}

/** Digits only, 6..8 — enforced in the store AND the UI. */
export const SAFEBOX_PIN_MIN_LENGTH = 6;
export const SAFEBOX_PIN_MAX_LENGTH = 8;
export function isValidSafeboxPin(pin: string): boolean {
  return /^[0-9]+$/.test(pin)
    && pin.length >= SAFEBOX_PIN_MIN_LENGTH
    && pin.length <= SAFEBOX_PIN_MAX_LENGTH;
}

/** Bytes wrapped by the safebox PIN blob. NOT a key and NOT the mnemonic — a
 *  random verifier, so a successful offline brute force yields nothing but
 *  «the PIN was right» (see the disclosed oracle risk in security-guidance). */
const SAFEBOX_VERIFIER_BYTES = 32;

/** Fresh verifier + blob for a new/replaced safebox PIN. */
export async function createSafeboxPinBlob(pin: string): Promise<PinEncryptedSeed> {
  const verifier = crypto.getRandomValues(new Uint8Array(SAFEBOX_VERIFIER_BYTES));
  return encryptBytesWithPin(verifier, pin);
}

/**
 * Check a safebox PIN against its blob. Resolves on success; throws
 * SafeboxWrongPinError (attempt-countable) or SafeboxPinUnavailableError
 * (never countable). A blob that decrypts to the wrong verifier LENGTH is a
 * storage problem, not a wrong PIN.
 */
export async function verifySafeboxPin(encrypted: PinEncryptedSeed, pin: string): Promise<void> {
  const verifier = await decryptBytesWithPinInternal(encrypted, pin, SAFEBOX_PIN_ERRORS);
  if (verifier.byteLength !== SAFEBOX_VERIFIER_BYTES) {
    throw new SafeboxPinUnavailableError('Malformed safebox verifier');
  }
}
