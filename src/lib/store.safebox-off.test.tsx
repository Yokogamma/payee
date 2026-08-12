// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// R4 matrix: the SAME safebox slice with SAFEBOX_WRITER_ENABLED pinned OFF.
// The contract this file exists to pin down: on R4 only the three WRITER
// actions are disabled. Reading, unlocking, activation (including the seed
// path a restored user needs), PIN change/deactivation and the seed reset must
// all keep working — otherwise a rollback would strand people out of their
// passwords.

vi.mock('./flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: false }));

vi.mock('hash-wasm', () => ({
  argon2id: async ({ password, salt }: { password: string; salt: Uint8Array }) => {
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
    getWorkerCapabilities: vi.fn(async () => ({ v3: 'unknown' as const, v4: 'unknown' as const })),
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

import { NotesProvider, useNotes, WriterDisabledError } from './store';
import {
  initStorage, resetAll, setMeta, countSafeboxEntries,
  saveSafeboxEntryWithSync, readSafeboxPinConfig,
} from './storage';
import {
  deriveSafeboxMetaKey, deriveSafeboxSecretKey, encryptSafeboxEntry,
} from './crypto';

class FakeBroadcastChannel {
  onmessage: unknown = null;
  postMessage(): void {}
  close(): void {}
}
const globalWithBC = globalThis as { BroadcastChannel?: unknown };
let savedBC: unknown;
beforeAll(() => { savedBC = globalWithBC.BroadcastChannel; globalWithBC.BroadcastChannel = FakeBroadcastChannel; });
afterAll(() => { globalWithBC.BroadcastChannel = savedBC; });

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PIN = '135790';

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() {
  return render(<NotesProvider><Probe /></NotesProvider>);
}
async function openMain() {
  await waitFor(() => expect(store.isReady).toBe(true));
  await act(async () => { await store.confirmMnemonic(MN); });
  await waitFor(() => expect(store.screen).toBe('main'));
}

async function seedEntry(title = 'seeded') {
  const metaKey = await deriveSafeboxMetaKey(MN);
  const secretKey = await deriveSafeboxSecretKey(MN);
  const entry = await encryptSafeboxEntry(metaKey, secretKey, {
    title, login: 'l', url: '', note: '', password: 'SEEDED-PW',
    files: [], rev: 1,
  });
  await saveSafeboxEntryWithSync(entry, {
    noteId: entry.entryId, kind: 'safebox', txId: 'TX-SEED',
    status: 'confirmed', transport: 'proxy', updatedAt: 1,
  });
  return entry;
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  await setMeta('init', true);
});
afterEach(() => cleanup());

describe('R4 contract — writer OFF', () => {
  it('all THREE writer actions throw WriterDisabledError and write nothing', async () => {
    await seedEntry();
    renderStore();
    await openMain();
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    await waitFor(() => expect(store.safeboxUnlocked).toBe(true));

    const root = store.safeboxChains[0].root;
    const versionId = store.safeboxChains[0].current.id;
    const before = await countSafeboxEntries();

    await expect(store.addSafeboxEntry({
      title: 't', login: '', url: '', note: '', password: 'p', files: [],
    })).rejects.toBeInstanceOf(WriterDisabledError);
    await expect(store.editSafeboxEntry(root, {
      title: 't', login: '', url: '', note: '', files: [],
    })).rejects.toBeInstanceOf(WriterDisabledError);
    await expect(store.restoreSafeboxVersion(root, versionId))
      .rejects.toBeInstanceOf(WriterDisabledError);

    expect(await countSafeboxEntries()).toBe(before);
  });

  it('READING is fully active: unlock, list, chains, reveal, copy', async () => {
    await seedEntry('видимая');
    renderStore();
    await openMain();
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    await waitFor(() => expect(store.safeboxUnlocked).toBe(true));

    expect(store.safeboxEntries.map(e => e.title)).toEqual(['видимая']);
    expect(store.safeboxChains).toHaveLength(1);
    const id = store.safeboxChains[0].current.id;
    expect(await store.revealSafeboxSecret(id)).toBe('SEEDED-PW');
  });

  it('the PIN lifecycle is writer-INDEPENDENT (activate / change / deactivate / seed reset)', async () => {
    await seedEntry();
    renderStore();
    await openMain();

    // Activation over restored data — the path a rolled-back device depends on.
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    expect(store.safeboxUnlocked).toBe(true);

    await act(async () => { await store.changeSafeboxPin(PIN, '222222'); });
    await act(async () => { await store.deactivateSafebox('222222'); });
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(await countSafeboxEntries()).toBe(1); // data untouched throughout

    await act(async () => { await store.resetSafeboxPinWithSeed(MN, '333333'); });
    await act(async () => { await store.unlockSafebox('333333'); });
    expect(store.safeboxUnlocked).toBe(true);
  });

  it('hydration still reports data/config so the entry point can be shown', async () => {
    await seedEntry();
    renderStore();
    await openMain();
    expect(store.safeboxDataPresent).toBe(true);
    expect(store.safeboxEntryCount).toBe(1);
    // The Main entry-point formula is
    // SAFEBOX_WRITER_ENABLED || safeboxDataPresent || safeboxPinConfigured —
    // false || true || false on this device.
    expect(store.safeboxPinConfigured).toBe(false);
  });

  it('a device with NEITHER data nor a config hides the safebox entirely on R4', async () => {
    renderStore();
    await openMain();
    expect(store.safeboxDataPresent).toBe(false);
    expect(store.safeboxPinConfigured).toBe(false);
  });
});
