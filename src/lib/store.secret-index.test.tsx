// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The store suites below need the writer, backup and secret-link flags ON;
// SECRET_LINK_ENABLED is a getter so a test can switch it per case.
const flagState = vi.hoisted(() => ({ secretLink: true }));
vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: true,
  BACKUP_IMPORT_ENABLED: true,
  get SECRET_LINK_ENABLED() { return flagState.secretLink; },
}));

// Argon2id stand-in (fast, deterministic). `beforeArgon2` is one-shot: it lets
// a test change the stored PIN while a derivation is in flight.
const kdfHooks = vi.hoisted(() => ({ beforeArgon2: null as null | (() => Promise<void>) }));
vi.mock('hash-wasm', () => ({
  argon2id: async ({ password, salt }: { password: string; salt: Uint8Array }) => {
    const hook = kdfHooks.beforeArgon2;
    kdfHooks.beforeArgon2 = null;
    await hook?.();
    const data = new TextEncoder().encode(`${password}:${Array.from(salt).join(',')}`);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  },
}));

vi.mock('./arweave', async importOriginal => {
  const actual = await importOriginal<typeof import('./arweave')>();
  return {
    ...actual,
    isArweaveOnline: vi.fn(async () => false),
    checkRegistration: vi.fn(async () => ({ status: 'unavailable' as const })),
    registerWithProxy: vi.fn(async () => ({ error: 'unavailable' })),
    uploadViaProxy: vi.fn(async () => ({ kind: 'error' as const, error: 'offline' })),
    fetchAllNotes: vi.fn(async () => ({ notes: [], safeboxEntries: [], incomplete: false })),
    getTxStatus: vi.fn(async () => ({ kind: 'unavailable' as const })),
    getWorkerCapabilities: vi.fn(async () => ({ uploads: 'unknown' as const, v3: 'unknown' as const, v4: 'unknown' as const })),
  };
});

// Real storage throughout. The snapshot reader gets hooks (a writer B landing
// right before/after writer A's snapshot), the two commits record every
// rejection so a test can name the conflict that forced a retry.
const storageHooks = vi.hoisted(() => ({
  beforeSnapshot: [] as Array<() => Promise<void>>,
  afterSnapshot: [] as Array<() => Promise<void>>,
  errors: [] as unknown[],
}));
vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  const recording = <A extends unknown[]>(f: (...a: A) => Promise<void>) => vi.fn(async (...a: A) => {
    try {
      return await f(...a);
    } catch (e) {
      storageHooks.errors.push(e);
      throw e;
    }
  });
  return {
    ...actual,
    readSecretLinkSnapshot: vi.fn(async () => {
      await storageHooks.beforeSnapshot.shift()?.();
      const snap = await actual.readSecretLinkSnapshot();
      await storageHooks.afterSnapshot.shift()?.();
      return snap;
    }),
    commitSafeboxEntry: recording(actual.commitSafeboxEntry as (...a: unknown[]) => Promise<void>),
    commitSecretLinkIndex: recording(actual.commitSecretLinkIndex),
  };
});

// Same cross-realm digest shim as store.safebox.test.tsx (noble/ed25519 under jsdom).
import { webcrypto } from 'node:crypto';
const subtleProxy = new Proxy(webcrypto.subtle, {
  get(target, prop) {
    if (prop === 'digest') {
      return (alg: AlgorithmIdentifier, data: BufferSource) =>
        target.digest(alg, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    }
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    subtle: subtleProxy,
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
  },
});

import {
  initStorage,
  resetAll,
  setMeta,
  getMeta,
  deleteMeta,
  getDbGeneration,
  countSafeboxEntries,
  getAllSafeboxEntries,
  commitSafeboxEntry,
  commitSecretLinkIndex,
  commitSafeboxPinWrite,
  readSafeboxPinConfig,
  readSecretLinkSnapshot,
  readResolverPhase1,
  readResolverPhase2,
  readIssueSnapshot,
  bumpLockGeneration,
  readLockGeneration,
  safeboxRowsOf,
  pinSeedEquals,
  SafeboxConfigChangedError,
  StorageResetError,
  SecretLinkConflictError,
  SAFEBOX_PIN_META_KEY,
  SECRET_LINK_KEY_PREFIX,
  SECRET_LINK_COVERAGE_KEY,
  SECRET_OP_KEY_PREFIX,
  VAULT_LOCK_GENERATION_KEY,
  SECRET_LINKS_ENABLED_KEY,
  SECRET_LINK_ORIGINS_KEY,
  type AuthSnapshot,
  type ExpectVault,
  type ExpectLight,
  type IndexWrite,
  type KeyExpect,
  type MaintenanceOp,
} from './storage';
import {
  SafeboxPinUnavailableError,
  bufferToBase64,
  base64ToBuffer,
  createSafeboxPinBlob,
  decryptSafeboxMeta,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  deriveKey,
  encryptSafeboxEntry,
  encryptWithPin,
  type EncryptedSafeboxEntry,
  type PinEncryptedSeed,
  type SafeboxEntryData,
} from './crypto';
import { QUICK_UNLOCK_META_KEY, type QuickUnlockRecord } from './quick-unlock';
import {
  chooseHead,
  classifyKey,
  coverageDelta,
  deriveSecretLinkKey,
  encryptIndexBlob,
  isCoverageRecord,
  issueSnapshotEquals,
  secretLinkHandle,
  tryDecryptIndexBlob,
  SECRET_RECEIPT_TTL_MS,
  type CoverageRow,
  type IndexBlob,
  type IndexRecord,
  type IssueSnapshot,
  type ReceiptRecord,
} from './secret-link';
import { byCurrentness } from './chains';
import { commitEntryWithSecretLink, rebuildSecretLinkIndex, type EntryIndexInput } from './secret-link-index';
import { NotesProvider, useNotes, SecretLinkDisabledError, SafeboxLockedError } from './store';
import { fetchAllNotes } from './arweave';
import { encodeBackup, deriveBackupKey } from './backup';
import {
  prepareImport,
  liveStorage,
  BackupCancelledError,
  type BackupStorage,
  type BackupVault,
} from './backup-adapter';
import type { ImportReport } from './backup-import';

// The secret-link CAS-writer (plan §1.3/§1.5, P1 step 3) against REAL storage
// (fake-indexeddb). Store-level suites append their own describe blocks below.

const b64 = (n: number, fill = 0) => bufferToBase64(new Uint8Array(n).fill(fill));

// Structurally valid legacy blob — no KDF ever runs in these tests.
const PIN_SEED: PinEncryptedSeed = { ciphertext: b64(32, 1), iv: b64(12), salt: b64(16) };
const CONFIG_ID = '11111111-2222-8333-8444-555555555555';
const OTHER_CONFIG_ID = '11111111-2222-8333-8444-666666666666';
const H1 = SECRET_LINK_KEY_PREFIX + 'TnYgaHGXuUjYvmglbl6DhA';
const H2 = SECRET_LINK_KEY_PREFIX + 'BxPZLUwEdOSIcnFi1PkkiQ';
const RECEIPT = SECRET_OP_KEY_PREFIX + 'https://baobook.app:6f1d6a3e-2b1c-4d7e-9a8b-0c1d2e3f4a5b';

function entry(id: string, metaIv = b64(12)): EncryptedSafeboxEntry {
  return {
    entryId: id,
    metaCiphertext: 'AAAA', metaIv,
    secretCiphertext: 'BBBB', secretIv: b64(12),
    createdAt: 1, v: 4,
  };
}
const E1 = entry('00000000-0000-8000-8000-000000000001', b64(12, 1));
const E2 = entry('00000000-0000-8000-8000-000000000002', b64(12, 2));

const blob = (ct: string): IndexBlob => ({ v: 1, iv: b64(12), ct });

async function writeConfig(configId = CONFIG_ID): Promise<void> {
  await setMeta(SAFEBOX_PIN_META_KEY, { blob: PIN_SEED, configId, attempts: 0, lockedUntil: null });
}

function vault(over: Partial<ExpectVault> = {}): ExpectVault {
  return { mode: 'vault', configId: CONFIG_ID, dbGeneration: getDbGeneration(), lockGeneration: 0, ...over };
}

const PIN_AUTH: AuthSnapshot = {
  factor: 'pin', pinSeed: PIN_SEED, enabled: true,
  origins: ['https://baobook.app', 'https://baobook.dev'], configId: CONFIG_ID, lockGeneration: 0,
};

function light(over: Partial<ExpectLight> = {}): ExpectLight {
  return {
    mode: 'light', configId: CONFIG_ID, dbGeneration: getDbGeneration(), lockGeneration: 0,
    auth: PIN_AUTH, ...over,
  };
}

async function writeLightAuthState(): Promise<void> {
  await setMeta('pin-seed', PIN_SEED);
  await setMeta(SECRET_LINKS_ENABLED_KEY, true);
  await setMeta(SECRET_LINK_ORIGINS_KEY, ['https://baobook.app', 'https://baobook.dev']);
}

async function expectConflict(p: Promise<unknown>, kind: SecretLinkConflictError['kind'], key?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SecretLinkConflictError);
  expect((err as SecretLinkConflictError).kind).toBe(kind);
  if (key !== undefined) expect((err as SecretLinkConflictError).key).toBe(key);
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  // resetAll carries the lock generation forward; start every test from 0.
  await setMeta(VAULT_LOCK_GENERATION_KEY, 0);
  await writeConfig();
});

