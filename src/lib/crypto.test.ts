import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  isValidMnemonic,
  deriveKey,
  deriveSigningKeypair,
  deriveOwnerHash,
  encrypt,
  encryptEnvelope,
  decrypt,
  decryptNote,
  encryptWithPin,
  decryptWithPin,
  isPinKdfLegacy,
  bufferToBase64,
  type PinEncryptedSeed,
} from './crypto';

// Phase 0 smoke tests — pin down current crypto behavior before Phase 1/3 changes.

describe('mnemonic', () => {
  it('generates a valid 12-word mnemonic', () => {
    const mn = generateMnemonic();
    expect(mn.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(mn)).toBe(true);
  });

  it('rejects an invalid mnemonic', () => {
    expect(isValidMnemonic('not a real seed phrase at all here now')).toBe(false);
  });
});

describe('key derivation', () => {
  it('is deterministic for the same mnemonic', async () => {
    const mn = generateMnemonic();
    const k1 = await deriveKey(mn);
    const k2 = await deriveKey(mn);
    const a = await encrypt(k1, 'hello');
    const text = await decrypt(k2, a);
    expect(text).toBe('hello');
  });

  it('derives a stable signing keypair and owner hash', async () => {
    const mn = generateMnemonic();
    const kp1 = await deriveSigningKeypair(mn);
    const kp2 = await deriveSigningKeypair(mn);
    expect(bufferToBase64(kp1.publicKey)).toBe(bufferToBase64(kp2.publicKey));
    const oh = await deriveOwnerHash(kp1.publicKey);
    expect(typeof oh).toBe('string');
    expect(oh.length).toBeGreaterThan(0);
  });
});

describe('encrypt/decrypt', () => {
  it('round-trips plaintext', async () => {
    const key = await deriveKey(generateMnemonic());
    const enc = await encrypt(key, 'секретная заметка');
    expect(enc.noteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await decrypt(key, enc)).toBe('секретная заметка');
  });

  it('uses a unique IV per encryption', async () => {
    const key = await deriveKey(generateMnemonic());
    const a = await encrypt(key, 'x');
    const b = await encrypt(key, 'x');
    expect(a.iv).not.toBe(b.iv);
  });

  it('fails to decrypt with the wrong key', async () => {
    const enc = await encrypt(await deriveKey(generateMnemonic()), 'x');
    const other = await deriveKey(generateMnemonic());
    await expect(decrypt(other, enc)).rejects.toBeDefined();
  });
});

describe('v2 envelope', () => {
  it('round-trips text through an encrypted envelope', async () => {
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'envelope secret');
    expect(note.v).toBe(2);
    expect(await decrypt(key, note)).toBe('envelope secret');
  });

  it('exposes the timestamp from inside the envelope, not from the record', async () => {
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'x');
    // Corrupt the outer createdAt — decryptNote must ignore it for v2.
    const decoded = await decryptNote(key, { ...note, createdAt: 0 });
    expect(decoded.text).toBe('x');
    expect(decoded.createdAt).toBe(note.createdAt);
  });

  it('rejects a v2 record whose outer noteId was swapped', async () => {
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'x');
    // Same ciphertext, forged outer noteId → inner id mismatch → reject.
    await expect(decrypt(key, { ...note, noteId: 'forged-id' })).rejects.toThrow(/envelope integrity/);
  });

  it('fails to decrypt a v2 envelope with the wrong key', async () => {
    const note = await encryptEnvelope(await deriveKey(generateMnemonic()), 'x');
    await expect(decrypt(await deriveKey(generateMnemonic()), note)).rejects.toBeDefined();
  });
});

// Build a legacy (PBKDF2-600k, no `kdf` field) blob the way the old code did.
async function makeLegacyPinBlob(mnemonic: string, pin: string): Promise<PinEncryptedSeed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic));
  return { ciphertext: bufferToBase64(ct), iv: bufferToBase64(iv), salt: bufferToBase64(salt) }; // no kdf
}

describe('PIN wrapping', () => {
  it('round-trips the mnemonic through an Argon2id PIN', async () => {
    const mn = generateMnemonic();
    const blob = await encryptWithPin(mn, '123456');
    expect(blob.kdf).toBe('argon2id');
    expect(isPinKdfLegacy(blob)).toBe(false);
    expect(await decryptWithPin(blob, '123456')).toBe(mn);
  });

  it('fails to unwrap with the wrong PIN', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    await expect(decryptWithPin(blob, '999999')).rejects.toBeDefined();
  });

  it('still reads a legacy PBKDF2 blob (no kdf field) and flags it for rewrap', async () => {
    const mn = generateMnemonic();
    const legacy = await makeLegacyPinBlob(mn, '1234');
    expect(isPinKdfLegacy(legacy)).toBe(true);
    expect(await decryptWithPin(legacy, '1234')).toBe(mn);
  });

  it('rejects an unknown kdf instead of silently falling back to PBKDF2', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    const hostile = { ...blob, kdf: 'scrypt' as unknown as PinEncryptedSeed['kdf'] };
    await expect(decryptWithPin(hostile, '123456')).rejects.toThrow(/Unknown PIN kdf/);
  });

  it('rejects Argon2 params that deviate from the pinned v1 profile (OOM guard)', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    const hostile = { ...blob, argon2: { ...blob.argon2!, memorySize: 4_000_000_000 } };
    await expect(decryptWithPin(hostile, '123456')).rejects.toThrow(/pinned v1 profile/);
  });

  it('rejects an unknown PIN kdf version', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    const hostile = { ...blob, v: 99 };
    await expect(decryptWithPin(hostile, '123456')).rejects.toThrow(/version/);
  });
});
