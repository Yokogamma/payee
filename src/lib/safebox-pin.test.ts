// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  createSafeboxPinBlob,
  verifySafeboxPin,
  isValidSafeboxPin,
  SafeboxWrongPinError,
  SafeboxPinUnavailableError,
  type PinEncryptedSeed,
} from './crypto';
import {
  initStorage,
  resetAll,
  setMeta,
  getMeta,
  saveSafeboxEntryWithSync,
  countSafeboxEntries,
  assertValidSafeboxPinConfig,
  readSafeboxPinConfig,
  hasSafeboxPinConfig,
  commitSafeboxPinWrite,
  commitSafeboxPinFailure,
  commitSafeboxPinSuccess,
  commitSafeboxPinDelete,
  commitSafeboxEntry,
  safeboxLockSeconds,
  SafeboxConfigChangedError,
  StorageResetError,
  getDbGeneration,
  SAFEBOX_PIN_META_KEY,
  SAFEBOX_MAX_PIN_ATTEMPTS,
  type SafeboxPinConfig,
} from './storage';
import type { EncryptedSafeboxEntry } from './crypto';

// §8 safebox-pin matrix: the verifier, the typed-error rule, the transactional
// config (attempts/lockout/wipe) and the `configId` identity that makes a
// replaced configuration observable WITHOUT BroadcastChannel.

const PIN = '123456';
const OTHER_PIN = '654321';

// Argon2id is deliberately expensive — derive ONE blob and reuse it.
let blob: PinEncryptedSeed;
beforeAll(async () => {
  blob = await createSafeboxPinBlob(PIN);
}, 60_000);

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

/** Create-or-replace a config for the tests (seed-authorized = unconditional). */
const writeConfig = () => commitSafeboxPinWrite(blob, 'seed-authorized', getDbGeneration());

const ENTRY: EncryptedSafeboxEntry = {
  entryId: '11111111-2222-8333-8444-555555555555',
  metaCiphertext: 'AAAA', metaIv: 'AAAAAAAAAAAAAAAA',
  secretCiphertext: 'BBBB', secretIv: 'AAAAAAAAAAAAAAAA',
  createdAt: 1, v: 4,
};

describe('PIN format rules', () => {
  it('digits only, 6..8', () => {
    expect(isValidSafeboxPin('123456')).toBe(true);
    expect(isValidSafeboxPin('12345678')).toBe(true);
    expect(isValidSafeboxPin('12345')).toBe(false);
    expect(isValidSafeboxPin('123456789')).toBe(false);
    expect(isValidSafeboxPin('12345a')).toBe(false);
    expect(isValidSafeboxPin('')).toBe(false);
  });
});

describe('verifier blob', () => {
  it('accepts the right PIN and reports a wrong one as SafeboxWrongPinError', async () => {
    await expect(verifySafeboxPin(blob, PIN)).resolves.toBeUndefined();
    await expect(verifySafeboxPin(blob, OTHER_PIN)).rejects.toBeInstanceOf(SafeboxWrongPinError);
  }, 60_000);

  it('wraps a RANDOM VERIFIER — never the mnemonic or a key', async () => {
    // 32 raw bytes + a 16-byte GCM tag = 48 bytes of ciphertext. A mnemonic
    // would be ~70+ bytes and a base64 key longer still.
    const raw = atob(blob.ciphertext);
    expect(raw.length).toBe(48);
    // Two blobs for the SAME pin differ (fresh verifier + salt + iv each time).
    const second = await createSafeboxPinBlob(PIN);
    expect(second.ciphertext).not.toBe(blob.ciphertext);
    expect(second.salt).not.toBe(blob.salt);
  }, 60_000);

  it('a malformed blob is UNAVAILABLE, never a wrong PIN (no attempt is spent)', async () => {
    const broken = { ...blob, iv: 'AAAA' }; // 3-byte IV
    await expect(verifySafeboxPin(broken, PIN)).rejects.toBeInstanceOf(SafeboxPinUnavailableError);
  }, 60_000);
});

