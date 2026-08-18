// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// Phase 0 of multi-device sync: the manual «Проверить обновления» sweep.
//
// Same harness as store.v3-writer.test.tsx (REAL storage through fake-indexeddb,
// REAL envelope crypto, only the network mocked) — the whole point of the change
// is that check and restore share ONE pipeline and differ only in what they
// report, so the check must be exercised against the real merge path.

vi.mock('./flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: true }));

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

import { NotesProvider, useNotes } from './store';
import {
  initStorage, resetAll, setMeta, getMeta, sanitizeFullSweepAt,
  getAllNotes as getStoredNotes, countSafeboxEntries,
} from './storage';
import { isArweaveOnline, fetchAllNotes, ArweaveIndexUnavailableError } from './arweave';
import type { FetchAllNotesResult, RestoredNote, RestoredSafeboxEntry } from './arweave';
import {
  deriveKey, decryptNote, encryptEnvelopeV3,
  deriveSafeboxMetaKey, deriveSafeboxSecretKey, encryptSafeboxEntry, decryptSafeboxMeta,
} from './crypto';

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
const EMPTY: FetchAllNotesResult = { notes: [], safeboxEntries: [], incomplete: false };

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

/** A remote note chain: `texts.length` versions sharing one root. */
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

/** A remote safebox chain: `titles.length` versions sharing one root. */
async function makeRemoteSafeboxChain(
  metaKey: CryptoKey, secretKey: CryptoKey, titles: string[],
): Promise<RestoredSafeboxEntry[]> {
  const out: RestoredSafeboxEntry[] = [];
  let root: string | undefined;
  let prev: string | undefined;
  for (let i = 0; i < titles.length; i++) {
    const enc = await encryptSafeboxEntry(metaKey, secretKey, {
      title: titles[i], login: '', url: '', note: '', password: 'pw', files: [],
      rev: i + 1, ...(root ? { root, prev } : {}),
    });
    root ??= enc.entryId;
    prev = enc.entryId;
    out.push({ encrypted: enc, meta: await decryptSafeboxMeta(metaKey, enc), txId: `TX-${enc.entryId.slice(0, 8)}` });
  }
  return out;
}

/**
 * Park the sweep INSIDE fetchAllNotes — the only place where a lock/reset can
 * land between «the sweep decided what to write» and «the sweep writes it»,
 * which is exactly what the epoch/generation guards exist for.
 */
function parkSweep(): { release: (result?: FetchAllNotesResult) => void } {
  let resolve!: (r: FetchAllNotesResult) => void;
  vi.mocked(fetchAllNotes).mockReturnValue(new Promise<FetchAllNotesResult>(r => { resolve = r; }));
  return { release: (result = EMPTY) => resolve(result) };
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
  sessionStorage.clear();
  vi.mocked(isArweaveOnline).mockResolvedValue(false);
  vi.mocked(fetchAllNotes).mockReset();
  vi.mocked(fetchAllNotes).mockResolvedValue(EMPTY);
  // The sweep logs a failure by design; keep the suite output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await setMeta('init', true);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ─── Notes: what came back, counted as CHAINS ───────────────────────

describe('checkForUpdates: notes', () => {
  it('merges remote notes into the list', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      ...EMPTY, notes: await makeRemoteChain(key, ['с другого устройства']),
    });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.chains).toHaveLength(1);
    expect(store.chains[0].current.text).toBe('с другого устройства');
    expect(await getStoredNotes()).toHaveLength(1);
  });

  it('THREE versions of one new root count as ONE note (1 заметка = 1)', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      ...EMPTY, notes: await makeRemoteChain(key, ['a', 'b', 'c']),
    });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', addedNotes: 1, updatedNotes: 0 });
    expect(store.chains).toHaveLength(1);   // one card…
    expect(store.notes).toHaveLength(3);    // …with its full history
  });

  it('a new version of an EXISTING chain counts as updated, not added', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.addNote('локальная'); });
    const root = store.chains[0].root;
    const current = store.chains[0].current;

    const key = await deriveKey(MN);
    const edit = await encryptEnvelopeV3(key, 'правка с другого устройства', {
      fmt: 'md', rev: current.rev + 1, root, prev: current.id,
    });
    vi.mocked(fetchAllNotes).mockResolvedValue({
      ...EMPTY,
      notes: [{ encrypted: edit, text: 'правка с другого устройства', txId: 'TX-EDIT', meta: (await decryptNote(key, edit)).meta }],
    });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', addedNotes: 0, updatedNotes: 1 });
    expect(store.chains).toHaveLength(1);
    expect(store.chains[0].current.text).toBe('правка с другого устройства');
  });
});

// ─── Safebox: roots that gained a version we did NOT have ───────────

