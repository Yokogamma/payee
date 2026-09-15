// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// W3 matrix: the SAME store harness as store.test.tsx but with the v3 writer
// flag mocked ON. Kept in a separate file — a hoisted vi.mock cannot flip a
// build-time constant between tests inside one statically-importing module.

vi.mock('./flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: false, QUICK_UNLOCK_ENABLED: false }));

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

vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    saveNote: vi.fn(actual.saveNote),
    // Spy only — the real write still runs. A sweep that RESURRECTS a
    // permanently quarantined row is invisible over HTTP (the payload builder
    // fails closed before any request is built), so the re-write of its sync
    // record is the only observable proof that it was touched at all.
    setSyncRecord: vi.fn(actual.setSyncRecord),
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

import { NotesProvider, useNotes, OperationInFlightError } from './store';
import { noteSearchText } from './note-search-text';
import {
  initStorage, resetAll, setMeta, saveNote, getAllNotes as getStoredNotes,
  getAllSyncRecords, readV3PauseMeta, getSyncRecord, setSyncRecord,
} from './storage';
import { isArweaveOnline, uploadViaProxy, fetchAllNotes, getWorkerCapabilities } from './arweave';
import { deriveKey, decryptNote, encryptEnvelopeV3, type EncryptedNote } from './crypto';
import type { RestoredNote, UploadResult } from './arweave';

// jsdom has no BroadcastChannel — minimal stand-in (no cross-tab needs here).
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

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
  vi.mocked(uploadViaProxy).mockReset();
  vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'error', error: 'offline' });
  vi.mocked(fetchAllNotes).mockResolvedValue({ notes: [], safeboxEntries: [], incomplete: false });
  await setMeta('init', true);
});

afterEach(() => cleanup());

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Driving the upload queue deterministically ──────────────────────
//
// The queue processor is fire-and-forget (`kickQueue` never returns a promise),
// so a test's only handle on its progress is the HTTP boundary. Waiting on
// downstream effects instead — «poll until the sync record turns accepted» —
// puts a whole round trip plus the 200ms inter-upload throttle inside a
// `waitFor` budget, and makes the result depend on how loaded the machine is.
// The helpers below replace that: PARK each dispatch until the test answers it,
// then use the processor's own completion as the happens-after barrier.

/** One dispatch parked at the proxy boundary. */
interface ParkedUpload {
  /** App-Version tag of the signed body: '1' for a legacy note, '3' for v3. */
  version: string | undefined;
  body: string;
  /** Answer this attempt; the processor resumes from here. */
  reply: (result: UploadResult) => void;
}

function appVersionTag(body: string): string | undefined {
  return (JSON.parse(body) as { tags: Array<{ name: string; value: string }> })
    .tags.find(t => t.name === 'App-Version')?.value;
}

/** Installs an `uploadViaProxy` that never answers on its own. */
function parkUploads() {
  const arrived: ParkedUpload[] = [];                   // dispatched, not taken
  const takers: Array<(u: ParkedUpload) => void> = [];  // taken before dispatch
  const all: ParkedUpload[] = [];

  vi.mocked(uploadViaProxy).mockImplementation(
    (body: string) => new Promise<UploadResult>(reply => {
      const upload: ParkedUpload = { version: appVersionTag(body), body, reply };
      all.push(upload);
      const taker = takers.shift();
      if (taker) taker(upload);
      else arrived.push(upload);
    }),
  );

  return {
    /** Every dispatch so far, in order. */
    all,
    /** The next dispatch. Deliberately without a deadline of its own: a queue
     *  that never gets there fails on the test timeout, not on a poll budget
     *  that a slow machine can exhaust while the queue is still working. */
    next(): Promise<ParkedUpload> {
      const ready = arrived.shift();
      return ready ? Promise.resolve(ready) : new Promise(take => { takers.push(take); });
    },
  };
}

/** Barrier for a queue that is KNOWN to be running (a dispatch was just
 *  answered): `syncing` flips back in processQueue's `finally`, i.e. after the
 *  last item's sync record, its counters, the pause marker and the
 *  registration flag are all published. Every assertion made after this
 *  happens-after the state it reads — no assertion may race a later write. */
async function queueDrained() {
  await waitFor(() => expect(store.arweave.syncing).toBe(false));
}

