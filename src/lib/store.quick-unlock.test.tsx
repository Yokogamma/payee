// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// «Быстрый вход» — store-level invariants (§8). The FLAG IS ON here; the OFF
// half of the matrix lives in store.quick-unlock-off.test.tsx.
//
// The ceremonies are stubbed (jsdom has no navigator.credentials at all), but
// the CRYPTO IS REAL: HKDF, AES-GCM and the record round-trip all run, so a
// blob written by setup is genuinely the blob unlock opens.

vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: false,
  SAFEBOX_WRITER_ENABLED: false,
  QUICK_UNLOCK_ENABLED: true,
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

// Only the three functions that touch hardware are stubbed. Everything else in
// the core — the HKDF derivation, the envelope, the error classification — is
// the real implementation.
vi.mock('./quick-unlock-core', async importOriginal => {
  const actual = await importOriginal<typeof import('./quick-unlock-core')>();
  return {
    ...actual,
    detectQuickUnlockCapability: vi.fn(async () => 'ready' as const),
    createPrfCredential: vi.fn(),
    evalPrf: vi.fn(),
  };
});

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    readClientConfigSnapshot: vi.fn(actual.readClientConfigSnapshot),
    commitQuickUnlockSeedWrite: vi.fn(actual.commitQuickUnlockSeedWrite),
    commitQuickUnlockSeedDeleteIfMatches: vi.fn(actual.commitQuickUnlockSeedDeleteIfMatches),
    bindVaultIdentity: vi.fn(actual.bindVaultIdentity),
  };
});

// Node's webcrypto rejects cross-realm bare ArrayBuffers, which @noble/ed25519
// passes to digest(). Same proxy as store.test.tsx.
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
import {
  initStorage, resetAll, getMeta, setMeta,
  readClientConfigSnapshot, commitQuickUnlockSeedWrite, commitQuickUnlockSeedDeleteIfMatches,
  bindVaultIdentity,
} from './storage';
import { QUICK_UNLOCK_META_KEY, parseQuickUnlockRecord } from './quick-unlock';
import {
  createPrfCredential, evalPrf, detectQuickUnlockCapability,
  QuickUnlockUnavailableError, QuickUnlockKeyMismatchError,
  QuickUnlockCancelledError, QuickUnlockNotCompletedError, QuickUnlockRecordInvalidError,
} from './quick-unlock-core';
import { isArweaveOnline } from './arweave';

// ─── Fake BroadcastChannel ───────────────────────────────────────────

type ChannelMessage = { data: unknown };

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  onmessage: ((e: ChannelMessage) => void) | null = null;
  closed = false;
  constructor(name: string) { this.name = name; FakeBroadcastChannel.instances.push(this); }
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
beforeAll(() => { savedBroadcastChannel = globalWithBC.BroadcastChannel; globalWithBC.BroadcastChannel = FakeBroadcastChannel; });
afterAll(() => { globalWithBC.BroadcastChannel = savedBroadcastChannel; });

// ─── Harness ─────────────────────────────────────────────────────────

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SESSION_KEY = 'eternal-notes-session';
const FAKE_PIN_BLOB = { ciphertext: 'ct', iv: 'iv', salt: 's' };
const CRED_ID = new Uint8Array(32).fill(0x1d);
const PRF = new Uint8Array(32).fill(0x77);

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}
function renderStore() { return render(<NotesProvider><Probe /></NotesProvider>); }
async function untilReady() { await waitFor(() => expect(store.isReady).toBe(true)); }
async function openMain() {
  await act(async () => { await store.confirmMnemonic(MN); });
  await waitFor(() => expect(store.screen).toBe('main'));
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function listenOnChannel() {
  const channel = new FakeBroadcastChannel('eternal-notes-vault');
  const received: Array<Record<string, unknown>> = [];
  channel.onmessage = e => received.push(e.data as Record<string, unknown>);
  return { channel, received };
}

/** The PIN metering, which NOTHING in this feature may ever touch. */
async function metering() {
  return {
    attempts: await getMeta('pin-attempts'),
    lockedUntil: await getMeta('pin-locked-until'),
  };
}

/** Open a vault, set a PIN and configure quick unlock through the real flow. */
async function configureQuickUnlock(): Promise<void> {
  await openMain();
  await act(async () => { await store.setupPin('123456'); });
  await act(async () => { await store.setupQuickUnlock(); });
  await waitFor(() => expect(store.hasQuickUnlock).toBe(true));
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  FakeBroadcastChannel.instances = [];
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
  vi.mocked(detectQuickUnlockCapability).mockResolvedValue('ready');
  vi.mocked(createPrfCredential).mockImplementation(async () => ({ credentialId: CRED_ID, prfOutput: PRF }));
  vi.mocked(evalPrf).mockImplementation(async () => PRF);
});