describe('assertValidSafeboxPinConfig (untrusted runtime boundary)', () => {
  // The blob must pass the FULL assertValidPinBlob check — the very one the
  // KDF path runs. A "three strings are present" fixture used to pass here,
  // which is exactly the hole this suite now pins shut.
  const good = (): SafeboxPinConfig => ({
    blob,
    configId: '3f1b0a20-1111-4222-8333-444455556666',
    attempts: 0,
    lockedUntil: null,
  });

  it('accepts a well-formed config', () => {
    expect(() => assertValidSafeboxPinConfig(good())).not.toThrow();
  });

  it('rejects each malformed field with SafeboxPinUnavailableError', () => {
    const cases: unknown[] = [
      null,
      'string',
      [],
      { ...good(), configId: 'not-a-uuid' },
      { ...good(), attempts: -1 },
      { ...good(), attempts: SAFEBOX_MAX_PIN_ATTEMPTS },  // 10 must already be wiped
      { ...good(), attempts: 1.5 },
      { ...good(), attempts: '3' },
      { ...good(), lockedUntil: 'soon' },
      { ...good(), lockedUntil: -1 },
      { ...good(), blob: null },
      { ...good(), blob: { ciphertext: 1, iv: 'i', salt: 's' } },
      { ...good(), blob: { ciphertext: 'c', iv: 'i', salt: 's' } },            // not base64 / wrong lengths
      { ...good(), blob: { ...blob, iv: 'AAAA' } },                            // 3-byte IV
      { ...good(), blob: { ...blob, salt: 'AAAA' } },                          // 3-byte salt
      { ...good(), blob: { ...blob, ciphertext: 'AAAA' } },                    // shorter than a GCM tag
      { ...good(), blob: { ...blob, kdf: 'scrypt' } },                         // unknown KDF
      { ...good(), blob: { ...blob, v: 2 } },                                  // unsupported KDF version
      { ...good(), blob: { ...blob, argon2: { ...blob.argon2!, memorySize: 8 } } }, // off-profile params
      { ...good(), extra: true },                          // extra field
    ];
    for (const raw of cases) {
      expect(() => assertValidSafeboxPinConfig(raw), JSON.stringify(raw)).toThrow(SafeboxPinUnavailableError);
    }
    const missing = good() as Partial<SafeboxPinConfig>;
    delete missing.lockedUntil;                            // missing field
    expect(() => assertValidSafeboxPinConfig(missing)).toThrow(SafeboxPinUnavailableError);
  });

  it('readSafeboxPinConfig THROWS on a malformed record (never "not configured")', async () => {
    await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
    await expect(readSafeboxPinConfig()).rejects.toBeInstanceOf(SafeboxPinUnavailableError);
    // …but presence-only hydration still says «configured» (fail closed: the
    // section must offer the seed reset, not a fresh-activation flow).
    expect(await hasSafeboxPinConfig()).toBe(true);
  });

  it('a malformed config leaves attempts/lockout untouched (no attempt spent)', async () => {
    await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
    const before = await getMeta(SAFEBOX_PIN_META_KEY);
    await expect(readSafeboxPinConfig()).rejects.toBeInstanceOf(SafeboxPinUnavailableError);
    expect(await getMeta(SAFEBOX_PIN_META_KEY)).toEqual(before);
  });
});

