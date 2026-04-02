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
  // No hash field. GCM auth tag inside ciphertext ensures integrity.
  // If decrypt succeeds — data is not corrupted.
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
 * Decrypt an encrypted note back to plaintext.
 * If decryption fails, the ciphertext was tampered with or wrong key used.
 */
export async function decrypt(
  key: CryptoKey,
  encrypted: EncryptedNote
): Promise<string> {
  const ciphertext = base64ToBuffer(encrypted.ciphertext);
  const iv = base64ToBuffer(encrypted.iv);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );

  return new TextDecoder().decode(decrypted);
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
