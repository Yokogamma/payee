// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// Store-level integration tests (§10): the epoch race around vault open, the
// PIN wipe path, multi-tab lock/config sync, the upload processor generation
// hand-off and the encrypted draft lifecycle — against REAL storage
// (fake-indexeddb) and real crypto, with only the network mocked.

// This file IS the writer-OFF (R3) matrix — pin the flag explicitly instead of
// inheriting whatever flags.ts currently ships, so the W3 flip stays a pure
// one-line change and both matrices (here / store.v3-writer.test.tsx) keep
// asserting their own half forever.
vi.mock('./flags', () => ({ V3_WRITER_ENABLED: false, SAFEBOX_WRITER_ENABLED: false, QUICK_UNLOCK_ENABLED: false }));

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

vi.mock('./crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('./crypto')>();
  return {
    ...actual,
    // Overridable per-test (wipe path / reset races) — default to the real impl.
    decryptWithPin: vi.fn(actual.decryptWithPin),
    encrypt: vi.fn(actual.encrypt),
    // Overridable to land a lock INSIDE the (slow) PIN derivation.
    encryptWithPin: vi.fn(actual.encryptWithPin),
  };
});

// The persistence request is a side-effect on the browser, not on the vault:
// mocked everywhere so the tests can assert WHERE it is (and is not) triggered.
vi.mock('./persistence', () => ({
  ensurePersistentStorage: vi.fn(async () => 'unsupported' as const),
  resetPersistenceAttemptForTests: vi.fn(),
}));

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    // Overridable per-test (persist-first / partial-cleanup / gate failures).
    getMeta: vi.fn(actual.getMeta),
    setMeta: vi.fn(actual.setMeta),
    saveNote: vi.fn(actual.saveNote),
    getPinConfigMeta: vi.fn(actual.getPinConfigMeta),
    // The auto-lock VERDICT still reads two keys; everything else (bootstrap
    // hydration, the cross-tab reconcile) reads this four-key snapshot.
    readClientConfigSnapshot: vi.fn(actual.readClientConfigSnapshot),
    clearPinConfigMeta: vi.fn(actual.clearPinConfigMeta),
    // Overridable per-test: the vault-identity transaction and the conditional
    // PIN write are exactly where the restore-with-PIN races live.
    bindVaultIdentity: vi.fn(actual.bindVaultIdentity),
    commitPinSeedIfAbsent: vi.fn(actual.commitPinSeedIfAbsent),
    // Stage P: the generation-guarded PIN-unlock commits. Overridable so the
    // store tests can land a reset / a cross-tab PIN change exactly on them.
    commitPinUnlockFailure: vi.fn(actual.commitPinUnlockFailure),
    commitPinUnlockSuccess: vi.fn(actual.commitPinUnlockSuccess),
    commitPinSeedRewrap: vi.fn(actual.commitPinSeedRewrap),
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

import {
  NotesProvider, useNotes, PinWipedError, WriterDisabledError, OperationInFlightError,
  VERDICT_DEADLINE_MS, GATE_NOTE_MS, GATE_EXIT_MS,
} from './store';
import {
  initStorage, resetAll, getMeta, setMeta, getPinConfigMeta, getAllSyncRecords,
  clearPinConfigMeta, saveNote, getAllNotes as getStoredNotes,
  commitPinUnlockFailure, commitPinUnlockSuccess, commitPinSeedRewrap,
  readClientConfigSnapshot,
} from './storage';

/** The four-key snapshot `reconcileLockScreen` and bootstrap now read. */
function configSnapshot(over: {
  pinSeed?: unknown;
  autoLockTimeout?: unknown;
  vaultPublicKey?: unknown;
} = {}) {
  return {
    pinSeed: undefined,
    autoLockTimeout: undefined,
    vaultPublicKey: undefined,
    quickUnlock: { kind: 'none' as const },
    ...over,
  };
}
import { isArweaveOnline, uploadViaProxy, type UploadResult } from './arweave';
import { decryptWithPin, WrongPinError, deriveKey, encryptEnvelopeV3, type EncryptedNote } from './crypto';
import { NoteTooLongError, MAX_NOTE_JSON_BYTES } from './limits';
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

/** The privacy gate is ALWAYS mounted (its raise must be a synchronous DOM
 *  flip, not a React commit — see store.tsx). «Up» therefore means *visible*,
 *  i.e. the element exists and is not `hidden`. */
