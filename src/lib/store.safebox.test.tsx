// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// W4 matrix: the safebox slice with SAFEBOX_WRITER_ENABLED mocked ON, against
// REAL storage (fake-indexeddb) and REAL envelope crypto, with only the network
// and the (deliberately expensive) Argon2 KDF mocked.

vi.mock('./flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: true, QUICK_UNLOCK_ENABLED: false }));

// Argon2id is ~1 s per call by design. The REAL KDF profile is exercised in
// safebox-pin.test.ts; here we only need the PIN gate's LOGIC, so swap in a
// fast deterministic stand-in.
vi.mock('hash-wasm', () => ({
  argon2id: async ({ password, salt }: { password: string; salt: Uint8Array }) => {
    const data = new TextEncoder().encode(`${password}:${Array.from(salt).join(',')}`);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  },
}));

// Lets a test park an operation INSIDE its crypto phase — i.e. after every
// early check has already passed — which is the only way to prove the
// pre-write epoch re-check actually guards anything.
const cryptoHooks = vi.hoisted(() => ({
  beforeEncryptEntry: null as null | (() => void | Promise<void>),
  beforeCreatePinBlob: null as null | (() => void | Promise<void>),
  beforeVerifyPin: null as null | (() => void | Promise<void>),
  beforeDecryptMeta: null as null | (() => void | Promise<void>),
  beforeDeriveSecretKey: null as null | (() => void | Promise<void>),
}));

vi.mock('./crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('./crypto')>();
  return {
    ...actual,
    encryptSafeboxEntry: vi.fn(async (...args: Parameters<typeof actual.encryptSafeboxEntry>) => {
      await cryptoHooks.beforeEncryptEntry?.();
      return actual.encryptSafeboxEntry(...args);
    }),
    createSafeboxPinBlob: vi.fn(async (...args: Parameters<typeof actual.createSafeboxPinBlob>) => {
      await cryptoHooks.beforeCreatePinBlob?.();
      return actual.createSafeboxPinBlob(...args);
    }),
    decryptSafeboxMeta: vi.fn(async (...args: Parameters<typeof actual.decryptSafeboxMeta>) => {
      const hook = cryptoHooks.beforeDecryptMeta;
      cryptoHooks.beforeDecryptMeta = null; // one-shot
      await hook?.();
      return actual.decryptSafeboxMeta(...args);
    }),
    verifySafeboxPin: vi.fn(async (...args: Parameters<typeof actual.verifySafeboxPin>) => {
      const hook = cryptoHooks.beforeVerifyPin;
      cryptoHooks.beforeVerifyPin = null; // one-shot: never re-enter
      await hook?.();
      return actual.verifySafeboxPin(...args);
    }),
    deriveSafeboxSecretKey: vi.fn(async (...args: Parameters<typeof actual.deriveSafeboxSecretKey>) => {
      const hook = cryptoHooks.beforeDeriveSecretKey;
      cryptoHooks.beforeDeriveSecretKey = null; // one-shot
      await hook?.();
      return actual.deriveSafeboxSecretKey(...args);
    }),
  };
});

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

// Same cross-realm digest shim as store.test.tsx (noble/ed25519 under jsdom).
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
  NotesProvider, useNotes, OperationInFlightError,
  SafeboxPinWipedError, SafeboxLockedError, SafeboxSeedRequiredError,
  SafeboxSeedMismatchError, SafeboxSamePinError, SafeboxNotConfiguredError,
  SafeboxConfigChangedError,
} from './store';
import {
  initStorage, resetAll, setMeta, getMeta,
  getAllSafeboxEntries, countSafeboxEntries, getAllSyncRecords, getSyncRecord,
  setSyncRecord, saveSafeboxEntryWithSync, readSafeboxPinConfig, readV4PauseMeta,
  commitSafeboxPinWrite, getDbGeneration, SAFEBOX_PIN_META_KEY, V4_PAUSE_META_KEY,
} from './storage';
import { uploadViaProxy, getWorkerCapabilities, isArweaveOnline, fetchAllNotes } from './arweave';
import { mergeRestoredNote } from './storage';
import {
  encryptWithPin, deriveSafeboxMetaKey, deriveSafeboxSecretKey,
  encryptSafeboxEntry, decryptSafeboxMeta, createSafeboxPinBlob,
  deriveKey, encryptEnvelopeV3, base64ToBuffer, bufferToBase64,
} from './crypto';

// ─── Fake BroadcastChannel (jsdom has none) ─────────────────────────

type ChannelMessage = { data: unknown };
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static enabled = true;
  name: string;
  onmessage: ((e: ChannelMessage) => void) | null = null;
  closed = false;
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    if (!FakeBroadcastChannel.enabled) return;
    for (const ch of FakeBroadcastChannel.instances) {
      if (ch === this || ch.closed || ch.name !== this.name) continue;
      queueMicrotask(() => { if (!ch.closed) ch.onmessage?.({ data }); });
    }
  }
  close(): void { this.closed = true; }
}

const globalWithBC = globalThis as { BroadcastChannel?: unknown };
let savedBC: unknown;
beforeAll(() => { savedBC = globalWithBC.BroadcastChannel; globalWithBC.BroadcastChannel = FakeBroadcastChannel; });
afterAll(() => { globalWithBC.BroadcastChannel = savedBC; });

// ─── Harness ────────────────────────────────────────────────────────

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MN = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const PIN = '135790';
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
async function openMain() {
  await waitFor(() => expect(store.isReady).toBe(true));
  await act(async () => { await store.confirmMnemonic(MN); });
  await waitFor(() => expect(store.screen).toBe('main'));
}
/** Open the vault AND activate + unlock the safebox. The seed is supplied
 *  because several tests seed entries first — activation over EXISTING data
 *  demands proof-by-decrypt, which is exactly the contract under test. */
async function openSafebox() {
  await openMain();
  await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
  await waitFor(() => expect(store.safeboxUnlocked).toBe(true));
}

/** Another tab installs its OWN safebox config (new configId). */
async function foreignTabReplacesConfig() {
  return commitSafeboxPinWrite(await createSafeboxPinBlob('999999'), 'seed-authorized', getDbGeneration());
}

/** Sync needs BOTH the persisted flag and a live «online» probe. */
async function enableSync() {
  await setMeta('ar-enabled', true);
  vi.mocked(isArweaveOnline).mockResolvedValue(true);
}

const ENTRY = {
  title: 'GitHub', login: 'yoko', url: 'https://github.com', note: 'рабочий',
  password: 'CORRECT-HORSE', files: [],
};

