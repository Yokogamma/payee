/**
 * Eternal Notes — Core Crypto Module
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
  /** Unique ID (crypto.randomUUID). Primary key in IndexedDB and Arweave tag. */
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
   * ciphertext is an encrypted envelope {v,id,t,text}, so id/date are
   * authenticated by the GCM tag and never exposed on-chain.
   */
  v?: 1 | 2;
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

export interface NoteData {
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
  const seed = mnemonicToSeedSync(mnemonic);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed.slice(0, 32),
    'HKDF',
    false,
    ['deriveKey']
  );

  const salt = new TextEncoder().encode('eternal-notes-v1');
  const info = new TextEncoder().encode('aes-256-gcm-encryption');

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
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
      salt: new TextEncoder().encode('eternal-notes-v1'),
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
 * Encrypt a note as a v2 envelope: the whole {v,id,t,text} object is encrypted,
 * so the note id and timestamp are authenticated by the GCM tag and never appear
 * in cleartext on-chain. Not yet wired into the write path (reader-before-writer
 * rollout) — v2 is accepted for reading first, then writes flip over.
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

/**
 * Decrypt a note to its text AND authoritative timestamp, dispatching on version.
 * - v1 (absent/1): ciphertext IS the text; createdAt comes from the record.
 * - v2: ciphertext is an envelope; validate it, cross-check the inner id against
 *   the record's noteId (defeats swapping ciphertext under a forged outer id),
 *   and take the timestamp from the (authenticated) envelope.
 * Throws if decryption fails or the envelope is inconsistent.
 */
export async function decryptNote(
  key: CryptoKey,
  encrypted: EncryptedNote
): Promise<{ text: string; createdAt: number }> {
  const raw = await aesDecrypt(key, encrypted);

  if (encrypted.v === 2) {
    const env = JSON.parse(raw) as NoteEnvelopeV2;
    if (
      env.v !== 2 ||
      typeof env.text !== 'string' ||
      typeof env.id !== 'string' ||
      typeof env.t !== 'number' ||
      env.id !== encrypted.noteId
    ) {
      throw new Error('v2 envelope integrity check failed');
    }
    return { text: env.text, createdAt: env.t };
  }

  return { text: raw, createdAt: encrypted.createdAt };
}

/** Decrypt a note to its text only (v1 or v2). Throws on failure/tamper. */
export async function decrypt(
  key: CryptoKey,
  encrypted: EncryptedNote
): Promise<string> {
  return (await decryptNote(key, encrypted)).text;
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

/**
 * Validate a stored PIN blob BEFORE running the KDF. A corrupted/hostile blob
 * must not be able to drive Argon2 into an OOM/hang via huge params, and an
 * unknown kdf must fail loudly (not silently fall back to PBKDF2).
 */
function assertValidPinBlob(e: PinEncryptedSeed): void {
  if (typeof e.ciphertext !== 'string' || e.ciphertext.length === 0 ||
      typeof e.iv !== 'string' || typeof e.salt !== 'string') {
    throw new Error('Malformed PIN blob');
  }
  if (base64ToBuffer(e.iv).length !== 12) throw new Error('Malformed PIN blob: iv');
  if (base64ToBuffer(e.salt).length !== 16) throw new Error('Malformed PIN blob: salt');

  if (e.kdf !== undefined && e.kdf !== 'pbkdf2' && e.kdf !== 'argon2id') {
    throw new Error(`Unknown PIN kdf: ${e.kdf}`);
  }
  if (e.kdf === 'argon2id') {
    const p = e.argon2;
    if (!p ||
        !(p.iterations >= 1 && p.iterations <= 10) ||
        !(p.memorySize >= 8_192 && p.memorySize <= 262_144) ||   // 8 MiB … 256 MiB
        !(p.parallelism >= 1 && p.parallelism <= 4) ||
        p.hashLength !== 32) {
      throw new Error('Argon2 params out of allowed range');
    }
  }
}

/** Encrypt mnemonic with PIN using Argon2id (current KDF). */
export async function encryptWithPin(mnemonic: string, pin: string): Promise<PinEncryptedSeed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePinKeyArgon2(pin, salt, ARGON2_PARAMS);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic),
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

/**
 * Decrypt mnemonic with PIN, dispatching on the blob's KDF. Throws on wrong PIN
 * (GCM auth failure). A missing `kdf` field means a legacy PBKDF2-600k blob.
 */
export async function decryptWithPin(encrypted: PinEncryptedSeed, pin: string): Promise<string> {
  assertValidPinBlob(encrypted);

  const salt = base64ToBuffer(encrypted.salt);
  const iv = base64ToBuffer(encrypted.iv);
  const ciphertext = base64ToBuffer(encrypted.ciphertext);

  const key = encrypted.kdf === 'argon2id'
    ? await derivePinKeyArgon2(pin, salt, encrypted.argon2 ?? ARGON2_PARAMS)
    : await derivePinKeyPbkdf2(pin, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource,
  );

  return new TextDecoder().decode(decrypted);
}
