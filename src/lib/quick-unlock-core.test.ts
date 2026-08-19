import { describe, it, expect, afterEach } from 'vitest';
import {
  detectQuickUnlockCapability,
  deriveQuickUnlockKek,
  wrapWithKek,
  unwrapWithKek,
  QuickUnlockUnavailableError,
  QuickUnlockKeyMismatchError,
  QUICK_UNLOCK_VAULT_INFO,
} from './quick-unlock-core';

// Core tests run in the NODE environment on purpose: the module must be usable
// without a DOM. That is a convenience, NOT the proof of the layering — the
// boundary is held by the ESLint rule (a module can import storage and still
// load fine under Node without executing a browser branch).

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function rawKey(key: CryptoKey): Promise<string> {
  // The derived key is non-extractable by design, so compare by BEHAVIOUR:
  // encrypt a fixed plaintext under a fixed IV and look at the ciphertext.
  const iv = bytes(12, 7);
  return Array.from(await wrapWithKek(key, iv, 'probe')).join(',');
}

// ─── HKDF derivation ─────────────────────────────────────────────────

describe('deriveQuickUnlockKek', () => {
  it('is deterministic for the same PRF output, salt and info', async () => {
    const prf = bytes(32, 1);
    const salt = bytes(32, 2);
    const a = await deriveQuickUnlockKek(prf, salt, QUICK_UNLOCK_VAULT_INFO);
    const b = await deriveQuickUnlockKek(prf, salt, QUICK_UNLOCK_VAULT_INFO);
    expect(await rawKey(a)).toBe(await rawKey(b));
  });

  it('a different hkdfSalt yields a different key', async () => {
    const prf = bytes(32, 1);
    const a = await deriveQuickUnlockKek(prf, bytes(32, 2), QUICK_UNLOCK_VAULT_INFO);
    const b = await deriveQuickUnlockKek(prf, bytes(32, 3), QUICK_UNLOCK_VAULT_INFO);
    expect(await rawKey(a)).not.toBe(await rawKey(b));
  });

  it('a different PRF output yields a different key', async () => {
    const salt = bytes(32, 2);
    const a = await deriveQuickUnlockKek(bytes(32, 1), salt, QUICK_UNLOCK_VAULT_INFO);
    const b = await deriveQuickUnlockKek(bytes(32, 9), salt, QUICK_UNLOCK_VAULT_INFO);
    expect(await rawKey(a)).not.toBe(await rawKey(b));
  });

  it('`info` PARTICIPATES — this is what separates future contours', async () => {
    const prf = bytes(32, 1);
    const salt = bytes(32, 2);
    const vault = await deriveQuickUnlockKek(prf, salt, QUICK_UNLOCK_VAULT_INFO);
    const other = await deriveQuickUnlockKek(prf, salt, 'eternal-notes-quick-unlock-safebox-v1');
    expect(await rawKey(vault)).not.toBe(await rawKey(other));
  });

  it('the pinned v1 info string is exactly the documented one', () => {
    // Changing it orphans every stored record — it must move only together
    // with the record `v`, which makes it worth an explicit assertion.
    expect(QUICK_UNLOCK_VAULT_INFO).toBe('eternal-notes-quick-unlock-v1');
  });

  it('an importKey/deriveBits failure is UNAVAILABLE, never a key mismatch', async () => {
    // OperationError out of the KDF does NOT prove a GCM tag mismatch: it is
    // an environment failure, and it must not be allowed to delete a record.
    const broken = new Proxy(crypto.subtle, {
      get(target, prop) {
        if (prop === 'importKey') {
          return () => Promise.reject(Object.assign(new Error('nope'), { name: 'OperationError' }));
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...crypto, subtle: broken, getRandomValues: crypto.getRandomValues.bind(crypto) },
    });
    try {
      await expect(deriveQuickUnlockKek(bytes(32, 1), bytes(32, 2), QUICK_UNLOCK_VAULT_INFO))
        .rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

// ─── Envelope ────────────────────────────────────────────────────────

describe('wrapWithKek / unwrapWithKek', () => {
  it('round-trips the mnemonic', async () => {
    const kek = await deriveQuickUnlockKek(randomBytes(32), randomBytes(32), QUICK_UNLOCK_VAULT_INFO);
    const iv = randomBytes(12);
    expect(await unwrapWithKek(kek, iv, await wrapWithKek(kek, iv, MN))).toBe(MN);
  });

  it('a DIFFERENT key is a KEY MISMATCH, not an environment failure', async () => {
    const iv = randomBytes(12);
    const salt = randomBytes(32);
    const good = await deriveQuickUnlockKek(bytes(32, 1), salt, QUICK_UNLOCK_VAULT_INFO);
    const other = await deriveQuickUnlockKek(bytes(32, 2), salt, QUICK_UNLOCK_VAULT_INFO);
    const blob = await wrapWithKek(good, iv, MN);
    await expect(unwrapWithKek(other, iv, blob)).rejects.toBeInstanceOf(QuickUnlockKeyMismatchError);
  });

  it('a corrupted GCM tag is a KEY MISMATCH too (indistinguishable by design)', async () => {
    const kek = await deriveQuickUnlockKek(randomBytes(32), randomBytes(32), QUICK_UNLOCK_VAULT_INFO);
    const iv = randomBytes(12);
    const blob = await wrapWithKek(kek, iv, MN);
    blob[blob.length - 1] ^= 0xff;
    await expect(unwrapWithKek(kek, iv, blob)).rejects.toBeInstanceOf(QuickUnlockKeyMismatchError);
  });

  it('a WRONG IV is a key mismatch as well — same GCM tag failure', async () => {
    const kek = await deriveQuickUnlockKek(randomBytes(32), randomBytes(32), QUICK_UNLOCK_VAULT_INFO);
    const blob = await wrapWithKek(kek, bytes(12, 1), MN);
    await expect(unwrapWithKek(kek, bytes(12, 2), blob)).rejects.toBeInstanceOf(QuickUnlockKeyMismatchError);
  });

  it('a NON-OperationError out of decrypt is UNAVAILABLE — the record survives', async () => {
    const kek = await deriveQuickUnlockKek(randomBytes(32), randomBytes(32), QUICK_UNLOCK_VAULT_INFO);
    const iv = randomBytes(12);
    const blob = await wrapWithKek(kek, iv, MN);
    const broken = new Proxy(crypto.subtle, {
      get(target, prop) {
        if (prop === 'decrypt') {
          return () => Promise.reject(Object.assign(new Error('gone'), { name: 'NotSupportedError' }));
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { ...crypto, subtle: broken, getRandomValues: crypto.getRandomValues.bind(crypto) },
    });
    try {
      await expect(unwrapWithKek(kek, iv, blob)).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

// ─── Capability detection ────────────────────────────────────────────

const globalWithWindow = globalThis as { window?: unknown };

function stubWindow(pkc: unknown): void {
  globalWithWindow.window = pkc === undefined ? {} : { PublicKeyCredential: pkc };
}

afterEach(() => { delete globalWithWindow.window; });

describe('detectQuickUnlockCapability', () => {
  it("returns 'no-api' with no window at all", async () => {
    expect(await detectQuickUnlockCapability()).toBe('no-api');
  });

  it("returns 'no-api' when PublicKeyCredential is absent", async () => {
    stubWindow(undefined);
    expect(await detectQuickUnlockCapability()).toBe('no-api');
  });

  it("returns 'no-platform' when isUVPAA says false", async () => {
    stubWindow({ isUserVerifyingPlatformAuthenticatorAvailable: async () => false });
    expect(await detectQuickUnlockCapability()).toBe('no-platform');
  });

  it("returns 'ready' when the client reports extension:prf", async () => {
    stubWindow({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      getClientCapabilities: async () => ({ 'extension:prf': true }),
    });
    expect(await detectQuickUnlockCapability()).toBe('ready');
  });

  it("returns 'no-prf' when the client explicitly denies it", async () => {
    stubWindow({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      getClientCapabilities: async () => ({ 'extension:prf': false }),
    });
    expect(await detectQuickUnlockCapability()).toBe('no-prf');
  });

  it("returns 'unknown' when getClientCapabilities is missing — the ceremony decides", async () => {
    stubWindow({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true });
    expect(await detectQuickUnlockCapability()).toBe('unknown');
  });

  it("returns 'unknown' when the capability map says nothing about PRF", async () => {
    stubWindow({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      getClientCapabilities: async () => ({ conditionalGet: true }),
    });
    expect(await detectQuickUnlockCapability()).toBe('unknown');
  });

  it("a REJECTING isUVPAA is 'unknown', not 'no-platform' — and never throws", async () => {
    stubWindow({ isUserVerifyingPlatformAuthenticatorAvailable: async () => { throw new Error('boom'); } });
    await expect(detectQuickUnlockCapability()).resolves.toBe('unknown');
  });

  it("a REJECTING getClientCapabilities is 'unknown' — and never throws", async () => {
    stubWindow({
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      getClientCapabilities: async () => { throw new Error('boom'); },
    });
    await expect(detectQuickUnlockCapability()).resolves.toBe('unknown');
  });
});