describe('W3: addNote writes v3', () => {
  it('creates a rev-1 md chain root with a UUIDv8 id and RAW (untrimmed) text', async () => {
    renderStore();
    await openMain();

    const raw = '    отступ важен\nвторая строка\n';
    await act(async () => { await store.addNote(raw); });

    const stored = await getStoredNotes();
    expect(stored).toHaveLength(1);
    expect(stored[0].v).toBe(3);
    expect(stored[0].noteId).toMatch(UUID_V8);

    const key = await deriveKey(MN);
    const dec = await decryptNote(key, stored[0]);
    expect(dec.text).toBe(raw); // no trim — markdown whitespace is significant
    expect(dec.meta).toEqual({ fmt: 'md', rev: 1, root: stored[0].noteId });
    expect(store.notes[0].fmt).toBe('md');
  });
});

describe('W3: editNote', () => {
  it('creates the next version; the chain current flips; upload enqueued when enabled', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('оригинал'); });
    const root = store.chains[0].root;

    await act(async () => { await store.editNote(root, '# отредактировано'); });

    expect(store.chains).toHaveLength(1);
    expect(store.chains[0].current.text).toBe('# отредактировано');
    expect(store.chains[0].current.rev).toBe(2);
    expect(store.chains[0].current.prev).toBe(root);
    expect(store.chains[0].versions).toHaveLength(2);
    expect(store.notes).toHaveLength(2);

    const stored = await getStoredNotes();
    expect(stored).toHaveLength(2);
    const key = await deriveKey(MN);
    const v2 = stored.find(n => n.noteId === store.chains[0].current.id)!;
    expect((await decryptNote(key, v2)).meta).toEqual({ fmt: 'md', rev: 2, root, prev: root });
  });

  it('sequential edits stay linear: rev 2 then rev 3 with prev pointing at rev 2 (fresh ref)', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('v1'); });
    const root = store.chains[0].root;

    // Two SEQUENTIAL awaits inside one act(): no re-render between them, so a
    // useEffect-synced notesRef would still hold v1 — the synchronous
    // publishNotes ref update is what keeps the chain linear here.
    await act(async () => {
      await store.editNote(root, 'v2');
      await store.editNote(root, 'v3');
    });

    const chain = store.chains[0];
    expect(chain.versions.map(v => v.rev).sort()).toEqual([1, 2, 3]);
    const rev3 = chain.versions.find(v => v.rev === 3)!;
    const rev2 = chain.versions.find(v => v.rev === 2)!;
    expect(rev3.prev).toBe(rev2.id); // NOT the root — no accidental fork
  });

  it('two RAPID edits of one chain: second rejects OperationInFlightError, one version saved', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('база'); });
    const root = store.chains[0].root;

    let secondError: unknown = null;
    await act(async () => {
      const p1 = store.editNote(root, 'правка А');
      const p2 = store.editNote(root, 'правка Б').catch(e => { secondError = e; });
      await Promise.all([p1, p2]);
    });
    expect(secondError).toBeInstanceOf(OperationInFlightError);
    expect(await getStoredNotes()).toHaveLength(2); // base + ONE edit, not two
  });

  it('a failed edit releases the per-root mutex (retry succeeds)', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('база'); });
    const root = store.chains[0].root;

    vi.mocked(saveNote).mockRejectedValueOnce(new Error('quota'));
    await expect(store.editNote(root, 'правка')).rejects.toThrow('quota');
    await act(async () => { await store.editNote(root, 'правка'); });
    expect(store.chains[0].current.text).toBe('правка');
  });

  it('restore-version path: fmt plain is preserved (stars stay literal)', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('заметка'); });
    const root = store.chains[0].root;

    await act(async () => { await store.editNote(root, '*литеральные звёзды*', { fmt: 'plain' }); });
    expect(store.chains[0].current.fmt).toBe('plain');

    const key = await deriveKey(MN);
    const stored = await getStoredNotes();
    const cur = stored.find(n => n.noteId === store.chains[0].current.id)!;
    expect((await decryptNote(key, cur)).meta.fmt).toBe('plain');
  });
});

