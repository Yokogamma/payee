// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// The FLAG-OFF half of the matrix (§10). The contract is per OPERATION, not
// per screen: setup and unlock are gated, reading and REMOVING never are.
// Rolling the flag back must not strand a user with a live record and no
// control for it — which is the whole reason there is no «reconfigure» button
// and the settings block stays visible on `QUICK_UNLOCK_ENABLED ||
// hasQuickUnlock`.

vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: false,
  SAFEBOX_WRITER_ENABLED: false,
  QUICK_UNLOCK_ENABLED: false,
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
  };
});

vi.mock('./persistence', () => ({
  ensurePersistentStorage: vi.fn(async () => 'unsupported' as const),
  resetPersistenceAttemptForTests: vi.fn(),
}));

vi.mock('./quick-unlock-core', async importOriginal => {
  const actual = await importOriginal<typeof import('./quick-unlock-core')>();
  return {
    ...actual,
    detectQuickUnlockCapability: vi.fn(async () => 'ready' as const),
    createPrfCredential: vi.fn(),
    evalPrf: vi.fn(),
  };
});

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

import { NotesProvider, useNotes } from './store';
import { initStorage, resetAll, getMeta, setMeta } from './storage';
import { QUICK_UNLOCK_META_KEY } from './quick-unlock';
import { createPrfCredential, evalPrf, QuickUnlockUnavailableError } from './quick-unlock-core';
import { bufferToBase64 } from './crypto';
import { isArweaveOnline } from './arweave';

/** A real 32-byte base64 key: the record validator demands canonical base64,
 *  so a readable placeholder such as "pk-value" would be rejected as MALFORMED
 *  and these tests would pass for the wrong reason. */
const VAULT_PK = bufferToBase64(new Uint8Array(32).fill(9));

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FAKE_PIN_BLOB = { ciphertext: 'ct', iv: 'iv', salt: 's' };

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() { return render(<NotesProvider><Probe /></NotesProvider>); }
async function untilReady() { await waitFor(() => expect(store.isReady).toBe(true)); }

/** A record left over from a build that had the flag ON. */
async function seedExistingRecord(pk: string) {
  await setMeta(QUICK_UNLOCK_META_KEY, {
    v: 1,
    credentialId: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    prfSalt: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
    hkdfSalt: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
    iv: 'BAQEBAQEBAQEBAQE',
    ciphertext: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=',
    pk,
    createdAt: 1_700_000_000_000,
  });
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
  cleanup();
});

describe('QUICK_UNLOCK_ENABLED = false', () => {
  it('setup refuses without opening any system sheet', async () => {
    renderStore();
    await untilReady();
    await act(async () => { await store.confirmMnemonic(MN); });
    await waitFor(() => expect(store.screen).toBe('main'));
    await act(async () => { await store.setupPin('123456'); });

    await act(async () => {
      await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(vi.mocked(createPrfCredential)).not.toHaveBeenCalled();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('unlock refuses without opening any system sheet', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('vault-public-key', VAULT_PK);
    await seedExistingRecord(VAULT_PK);

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin');

    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(vi.mocked(evalPrf)).not.toHaveBeenCalled();
  });

  it('an EXISTING record is still hydrated — the block must be able to show it', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('vault-public-key', VAULT_PK);
    await seedExistingRecord(VAULT_PK);

    renderStore();
    await untilReady();
    expect(store.hasQuickUnlock).toBe(true);
    expect(store.quickUnlockMeta?.createdAt).toBe(1_700_000_000_000);
  });

  it('REMOVAL works with the flag off — a rollback never strands a record', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('vault-public-key', VAULT_PK);
    await seedExistingRecord(VAULT_PK);

    renderStore();
    await untilReady();
    expect(store.hasQuickUnlock).toBe(true);

    await act(async () => { await store.removeQuickUnlock(); });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
    expect(store.hasQuickUnlock).toBe(false);
  });

  it('an orphaned record is still cleaned up with the flag off', async () => {
    await setMeta('init', true);
    await setMeta('vault-public-key', VAULT_PK); // no pin-seed
    await seedExistingRecord(VAULT_PK);

    renderStore();
    await untilReady();
    await waitFor(async () => expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined());
    expect(store.hasQuickUnlock).toBe(false);
  });
});