function gateUp(): boolean {
  const el = document.querySelector('.lock-gate');
  return el !== null && !el.hasAttribute('hidden');
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

describe('lock during a pending vault open (review finding 2)', () => {
  it('a lock while openVault is preparing cancels it — nothing publishes afterwards', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin'); // no session yet — and no cryptoKey either

    // Start an unlock-like open; the vault op is in flight but NOT committed.
    // The lock must still take: a pending open counts as lockable state.
    let pending!: Promise<void>;
    act(() => {
      pending = store.confirmMnemonic(MN);
      store.lockApp();
    });
    await act(async () => { await pending; });

    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('lock during addNote (review finding 1)', () => {
  it('the note persists encrypted, but its plaintext is NOT republished behind the PIN screen', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    let pending!: Promise<void>;
    act(() => {
      pending = store.addNote('секретный текст');
      store.lockApp(); // lands while encrypt()/saveNote() are still in flight
    });
    await act(async () => { await pending; });

    expect(store.screen).toBe('pin');
    expect(store.notes).toEqual([]); // no plaintext behind the lock

    // The save itself was committed (ciphertext at rest) — the next unlock
    // decrypts it from storage.
    await openMain();
    await waitFor(() => expect(store.notes.map(n => n.text)).toEqual(['секретный текст']));
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

// ─── Regression: a gate left covering the screen it was meant to guard ──
//
// Reported from production: after a long idle the app opens as a blank page
// with a single padlock, and ONLY a full restart clears it. That padlock is
// the privacy gate — nobody lowered it.
//
// The sequence needs the page to WAKE UP HIDDEN (Android reloads a
// backgrounded PWA): the mount block sees `hidden` plus a session seed and
// raises the gate, then the bootstrap lock decision drops the seed and lands
// on 'pin' — without touching the gate. From that point `lockApp()` cannot
// rescue it either: it returns on its first line, because `vaultPresentInTab()`
// is no longer true once the seed is gone.
//
// The invariant both halves must keep: a LOCKED app holds no plaintext, so no
// gate may cover it.
describe('privacy gate never outlives the screen it covers', () => {
  // Visibility is restored by the file-level afterEach — which resets the
  // property WITHOUT dispatching, so no teardown event reaches a half-unmounted
  // provider.

  async function seedLockedWakeup() {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);
    sessionStorage.setItem(SESSION_KEY, MN);
    sessionStorage.setItem(HIDDEN_AT_KEY, String(Date.now() - 301_000));
    setVisibility('hidden'); // no listeners yet — this is the pre-render state
  }

  it('bootstrap locks while hidden: PIN screen is reachable, gate is down', async () => {
    await seedLockedWakeup();

    renderStore();
    await untilReady();

    expect(store.screen).toBe('pin');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull(); // seed dropped by the lock
    await waitFor(() => expect(gateUp()).toBe(false));
  });

  it('and the gate is still down after the user brings the app forward', async () => {
    await seedLockedWakeup();

    renderStore();
    await untilReady();

    await act(async () => { setVisibility('visible'); });

    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.screen).toBe('pin');
  });

  // Contract test, not a reproduction. Three call sites in `evaluateReturn`
  // delegate the gate to lockApp() on the strength of its own comment — «the
  // locked UI is non-sensitive, so no gate may be left covering it». That
  // promise silently lapses when the vault is already gone, because lockApp
  // returns on its first line. Pin the promise so the next path that clears a
  // vault under a raised gate cannot re-create the production lockout above.
  it('lockApp() lowers the gate even when there is no vault left to lock', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    expect(store.screen).toBe('restore'); // no session, no PIN — nothing open

    // A session seed alone makes vaultPresentInTab() true, which is what lets
    // the hidden edge raise the gate (same condition the mount block uses).
    sessionStorage.setItem(SESSION_KEY, MN);
    await act(async () => { setVisibility('hidden'); });
    expect(gateUp()).toBe(true);

    // …and now the seed goes away, exactly as the bootstrap lock branch does.
    sessionStorage.removeItem(SESSION_KEY);
    act(() => { store.lockApp(); });

    expect(gateUp()).toBe(false);
  });

  // Round 2 of the SAME production report — the padlock came back.
  //
  // Both fixes above answer «who lowers the gate», and both assume the verdict
  // ARRIVES. It does not have to. The verdict waits on one IndexedDB read, and
  // IndexedDB stalls precisely in this lifecycle (a connection suspended on
  // BFCache entry, a transaction opened around a freeze/discard, an upgrade
  // blocked by another tab). A read that REJECTS already fails closed; a read
  // that never settles used to hold the gate open forever — and every later
  // hide/return raised it again, so only a relaunch cleared it.
  describe('an authoritative read that never settles', () => {
    // Only the two timer functions the gate itself uses are faked, and only
    // AFTER the vault is open: fake-indexeddb drives its transactions on
    // setImmediate, and waitFor() needs a real clock to poll on.
    function freezeTheClock() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    }
    afterEach(() => { vi.useRealTimers(); });

    /** Vault open on screen, real clock. The clock is frozen only afterwards —
     *  every timer the gate arms must be created under the FAKE clock, or
     *  advancing it would move nothing. */
    async function openTheVault() {
      await setMeta('init', true);
      await setMeta('pin-seed', FAKE_PIN_BLOB);
      renderStore();
      await untilReady();
      await openMain();
    }

    async function openAndHide() {
      await openTheVault();
      freezeTheClock();
      act(() => { setVisibility('hidden'); });
      expect(gateUp()).toBe(true);
    }

    async function stallTheVerdict() {
      await openAndHide();
      // The read is issued and simply never answers — not an error, not a
      // rejection, nothing to catch.
      vi.mocked(getPinConfigMeta).mockImplementationOnce(() => new Promise(() => {}));
      act(() => { setVisibility('visible'); });
      expect(gateUp()).toBe(true); // still legitimately checking
    }

    it('fails CLOSED on its deadline: PIN screen, gate down, no relaunch needed', async () => {
      await stallTheVerdict();

      await act(async () => { await vi.advanceTimersByTimeAsync(VERDICT_DEADLINE_MS + 1000); });

      expect(store.screen).toBe('pin');
      expect(store.mnemonic).toBeNull();
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
      expect(gateUp()).toBe(false);
      expect(document.querySelector('div[inert]')).toBeNull();
    });

    it('explains itself, then offers the manual way out while it waits', async () => {
      await stallTheVerdict();

      const note = () => document.querySelector('.lock-gate-note');
      const exit = () => document.querySelector<HTMLButtonElement>('.lock-gate-exit');
      expect(note()!.hasAttribute('hidden')).toBe(true);

      // A second in: the padlock is no longer mute.
      await act(async () => { await vi.advanceTimersByTimeAsync(GATE_NOTE_MS + 100); });
      expect(note()!.hasAttribute('hidden')).toBe(false);
      expect(exit()!.hasAttribute('hidden')).toBe(true); // the verdict may still land
    });

    // The deadline above answers every path that RUNS. This answers the one
    // that does not: a tab that comes back without ever delivering a return
    // event (no visibilitychange, no pageshow) leaves the gate up with no
    // verdict in flight to time out — nothing is stuck, because nothing is
    // running. That is the shape of both production reports, and the shape of
    // whatever path is missed next. The handle must not depend on the event.
    it('the escape hatch appears — and locks — with no return event at all', async () => {
      // NB: openAndHide() has already frozen the clock — do NOT call
      // freezeTheClock() again here. Under vitest 4 a repeated useFakeTimers()
      // re-installs the fake clock and DISCARDS the gate's armed timers, so
      // advancing time would move nothing (vitest 3 tolerated the double call).
      await openAndHide();

      // Visible again, but the browser never told us (property flipped WITHOUT
      // dispatching, the same way the file-level afterEach does it).
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

      await act(async () => { await vi.advanceTimersByTimeAsync(GATE_EXIT_MS + 500); });
      const exit = document.querySelector<HTMLButtonElement>('.lock-gate-exit')!;
      expect(document.querySelector('.lock-gate-note')!.hasAttribute('hidden')).toBe(false);
      expect(exit.hasAttribute('hidden')).toBe(false);

      await act(async () => { exit.click(); });

      expect(store.screen).toBe('pin');
      expect(gateUp()).toBe(false);
      expect(store.mnemonic).toBeNull();
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('stays mute over a BACKGROUND tab — nobody is looking at it', async () => {
      // Same rule: the clock is already frozen by openAndHide().
      await openAndHide();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      expect(gateUp()).toBe(true); // correct: a hidden tab holds an open vault
      expect(document.querySelector('.lock-gate-note')!.hasAttribute('hidden')).toBe(true);
      expect(document.querySelector('.lock-gate-exit')!.hasAttribute('hidden')).toBe(true);
    });
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
    expect(gateUp()).toBe(false); // decided — gate down
  });

  it('timeout null: hidden → visible does NOT lock (gate drops after the verdict)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    act(() => { setVisibility('visible'); });
    // The authoritative config re-read must confirm "no lock" and drop the gate.
    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.screen).toBe('main');
    expect(store.mnemonic).toBe(MN);
  });

  it('the opaque gate is up from the hidden edge until the authoritative verdict (review round 2)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // timeout null → the sync path says "no lock"; only the async re-read decides.

    renderStore();
    await untilReady();
    await openMain();

    // Raised synchronously on the hidden edge — the first frame a return
    // paints already contains the gate, never plaintext.
    act(() => { setVisibility('hidden'); });
    expect(gateUp()).toBe(true);

    // Hold the config read open: the verdict is pending, the gate must stay.
    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null }); }),
    );
    act(() => { setVisibility('visible'); });
    expect(gateUp()).toBe(true); // still checking
    expect(store.screen).toBe('main'); // Main mounted, but covered by the gate
    // The gated content is INERT: no keyboard focus / AT access behind the overlay.
    expect(document.querySelector('div[inert]')).not.toBeNull();

    await act(async () => { releaseRead(); });
    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.screen).toBe('main'); // verdict: no lock — gate down, app usable
    expect(document.querySelector('div[inert]')).toBeNull(); // content interactive again
  });

  it('an unreadable config on return fails CLOSED (review round 2)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // timeout null in refs — a fail-open bug would keep the vault on screen.

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    vi.mocked(getPinConfigMeta).mockRejectedValueOnce(new Error('idb down'));
    act(() => { setVisibility('visible'); });

    await waitFor(() => expect(store.screen).toBe('pin'));
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(gateUp()).toBe(false); // decided (locked) — gate down
  });

  it('a config change missed while hidden still locks on return (review finding 3)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // Auto-lock starts OFF in this tab's refs.

    renderStore();
    await untilReady();
    await openMain();
    expect(store.autoLockTimeout).toBeNull();

    act(() => { setVisibility('hidden'); });
    // Another tab enabled «Сразу» while we were frozen — its broadcast never
    // reached us. Only the authoritative IndexedDB config knows.
    await setMeta('auto-lock-timeout', 0);

    act(() => { setVisibility('visible'); });
    // The stale refs said "no lock"; the self-heal re-read must overturn that
    // using the SAME consumed marker.
    await waitFor(() => expect(store.screen).toBe('pin'));
    expect(store.mnemonic).toBeNull();
    expect(store.autoLockTimeout).toBe(0);
  });
});