describe('storage: secret-link', () => {
  describe('commitSafeboxEntry (expect, writes)', () => {
    it('writes entry + index + coverage in ONE transaction', async () => {
      const writes: IndexWrite[] = [
        { key: H1, expect: { present: false }, blob: blob('rec1') },
        { key: SECRET_LINK_COVERAGE_KEY, expect: { present: false }, blob: blob('cov1') },
      ];
      await commitSafeboxEntry(E1, vault(), writes);
      expect(await countSafeboxEntries()).toBe(1);
      expect(await getMeta(H1)).toEqual(blob('rec1'));
      expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toEqual(blob('cov1'));
    });

    it('a conflict on the LAST write rolls back the entry and every earlier write', async () => {
      await setMeta(H2, blob('existing'));
      const writes: IndexWrite[] = [
        { key: H1, expect: { present: false }, blob: blob('rec1') },
        { key: SECRET_LINK_COVERAGE_KEY, expect: { present: false }, blob: blob('cov1') },
        { key: H2, expect: { present: false }, blob: blob('rec2') },
      ];
      await expectConflict(commitSafeboxEntry(E1, vault(), writes), 'key', H2);
      expect(await countSafeboxEntries()).toBe(0);
      expect(await getMeta(H1)).toBeUndefined();
      expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toBeUndefined();
      expect(await getMeta(H2)).toEqual(blob('existing'));
    });

    it('blob:null deletes the key', async () => {
      await setMeta(H1, blob('old'));
      await commitSafeboxEntry(E1, vault(), [{ key: H1, expect: { present: true, ct: 'old' }, blob: null }]);
      const snap = await readSecretLinkSnapshot();
      expect(snap.index.has(H1)).toBe(false);
    });

    it('without writes: entry-only commit under the vault expectations', async () => {
      await commitSafeboxEntry(E1, vault());
      expect(await countSafeboxEntries()).toBe(1);
    });

    it('config conflict: replaced or absent → kind config, nothing written', async () => {
      await writeConfig(OTHER_CONFIG_ID);
      await expectConflict(
        commitSafeboxEntry(E1, vault(), [{ key: H1, expect: { present: false }, blob: blob('r') }]),
        'config',
      );
      await setMeta(SAFEBOX_PIN_META_KEY, undefined);
      // A key holding undefined reads exactly like the absent config here.
      await expectConflict(commitSafeboxEntry(E1, vault({ configId: OTHER_CONFIG_ID })), 'config');
      expect(await countSafeboxEntries()).toBe(0);
      expect(await getMeta(H1)).toBeUndefined();
    });

    it('malformed config keeps its existing fail-closed type', async () => {
      await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
      await expect(commitSafeboxEntry(E1, vault())).rejects.toBeInstanceOf(SafeboxPinUnavailableError);
      expect(await countSafeboxEntries()).toBe(0);
    });

    it('dbGeneration mismatch → StorageResetError, as before', async () => {
      await expect(commitSafeboxEntry(E1, vault({ dbGeneration: getDbGeneration() - 1 })))
        .rejects.toBeInstanceOf(StorageResetError);
    });

    it('lock conflict: a bump between snapshot and commit → kind lock, rolled back', async () => {
      const g = (await readSecretLinkSnapshot()).lockGeneration;
      await bumpLockGeneration();
      await expectConflict(
        commitSafeboxEntry(E1, vault({ lockGeneration: g }), [{ key: H1, expect: { present: false }, blob: blob('r') }]),
        'lock',
      );
      expect(await countSafeboxEntries()).toBe(0);
      expect(await getMeta(H1)).toBeUndefined();
    });

    it('lock: an ABSENT counter equals 0; a damaged one never matches', async () => {
      await setMeta(VAULT_LOCK_GENERATION_KEY, undefined);
      await commitSafeboxEntry(E1, vault({ lockGeneration: 0 }));
      expect(await countSafeboxEntries()).toBe(1);
      await deleteMeta(VAULT_LOCK_GENERATION_KEY);
      await commitSafeboxEntry(E2, vault({ lockGeneration: 0 }));
      expect(await countSafeboxEntries()).toBe(2);
      await setMeta(VAULT_LOCK_GENERATION_KEY, 'x');
      expect(await readLockGeneration()).toBe(0);
      await expectConflict(commitSafeboxEntry(entry('00000000-0000-8000-8000-000000000003'), light()), 'lock');
      expect(await bumpLockGeneration()).toBe(1); // the next bump repairs it
    });

    it('lock: a damaged counter never costs an ordinary (vault) save; a light commit fails closed', async () => {
      await writeLightAuthState();
      let n = 3;
      for (const damaged of ['3', -1, 1.5, {}, null]) {
        await setMeta(VAULT_LOCK_GENERATION_KEY, damaged);
        const snap = await readSecretLinkSnapshot();
        expect(snap.lockGeneration).toBe(0);
        const e = entry(`00000000-0000-8000-8000-00000000000${n++}`);
        await commitSafeboxEntry(e, vault({ lockGeneration: snap.lockGeneration }), [
          { key: H1, expect: { present: false }, blob: blob('r') },
        ]);
        expect(await getMeta(H1)).toEqual(blob('r'));
        await deleteMeta(H1);
        await expectConflict(
          commitSafeboxEntry(entry('00000000-0000-8000-8000-0000000000ff'), light({ lockGeneration: 0 })),
          'lock',
        );
      }
      // A real bump still moves the normalized value: the vault check sees it.
      const g = (await readSecretLinkSnapshot()).lockGeneration;
      await bumpLockGeneration();
      await expectConflict(commitSafeboxEntry(entry('00000000-0000-8000-8000-0000000000fe'), vault({ lockGeneration: g })), 'lock');
      expect(await countSafeboxEntries()).toBe(5);
    });

    it('rows conflict: a row added after the snapshot → kind rows, rolled back', async () => {
      await commitSafeboxEntry(E1, vault());
      const snap = await readSecretLinkSnapshot();
      await commitSafeboxEntry(E2, vault()); // writer B, after A's snapshot
      await expectConflict(
        commitSecretLinkIndex(
          [{ key: H1, expect: { present: false }, blob: blob('r') }],
          vault({ safeboxRows: safeboxRowsOf(snap.entries) }),
        ),
        'rows',
      );
      expect(await getMeta(H1)).toBeUndefined();
    });

    it('rows: compared element-wise in entryId order; a replaced metaIv conflicts', async () => {
      await commitSafeboxEntry(E2, vault());
      await commitSafeboxEntry(E1, vault());
      const snap = await readSecretLinkSnapshot();
      expect(snap.entries.map(e => e.entryId)).toEqual([E1.entryId, E2.entryId]);
      const rows = safeboxRowsOf(snap.entries);
      await commitSecretLinkIndex([], vault({ safeboxRows: rows }));
      await expectConflict(commitSecretLinkIndex([], vault({ safeboxRows: [rows[1], rows[0]] })), 'rows');
      await commitSafeboxEntry({ ...E1, metaIv: b64(12, 9) }, vault());
      await expectConflict(commitSecretLinkIndex([], vault({ safeboxRows: rows })), 'rows');
    });

    it('rows: a row written BEFORE the snapshot is in it — no conflict', async () => {
      await commitSafeboxEntry(E1, vault());
      await commitSafeboxEntry(E2, vault());
      const snap = await readSecretLinkSnapshot();
      await commitSecretLinkIndex(
        [{ key: H1, expect: { present: false }, blob: blob('r') }],
        vault({ safeboxRows: safeboxRowsOf(snap.entries) }),
      );
      expect(await getMeta(H1)).toEqual(blob('r'));
    });

    it('auth conflict (light): pin-seed, enabled, origins, configId, lock generation', async () => {
      await writeLightAuthState();
      await commitSafeboxEntry(E1, light(), [{ key: H1, expect: { present: false }, blob: blob('r') }]);
      expect(await getMeta(H1)).toEqual(blob('r'));

      const tryOnce = () => commitSafeboxEntry(E2, light(), [{ key: H2, expect: { present: false }, blob: blob('r2') }]);

      await setMeta('pin-seed', { ...PIN_SEED, ciphertext: b64(32, 7) });
      await expectConflict(tryOnce(), 'auth');
      await setMeta('pin-seed', PIN_SEED);

      await setMeta(SECRET_LINKS_ENABLED_KEY, false);
      await expectConflict(tryOnce(), 'auth');
      await setMeta(SECRET_LINKS_ENABLED_KEY, true);

      await setMeta(SECRET_LINK_ORIGINS_KEY, ['https://baobook.app']);
      await expectConflict(tryOnce(), 'auth');
      await setMeta(SECRET_LINK_ORIGINS_KEY, ['https://baobook.dev', 'https://baobook.app']);
      await expectConflict(tryOnce(), 'auth');
      await setMeta(SECRET_LINK_ORIGINS_KEY, ['https://baobook.app', 'https://baobook.dev']);

      // auth taken against another config/generation than the expect itself
      await expectConflict(
        commitSafeboxEntry(E2, light({ auth: { ...PIN_AUTH, configId: OTHER_CONFIG_ID } })),
        'auth',
      );
      await expectConflict(
        commitSafeboxEntry(E2, light({ auth: { ...PIN_AUTH, lockGeneration: 5 } })),
        'auth',
      );

      expect(await countSafeboxEntries()).toBe(1);
      expect(await getMeta(H2)).toBeUndefined();
      await tryOnce();
      expect(await countSafeboxEntries()).toBe(2);
    });

    it('auth (light, prf): record equality + pin-seed present', async () => {
      await writeLightAuthState();
      const pk = b64(32, 3);
      const record: QuickUnlockRecord = {
        v: 1, credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', prfSalt: b64(32), hkdfSalt: b64(32),
        iv: b64(12), ciphertext: b64(48), pk, createdAt: 1_700_000_000_000,
      };
      await setMeta(QUICK_UNLOCK_META_KEY, record);
      await setMeta('vault-public-key', pk);
      const auth: AuthSnapshot = {
        factor: 'prf', prfRecord: record, pinPresent: true, enabled: true,
        origins: ['https://baobook.app', 'https://baobook.dev'], configId: CONFIG_ID, lockGeneration: 0,
      };
      await commitSafeboxEntry(E1, light({ auth }));
      expect(await countSafeboxEntries()).toBe(1);

      await setMeta(QUICK_UNLOCK_META_KEY, { ...record, iv: b64(12, 5) });
      await expectConflict(commitSafeboxEntry(E2, light({ auth })), 'auth');
      await setMeta(QUICK_UNLOCK_META_KEY, record);
      await deleteMeta('pin-seed');
      await expectConflict(commitSafeboxEntry(E2, light({ auth })), 'auth');
      // A damaged pin-seed is as absent as a missing one (same rule as phase 3).
      await setMeta('pin-seed', {});
      await expectConflict(commitSafeboxEntry(E2, light({ auth })), 'auth');
      expect(await countSafeboxEntries()).toBe(1);
    });

    it('auth (light): a missing settings key never matches (nothing is completed from auth)', async () => {
      await setMeta('pin-seed', PIN_SEED);
      await expectConflict(commitSafeboxEntry(E1, light()), 'auth');
      expect(await countSafeboxEntries()).toBe(0);
    });
  });

  describe('KeyExpect', () => {
    const put = (key: string, expect: IndexWrite['expect']) =>
      commitSecretLinkIndex([{ key, expect, blob: blob('new') }], vault());

    it('present:false conflicts with ANY existing value: {}, null, undefined', async () => {
      for (const v of [{}, null, undefined, { ct: 'x' }]) {
        await setMeta(H1, v);
        await expectConflict(put(H1, { present: false }), 'key', H1);
        const snap = await readSecretLinkSnapshot();
        expect(snap.index.has(H1)).toBe(true);
        expect(snap.index.get(H1)).toEqual(v);
      }
    });

    it('present:true + ct: requires an existing value with that exact ct', async () => {
      await expectConflict(put(H1, { present: true, ct: 'old' }), 'key', H1); // absent
      await setMeta(H1, undefined);
      await expectConflict(put(H1, { present: true, ct: 'old' }), 'key', H1); // undefined value
      await setMeta(H1, null);
      await expectConflict(put(H1, { present: true, ct: 'old' }), 'key', H1);
      await setMeta(H1, blob('other'));
      await expectConflict(put(H1, { present: true, ct: 'old' }), 'key', H1);
      await setMeta(H1, blob('old'));
      await put(H1, { present: true, ct: 'old' });
      expect(await getMeta(H1)).toEqual(blob('new'));
    });

    it('present:true + raw: object/array passed as-is, compared structurally', async () => {
      const damaged = { v: 2, nested: [1, 'a', null, { x: NaN }] };
      await setMeta(H1, damaged);
      await put(H1, { present: true, raw: { nested: [1, 'a', null, { x: NaN }], v: 2 } });
      expect(await getMeta(H1)).toEqual(blob('new'));

      await setMeta(H2, [1, [2, 3]]);
      await expectConflict(put(H2, { present: true, raw: [1, [2, 4]] }), 'key', H2);
      await commitSecretLinkIndex([{ key: H2, expect: { present: true, raw: [1, [2, 3]] }, blob: null }], vault());
      expect((await readSecretLinkSnapshot()).index.has(H2)).toBe(false);
    });

    it('present:true + raw:undefined — a key holding undefined differs from an absent key', async () => {
      await expectConflict(put(H1, { present: true, raw: undefined }), 'key', H1); // absent
      await setMeta(H1, undefined);
      await expectConflict(put(H1, { present: false }), 'key', H1);
      await put(H1, { present: true, raw: undefined });
      expect(await getMeta(H1)).toEqual(blob('new'));
    });

    it('raw outside the RawComparable domain (Date in the DB) fails closed → key conflict', async () => {
      const d = new Date(0);
      await setMeta(H1, d);
      await expectConflict(
        commitSecretLinkIndex([{ key: H1, expect: { present: true, raw: d as never }, blob: null }], vault()),
        'key', H1,
      );
      expect(await getMeta(H1)).toEqual(d);
    });

    it('a malformed value changed between snapshot and commit → key conflict, no overwrite', async () => {
      await setMeta(H1, { bad: 1 });
      const snap = await readSecretLinkSnapshot();
      await setMeta(H1, { bad: 2 });
      await expectConflict(
        commitSecretLinkIndex(
          [{ key: H1, expect: { present: true, raw: snap.index.get(H1) as never }, blob: blob('fixed') }],
          vault(),
        ),
        'key', H1,
      );
      expect(await getMeta(H1)).toEqual({ bad: 2 });
    });

    it('writes outside the secret-link keys are rejected before any transaction', async () => {
      const bad = [
        { key: 'pin-seed', expect: { present: false }, blob: blob('x') },
        { key: SECRET_LINK_KEY_PREFIX, expect: { present: false }, blob: blob('x') },
        { key: H1, expect: { present: true }, blob: blob('x') },
        { key: H1, expect: { present: false }, blob: { v: 1, iv: '', ct: 'x' } },
      ] as unknown as IndexWrite[];
      for (const w of bad) {
        await expect(commitSafeboxEntry(E1, vault(), [w])).rejects.toBeInstanceOf(TypeError);
      }
      const dup = { key: H1, expect: { present: false }, blob: blob('x') } as IndexWrite;
      await expect(commitSecretLinkIndex([dup, dup], vault())).rejects.toBeInstanceOf(TypeError);
      expect(await countSafeboxEntries()).toBe(0);
      expect(await getMeta('pin-seed')).toBeUndefined();
    });
  });

  describe('legacy commitSafeboxEntry(entry, configId, gen)', () => {
    it('behaves exactly as before: no lock/rows/index checks', async () => {
      await setMeta(VAULT_LOCK_GENERATION_KEY, 'damaged');
      await setMeta(H1, blob('untouched'));
      await commitSafeboxEntry(E1, CONFIG_ID, getDbGeneration());
      expect(await countSafeboxEntries()).toBe(1);
      expect(await getMeta(H1)).toEqual(blob('untouched'));
    });

    it('same errors as before', async () => {
      await expect(commitSafeboxEntry(E1, OTHER_CONFIG_ID, getDbGeneration()))
        .rejects.toBeInstanceOf(SafeboxConfigChangedError);
      await expect(commitSafeboxEntry(E1, CONFIG_ID, getDbGeneration() - 1))
        .rejects.toBeInstanceOf(StorageResetError);
      await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
      await expect(commitSafeboxEntry(E1, CONFIG_ID, getDbGeneration()))
        .rejects.toBeInstanceOf(SafeboxPinUnavailableError);
      await deleteMeta(SAFEBOX_PIN_META_KEY);
      await expect(commitSafeboxEntry(E1, CONFIG_ID, getDbGeneration()))
        .rejects.toBeInstanceOf(SafeboxConfigChangedError);
      expect(await getAllSafeboxEntries()).toEqual([]);
    });
  });

  describe('readSecretLinkSnapshot', () => {
    it('splits index / coverage / receipts by prefix; coverage is not an index key', async () => {
      await commitSafeboxEntry(E1, vault());
      await setMeta(H1, blob('r1'));
      await setMeta(H2, undefined);
      await setMeta(SECRET_LINK_COVERAGE_KEY, blob('c'));
      await setMeta(RECEIPT, blob('rc'));
      await setMeta('secret-link', 'not ours');
      await setMeta('secret-links-enabled-x', 'not ours');
      await setMeta(VAULT_LOCK_GENERATION_KEY, 4);

      const snap = await readSecretLinkSnapshot();
      expect(snap.entries).toEqual([E1]);
      expect([...snap.index.keys()].sort()).toEqual([H2, H1].sort());
      expect(snap.index.get(H1)).toEqual(blob('r1'));
      expect(snap.index.has(H2)).toBe(true);
      expect(snap.index.get(H2)).toBeUndefined();
      expect(snap.coverage).toEqual(blob('c'));
      expect(snap.coveragePresent).toBe(true);
      expect([...snap.receipts.entries()]).toEqual([[RECEIPT, blob('rc')]]);
      expect(snap.lockGeneration).toBe(4);
    });

    it('coverage: an absent key differs from a key holding undefined', async () => {
      expect((await readSecretLinkSnapshot()).coveragePresent).toBe(false);
      await setMeta(SECRET_LINK_COVERAGE_KEY, undefined);
      const snap = await readSecretLinkSnapshot();
      expect(snap.coveragePresent).toBe(true);
      expect(snap.coverage).toBeUndefined();
    });

    it('is one consistent transaction: a concurrent writer lands wholly before or after it', async () => {
      const writes: IndexWrite[] = [
        { key: H1, expect: { present: false }, blob: blob('r1') },
        { key: SECRET_LINK_COVERAGE_KEY, expect: { present: false }, blob: blob('c1') },
      ];
      const [snap] = await Promise.all([readSecretLinkSnapshot(), commitSafeboxEntry(E1, vault(), writes)]);
      const sawEntry = snap.entries.length === 1;
      expect(snap.index.has(H1)).toBe(sawEntry);
      expect(snap.coveragePresent).toBe(sawEntry);
    });
  });

  describe('resolver readers', () => {
    it('phase 1 / phase 2 / issue snapshot read raw state in one transaction each', async () => {
      await writeLightAuthState();
      await commitSafeboxEntry(E1, vault(), [
        { key: H1, expect: { present: false }, blob: blob('r1') },
        { key: SECRET_LINK_COVERAGE_KEY, expect: { present: false }, blob: blob('c1') },
      ]);
      const handle = H1.slice(SECRET_LINK_KEY_PREFIX.length);

      expect(await readResolverPhase1(handle)).toEqual({ rec: blob('r1'), cov: blob('c1') });

      const p2 = await readResolverPhase2(handle, E1.entryId);
      expect(p2.recCt).toBe('r1');
      expect(p2.covCt).toBe('c1');
      expect(p2.headEntry).toEqual(E1);
      expect(p2.entries).toEqual([E1]);
      expect(p2.rows).toEqual([[E1.entryId, E1.metaIv]]);

      const issue = await readIssueSnapshot(handle, E1.entryId);
      expect(issue.recCt).toBe('r1');
      expect(issue.covCt).toBe('c1');
      expect(issue.headMetaIv).toBe(E1.metaIv);
      expect(issue.rows).toEqual([[E1.entryId, E1.metaIv]]);
      expect(issue.currentAuth.configId).toBe(CONFIG_ID);
      expect(issue.currentAuth.enabled).toBe(true);
      expect(issue.currentAuth.origins).toEqual(PIN_AUTH.origins);
      expect(issue.currentAuth.pinSeed).toEqual(PIN_SEED);
      expect(issue.currentAuth.quickUnlock).toEqual({ kind: 'none' });
      expect(issue.currentAuth.lockGeneration).toBe(0);
    });

    it('readIssueSnapshot feeds issueSnapshotEquals as is: fresh device (no counter) → true; any change → false', async () => {
      await writeLightAuthState();
      await commitSafeboxEntry(E1, vault(), [
        { key: H1, expect: { present: false }, blob: blob('r1') },
        { key: SECRET_LINK_COVERAGE_KEY, expect: { present: false }, blob: blob('c1') },
      ]);
      await deleteMeta(VAULT_LOCK_GENERATION_KEY); // lockApp never ran on this device
      const handle = H1.slice(SECRET_LINK_KEY_PREFIX.length);
      const read = () => readIssueSnapshot(handle, E1.entryId);
      const first = await read();
      expect(first.currentAuth.lockGeneration).toBeUndefined();
      const snap: IssueSnapshot = {
        recCt: first.recCt!, covCt: first.covCt!, headMetaIv: first.headMetaIv!, rows: first.rows, auth: PIN_AUTH,
      };
      const fresh = async (auth: AuthSnapshot = PIN_AUTH) =>
        issueSnapshotEquals(await read(), { ...snap, auth }, auth, pinSeedEquals);
      expect(await fresh()).toBe(true);

      // The real pinSeedEquals: iv / salt / kdf / v each matter at the same ciphertext.
      for (const over of [{ iv: b64(12, 9) }, { salt: b64(16, 9) }, { kdf: 'pbkdf2' }, { v: 1 }]) {
        await setMeta('pin-seed', { ...PIN_SEED, ...over });
        expect(await fresh()).toBe(false);
      }
      await setMeta('pin-seed', PIN_SEED);
      expect(await fresh()).toBe(true);

      await setMeta(VAULT_LOCK_GENERATION_KEY, 0);
      expect(await fresh()).toBe(true);
      await bumpLockGeneration();
      expect(await fresh()).toBe(false);
      await deleteMeta(VAULT_LOCK_GENERATION_KEY);

      // PRF: the same record, then a damaged pin-seed under it.
      const pk = b64(32, 3);
      const record: QuickUnlockRecord = {
        v: 1, credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', prfSalt: b64(32), hkdfSalt: b64(32),
        iv: b64(12), ciphertext: b64(48), pk, createdAt: 1_700_000_000_000,
      };
      await setMeta(QUICK_UNLOCK_META_KEY, record);
      await setMeta('vault-public-key', pk);
      const prfAuth: AuthSnapshot = {
        factor: 'prf', prfRecord: record, pinPresent: true, enabled: true,
        origins: PIN_AUTH.origins, configId: CONFIG_ID, lockGeneration: 0,
      };
      expect(await fresh(prfAuth)).toBe(true);
      await setMeta(QUICK_UNLOCK_META_KEY, { ...record, iv: b64(12, 5) });
      expect(await fresh(prfAuth)).toBe(false);
      await setMeta(QUICK_UNLOCK_META_KEY, record);
      await setMeta('pin-seed', {});
      expect(await fresh(prfAuth)).toBe(false);
      await deleteMeta('pin-seed');
      expect(await fresh(prfAuth)).toBe(false);
    });

    it('missing/malformed record, coverage and head read as null', async () => {
      await setMeta(H1, { v: 1, ct: 'no-iv' });
      const p2 = await readResolverPhase2(H1.slice(SECRET_LINK_KEY_PREFIX.length), E1.entryId);
      expect(p2.recCt).toBeNull();
      expect(p2.covCt).toBeNull();
      expect(p2.headEntry).toBeUndefined();
      const issue = await readIssueSnapshot('nope', E1.entryId);
      expect(issue.headMetaIv).toBeNull();
      await setMeta(SAFEBOX_PIN_META_KEY, { garbage: true });
      expect((await readIssueSnapshot('nope', E1.entryId)).currentAuth.configId).toBeNull();
    });
  });

  describe('lock generation', () => {
    it('two concurrent bumps from the same g yield g+1 and g+2', async () => {
      await setMeta(VAULT_LOCK_GENERATION_KEY, 7);
      const results = await Promise.all([bumpLockGeneration(), bumpLockGeneration()]);
      expect(results.sort()).toEqual([8, 9]);
      expect(await readLockGeneration()).toBe(9);
    });

    it('absent counter reads as 0 and bumps to 1', async () => {
      await deleteMeta(VAULT_LOCK_GENERATION_KEY);
      expect(await readLockGeneration()).toBe(0);
      expect(await bumpLockGeneration()).toBe(1);
    });

    it('resetAll carries the counter: g=0 → 1, g>0 → g+1, everything else cleared', async () => {
      await deleteMeta(VAULT_LOCK_GENERATION_KEY);
      await resetAll();
      expect(await readLockGeneration()).toBe(1);

      await setMeta(VAULT_LOCK_GENERATION_KEY, 41);
      await writeConfig();
      await setMeta(H1, blob('r'));
      await commitSafeboxEntry(E1, vault({ lockGeneration: 41 }));
      await resetAll();
      expect(await readLockGeneration()).toBe(42);
      expect(await getMeta(H1)).toBeUndefined();
      expect(await getMeta(SAFEBOX_PIN_META_KEY)).toBeUndefined();
      expect(await countSafeboxEntries()).toBe(0);
    });
  });
});