afterEach(() => {
  cleanup();
  vi.mocked(createPrfCredential).mockReset();
  vi.mocked(evalPrf).mockReset();
});

// ─── Round trip ──────────────────────────────────────────────────────

describe('setup → unlock round trip', () => {
  it('the blob written by setup is the blob unlock opens — with REAL crypto', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();

    const stored = parseQuickUnlockRecord(await getMeta(QUICK_UNLOCK_META_KEY));
    expect(stored).not.toBeNull();
    expect(stored?.pk).toBe(await getMeta('vault-public-key'));
    expect(store.quickUnlockMeta?.createdAt).toBe(stored?.createdAt);

    act(() => { store.lockApp(); });
    expect(store.screen).toBe('pin');
    // The record survives a lock — the PIN screen must know to offer it.
    expect(store.hasQuickUnlock).toBe(true);

    await act(async () => { await store.unlockWithQuickUnlock(); });
    await waitFor(() => expect(store.screen).toBe('main'));
    expect(store.mnemonic).toBe(MN);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(MN);
  });

  it('hasQuickUnlock is DERIVED — it tracks quickUnlockMeta exactly', async () => {
    renderStore();
    await untilReady();
    expect(store.quickUnlockMeta).toBeNull();
    expect(store.hasQuickUnlock).toBe(false);

    await configureQuickUnlock();
    expect(store.hasQuickUnlock).toBe(store.quickUnlockMeta !== null);

    await act(async () => { await store.removeQuickUnlock(); });
    expect(store.quickUnlockMeta).toBeNull();
    expect(store.hasQuickUnlock).toBe(false);
  });

  it('a valid record is visible from the FIRST paint of the PIN screen', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();

    cleanup();
    sessionStorage.clear(); // cold boot onto the PIN screen
    renderStore();
    await untilReady();
    expect(store.screen).toBe('pin');
    expect(store.hasQuickUnlock).toBe(true); // hydrated from the same snapshot
  });
});

// ─── THE invariant: the PIN meter is never touched ───────────────────

describe('the PIN metering is untouchable (§8, invariants 1–5)', () => {
  const OUTCOMES: Array<[string, () => void]> = [
    ['cancel / our abort', () => vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockCancelledError())],
    ['NotAllowedError', () => vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockNotCompletedError())],
    ['no PRF / unavailable', () => vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockUnavailableError('no prf'))],
    ['GCM mismatch', () => vi.mocked(evalPrf).mockResolvedValue(new Uint8Array(32).fill(0x11))],
  ];

  for (const [name, arrange] of OUTCOMES) {
    it(`${name}: pin-attempts and pin-locked-until are unchanged`, async () => {
      renderStore();
      await untilReady();
      await configureQuickUnlock();
      await setMeta('pin-attempts', 3);
      const before = await metering();

      act(() => { store.lockApp(); });
      arrange();
      await act(async () => { await store.unlockWithQuickUnlock().catch(() => {}); });

      expect(await metering()).toEqual(before);
      expect(store.screen).toBe('pin');
      expect(store.mnemonic).toBeNull();
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    });
  }

  it('an ACTIVE PIN lockout does not block quick unlock — a different contour', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    await setMeta('pin-attempts', 7);
    const lockedUntil = Date.now() + 300_000;
    await setMeta('pin-locked-until', lockedUntil);

    act(() => { store.lockApp(); });
    await act(async () => { await store.unlockWithQuickUnlock(); });
    await waitFor(() => expect(store.screen).toBe('main'));

    // …and a SUCCESSFUL quick unlock does not reset somebody else's meter.
    expect(await getMeta('pin-attempts')).toBe(7);
    expect(await getMeta('pin-locked-until')).toBe(lockedUntil);
  });

  it('a failed SETUP does not meter either', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });
    await setMeta('pin-attempts', 2);
    const before = await metering();

    vi.mocked(createPrfCredential).mockRejectedValue(new QuickUnlockNotCompletedError());
    await act(async () => { await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockNotCompletedError); });

    expect(await metering()).toEqual(before);
  });
});