describe('W3: restore counters M/K (snapshot algorithm)', () => {
  async function makeRemoteChain(key: CryptoKey, texts: string[]): Promise<RestoredNote[]> {
    const out: RestoredNote[] = [];
    let root: string | undefined;
    let prev: string | undefined;
    for (let i = 0; i < texts.length; i++) {
      const enc = await encryptEnvelopeV3(key, texts[i], {
        fmt: 'md', rev: i + 1, ...(root ? { root, prev } : {}),
      });
      root ??= enc.noteId;
      prev = enc.noteId;
      const dec = await decryptNote(key, enc);
      out.push({ encrypted: enc, text: texts[i], txId: `TX-${enc.noteId.slice(0, 8)}`, meta: dec.meta });
    }
    return out;
  }

  it('a NEW chain of 3 versions → M=1, K=0; ALL versions land in state', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    const chain = await makeRemoteChain(key, ['a', 'b', 'c']);
    vi.mocked(fetchAllNotes).mockResolvedValue({ notes: chain, safeboxEntries: [], incomplete: false });

    await act(async () => { await store.retryRestore(); });

    expect(store.restoredCount).toBe(1);        // one user-perceived note
    expect(store.restoredUpdatedCount).toBe(0);
    expect(store.notes).toHaveLength(3);        // full history, no re-unlock
    expect(store.chains).toHaveLength(1);
    expect(store.chains[0].current.text).toBe('c');
  });

  it('a new version of an EXISTING chain → M=0, K=1; a mixed sweep counts both', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('локальная'); });
    const localRoot = store.chains[0].root;
    const key = await deriveKey(MN);

    // Remote: a fork/edit of the local chain + a completely new chain.
    const localCurrent = store.chains[0].current;
    const remoteEdit = await encryptEnvelopeV3(key, 'правка с другого устройства', {
      fmt: 'md', rev: localCurrent.rev + 1, root: localRoot, prev: localCurrent.id,
    });
    const remoteEditDec = await decryptNote(key, remoteEdit);
    const newChain = await makeRemoteChain(key, ['совсем новая']);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: [
        { encrypted: remoteEdit, text: 'правка с другого устройства', txId: 'TX-EDIT', meta: remoteEditDec.meta },
        ...newChain,
      ],
      safeboxEntries: [],
      incomplete: false,
    });

    await act(async () => { await store.retryRestore(); });

    expect(store.restoredCount).toBe(1);        // the new chain
    expect(store.restoredUpdatedCount).toBe(1); // the updated existing chain
    expect(store.chains).toHaveLength(2);
    const updated = store.chains.find(c => c.root === localRoot)!;
    expect(updated.current.text).toBe('правка с другого устройства');

    // Idempotent repeat sweep: nothing new → 0/0.
    await act(async () => { await store.retryRestore(); });
    expect(store.restoredCount).toBe(0);
    expect(store.restoredUpdatedCount).toBe(0);
  });
});