// ═══ Writers over real storage and real crypto (plan §1.3, P1 «Тесты») ═══
//
// The single-entry writer and the rebuild (secret-link-index.ts) against the
// CAS-writer above. «The resolver» here is a MODEL of plan §1.3 phases 1–2
// (P2 is not implemented): the real readers + coverageDelta + the real
// decryption, so «резолвер отказывает / выдаёт X» is checked on stored bytes.

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let metaKey: CryptoKey;
let secretKey: CryptoKey;
let kLink: CryptoKey;

beforeAll(async () => {
  metaKey = await deriveSafeboxMetaKey(MN);
  secretKey = await deriveSafeboxSecretKey(MN);
  kLink = await deriveSecretLinkKey(MN);
});

beforeEach(() => {
  storageHooks.beforeSnapshot.length = 0;
  storageHooks.afterSnapshot.length = 0;
  storageHooks.errors.length = 0;
  vi.mocked(commitSafeboxEntry).mockClear();
  vi.mocked(commitSecretLinkIndex).mockClear();
  kdfHooks.beforeArgon2 = null;
  flagState.secretLink = true;
});

interface Version { entry: EncryptedSafeboxEntry; meta: SafeboxEntryData }

/** One real encrypted version; `t` pins the authenticated createdAt. */
async function version(over: { root?: string; prev?: string; rev?: number; t?: number } = {}): Promise<Version> {
  const clock = over.t !== undefined ? vi.spyOn(Date, 'now').mockReturnValue(over.t) : null;
  try {
    const entry = await encryptSafeboxEntry(metaKey, secretKey, {
      title: 't', login: '', url: '', note: '', password: 'pw', files: [],
      rev: over.rev ?? 1, root: over.root, prev: over.prev,
    });
    return { entry, meta: await decryptSafeboxMeta(metaKey, entry) };
  } finally {
    clock?.mockRestore();
  }
}