// ─── Error classification and the record's fate ──────────────────────

describe('what may and may not delete the record', () => {
  it('a GCM mismatch deletes THAT record and lands on the PIN screen', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });

    vi.mocked(evalPrf).mockResolvedValue(new Uint8Array(32).fill(0x11)); // wrong key
    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockKeyMismatchError);
    });

    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
    await waitFor(() => expect(store.hasQuickUnlock).toBe(false));
    expect(store.screen).toBe('pin');
  });

  it('NotAllowedError deletes NOTHING and says nothing about a missing key', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    const record = await getMeta(QUICK_UNLOCK_META_KEY);
    act(() => { store.lockApp(); });

    vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockNotCompletedError());
    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockNotCompletedError);
    });

    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(record);
    expect(store.hasQuickUnlock).toBe(true);
  });

  it('an UNAVAILABLE ceremony deletes nothing either', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    const record = await getMeta(QUICK_UNLOCK_META_KEY);
    act(() => { store.lockApp(); });

    vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockUnavailableError('device said no'));
    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(record);
  });

  it('OUR abort is the ONLY silent outcome — it resolves, it does not reject', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });

    vi.mocked(evalPrf).mockRejectedValue(new QuickUnlockCancelledError());
    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).resolves.toBeUndefined();
    });
    expect(store.screen).toBe('pin');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeDefined();
  });

  it('a mismatch against a record ANOTHER TAB replaced says «not completed», not «deleted»', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });

    // The conditional delete reports 'changed' — the replacement is intact.
    vi.mocked(commitQuickUnlockSeedDeleteIfMatches).mockResolvedValueOnce('changed');
    vi.mocked(evalPrf).mockResolvedValue(new Uint8Array(32).fill(0x11));
    await act(async () => {
      const err = await store.unlockWithQuickUnlock().catch(e => e);
      expect(err).toBeInstanceOf(QuickUnlockUnavailableError);
      expect(err.message).not.toContain('подходит'); // never claims removal
    });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeDefined();
  });

  it('a decrypted-but-INVALID mnemonic never reaches openVault', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });
    vi.mocked(bindVaultIdentity).mockClear();

    // Re-wrap garbage under the SAME key so the GCM tag passes.
    const { deriveQuickUnlockKek, wrapWithKek, QUICK_UNLOCK_VAULT_INFO } =
      await vi.importActual<typeof import('./quick-unlock-core')>('./quick-unlock-core');
    const { base64ToBuffer, bufferToBase64 } = await vi.importActual<typeof import('./crypto')>('./crypto');
    const rec = parseQuickUnlockRecord(await getMeta(QUICK_UNLOCK_META_KEY))!;
    const kek = await deriveQuickUnlockKek(PRF, base64ToBuffer(rec.hkdfSalt), QUICK_UNLOCK_VAULT_INFO);
    const bad = await wrapWithKek(kek, base64ToBuffer(rec.iv), 'not a mnemonic at all');
    await setMeta(QUICK_UNLOCK_META_KEY, { ...rec, ciphertext: bufferToBase64(bad) });

    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockRecordInvalidError);
    });
    expect(vi.mocked(bindVaultIdentity)).not.toHaveBeenCalled();
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

// ─── The compatibility rule ──────────────────────────────────────────