/** Write an encrypted entry straight to storage (simulates another device). */
async function seedEntry(over: Partial<Parameters<typeof encryptSafeboxEntry>[2]> = {}) {
  const metaKey = await deriveSafeboxMetaKey(MN);
  const secretKey = await deriveSafeboxSecretKey(MN);
  const entry = await encryptSafeboxEntry(metaKey, secretKey, {
    title: 'seeded', login: 'l', url: '', note: '', password: 'SEEDED-PW', files: [], rev: 1,
    ...over,
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
  FakeBroadcastChannel.instances.length = 0;
  FakeBroadcastChannel.enabled = true;
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
  vi.mocked(uploadViaProxy).mockReset();
  vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'error', error: 'offline' });
  vi.mocked(getWorkerCapabilities).mockResolvedValue({ uploads: 'unknown', v3: 'unknown', v4: 'unknown' });
  cryptoHooks.beforeEncryptEntry = null;
  cryptoHooks.beforeCreatePinBlob = null;
  cryptoHooks.beforeVerifyPin = null;
  cryptoHooks.beforeDecryptMeta = null;
  cryptoHooks.beforeDeriveSecretKey = null;
  await setMeta('init', true);
});
afterEach(() => cleanup());

// ─── Activation / unlock / lock ─────────────────────────────────────

describe('safebox activation and unlock', () => {
  it('first activation stores a config with a fresh configId and opens the section', async () => {
    renderStore();
    await openMain();
    expect(store.safeboxPinConfigured).toBe(false);
    expect(store.safeboxUnlocked).toBe(false);

    await act(async () => { await store.activateSafebox(PIN); });

    const config = await readSafeboxPinConfig();
    expect(config).not.toBeNull();
    expect(config!.attempts).toBe(0);
    expect(store.safeboxPinConfigured).toBe(true);
    expect(store.safeboxUnlocked).toBe(true);
  });

  it('rejects a PIN that is not 6–8 digits', async () => {
    renderStore();
    await openMain();
    for (const bad of ['12345', '123456789', '12345a']) {
      await expect(store.activateSafebox(bad)).rejects.toBeDefined();
    }
    expect(await readSafeboxPinConfig()).toBeNull();
  });

  it('unlock decrypts every META and publishes chains; lock drops them SYNCHRONOUSLY', async () => {
    await seedEntry({ title: 'первая' });
    renderStore();
    await openSafebox();

    expect(store.safeboxEntries.map(e => e.title)).toEqual(['первая']);
    expect(store.safeboxChains).toHaveLength(1);

    act(() => { store.lockSafebox(); });
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.safeboxEntries).toEqual([]);
    expect(store.safeboxChains).toEqual([]);
    // The data itself is untouched — only the session is gone.
    expect(await countSafeboxEntries()).toBe(1);

    await act(async () => { await store.unlockSafebox(PIN); });
    expect(store.safeboxEntries.map(e => e.title)).toEqual(['первая']);
  });

  it('a wrong PIN is metered; the 10th wipes the CONFIG and keeps the DATA', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });

    for (let i = 1; i <= 3; i++) {
      await expect(store.unlockSafebox('000000')).rejects.toBeDefined();
    }
    expect((await readSafeboxPinConfig())?.attempts).toBe(3);

    // Attempts 4..9 arm a lockout; clear it each time so we can reach the wipe.
    for (let i = 4; i <= 9; i++) {
      const cfg = (await readSafeboxPinConfig())!;
      await setMeta(SAFEBOX_PIN_META_KEY, { ...cfg, lockedUntil: null });
      await expect(store.unlockSafebox('000000')).rejects.toBeDefined();
    }
    const cfg = (await readSafeboxPinConfig())!;
    await setMeta(SAFEBOX_PIN_META_KEY, { ...cfg, lockedUntil: null });
    await expect(store.unlockSafebox('000000')).rejects.toBeInstanceOf(SafeboxPinWipedError);

    expect(await readSafeboxPinConfig()).toBeNull();
    await waitFor(() => expect(store.safeboxPinConfigured).toBe(false));
    expect(await countSafeboxEntries()).toBe(1); // entries survive the wipe
  });

  it('unlock without a configuration throws SafeboxNotConfiguredError', async () => {
    renderStore();
    await openMain();
    await expect(store.unlockSafebox(PIN)).rejects.toBeInstanceOf(SafeboxNotConfiguredError);
  });
});

// ─── Lifecycle: both lock kinds, pagehide, pageshow ─────────────────

describe('safebox locking (§3)', () => {
  it('an APP lock also locks the section (both epochs move)', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockApp(); });
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.safeboxEntries).toEqual([]);
  });

  it('pagehide alone locks the safebox (no visibility edge needed)', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('a hidden visibility edge locks the safebox', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(store.safeboxUnlocked).toBe(false);
    spy.mockRestore();
  });

  it('a BFCache pageshow leaves the section CLOSED (fail-closed control check)', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('a reveal in flight when a lock lands publishes NOTHING', async () => {
    const entry = await seedEntry({ password: 'SECRET' });
    renderStore();
    await openSafebox();

    let error: unknown;
    await act(async () => {
      const p = store.revealSafeboxSecret(entry.entryId).catch(e => { error = e; });
      store.lockSafebox(); // section lock DURING the decrypt
      await p;
    });
    expect(error).toBeInstanceOf(SafeboxLockedError);
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('an APP lock in flight also aborts a reveal', async () => {
    const entry = await seedEntry({ password: 'SECRET' });
    renderStore();
    await openSafebox();

    let error: unknown;
    await act(async () => {
      const p = store.revealSafeboxSecret(entry.entryId).catch(e => { error = e; });
      store.lockApp();
      await p;
    });
    expect(error).toBeDefined();
  });

  it('reveal/copy/download refuse outright while the section is locked', async () => {
    const entry = await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });
    await expect(store.revealSafeboxSecret(entry.entryId)).rejects.toBeInstanceOf(SafeboxLockedError);
    await expect(store.copySafeboxPassword(entry.entryId)).rejects.toBeInstanceOf(SafeboxLockedError);
    await expect(store.downloadSafeboxAttachment(entry.entryId, 'f')).rejects.toBeInstanceOf(SafeboxLockedError);
  });
});

// ─── Storage-backed configId recheck (works WITHOUT BroadcastChannel) ──