/** The next version of a chain. */
const next = (v: Version, t?: number) => version({ root: v.meta.root, prev: v.meta.id, rev: v.meta.rev + 1, t });

const LIVE: MaintenanceOp = { stillValid: () => true };

function writeOne(v: Version, over: Partial<EntryIndexInput> = {}) {
  return commitEntryWithSecretLink({
    entry: v.entry, meta: v.meta, kLink, metaKey,
    configId: CONFIG_ID, dbGeneration: getDbGeneration(),
    mop: LIVE, deadError: () => new Error('dead'),
    ...over,
  });
}

/** An old build's writer: the entry alone, no index maintenance at all. */
const oldWriter = (v: Version) => commitSafeboxEntry(v.entry, CONFIG_ID, getDbGeneration());

const rebuild = (mop: MaintenanceOp = LIVE, now?: () => number) =>
  rebuildSecretLinkIndex(kLink, metaKey, mop, now ? { now } : {});

const keyOf = async (root: string) => SECRET_LINK_KEY_PREFIX + await secretLinkHandle(kLink, root);

async function indexRecordOf(root: string): Promise<IndexRecord | null> {
  const raw = await getMeta(await keyOf(root));
  const c = classifyKey(
    raw === undefined ? { present: false } : { present: true, raw }, 'index', Date.now(),
    await tryDecryptIndexBlob(metaKey, raw),
  );
  return c.kind === 'live' ? c.record : null;
}

async function coverageRows(): Promise<CoverageRow[] | null> {
  const raw = await getMeta(SECRET_LINK_COVERAGE_KEY);
  const c = classifyKey(
    raw === undefined ? { present: false } : { present: true, raw }, 'coverage', Date.now(),
    await tryDecryptIndexBlob(metaKey, raw),
  );
  return c.kind === 'live' ? c.record.rows : null;
}

const rowOf = (v: Version): CoverageRow => [v.entry.entryId, v.entry.metaIv];
const sortedRows = (...vs: Version[]) => vs.map(rowOf).sort((a, b) => (a[0] < b[0] ? -1 : 1));

type Resolved = { ok: true; headId: string } | { ok: false; reason: string };

/** Model of the resolver, plan §1.3 phases 1–2 (one pass, no retry). */
async function resolve(root: string): Promise<Resolved> {
  const no = (reason: string): Resolved => ({ ok: false, reason });
  const handle = await secretLinkHandle(kLink, root);
  const now = Date.now();
  const p1 = await readResolverPhase1(handle);
  const rec = classifyKey(
    p1.rec === undefined ? { present: false } : { present: true, raw: p1.rec }, 'index', now,
    await tryDecryptIndexBlob(metaKey, p1.rec),
  );
  const cov = classifyKey(
    p1.cov === undefined ? { present: false } : { present: true, raw: p1.cov }, 'coverage', now,
    await tryDecryptIndexBlob(metaKey, p1.cov),
  );
  if (rec.kind !== 'live') return no('index');
  if (cov.kind !== 'live') return no('coverage');
  if (await secretLinkHandle(kLink, rec.record.root) !== handle) return no('binding');
  const p2 = await readResolverPhase2(handle, rec.record.head.id);
  if (p2.recCt !== rec.ct || p2.covCt !== cov.ct) return no('changed');
  if (!p2.headEntry) return no('head-missing');
  const { delta, missing } = coverageDelta(p2.rows, cov.record.rows);
  if (missing.length > 0) return no('missing');
  if (delta.length > 200) return no('delta-size');
  for (const [id, iv] of delta) {
    const e = p2.entries.find(x => x.entryId === id && x.metaIv === iv)!;
    let m: SafeboxEntryData;
    try {
      m = await decryptSafeboxMeta(metaKey, e);
    } catch {
      return no('delta-undecryptable');
    }
    if (m.root === rec.record.root && m.id !== rec.record.head.id) return no('stale');
  }
  let head: SafeboxEntryData;
  try {
    head = await decryptSafeboxMeta(metaKey, p2.headEntry);
  } catch {
    return no('head-undecryptable');
  }
  const h = rec.record.head;
  if (head.id !== h.id || head.root !== rec.record.root || head.rev !== h.rev || head.createdAt !== h.createdAt) {
    return no('head-mismatch');
  }
  return { ok: true, headId: head.id };
}

const conflictKinds = () => storageHooks.errors
  .filter((e): e is SecretLinkConflictError => e instanceof SecretLinkConflictError)
  .map(e => e.kind);

/** Calls of commitSafeboxEntry for this entry: [expect-or-configId, writes]. */
const commitsOf = (v: Version) => vi.mocked(commitSafeboxEntry).mock.calls
  .filter(c => c[0] === v.entry)
  .map(c => c.slice(1));

function rotten(v: Version): Version {
  const buf = base64ToBuffer(v.entry.metaCiphertext);
  buf[0] ^= 0xff;
  return { entry: { ...v.entry, metaCiphertext: bufferToBase64(buf) }, meta: v.meta };
}