// ─── Privacy gate lifecycle (review round 3) ────────────────────────

describe('privacy gate across pending opens and generations', () => {
  it('a vault COMMITTED while hidden comes up gated until the return verdict', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // timeout null — no sync lock; the gate is the only protection.

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin'); // no session yet

    // The tab hides while openVault is still preparing — no key exists yet,
    // but the pending op MUST count as gateable vault state.
    let pending!: Promise<void>;
    act(() => {
      pending = store.confirmMnemonic(MN);
      setVisibility('hidden');
    });
    expect(gateUp()).toBe(true); // gated already

    await act(async () => { await pending; });
    expect(store.screen).toBe('main'); // committed while hidden…
    expect(gateUp()).toBe(true); // …but still gated

    act(() => { setVisibility('visible'); });
    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.screen).toBe('main'); // verdict (timeout null): stay open
  });

  it('a NEW hidden edge while the old verdict is pending keeps the NEW gate up (generation)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null }); }),
    );
    act(() => { setVisibility('visible'); }); // check A pending, gate up

    act(() => { setVisibility('hidden'); }); // SECOND away-interval begins

    // Check A resolves now — it is superseded and must NOT drop the new gate.
    await act(async () => { releaseRead(); });
    expect(gateUp()).toBe(true);

    // The second return runs its own (unmocked) verdict and settles the gate.
    act(() => { setVisibility('visible'); });
    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.screen).toBe('main');
  });

  it('an old pending verdict cannot lock a vault the user re-opened since', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // Refs know timeout=null; the meta will say 0 — the OLD verdict, once
    // released, would demand a lock. It must be abandoned instead.

    renderStore();
    await untilReady();
    await openMain();
    const { channel } = listenOnChannel();

    act(() => { setVisibility('hidden'); });
    await setMeta('auto-lock-timeout', 0); // changed elsewhere, broadcast missed

    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 0 }); }),
    );
    act(() => { setVisibility('visible'); }); // old check pending on the deferred read

    // Meanwhile: a foreign lock takes the tab down…
    channel.postMessage({ type: 'lock', originId: 'other-tab', messageId: 'r3-1' });
    await waitFor(() => expect(store.screen).toBe('pin'));
    // …and the user re-unlocks a fresh session.
    await openMain();

    // The old verdict resolves to "lock" — but its cycle is gone.
    await act(async () => { releaseRead(); });
    await act(async () => {});
    expect(store.screen).toBe('main'); // the NEW session stays open
    expect(store.mnemonic).toBe(MN);
    expect(gateUp()).toBe(false);
  });

  it('fast-path lock reconciles a stale PIN target: wiped pin-seed → restore screen', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 0);

    renderStore();
    await untilReady();
    await openMain();
    expect(store.hasPin).toBe(true);

    // Another tab wipes the whole PIN configuration; the broadcast is missed.
    await clearPinConfigMeta();

    act(() => { setVisibility('hidden'); });
    act(() => { setVisibility('visible'); });
    // Stale refs (hasPin=true, timeout=0) lock synchronously to 'pin' — the
    // reconciliation must move the user off the seedless PIN dead-end.
    await waitFor(() => expect(store.screen).toBe('restore'));
    expect(store.hasPin).toBe(false);
    expect(store.autoLockTimeout).toBeNull();
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── Verdict/config ordering + reset invalidation (review round 4) ──

describe('config publication ordering and reset lifecycle', () => {
  it('a superseded verdict cannot overwrite the new cycle\'s config refs', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setAutoLockTimeout(1800); });
    expect(store.autoLockTimeout).toBe(1800);

    act(() => { setVisibility('hidden'); });
    // Check A will read STALE values (pin blob + timeout null) once released.
    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null }); }),
    );
    act(() => { setVisibility('visible'); }); // check A pending

    act(() => { setVisibility('hidden'); }); // a NEW cycle supersedes A

    await act(async () => { releaseRead(); });
    // A resolved with timeout=null — but its cycle is gone: the refs must
    // keep the CURRENT configuration, not A's stale read.
    expect(store.autoLockTimeout).toBe(1800);
    expect(gateUp()).toBe(true); // new gate intact

    act(() => { setVisibility('visible'); }); // cycle B settles normally
    await waitFor(() => expect(gateUp()).toBe(false));
    expect(store.autoLockTimeout).toBe(1800);
    expect(store.screen).toBe('main'); // 1800s not elapsed — stays open
  });

  it('resetApp performs the full lifecycle invalidation — no orphaned gate over landing', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);

    renderStore();
    await untilReady();
    await openMain();

    act(() => { setVisibility('hidden'); });
    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null }); }),
    );
    act(() => { setVisibility('visible'); }); // verdict pending — it owns the gate
    expect(gateUp()).toBe(true);

    await act(async () => { await store.resetApp(); });
    expect(store.screen).toBe('landing');
    expect(gateUp()).toBe(false); // dropped synchronously
    expect(document.querySelector('div[inert]')).toBeNull();

    // The abandoned verdict resolves later — landing must stay ungated.
    await act(async () => { releaseRead(); });
    await act(async () => {});
    expect(store.screen).toBe('landing');
    expect(gateUp()).toBe(false);
  });

  it('an OLDER reconcile cannot overwrite a NEWER one (last caller wins)', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin');
    expect(store.hasPin).toBe(true);
    const { channel } = listenOnChannel();

    // Reconcile A hangs on its read…
    let releaseRead!: () => void;
    vi.mocked(readClientConfigSnapshot).mockImplementationOnce(
      () => new Promise(res => {
        releaseRead = () => res(configSnapshot({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }));
      }),
    );
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'r4-a' });
    await act(async () => {});

    // …while the PIN is wiped and a SECOND config message applies it.
    await clearPinConfigMeta();
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'r4-b' });
    await waitFor(() => expect(store.hasPin).toBe(false));
    expect(store.screen).toBe('restore'); // dead PIN screen downgraded

    // A finally resolves with the OLD pin blob — it must be discarded.
    await act(async () => { releaseRead(); });
    await act(async () => {});
    expect(store.hasPin).toBe(false);
    expect(store.autoLockTimeout).toBeNull();
    expect(store.screen).toBe('restore');
  });
});

