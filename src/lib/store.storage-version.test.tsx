// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

// §5 (B1): what bootstrap does when the LOCAL DATABASE is the problem.
//  - a tab holding the old schema blocks the v1→v2 upgrade → a banner, never an
//    endless 'loading' spinner;
//  - the stored DB is NEWER than this build → a RELOAD screen, and explicitly
//    NOT the generic error screen whose destructive reset is two clicks away;
//  - …and that reload screen SURVIVES the auto-lock's fail-closed verdict on
//    the first return from the background (A18) — as does the generic error
//    screen, whose destructive reset is the one recovery from a storage that
//    will not open.

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
import { closeStorage } from './storage';
import App from '../App';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SESSION_KEY = 'eternal-notes-session';

let store: ReturnType<typeof useNotes>;
function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() {
  return render(<NotesProvider><Probe /></NotesProvider>);
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

// ─── A dead-end tab with a session seed (shared by the two describes below) ──

/** Boot the REAL App — router and ErrorScreen, not a Probe: these findings are
 *  about which screen the user is looking at, and `store.screen` alone would
 *  not notice the router or the copy changing underneath it. Resolves once
 *  `heading` is up with the seed still in the tab (bootstrap threw before step
 *  4 could judge it — vaultPresentInTab() stays true). Returns a counter of
 *  fail-closed verdicts, the only footprint a lock leaves once the seed is
 *  gone. */
async function bootDeadEndWithSeed(behaviour: 'version-error' | 'generic-error', heading: string) {
  h.initBehaviour = behaviour;
  // An earlier case opened the real database; this build must have NONE, or
  // the config re-read on return would succeed and no lock would be at stake.
  closeStorage();
  sessionStorage.setItem(SESSION_KEY, MN);
  // jsdom has no matchMedia; App's theme hook needs it to resolve «system».
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  }));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

  render(<App />);
  expect(await screen.findByText(heading)).toBeTruthy();
  expect(sessionStorage.getItem(SESSION_KEY)).toBe(MN);
  return {
    failClosedLocks: () =>
      errors.mock.calls.filter(c => String(c[0]).includes('locking fail-closed')).length,
  };
}

/** Background and back on the visibility edge. The refs say «no lock» (no
 *  PIN, no timeout), so the verdict goes to the authoritative config — which
 *  throws → fail-closed. */
function returnViaVisibility() {
  act(() => { setVisibility('hidden'); });
  act(() => { setVisibility('visible'); });
}

/** The same round trip through the BFCache: `pagehide` is the hidden edge,
 *  a PERSISTED `pageshow` the return. */
function returnViaBfcache() {
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
}

