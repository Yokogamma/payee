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
  WrongPinError,
  PinUnlockUnavailableError,
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

  it('fails to unwrap with the wrong PIN — typed WrongPinError (attempt-countable)', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    await expect(decryptWithPin(blob, '999999')).rejects.toBeInstanceOf(WrongPinError);
  });

  it('classifies a corrupted blob as PinUnlockUnavailableError (NOT attempt-countable)', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    // Correct PIN + broken salt: the environment failed, not the user.
    const corrupt = { ...blob, salt: '###not-base64###' };
    await expect(decryptWithPin(corrupt, '123456')).rejects.toBeInstanceOf(PinUnlockUnavailableError);
  });

  it('classifies a ciphertext shorter than the GCM tag as unavailable, not a wrong PIN', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    const truncated = { ...blob, ciphertext: bufferToBase64(new Uint8Array(8)) }; // < 16-byte tag
    await expect(decryptWithPin(truncated, '123456')).rejects.toBeInstanceOf(PinUnlockUnavailableError);
  });

  it('classifies unknown kdf / bad profile / bad version as PinUnlockUnavailableError', async () => {
    const blob = await encryptWithPin(generateMnemonic(), '123456');
    await expect(decryptWithPin({ ...blob, kdf: 'scrypt' as never }, '123456'))
      .rejects.toBeInstanceOf(PinUnlockUnavailableError);
    await expect(decryptWithPin({ ...blob, v: 99 }, '123456'))
      .rejects.toBeInstanceOf(PinUnlockUnavailableError);
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

// ─── v3 envelope (version chains) ────────────────────────────────────

import { encryptEnvelopeV3, randomUuidV8, UnsupportedNoteVersionError, type EncryptedNote } from './crypto';

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomUuidV8', () => {
  it('produces version-8 RFC-variant UUIDs, unique across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = randomUuidV8();
      expect(id).toMatch(UUID_V8);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});

describe('v3 envelope', () => {
  it('round-trips text + meta for a rev-1 root (root defaults to own id)', async () => {
    const key = await deriveKey(generateMnemonic());
    const enc = await encryptEnvelopeV3(key, '# заголовок', { fmt: 'md', rev: 1 });
    expect(enc.v).toBe(3);
    expect(enc.noteId).toMatch(UUID_V8);

    const dec = await decryptNote(key, enc);
    expect(dec.text).toBe('# заголовок');
    expect(dec.createdAt).toBe(enc.createdAt);
    expect(dec.meta).toEqual({ fmt: 'md', rev: 1, root: enc.noteId });
  });

  it('round-trips a rev-2 version with explicit root/prev and fmt plain', async () => {
    const key = await deriveKey(generateMnemonic());
    const root = crypto.randomUUID(); // a legacy v4 chain root
    const prev = root;
    const enc = await encryptEnvelopeV3(key, 'v *literal stars*', { fmt: 'plain', rev: 2, root, prev });
    const dec = await decryptNote(key, enc);
    expect(dec.meta).toEqual({ fmt: 'plain', rev: 2, root, prev });
  });

  it('preserves leading/trailing whitespace (no trim in the crypto layer)', async () => {
    const key = await deriveKey(generateMnemonic());
    const text = '    indented code\n\n';
    const enc = await encryptEnvelopeV3(key, text, { fmt: 'md', rev: 1 });
    expect((await decryptNote(key, enc)).text).toBe(text);
  });
});

describe('v3 envelope validation (fail closed)', () => {
  async function forgeV3(envelope: Record<string, unknown>, outerNoteId?: string): Promise<{ key: CryptoKey; enc: EncryptedNote }> {
    const key = await deriveKey(generateMnemonic());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)));
    return {
      key,
      enc: {
        noteId: outerNoteId ?? (envelope.id as string),
        ciphertext: bufferToBase64(ct),
        iv: bufferToBase64(iv),
        createdAt: Date.now(),
        v: 3,
      },
    };
  }

  function baseEnv(): Record<string, unknown> {
    const id = randomUuidV8();
    return { v: 3, id, t: Date.now(), text: 'x', fmt: 'md', rev: 1, root: id };
  }

  const cases: Array<[string, (e: Record<string, unknown>) => void]> = [
    ['inner id mismatch vs outer noteId', () => { /* outer overridden below */ }],
    ['rev 0', e => { e.rev = 0; }],
    ['negative rev', e => { e.rev = -1; }],
    ['fractional rev', e => { e.rev = 1.5; }],
    ['unsafe-integer rev', e => { e.rev = Number.MAX_SAFE_INTEGER + 2; }],
    ['bad fmt', e => { e.fmt = 'html'; }],
    ['missing text', e => { delete e.text; }],
    ['non-string text', e => { e.text = 42; }],
    ['negative t', e => { e.t = -5; }],
    ['t beyond Date range', e => { e.t = 8_640_000_000_000_001; }],
    ['non-number t', e => { e.t = 'now'; }],
    ['non-UUID root', e => { e.root = 'not-a-uuid'; }],
    ['non-UUID prev', e => { e.rev = 2; e.prev = 'nope'; e.root = crypto.randomUUID(); }],
    ['rev 1 with prev', e => { e.prev = crypto.randomUUID(); }],
    ['rev 1 with foreign root', e => { e.root = crypto.randomUUID(); }],
    ['rev 2 without prev', e => { e.rev = 2; e.root = crypto.randomUUID(); }],
    ['rev 2 self-root', e => { e.rev = 2; e.prev = crypto.randomUUID(); }],
    ['rev 2 self-prev', e => { e.rev = 2; e.root = crypto.randomUUID(); e.prev = e.id; }],
    ['v4 id in a v3 envelope (namespace)', e => { const id = crypto.randomUUID(); e.id = id; e.root = id; }],
  ];

  for (const [name, mutate] of cases) {
    it(`rejects ${name}`, async () => {
      const env = baseEnv();
      mutate(env);
      const outer = name === 'inner id mismatch vs outer noteId' ? randomUuidV8() : undefined;
      const { key, enc } = await forgeV3(env, outer);
      await expect(decryptNote(key, enc)).rejects.toThrow(/integrity check failed/);
    });
  }
});