// ─── Verdict re-decides against the newest config (review round 5) ──

describe('stale verdict vs newer config', () => {
  it('«Сразу», включённый другой вкладкой mid-verdict, wins: the stale no-lock re-decides and LOCKS', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    // timeout null — the stale snapshot will say "no lock".

    renderStore();
    await untilReady();
    await openMain();
    const { channel } = listenOnChannel();

    act(() => { setVisibility('hidden'); });
    let releaseRead!: () => void;
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null }); }),
    );
    act(() => { setVisibility('visible'); }); // verdict A pending on the stale snapshot

    // Another tab enables «Сразу» and announces it while A is still reading.
    await setMeta('auto-lock-timeout', 0);
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'r5-a' });
    await waitFor(() => expect(store.autoLockTimeout).toBe(0)); // reconcile applied
    expect(store.screen).toBe('main'); // still gated, not yet locked

    // A resolves with "no lock" — it must RE-DECIDE against the newest
    // config (the marker is already consumed; dropping the gate here would
    // leave the vault open forever).
    await act(async () => { releaseRead(); });
    await waitFor(() => expect(store.screen).toBe('pin'));
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(gateUp()).toBe(false);
  });

  it('a reconcile resolving after resetApp cannot resurrect hasPin on landing', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin');
    const { channel } = listenOnChannel();

    let releaseRead!: () => void;
    vi.mocked(readClientConfigSnapshot).mockImplementationOnce(
      () => new Promise(res => {
        releaseRead = () => res(configSnapshot({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }));
      }),
    );
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'r5-b' });
    await act(async () => {}); // reconcile A is now pending on the deferred read

    await act(async () => { await store.resetApp(); });
    expect(store.screen).toBe('landing');
    expect(store.hasPin).toBe(false);

    // The stale snapshot resolves AFTER the reset — it must be discarded.
    await act(async () => { releaseRead(); });
    await act(async () => {});
    expect(store.hasPin).toBe(false); // NOT resurrected on the clean landing
    expect(store.autoLockTimeout).toBeNull();
    expect(store.screen).toBe('landing');
  });

  it('a local setAutoLockTimeout wins over an in-flight reconcile read', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 300);

    renderStore();
    await untilReady();
    expect(store.autoLockTimeout).toBe(300);
    const { channel } = listenOnChannel();

    let releaseRead!: () => void;
    vi.mocked(readClientConfigSnapshot).mockImplementationOnce(
      () => new Promise(res => {
        releaseRead = () => res(configSnapshot({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }));
      }),
    );
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'r5-c' });
    await act(async () => {}); // reconcile A pending with the OLD timeout

    await act(async () => { await store.setAutoLockTimeout(1800); }); // local write + bump
    expect(store.autoLockTimeout).toBe(1800);

    await act(async () => { releaseRead(); });
    await act(async () => {});
    expect(store.autoLockTimeout).toBe(1800); // the old read did not revert it
    expect(await getMeta('auto-lock-timeout')).toBe(1800);
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
    // Stage P moved the wipe INSIDE the metering transaction: the one commit
    // that can fail mid-cleanup is now commitPinUnlockFailure, and it rolls
    // back with tx.abort() — meter and wipe are all-or-nothing together.
    vi.mocked(commitPinUnlockFailure).mockRejectedValueOnce(new Error('db down'));
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

  it('a REPLAYED foreign lock (same messageId) is deduplicated (§8)', async () => {
    await setMeta('init', true);

    renderStore();
    await untilReady();
    await openMain();
    const { channel } = listenOnChannel();

    const msg = { type: 'lock', originId: 'other-tab', messageId: 'dup-1' };
    channel.postMessage(msg);
    await waitFor(() => expect(store.screen).toBe('restore')); // locked once

    await openMain();
    channel.postMessage(msg); // an echoing transport replays the SAME message
    await act(async () => {});
    expect(store.screen).toBe('main'); // deduped — must not lock the new session
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

// ─── v3 writer gate OFF (R3 contract) ────────────────────────────────
// V3_WRITER_ENABLED is the real (false) flag in this file; the ON matrix
// lives in store.v3-writer.test.tsx with a mocked flag.

describe('R3 contract: writer OFF, reader always on', () => {
  it('addNote keeps writing v1 (no envelope version on the stored record)', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    await act(async () => { await store.addNote('обычная заметка'); });
    const stored = await getStoredNotes();
    expect(stored).toHaveLength(1);
    expect(stored[0].v).toBeUndefined(); // legacy v1 record
    expect(store.notes[0].fmt).toBe('plain');
    expect(store.notes[0].rev).toBe(1);
    expect(store.notes[0].root).toBe(stored[0].noteId);
  });

  it('editNote throws WriterDisabledError — never a silent no-op', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.addNote('текст'); });
    const root = store.notes[0].root;

    await expect(store.editNote(root, 'новый текст')).rejects.toThrow(WriterDisabledError);
    // Nothing was created.
    expect(await getStoredNotes()).toHaveLength(1);
  });

  it('a double addNote before re-render: second call rejects, ONE record saved', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    let secondError: unknown = null;
    await act(async () => {
      const p1 = store.addNote('раз');
      const p2 = store.addNote('раз').catch(e => { secondError = e; });
      await Promise.all([p1, p2]);
    });
    expect(secondError).toBeInstanceOf(OperationInFlightError);
    expect(await getStoredNotes()).toHaveLength(1);
  });

  it('a failed save releases the single-flight mutex (retry works, text not lost)', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    vi.mocked(saveNote).mockRejectedValueOnce(new Error('quota'));
    await expect(store.addNote('первая попытка')).rejects.toThrow('quota');
    // Mutex released — the retry saves normally.
    await act(async () => { await store.addNote('первая попытка'); });
    expect(await getStoredNotes()).toHaveLength(1);
  });

  it('addNote rejects an over-limit note with NoteTooLongError and saves NOTHING', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    const huge = 'ж'.repeat(MAX_NOTE_JSON_BYTES); // 2 bytes/char → 2× the limit
    await expect(store.addNote(huge)).rejects.toThrow(NoteTooLongError);
    expect(await getStoredNotes()).toHaveLength(0);
  });

  it('READER stays active under the OFF flag: a stored v3 chain renders as ONE card', async () => {
    // Simulates the W3→R3 rollback: v3 data already in storage.
    await setMeta('init', true);
    const key = await deriveKey(MN);
    const v1root = await encryptEnvelopeV3(key, 'корень', { fmt: 'md', rev: 1 });
    const v2edit = await encryptEnvelopeV3(key, '# правка', {
      fmt: 'md', rev: 2, root: v1root.noteId, prev: v1root.noteId,
    });
    await saveNote(v1root);
    await saveNote(v2edit);

    renderStore();
    await untilReady();
    await openMain();

    // Raw versions both decrypted and visible to sync/reset accounting…
    expect(store.notes).toHaveLength(2);
    // …but the feed view groups them into a single chain with the edit current.
    expect(store.chains).toHaveLength(1);
    expect(store.chains[0].root).toBe(v1root.noteId);
    expect(store.chains[0].current.text).toBe('# правка');
    expect(store.chains[0].current.fmt).toBe('md');
    expect(store.chains[0].versions).toHaveLength(2);
    // Storage-backed reset risk counts BOTH versions (nothing confirmed).
    expect(store.arweave.resetRisk.notes).toBe(2);
  });

  it('an unknown-version record is invisible in the UI but counted by resetRisk.notes', async () => {
    await setMeta('init', true);
    const key = await deriveKey(MN);
    const good = await encryptEnvelopeV3(key, 'нормальная', { fmt: 'md', rev: 1 });
    const alien = { ...(await encryptEnvelopeV3(key, 'из будущего', { fmt: 'md', rev: 1 })), v: 4 };
    await saveNote(good);
    await saveNote(alien as unknown as EncryptedNote);

    renderStore();
    await untilReady();
    await openMain();

    expect(store.notes).toHaveLength(1); // alien skipped, no crash
    expect(store.arweave.resetRisk.notes).toBe(2); // but still at risk on reset
  });
});

