// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// Store-level integration tests (§10): the epoch race around vault open, the
// PIN wipe path, multi-tab lock/config sync, the upload processor generation
// hand-off and the encrypted draft lifecycle — against REAL storage
// (fake-indexeddb) and real crypto, with only the network mocked.

vi.mock('./arweave', async importOriginal => {
  const actual = await importOriginal<typeof import('./arweave')>();
  return {
    ...actual,
    isArweaveOnline: vi.fn(async () => false),
    checkRegistration: vi.fn(async () => ({ status: 'unavailable' as const })),
    registerWithProxy: vi.fn(async () => ({ error: 'unavailable' })),
    uploadViaProxy: vi.fn(async () => ({ kind: 'error' as const, error: 'offline' })),
    fetchAllNotes: vi.fn(async () => ({ notes: [], incomplete: false })),
    getTxStatus: vi.fn(async () => ({ kind: 'unavailable' as const })),
  };
});

vi.mock('./crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('./crypto')>();
  return {
    ...actual,
    // Overridable per-test (wipe path) — defaults to the real implementation.
    decryptWithPin: vi.fn(actual.decryptWithPin),
  };
});

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    // Overridable per-test (persist-first / partial-cleanup failures).
    setMeta: vi.fn(actual.setMeta),
    clearPinConfigMeta: vi.fn(actual.clearPinConfigMeta),
  };
});

// Node's webcrypto (what vitest injects under jsdom, where code runs in the
// jsdom vm realm) accepts cross-realm typed-array VIEWS but rejects cross-realm
// bare ArrayBuffers — and @noble/ed25519 passes exactly that
// (digest('SHA-512', m.buffer)). Wrap digest to hand it a view instead;
// everything else delegates untouched.
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

import { NotesProvider, useNotes, PinWipedError } from './store';
import { initStorage, resetAll, getMeta, setMeta, getAllSyncRecords, clearPinConfigMeta } from './storage';
import { isArweaveOnline, uploadViaProxy, type UploadResult } from './arweave';
import { decryptWithPin, WrongPinError } from './crypto';
import { DRAFT_STORAGE_KEY, parseDraftEnvelope } from './draft';
import { HIDDEN_AT_KEY } from './auto-lock';

// ─── Fake BroadcastChannel (jsdom has none; Node's spans threads, not tabs) ──

type ChannelMessage = { data: unknown };

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  onmessage: ((e: ChannelMessage) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    for (const ch of FakeBroadcastChannel.instances) {
      if (ch === this || ch.closed || ch.name !== this.name) continue;
      queueMicrotask(() => { if (!ch.closed) ch.onmessage?.({ data }); });
    }
  }

  close(): void { this.closed = true; }
}

const globalWithBC = globalThis as { BroadcastChannel?: unknown };
let savedBroadcastChannel: unknown;

beforeAll(() => {
  savedBroadcastChannel = globalWithBC.BroadcastChannel;
  globalWithBC.BroadcastChannel = FakeBroadcastChannel;
});
afterAll(() => {
  globalWithBC.BroadcastChannel = savedBroadcastChannel;
});

// ─── Harness ─────────────────────────────────────────────────────────

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SESSION_KEY = 'eternal-notes-session';
const FAKE_PIN_BLOB = { ciphertext: 'ct', iv: 'iv', salt: 's' };

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  // Written from an effect (not during render) — the harness reads it only
  // after act()/waitFor have flushed effects anyway.
  useEffect(() => { store = snapshot; });
  return null;
}

function renderStore() {
  return render(<NotesProvider><Probe /></NotesProvider>);
}

async function untilReady() {
  await waitFor(() => expect(store.isReady).toBe(true));
}

/** Open the vault through the public API and wait until it is on screen. */
async function openMain() {
  await act(async () => { await store.confirmMnemonic(MN); });
  await waitFor(() => expect(store.screen).toBe('main'));
}

/** Attach a listener tab to the vault channel (created AFTER renderStore so
 *  the store's own channel exists too). */