describe('configId recheck before publishing a secret (§2)', () => {
  it('a PIN replaced in "another tab" invalidates the session even with NO BroadcastChannel', async () => {
    const entry = await seedEntry({ password: 'SECRET' });
    // Simulate an environment without the channel: the store falls back to
    // per-tab behaviour and the STORAGE recheck is the only guarantee left.
    FakeBroadcastChannel.enabled = false;

    renderStore();
    await openSafebox();
    expect(await store.revealSafeboxSecret(entry.entryId)).toBe('SECRET');

    // Another tab replaces the configuration (new configId), no broadcast.
    await foreignTabReplacesConfig();

    await act(async () => {
      await expect(store.revealSafeboxSecret(entry.entryId))
        .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    });
    await waitFor(() => expect(store.safeboxUnlocked).toBe(false)); // stale session closed
  });

  it('a config DELETED in another tab also invalidates the session', async () => {
    const entry = await seedEntry();
    FakeBroadcastChannel.enabled = false;
    renderStore();
    await openSafebox();
    await (await import('./storage')).deleteMeta(SAFEBOX_PIN_META_KEY);
    await expect(store.revealSafeboxSecret(entry.entryId))
      .rejects.toBeInstanceOf(SafeboxConfigChangedError);
  });

  it('a cross-tab `config` broadcast locks this tab when the configId changed', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();

    // A second "tab" on the same channel announces a config change.
    await foreignTabReplacesConfig();
    const other = new FakeBroadcastChannel('eternal-notes-vault');
    await act(async () => {
      other.postMessage({ type: 'config', originId: 'other-tab', messageId: crypto.randomUUID() });
      await new Promise(r => setTimeout(r, 0));
    });
    await waitFor(() => expect(store.safeboxUnlocked).toBe(false));
  });
});

// ─── Writer actions ─────────────────────────────────────────────────

describe('safebox writer actions (flag ON)', () => {
  it('addSafeboxEntry persists a rev-1 chain root and publishes its meta', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });

    const stored = await getAllSafeboxEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0].v).toBe(4);
    expect(store.safeboxChains).toHaveLength(1);
    expect(store.safeboxChains[0].current.title).toBe('GitHub');
    expect(store.safeboxChains[0].current.rev).toBe(1);

    // The password is readable through the explicit action only.
    expect(await store.revealSafeboxSecret(stored[0].entryId)).toBe('CORRECT-HORSE');
  });

  it('a second concurrent add rejects with OperationInFlightError (one entry saved)', async () => {
    renderStore();
    await openSafebox();
    let second: unknown;
    await act(async () => {
      const p1 = store.addSafeboxEntry(ENTRY);
      const p2 = store.addSafeboxEntry(ENTRY).catch(e => { second = e; });
      await Promise.all([p1, p2]);
    });
    expect(second).toBeInstanceOf(OperationInFlightError);
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('edit applies the PATCH contract: untouched password and files carry over', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;

    await act(async () => {
      await store.editSafeboxEntry(root, {
        title: 'GitHub (work)', login: 'yoko', url: 'https://github.com', note: 'обновлено',
        files: [], // no password action, no file actions
      });
    });

    const chain = store.safeboxChains[0];
    expect(chain.versions).toHaveLength(2);
    expect(chain.current.title).toBe('GitHub (work)');
    expect(chain.current.rev).toBe(2);
    expect(chain.current.prev).toBe(root);
    // The password survived an edit that never decrypted it in the form.
    expect(await store.revealSafeboxSecret(chain.current.id)).toBe('CORRECT-HORSE');
  });

  it('edit can REPLACE the password without touching anything else', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    await act(async () => {
      await store.editSafeboxEntry(root, {
        title: ENTRY.title, login: ENTRY.login, url: ENTRY.url, note: ENTRY.note,
        password: { kind: 'replace', value: 'NEW-PASSWORD' },
        files: [],
      });
    });
    expect(await store.revealSafeboxSecret(store.safeboxChains[0].current.id)).toBe('NEW-PASSWORD');
  });

  it('restoreSafeboxVersion re-publishes the FULL old content as a new head version', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    const original = store.safeboxChains[0].current.id;

    await act(async () => {
      await store.editSafeboxEntry(root, {
        title: 'Новое', login: 'other', url: '', note: '',
        password: { kind: 'replace', value: 'NEW' }, files: [],
      });
    });
    await act(async () => { await store.restoreSafeboxVersion(root, original); });

    const chain = store.safeboxChains[0];
    expect(chain.versions).toHaveLength(3);
    expect(chain.current.rev).toBe(3);
    expect(chain.current.title).toBe('GitHub');       // meta restored
    expect(chain.current.login).toBe('yoko');
    expect(await store.revealSafeboxSecret(chain.current.id)).toBe('CORRECT-HORSE'); // secret too
  });

  it('a lock during restoreSafeboxVersion aborts it without writing', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    const versionId = store.safeboxChains[0].current.id;
    const before = await countSafeboxEntries();

    let error: unknown;
    await act(async () => {
      const p = store.restoreSafeboxVersion(root, versionId).catch(e => { error = e; });
      store.lockSafebox();
      await p;
    });
    expect(error).toBeDefined();
    expect(await countSafeboxEntries()).toBe(before);
  });

  it('a config replaced mid-write refuses the version (atomic recheck + save)', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    const before = await countSafeboxEntries();

    // Another tab replaces the configuration between capture and commit.
    await foreignTabReplacesConfig();

    await expect(store.editSafeboxEntry(root, {
      title: 'x', login: '', url: '', note: '', files: [],
    })).rejects.toBeInstanceOf(SafeboxConfigChangedError);
    expect(await countSafeboxEntries()).toBe(before);
  });

  it('an over-limit entry is rejected BEFORE it is persisted', async () => {
    renderStore();
    await openSafebox();
    const { SafeboxEntryTooLargeError } = await import('./limits');
    await expect(store.addSafeboxEntry({
      ...ENTRY, note: 'ы'.repeat(30_000),
    })).rejects.toBeInstanceOf(SafeboxEntryTooLargeError);
    expect(await countSafeboxEntries()).toBe(0);
  });

  it('a reset during an in-flight add does not resurrect the entry', async () => {
    renderStore();
    await openSafebox();
    let error: unknown;
    await act(async () => {
      const p = store.addSafeboxEntry(ENTRY).catch(e => { error = e; });
      await store.resetApp();
      await p;
    });
    expect(error).toBeDefined();
    expect(await countSafeboxEntries()).toBe(0);
  });
});

// ─── Sync pipeline ──────────────────────────────────────────────────

