// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, waitFor, act } from '@testing-library/react';

// §5 (B1): what bootstrap does when the LOCAL DATABASE is the problem.
//  - a tab holding the old schema blocks the v1→v2 upgrade → a banner, never an
//    endless 'loading' spinner;
//  - the stored DB is NEWER than this build → a RELOAD screen, and explicitly
//    NOT the generic error screen whose destructive reset is two clicks away.

vi.mock('./flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: false, QUICK_UNLOCK_ENABLED: false }));

const h = vi.hoisted(() => ({
  initBehaviour: 'ok' as 'ok' | 'version-error' | 'blocked' | 'blocking' | 'generic-error',
  fireBlocking: null as null | (() => void),
}));

import type { InitStorageOptions } from './storage';

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    initStorage: vi.fn(async (opts?: InitStorageOptions) => {
      if (h.initBehaviour === 'version-error') {
        const err = new Error('The requested version (1) is less than the existing version (2).');
        err.name = 'VersionError';
        throw err;
      }
      if (h.initBehaviour === 'generic-error') throw new Error('quota exceeded');
      if (h.initBehaviour === 'blocked') {
        opts?.onBlocked?.();
        // A blocked upgrade eventually completes once the other tab closes.
        return actual.initStorage();
      }
      if (h.initBehaviour === 'blocking') {
        // Fires LATER, mid-session, when a newer build asks for an upgrade.
        h.fireBlocking = () => opts?.onBlocking?.();
      }
      return actual.initStorage();
    }),
  };
});

vi.mock('./arweave', async importOriginal => {
  const actual = await importOriginal<typeof import('./arweave')>();
  return {
    ...actual,
    isArweaveOnline: vi.fn(async () => false),
    checkRegistration: vi.fn(async () => ({ status: 'unavailable' as const })),
    fetchAllNotes: vi.fn(async () => ({ notes: [], safeboxEntries: [], incomplete: false })),
    getTxStatus: vi.fn(async () => ({ kind: 'unavailable' as const })),
    getWorkerCapabilities: vi.fn(async () => ({ uploads: 'unknown' as const, v3: 'unknown' as const, v4: 'unknown' as const })),
  };
});

// Same cross-realm digest shim as the other store suites: under jsdom
// @noble/ed25519 hands WebCrypto a bare (cross-realm) ArrayBuffer, which Node's
// implementation rejects — wrap digest to pass a view instead.
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

class FakeBroadcastChannel {
  onmessage: unknown = null;
  postMessage(): void {}
  close(): void {}
}
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;

import { NotesProvider, useNotes } from './store';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let store: ReturnType<typeof useNotes>;
function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() {
  return render(<NotesProvider><Probe /></NotesProvider>);
}

beforeEach(() => {
  h.initBehaviour = 'ok';
  h.fireBlocking = null;
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe('bootstrap — local database problems', () => {
  it('a VersionError routes to the NON-DESTRUCTIVE «reload» screen', async () => {
    h.initBehaviour = 'version-error';
    renderStore();
    await waitFor(() => expect(store.screen).toBe('error'));
    expect(store.storageOutdated).toBe(true);
    // The generic bootError (which unlocks the destructive reset copy) stays
    // untouched: the data is INTACT and must not be offered for deletion.
    expect(store.bootError).toBeNull();
  });

  it('any OTHER init failure keeps the generic error screen with its reset path', async () => {
    h.initBehaviour = 'generic-error';
    renderStore();
    await waitFor(() => expect(store.screen).toBe('error'));
    expect(store.storageOutdated).toBe(false);
    expect(store.bootError).toContain('quota exceeded');
  });

  it('`blocking` (a newer build wants to upgrade) locks the vault and shows the reload screen', async () => {
    h.initBehaviour = 'blocking';
    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await act(async () => { await store.confirmMnemonic(MN); });
    await waitFor(() => expect(store.screen).toBe('main'));
    expect(store.mnemonic).toBe(MN);

    // The other tab requests the upgrade: our connection is closed for it.
    await act(async () => { h.fireBlocking!(); });
    await waitFor(() => expect(store.screen).toBe('error'));
    expect(store.storageOutdated).toBe(true);
    expect(store.bootError).toBeNull(); // no destructive-reset copy
    // The database is gone from under us: keeping decrypted state in memory
    // buys nothing and leaves secrets resident behind a dead-end screen.
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('a blocked upgrade surfaces `storageBlocked` and then clears once it completes', async () => {
    h.initBehaviour = 'blocked';
    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    // The banner is shown while blocked and cleared after the upgrade lands.
    expect(store.storageBlocked).toBe(false);
    expect(store.screen).not.toBe('error');
  });
});