describe('secret-link writers: the race order (plan P1)', () => {
  it('writer B lands AFTER A\'s snapshot, before A\'s commit → key conflict, A retries; both rows covered', async () => {
    const x0 = await version();
    expect(await writeOne(x0)).toBe('indexed');
    const a = await version();
    const b = await version();
    storageHooks.afterSnapshot.push(async () => { expect(await writeOne(b)).toBe('indexed'); });

    expect(await writeOne(a)).toBe('indexed');

    expect(conflictKinds()).toEqual(['key']);
    expect((storageHooks.errors[0] as SecretLinkConflictError).key).toBe(SECRET_LINK_COVERAGE_KEY);
    expect(commitsOf(a)).toHaveLength(2);
    expect(await countSafeboxEntries()).toBe(3);
    expect(await coverageRows()).toEqual(sortedRows(x0, a, b));
    for (const v of [x0, a, b]) expect(await resolve(v.meta.root)).toEqual({ ok: true, headId: v.meta.id });
  });

  it('rebuild: B lands after the rebuild\'s snapshot → rows conflict, retried from a fresh snapshot', async () => {
    const a = await version();
    const b = await version();
    await oldWriter(a);
    storageHooks.afterSnapshot.push(async () => { await oldWriter(b); });

    expect(await rebuild()).toBe('rebuilt');

    expect(conflictKinds()).toEqual(['rows']);
    expect(vi.mocked(commitSecretLinkIndex)).toHaveBeenCalledTimes(2);
    expect(await coverageRows()).toEqual(sortedRows(a, b));
    expect((await resolve(b.meta.root)).ok).toBe(true);
  });

  it('B lands BEFORE A\'s snapshot → the snapshot already holds B, no conflict at all', async () => {
    const a = await version();
    const b = await version();
    expect(await writeOne(b)).toBe('indexed');
    expect(await writeOne(a)).toBe('indexed');
    expect(commitsOf(a)).toHaveLength(1);

    const c = await version();
    await oldWriter(c);
    expect(await rebuild()).toBe('rebuilt');
    expect(vi.mocked(commitSecretLinkIndex)).toHaveBeenCalledTimes(1);
    expect(storageHooks.errors).toEqual([]);
    expect(await coverageRows()).toEqual(sortedRows(a, b, c));
  });

  it('rebuild ∥ rebuild: one commits, the other re-reads and finds nothing to change', async () => {
    const a = await version();
    const b = await version();
    await oldWriter(a);
    await oldWriter(b);
    const outcomes = await Promise.all([rebuild(), rebuild()]);
    expect(outcomes.sort()).toEqual(['rebuilt', 'unchanged']);
    expect(conflictKinds()).toEqual(['key']);
    expect(await coverageRows()).toEqual(sortedRows(a, b));
    expect((await resolve(a.meta.root)).ok).toBe(true);
    expect((await resolve(b.meta.root)).ok).toBe(true);
  });

  it('rebuild works from its OWN snapshot: rows the snapshot holds, not what anybody decrypted earlier', async () => {
    const a = await version();
    const r = rotten(await version());
    await oldWriter(a);
    await oldWriter(r);
    const c = await version();
    // A row that lands just before the rebuild reads — no caller list has it.
    storageHooks.beforeSnapshot.push(async () => { await oldWriter(c); });
    expect(await rebuild()).toBe('rebuilt');
    // Undecryptable rows stay OUTSIDE the coverage.
    expect(await coverageRows()).toEqual(sortedRows(a, c));
    expect((await indexRecordOf(c.meta.root))!.head.id).toBe(c.meta.id);
    // …and the damaged row, being in nobody's coverage, keeps the resolver closed.
    expect(await resolve(c.meta.root)).toEqual({ ok: false, reason: 'delta-undecryptable' });
  });
});

describe('secret-link writers: malformed index/coverage (plan §1.3 table)', () => {
  async function damagedCases(a: Version): Promise<Array<{ key: string; value: unknown }>> {
    const otherRoot = (await version()).meta.root;
    return [
      { key: SECRET_LINK_COVERAGE_KEY, value: { garbage: 1 } },
      { key: SECRET_LINK_COVERAGE_KEY, value: blob('bm90IGEgY2lwaGVydGV4dA==') }, // IndexBlob, not ours
      { key: SECRET_LINK_COVERAGE_KEY, value: await encryptIndexBlob(metaKey, { v: 1, rows: [['b', 'x'], ['a', 'y']] }) },
      { key: await keyOf(a.meta.root), value: null },
      { key: await keyOf(a.meta.root), value: blob('bm90IGEgY2lwaGVydGV4dA==') },
      // A live record under OUR handle that names another root.
      { key: await keyOf(a.meta.root), value: await encryptIndexBlob(metaKey, {
        v: 1, root: otherRoot, head: { id: otherRoot, rev: 1, createdAt: 1 }, indexedAt: 1,
      }) },
    ];
  }

  it('ordinary writer: exactly one entry, NO index writes, damaged key untouched, resolver refuses', async () => {
    const probe = await version();
    for (const { key, value } of await damagedCases(probe)) {
      await resetAll();
      await setMeta(VAULT_LOCK_GENERATION_KEY, 0);
      await writeConfig();
      vi.mocked(commitSafeboxEntry).mockClear();
      await setMeta(key, value);

      expect(await writeOne(probe)).toBe('entry-only');
      expect(await countSafeboxEntries()).toBe(1);
      expect(commitsOf(probe)).toEqual([[vault()]]); // no `writes` argument at all
      expect(await getMeta(key)).toEqual(value);
      expect((await resolve(probe.meta.root)).ok).toBe(false);
    }
  });

  it('malformed appearing between snapshot and commit → key conflict → reclassified → the same outcome', async () => {
    const x0 = await version();
    await writeOne(x0);
    const a = await version();
    storageHooks.afterSnapshot.push(async () => { await setMeta(SECRET_LINK_COVERAGE_KEY, { damaged: true }); });

    expect(await writeOne(a)).toBe('entry-only');

    expect(conflictKinds()).toEqual(['key']);
    expect(commitsOf(a)).toHaveLength(2);
    expect(commitsOf(a)[1]).toHaveLength(1); // the second commit carries no writes
    expect(await countSafeboxEntries()).toBe(2);
    expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toEqual({ damaged: true });
    expect((await resolve(a.meta.root)).ok).toBe(false);
    expect((await resolve(x0.meta.root)).ok).toBe(false); // coverage gone for everybody
  });

  it('three key conflicts in a row → the entry alone (entry-only fallback)', async () => {
    const x0 = await version();
    await writeOne(x0);
    const a = await version();
    const churn = async () => {
      await setMeta(SECRET_LINK_COVERAGE_KEY, await encryptIndexBlob(metaKey, { v: 1, rows: [rowOf(x0)] }));
    };
    storageHooks.afterSnapshot.push(churn, churn, churn);
    expect(await writeOne(a)).toBe('entry-only');
    expect(conflictKinds()).toEqual(['key', 'key', 'key']);
    expect(commitsOf(a)).toHaveLength(4);
    expect(await countSafeboxEntries()).toBe(2);
  });

  it('rebuild replaces / deletes damaged keys through expect {raw} — and only through it', async () => {
    const a = await version();
    await oldWriter(a);
    const own = await keyOf(a.meta.root);
    const stray = SECRET_LINK_KEY_PREFIX + 'AAAAAAAAAAAAAAAAAAAAAA';
    await setMeta(own, { bad: 1 });
    await setMeta(stray, [1, [2, null]]);
    await setMeta(SECRET_LINK_COVERAGE_KEY, 'garbage');

    expect(await rebuild()).toBe('rebuilt');

    const writes = vi.mocked(commitSecretLinkIndex).mock.calls[0][0];
    const expects = Object.fromEntries(writes.map(w => [w.key, w.expect])) as Record<string, KeyExpect>;
    expect(expects[own]).toEqual({ present: true, raw: { bad: 1 } });
    expect(expects[stray]).toEqual({ present: true, raw: [1, [2, null]] });
    expect(expects[SECRET_LINK_COVERAGE_KEY]).toEqual({ present: true, raw: 'garbage' });
    expect((await readSecretLinkSnapshot()).index.has(stray)).toBe(false);
    expect(await resolve(a.meta.root)).toEqual({ ok: true, headId: a.meta.id });
  });

  it('a malformed value that keeps changing between snapshot and commit is never overwritten', async () => {
    const a = await version();
    await oldWriter(a);
    await setMeta(SECRET_LINK_COVERAGE_KEY, { bad: 0 });
    let n = 0;
    const mutate = async () => { await setMeta(SECRET_LINK_COVERAGE_KEY, { bad: ++n }); };
    storageHooks.afterSnapshot.push(mutate, mutate, mutate);

    expect(await rebuild()).toBe('gave-up');
    expect(conflictKinds()).toEqual(['key', 'key', 'key']);
    expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toEqual({ bad: 3 });
    expect(await getMeta(await keyOf(a.meta.root))).toBeUndefined(); // rolled back with it
  });

  it('object/array raw reaches expect.raw unserialized: NaN, undefined member, array hole', async () => {
    const a = await version();
    await oldWriter(a);
    const strayObj = SECRET_LINK_KEY_PREFIX + 'DDDDDDDDDDDDDDDDDDDDDD';
    const strayArr = SECRET_LINK_KEY_PREFIX + 'EEEEEEEEEEEEEEEEEEEEEE';
    await setMeta(strayObj, { x: NaN, y: undefined });
    // eslint-disable-next-line no-sparse-arrays
    await setMeta(strayArr, [1, , 3]);

    expect(await rebuild()).toBe('rebuilt');

    const writes = vi.mocked(commitSecretLinkIndex).mock.calls[0][0];
    const byKey = Object.fromEntries(writes.map(w => [w.key, w.expect])) as Record<string, KeyExpect>;
    // A JSON round-trip would turn NaN into null, drop `y` and fill the hole.
    const obj = (byKey[strayObj] as { raw: Record<string, unknown> }).raw;
    expect(Number.isNaN(obj.x)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(obj, 'y')).toBe(true);
    const arr = (byKey[strayArr] as { raw: unknown[] }).raw;
    expect(arr).toHaveLength(3);
    expect(1 in arr).toBe(false);
    const snap = await readSecretLinkSnapshot();
    expect(snap.index.has(strayObj)).toBe(false);
    expect(snap.index.has(strayArr)).toBe(false);
  });

  it('raw outside RawComparable (Date, Map, cycle) → the rebuild leaves the key alone, with a warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = await version();
      const b = await version();
      await oldWriter(a);
      await oldWriter(b);
      const cyclic: Record<string, unknown> = { v: 1 };
      cyclic.self = cyclic;
      const ownA = await keyOf(a.meta.root);
      const strayMap = SECRET_LINK_KEY_PREFIX + 'BBBBBBBBBBBBBBBBBBBBBB';
      const strayCycle = SECRET_LINK_KEY_PREFIX + 'CCCCCCCCCCCCCCCCCCCCCC';
      await setMeta(ownA, new Date(0));
      await setMeta(strayMap, new Map([['k', 1]]));
      await setMeta(strayCycle, cyclic);

      expect(await rebuild()).toBe('rebuilt');

      const domainWarnings = warn.mock.calls.filter(c => /outside the comparable domain/.test(String(c[0])));
      expect(domainWarnings).toHaveLength(3);
      expect(await getMeta(ownA)).toBeInstanceOf(Date);
      expect(await getMeta(strayMap)).toBeInstanceOf(Map);
      const kept = await getMeta<Record<string, unknown>>(strayCycle);
      expect(kept!.self).toBe(kept);
      // Everything else was still maintained.
      expect(await coverageRows()).toEqual(sortedRows(a, b));
      expect((await resolve(b.meta.root)).ok).toBe(true);
      expect((await resolve(a.meta.root)).ok).toBe(false);

      // The same for a coverage value outside the domain: left, warned.
      warn.mockClear();
      await setMeta(SECRET_LINK_COVERAGE_KEY, new Date(1));
      await rebuild();
      expect(warn.mock.calls.some(c => /coverage holds a value outside/.test(String(c[0])))).toBe(true);
      expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toBeInstanceOf(Date);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('secret-link writers: coverage and the resolver model', () => {
  it('an old writer\'s new version is a fresh pair in the delta → the resolver refuses', async () => {
    const a0 = await version();
    await writeOne(a0);
    const a1 = await next(a0);
    await oldWriter(a1);

    const p2 = await readResolverPhase2(await secretLinkHandle(kLink, a0.meta.root), a0.meta.id);
    const { delta, missing } = coverageDelta(p2.rows, (await coverageRows())!);
    expect(delta).toEqual([rowOf(a1)]);
    expect(missing).toEqual([]);
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'stale' });
  });

  for (const via of ['old writer', 'entry-only fallback'] as const) {
    it(`cross-chain 5-H1 (${via}): B0 saved later does not cover A1; A never resolves to A0; rebuild → A1`, async () => {
      const a0 = await version();
      await writeOne(a0);
      const a1 = await next(a0);
      if (via === 'old writer') {
        await oldWriter(a1);
      } else {
        const churn = async () => {
          await setMeta(SECRET_LINK_COVERAGE_KEY, await encryptIndexBlob(metaKey, { v: 1, rows: [rowOf(a0)] }));
        };
        storageHooks.afterSnapshot.push(churn, churn, churn);
        expect(await writeOne(a1)).toBe('entry-only');
      }
      const b0 = await version();
      expect(await writeOne(b0)).toBe('indexed');

      const rows = (await coverageRows())!;
      expect(rows).toContainEqual(rowOf(b0));
      expect(rows).not.toContainEqual(rowOf(a1));
      expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'stale' });
      expect(await resolve(b0.meta.root)).toEqual({ ok: true, headId: b0.meta.id });

      expect(await rebuild()).toBe('rebuilt');
      expect(await resolve(a0.meta.root)).toEqual({ ok: true, headId: a1.meta.id });
    });
  }

  it('the same id with another payload → missing AND delta → refused', async () => {
    const a0 = await version();
    await writeOne(a0);
    const replaced = { ...a0.entry, metaIv: b64(12, 7) };
    await commitSafeboxEntry(replaced, CONFIG_ID, getDbGeneration());
    const p2 = await readResolverPhase2(await secretLinkHandle(kLink, a0.meta.root), a0.meta.id);
    const { delta, missing } = coverageDelta(p2.rows, (await coverageRows())!);
    expect(delta).toEqual([[a0.entry.entryId, replaced.metaIv]]);
    expect(missing).toEqual([rowOf(a0)]);
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'missing' });
  });

  it('a damaged row outside the coverage → refused, before and after a rebuild (never covered)', async () => {
    const a0 = await version();
    await writeOne(a0);
    const r = rotten(await version());
    await oldWriter(r);
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'delta-undecryptable' });
    expect(await rebuild()).toBe('unchanged'); // the coverage already is «every row that decrypts»
    expect(await coverageRows()).toEqual([rowOf(a0)]);
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'delta-undecryptable' });
  });

  it('damaged coverage → the resolver refuses', async () => {
    const a0 = await version();
    await writeOne(a0);
    await setMeta(SECRET_LINK_COVERAGE_KEY, blob('bm90IGEgY2lwaGVydGV4dA=='));
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'coverage' });
  });

  it('rows unsorted or duplicated → the validator refuses, the writer leaves them, the rebuild repairs', async () => {
    const a0 = await version();
    const b0 = await version();
    const [r1, r2] = sortedRows(a0, b0);
    expect(isCoverageRecord({ v: 1, rows: [r1, r2] })).toBe(true);
    expect(isCoverageRecord({ v: 1, rows: [r2, r1] })).toBe(false);
    expect(isCoverageRecord({ v: 1, rows: [r1, r1] })).toBe(false);

    await oldWriter(a0);
    const unsorted = await encryptIndexBlob(metaKey, { v: 1, rows: [r2, r1] });
    await setMeta(SECRET_LINK_COVERAGE_KEY, unsorted);
    expect(await writeOne(b0)).toBe('entry-only');
    expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toEqual(unsorted);
    expect((await resolve(b0.meta.root)).ok).toBe(false);
    expect(await rebuild()).toBe('rebuilt');
    expect(await coverageRows()).toEqual([r1, r2]);
    expect((await resolve(b0.meta.root)).ok).toBe(true);
  });

  it('head tie-break is byCurrentness (createdAt, rev, id); the writer never downgrades it; rebuild agrees', async () => {
    const v1 = await version({ t: 1_000 });
    const v2 = await next(v1, 1_000);                                   // same t, higher rev
    const v2b = await version({ root: v1.meta.root, prev: v1.meta.id, rev: 2, t: 1_000 }); // fork: tie → id
    const v0 = await version({ root: v1.meta.root, prev: v1.meta.id, rev: 9, t: 500 });   // older clock
    await writeOne(v1);
    await writeOne(v2);
    expect((await indexRecordOf(v1.meta.root))!.head.id).toBe(v2.meta.id);
    await writeOne(v2b);
    const expected = [v2.meta, v2b.meta].sort(byCurrentness)[0];
    expect(chooseHead([v2.meta, v2b.meta])).toBe(expected);
    expect((await indexRecordOf(v1.meta.root))!.head.id).toBe(expected.id);
    await writeOne(v0);
    expect((await indexRecordOf(v1.meta.root))!.head.id).toBe(expected.id);
    // Everything was written by the writer, so the coverage is complete: the
    // rebuild has nothing to change, and the resolver serves the same head.
    expect(await rebuild()).toBe('unchanged');
    expect(await resolve(v1.meta.root)).toEqual({ ok: true, headId: expected.id });
  });
});