describe('safebox sync pipeline', () => {
  it('enqueues a v4 upload and records the sync state under kind:safebox', async () => {
    await enableSync();
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-SB', committed: true });
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });

    await waitFor(async () => {
      const records = await getAllSyncRecords();
      expect(records.some(r => r.kind === 'safebox' && r.status === 'accepted')).toBe(true);
    });
    // The signed body really is a v4 payload.
    const body = JSON.parse(vi.mocked(uploadViaProxy).mock.calls[0][0]) as {
      tags: Array<{ name: string; value: string }>; data: string;
    };
    expect(body.tags.find(t => t.name === 'App-Version')?.value).toBe('4');
    expect(Object.keys(JSON.parse(body.data)).sort()).toEqual(['id', 'mc', 'miv', 'sc', 'siv']);
  });

  it('syncPendingRecords returns a pending safebox entry to the queue after a reload', async () => {
    await enableSync();
    const entry = await seedEntry();
    // Pending: an error record (retryable), as a crashed upload would leave.
    await setSyncRecord({
      noteId: entry.entryId, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: 1,
    });
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-RETRY', committed: true });

    renderStore();
    await openMain(); // NOTE: no unlock — syncing must not need the PIN
    await act(async () => { await store.retrySync(); });

    await waitFor(async () => {
      expect((await getSyncRecord(entry.entryId))?.txId).toBe('TX-RETRY');
    });
  });

  it('the v4 kill switch pauses ONLY the safebox queue and persists the marker', async () => {
    await enableSync();
    vi.mocked(uploadViaProxy).mockResolvedValue({
      kind: 'v4_disabled', error: '{"code":"v4_uploads_disabled"}',
    });
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });

    await waitFor(() => expect(store.v4Paused).toBe(true));
    expect(store.v3Paused).toBe(false);
    expect(await readV4PauseMeta()).not.toBeNull();
  });

  it('the pause is NOT lifted while /health reports versions∋4 but v4Uploads:false', async () => {
    await setMeta(V4_PAUSE_META_KEY, { pausedAt: 1000 });
    vi.mocked(getWorkerCapabilities).mockResolvedValue({ uploads: 'enabled', v3: 'enabled', v4: 'disabled' });
    await enableSync();
    renderStore();
    await openMain();
    await waitFor(() => expect(store.v4Paused).toBe(true));
    expect(await readV4PauseMeta()).toEqual({ pausedAt: 1000 });
  });

  it('manual resume clears the marker unconditionally', async () => {
    await setMeta(V4_PAUSE_META_KEY, 'garbage'); // malformed → never auto-lifted
    renderStore();
    await openMain();
    await waitFor(() => expect(store.v4Paused).toBe(true));
    await act(async () => { await store.resumeV4Uploads(); });
    expect(store.v4Paused).toBe(false);
    expect(await readV4PauseMeta()).toBeNull();
  });

  it('a malformed stored entry is quarantined WITHOUT any HTTP request', async () => {
    await enableSync();
    // A row corrupted on disk: a 3-byte IV can never be serialized.
    await saveSafeboxEntryWithSync(
      {
        entryId: '11111111-2222-8333-8444-555555555555',
        metaCiphertext: 'AAAA', metaIv: 'AAAA',
        secretCiphertext: 'BBBB', secretIv: 'AAAAAAAAAAAAAAAA',
        createdAt: 1, v: 4,
      },
      { noteId: '11111111-2222-8333-8444-555555555555', kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: 1 },
    );
    renderStore();
    await openMain();
    await act(async () => { await store.retrySync(); });

    await waitFor(async () => {
      const rec = await getSyncRecord('11111111-2222-8333-8444-555555555555');
      expect(rec?.terminalError).toBe('malformed_record');
    });
    expect(vi.mocked(uploadViaProxy)).not.toHaveBeenCalled();
  });

  it('safebox records do NOT distort the notes counters', async () => {
    await seedEntry();               // confirmed safebox entry
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('заметка'); });

    await waitFor(() => expect(store.arweave.countsReady).toBe(true));
    // ONE unsynced note; the safebox entry is accounted separately.
    expect(store.arweave.unsyncedCount).toBe(1);
    expect(store.arweave.confirmedCount).toBe(0);
    expect(store.arweave.safebox.confirmedCount).toBe(1);
    expect(store.arweave.safebox.unsyncedCount).toBe(0);
  });

  it('reset-safety counts UNSYNCED safebox entries while the section is LOCKED', async () => {
    const entry = await seedEntry();
    await setSyncRecord({
      noteId: entry.entryId, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: 1,
    });
    renderStore();
    await openMain();                       // safebox stays locked
    await waitFor(() => expect(store.arweave.countsReady).toBe(true));
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.arweave.resetRisk.safebox).toBe(1);
  });
});

// ─── Hydration, PIN lifecycle, seed paths ───────────────────────────

describe('hydration and PIN lifecycle', () => {
  it('hydrates safeboxPinConfigured / safeboxDataPresent at vault open (locked)', async () => {
    await seedEntry();
    await commitSafeboxPinWrite(await createSafeboxPinBlob(PIN), 'seed-authorized', getDbGeneration());
    renderStore();
    await openMain();
    expect(store.safeboxPinConfigured).toBe(true);
    expect(store.safeboxDataPresent).toBe(true);
    expect(store.safeboxEntryCount).toBe(1);
    expect(store.safeboxUnlocked).toBe(false); // never auto-opens
  });

  it('activation over EXISTING data without the seed is refused', async () => {
    await seedEntry();
    renderStore();
    await openMain();
    await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxSeedRequiredError);
    expect(await readSafeboxPinConfig()).toBeNull();
  });

  it('activation over existing data SUCCEEDS with the correct seed', async () => {
    await seedEntry({ title: 'старая' });
    renderStore();
    await openMain();
    await act(async () => { await store.activateSafebox(PIN, { mnemonic: MN }); });
    expect(store.safeboxUnlocked).toBe(true);
    expect(store.safeboxEntries.map(e => e.title)).toEqual(['старая']);
  });

  it('activation with a FOREIGN seed is refused', async () => {
    await seedEntry();
    renderStore();
    await openMain();
    await expect(store.activateSafebox(PIN, { mnemonic: OTHER_MN }))
      .rejects.toBeInstanceOf(SafeboxSeedMismatchError);
  });

  it('the same-PIN check never spends a MAIN-PIN attempt', async () => {
    renderStore();
    await openMain();
    await act(async () => { await setMeta('pin-seed', await encryptWithPin(MN, '111111')); });

    // Ten activations with DIFFERENT pins: the raw check must not meter.
    for (let i = 0; i < 10; i++) {
      // NOT an assertion. `.catch()` returns a new promise, so the assertion
      // it was chained onto was never awaited (vitest said so on every run) —
      // and the catch swallowed its failure anyway, making it dead code that
      // looked like coverage. What is under test here is the METER, asserted
      // after the loop; the verdict of any single activation is irrelevant.
      await store.activateSafebox(PIN).catch(() => {});
      await act(async () => { await store.deactivateSafebox(PIN); });
    }
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
  });

  it('a safebox PIN identical to the MAIN PIN is refused', async () => {
    renderStore();
    await openMain();
    await act(async () => { await setMeta('pin-seed', await encryptWithPin(MN, PIN)); });
    await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxSamePinError);
  });

  it('changing the PIN requires the CURRENT one and keeps this session open', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    await expect(store.changeSafeboxPin('000000', '222222')).rejects.toBeDefined();
    await act(async () => { await store.changeSafeboxPin(PIN, '222222'); });
    expect(store.safeboxUnlocked).toBe(true);

    // The OLD pin no longer opens the section; the new one does.
    act(() => { store.lockSafebox(); });
    await expect(store.unlockSafebox(PIN)).rejects.toBeDefined();
    await act(async () => { await store.unlockSafebox('222222'); });
    expect(store.safeboxUnlocked).toBe(true);
  });

  it('deactivation requires the current PIN, removes the config and KEEPS the data', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    await expect(store.deactivateSafebox('000000')).rejects.toBeDefined();
    await act(async () => { await store.deactivateSafebox(PIN); });
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.safeboxPinConfigured).toBe(false);
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('resetSafeboxPinWithSeed replaces the PIN, keeps the data and needs the RIGHT seed', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    await expect(store.resetSafeboxPinWithSeed(OTHER_MN, '222222'))
      .rejects.toBeInstanceOf(SafeboxSeedMismatchError);

    await act(async () => { await store.resetSafeboxPinWithSeed(MN, '222222'); });
    expect(store.safeboxUnlocked).toBe(false); // the old session is over
    expect(await countSafeboxEntries()).toBe(1);
    await act(async () => { await store.unlockSafebox('222222'); });
    expect(store.safeboxUnlocked).toBe(true);
  });

  it('getSafeboxPinLockState reports the persisted lockout', async () => {
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });
    for (let i = 0; i < 4; i++) {
      await expect(store.unlockSafebox('000000')).rejects.toBeDefined();
    }
    const state = await store.getSafeboxPinLockState();
    expect(state.configured).toBe(true);
    expect(state.attempts).toBe(4);
    expect(state.lockedSeconds).toBeGreaterThan(0);
  });
});