describe('a record without a PIN is void', () => {
  it('removing the PIN takes the record with it, atomically', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();

    await act(async () => { await store.removePin(); });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
    expect(store.hasQuickUnlock).toBe(false);
  });

  it('an ORPHANED record (older client removed the PIN) is refused AND cleaned up', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });

    // Exactly what a build without this feature leaves behind: the PIN gone,
    // the record still there (its clearPinConfigMeta never knew about it).
    const db = await import('./storage');
    await db.deleteMeta('pin-seed');

    await act(async () => {
      await expect(store.unlockWithQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    await waitFor(async () => expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined());
    expect(vi.mocked(evalPrf)).not.toHaveBeenCalled(); // no pointless system sheet
  });

  it('resetApp leaves no record behind', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    await act(async () => { await store.resetApp(); });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
    expect(store.hasQuickUnlock).toBe(false);
  });
});

// ─── Setup lifecycle: the shared controller ──────────────────────────

describe('setup lifecycle', () => {
  it('a lock during the STORAGE READ never starts a ceremony', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    const gate = deferred<Awaited<ReturnType<typeof readClientConfigSnapshot>>>();
    vi.mocked(readClientConfigSnapshot).mockImplementationOnce(() => gate.promise);

    let pending!: Promise<void>;
    act(() => { pending = store.setupQuickUnlock(); });
    act(() => { store.lockApp(); }); // the ref is already armed — this aborts it

    await act(async () => {
      gate.resolve({
        pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null, vaultPublicKey: 'pk',
        quickUnlock: { kind: 'none' },
      });
      await pending;
    });

    expect(vi.mocked(createPrfCredential)).not.toHaveBeenCalled();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('a lock during the CAPABILITY probe never calls create()', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    const gate = deferred<'ready'>();
    vi.mocked(detectQuickUnlockCapability).mockImplementationOnce(() => gate.promise);

    let pending!: Promise<void>;
    act(() => { pending = store.setupQuickUnlock(); });
    await act(async () => {}); // let the snapshot read settle
    act(() => { store.lockApp(); });

    await act(async () => { gate.resolve('ready'); await pending; });
    expect(vi.mocked(createPrfCredential)).not.toHaveBeenCalled();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('a lock after the ceremony but BEFORE the commit writes no blob', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    const gate = deferred<{ credentialId: Uint8Array; prfOutput: Uint8Array }>();
    vi.mocked(createPrfCredential).mockImplementationOnce(() => gate.promise);

    let pending!: Promise<void>;
    act(() => { pending = store.setupQuickUnlock(); });
    await waitFor(() => expect(vi.mocked(createPrfCredential)).toHaveBeenCalled());
    act(() => { store.lockApp(); });

    await act(async () => { gate.resolve({ credentialId: CRED_ID, prfOutput: PRF }); await pending; });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
    expect(store.hasQuickUnlock).toBe(false);
  });

  it('POINT OF NO RETURN: a lock after the commit keeps the record AND publishes the button', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });
    const { received } = listenOnChannel();

    // The commit runs for real, then the lock lands before publication.
    const real = vi.mocked(commitQuickUnlockSeedWrite).getMockImplementation()!;
    vi.mocked(commitQuickUnlockSeedWrite).mockImplementationOnce(async (rec, gen) => {
      const outcome = await real(rec, gen);
      store.lockApp();
      return outcome;
    });

    await act(async () => { await store.setupQuickUnlock(); });

    // The record exists…
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeDefined();
    // …other tabs were told…
    await act(async () => {});
    expect(received.some(m => m.type === 'config')).toBe(true);
    // …and THIS tab shows the button, without a reload: it never hears its own
    // broadcast (echo is filtered by originId), so publication cannot wait for
    // one. createdAt is not plaintext; the lock does not hide it.
    expect(store.hasQuickUnlock).toBe(true);
    expect(store.screen).toBe('pin'); // sensitive state IS gone
    expect(store.mnemonic).toBeNull();
  });

  it('a RESET after the commit publishes nothing — metadata must not resurrect', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    const real = vi.mocked(commitQuickUnlockSeedWrite).getMockImplementation()!;
    vi.mocked(commitQuickUnlockSeedWrite).mockImplementationOnce(async (rec, gen) => {
      const outcome = await real(rec, gen);
      await resetAll(); // the database this record belonged to is gone
      return outcome;
    });

    await act(async () => { await store.setupQuickUnlock(); });
    expect(store.hasQuickUnlock).toBe(false);
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('a PIN removed by another tab mid-setup: the commit refuses, no blob', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    vi.mocked(createPrfCredential).mockImplementationOnce(async () => {
      const db = await import('./storage');
      await db.clearPinConfigMeta(); // another tab drops the PIN mid-ceremony
      return { credentialId: CRED_ID, prfOutput: PRF };
    });

    await act(async () => {
      await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('the early filter refuses a SECOND setup without opening a sheet', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    vi.mocked(createPrfCredential).mockClear();

    await act(async () => {
      await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(vi.mocked(createPrfCredential)).not.toHaveBeenCalled();
  });

  it("a racing tab that wins the commit gets 'already-configured' and clobbers nothing", async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });

    vi.mocked(commitQuickUnlockSeedWrite).mockResolvedValueOnce('already-configured');
    await act(async () => {
      await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    // Nothing of ours was written, and the state was re-read.
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('setup without an open vault rejects instead of doing nothing', async () => {
    renderStore();
    await untilReady();
    await expect(store.setupQuickUnlock()).rejects.toBeDefined();
  });
});

// ─── The shared controller ───────────────────────────────────────────

describe('one controller for both ceremonies', () => {
  it('a new attempt aborts the previous one, and the old finally keeps the new handle', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });

    const first = deferred<Uint8Array>();
    vi.mocked(evalPrf).mockImplementationOnce(() => first.promise);

    let pendingA!: Promise<void>;
    act(() => { pendingA = store.unlockWithQuickUnlock(); });
    await waitFor(() => expect(vi.mocked(evalPrf)).toHaveBeenCalledTimes(1));

    // B starts and aborts A. A's rejection must be silent.
    const pendingB = store.unlockWithQuickUnlock();
    await act(async () => {
      first.reject(new QuickUnlockCancelledError());
      await expect(pendingA).resolves.toBeUndefined();
      await pendingB;
    });

    await waitFor(() => expect(store.screen).toBe('main')); // B completed
  });
});

// ─── Reset / lock races around the unlock path ───────────────────────

describe('races on the unlock path', () => {
  it('a reset DURING the ceremony: nothing is published, bind is never called', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });
    vi.mocked(bindVaultIdentity).mockClear();

    vi.mocked(evalPrf).mockImplementationOnce(async () => {
      await resetAll(); // «Удалить всё» in another tab, mid-sheet
      return PRF;
    });

    await act(async () => { await store.unlockWithQuickUnlock().catch(() => {}); });

    expect(vi.mocked(bindVaultIdentity)).not.toHaveBeenCalled();
    expect(store.mnemonic).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(store.screen).not.toBe('main');
  });

  it('a foreign LOCK broadcast during the ceremony ends it silently', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });
    const { channel } = listenOnChannel();

    const gate = deferred<Uint8Array>();
    vi.mocked(evalPrf).mockImplementationOnce(({ signal }) => {
      signal?.addEventListener('abort', () => gate.reject(new QuickUnlockCancelledError()));
      return gate.promise;
    });

    let pending!: Promise<void>;
    act(() => { pending = store.unlockWithQuickUnlock(); });
    await waitFor(() => expect(vi.mocked(evalPrf)).toHaveBeenCalled());

    channel.postMessage({ type: 'lock', originId: 'other-tab', messageId: 'qu-lock' });
    await act(async () => { await expect(pending).resolves.toBeUndefined(); });

    expect(store.screen).toBe('pin');
    expect(store.mnemonic).toBeNull();
  });

  it('a foreign RESET broadcast during the ceremony ends it silently too', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    act(() => { store.lockApp(); });
    const { channel } = listenOnChannel();

    const gate = deferred<Uint8Array>();
    vi.mocked(evalPrf).mockImplementationOnce(({ signal }) => {
      signal?.addEventListener('abort', () => gate.reject(new QuickUnlockCancelledError()));
      return gate.promise;
    });

    let pending!: Promise<void>;
    act(() => { pending = store.unlockWithQuickUnlock(); });
    await waitFor(() => expect(vi.mocked(evalPrf)).toHaveBeenCalled());

    channel.postMessage({ type: 'reset', originId: 'other-tab', messageId: 'qu-reset' });
    await act(async () => { await expect(pending).resolves.toBeUndefined(); });
    expect(store.mnemonic).toBeNull();
  });
});