// ─── Exclusive reset (P1): no write may land after «Удалить всё» ─────

describe('exclusive reset — post-point-of-no-return persists are refused', () => {
  it('an upload result arriving AFTER resetApp writes NO sync record into the wiped DB', async () => {
    await setMeta('init', true);
    await setMeta('ar-enabled', true);
    vi.mocked(isArweaveOnline).mockResolvedValue(true);

    // The upload passes its point of no return, then hangs in HTTP.
    // (The mock's call counter accumulates across this file — baseline it.)
    const callsBefore = vi.mocked(uploadViaProxy).mock.calls.length;
    const inFlight = deferred<UploadResult>();
    vi.mocked(uploadViaProxy).mockImplementationOnce(() => inFlight.promise);

    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.addNote('заметка'); });
    await waitFor(() =>
      expect(vi.mocked(uploadViaProxy).mock.calls.length).toBe(callsBefore + 1));

    // «Удалить всё» while the request is still in flight.
    await act(async () => { await store.resetApp(); });
    expect(store.screen).toBe('landing');

    // The response lands afterwards — its unconditional persist must be
    // REFUSED by the generation guard, not written into the fresh DB.
    await act(async () => {
      inFlight.resolve({ kind: 'accepted', txId: 'TX-LATE', committed: true });
      await new Promise(r => setTimeout(r, 50));
    });

    expect(await getAllSyncRecords()).toEqual([]);
    expect(await getStoredNotes()).toEqual([]);
  });

  it('an addNote save racing resetApp rejects instead of resurrecting the note', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    // Pause addNote INSIDE encrypt — i.e. before its generation guard. In
    // production there is no await between the guard and the write-transaction
    // creation, so the only real race window is the awaits BEFORE the guard.
    const { encrypt } = await import('./crypto');
    const { encrypt: realEncrypt } = await vi.importActual<typeof import('./crypto')>('./crypto');
    let releaseEncrypt!: () => void;
    const gate = new Promise<void>(r => { releaseEncrypt = r; });
    vi.mocked(encrypt).mockImplementationOnce(async (key, text) => {
      await gate;
      return realEncrypt(key, text);
    });

    let saveError: unknown = null;
    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = store.addNote('гонка со сбросом').catch(e => { saveError = e; });
      await new Promise(r => setTimeout(r, 10));
    });
    await act(async () => { await store.resetApp(); });
    await act(async () => { releaseEncrypt(); await savePromise; });

    // The note belongs to a destroyed vault: the save must fail loudly…
    expect(saveError).toBeInstanceOf(Error);
    expect(String(saveError)).toMatch(/сброшено/);
    // …and nothing may exist in the fresh DB.
    expect(await getStoredNotes()).toEqual([]);
  });

  it('resetApp broadcasts a reset message so other tabs invalidate their writes', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();
    const { received } = listenOnChannel();

    await act(async () => { await store.resetApp(); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });

    expect(received.some(m => m.type === 'reset')).toBe(true);
  });

  it('receiving a foreign reset locks this tab and bumps its DB generation', async () => {
    await setMeta('init', true);
    renderStore();
    await untilReady();
    await openMain();

    const { getDbGeneration } = await import('./storage');
    const genBefore = getDbGeneration();
    const { channel } = listenOnChannel();
    await act(async () => {
      channel.postMessage({ type: 'reset', originId: 'other-tab', messageId: crypto.randomUUID() });
      await new Promise(r => setTimeout(r, 20));
    });

    expect(getDbGeneration()).toBe(genBefore + 1); // local writes invalidated
    await waitFor(() => expect(store.screen).not.toBe('main')); // locked out
    expect(store.mnemonic).toBeNull();
  });
});

// ─── Restore with a PIN + the persistence request ───────────────────
//
// REALM CAVEAT: every "other tab" here is simulated inside ONE JS realm, which
// shares this module's `dbGeneration` and IndexedDB. That is enough for the
// properties below (ordering, conditional writes, epoch/generation guards) but
// it CANNOT model a reset by a real second tab whose 'reset' broadcast never
// arrived — the project's accepted residual window (see storage.ts).

import { bindVaultIdentity, commitPinSeedIfAbsent, StorageResetError } from './storage';
import { encryptWithPin, type PinEncryptedSeed } from './crypto';
import { ensurePersistentStorage } from './persistence';
import { VaultMismatchError } from './store';

// A second BIP39-valid phrase — a DIFFERENT vault, not a typo of MN.
const MN_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PIN = '123456';

async function storedPinSeed(): Promise<PinEncryptedSeed | undefined> {
  return getMeta<PinEncryptedSeed>('pin-seed');
}