// ─── Restore routing ────────────────────────────────────────────────

describe('restore routes safebox entries separately', () => {
  it('merges v4 entries, counts them apart from notes, and needs NO PIN', async () => {
    const metaKey = await deriveSafeboxMetaKey(MN);
    const secretKey = await deriveSafeboxSecretKey(MN);
    const remote = await encryptSafeboxEntry(metaKey, secretKey, {
      title: 'из блокчейна', login: '', url: '', note: '', password: 'pw', files: [], rev: 1,
    });
    const decrypted = await decryptSafeboxMeta(metaKey, remote);

    const { fetchAllNotes } = await import('./arweave');
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: [],
      safeboxEntries: [{ encrypted: remote, meta: decrypted, txId: 'TX-R' }],
      incomplete: false,
    });

    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await act(async () => { await store.restoreFromMnemonic(MN); });

    await waitFor(() => expect(store.restoredSafeboxCount).toBe(1));
    expect(store.restoredCount).toBe(0);          // notes counter untouched
    expect(await countSafeboxEntries()).toBe(1);
    expect(store.safeboxDataPresent).toBe(true);
    expect(store.safeboxUnlocked).toBe(false);    // restore never opens the section
  });

  it('the post-restore session may activate ONCE without re-entering the seed', async () => {
    const metaKey = await deriveSafeboxMetaKey(MN);
    const secretKey = await deriveSafeboxSecretKey(MN);
    const remote = await encryptSafeboxEntry(metaKey, secretKey, {
      title: 'x', login: '', url: '', note: '', password: 'pw', files: [], rev: 1,
    });
    const decrypted = await decryptSafeboxMeta(metaKey, remote);
    const { fetchAllNotes } = await import('./arweave');
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: [], safeboxEntries: [{ encrypted: remote, meta: decrypted, txId: 'TX-R' }], incomplete: false,
    });

    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await act(async () => { await store.restoreFromMnemonic(MN); });

    // First activation: allowed without the 12 words (the user just proved them).
    await act(async () => { await store.activateSafebox(PIN); });
    expect(store.safeboxUnlocked).toBe(true);

    // The window is ONE-SHOT: after a deactivation it is gone.
    await act(async () => { await store.deactivateSafebox(PIN); });
    await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxSeedRequiredError);
  });

  it('a LOCK burns the post-restore window', async () => {
    const metaKey = await deriveSafeboxMetaKey(MN);
    const secretKey = await deriveSafeboxSecretKey(MN);
    const remote = await encryptSafeboxEntry(metaKey, secretKey, {
      title: 'x', login: '', url: '', note: '', password: 'pw', files: [], rev: 1,
    });
    const decrypted = await decryptSafeboxMeta(metaKey, remote);
    const { fetchAllNotes } = await import('./arweave');
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: [], safeboxEntries: [{ encrypted: remote, meta: decrypted, txId: 'TX-R' }], incomplete: false,
    });

    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await act(async () => { await store.restoreFromMnemonic(MN); });

    act(() => { store.lockSafebox(); });
    sessionStorage.setItem(SESSION_KEY, MN); // the vault itself is still open
    await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxSeedRequiredError);
  });
});

// ─── Late-lock / late-reset races (review follow-up) ────────────────
//
// The earlier race tests locked IMMEDIATELY after starting an operation, which
// the early guards already caught. These park the operation inside its crypto
// phase — past every early check — so only the guard directly before the write
// can save us.

describe('a lock that lands AFTER the early checks', () => {
  it('addSafeboxEntry: nothing is written once the section locked mid-encrypt', async () => {
    renderStore();
    await openSafebox();

    cryptoHooks.beforeEncryptEntry = () => { store.lockSafebox(); };
    await act(async () => {
      await expect(store.addSafeboxEntry(ENTRY)).rejects.toBeInstanceOf(SafeboxLockedError);
    });
    // The version must NOT be on disk: the form is gone, the user never saw a
    // confirmation, and a stray record would later be dispatched as a PAID
    // upload of a version nobody asked for.
    expect(await countSafeboxEntries()).toBe(0);
    expect(await getAllSyncRecords()).toHaveLength(0);
  });

  it('editSafeboxEntry: no new version once the section locked mid-encrypt', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    const before = await countSafeboxEntries();

    cryptoHooks.beforeEncryptEntry = () => { store.lockSafebox(); };
    await act(async () => {
      await expect(store.editSafeboxEntry(root, {
        title: 'после блокировки', login: '', url: '', note: '', files: [],
      })).rejects.toBeInstanceOf(SafeboxLockedError);
    });
    expect(await countSafeboxEntries()).toBe(before);
  });

  it('restoreSafeboxVersion: no new version once an APP lock landed mid-encrypt', async () => {
    renderStore();
    await openSafebox();
    await act(async () => { await store.addSafeboxEntry(ENTRY); });
    const root = store.safeboxChains[0].root;
    const versionId = store.safeboxChains[0].current.id;
    const before = await countSafeboxEntries();

    cryptoHooks.beforeEncryptEntry = () => { store.lockApp(); };
    await act(async () => {
      await expect(store.restoreSafeboxVersion(root, versionId)).rejects.toBeDefined();
    });
    expect(await countSafeboxEntries()).toBe(before);
  });
});