describe('checkForUpdates: safebox', () => {
  it('THREE versions of one root count as ONE changed entry', async () => {
    renderStore();
    await openMain();
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      ...EMPTY, safeboxEntries: await makeRemoteSafeboxChain(metaKey, secretKey, ['v1', 'v2', 'v3']),
    });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', changedSafebox: 1 });
    expect(await countSafeboxEntries()).toBe(3);
  });

  it('a REPEAT sweep with nothing new reports 0 — the merge is an idempotent upsert', async () => {
    renderStore();
    await openMain();
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      ...EMPTY, safeboxEntries: await makeRemoteSafeboxChain(metaKey, secretKey, ['v1', 'v2']),
    });

    await act(async () => { await store.checkForUpdates(); });
    expect(store.updateCheck).toMatchObject({ changedSafebox: 1 });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', changedSafebox: 0 });
    expect(await countSafeboxEntries()).toBe(2); // no duplication either
  });

  it('a NEW version of an already-known root counts once', async () => {
    renderStore();
    await openMain();
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    const chain = await makeRemoteSafeboxChain(metaKey, secretKey, ['v1', 'v2']);

    vi.mocked(fetchAllNotes).mockResolvedValue({ ...EMPTY, safeboxEntries: [chain[0]] });
    await act(async () => { await store.checkForUpdates(); });

    // Second sweep returns the SAME v1 plus a brand-new v2 of that root.
    vi.mocked(fetchAllNotes).mockResolvedValue({ ...EMPTY, safeboxEntries: chain });
    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', changedSafebox: 1 });
    expect(await countSafeboxEntries()).toBe(2);
  });
});

// ─── Reporting contract ─────────────────────────────────────────────

describe('checkForUpdates: reporting', () => {
  it('an unreachable index is an ERROR, not a partial sweep', async () => {
    renderStore();
    await openMain();
    vi.mocked(fetchAllNotes).mockRejectedValue(new ArweaveIndexUnavailableError());

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck.status).toBe('error');
  });

  it('incomplete is DONE + partial — the sweep ran and merged what it reached', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({
      notes: await makeRemoteChain(key, ['дошло']), safeboxEntries: [], incomplete: true,
    });

    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', partial: true, addedNotes: 1 });
    expect(store.chains).toHaveLength(1); // what DID arrive is kept
  });

  it('NEVER touches the restore banners — on success or on failure', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({ ...EMPTY, notes: await makeRemoteChain(key, ['x']) });

    await act(async () => { await store.checkForUpdates(); });
    expect(store.restoring).toBe(false);
    expect(store.restoreError).toBeNull();
    expect(store.restoredCount).toBeNull();
    expect(store.restoredUpdatedCount).toBeNull();
    expect(store.restoreProgress).toBeNull();

    vi.mocked(fetchAllNotes).mockRejectedValue(new ArweaveIndexUnavailableError());
    await act(async () => { await store.checkForUpdates(); });
    expect(store.restoring).toBe(false);
    expect(store.restoreError).toBeNull();
    expect(store.restoredCount).toBeNull();
  });

  it('works with «Автоматическая синхронизация» OFF — the sweep only READS', async () => {
    renderStore();
    await openMain();
    expect(store.arweave.enabled).toBe(false);

    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({ ...EMPTY, notes: await makeRemoteChain(key, ['всё равно приехало']) });
    await act(async () => { await store.checkForUpdates(); });

    expect(store.updateCheck).toMatchObject({ status: 'done', addedNotes: 1 });
    expect(store.chains).toHaveLength(1);
  });

  it('is single-flight: a second call while one runs is a no-op', async () => {
    renderStore();
    await openMain();
    const gate = parkSweep();

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = store.checkForUpdates();
      second = store.checkForUpdates();
    });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));

    await act(async () => { gate.release(); await Promise.all([first, second]); });
    expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1);
  });
});

// ─── Lifecycle races ────────────────────────────────────────────────