describe('restoreFromMnemonic({ pin })', () => {
  it('stores a PIN that unwraps the very seed that was restored', async () => {
    renderStore();
    await untilReady();

    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });

    const blob = await storedPinSeed();
    expect(blob).toBeDefined();
    expect(await decryptWithPin(blob!, PIN)).toBe(MN);
    await waitFor(() => expect(store.hasPin).toBe(true));
    expect(store.pinSetupNotice).toBeNull();
    expect(await getMeta('init')).toBe(true);
  });

  it('without a pin nothing is configured', async () => {
    renderStore();
    await untilReady();

    await act(async () => { await store.restoreFromMnemonic(MN); });

    expect(await storedPinSeed()).toBeUndefined();
    expect(store.hasPin).toBe(false);
  });

  it('a FOREIGN vault leaves no PIN behind (the guard runs first)', async () => {
    // The scenario the PIN must never survive: a checksum-valid phrase for a
    // DIFFERENT vault. Writing the PIN before this check would leave a PIN that
    // unlocks a vault this device does not have.
    await setMeta('init', true);
    await setMeta('vault-public-key', 'someone-elses-key');
    renderStore();
    await untilReady();

    await act(async () => {
      await expect(store.restoreFromMnemonic(MN_B, { pin: PIN }))
        .rejects.toBeInstanceOf(VaultMismatchError);
    });

    expect(await storedPinSeed()).toBeUndefined();
  });

  it('another tab bound the vault mid-open: nothing is published, no PIN', async () => {
    // openVault's own read-only guard passed (the key appeared while we were
    // preparing) — the transaction is what catches it. Everything sensitive is
    // published AFTER it, so a rejection cannot strand a decrypted vault here.
    vi.mocked(bindVaultIdentity).mockResolvedValueOnce('foreign');
    renderStore();
    await untilReady();

    await act(async () => {
      await expect(store.restoreFromMnemonic(MN, { pin: PIN }))
        .rejects.toBeInstanceOf(VaultMismatchError);
    });

    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).not.toBe('main');
    expect(await getMeta('init')).toBeUndefined();
    expect(await storedPinSeed()).toBeUndefined();
  });

  it('a reset this tab already knows about stands down silently', async () => {
    vi.mocked(bindVaultIdentity).mockRejectedValueOnce(new StorageResetError());
    renderStore();
    await untilReady();

    // No throw: the vault the user asked for is gone, and the reset already
    // owns the screen.
    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });

    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).not.toBe('main');
    expect(await getMeta('init')).toBeUndefined();
    expect(await storedPinSeed()).toBeUndefined();
  });

  it('a PIN configured by another tab is NOT replaced — and the user is told', async () => {
    const foreignBlob = await encryptWithPin(MN, '999999');
    await setMeta('pin-seed', foreignBlob);
    renderStore();
    await untilReady();

    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });

    expect(await storedPinSeed()).toEqual(foreignBlob); // untouched
    await waitFor(() => expect(store.pinSetupNotice).toBe('already-set'));
    expect(store.hasPin).toBe(true); // a PIN exists — just not this one
  });

  it('a lock during the PIN derivation writes nothing at all', async () => {
    renderStore();
    await untilReady();
    vi.mocked(encryptWithPin).mockImplementationOnce(async () => {
      store.lockApp();
      return { ciphertext: 'ct', iv: 'iv', salt: 's' } as PinEncryptedSeed;
    });

    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });

    expect(await storedPinSeed()).toBeUndefined();
    expect(store.hasPin).toBe(false);
    expect(store.pinSetupNotice).toBeNull();
  });

  it('a reset INSIDE the PIN transaction publishes nothing — not even the broadcast', async () => {
    // A generation bump cannot abort a transaction that is already running, so
    // the guarantee is not an exception: it is that everything leaving this tab
    // (cross-tab signal, React state) happens after the post-commit guard.
    renderStore();
    await untilReady();
    const { received } = listenOnChannel();
    vi.mocked(commitPinSeedIfAbsent).mockImplementationOnce(async () => {
      await store.resetApp();
      return true;
    });

    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });

    expect(received.filter(m => m.type === 'config')).toHaveLength(0);
    expect(store.hasPin).toBe(false);
    expect(store.pinSetupNotice).toBeNull();
    expect(await storedPinSeed()).toBeUndefined(); // the wipe is the final state
  });

  it('a reconcile that started BEFORE the write cannot undo it', async () => {
    renderStore();
    await untilReady();

    // A foreign `config` starts a reconcile; its read hangs until we release it.
    const gate = deferred<{ pinSeed: unknown; autoLockTimeout: unknown }>();
    vi.mocked(getPinConfigMeta).mockImplementationOnce(() => gate.promise);
    const { channel } = listenOnChannel();
    await act(async () => {
      channel.postMessage({ type: 'config', originId: 'other-tab', messageId: crypto.randomUUID() });
      await new Promise(r => setTimeout(r, 20));
    });

    await act(async () => { await store.restoreFromMnemonic(MN, { pin: PIN }); });
    await waitFor(() => expect(store.hasPin).toBe(true));

    // The stale snapshot (taken when no PIN existed) must discard itself.
    await act(async () => {
      gate.resolve({ pinSeed: undefined, autoLockTimeout: undefined });
      await new Promise(r => setTimeout(r, 20));
    });

    expect(store.hasPin).toBe(true);
    expect(store.screen).toBe('main');
  });
});

describe('confirmMnemonic({ pin }) — creation and restore follow ONE rule', () => {
  it('stores a PIN that unwraps the seed that was just created', async () => {
    renderStore();
    await untilReady();

    await act(async () => { await store.confirmMnemonic(MN, { pin: PIN }); });

    const blob = await storedPinSeed();
    expect(await decryptWithPin(blob!, PIN)).toBe(MN);
    await waitFor(() => expect(store.hasPin).toBe(true));
    expect(await getMeta('init')).toBe(true);
    expect(store.pinSetupNotice).toBeNull();
  });

  it('losing the identity race writes NO pin — and deletes nobody else’s', async () => {
    // The mixed Onboarding × Restore race: another tab bound this device to a
    // different vault and configured ITS PIN while this onboarding was running.
    // Writing first and «undoing» on mismatch would delete the winner's PIN
    // (and its auto-lock setting with it).
    const winnersBlob = await encryptWithPin(MN_B, '999999');
    await setMeta('vault-public-key', 'someone-elses-key');
    await setMeta('init', true);
    await setMeta('pin-seed', winnersBlob);
    await setMeta('auto-lock-timeout', 300);
    renderStore();
    await untilReady();

    await act(async () => {
      await expect(store.confirmMnemonic(MN, { pin: PIN }))
        .rejects.toBeInstanceOf(VaultMismatchError);
    });

    expect(await storedPinSeed()).toEqual(winnersBlob); // untouched, not wiped
    expect(await getMeta('auto-lock-timeout')).toBe(300);
  });

  it('a PIN already configured for the SAME vault is never replaced', async () => {
    renderStore();
    await untilReady();
    await act(async () => { await store.confirmMnemonic(MN, { pin: PIN }); });
    const first = await storedPinSeed();

    // The other tab finishes its own creation of the same vault, own PIN.
    await act(async () => { await store.confirmMnemonic(MN, { pin: '999999' }); });

    expect(await storedPinSeed()).toEqual(first);
    await waitFor(() => expect(store.pinSetupNotice).toBe('already-set'));
  });

  it('creation without a pin configures nothing', async () => {
    renderStore();
    await untilReady();
    await act(async () => { await store.confirmMnemonic(MN); });
    expect(await storedPinSeed()).toBeUndefined();
    expect(store.hasPin).toBe(false);
  });
});