// ─── Receipts (P3 writes them; P1 owns their classification and CAS) ─

// NOTE: P1 has no drop writer yet. `drop` below is a TEST MODEL of plan §1.3
// step 1; what is under test is the product code it calls — classifyKey, the
// KeyExpect CAS of the commit, and the rebuild's collection of expired
// receipts. Outcomes such as «zero writes» or «one replacement» are properties
// of this model and must be re-proven on the real dropSafeboxEntry in P3.
describe('secret-link receipts: classification + CAS (drop writer modelled on plan §1.3 step 1)', () => {
  const ORIGIN = 'https://baobook.app';
  const OP_ID = '6f1d6a3e-2b1c-4d7e-9a8b-0c1d2e3f4a5b';
  const R_KEY = SECRET_OP_KEY_PREFIX + ORIGIN + ':' + OP_ID;

  function receipt(committedAt: number, link = 'L1'): ReceiptRecord {
    return { v: 1, opOrigin: ORIGIN, opId: OP_ID, handle: 'TnYgaHGXuUjYvmglbl6DhA', link, title: 't', committedAt };
  }

  type DropOutcome = { kind: 'committed' } | { kind: 'existing'; link: string } | { kind: 'storage' };

  /** Receipt-first, then entry + receipt in ONE commit (the «three conflicts»
   *  shape of §1.3 step 3); a `key` conflict re-classifies (≤3). `onEncrypt`
   *  runs between classification and commit (the clock may move there). */
  async function drop(v: Version, link: string, clock: { now: number }, onEncrypt?: () => void): Promise<DropOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await readSecretLinkSnapshot();
      const slot = snap.receipts.has(R_KEY) ? { present: true as const, raw: snap.receipts.get(R_KEY) } : { present: false as const };
      const c = classifyKey(slot, 'receipt', clock.now, slot.present ? await tryDecryptIndexBlob(metaKey, slot.raw) : undefined);
      if (c.kind === 'malformed') return { kind: 'storage' };
      if (c.kind === 'live') return { kind: 'existing', link: c.record.link };
      const expectR: KeyExpect = c.kind === 'expired' ? { present: true, ct: c.ct } : { present: false };
      const rBlob = await encryptIndexBlob(metaKey, receipt(clock.now, link));
      onEncrypt?.();
      try {
        await commitSafeboxEntry(v.entry, light({ lockGeneration: snap.lockGeneration }), [{ key: R_KEY, expect: expectR, blob: rBlob }]);
        return { kind: 'committed' };
      } catch (e) {
        if (e instanceof SecretLinkConflictError && e.kind === 'key') continue;
        throw e;
      }
    }
    return { kind: 'storage' };
  }

  const receiptLink = async () => {
    const raw = await getMeta(R_KEY);
    const d = await tryDecryptIndexBlob(metaKey, raw);
    return d.ok ? (d.plain as ReceiptRecord).link : null;
  };

  beforeEach(async () => { await writeLightAuthState(); });

  it('live → the previous result, nothing written', async () => {
    const now = 10 * SECRET_RECEIPT_TTL_MS;
    await setMeta(R_KEY, await encryptIndexBlob(metaKey, receipt(now - 1, 'OLD')));
    expect(await drop(await version(), 'NEW', { now })).toEqual({ kind: 'existing', link: 'OLD' });
    expect(await countSafeboxEntries()).toBe(0);
  });

  it('expired → replaced atomically with the entry (expect {ct} of the old one)', async () => {
    const now = 10 * SECRET_RECEIPT_TTL_MS;
    await setMeta(R_KEY, await encryptIndexBlob(metaKey, receipt(now - SECRET_RECEIPT_TTL_MS, 'OLD')));
    expect(await drop(await version(), 'NEW', { now })).toEqual({ kind: 'committed' });
    expect(await countSafeboxEntries()).toBe(1);
    expect(await receiptLink()).toBe('NEW');
  });

  it('malformed → typed storage refusal, zero records', async () => {
    await setMeta(R_KEY, { not: 'a blob' });
    expect(await drop(await version(), 'NEW', { now: 1 })).toEqual({ kind: 'storage' });
    expect(await countSafeboxEntries()).toBe(0);
    expect(await getMeta(R_KEY)).toEqual({ not: 'a blob' });
  });

  it('malformed appearing between snapshot and commit → key → re-classified → zero records', async () => {
    storageHooks.afterSnapshot.push(async () => { await setMeta(R_KEY, { not: 'a blob' }); });
    expect(await drop(await version(), 'NEW', { now: 1 })).toEqual({ kind: 'storage' });
    expect(conflictKinds()).toEqual(['key']);
    expect(await countSafeboxEntries()).toBe(0);
    expect(await getMeta(R_KEY)).toEqual({ not: 'a blob' });
  });

  it('GC race: the rebuild collects the expired receipt after the snapshot → key → absent → one record', async () => {
    const now = 10 * SECRET_RECEIPT_TTL_MS;
    await setMeta(R_KEY, await encryptIndexBlob(metaKey, receipt(now - SECRET_RECEIPT_TTL_MS, 'OLD')));
    storageHooks.afterSnapshot.push(async () => {
      expect(await rebuild(LIVE, () => now)).toBe('rebuilt');
      expect(await getMeta(R_KEY)).toBeUndefined();
    });
    expect(await drop(await version(), 'NEW', { now })).toEqual({ kind: 'committed' });
    expect(conflictKinds()).toEqual(['key']);
    expect(await countSafeboxEntries()).toBe(1);
    expect(await receiptLink()).toBe('NEW');
  });

  it('expiry during encryption does not change the decision taken from the snapshot', async () => {
    const t0 = 10 * SECRET_RECEIPT_TTL_MS;
    // Absent at t0: the commit expects {present:false}, whatever the clock does.
    const clock = { now: t0 };
    expect(await drop(await version(), 'A', clock, () => { clock.now += 2 * SECRET_RECEIPT_TTL_MS; }))
      .toEqual({ kind: 'committed' });
    // The receipt carries t0 (taken before the clock moved). Live 1 ms before
    // its expiry: no write, even though it expires during this encryption.
    const late = { now: t0 + SECRET_RECEIPT_TTL_MS - 1 };
    expect(await drop(await version(), 'B', late, () => { late.now += 10; }))
      .toEqual({ kind: 'existing', link: 'A' });
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('two windows both seeing the same expired receipt → exactly one replacement', async () => {
    const now = 10 * SECRET_RECEIPT_TTL_MS;
    await setMeta(R_KEY, await encryptIndexBlob(metaKey, receipt(now - SECRET_RECEIPT_TTL_MS, 'OLD')));
    const [x, y] = await Promise.all([
      drop(await version(), 'X', { now }),
      drop(await version(), 'Y', { now }),
    ]);
    const outcomes = [x, y];
    const committed = outcomes.filter(o => o.kind === 'committed');
    expect(committed).toHaveLength(1);
    const winner = await receiptLink();
    expect(outcomes).toContainEqual({ kind: 'existing', link: winner });
    expect(await countSafeboxEntries()).toBe(1);
  });
});