describe('a RESET that lands during a PIN write', () => {
  it('activation cannot resurrect safebox-pin in the wiped database', async () => {
    renderStore();
    await openMain();

    cryptoHooks.beforeCreatePinBlob = async () => { await store.resetApp(); };
    await act(async () => {
      await expect(store.activateSafebox(PIN)).rejects.toBeDefined();
    });
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(await getMeta(SAFEBOX_PIN_META_KEY)).toBeUndefined();
  });

  it('the seed reset cannot resurrect safebox-pin either', async () => {
    await seedEntry();
    renderStore();
    await openMain();

    cryptoHooks.beforeCreatePinBlob = async () => { await store.resetApp(); };
    await act(async () => {
      await expect(store.resetSafeboxPinWithSeed(MN, PIN)).rejects.toBeDefined();
    });
    expect(await getMeta(SAFEBOX_PIN_META_KEY)).toBeUndefined();
    expect(await countSafeboxEntries()).toBe(0); // the reset really did wipe
  });
});

describe('unlockSafebox never resolves on a superseded session', () => {
  it('throws SafeboxLockedError when a lock lands during the KDF', async () => {
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });

    // A caller that treats «resolved» as «PIN proven» (the Settings seed gate)
    // must never see a resolution here.
    let resolved = false;
    await act(async () => {
      const p = store.unlockSafebox(PIN).then(() => { resolved = true; });
      store.lockSafebox(); // supersede the attempt mid-flight
      await expect(p).rejects.toBeInstanceOf(SafeboxLockedError);
    });
    expect(resolved).toBe(false);
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('throws when the config is replaced DURING the KDF (no BroadcastChannel)', async () => {
    FakeBroadcastChannel.enabled = false;
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });

    // Deterministic: the foreign tab installs its own config while we are
    // inside the KDF, i.e. after the config was read and before the success
    // is committed — the exact window an unconditional write would miss.
    cryptoHooks.beforeVerifyPin = async () => { await foreignTabReplacesConfig(); };
    await act(async () => {
      await expect(store.unlockSafebox(PIN)).rejects.toBeInstanceOf(SafeboxConfigChangedError);
    });
    expect(store.safeboxUnlocked).toBe(false);
  });
});

describe('lock generation drives the UI remount', () => {
  it('bumps on EVERY lock, including a hidden edge with the section already locked', async () => {
    renderStore();
    await openMain();
    const initial = store.safeboxLockGeneration;

    act(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    const afterHide = store.safeboxLockGeneration;
    expect(afterHide).toBeGreaterThan(initial);

    // Still locked — but a second hidden edge must still invalidate any form
    // state (activation PIN, seed-reset grid) typed in between.
    act(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    expect(store.safeboxLockGeneration).toBeGreaterThan(afterHide);
  });
});

describe('synchronous secret scrub on the hidden edge (BFCache)', () => {
  it('blanks every safebox input/textarea BEFORE the snapshot can be taken', async () => {
    renderStore();
    await openMain();

    // Stand in for the activation / PIN-pad / seed-reset forms, which live
    // OUTSIDE the unlocked session and would otherwise be captured as-is.
    const section = document.createElement('div');
    section.className = 'safebox-section';
    const pin = document.createElement('input');
    pin.value = '135790';
    const word = document.createElement('input');
    word.value = 'abandon';
    const note = document.createElement('textarea');
    note.value = 'секрет';
    section.append(pin, word, note);
    document.body.append(section);

    try {
      // `pagehide` runs the scrub SYNCHRONOUSLY — no await, no React commit.
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      expect(pin.value).toBe('');
      expect(word.value).toBe('');
      expect(note.value).toBe('');
    } finally {
      section.remove();
    }
  });
});

// ─── Publication-time guarantees (review follow-up) ─────────────────

describe('opening the section is itself a secret publication', () => {
  it('a config replaced DURING meta decryption aborts the unlock (no stale session)', async () => {
    FakeBroadcastChannel.enabled = false; // storage recheck is the only guarantee
    await seedEntry();
    renderStore();
    await openSafebox();
    act(() => { store.lockSafebox(); });

    // The foreign tab installs its own config while we decrypt the metas —
    // i.e. after the PIN was verified and before anything is published.
    cryptoHooks.beforeDecryptMeta = async () => { await foreignTabReplacesConfig(); };
    await act(async () => {
      await expect(store.unlockSafebox(PIN)).rejects.toBeInstanceOf(SafeboxConfigChangedError);
    });

    // Nothing published: no metas on screen, and the seed gate (which accepts
    // a RESOLVED unlock as proof of the PIN) never sees a resolution.
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.safeboxEntries).toEqual([]);
  });

  it('the same guard applies to activation', async () => {
    FakeBroadcastChannel.enabled = false;
    await seedEntry();
    renderStore();
    await openMain();

    cryptoHooks.beforeDecryptMeta = async () => { await foreignTabReplacesConfig(); };
    await act(async () => {
      await expect(store.activateSafebox(PIN, { mnemonic: MN }))
        .rejects.toBeInstanceOf(SafeboxConfigChangedError);
    });
    expect(store.safeboxUnlocked).toBe(false);
  });

  it('a focus edge re-reads the config and locks a session that lost it', async () => {
    FakeBroadcastChannel.enabled = false;
    await seedEntry();
    renderStore();
    await openSafebox();
    expect(store.safeboxUnlocked).toBe(true);

    await foreignTabReplacesConfig();       // silently, no broadcast
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 0));
    });
    // The plan's «дополнительный recheck на focus/pageshow»: the tab does not
    // wait for the next secret action to notice.
    await waitFor(() => expect(store.safeboxUnlocked).toBe(false));
  });
});

describe('activation captures BOTH epochs before its first await', () => {
  it('a hidden edge during the KDF cancels it: no PIN written, section closed', async () => {
    renderStore();
    await openMain();

    cryptoHooks.beforeCreatePinBlob = () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide')); // bumps the section epoch
    };
    await act(async () => {
      await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxLockedError);
    });

    // Nothing was configured and NOTHING was opened in the hidden tab.
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(store.safeboxUnlocked).toBe(false);
    expect(store.safeboxPinConfigured).toBe(false);
  });

  it('an app lock during the KDF cancels it too', async () => {
    renderStore();
    await openMain();

    cryptoHooks.beforeCreatePinBlob = () => { store.lockApp(); };
    await act(async () => {
      await expect(store.activateSafebox(PIN)).rejects.toBeInstanceOf(SafeboxLockedError);
    });
    expect(await readSafeboxPinConfig()).toBeNull();
    expect(store.safeboxUnlocked).toBe(false);
  });
});