function listenOnChannel() {
  const channel = new FakeBroadcastChannel('eternal-notes-vault');
  const received: Array<Record<string, unknown>> = [];
  channel.onmessage = e => received.push(e.data as Record<string, unknown>);
  return { channel, received };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  FakeBroadcastChannel.instances = [];
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

// ─── Epoch: lock during vault open (§4) ─────────────────────────────

describe('lock during bootstrap vault open', () => {
  it('a lock racing the session restore wins: nothing is published', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    sessionStorage.setItem(SESSION_KEY, MN);

    renderStore();
    // Fire the lock while bootstrap's prepare is still in flight.
    act(() => { store.lockApp(); });

    await untilReady();
    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── Bootstrap lock decision (§5) ───────────────────────────────────

describe('decideBootstrapLock wiring', () => {
  it('locks at boot: away past the threshold with a live session → PIN, seed dropped', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);
    sessionStorage.setItem(SESSION_KEY, MN);
    sessionStorage.setItem(HIDDEN_AT_KEY, String(Date.now() - 301_000));

    renderStore();
    await untilReady();

    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull(); // seed never survives a lock
    expect(sessionStorage.getItem(HIDDEN_AT_KEY)).toBeNull(); // marker consumed atomically
  });

  it('does not lock with the feature off (timeout null): session restores to main', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    sessionStorage.setItem(SESSION_KEY, MN);
    sessionStorage.setItem(HIDDEN_AT_KEY, String(Date.now() - 301_000));

    renderStore();
    await untilReady();
    await waitFor(() => expect(store.screen).toBe('main'));
    expect(store.mnemonic).toBe(MN);
  });
});

// ─── Lifecycle: hidden → visible with «Сразу» (§5) ──────────────────

describe('auto-lock on return to foreground', () => {
  it('timeout 0: hidden → visible locks the vault synchronously', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 0);

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    expect(sessionStorage.getItem(HIDDEN_AT_KEY)).not.toBeNull(); // marker armed

    act(() => { setVisibility('visible'); });
    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('timeout null: hidden → visible does NOT lock', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    act(() => { setVisibility('visible'); });
    expect(store.screen).toBe('main');
    expect(store.mnemonic).toBe(MN);
  });
});

// ─── PIN wipe (§8) ──────────────────────────────────────────────────

describe('10-strike PIN wipe', () => {
  it('wipe resets the auto-lock timeout atomically and broadcasts config', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);
    await setMeta('pin-attempts', 9);

    renderStore();
    await untilReady();
    expect(store.hasPin).toBe(true);
    expect(store.autoLockTimeout).toBe(300);
    const { received } = listenOnChannel();

    vi.mocked(decryptWithPin).mockRejectedValueOnce(new WrongPinError());
    await act(async () => {
      await expect(store.unlockWithPin('000000')).rejects.toThrow(PinWipedError);
    });

    // Meta: everything gone in one transaction, timeout explicitly «Никогда».
    expect(await getMeta('pin-seed')).toBeUndefined();
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    expect(await getMeta('auto-lock-timeout')).toBeNull();
    // React state follows the commit.
    expect(store.hasPin).toBe(false);
    expect(store.autoLockTimeout).toBeNull();
    // Other tabs were told to re-read the config.
    await act(async () => {}); // flush the microtask delivery
    expect(received.some(m => m.type === 'config')).toBe(true);
  });

  it('a failure mid-cleanup leaves NO partial configuration and NO broadcast', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);
    await setMeta('pin-attempts', 9);

    renderStore();
    await untilReady();
    const { received } = listenOnChannel();

    vi.mocked(decryptWithPin).mockRejectedValueOnce(new WrongPinError());
    vi.mocked(clearPinConfigMeta).mockRejectedValueOnce(new Error('db down'));
    await act(async () => {
      await expect(store.unlockWithPin('000000')).rejects.toThrow('db down');
    });

    // The configuration is fully intact — never half-cleared.
    expect(await getMeta('pin-seed')).toEqual(FAKE_PIN_BLOB);
    expect(await getMeta('auto-lock-timeout')).toBe(300);
    expect(store.hasPin).toBe(true);
    expect(store.autoLockTimeout).toBe(300);
    await act(async () => {});
    expect(received.some(m => m.type === 'config')).toBe(false);
  });
});

// ─── Persist-first timeout setting (§6) ─────────────────────────────

describe('setAutoLockTimeout', () => {
  it('persists before publishing; a failed write keeps the old value', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();

    await act(async () => { await store.setAutoLockTimeout(1800); });
    expect(await getMeta('auto-lock-timeout')).toBe(1800);
    expect(store.autoLockTimeout).toBe(1800);

    vi.mocked(setMeta).mockRejectedValueOnce(new Error('quota'));
    await act(async () => {
      await expect(store.setAutoLockTimeout(300)).rejects.toThrow('quota');
    });
    expect(store.autoLockTimeout).toBe(1800);           // state untouched
    expect(await getMeta('auto-lock-timeout')).toBe(1800); // meta untouched
  });
});

// ─── Multi-tab (§8) ─────────────────────────────────────────────────