beforeEach(() => {
  h.initBehaviour = 'ok';
  h.fireBlocking = null;
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

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

// A18 (client-b1 acceptance, 2026-09-17). A session seed can outlive the build
// that wrote it — a same-origin build swap, a discarded tab the browser restores
// with its sessionStorage — and a VersionError throws BEFORE bootstrap gets to
// judge that seed. So the tab still «holds a vault», and the first return from
// the background re-reads an auto-lock config it cannot read (no database),
// locks fail-closed, and used to land on the seed-entry screen — where the
// correct phrase is answered with «Неверная seed-фраза», because nothing can
// open the database from this build. The lock itself is right (the seed must
// not sit in a dead-end tab); only the SCREEN must not move.
describe('bootstrap — VersionError with a session seed still in the tab (A18)', () => {
  const bootOutdatedWithSeed = () => bootDeadEndWithSeed('version-error', 'Приложение обновилось');

  /** The SAME screen: reload only, no destructive reset, no seed form, and no
   *  privacy gate left covering it. */
  function expectReloadScreenOnly() {
    expect(screen.getByText('Приложение обновилось')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Перезагрузить' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Сбросить/ })).toBeNull();
    expect(screen.queryByText('Восстановление')).toBeNull();
    expect(document.querySelector('.lock-gate')?.hasAttribute('hidden')).toBe(true);
  }

  it('the fail-closed lock on the first return keeps the «reload» screen', async () => {
    const { failClosedLocks } = await bootOutdatedWithSeed();

    returnViaVisibility();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    expect(failClosedLocks()).toBe(1);
    // The lock set its target screen synchronously with the seed removal; let
    // that commit before looking, so a wrong target cannot hide behind timing.
    await act(async () => {});

    expectReloadScreenOnly();
  });

  it('a BFCache restore (pagehide → persisted pageshow) is decided the same way', async () => {
    const { failClosedLocks } = await bootOutdatedWithSeed();

    returnViaBfcache();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    expect(failClosedLocks()).toBe(1);
    await act(async () => {});

    expectReloadScreenOnly();
  });

  it('every later return finds nothing to lock and leaves the screen alone', async () => {
    const { failClosedLocks } = await bootOutdatedWithSeed();

    returnViaVisibility();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    await act(async () => {});
    expectReloadScreenOnly();

    // Second round trip. The config is still unreadable, so the verdict still
    // says «lock» — but the seed is gone, vaultPresentInTab() is false, and
    // lockApp takes its first exit: the gate comes down, nothing else moves.
    // The hidden edge itself raises no gate this time (no vault to cover).
    returnViaVisibility();
    await waitFor(() => expect(failClosedLocks()).toBe(2));
    await act(async () => {});

    expectReloadScreenOnly();
  });
});

// The GENERIC boot failure has the same shape, one step earlier still: init
// itself throws (corrupted IndexedDB, quota, private mode), the seed is never
// judged, and the first return fails closed. Here the lock used to land on
// seed entry as well — and took «Сбросить данные» with it, the one recovery
// from a storage that will not open, reachable from no other screen. Nothing
// on the seed-entry or PIN screens can succeed without a database; the error
// screen's reload and reset are the only truthful actions, so the lock must
// keep that screen too. Same three round trips as A18.
describe('bootstrap — generic init failure with a session seed still in the tab', () => {
  const bootBrokenWithSeed = () => bootDeadEndWithSeed('generic-error', 'Не удалось запустить');

  /** The SAME screen: the failure copy, reload AND the reset all still there;
   *  no seed form, no PIN pad, no privacy gate left covering it. */
  function expectErrorScreenWithReset() {
    expect(screen.getByText('Не удалось запустить')).toBeTruthy();
    expect(screen.getByText('quota exceeded')).toBeTruthy(); // the bootError copy
    expect(screen.getByRole('button', { name: 'Перезагрузить' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Сбросить данные' })).toBeTruthy();
    expect(screen.queryByText('Восстановление')).toBeNull();
    expect(screen.queryByText('Eternal Notes')).toBeNull();
    expect(document.querySelector('.lock-gate')?.hasAttribute('hidden')).toBe(true);
  }

  it('the fail-closed lock on the first return keeps the error screen and its reset', async () => {
    const { failClosedLocks } = await bootBrokenWithSeed();
    // The reset is on offer BEFORE the lock — the regression was losing it.
    expect(screen.getByRole('button', { name: 'Сбросить данные' })).toBeTruthy();

    returnViaVisibility();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    expect(failClosedLocks()).toBe(1);
    // The lock set its target screen synchronously with the seed removal; let
    // that commit before looking, so a wrong target cannot hide behind timing.
    await act(async () => {});

    expectErrorScreenWithReset();
  });

  it('a BFCache restore (pagehide → persisted pageshow) is decided the same way', async () => {
    const { failClosedLocks } = await bootBrokenWithSeed();

    returnViaBfcache();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    expect(failClosedLocks()).toBe(1);
    await act(async () => {});

    expectErrorScreenWithReset();
  });

  it('every later return finds nothing to lock and leaves the screen alone', async () => {
    const { failClosedLocks } = await bootBrokenWithSeed();

    returnViaVisibility();
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBeNull());
    await act(async () => {});
    expectErrorScreenWithReset();

    // Second round trip: the config is still unreadable, the verdict still
    // says «lock» — but with no seed, vaultPresentInTab() is false and lockApp
    // takes its first exit. Screen, copy and both buttons are left alone.
    returnViaVisibility();
    await waitFor(() => expect(failClosedLocks()).toBe(2));
    await act(async () => {});

    expectErrorScreenWithReset();
  });
});