describe('checkForUpdates: lifecycle', () => {
  it('a LOCK mid-sweep publishes nothing (epoch guard)', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    act(() => { store.lockApp(); });

    await act(async () => {
      gate.release({ ...EMPTY, notes: await makeRemoteChain(key, ['опоздало']) });
      await run;
    });

    expect(await getStoredNotes()).toHaveLength(0);
    expect(store.notes).toHaveLength(0);
    expect(store.updateCheck.status).toBe('idle');
  });

  it('a LOCK clears a COMPLETED result — it must not leak into the next session', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValue({ ...EMPTY, notes: await makeRemoteChain(key, ['было']) });

    await act(async () => { await store.checkForUpdates(); });
    expect(store.updateCheck.status).toBe('done');

    act(() => { store.lockApp(); });
    expect(store.updateCheck.status).toBe('idle');
  });

  it('resetApp mid-sweep resurrects nothing (end-to-end)', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    await act(async () => { await store.resetApp(); });

    await act(async () => {
      gate.release({
        notes: await makeRemoteChain(key, ['после сброса']),
        safeboxEntries: await makeRemoteSafeboxChain(metaKey, secretKey, ['после сброса']),
        incomplete: false,
      });
      await run;
    });

    expect(await getStoredNotes()).toHaveLength(0);
    expect(await countSafeboxEntries()).toBe(0);
    expect(store.updateCheck.status).toBe('idle');
  });

  // The two tests below isolate the DB-generation guard from the epoch guard.
  // resetApp() cannot do that: it bumps the epoch FIRST (invalidateVaultLifecycle),
  // so the epoch check alone would stop the sweep and the generation guard could
  // be deleted without any test noticing. Calling resetAll() DIRECTLY wipes the
  // database while the epoch stays valid — the one interleaving that the
  // generation token exists for. They are also split by store, because the notes
  // loop RETURNS on the mismatch and would never let the safebox loop run.

  it('a direct resetAll mid-sweep blocks the NOTE merge (generation guard)', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    await resetAll(); // epoch untouched — ONLY the DB generation moves

    await act(async () => {
      gate.release({ ...EMPTY, notes: await makeRemoteChain(key, ['воскрешение']) });
      await run;
    });

    expect(await getStoredNotes()).toHaveLength(0);
  });

  it('a direct resetAll mid-sweep blocks the SAFEBOX merge (generation guard)', async () => {
    renderStore();
    await openMain();
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    await resetAll();

    await act(async () => {
      // NOTES DELIBERATELY EMPTY: with a note in the payload the notes loop
      // would return first and this test would pass without the safebox guard.
      gate.release({ ...EMPTY, safeboxEntries: await makeRemoteSafeboxChain(metaKey, secretKey, ['воскрешение']) });
      await run;
    });

    expect(await countSafeboxEntries()).toBe(0);
  });
});

// ─── Фаза 1: инкрементальный режим проверки, полное восстановление ──
//
// fetchAllNotes здесь замокан, поэтому сторовые тесты проверяют КОНТРАКТ между
// store и sweep'ом: какую карту `known` store передаёт (или не передаёт) и как
// живёт метка полной сверки `sweep-full-at`. Sentinel-семантика самой карты
// покрыта в arweave.incremental.test.ts.

/** opts последнего вызова fetchAllNotes (4-й аргумент). */
function lastSweepOpts() {
  const call = vi.mocked(fetchAllNotes).mock.calls.at(-1);
  return call?.[3] as { known?: Map<string, { noteId: string; kind: 'note' | 'safebox' }> } | undefined;
}