describe('persistent-storage request', () => {
  beforeEach(() => { vi.mocked(ensurePersistentStorage).mockClear(); });

  it('is made when the user creates a vault', async () => {
    renderStore();
    await untilReady();
    await openMain();
    expect(ensurePersistentStorage).toHaveBeenCalled();
  });

  it('is made when the user restores by seed', async () => {
    renderStore();
    await untilReady();
    await act(async () => { await store.restoreFromMnemonic(MN); });
    expect(ensurePersistentStorage).toHaveBeenCalled();
  });

  it('is made when the user unlocks with a PIN', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', await encryptWithPin(MN, PIN));
    renderStore();
    await untilReady();
    vi.mocked(ensurePersistentStorage).mockClear();

    await act(async () => { await store.unlockWithPin(PIN); });

    expect(ensurePersistentStorage).toHaveBeenCalled();
  });

  it('is NOT made by a silent session resume — there is no user gesture there', async () => {
    await setMeta('init', true);
    sessionStorage.setItem(SESSION_KEY, MN);
    renderStore();
    await untilReady();
    await waitFor(() => expect(store.screen).toBe('main'));

    expect(ensurePersistentStorage).not.toHaveBeenCalled();
  });
});

describe('setupPin without an open vault', () => {
  it('rejects instead of silently doing nothing', async () => {
    renderStore();
    await untilReady();
    await expect(store.setupPin(PIN)).rejects.toBeDefined();
    expect(await storedPinSeed()).toBeUndefined();
  });
});

// ─── Stage P: the bindVaultIdentity window ──────────────────────────
//
// Until stage P, openVault cleared `vaultOpAbortRef` in a `finally` right
// after prepareVaultSnapshot — i.e. BEFORE `await bindVaultIdentity`. In that
// window the tab held nothing lockable at all (no key, no session seed, no op
// in flight), so lockApp() took its `!vaultPresentInTab()` early exit WITHOUT
// bumping the epoch; the post-bind epoch check then passed and the vault was
// published against the lock verdict. The tests below pause exactly there.

import type { VaultBindResult } from './storage';

/** The real transaction, captured before any test replaces it: the identity
 *  tests need the bind to actually COMMIT, then hold. */
const realBindVaultIdentity = vi.mocked(bindVaultIdentity).getMockImplementation()!;

/** Take over the identity transaction for ONE test, dispatching on the 1-based
 *  call number. Deliberately NOT mockImplementationOnce: a test that fails
 *  before its gate opens would leave an unconsumed implementation queued for
 *  whatever runs next. `restoreRealBind` in afterEach always undoes this. */
function stubBind(
  impl: (call: number, pk: string, opts: { initialize: boolean }, gen: number) => Promise<VaultBindResult>,
) {
  let call = 0;
  vi.mocked(bindVaultIdentity).mockImplementation((pk, opts, gen) => impl(++call, pk, opts, gen));
}

function restoreRealBind() {
  vi.mocked(bindVaultIdentity).mockImplementation(realBindVaultIdentity);
}

/** Park an open in the bind window: prepare has COMPLETED, the identity
 *  transaction has been entered and has not returned yet. */
async function openPausedInBindWindow(start: () => Promise<void>) {
  const entered = deferred<void>();
  const gate = deferred<VaultBindResult>();
  stubBind(async (call, pk, opts, gen) => {
    if (call > 1) return realBindVaultIdentity(pk, opts, gen);
    entered.resolve();
    return gate.promise;
  });
  let pending!: Promise<void>;
  act(() => { pending = start(); });
  await act(async () => { await entered.promise; });
  return { gate, pending };
}

describe('lock inside the bindVaultIdentity window (stage P)', () => {
  afterEach(restoreRealBind);

  it('«Сразу» + hidden→visible during bind: openVault publishes NOTHING', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 0); // «Сразу»

    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin');

    const { gate, pending } = await openPausedInBindWindow(() => store.confirmMnemonic(MN));

    // The system sheet / task switcher round-trip. A tab with an open in
    // flight is NOT empty — the gate must rise and the return must lock.
    act(() => { setVisibility('hidden'); });
    expect(gateUp()).toBe(true);
    act(() => { setVisibility('visible'); });
    expect(store.screen).toBe('pin'); // locked synchronously at «Сразу»

    await act(async () => { gate.resolve('bound'); await pending; });

    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull(); // no session seed
    expect(gateUp()).toBe(false);                           // decided — gate down
  });
});