describe('W3: v3 upload pause (kill switch, client side)', () => {
  const V3_DISABLED = { kind: 'v3_disabled' as const, error: '{"code":"v3_uploads_disabled"}' };

  it('queue [v3, v3, v1]: ONE v3 HTTP attempt, the v1 still uploads, pause persisted', async () => {
    await setMeta('ar-enabled', true);

    renderStore();
    await openMain();

    // Seed a legacy v1 record directly (addNote under the ON flag writes v3).
    const key = await deriveKey(MN);
    const { encrypt } = await import('./crypto');
    const v1note = await encrypt(key, 'старая v1');
    await saveNote(v1note);

    const http = parkUploads();

    // Fill the queue while the store is still OFFLINE (beforeEach default):
    // enqueueing is gated on `enabled` alone, dispatching on `online` too, so
    // the [v3, v3, v1] order this test is named after becomes a fact instead
    // of a race against the background online probe.
    await act(async () => { await store.addNote('первая v3'); });
    await act(async () => { await store.addNote('вторая v3'); });
    expect(http.all).toHaveLength(0);

    // Online: retrySync publishes `online` BEFORE it resolves, and its sweep
    // appends the v1 behind the two queued v3s — one processor, one order.
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    let first!: ParkedUpload;
    await act(async () => {
      await store.retrySync();
      first = await http.next();
    });
    expect(first.version).toBe('3');

    // The kill switch answers the first v3 …
    let second!: ParkedUpload;
    await act(async () => {
      first.reply(V3_DISABLED);
      second = await http.next();
    });
    // … and the very next request on the wire is the v1: the second v3 was
    // dropped by the pre-dispatch marker check (ONE v3 HTTP attempt) and the
    // queue moved ON instead of stalling on the paused backlog.
    expect(second.version).toBe('1');

    await act(async () => {
      second.reply({ kind: 'accepted', txId: 'TX-1', committed: true });
    });
    await queueDrained();

    expect(http.all.filter(u => u.version === '3')).toHaveLength(1);
    expect(await readV3PauseMeta()).not.toBeNull();
    expect(store.v3Paused).toBe(true);
    expect((await getSyncRecord(v1note.noteId))?.status).toBe('accepted');

    // recovery-critical: v3_disabled must never markUnregistered — the v1
    // upload's accepted auto-discovery set registered=true and it must stay.
    //
    // A BARE expect, deliberately — 12e7b45 had to wrap this one in `waitFor`
    // because the flag reached the store a render after the accepted record it
    // comes from, and a loaded CI runner lost that race. `queueDrained()` above
    // closes the gap structurally: it returns on the processor's own `finally`,
    // and setArweave publishes ONE state object (store.tsx), so the render that
    // shows syncing=false is the render that shows registered=true.
    expect(store.arweave.registered).toBe(true);
  });

  it('the pause survives a remount (lock/reload): banner state re-derived from the marker', async () => {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();

    vi.mocked(uploadViaProxy).mockResolvedValue(V3_DISABLED);
    await act(async () => { await store.addNote('заметка'); });
    await act(async () => { await store.retrySync(); });
    await waitFor(async () => expect(await readV3PauseMeta()).not.toBeNull());

    // Remount (reload analogue): the mirror must come back from the marker.
    cleanup();
    sessionStorage.setItem('eternal-notes-session', MN);
    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await waitFor(() => expect(store.screen).toBe('main'));
    await waitFor(() => expect(store.v3Paused).toBe(true));
    // No automatic burst: the record stays error, no new HTTP for it.
    const records = await getAllSyncRecords();
    expect(records.every(r => r.status !== 'uploading')).toBe(true);
  });

  it('manual resume clears the marker and re-enqueues the backlog exactly once each', async () => {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();

    vi.mocked(uploadViaProxy).mockResolvedValue(V3_DISABLED);
    await act(async () => { await store.addNote('нота А'); });
    await act(async () => { await store.addNote('нота Б'); });
    await act(async () => { await store.retrySync(); });
    await waitFor(async () => expect(await readV3PauseMeta()).not.toBeNull());
    await waitFor(() => expect(store.v3Paused).toBe(true));

    // Gate reopens server-side; manual resume lifts the pause.
    vi.mocked(uploadViaProxy).mockClear();
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-OK', committed: true });
    await act(async () => { await store.resumeV3Uploads(); });

    expect(await readV3PauseMeta()).toBeNull();
    await waitFor(() => expect(store.v3Paused).toBe(false));
    await waitFor(async () => {
      const records = await getAllSyncRecords();
      const accepted = records.filter(r => r.status === 'accepted');
      expect(accepted).toHaveLength(2); // both previously-paused v3 uploaded
    });
    expect(vi.mocked(uploadViaProxy).mock.calls.length).toBe(2); // exactly once each
  });
});

describe('W3: unsupported-version quarantine in the queue', () => {
  it('a v:4 record is quarantined without HTTP; the queue moves on to valid notes', async () => {
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();

    const key = await deriveKey(MN);
    // A record from a FUTURE client version sits in storage AHEAD of a valid
    // note: syncPendingRecords enqueues newest-first, so the explicit
    // createdAt values are what make «moves on» a fact about ONE queue pass
    // instead of a coin flip on IndexedDB order.
    const valid = { ...(await encryptEnvelopeV3(key, 'нормальная', { fmt: 'md', rev: 1 })), createdAt: 1_000 };
    const future = { ...(await encryptEnvelopeV3(key, 'из будущего', { fmt: 'md', rev: 1 })), v: 4, createdAt: 2_000 };
    await saveNote(valid);
    await saveNote(future as unknown as EncryptedNote);

    const http = parkUploads();

    // One sweep enqueues [v:4, valid]. The v:4 row fails closed on its way to
    // the payload builder, so the FIRST request on the wire is the valid note.
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    let first!: ParkedUpload;
    await act(async () => {
      await store.retrySync();
      first = await http.next();
    });
    expect(first.body).toContain(valid.noteId);

    await act(async () => { first.reply({ kind: 'accepted', txId: 'TX-OK', committed: true }); });
    await queueDrained();

    expect((await getSyncRecord(future.noteId))?.terminalError).toBe('unsupported_version');
    expect((await getSyncRecord(valid.noteId))?.status).toBe('accepted');
    expect(http.all).toHaveLength(1); // the quarantined row cost no HTTP at all

    // reload/poll/manual retry never resurrect it. A re-processed quarantine
    // makes no HTTP either (fail-closed again), so its sync record write is
    // what has to be watched — and a third, still-pending note gives the
    // second sweep visible work: without it «no calls» would pass whether the
    // sweep ran or not.
    const pending = await encryptEnvelopeV3(key, 'ещё не отправленная', { fmt: 'md', rev: 1 });
    await saveNote(pending);
    vi.mocked(setSyncRecord).mockClear();

    let second!: ParkedUpload;
    await act(async () => {
      await store.retrySync();
      second = await http.next();
    });
    expect(second.body).toContain(pending.noteId); // the sweep really ran
    await act(async () => { second.reply({ kind: 'accepted', txId: 'TX-OK-2', committed: true }); });
    await queueDrained();

    expect(http.all.some(u => u.body.includes(future.noteId))).toBe(false);
    expect(vi.mocked(setSyncRecord).mock.calls.some(([r]) => r.noteId === future.noteId)).toBe(false);
  });
});