// ─── Cross-tab state ─────────────────────────────────────────────────

describe('cross-tab reconcile', () => {
  it("a 'config' message publishes the record another tab wrote", async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    const { channel } = listenOnChannel();

    await act(async () => { await store.removeQuickUnlock(); });
    expect(store.hasQuickUnlock).toBe(false);

    // Another tab configures it again, in storage, then announces it.
    const record = {
      v: 1 as const,
      credentialId: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      prfSalt: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
      hkdfSalt: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
      iv: 'BAQEBAQEBAQEBAQE',
      ciphertext: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=',
      pk: String(await getMeta('vault-public-key')),
      createdAt: 1_700_000_000_000,
    };
    await setMeta(QUICK_UNLOCK_META_KEY, record);
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'qu-cfg' });

    await waitFor(() => expect(store.hasQuickUnlock).toBe(true));
    expect(store.quickUnlockMeta?.createdAt).toBe(1_700_000_000_000);
  });

  it('a stale reconcile cannot resurrect the record after removeQuickUnlock', async () => {
    renderStore();
    await untilReady();
    await configureQuickUnlock();
    const { channel } = listenOnChannel();

    const gate = deferred<Awaited<ReturnType<typeof readClientConfigSnapshot>>>();
    const stored = parseQuickUnlockRecord(await getMeta(QUICK_UNLOCK_META_KEY))!;
    vi.mocked(readClientConfigSnapshot).mockImplementationOnce(() => gate.promise);
    channel.postMessage({ type: 'config', originId: 'other-tab', messageId: 'qu-stale' });
    await act(async () => {}); // reconcile A pending on the deferred read

    await act(async () => { await store.removeQuickUnlock(); }); // local write bumps the token

    await act(async () => {
      gate.resolve({
        pinSeed: FAKE_PIN_BLOB, autoLockTimeout: null,
        vaultPublicKey: stored.pk, quickUnlock: { kind: 'valid', record: stored },
      });
    });
    expect(store.hasQuickUnlock).toBe(false); // the stale read was discarded
  });
});