describe('checkForUpdates: инкрементальный режим (Фаза 1)', () => {
  it('первая проверка без метки — ПОЛНАЯ (known не передаётся), успех пишет метку', async () => {
    renderStore();
    await openMain();

    await act(async () => { await store.checkForUpdates(); });

    expect(lastSweepOpts()?.known).toBeUndefined();          // тест 17: нет метки → полный
    expect(typeof await getMeta('sweep-full-at')).toBe('number'); // успех продвинул метку
  });

  it('повторная проверка при свежей метке — инкрементальная: known из confirmed-записей', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    const remote = await makeRemoteChain(key, ['известная после merge']);
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({ ...EMPTY, notes: remote });

    await act(async () => { await store.checkForUpdates(); }); // полная, merge + метка
    await act(async () => { await store.checkForUpdates(); }); // инкрементальная

    const known = lastSweepOpts()?.known;
    expect(known).toBeInstanceOf(Map);
    expect(known!.get(remote[0].txId)).toEqual({ noteId: remote[0].encrypted.noteId, kind: 'note' });
  });

  it('restore ВСЕГДА полный: known не передаётся даже при свежей метке (тест 10)', async () => {
    renderStore();
    await openMain();
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({
      ...EMPTY, notes: await makeRemoteChain(key, ['уже известная']),
    });
    await act(async () => { await store.checkForUpdates(); }); // есть и записи, и метка

    await act(async () => { await store.retryRestore(); });

    expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(2);
    expect(lastSweepOpts()?.known).toBeUndefined();
  });

  it('граница ремонта сейфа (тест 11): запись закрытой секции остаётся в known до полной сверки', async () => {
    renderStore();
    await openMain();
    const [metaKey, secretKey] = await Promise.all([deriveSafeboxMetaKey(MN), deriveSafeboxSecretKey(MN)]);
    const remote = await makeRemoteSafeboxChain(metaKey, secretKey, ['в сейфе']);
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({ ...EMPTY, safeboxEntries: remote });

    await act(async () => { await store.checkForUpdates(); }); // полная: merge сейфа + метка
    await act(async () => { await store.checkForUpdates(); }); // инкрементальная

    // Секция закрыта, повреждение её записи детектировать нечем — запись
    // остаётся «известной» (sentinel, не качается). Ремонт — у полной сверки.
    const known = lastSweepOpts()?.known;
    expect(known!.get(remote[0].txId)).toEqual({ noteId: remote[0].encrypted.entryId, kind: 'safebox' });
  });

  it('полностью известная выборка → done с нулями, partial=false (тест 12)', async () => {
    renderStore();
    await openMain();
    await act(async () => { await store.checkForUpdates(); }); // метка
    await act(async () => { await store.checkForUpdates(); }); // инкрементальная, EMPTY

    expect(store.updateCheck).toMatchObject({
      status: 'done', addedNotes: 0, updatedNotes: 0, changedSafebox: 0, partial: false,
    });
  });

  it('метка старше суток → проверка снова ПОЛНАЯ (тест 13)', async () => {
    renderStore();
    await openMain();
    await setMeta('sweep-full-at', Date.now() - 25 * 60 * 60 * 1000);

    await act(async () => { await store.checkForUpdates(); });

    expect(lastSweepOpts()?.known).toBeUndefined();
  });

  it('успешный restore продвигает метку (тест 13, wasFull)', async () => {
    renderStore();
    await openMain();
    expect(await getMeta('sweep-full-at')).toBeUndefined();

    await act(async () => { await store.retryRestore(); });

    expect(typeof await getMeta('sweep-full-at')).toBe('number');
  });

  it('incomplete НЕ продвигает метку — частичная полная сверка полной не считается (тест 14)', async () => {
    renderStore();
    await openMain();
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({ ...EMPTY, incomplete: true });

    await act(async () => { await store.checkForUpdates(); }); // полная, но partial

    expect(store.updateCheck).toMatchObject({ status: 'done', partial: true });
    expect(await getMeta('sweep-full-at')).toBeUndefined();
  });

  it('блокировка в середине полной сверки: метка не пишется (тест 15)', async () => {
    renderStore();
    await openMain();
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    act(() => { store.lockApp(); });

    await act(async () => { gate.release(); await run; });

    expect(await getMeta('sweep-full-at')).toBeUndefined();
  });

  it('прямой resetAll в середине: generation-гейт блокирует запись метки (тест 16)', async () => {
    // Изолирует НОВЫЙ гейт от эпохи: resetAll двигает только поколение БД.
    // Пустой результат (merge-циклы не бегут) доводит sweep ровно до записи
    // метки — единственной строки, которую здесь охраняет generation-проверка.
    renderStore();
    await openMain();
    const gate = parkSweep();

    let run!: Promise<void>;
    await act(async () => { run = store.checkForUpdates(); });
    await waitFor(() => expect(vi.mocked(fetchAllNotes)).toHaveBeenCalledTimes(1));
    await resetAll(); // эпоха нетронута — только dbGeneration

    await act(async () => { gate.release(); await run; });

    expect(await getMeta('sweep-full-at')).toBeUndefined();
  });

  it('свежая метка + ноль sync-записей → инкрементальная с ПУСТОЙ картой, merge работает (тест 17)', async () => {
    renderStore();
    await openMain();
    await setMeta('sweep-full-at', Date.now());
    const key = await deriveKey(MN);
    vi.mocked(fetchAllNotes).mockResolvedValueOnce({
      ...EMPTY, notes: await makeRemoteChain(key, ['первая на устройстве']),
    });

    await act(async () => { await store.checkForUpdates(); });

    const known = lastSweepOpts()?.known;
    expect(known).toBeInstanceOf(Map);
    expect(known!.size).toBe(0);           // нечего пропускать — поведение полного
    expect(store.chains).toHaveLength(1);  // merge не пострадал
  });
});

// ─── Тест 19: runtime-валидация метки (§6.2г) ───────────────────────

describe('sanitizeFullSweepAt', () => {
  const NOW = 1_755_600_000_000;
  const SKEW = 5 * 60 * 1000;

  it.each([
    ['строка', 'вчера'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['отрицательное', -1],
    ['дробное', 1.5],
    ['будущее за границей (+5 мин + 1 мс)', NOW + SKEW + 1],
    ['объект', { at: 1 }],
    ['undefined', undefined],
  ])('битое значение (%s) → 0: следующая проверка будет ПОЛНОЙ', (_label, raw) => {
    expect(sanitizeFullSweepAt(raw, NOW)).toBe(0);
  });

  it('границы диапазона принимаются: 0 и ровно now + 5 мин', () => {
    expect(sanitizeFullSweepAt(0, NOW)).toBe(0);
    expect(sanitizeFullSweepAt(NOW + SKEW, NOW)).toBe(NOW + SKEW);
  });

  it('валидная свежая метка возвращается как есть', () => {
    expect(sanitizeFullSweepAt(NOW - 1000, NOW)).toBe(NOW - 1000);
  });
});