describe('W3: stale pause banner clears when another tab lifted the marker (review fix)', () => {
  it('a poll cycle that finds NO marker drops the local v3Paused mirror', async () => {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();

    // Pause this tab via a real v3_disabled round-trip.
    vi.mocked(uploadViaProxy).mockResolvedValue({
      kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}',
    });
    await act(async () => { await store.addNote('нота'); });
    await act(async () => { await store.retrySync(); });
    await waitFor(() => expect(store.v3Paused).toBe(true));

    // Another tab resumed: the shared marker is gone, our mirror is stale.
    const { clearV3UploadsPaused } = await import('./storage');
    await clearV3UploadsPaused('any');
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-OK', committed: true });

    // Next poll cycle (visibility return) must clear the stale banner.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 50));
    });
    await waitFor(() => expect(store.v3Paused).toBe(false));
  });
});

describe('W3: quarantine is counted separately from retryable errors (review fix)', () => {
  it('a terminalError record lands in quarantinedCount, NOT errorCount', async () => {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();

    const key = await deriveKey(MN);
    const future = { ...(await encryptEnvelopeV3(key, 'из будущего', { fmt: 'md', rev: 1 })), v: 4 };
    await saveNote(future as unknown as EncryptedNote);

    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-OK', committed: true });
    await act(async () => { await store.retrySync(); });

    await waitFor(async () => {
      const rec = await getSyncRecord(future.noteId);
      expect(rec?.terminalError).toBe('unsupported_version');
    });
    await waitFor(() => {
      expect(store.arweave.quarantinedCount).toBe(1);
      expect(store.arweave.errorCount).toBe(0); // not a lying «Повторить» error
      expect(store.arweave.resetRisk.notes).toBeGreaterThanOrEqual(1); // still at risk
    });
  });
});

describe('W3: exclusive reset refuses a late v3 pause marker (P1)', () => {
  it('a v3_disabled response arriving AFTER resetApp writes neither the marker nor a record', async () => {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);

    let resolveUpload!: (v: Awaited<ReturnType<typeof uploadViaProxy>>) => void;
    vi.mocked(uploadViaProxy).mockImplementationOnce(
      () => new Promise(r => { resolveUpload = r; }));

    renderStore();
    await openMain();
    await act(async () => { await store.addNote('v3 заметка'); });
    await waitFor(() => expect(vi.mocked(uploadViaProxy)).toHaveBeenCalledTimes(1));

    await act(async () => { await store.resetApp(); });

    await act(async () => {
      resolveUpload({ kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}' });
      await new Promise(r => setTimeout(r, 50));
    });

    // Neither the pause marker nor the failure record may haunt the next vault.
    expect(await readV3PauseMeta()).toBeNull();
    expect(await getAllSyncRecords()).toEqual([]);
  });
});

// The UI matrix in Main.v3.test.tsx hands the screen a ready-made
// `filteredChains`, so it can prove what a card RENDERS but never that the
// store agrees. This block runs the real NotesProvider filter.
describe('W3: search filters on what the card shows, not on the source', () => {
  it('a phrase that spans a bold marker is findable — and its markers are gone', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('до **важное** после'); });

    // On screen the note reads «до важное после»; that is what a user types.
    await act(async () => { store.setSearchQuery('до важное'); });
    expect(store.filteredChains).toHaveLength(1);

    // And the string the card highlights is the string that matched.
    expect(noteSearchText(store.filteredChains[0].current)).toBe('до важное после');
  });

  it('markup and link targets are NOT searchable — they are not on screen', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('см. [документацию](https://example.invalid/secret-path)'); });

    // Either of these used to return a card with nothing highlighted in it.
    await act(async () => { store.setSearchQuery('secret-path'); });
    expect(store.filteredChains).toHaveLength(0);
    await act(async () => { store.setSearchQuery('](http'); });
    expect(store.filteredChains).toHaveLength(0);

    await act(async () => { store.setSearchQuery('документацию'); });
    expect(store.filteredChains).toHaveLength(1);
  });

  it('filteredNotes and filteredChains agree', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('# Заголовок и **текст**'); });

    await act(async () => { store.setSearchQuery('Заголовок и текст'); });
    expect(store.filteredNotes).toHaveLength(1);
    expect(store.filteredChains).toHaveLength(1);
  });
});

