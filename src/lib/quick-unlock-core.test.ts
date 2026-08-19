import { describe, it, expect, afterEach } from 'vitest';
import {
  detectQuickUnlockCapability,
  deriveQuickUnlockKek,
  wrapWithKek,
  unwrapWithKek,
  createPrfCredential,
  evalPrf,
  QuickUnlockUnavailableError,
  QuickUnlockKeyMismatchError,
  QuickUnlockCancelledError,
  QuickUnlockNotCompletedError,
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

// ─── Ceremonies (fake navigator.credentials) ─────────────────────────
//
// jsdom has no `navigator.credentials` at all, so the whole surface is stubbed.
// The fake returns DIFFERENT bytes on create and on get — that is what proves
// WHICH output actually ends up wrapping the seed.

const CREATE_PRF = new Uint8Array(32).fill(0xc1);
const GET_PRF = new Uint8Array(32).fill(0x67);
const CRED_ID = new Uint8Array(32).fill(0x1d);

type ExtResults = { prf?: { enabled?: boolean; results?: { first?: Uint8Array } } };

interface FakeOptions {
  createExt?: ExtResults;
  getExt?: ExtResults;
  createRejects?: Error;
  getRejects?: Error;
  createReturnsNull?: boolean;
  getReturnsNull?: boolean;
}

const globalWithNav = globalThis as { navigator?: unknown; location?: unknown };

function stubCredentials(opts: FakeOptions = {}) {
  const createCalls: unknown[] = [];
  const getCalls: unknown[] = [];
  const credential = (ext: ExtResults) => ({
    rawId: CRED_ID.slice().buffer,
    getClientExtensionResults: () => ext,
  });

  globalWithNav.location = { hostname: 'notes.matamata.dev' };
  globalWithNav.navigator = {
    credentials: {
      create: async (o: unknown) => {
        createCalls.push(o);
        if (opts.createRejects) throw opts.createRejects;
        if (opts.createReturnsNull) return null;
        return credential(opts.createExt ?? { prf: { enabled: true, results: { first: CREATE_PRF } } });
      },
      get: async (o: unknown) => {
        getCalls.push(o);
        if (opts.getRejects) throw opts.getRejects;
        if (opts.getReturnsNull) return null;
        return credential(opts.getExt ?? { prf: { enabled: true, results: { first: GET_PRF } } });
      },
    },
  };
  return { createCalls, getCalls };
}

function publicKeyOf(call: unknown): Record<string, unknown> {
  return (call as { publicKey: Record<string, unknown> }).publicKey;
}

const named = (name: string) => Object.assign(new Error(name), { name });

afterEach(() => {
  delete globalWithNav.navigator;
  delete globalWithNav.location;
});

describe('createPrfCredential', () => {
  const prfSalt = bytes(32, 2);

  it('wraps with the CONTROL get() output, not the create() one', async () => {
    stubCredentials();
    const result = await createPrfCredential({ prfSalt });
    // The blob must be openable by the very path every unlock will take.
    expect(Array.from(result.prfOutput)).toEqual(Array.from(GET_PRF));
    expect(Array.from(result.prfOutput)).not.toEqual(Array.from(CREATE_PRF));
    expect(Array.from(result.credentialId)).toEqual(Array.from(CRED_ID));
  });

  it('ALWAYS performs the control get()', async () => {
    const { getCalls } = stubCredentials();
    await createPrfCredential({ prfSalt });
    expect(getCalls).toHaveLength(1);
  });

  it('both ceremonies carry userVerification: required (v1 invariant)', async () => {
    const { createCalls, getCalls } = stubCredentials();
    await createPrfCredential({ prfSalt });
    expect((publicKeyOf(createCalls[0]).authenticatorSelection as Record<string, unknown>).userVerification)
      .toBe('required');
    expect(publicKeyOf(getCalls[0]).userVerification).toBe('required');
  });

  it('sends a CONSTANT user name — no mnemonic, no pk, nothing derived from them', async () => {
    const { createCalls } = stubCredentials();
    await createPrfCredential({ prfSalt });
    const user = publicKeyOf(createCalls[0]).user as Record<string, unknown>;
    expect(user.name).toBe('Matamata Notes');
    expect(user.displayName).toBe('Matamata Notes');
    const serialized = JSON.stringify(createCalls[0], (_k, v) =>
      v instanceof Uint8Array ? Array.from(v) : v);
    for (const word of MN.split(' ')) expect(serialized).not.toContain(word);
  });

  it('asks for a platform authenticator and a discouraged resident key', async () => {
    const { createCalls } = stubCredentials();
    await createPrfCredential({ prfSalt });
    const sel = publicKeyOf(createCalls[0]).authenticatorSelection as Record<string, unknown>;
    expect(sel.authenticatorAttachment).toBe('platform');
    // 'preferred', not 'discouraged': the providers that implement hmac-secret
    // are the ones storing DISCOVERABLE passkeys, and a non-discoverable
    // credential is what an Android device handed back with no PRF at all.
    // Not 'required' either — a platform that can only do non-discoverable
    // should still get its chance instead of a flat refusal.
    expect(sel.residentKey).toBe('preferred');
    expect(publicKeyOf(createCalls[0]).attestation).toBe('none');
  });

  it('refuses BEFORE the second prompt when create reports no PRF at all', async () => {
    const { getCalls } = stubCredentials({ createExt: { prf: { enabled: false } } });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    expect(getCalls).toHaveLength(0); // the user is not shown a pointless sheet
  });

  it('accepts enabled:true even when create returns no results — get decides', async () => {
    stubCredentials({ createExt: { prf: { enabled: true } } });
    const result = await createPrfCredential({ prfSalt });
    expect(Array.from(result.prfOutput)).toEqual(Array.from(GET_PRF));
  });

  it('enabled:true but the control get() returns NOTHING → unavailable, no blob', async () => {
    stubCredentials({ createExt: { prf: { enabled: true } }, getExt: { prf: { enabled: true } } });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });

  it('NotAllowedError becomes NotCompleted (cancel / timeout / gone are one outcome)', async () => {
    stubCredentials({ createRejects: named('NotAllowedError') });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockNotCompletedError);
  });

  it('OUR abort becomes Cancelled — the only silent outcome', async () => {
    stubCredentials({ createRejects: named('AbortError') });
    const controller = new AbortController();
    controller.abort();
    await expect(createPrfCredential({ prfSalt, signal: controller.signal }))
      .rejects.toBeInstanceOf(QuickUnlockCancelledError);
  });

  it('an already-aborted signal never opens a sheet at all', async () => {
    const { createCalls } = stubCredentials();
    const controller = new AbortController();
    controller.abort();
    await expect(createPrfCredential({ prfSalt, signal: controller.signal }))
      .rejects.toBeInstanceOf(QuickUnlockCancelledError);
    expect(createCalls).toHaveLength(0);
  });

  it('any other DOM error becomes Unavailable', async () => {
    stubCredentials({ createRejects: named('NotSupportedError') });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });

  it('a BARE AbortError (not ours) is Unavailable, NOT a silent cancel', async () => {
    // «Cancelled» is the one outcome that shows the user nothing. Claiming it
    // for an abort we did not issue would hide a real failure behind a screen
    // that says nothing at all.
    stubCredentials({ createRejects: named('AbortError') });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });

  it('classifies a CROSS-REALM rejection by name, not by instanceof', async () => {
    // A WebAuthn error arriving from another realm is not an instance of THIS
    // realm's Error — matching on the class would misfile it as Unavailable.
    stubCredentials({ createRejects: { name: 'NotAllowedError', message: 'denied' } as unknown as Error });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockNotCompletedError);
  });

  it('a null credential is Unavailable, not a crash', async () => {
    stubCredentials({ createReturnsNull: true });
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });

  it('no WebAuthn API at all is Unavailable', async () => {
    globalWithNav.navigator = {};
    await expect(createPrfCredential({ prfSalt })).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });
});