describe('multi-tab vault channel', () => {
  it('a foreign lock message locks this tab WITHOUT re-broadcasting (no echo storm)', async () => {
    await setMeta('init', true);

    renderStore();
    await untilReady();
    await openMain();
    const { channel, received } = listenOnChannel();

    channel.postMessage({ type: 'lock', originId: 'other-tab', messageId: 'm1' });
    await waitFor(() => expect(store.screen).toBe('restore')); // no PIN → seed re-entry
    expect(store.mnemonic).toBeNull();

    await act(async () => {});
    expect(received).toEqual([]); // handler used broadcast:false — silence on the wire
  });

  it('replaying the tab\'s OWN lock message is ignored (originId dedup)', async () => {
    await setMeta('init', true);

    renderStore();
    await untilReady();
    await openMain();
    const { channel, received } = listenOnChannel();

    act(() => { store.lockApp(); });
    await act(async () => {});
    const own = received.find(m => m.type === 'lock');
    expect(own).toBeDefined(); // lock was broadcast exactly once
    expect(received).toHaveLength(1);

    await openMain(); // unlock again
    channel.postMessage(own!); // an echoing transport replays our own message
    await act(async () => {});
    expect(store.screen).toBe('main'); // own-origin message must be ignored
  });

  it('a config message re-reads PIN/timeout from meta', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);

    renderStore();
    await untilReady();
    expect(store.hasPin).toBe(true);
    expect(store.autoLockTimeout).toBe(300);

    // Another tab wiped the PIN configuration.
    await clearPinConfigMeta();
    const { channel } = listenOnChannel();
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'm2' });

    await waitFor(() => expect(store.hasPin).toBe(false));
    expect(store.autoLockTimeout).toBeNull();
  });
});

// ─── Upload processor generations (§7) ──────────────────────────────

describe('upload processor across lock/unlock', () => {
  it('in-flight upload commits after lock; the superseded processor hands off to a new one', async () => {
    await setMeta('init', true);
    await setMeta('ar-enabled', true);
    vi.mocked(isArweaveOnline).mockResolvedValue(true);

    const first = deferred<UploadResult>();
    vi.mocked(uploadViaProxy)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ kind: 'accepted', txId: 'TX2', committed: true });

    renderStore();
    await untilReady();
    await openMain();
    await waitFor(() => expect(store.arweave.online).toBe(true));

    await act(async () => { await store.addNote('первая'); });
    await act(async () => { await store.addNote('вторая'); });
    // The processor took note 1 and is now stuck in the in-flight upload.
    await waitFor(() => expect(vi.mocked(uploadViaProxy)).toHaveBeenCalledTimes(1));

    act(() => { store.lockApp(); });
    expect(store.screen).toBe('restore');

    // Unlock analogue: reopen the vault and re-enqueue pending work. The OLD
    // processor still owns isProcessing — this kick alone cannot start a new one.
    await openMain();
    await act(async () => { await store.retrySync(); });

    // Release the old processor: its result must persist DESPITE the lock
    // (committed upload), and its finally must hand off to a NEW processor.
    act(() => { first.resolve({ kind: 'accepted', txId: 'TX1', committed: true }); });

    await waitFor(async () => {
      const records = await getAllSyncRecords();
      const accepted = records.filter(r => r.status === 'accepted').map(r => r.txId).sort();
      expect(accepted).toEqual(['TX1', 'TX2']);
    });
    expect(vi.mocked(uploadViaProxy).mock.calls.length).toBeGreaterThanOrEqual(2);
    // Nothing may be left 'uploading' — every processed branch persisted.
    const records = await getAllSyncRecords();
    expect(records.filter(r => r.status === 'uploading')).toEqual([]);
  });
});

// ─── Draft across lock/unlock (§2/§3) ───────────────────────────────

describe('encrypted draft across lock/unlock/reset', () => {
  it('lock keeps the ciphertext; unlock reads it back; reset destroys it', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    await act(async () => { await store.persistDraft('тайный черновик'); });
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(parseDraftEnvelope(raw!)).not.toBeNull(); // encrypted envelope, not plaintext
    expect(raw).not.toContain('тайный');

    act(() => { store.lockApp(); });
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBe(raw); // ciphertext survives the lock
    await act(async () => {
      expect(await store.readDraft()).toBeNull(); // and is unreadable while locked
    });

    await openMain();
    await act(async () => {
      expect(await store.readDraft()).toBe('тайный черновик');
    });

    await act(async () => { await store.resetApp(); });
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull(); // explicit reset destroys it
  });

  it('a LEGACY plaintext draft does not survive a lock', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    sessionStorage.setItem(DRAFT_STORAGE_KEY, 'старый плейнтекст');
    act(() => { store.lockApp(); });
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });
});