describe('transactional config mutations (configId identity)', () => {
  it('mints a FRESH configId on every replace', async () => {
    const first = await writeConfig();
    const second = await writeConfig();
    expect(first).not.toBe(second);
    expect((await readSafeboxPinConfig())?.configId).toBe(second);
  });

  it('two concurrent failures BOTH count (no lost increment)', async () => {
    const configId = await writeConfig();
    // Two "tabs" failing at once. IndexedDB serializes readwrite transactions
    // per store, and each helper re-reads inside its own transaction — the
    // getMeta/setMeta pattern would lose one of these.
    await Promise.all([
      commitSafeboxPinFailure(configId, Date.now(), getDbGeneration()),
      commitSafeboxPinFailure(configId, Date.now(), getDbGeneration()),
    ]);
    expect((await readSafeboxPinConfig())?.attempts).toBe(2);
  });

  it('a failure is NOT charged to a config that was replaced meanwhile', async () => {
    const oldId = await writeConfig();
    const newId = await writeConfig(); // another tab re-created it
    await expect(commitSafeboxPinFailure(oldId, Date.now(), getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    const cfg = await readSafeboxPinConfig();
    expect(cfg?.configId).toBe(newId);
    expect(cfg?.attempts).toBe(0); // the fresh config is untouched
  });

  it('a stale SUCCESS after a recreate is rejected (delete→recreate is observable)', async () => {
    const oldId = await writeConfig();
    await commitSafeboxPinDelete(oldId, getDbGeneration());
    const newId = await writeConfig();
    expect(newId).not.toBe(oldId); // a monotonic counter could have repeated
    await expect(commitSafeboxPinSuccess(oldId, getDbGeneration())).rejects.toBeInstanceOf(SafeboxConfigChangedError);
  });

  it('every mutation against a MISSING config fails closed', async () => {
    await expect(commitSafeboxPinFailure('3f1b0a20-1111-4222-8333-444455556666', Date.now(), getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    await expect(commitSafeboxPinSuccess('3f1b0a20-1111-4222-8333-444455556666', getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    await expect(commitSafeboxPinDelete('3f1b0a20-1111-4222-8333-444455556666', getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
  });

  it('success clears attempts and the lockout, keeping the blob and configId', async () => {
    const configId = await writeConfig();
    await commitSafeboxPinFailure(configId, Date.now(), getDbGeneration());
    await commitSafeboxPinFailure(configId, Date.now(), getDbGeneration());
    await commitSafeboxPinFailure(configId, Date.now(), getDbGeneration());
    await commitSafeboxPinFailure(configId, Date.now(), getDbGeneration()); // 4th → 30 s lockout
    expect((await readSafeboxPinConfig())?.lockedUntil).not.toBeNull();

    await commitSafeboxPinSuccess(configId, getDbGeneration());
    const cfg = await readSafeboxPinConfig();
    expect(cfg).toMatchObject({ configId, attempts: 0, lockedUntil: null });
    expect(cfg?.blob).toEqual(blob);
  });
});

describe('progressive lockout and the 10-strike wipe', () => {
  it('follows the ≤3→0s, ≤5→30s, ≤7→300s, else 1800s schedule', () => {
    expect(safeboxLockSeconds(1)).toBe(0);
    expect(safeboxLockSeconds(3)).toBe(0);
    expect(safeboxLockSeconds(4)).toBe(30);
    expect(safeboxLockSeconds(5)).toBe(30);
    expect(safeboxLockSeconds(6)).toBe(300);
    expect(safeboxLockSeconds(7)).toBe(300);
    expect(safeboxLockSeconds(8)).toBe(1800);
    expect(safeboxLockSeconds(9)).toBe(1800);
  });

  it('the 10th failure wipes the CONFIG ONLY — entries survive', async () => {
    const configId = await writeConfig();
    await saveSafeboxEntryWithSync(ENTRY, {
      noteId: ENTRY.entryId, kind: 'safebox', status: 'confirmed', transport: 'proxy', updatedAt: 1,
    });

    const now = 1_700_000_000_000;
    let outcome;
    for (let i = 1; i <= SAFEBOX_MAX_PIN_ATTEMPTS; i++) {
      outcome = await commitSafeboxPinFailure(configId, now, getDbGeneration());
      if (i < SAFEBOX_MAX_PIN_ATTEMPTS) expect(outcome.wiped).toBe(false);
    }
    expect(outcome!.wiped).toBe(true);
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(await hasSafeboxPinConfig()).toBe(false);
    // THE DATA IS UNTOUCHED — the section switches to «restore by seed».
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('records the lockout deadline computed from the caller-supplied now', async () => {
    const configId = await writeConfig();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) await commitSafeboxPinFailure(configId, now, getDbGeneration());
    expect((await readSafeboxPinConfig())?.lockedUntil).toBeNull(); // ≤3 → no lockout
    const fourth = await commitSafeboxPinFailure(configId, now, getDbGeneration());
    expect(fourth.lockedUntil).toBe(now + 30_000);
  });
});

describe('commitSafeboxEntry (atomic configId recheck + write)', () => {
  it('writes the entry when the config still matches', async () => {
    const configId = await writeConfig();
    await commitSafeboxEntry(ENTRY, configId, getDbGeneration());
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('REFUSES the write when the config was replaced mid-operation', async () => {
    const oldId = await writeConfig();
    await writeConfig(); // another tab replaced it
    await expect(commitSafeboxEntry(ENTRY, oldId, getDbGeneration())).rejects.toBeInstanceOf(SafeboxConfigChangedError);
    expect(await countSafeboxEntries()).toBe(0); // nothing landed
  });

  it('REFUSES the write when the config disappeared (deactivation / wipe)', async () => {
    const configId = await writeConfig();
    await commitSafeboxPinDelete(configId, getDbGeneration());
    await expect(commitSafeboxEntry(ENTRY, configId, getDbGeneration())).rejects.toBeInstanceOf(SafeboxConfigChangedError);
    expect(await countSafeboxEntries()).toBe(0);
  });

  it('REFUSES the write when the config is malformed (fail closed)', async () => {
    const configId = await writeConfig();
    await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
    await expect(commitSafeboxEntry(ENTRY, configId, getDbGeneration())).rejects.toBeInstanceOf(SafeboxPinUnavailableError);
    expect(await countSafeboxEntries()).toBe(0);
  });
});

describe('reset-exclusivity (dbGeneration) on the PIN paths', () => {
  it('EVERY PIN/entry write is refused once a reset bumped the generation', async () => {
    const stale = getDbGeneration();
    const configId = await writeConfig();
    await resetAll(); // destroys the vault and bumps the generation

    // A flow that captured `stale` before the wipe must not resurrect anything
    // in the emptied database — nor attach it to the NEXT vault opened here.
    await expect(commitSafeboxPinWrite(blob, 'seed-authorized', stale)).rejects.toBeInstanceOf(StorageResetError);
    await expect(commitSafeboxPinWrite(blob, 'absent', stale)).rejects.toBeInstanceOf(StorageResetError);
    await expect(commitSafeboxPinFailure(configId, Date.now(), stale)).rejects.toBeInstanceOf(StorageResetError);
    await expect(commitSafeboxPinSuccess(configId, stale)).rejects.toBeInstanceOf(StorageResetError);
    await expect(commitSafeboxPinDelete(configId, stale)).rejects.toBeInstanceOf(StorageResetError);
    await expect(commitSafeboxEntry(ENTRY, configId, stale)).rejects.toBeInstanceOf(StorageResetError);

    expect(await getMeta(SAFEBOX_PIN_META_KEY)).toBeUndefined();
    expect(await countSafeboxEntries()).toBe(0);
  });
});

describe('write preconditions (Argon2id takes ~1 s — the config can move)', () => {
  it('create-if-absent refuses to clobber a config another tab installed', async () => {
    await writeConfig();
    await expect(commitSafeboxPinWrite(blob, 'absent', getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
  });

  it('replace-if-configId refuses when the current config is a different one', async () => {
    const oldId = await writeConfig();
    const newId = await writeConfig(); // another tab won the race
    await expect(commitSafeboxPinWrite(blob, { configId: oldId }, getDbGeneration()))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    expect((await readSafeboxPinConfig())?.configId).toBe(newId); // untouched
  });

  it('replace-if-configId succeeds while we are still the owner', async () => {
    const id = await writeConfig();
    const next = await commitSafeboxPinWrite(blob, { configId: id }, getDbGeneration());
    expect(next).not.toBe(id);
    expect((await readSafeboxPinConfig())?.configId).toBe(next);
  });

  it('seed-authorized is unconditional BY DESIGN (proof of seed outranks any config)', async () => {
    await writeConfig();
    const next = await commitSafeboxPinWrite(blob, 'seed-authorized', getDbGeneration());
    expect((await readSafeboxPinConfig())?.configId).toBe(next);
  });
});