describe('counters do not trust the stored `kind` field', () => {
  it('a safebox row whose kind rotted to "note" still counts as SAFEBOX', async () => {
    const entry = await seedEntry();
    // Corrupt the field the way a bad write / older build could.
    await setSyncRecord({
      noteId: entry.entryId, kind: 'note', txId: 'TX', status: 'confirmed',
      transport: 'proxy', updatedAt: 1,
    });
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('заметка'); });
    await waitFor(() => expect(store.arweave.countsReady).toBe(true));

    // Bucketed by STORE MEMBERSHIP: the safebox row cannot be subtracted from
    // the notes total (which would drive «синхронизировано X из N» negative).
    expect(store.arweave.confirmedCount).toBe(0);
    expect(store.arweave.safebox.confirmedCount).toBe(1);
    expect(store.arweave.unsyncedCount).toBe(1);   // exactly the one note
    expect(store.arweave.unsyncedCount).toBeGreaterThanOrEqual(0);
  });

  it('a record with an INVALID kind is quarantined and never dispatched', async () => {
    await enableSync();
    const entry = await seedEntry();
    await setSyncRecord({
      noteId: entry.entryId, kind: 'nonsense', status: 'error', transport: 'proxy', updatedAt: 1,
    } as unknown as Parameters<typeof setSyncRecord>[0]);

    renderStore();
    await openMain();
    await act(async () => { await store.retrySync(); });

    // terminalError keeps it out of every queue pass — no HTTP at all.
    expect(vi.mocked(uploadViaProxy)).not.toHaveBeenCalled();
    expect(store.arweave.safebox.quarantinedCount).toBe(1);
  });
});

describe('orphan sync rows never distort the reset warning', () => {
  /** A sync row whose id exists in NEITHER store — a leftover from a partial
   *  reset, or a foreign writer. Written BEFORE the vault opens so the very
   *  first refreshSyncCounts already sees it. */
  async function seedOrphan(id: string, status: 'confirmed' | 'accepted' = 'confirmed') {
    await setSyncRecord({
      noteId: id, kind: 'note', txId: 'TX-GHOST', status,
      transport: 'proxy', updatedAt: 1,
    });
  }

  it('an orphan CONFIRMED row cannot cancel out a real unsynced note', async () => {
    await seedOrphan('orphan-id');
    renderStore();
    await openMain();
    // addNote refreshes the counters, so they are computed WITH the orphan
    // already in the sync store.
    await act(async () => { await store.addNote('несинхронизированная'); });
    await waitFor(() => expect(store.arweave.countsReady).toBe(true));

    expect(store.arweave.confirmedCount).toBe(0);   // the ghost is not ours
    expect(store.arweave.resetRisk.notes).toBe(1);  // the real note IS at risk
    expect(store.arweave.unsyncedCount).toBe(1);
  });

  it('orphan rows cannot drive the counters negative', async () => {
    for (const id of ['g1', 'g2', 'g3']) await seedOrphan(id);
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('одна заметка'); });
    await waitFor(() => expect(store.arweave.countsReady).toBe(true));

    // One real note, three ghost «confirmed» rows.
    expect(store.arweave.confirmedCount).toBe(0);
    expect(store.arweave.unsyncedCount).toBe(1);
    expect(store.arweave.unsyncedCount).toBeGreaterThanOrEqual(0);
    expect(store.arweave.resetRisk.notes).toBe(1);
  });

  it('an orphan row is not attributed to the safebox bucket either', async () => {
    const entry = await seedEntry();
    await setSyncRecord({
      noteId: entry.entryId, kind: 'safebox', status: 'error',
      transport: 'proxy', updatedAt: 1,
    });
    await seedOrphan('orphan-sbx');
    renderStore();
    await openMain();
    await waitFor(() => expect(store.arweave.countsReady).toBe(true));

    // The real entry is unsynced and at risk; the ghost counts nowhere.
    expect(store.arweave.safebox.confirmedCount).toBe(0);
    expect(store.arweave.resetRisk.safebox).toBe(1);
    expect(store.arweave.confirmedCount).toBe(0);
    expect(store.arweave.resetRisk.notes).toBe(0);
  });
});

// ─── Прицельный ремонт сейфа (§6.4 плана Фазы 1; тесты 25–28) ───────
//
// Сторона сейфа у undecryptableIdsRef: сбор битых meta при открытии секции
// (публикация ОБЪЕДИНЕНИЕМ под эпохами), пометка при показе секрета, и
// исключение помеченного из «известного» инкрементальной проверки.

/** Побить base64-шифротекст: GCM гарантированно откажет при расшифровке. */
function corruptB64(b64: string): string {
  const buf = base64ToBuffer(b64);
  buf[0] ^= 0xff;
  return bufferToBase64(buf);
}

/** opts последнего вызова fetchAllNotes (4-й аргумент). */
function lastSweepOpts() {
  const call = vi.mocked(fetchAllNotes).mock.calls.at(-1);
  return call?.[3] as { known?: Map<string, { noteId: string; kind: 'note' | 'safebox' }> } | undefined;
}

/** Запись с БИТОЙ meta-половиной прямо в хранилище. */
async function seedRottenMetaEntry(txId: string) {
  const metaKey = await deriveSafeboxMetaKey(MN);
  const secretKey = await deriveSafeboxSecretKey(MN);
  const entry = await encryptSafeboxEntry(metaKey, secretKey, {
    title: 'сгнившая meta', login: '', url: '', note: '', password: 'x', files: [], rev: 1,
  });
  await saveSafeboxEntryWithSync(
    { ...entry, metaCiphertext: corruptB64(entry.metaCiphertext) },
    { noteId: entry.entryId, kind: 'safebox', txId, status: 'confirmed', transport: 'proxy', updatedAt: 1 },
  );
  return entry; // ЦЕЛАЯ версия — то, что лежит «на цепи»
}

/** Запись с ЦЕЛОЙ meta и БИТОЙ secret-половиной. */
async function seedRottenSecretEntry(txId: string) {
  const metaKey = await deriveSafeboxMetaKey(MN);
  const secretKey = await deriveSafeboxSecretKey(MN);
  const entry = await encryptSafeboxEntry(metaKey, secretKey, {
    title: 'сгнивший секрет', login: '', url: '', note: '', password: 'x', files: [], rev: 1,
  });
  await saveSafeboxEntryWithSync(
    { ...entry, secretCiphertext: corruptB64(entry.secretCiphertext) },
    { noteId: entry.entryId, kind: 'safebox', txId, status: 'confirmed', transport: 'proxy', updatedAt: 1 },
  );
  return entry;
}

