/**
 * Eternal Notes — Core Crypto Module
 *
 * Всё шифрование на клиенте. Ключ никогда не покидает устройство.
 *
 * Flow:
 *   generateMnemonic() → 12 слов
 *   deriveKey(mnemonic) → CryptoKey (AES-256-GCM)
 *   encrypt(key, plaintext) → { ciphertext, iv, salt }
 *   decrypt(key, encrypted) → plaintext
 *
 * Восстановление:
 *   Ввёл 12 слов → deriveKey() → тот же ключ → расшифровка всех заметок
 */

import { generateMnemonic as genMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface EncryptedNote {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (unique per note) */
  iv: string;
  /** Timestamp of creation */
  createdAt: number;
  /** SHA-256 hash of plaintext (for deduplication/integrity) */
  hash: string;
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
  // BIP-39: mnemonic → 64-byte seed
  const seed = mnemonicToSeedSync(mnemonic);

  // Import the first 32 bytes as raw key material for HKDF
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    seed.slice(0, 32),
    'HKDF',
    false,
    ['deriveKey']
  );

  // HKDF: derive AES-256-GCM key
  // Salt and info are fixed — deterministic derivation from the same seed
  const salt = new TextEncoder().encode('eternal-notes-v1');
  const info = new TextEncoder().encode('aes-256-gcm-encryption');

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable — key never leaves CryptoKey object
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive a deterministic "owner hash" from a mnemonic.
 * Used as a public identifier on Arweave to find all notes by this user.
 * Does NOT reveal the mnemonic or encryption key.
 */
export async function deriveOwnerHash(mnemonic: string): Promise<string> {
  const seed = mnemonicToSeedSync(mnemonic);
  // Use the second half of the seed (bytes 32-64) for owner hash
  // This ensures owner hash is independent from encryption key
  const hashBuffer = await crypto.subtle.digest('SHA-256', seed.slice(32, 64));
  return bufferToBase64(hashBuffer);
}

// ─── Encryption / Decryption ─────────────────────────────────────────

/**
 * Encrypt a plaintext note with AES-256-GCM.
 *
 * Each note gets a unique random IV (12 bytes).
 * Returns base64-encoded ciphertext + IV.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: string
): Promise<EncryptedNote> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Random 12-byte IV — MUST be unique per encryption
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // AES-256-GCM encryption
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // SHA-256 hash of plaintext (for integrity/dedup)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    createdAt: Date.now(),
    hash: bufferToBase64(hashBuffer),
  };
}

/**
 * Decrypt an encrypted note back to plaintext.
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

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Storage (local cache) ───────────────────────────────────────────

const STORAGE_KEY = 'eternal-notes-encrypted';
const MNEMONIC_CHECK_KEY = 'eternal-notes-init';

/**
 * Save encrypted notes to local storage (cache for offline/fast access)
 */
export function saveToLocal(notes: EncryptedNote[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

/**
 * Load encrypted notes from local storage
 */
export function loadFromLocal(): EncryptedNote[] {
  const data = localStorage.getItem(STORAGE_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Check if app is initialized (has a mnemonic set up)
 */
export function isInitialized(): boolean {
  return localStorage.getItem(MNEMONIC_CHECK_KEY) === 'true';
}

/**
 * Mark app as initialized
 */
export function markInitialized(): void {
  localStorage.setItem(MNEMONIC_CHECK_KEY, 'true');
}

/**
 * Clear all local data (for testing/reset)
 */
export function clearLocal(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(MNEMONIC_CHECK_KEY);
}