describe('unknown version dispatch (fail closed)', () => {
  it('rejects an unknown v instead of falling back to the v1 raw-text path', async () => {
    const key = await deriveKey(generateMnemonic());
    const enc = await encrypt(key, 'text');
    const forged = { ...enc, v: 4 } as unknown as EncryptedNote;
    await expect(decryptNote(key, forged)).rejects.toThrow(UnsupportedNoteVersionError);
    const forgedStr = { ...enc, v: '3' } as unknown as EncryptedNote;
    await expect(decryptNote(key, forgedStr)).rejects.toThrow(UnsupportedNoteVersionError);
  });
});

describe('synthesized meta + shared validators for legacy versions', () => {
  it('synthesizes plain/rev1/root=noteId for v1 and v2', async () => {
    const key = await deriveKey(generateMnemonic());
    const v1 = await encrypt(key, 'a');
    expect((await decryptNote(key, v1)).meta).toEqual({ fmt: 'plain', rev: 1, root: v1.noteId });
    const v2 = await encryptEnvelope(key, 'b');
    expect((await decryptNote(key, v2)).meta).toEqual({ fmt: 'plain', rev: 1, root: v2.noteId });
  });

  it('rejects a v1 record with a non-UUIDv4 noteId or out-of-range createdAt', async () => {
    const key = await deriveKey(generateMnemonic());
    const enc = await encrypt(key, 'a');
    await expect(decryptNote(key, { ...enc, noteId: 'garbage' })).rejects.toThrow(/noteId/);
    await expect(decryptNote(key, { ...enc, noteId: randomUuidV8() })).rejects.toThrow(/noteId/);
    await expect(decryptNote(key, { ...enc, createdAt: -1 })).rejects.toThrow(/createdAt/);
    await expect(decryptNote(key, { ...enc, createdAt: Number.NaN })).rejects.toThrow(/createdAt/);
  });

  it('rejects a v2 record whose inner id is not a UUIDv4', async () => {
    const key = await deriveKey(generateMnemonic());
    const badId = randomUuidV8();
    const envelope = { v: 2, id: badId, t: Date.now(), text: 'x' };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)));
    const enc: EncryptedNote = {
      noteId: badId, ciphertext: bufferToBase64(ct), iv: bufferToBase64(iv), createdAt: Date.now(), v: 2,
    };
    await expect(decryptNote(key, enc)).rejects.toThrow(/v2 envelope/);
  });
});