describe('safebox targeted repair (§6.4)', () => {
  it('тест 25+27: битая meta собирается при открытии секции ОБЪЕДИНЕНИЕМ с ремонтными id заметок', async () => {
    // Битая ЗАМЕТКА — её id попадёт в набор при разблокировке приложения.
    // Рядом целая: legacy-binding требует хотя бы одной расшифровавшейся,
    // иначе openVault честно решит, что seed чужой.
    const noteKey = await deriveKey(MN);
    const goodNote = await encryptEnvelopeV3(noteKey, 'целая заметка', { fmt: 'md', rev: 1 });
    const brokenNote = await encryptEnvelopeV3(noteKey, 'битая заметка', { fmt: 'md', rev: 1 });
    await mergeRestoredNote(goodNote, 'TX-NOTE-GOOD', 1, getDbGeneration());
    await mergeRestoredNote(
      { ...brokenNote, ciphertext: corruptB64(brokenNote.ciphertext) }, 'TX-NOTE-ROT', 1, getDbGeneration(),
    );

    renderStore();
    await openSafebox(); // разблокировка приложения (сбор заметок) + активация секции

    // Записи сейфа появляются «с другого устройства» ПОСЛЕ активации; повторное
    // открытие секции — момент сбора битых meta.
    await seedRottenMetaEntry('TX-SB-ROT');
    await seedEntry(); // целая, TX-SEED
    act(() => { store.lockSafebox(); });
    await act(async () => { await store.unlockSafebox(PIN); });

    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });

    const known = lastSweepOpts()?.known;
    expect(known!.has('TX-SEED')).toBe(true);       // целая — известна
    expect(known!.has('TX-SB-ROT')).toBe(false);    // битая meta — кандидат ремонта
    // Объединение, не присваивание: ремонтный id ЗАМЕТКИ пережил открытие секции.
    expect(known!.has('TX-NOTE-ROT')).toBe(false);
  });

  it('тест 28: битая secret-половина — показ помечает, инкрементальная проверка чинит ОБЕ половины', async () => {
    renderStore();
    await openSafebox();
    const intact = await seedRottenSecretEntry('TX-SB-SECRET');
    act(() => { store.lockSafebox(); });
    await act(async () => { await store.unlockSafebox(PIN); }); // meta цела — запись видна

    // Показ секрета падает на битой половине → id уходит в ремонт.
    await expect(store.revealSafeboxSecret(intact.entryId)).rejects.toBeDefined();

    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-SB-SECRET')).toBe(false);

    // Сеть отдаёт целую запись (обе половины валидируются в sweep'е) → merge
    // чинит строку и выводит id из ремонта.
    const metaKey = await deriveSafeboxMetaKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({
      notes: [], incomplete: false,
      safeboxEntries: [{ encrypted: intact, meta: await decryptSafeboxMeta(metaKey, intact), txId: 'TX-SB-SECRET' }],
    });
    await act(async () => { await store.checkForUpdates(); });
    await expect(store.revealSafeboxSecret(intact.entryId)).resolves.toBe('x'); // починено

    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-SB-SECRET')).toBe(true); // снова известна
  });

  it('тест 26: блокировка секции, догнавшая показ, НЕ помечает id чужой сессией', async () => {
    renderStore();
    await openSafebox();
    const entry = await seedRottenSecretEntry('TX-RACE');
    act(() => { store.lockSafebox(); });
    await act(async () => { await store.unlockSafebox(PIN); });

    // Секция блокируется В МОМЕНТ расшифровки показа: битый секрет упадёт уже
    // после ухода эпохи — пометка обязана не состояться.
    cryptoHooks.beforeDecryptMeta = () => { store.lockSafebox(); };
    let error: unknown;
    await act(async () => {
      await store.revealSafeboxSecret(entry.entryId).catch(e => { error = e; });
    });
    expect(error).toBeDefined();

    // Наблюдаемое следствие: id НЕ в ремонте → запись осталась «известной».
    // (Блокировка секции ref не чистит — незамеченной пометку не спрятать.)
    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.unlockSafebox(PIN); });
    // Повторное открытие секции собирает только БИТЫЕ META — цела; secret-гниль
    // при открытии не детектится, так что чистый ref означает «пометки не было».
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-RACE')).toBe(true);
  });

  it('тест 26 (дополнение): показ при уже заблокированной секции не помечает ничего', async () => {
    renderStore();
    await openSafebox();
    const entry = await seedRottenSecretEntry('TX-LOCKED');
    act(() => { store.lockSafebox(); });

    await expect(store.revealSafeboxSecret(entry.entryId)).rejects.toBeInstanceOf(SafeboxLockedError);

    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-LOCKED')).toBe(true); // пометки не было
  });

  it('тест 26 (гонка открытия): блокировка ПРИЛОЖЕНИЯ во время открытия секции не публикует failed ids', async () => {
    renderStore();
    await openSafebox();
    await seedRottenMetaEntry('TX-APP-RACE');
    act(() => { store.lockSafebox(); });

    // Блокировка приложения бьёт ровно между ранними проверками открытия и
    // расшифровкой meta: локальный набор battered-id обязан умереть вместе с
    // сессией, а не просочиться в ref следующей.
    cryptoHooks.beforeDecryptMeta = () => { store.lockApp(); };
    await act(async () => { await store.unlockSafebox(PIN).catch(() => {}); });

    // Пере-открываем ХРАНИЛИЩЕ (секцию — нет). Повторное открытие секции
    // пересобрало бы битые meta заново и спрятало бы утечку — поэтому здесь
    // только vault: чистый ref означает, что запись осталась «известной».
    await act(async () => { await store.confirmMnemonic(MN); });
    await waitFor(() => expect(store.screen).toBe('main'));
    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-APP-RACE')).toBe(true);
  });

  it('тест 26 (смена конфигурации): SafeboxConfigChangedError не помечает запись', async () => {
    renderStore();
    await openSafebox();
    const entry = await seedEntry(); // ЦЕЛАЯ запись: ошибка — именно смена конфига
    act(() => { store.lockSafebox(); });
    await act(async () => { await store.unlockSafebox(PIN); });

    await foreignTabReplacesConfig();
    await expect(store.revealSafeboxSecret(entry.entryId)).rejects.toBeInstanceOf(SafeboxConfigChangedError);

    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-SEED')).toBe(true); // пометки не было
  });

  it('тест 26 (сбой деривации): отказ KDF секретного ключа — не повреждение, id не помечается', async () => {
    renderStore();
    await openSafebox();
    const entry = await seedEntry(); // ЦЕЛАЯ запись
    act(() => { store.lockSafebox(); });
    await act(async () => { await store.unlockSafebox(PIN); });

    cryptoHooks.beforeDeriveSecretKey = () => { throw new Error('kdf упал'); };
    await expect(store.revealSafeboxSecret(entry.entryId)).rejects.toThrow('kdf упал');

    await setMeta('sweep-full-at', Date.now());
    await act(async () => { await store.checkForUpdates(); });
    expect(lastSweepOpts()?.known!.has('TX-SEED')).toBe(true); // деривация вне ремонтных try
  });
});