describe('evalPrf', () => {
  const prfSalt = bytes(32, 2);

  it('returns the PRF output and pins transports to internal', async () => {
    const { getCalls } = stubCredentials();
    const out = await evalPrf({ credentialId: CRED_ID, prfSalt });
    expect(Array.from(out)).toEqual(Array.from(GET_PRF));
    const allow = publicKeyOf(getCalls[0]).allowCredentials as Array<Record<string, unknown>>;
    expect(allow).toHaveLength(1);
    expect(allow[0].transports).toEqual(['internal']);
    expect(Array.from(allow[0].id as Uint8Array)).toEqual(Array.from(CRED_ID));
  });

  it('passes the salt through the prf extension', async () => {
    const { getCalls } = stubCredentials();
    await evalPrf({ credentialId: CRED_ID, prfSalt });
    const ext = publicKeyOf(getCalls[0]).extensions as { prf: { eval: { first: Uint8Array } } };
    expect(Array.from(ext.prf.eval.first)).toEqual(Array.from(prfSalt));
  });

  it('a missing PRF output is UNAVAILABLE — never a key mismatch', async () => {
    // Nothing was decrypted, so nothing may be concluded about the record.
    stubCredentials({ getExt: { prf: { enabled: true } } });
    await expect(evalPrf({ credentialId: CRED_ID, prfSalt }))
      .rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });

  it('NotAllowedError becomes NotCompleted', async () => {
    stubCredentials({ getRejects: named('NotAllowedError') });
    await expect(evalPrf({ credentialId: CRED_ID, prfSalt }))
      .rejects.toBeInstanceOf(QuickUnlockNotCompletedError);
  });

  it('our abort wins the classification over whatever the platform raised', async () => {
    const controller = new AbortController();
    stubCredentials({ getRejects: named('NotAllowedError') });
    controller.abort();
    await expect(evalPrf({ credentialId: CRED_ID, prfSalt, signal: controller.signal }))
      .rejects.toBeInstanceOf(QuickUnlockCancelledError);
  });

  it('a null assertion is Unavailable', async () => {
    stubCredentials({ getReturnsNull: true });
    await expect(evalPrf({ credentialId: CRED_ID, prfSalt }))
      .rejects.toBeInstanceOf(QuickUnlockUnavailableError);
  });
});