// ─── Capability ──────────────────────────────────────────────────────

describe('capability probe', () => {
  it('publishes the verdict and never rejects', async () => {
    renderStore();
    await untilReady();
    vi.mocked(detectQuickUnlockCapability).mockResolvedValue('no-prf');
    act(() => { store.refreshQuickUnlockCapability(); });
    await waitFor(() => expect(store.quickUnlockCapability).toBe('no-prf'));
  });

  it("'unknown' does NOT block a setup attempt — only the ceremony decides", async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });
    vi.mocked(detectQuickUnlockCapability).mockResolvedValue('unknown');

    await act(async () => { await store.setupQuickUnlock(); });
    expect(store.hasQuickUnlock).toBe(true);
  });

  it('a negative verdict refuses BEFORE the ceremony', async () => {
    renderStore();
    await untilReady();
    await openMain();
    await act(async () => { await store.setupPin('123456'); });
    vi.mocked(detectQuickUnlockCapability).mockResolvedValue('no-platform');
    vi.mocked(createPrfCredential).mockClear();

    await act(async () => {
      await expect(store.setupQuickUnlock()).rejects.toBeInstanceOf(QuickUnlockUnavailableError);
    });
    expect(vi.mocked(createPrfCredential)).not.toHaveBeenCalled();
  });
});