// ─── §2.6 п.4: storage failures inside the commit ───────────────────

describe('secret-link writers: quota / abort while committing with writes', () => {
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } })
    .IDBObjectStore.prototype;
  const realPut = proto.put;
  afterEach(() => { proto.put = realPut; });

  const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

  for (const how of ['quota (thrown by put)', 'abort (after the put)'] as const) {
    it(`${how} on the coverage write → nothing written: no entry, no index`, async () => {
      const x0 = await version();
      await writeOne(x0);
      const covBefore = await getMeta(SECRET_LINK_COVERAGE_KEY);
      const a = await version();
      proto.put = function (this: { transaction: IDBTransaction }, ...args: unknown[]) {
        if (args[1] === SECRET_LINK_COVERAGE_KEY) {
          if (how.startsWith('quota')) throw quotaError();
          const req = realPut.apply(this, args);
          this.transaction.abort();
          return req;
        }
        return realPut.apply(this, args);
      };

      await expect(writeOne(a)).rejects.toBeDefined();
      proto.put = realPut;
      expect(await countSafeboxEntries()).toBe(1);
      expect(await getMeta(await keyOf(a.meta.root))).toBeUndefined();
      expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toEqual(covBefore);
    });
  }

  it('quota during a rebuild commit → failed, nothing written, the previous index stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = await version();
      await oldWriter(a);
      proto.put = function (this: unknown, ...args: unknown[]) {
        if (args[1] === SECRET_LINK_COVERAGE_KEY) throw quotaError();
        return realPut.apply(this, args);
      };
      expect(await rebuild()).toBe('failed');
      proto.put = realPut;
      expect(await getMeta(await keyOf(a.meta.root))).toBeUndefined();
      expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

// ═══ Store integration (NotesProvider over real storage) ═══════════

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() {
  return render(<NotesProvider><Probe /></NotesProvider>);
}

const PIN = '135790';
const MAIN_PIN = '2580';
const NEW_ENTRY = { title: 'GitHub', login: 'yoko', url: 'https://github.com', note: '', password: 'PW', files: [] };

async function openMain(opts: { pin?: string } = {}) {
  await waitFor(() => expect(store.isReady).toBe(true));
  await act(async () => { await store.confirmMnemonic(MN, opts); });
  await waitFor(() => expect(store.screen).toBe('main'));
}
async function openSafebox() {
  await openMain();
  await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
  await waitFor(() => expect(store.safeboxUnlocked).toBe(true));
}
/** A real safebox PIN config written straight to storage — the section is
 *  configured, but nobody in this tab has entered its PIN. */
async function configureSafeboxElsewhere(): Promise<void> {
  await commitSafeboxPinWrite(await createSafeboxPinBlob(PIN), 'seed-authorized', getDbGeneration());
}
/** The CURRENT config's id (the store activates its own). */
const currentConfigId = async () => (await readSafeboxPinConfig())!.configId;

/**
 * `lockDurableRef` has no reader in P1 (P2's `stillValid` is the consumer)
 * and is deliberately not part of the store API — read it from the provider's
 * hook list. The ref is located once, at mount, as the ONLY ref holding
 * 'idle' (the one string-initialised ref in store.tsx).
 */
function lockDurableProbe(container: HTMLElement): () => unknown {
  type Hook = { memoizedState: unknown; next: Hook | null };
  type Fiber = {
    type: unknown; child: Fiber | null; sibling: Fiber | null; memoizedState: Hook | null;
    stateNode: { current: Fiber } | null;
  };
  const rootKey = Object.keys(container).find(k => k.startsWith('__reactContainer$'))!;
  // The HostRoot recorded at createRoot may be the alternate: go through the
  // FiberRoot to the CURRENT tree.
  const hostRoot = (container as unknown as Record<string, Fiber>)[rootKey];
  const stack: Array<Fiber | null> = [hostRoot.stateNode!.current];
  let provider: Fiber | null = null;
  while (stack.length > 0 && provider === null) {
    const f = stack.pop();
    if (!f) continue;
    if (f.type === NotesProvider) provider = f;
    stack.push(f.sibling, f.child);
  }
  const refs: Array<{ current: unknown }> = [];
  for (let h = provider!.memoizedState; h; h = h.next) {
    const s = h.memoizedState as { current?: unknown } | null;
    if (s && typeof s === 'object' && Object.keys(s).length === 1 && s.current === 'idle') refs.push(s as { current: unknown });
  }
  expect(refs).toHaveLength(1);
  return () => refs[0].current;
}

function installNavigator() {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText },
    locks: { request: async (_n: string, _o: unknown, run: () => Promise<unknown>) => run() },
  });
  return writeText;
}

describe('store: secret-link maintenance', () => {
  let writeText: ReturnType<typeof installNavigator>;
  beforeEach(async () => {
    await deleteMeta(SAFEBOX_PIN_META_KEY);
    await setMeta('init', true);
    sessionStorage.clear();
    vi.mocked(fetchAllNotes).mockResolvedValue({ notes: [], safeboxEntries: [], incomplete: false });
    writeText = installNavigator();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  for (const flag of [false, true]) {
    it(`flag ${flag ? 'ON' : 'OFF'} + secret-links-enabled=false → the save still writes index + coverage (vault mode, no factor)`, async () => {
      flagState.secretLink = flag;
      await setMeta(SECRET_LINKS_ENABLED_KEY, false);
      renderStore();
      await openSafebox();
      await waitFor(async () => expect(await coverageRows()).toEqual([])); // the open's rebuild

      await act(async () => { await store.addSafeboxEntry(NEW_ENTRY); });
      const [mine] = store.safeboxEntries;
      expect(await resolve(mine.root)).toEqual({ ok: true, headId: mine.id });
      // The store's save went through the CAS-writer WITH index writes.
      const indexed = vi.mocked(commitSafeboxEntry).mock.calls.filter(c =>
        (c[0] as EncryptedSafeboxEntry).entryId === mine.id && Array.isArray(c[2]));
      expect(indexed.length).toBeGreaterThan(0);
      expect((indexed.at(-1)![2] as IndexWrite[]).map(w => w.key))
        .toEqual([await keyOf(mine.root), SECRET_LINK_COVERAGE_KEY]);

      if (!flag) {
        await expect(store.copySecretLink(mine.root)).rejects.toBeInstanceOf(SecretLinkDisabledError);
        expect(writeText).not.toHaveBeenCalled();
      } else {
        expect(await store.copySecretLink(mine.root)).toBe(true);
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}${import.meta.env.BASE_URL}#/s/${await secretLinkHandle(kLink, mine.root)}`,
        );
      }
    });
  }

  it('a damaged lock counter never blocks an ordinary save (§0.2): saved, indexed, section open', async () => {
    renderStore();
    await openSafebox();
    await waitFor(async () => expect(await coverageRows()).toEqual([]));
    await setMeta(VAULT_LOCK_GENERATION_KEY, 'x');

    await act(async () => { await store.addSafeboxEntry(NEW_ENTRY); });
    const [mine] = store.safeboxEntries;
    expect(await resolve(mine.root)).toEqual({ ok: true, headId: mine.id });
    expect(store.safeboxUnlocked).toBe(true);
  });

  it('a lock elsewhere between snapshot and commit (no broadcast) → SafeboxLockedError AND the section closes', async () => {
    renderStore();
    await openSafebox();
    await waitFor(async () => expect(await coverageRows()).toEqual([]));
    storageHooks.afterSnapshot.push(async () => { await bumpLockGeneration(); });

    let err: unknown = null;
    await act(async () => { await store.addSafeboxEntry(NEW_ENTRY).catch((e: unknown) => { err = e; }); });
    expect(err).toBeInstanceOf(SafeboxLockedError);
    expect(conflictKinds()).toContain('lock');
    expect(await countSafeboxEntries()).toBe(0);
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('opening by the seed with NO PIN (restore sweep, section locked) → the rebuild runs', async () => {
    await configureSafeboxElsewhere();
    const remote = await version();
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: [], safeboxEntries: [{ encrypted: remote.entry, meta: remote.meta, txId: 'TX-R' }], incomplete: false,
    });
    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await act(async () => { await store.restoreFromMnemonic(MN); });

    await waitFor(async () => expect(await resolve(remote.meta.root)).toEqual({ ok: true, headId: remote.meta.id }));
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('main PIN unlock with config-changed (another tab rewrote pin-seed mid-KDF) → opens; the index is maintained', async () => {
    const { container } = renderStore();
    void container;
    await openMain({ pin: MAIN_PIN });
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    act(() => { store.lockApp(); });
    await waitFor(() => expect(store.screen).not.toBe('main'));

    // The other tab's write lands while this tab's Argon2id runs.
    const replaced = await encryptWithPin(MN, MAIN_PIN);
    kdfHooks.beforeArgon2 = async () => { await setMeta('pin-seed', replaced); };
    await act(async () => { await store.unlockWithPin(MAIN_PIN); });
    await waitFor(() => expect(store.screen).toBe('main'));
    expect(await getMeta('pin-seed')).toEqual(replaced); // the old policy: nothing reset, nothing rewrapped

    await act(async () => { await store.unlockSafebox(PIN); });
    await act(async () => { await store.addSafeboxEntry(NEW_ENTRY); });
    const [mine] = store.safeboxEntries;
    await waitFor(async () => expect(await resolve(mine.root)).toEqual({ ok: true, headId: mine.id }));
  });

  it('the open\'s rebuild reads its OWN snapshot, not the list the section just published', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    await waitFor(async () => expect(await coverageRows()).toEqual([]));
    act(() => { store.lockSafebox(); });

    const late = await version();
    // Lands after the section decrypted its list, right before the rebuild reads.
    storageHooks.beforeSnapshot.push(async () => {
      await commitSafeboxEntry(late.entry, await currentConfigId(), getDbGeneration());
    });
    await act(async () => { await store.unlockSafebox(PIN); });

    await waitFor(async () => expect(await resolve(late.meta.root)).toEqual({ ok: true, headId: late.meta.id }));
    expect(store.safeboxEntries.map(e => e.id)).not.toContain(late.meta.id);
  });

  it('lockApp bumps the counter (done); a quota failure → lockDurableRef=failed, sticky; the lock itself holds', async () => {
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } })
      .IDBObjectStore.prototype;
    const realPut = proto.put;
    try {
      const { container } = renderStore();
      const durable = lockDurableProbe(container);
      await openSafebox();
      const g0 = await readLockGeneration();

      act(() => { store.lockApp(); });
      await waitFor(() => expect(durable()).toBe('done'));
      expect(await readLockGeneration()).toBe(g0 + 1);

      await openMain();
      proto.put = function (this: unknown, ...args: unknown[]) {
        if (args[1] === VAULT_LOCK_GENERATION_KEY) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        return realPut.apply(this, args);
      };
      act(() => { store.lockApp(); });
      // Synchronous: the vault is locked regardless of the write.
      expect(store.safeboxUnlocked).toBe(false);
      await waitFor(() => expect(durable()).toBe('failed'));
      expect(await readLockGeneration()).toBe(g0 + 1);

      proto.put = realPut;
      await openMain();
      act(() => { store.lockApp(); });
      await waitFor(async () => expect(await readLockGeneration()).toBe(g0 + 2));
      expect(durable()).toBe('failed'); // sticky
    } finally {
      proto.put = realPut;
    }
  });

  it('import with the section CLOSED and the vault open → the rebuild ran before apply resolved', async () => {
    await configureSafeboxElsewhere();
    renderStore();
    await openMain();
    const a0 = await version();
    const a1 = await next(a0);
    const b0 = await version();
    const json = await encodeBackup({
      notes: [],
      safebox: [a0.entry, a1.entry, b0.entry] as unknown as Record<string, unknown>[],
      incompleteRestore: false, containsUnsupportedRecords: false, createdAt: 1_756_000_000_000,
    }, await deriveBackupKey(MN));
    const prepared = await act(async () => store.prepareBackupImport(new File([json], 'b.json')));
    await act(async () => { await store.applyBackupImport(prepared); });

    expect(store.safeboxUnlocked).toBe(false);
    expect(await resolve(a0.meta.root)).toEqual({ ok: true, headId: a1.meta.id });
    expect(await resolve(b0.meta.root)).toEqual({ ok: true, headId: b0.meta.id });
  });

  it('a prepared import does not hold the seed: K_link is derived from the ref at call time', async () => {
    // The existing source scan (store.backup.test.tsx) covers the factory's
    // OUTER scope; this pins the new callback's own body.
    const source = readFileSync(join(process.cwd(), 'src/lib/store.tsx'), 'utf8');
    const start = source.indexOf('deriveSecretLinkKey: async () => {');
    const body = source.slice(start, source.indexOf('},', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/if \(!mnemonicRef\.current\) throw new BackupVaultLockedError\(\)/);
    expect(body).toMatch(/deriveSecretLinkKey\(mnemonicRef\.current\)/);
    expect(body).not.toMatch(/(?:const|let|var)\s+\w+\s*=\s*mnemonicRef\.current/);

    // Runtime: prepared, then locked → apply refuses, and no index appears.
    await configureSafeboxElsewhere();
    renderStore();
    await openMain();
    const a0 = await version();
    const json = await encodeBackup({
      notes: [], safebox: [a0.entry] as unknown as Record<string, unknown>[],
      incompleteRestore: false, containsUnsupportedRecords: false, createdAt: 1_756_000_000_000,
    }, await deriveBackupKey(MN));
    const prepared = await act(async () => store.prepareBackupImport(new File([json], 'b.json')));
    act(() => { store.lockApp(); });
    await expect(prepared.apply()).rejects.toBeInstanceOf(BackupCancelledError);
    expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toBeUndefined();
  });
});