describe('competing openVault calls (stage P)', () => {
  afterEach(restoreRealBind);

  it('the preempted call publishes nothing and its VaultMismatchError stays silent', async () => {
    renderStore();
    await untilReady();

    const { gate: gateA, pending: pendingA } =
      await openPausedInBindWindow(() => store.confirmMnemonic(MN));

    // B starts while A sits in its bind: it aborts A's controller on entry and
    // runs the REAL identity transaction through to publication.
    await act(async () => { await store.confirmMnemonic(MN); });
    await waitFor(() => expect(store.screen).toBe('main'));

    // A's bind finally lands — with a verdict that would normally raise a
    // user-facing error. A preempted attempt has no UI to report into: the
    // epoch never moved (a new openVault does not bump it), so ONLY the abort
    // signal can catch this.
    await act(async () => {
      gateA.resolve('foreign');
      await expect(pendingA).resolves.toBeUndefined();
    });

    expect(store.screen).toBe('main');
    expect(store.mnemonic).toBe(MN);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(MN);
  });

  it("a preempted call's finally does NOT clear the newer call's controller", async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('auto-lock-timeout', 0);

    renderStore();
    await untilReady();

    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const gateA = deferred<VaultBindResult>();
    const gateB = deferred<VaultBindResult>();
    stubBind(async call => {
      if (call === 1) { enteredA.resolve(); return gateA.promise; }
      enteredB.resolve();
      return gateB.promise;
    });

    let pendingA!: Promise<void>;
    act(() => { pendingA = store.confirmMnemonic(MN); });
    await act(async () => { await enteredA.promise; });

    let pendingB!: Promise<void>;
    act(() => { pendingB = store.confirmMnemonic(MN); });
    await act(async () => { await enteredB.promise; });

    // A stands down. Its `finally` clears the ref ONLY if the ref still holds
    // A's own controller — otherwise the tab would look empty for the rest of
    // B's bind window, and the lock below would silently do nothing.
    await act(async () => { gateA.resolve('bound'); await pendingA; });

    act(() => { setVisibility('hidden'); });
    act(() => { setVisibility('visible'); });

    await act(async () => { gateB.resolve('bound'); await pendingB; });

    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe('the bind transaction is the point of no return for IDENTITY (stage P)', () => {
  afterEach(restoreRealBind);

  /** Run restoreFromMnemonic up to a COMMITTED bind, then lock before it
   *  returns. Leaves the vault bound on disk and unpublished in the tab. */
  async function lockAfterCommittedBind(mn: string) {
    const committed = deferred<void>();
    const gate = deferred<void>();
    stubBind(async (call, pk, opts, gen) => {
      // A readwrite transaction cannot be cancelled by an AbortSignal — and
      // must not be: identity is linearized by transaction creation order,
      // exactly like resetAll. Let it COMMIT, then let the lock land.
      const result = await realBindVaultIdentity(pk, opts, gen);
      if (call > 1) return result; // the retry binds normally
      committed.resolve();
      await gate.promise;
      return result;
    });
    let pending!: Promise<void>;
    act(() => { pending = store.restoreFromMnemonic(mn); });
    await act(async () => { await committed.promise; });
    act(() => { store.lockApp(); }); // e.g. another tab's 'lock' broadcast
    await act(async () => { gate.resolve(); await pending; });
  }

  it('keeps BOTH vault-public-key and meta.init, and publishes no vault', async () => {
    renderStore();
    await untilReady();
    await lockAfterCommittedBind(MN);

    // Identity — written by the one transaction that had already started.
    expect(typeof await getMeta('vault-public-key')).toBe('string');
    expect(await getMeta('init')).toBe(true);
    // Publication — nothing at all.
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).toBe('restore'); // no PIN configured → seed re-entry
  });

  it('a retry with the SAME seed binds and succeeds', async () => {
    renderStore();
    await untilReady();
    await lockAfterCommittedBind(MN);

    await act(async () => { await store.restoreFromMnemonic(MN); });
    await waitFor(() => expect(store.screen).toBe('main'));
    expect(store.mnemonic).toBe(MN);
  });

  it('a DIFFERENT seed is refused — documented first-writer-wins', async () => {
    renderStore();
    await untilReady();
    await lockAfterCommittedBind(MN);

    await act(async () => {
      await expect(store.restoreFromMnemonic(MN_B)).rejects.toBeInstanceOf(VaultMismatchError);
    });
    expect(store.mnemonic).toBeNull();
    expect(store.screen).toBe('restore');
  });
});

// ─── Stage P: the PIN unlock commits ────────────────────────────────

describe('PIN unlock against a configuration that changed mid-derivation', () => {
  const OTHER_BLOB = { ciphertext: 'other', iv: 'iv', salt: 's' };

  it('a wrong-PIN verdict for a REPLACED blob is silent: no error, no metering', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    renderStore();
    await untilReady();

    // Another tab changes the PIN while Argon2id is running (~1 s). The
    // verdict below belongs to a configuration that no longer exists.
    vi.mocked(decryptWithPin).mockImplementationOnce(async () => {
      await setMeta('pin-seed', OTHER_BLOB);
      await setMeta('pin-attempts', 4);
      throw new WrongPinError();
    });

    await act(async () => {
      await expect(store.unlockWithPin('000000')).resolves.toBeUndefined();
    });

    expect(await getMeta('pin-seed')).toEqual(OTHER_BLOB); // not wiped
    expect(await getMeta('pin-attempts')).toBe(4);         // not metered
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    expect(store.screen).toBe('pin');
  });

  it('a reset during the derivation is a silent stand-down — nothing is resurrected', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    renderStore();
    await untilReady();

    vi.mocked(decryptWithPin).mockImplementationOnce(async () => {
      await resetAll(); // «Удалить всё» in another tab, mid-KDF
      throw new WrongPinError();
    });

    await act(async () => {
      await expect(store.unlockWithPin('000000')).resolves.toBeUndefined();
    });

    expect(await getMeta('pin-seed')).toBeUndefined();
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
  });

  // A blob whose kdf is already Argon2id — no legacy re-wrap on the success
  // path, so the reset below lands in the window this describe is about.
  const ARGON2_PIN_BLOB = {
    ciphertext: 'ct', iv: 'iv', salt: 's',
    kdf: 'argon2id' as const, v: 1,
    argon2: { iterations: 3, memorySize: 65_536, parallelism: 1, hashLength: 32 },
  };

  it('a reset AFTER the success commit, before openVault: nothing is re-bound', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', ARGON2_PIN_BLOB);
    renderStore();
    await untilReady();

    vi.mocked(decryptWithPin).mockImplementationOnce(async () => MN);
    // The commit itself succeeds — «Удалить всё» lands immediately after it,
    // in the window between the last guarded write and openVault.
    const realSuccess = vi.mocked(commitPinUnlockSuccess).getMockImplementation()!;
    vi.mocked(commitPinUnlockSuccess).mockImplementationOnce(async (blob, gen) => {
      const outcome = await realSuccess(blob, gen);
      await resetAll();
      return outcome;
    });
    vi.mocked(bindVaultIdentity).mockClear();

    await act(async () => {
      await expect(store.unlockWithPin('000000')).resolves.toBeUndefined();
    });

    // openVault carries the token captured before the KDF: it stands down
    // BEFORE the identity transaction, so nothing is bound into the wiped DB.
    expect(vi.mocked(bindVaultIdentity)).not.toHaveBeenCalled();
    expect(await getMeta('vault-public-key')).toBeUndefined();
    expect(store.mnemonic).toBeNull();
    expect(store.notes).toEqual([]);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).not.toBe('main');
  });

  it('a reset AFTER the legacy re-wrap, before openVault: nothing is re-bound', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB); // legacy → the re-wrap branch runs
    renderStore();
    await untilReady();

    vi.mocked(decryptWithPin).mockImplementationOnce(async () => MN);
    vi.mocked(encryptWithPin).mockResolvedValueOnce(ARGON2_PIN_BLOB); // skip a real Argon2
    const realRewrap = vi.mocked(commitPinSeedRewrap).getMockImplementation()!;
    vi.mocked(commitPinSeedRewrap).mockImplementationOnce(async (blob, next, gen) => {
      const outcome = await realRewrap(blob, next, gen);
      await resetAll(); // the re-wrap committed; THEN the database is wiped
      return outcome;
    });
    vi.mocked(bindVaultIdentity).mockClear();

    await act(async () => {
      await expect(store.unlockWithPin('000000')).resolves.toBeUndefined();
    });

    expect(vi.mocked(bindVaultIdentity)).not.toHaveBeenCalled();
    expect(await getMeta('vault-public-key')).toBeUndefined();
    expect(await getMeta('pin-seed')).toBeUndefined(); // the wipe stands
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).not.toBe('main');
  });

  it('a SUCCESSFUL unlock still opens the vault, but leaves foreign counters alone', async () => {
    await setMeta('init', true);
    await setMeta('pin-seed', FAKE_PIN_BLOB);
    await setMeta('pin-attempts', 3);
    renderStore();
    await untilReady();

    vi.mocked(decryptWithPin).mockImplementationOnce(async () => {
      await setMeta('pin-seed', OTHER_BLOB);
      return MN;
    });

    await act(async () => { await store.unlockWithPin('000000'); });
    await waitFor(() => expect(store.screen).toBe('main'));

    // Same seed came out, so the vault opens — but the metering (and the blob
    // the legacy re-wrap would have replaced) belongs to the other tab now.
    expect(await getMeta('pin-attempts')).toBe(3);
    expect(await getMeta('pin-seed')).toEqual(OTHER_BLOB);
  });
});