describe('global pause lifecycle (P1 review)', () => {
  const GLOBAL_DISABLED = { kind: 'uploads_disabled' as const, error: '{"code":"uploads_disabled"}' };

  async function pauseGlobally() {
    vi.mocked(isArweaveOnline).mockResolvedValue(true);
    await setMeta('ar-enabled', true);
    renderStore();
    await openMain();
    vi.mocked(uploadViaProxy).mockResolvedValue(GLOBAL_DISABLED);
    await act(async () => { await store.addNote('нота'); });
    await act(async () => { await store.retrySync(); });
    const { readGlobalPauseMeta } = await import('./storage');
    await waitFor(async () => expect(await readGlobalPauseMeta()).not.toBeNull());
    await waitFor(() => expect(store.v3Paused).toBe(true));
  }

  it('a reload surfaces the GLOBAL marker — not only the version ones', async () => {
    await pauseGlobally();
    cleanup();
    sessionStorage.setItem('eternal-notes-session', MN);
    renderStore();
    await waitFor(() => expect(store.isReady).toBe(true));
    await waitFor(() => expect(store.screen).toBe('main'));
    // Before: the unlock read only v3/v4 markers, and a global pause came back
    // from a reload as a silently stuck queue.
    await waitFor(() => expect(store.v3Paused).toBe(true));
    await waitFor(() => expect(store.v4Paused).toBe(true));
  });

  it('manual resume lifts the GLOBAL marker, or the next queue pass re-pauses at once', async () => {
    await pauseGlobally();
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-OK', committed: true });
    await act(async () => { await store.resumeV3Uploads(); });
    const { readGlobalPauseMeta } = await import('./storage');
    expect(await readGlobalPauseMeta()).toBeNull();
    await waitFor(() => expect(store.v3Paused).toBe(false));
    await waitFor(async () => {
      const records = await getAllSyncRecords();
      expect(records.some(r => r.status === 'accepted')).toBe(true); // it actually uploaded
    });
  });

  it('the health probe lifts the GLOBAL marker on the GLOBAL verdict, with both versions still off', async () => {
    await pauseGlobally();
    // uploads back on, v3 and v4 still off: v1/v2 are allowed again. Under the
    // old rule («some version enabled») this marker could never lift.
    vi.mocked(getWorkerCapabilities).mockResolvedValue({ uploads: 'enabled', v3: 'disabled', v4: 'disabled' });
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'accepted', txId: 'TX-OK', committed: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 50));
    });
    const { readGlobalPauseMeta } = await import('./storage');
    await waitFor(async () => expect(await readGlobalPauseMeta()).toBeNull());
    await waitFor(() => expect(store.v3Paused).toBe(false));
  });

  it('lifting the GLOBAL marker does not clear a version banner whose own marker stands', async () => {
    await pauseGlobally();
    // A v3 marker of its own, on top of the global one.
    vi.mocked(uploadViaProxy).mockResolvedValue({ kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}' });
    const { clearGlobalUploadsPaused, readV3PauseMeta } = await import('./storage');
    await clearGlobalUploadsPaused('any');
    await act(async () => { await store.retrySync(); });
    await waitFor(async () => expect(await readV3PauseMeta()).not.toBeNull());
    // Now a global pause again, then a probe that lifts ONLY the global one.
    vi.mocked(uploadViaProxy).mockResolvedValue(GLOBAL_DISABLED);
    await act(async () => { await store.addNote('ещё'); await store.retrySync(); });
    vi.mocked(getWorkerCapabilities).mockResolvedValue({ uploads: 'enabled', v3: 'disabled', v4: 'enabled' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 50));
    });
    // v3 stays paused — its own marker is still there.
    await waitFor(() => expect(store.v3Paused).toBe(true));
    expect(await readV3PauseMeta()).not.toBeNull();
  });
});
