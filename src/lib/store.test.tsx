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
vi.mock('./flags', () => ({ V3_WRITER_ENABLED: false, SAFEBOX_WRITER_ENABLED: false }));

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
  };
});

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    // Overridable per-test (persist-first / partial-cleanup / gate failures).
    getMeta: vi.fn(actual.getMeta),
    setMeta: vi.fn(actual.setMeta),
    saveNote: vi.fn(actual.saveNote),
    getPinConfigMeta: vi.fn(actual.getPinConfigMeta),
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

import { NotesProvider, useNotes, PinWipedError, WriterDisabledError, OperationInFlightError } from './store';
import {
  initStorage, resetAll, getMeta, setMeta, getPinConfigMeta, getAllSyncRecords,
  clearPinConfigMeta, saveNote, getAllNotes as getStoredNotes,
} from './storage';
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
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }); }),
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
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }); }),
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
    vi.mocked(getPinConfigMeta).mockImplementationOnce(
      () => new Promise(res => { releaseRead = () => res({ pinSeed: FAKE_PIN_BLOB, autoLockTimeout: 300 }); }),
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