// ═══ Import tail (adapter seam over real storage) ═══════════════════

describe('import: the rebuild after stage B never changes the report', () => {
  beforeEach(() => { installNavigator(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const keys = async () => ({
    note: await deriveKey(MN),
    safeboxMeta: metaKey,
    safeboxSecret: secretKey,
    container: await deriveBackupKey(MN),
  });

  async function fileOf(vs: Version[]) {
    const text = await encodeBackup({
      notes: [], safebox: vs.map(v => v.entry) as unknown as Record<string, unknown>[],
      incompleteRestore: false, containsUnsupportedRecords: false, createdAt: 1_756_000_000_000,
    }, await deriveBackupKey(MN));
    return { size: new TextEncoder().encode(text).byteLength, text: async () => text };
  }

  function vaultWith(over: Partial<BackupVault> = {}): BackupVault {
    return {
      deriveKeys: keys,
      deriveSecretLinkKey: vi.fn(() => deriveSecretLinkKey(MN)),
      dbGeneration: getDbGeneration(),
      assertAlive: () => {},
      now: () => 1_756_000_000_000,
      ...over,
    };
  }

  /** Real storage; the second safebox merge can be made to hit the quota. */
  function storageWith(opts: { quotaOnSecond?: boolean; rebuild?: BackupStorage['rebuildSecretLinkIndex'] } = {}) {
    let merges = 0;
    const rebuildSpy = vi.fn(opts.rebuild ?? liveStorage.rebuildSecretLinkIndex);
    const s: BackupStorage = {
      ...liveStorage,
      mergeRecord: async input => {
        if (input.kind === 'safebox' && ++merges === 2 && opts.quotaOnSecond) {
          throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        }
        return liveStorage.mergeRecord(input);
      },
      rebuildSecretLinkIndex: rebuildSpy,
    };
    return { storage: s, rebuildSpy };
  }

  async function freshDb() {
    await resetAll();
    await setMeta(VAULT_LOCK_GENERATION_KEY, 0);
    await writeConfig();
  }

  for (const partial of [false, true]) {
    it(`${partial ? 'partial' : 'successful'} stage B: a failing deriveSecretLinkKey or rebuild leaves the ImportReport as is`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const a0 = await version();
        const b0 = await version();
        const c0 = await version();
        const run = async (vault: BackupVault, rebuildImpl?: BackupStorage['rebuildSecretLinkIndex']): Promise<ImportReport> => {
          await freshDb();
          const { storage } = storageWith({ quotaOnSecond: partial, rebuild: rebuildImpl });
          const prepared = await prepareImport(() => ({ ...vault, dbGeneration: getDbGeneration() }), await fileOf([a0, b0, c0]), storage);
          return prepared.apply();
        };

        const baseline = await run(vaultWith());
        expect(baseline.counters.quotaStopped > 0).toBe(partial);
        // The healthy rebuild covered exactly what stage B committed.
        expect((await coverageRows())!.length).toBe(partial ? 1 : 3);

        const failingKey = vaultWith({ deriveSecretLinkKey: async () => { throw new Error('derive failed'); } });
        expect(await run(failingKey)).toEqual(baseline);
        expect(await getMeta(SECRET_LINK_COVERAGE_KEY)).toBeUndefined();

        const throwing = async (): Promise<never> => { throw new Error('rebuild exploded'); };
        expect(await run(vaultWith(), throwing)).toEqual(baseline);
        expect(warn.mock.calls.some(c => /index not rebuilt after the import/.test(String(c[0])))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  }

  it('a lock after stage B, before the rebuild → the rebuild is not started; the import stays uncovered', async () => {
    const a0 = await version();
    await writeOne(a0);
    const a1 = await next(a0);
    const file = await fileOf([a0, a1]);

    // Count the lifecycle checks a healthy apply makes before the rebuild starts.
    let calls = 0;
    let atRebuild = -1;
    {
      const { storage } = storageWith({
        rebuild: async () => { atRebuild = calls; return 'unchanged'; },
      });
      const prepared = await prepareImport(() => vaultWith({ assertAlive: () => { calls++; } }), file, storage);
      calls = 0;
      await prepared.apply();
    }
    expect(atRebuild).toBeGreaterThan(1);

    await freshDb();
    await writeOne(a0);
    let n = 0;
    const deriveSpy = vi.fn(() => deriveSecretLinkKey(MN));
    const { storage, rebuildSpy } = storageWith();
    const vault = vaultWith({
      deriveSecretLinkKey: deriveSpy,
      // Alive through stage B; the check right before the rebuild sees the lock.
      assertAlive: () => { if (++n >= atRebuild && armed) throw new BackupCancelledError('locked'); },
    });
    let armed = false;
    const prepared = await prepareImport(() => vault, file, storage);
    armed = true;
    n = 0;
    const report = await prepared.apply();

    expect(report.counters.quotaStopped).toBe(0);
    expect(await countSafeboxEntries()).toBe(2);
    expect(deriveSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    // The partially-maintained index stays as stage B left it: A1 is outside
    // the coverage, so A refuses (never serves A0) until the next open.
    expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'stale' });
  });

  it('cross-chain 5-H1 (partial import): A1 imported, its rebuild never ran; B0 saved later → A stale; rebuild → A1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await freshDb();
      const a0 = await version();
      await writeOne(a0);
      const a1 = await next(a0);
      // Stage B commits A1, but the tail's rebuild cannot run (no K_link):
      // the import leaves the index only partially maintained.
      const { storage, rebuildSpy } = storageWith();
      const vault = vaultWith({ deriveSecretLinkKey: async () => { throw new Error('derive failed'); } });
      const prepared = await prepareImport(() => ({ ...vault, dbGeneration: getDbGeneration() }), await fileOf([a0, a1]), storage);
      await prepared.apply();
      expect(rebuildSpy).not.toHaveBeenCalled();
      expect((await getAllSafeboxEntries()).map(e => e.entryId)).toContain(a1.entry.entryId);

      const b0 = await version();
      expect(await writeOne(b0)).toBe('indexed');
      const rows = (await coverageRows())!;
      expect(rows).toContainEqual(rowOf(b0));
      expect(rows).not.toContainEqual(rowOf(a1));
      expect(await resolve(a0.meta.root)).toEqual({ ok: false, reason: 'stale' });
      expect(await resolve(b0.meta.root)).toEqual({ ok: true, headId: b0.meta.id });

      expect(await rebuild()).toBe('rebuilt');
      expect(await resolve(a0.meta.root)).toEqual({ ok: true, headId: a1.meta.id });
    } finally {
      warn.mockRestore();
    }
  });

  it('preparing an import never derives K_link — only apply does, through the vault callback', async () => {
    const a0 = await version();
    const deriveSpy = vi.fn(() => deriveSecretLinkKey(MN));
    const { storage } = storageWith();
    const prepared = await prepareImport(() => vaultWith({ deriveSecretLinkKey: deriveSpy }), await fileOf([a0]), storage);
    expect(deriveSpy).not.toHaveBeenCalled();
    // That the prepared import holds no seed is pinned by behaviour in
    // «a prepared import does not hold the seed» (lock → apply refuses).
    await prepared.apply();
    expect(deriveSpy).toHaveBeenCalledTimes(1);
    expect(await resolve(a0.meta.root)).toEqual({ ok: true, headId: a0.meta.id });
  });
});
