// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// The backup slice with both release flags mocked ON, against REAL storage
// (fake-indexeddb) and REAL crypto. What is under test is the WIRING: that the
// store's actions carry one database generation, refresh what changed, put
// restored records back in a sendable state, and stop when the vault they were
// aimed at goes away — none of which the adapter's own tests can see, because
// all of them are things the store does around it.
vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: true,
  BACKUP_IMPORT_ENABLED: true,
}));

// No network in a store test: the queue must be OBSERVED, not performed.
vi.mock('./arweave', async importOriginal => {
  const actual = await importOriginal<typeof import('./arweave')>();
  return { ...actual, uploadViaProxy: vi.fn(async () => ({ kind: 'in_progress' as const })) };
});

// Real storage throughout — two functions are left spy-able, and both delegate
// to the real one by default. `getAllNotes` so a repaint can be made to fail
// without faking the database the import actually writes to; `mergeBackupRecord`
// so another operation can be run at a chosen point INSIDE a running import,
// with a real, partially applied store underneath it.
vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    getAllNotes: vi.fn(actual.getAllNotes),
    mergeBackupRecord: vi.fn(actual.mergeBackupRecord),
  };
});

import { NotesProvider, useNotes } from './store';
import { encodeBackup, decodeBackup, deriveBackupKey } from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptEnvelopeV3,
  encryptSafeboxEntry,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import { uploadViaProxy } from './arweave';
import {
  getAllNotes,
  getAllSafeboxEntries,
  getAllSyncRecords,
  getMeta,
  getNoteById,
  getSafeboxEntryById,
  getSyncRecord,
  initStorage,
  mergeBackupRecord,
  resetAll,
  INCOMPLETE_RESTORE_META_KEY,
} from './storage';
import {
  BackupCancelledError,
  BackupVaultLockedError,
  importSucceeded,
  LAST_EXPORT_ARTIFACT_KEY,
  LAST_VERIFIED_ARTIFACT_KEY,
  type ExportOutcome,
} from './backup-adapter';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let store: ReturnType<typeof useNotes>;

function Probe() {
  const snapshot = useNotes();
  useEffect(() => { store = snapshot; });
  return null;
}

async function openMain() {
  render(<NotesProvider><Probe /></NotesProvider>);
  await waitFor(() => expect(store.isReady).toBe(true));
  await act(async () => { await store.confirmMnemonic(MN); });
  await waitFor(() => expect(store.screen).toBe('main'));
}

async function containerJson(
  notes: EncryptedNote[],
  safebox: EncryptedSafeboxEntry[] = [],
): Promise<string> {
  return encodeBackup({
    notes: notes as unknown as Record<string, unknown>[],
    safebox: safebox as unknown as Record<string, unknown>[],
    incompleteRestore: false,
    containsUnsupportedRecords: false,
    createdAt: 1_756_000_000_000,
  }, await deriveBackupKey(MN));
}

/** A container holding one note, made with the same seed the vault uses. */
async function containerWith(text: string): Promise<{ file: File; note: EncryptedNote }> {
  const note = await encryptEnvelopeV3(await deriveKey(MN), text, { fmt: 'plain', rev: 1 });
  const json = await containerJson([note]);
  return { note, file: new File([json], 'backup.json', { type: 'application/json' }) };
}

/** Everything an import is allowed to touch, read straight from the database.
 *  Deliberately not «the notes»: an import that quietly resurrected a sync row
 *  or flipped the completeness marker would leave the note list identical and
 *  the store in a different state. */
async function dbState() {
  return {
    notes: await getAllNotes(),
    safebox: await getAllSafeboxEntries(),
    sync: await getAllSyncRecords(),
    incompleteMarker: await getMeta<unknown>(INCOMPLETE_RESTORE_META_KEY),
  };
}

/** A file whose read can be held open — the window in which a tab goes away. */
function heldFile(json: string): { file: File; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  return {
    release,
    file: {
      size: new TextEncoder().encode(json).byteLength,
      text: async () => { await gate; return json; },
    } as unknown as File,
  };
}

/** Web Locks is not in jsdom, and the import is fail-closed without it. This
 *  stand-in behaves like the real one in the way that matters here: it honours
 *  the abort signal it is given while WAITING. */
function installLocks(hold?: Promise<void>, onRequest?: () => void) {
  const seen: Array<{ signal?: AbortSignal }> = [];
  vi.stubGlobal('navigator', { ...navigator, locks: {
    request: async (_n: string, opts: { signal?: AbortSignal }, run: () => Promise<unknown>) => {
      seen.push(opts);
      onRequest?.();
      if (hold) {
        await hold;
        if (opts.signal?.aborted) {
          const err = new Error('The request was aborted.');
          err.name = 'AbortError';
          throw err;
        }
      }
      return run();
    },
  } });
  return seen;
}

beforeEach(async () => {
  // Same reset discipline as the other store suites: initialize and wipe,
  // rather than deleting the database out from under a cached handle.
  await initStorage();
  await resetAll();
  vi.mocked(uploadViaProxy).mockClear();
  vi.mocked(getAllNotes).mockClear();
  vi.mocked(mergeBackupRecord).mockClear();
  installLocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the vault has to be open', () => {
  it('every backup action refuses while it is not', async () => {
    render(<NotesProvider><Probe /></NotesProvider>);
    await waitFor(() => expect(store.isReady).toBe(true));

    // Onboarding: no seed in memory, so no container key can exist.
    await expect(store.exportBackupFile()).rejects.toBeInstanceOf(BackupVaultLockedError);
  });
});

describe('an import puts the records where the app can see them', () => {
  it('restores a note into storage AND onto the screen', async () => {
    // The list on screen is React state, not the database. An import that
    // wrote the record and left the list alone would look like a failed
    // import to the only person who matters.
    await openMain();
    const { file, note } = await containerWith('RESTORED-FROM-BACKUP');

    const prepared = await act(async () => store.prepareBackupImport(file));
    expect(prepared.report.ok).toBe(true);

    const { report, viewRefreshed } = await act(async () => store.applyBackupImport(prepared));

    expect(report.counters.added).toBe(1);
    expect(report.allFileRecordsApplied).toBe(true);
    expect(viewRefreshed).toBe(true);
    expect(await getNoteById(note.noteId)).toBeDefined();
    await waitFor(() => {
      expect(store.notes.some(n => n.text === 'RESTORED-FROM-BACKUP')).toBe(true);
    });
  });

  it('restores a safebox entry and tells the section it now has data', async () => {
    // `safeboxEntryCount` is what decides whether the section offers itself at
    // all. Entries restored without it land in a room with no door.
    await openMain();
    const entry = await encryptSafeboxEntry(
      await deriveSafeboxMetaKey(MN),
      await deriveSafeboxSecretKey(MN),
      { title: 'bank', login: 'me', url: '', note: '', password: 'hunter2', files: [], rev: 1 },
    );
    const file = new File([await containerJson([], [entry])], 'backup.json');

    const prepared = await act(async () => store.prepareBackupImport(file));
    const { report } = await act(async () => store.applyBackupImport(prepared));

    expect(report.counters.added).toBe(1);
    expect(await getSafeboxEntryById(entry.entryId)).toBeDefined();
    await waitFor(() => { expect(store.safeboxEntryCount).toBe(1); });
    expect(store.safeboxDataPresent).toBe(true);
  });

  it('leaves the restored record queued BY ID, and sends nothing on its own', async () => {
    // Two halves, and the first is the durable one: the merge deliberately
    // creates NO sync row for a record that was absent, because a record with
    // no row reads as new — which it is. A row claiming `accepted` or
    // `confirmed` would be the failure: the queue skips it by status and
    // polling skips it for want of a txId, so the data would be restored and
    // never sent.
    //
    // The second half is that the store then re-derives the view, so the
    // restored id shows up as `queued` rather than as nothing at all.
    //
    // What this does NOT prove is a network send: Arweave is off in a fresh
    // vault and enabling it needs a registered identity, so the dispatch
    // itself belongs to the upload-flow suite. What IS proven here is that an
    // import publishes nothing behind the user's back.
    await openMain();
    const { file, note } = await containerWith('QUEUED-AFTER-IMPORT');

    const prepared = await act(async () => store.prepareBackupImport(file));
    await act(async () => store.applyBackupImport(prepared));

    expect(await getSyncRecord(note.noteId)).toBeUndefined();
    await waitFor(() => {
      expect(store.syncStatuses[note.noteId]).toEqual({ status: 'queued' });
    });
    expect(store.arweave.unsyncedCount).toBe(1);
    expect(uploadViaProxy).not.toHaveBeenCalled();
  });
});

describe('an operation belongs to the vault that started it (D15)', () => {
  it('a prepared import is refused after a lock — with nothing written', async () => {
    // The gap: stage A and stage B are separated by a human decision, and a
    // human decision takes long enough to lock the app. A stage B that took a
    // fresh vault would let the new one authorize the old one's ciphertext.
    await openMain();
    const { file, note } = await containerWith('MUST-NOT-LAND');
    const prepared = await act(async () => store.prepareBackupImport(file));

    act(() => { store.lockApp(); });

    await expect(prepared.apply()).rejects.toBeInstanceOf(BackupCancelledError);
    expect(await getNoteById(note.noteId)).toBeUndefined();
  });

  it('a tab that goes away mid-read stops the operation', async () => {
    // `pagehide` is the honest edge: the vault is not locked and the database
    // is not reset, so neither of the other two guards moves. Only the
    // operation token does.
    await openMain();
    const { file, release } = heldFile(await containerJson([
      await encryptEnvelopeV3(await deriveKey(MN), 'ABANDONED', { fmt: 'plain', rev: 1 }),
    ]));

    const pending = store.prepareBackupImport(file);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      release();
      await expect(pending).rejects.toBeInstanceOf(BackupCancelledError);
    });
  });

  it('a second operation supersedes the first over the same database', async () => {
    // The third number exists for this too, not only for the tab going away.
    // Two backup operations in flight over one database is a race in which the
    // EARLIER one can finish last — and stage B of the earlier one would then
    // write over a store the later one has already judged. «Newest wins» is
    // enforced by bumping the token on the way IN, so the first operation
    // fails the moment it looks up again.
    await openMain();
    const json = await containerJson([
      await encryptEnvelopeV3(await deriveKey(MN), 'FIRST-ATTEMPT', { fmt: 'plain', rev: 1 }),
    ]);

    const superseded = store.prepareBackupImport(new File([json], 'first.json'));
    // The expectation is attached NOW, not after the second call: the first
    // operation is refused during its own key derivation, and a rejection
    // nobody is listening to yet is an unhandled rejection — a red run with a
    // green test list.
    const settled = expect(superseded).rejects.toBeInstanceOf(BackupCancelledError);

    // The second call captures a NEW token. Nothing about the vault changed:
    // it is not locked and the database was not reset, so only the third
    // number can tell these two operations apart.
    const winner = await act(async () => store.prepareBackupImport(new File([json], 'again.json')));

    await act(async () => { await settled; });
    expect(winner.report.ok).toBe(true);
  });

  it('a lock releases an operation that is WAITING, not only one that is working', async () => {
    // The epoch stops the next `assertAlive` — but a tab queued behind another
    // tab's Web Lock has no next check to reach until its turn comes, and that
    // turn may be a 30 MB import away. Locking the app has to release the
    // queue slot too, and say so by name rather than as a bare platform
    // AbortError the UI would render as «не удалось выполнить действие».
    await openMain();
    const { file, note } = await containerWith('WAITING-WHEN-LOCKED');
    const prepared = await act(async () => store.prepareBackupImport(file));

    let release!: () => void;
    let requested!: () => void;
    const waiting = new Promise<void>(r => { requested = r; });
    const seen = installLocks(new Promise<void>(r => { release = r; }), () => requested());

    const pending = prepared.apply();
    const settled = expect(pending).rejects.toBeInstanceOf(BackupCancelledError);
    await act(async () => {
      await waiting;
      store.lockApp();
      release();
      await settled;
    });

    expect(seen[0].signal?.aborted).toBe(true);
    expect(await getNoteById(note.noteId)).toBeUndefined();
  });

  it('stops WAITING for another tab, not only working', async () => {
    // The wait can be long — another tab may be importing 30 MB — and a tab
    // that has gone away must stop queueing for a turn it no longer wants.
    await openMain();
    const { file, note } = await containerWith('WAITING-FOREVER');
    const prepared = await act(async () => store.prepareBackupImport(file));

    let release!: () => void;
    let requested!: () => void;
    const waiting = new Promise<void>(r => { requested = r; });
    const seen = installLocks(new Promise<void>(r => { release = r; }), () => requested());

    const pending = prepared.apply();
    await act(async () => {
      // Cancel only once the lock has actually been ASKED for. Firing earlier
      // would prove the wrong thing: the guards would stop the import before
      // it ever reached the lock, and the wait would stay untested.
      await waiting;
      window.dispatchEvent(new Event('pagehide'));
      release();
      await expect(pending).rejects.toThrow();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].signal?.aborted).toBe(true);
    expect(await getNoteById(note.noteId)).toBeUndefined();
  });
});

describe('a tab that leaves during the tail stops the tail (D15)', () => {
  it('does not keep decrypting, counting and SENDING for a page nobody is looking at', async () => {
    // The import itself is committed — cancelling it is stage B's own job and
    // it does that correctly. What this covers is everything AFTER: the app
    // catching up, which is not one operation but five — re-decrypting every
    // note, two count passes, a safebox read and a push of the upload queue.
    //
    // Neither the epoch nor the database generation moves on `pagehide`, so
    // without the operation token that whole tail ran on for a page already
    // declared closed — and `viewRefreshed: true` claimed a repaint the very
    // first step had abandoned. The queue push is the part that mattered: a
    // hidden tab would start SENDING.
    await openMain();
    const { file, note } = await containerWith('TAIL-ABANDONED');
    const prepared = await act(async () => store.prepareBackupImport(file));

    // Leave the page at the first step of the tail, not during stage B.
    vi.mocked(getAllNotes).mockImplementationOnce(async () => {
      window.dispatchEvent(new Event('pagehide'));
      return [];
    });

    const outcome = await act(async () => store.applyBackupImport(prepared));

    // The data landed and the report is honest about it…
    expect(outcome.report.counters.added).toBe(1);
    expect(await getNoteById(note.noteId)).toBeDefined();
    // …and the screen is NOT claimed to be up to date.
    expect(outcome.viewRefreshed).toBe(false);
    expect(uploadViaProxy).not.toHaveBeenCalled();
  });
});

describe('bookkeeping never destroys the result', () => {
  it('an export records the file it produced (D21)', async () => {
    await openMain();

    const { exported, markerRecorded } = await act(async () => store.exportBackupFile());

    expect(markerRecorded).toBe(true);
    const marker = await getMeta<{ sha256: string }>(LAST_EXPORT_ARTIFACT_KEY);
    expect(marker?.sha256).toBe(exported.artifact.sha256);
  });

  it('a verify records the file it checked', async () => {
    await openMain();
    const { file } = await containerWith('VERIFIED');

    const { report, markerRecorded } = await act(async () => store.verifyBackupFile(file));

    expect(report.ok).toBe(true);
    expect(markerRecorded).toBe(true);
    const marker = await getMeta<{ sha256: string }>(LAST_VERIFIED_ARTIFACT_KEY);
    expect(marker?.sha256).toBe(report.sha256);
  });

  it('a repaint that fails after the import still returns the report', async () => {
    // Everything after `apply` is the app CATCHING UP. The import has already
    // happened; an exception raised while repainting would leave the user to
    // retry blind over data that is already in place — and «retry» over a
    // restore means answering the same destructive-looking confirmation twice.
    await openMain();
    const { file, note } = await containerWith('LANDED-ANYWAY');
    const prepared = await act(async () => store.prepareBackupImport(file));
    vi.mocked(getAllNotes).mockRejectedValueOnce(new Error('repaint exploded'));

    const outcome = await act(async () => store.applyBackupImport(prepared));

    expect(outcome.report.counters.added).toBe(1);
    // The screen is stale and the caller is TOLD so, rather than being handed
    // an exception that says nothing about what landed.
    expect(outcome.viewRefreshed).toBe(false);
    expect(await getNoteById(note.noteId)).toBeDefined();
  });
});

describe('applying the SAME container a second time (§8)', () => {
  it('a repeated import writes nothing, counts nothing, and still reports success', async () => {
    // A restore gets repeated: the user re-picks the file after a crash, runs
    // the same copy on a second device, or simply presses it twice because the
    // first time gave no obvious feedback. Two failures hide here, and both
    // are about the SECOND pass, not the first.
    //
    // The write half: a second pass that put the payload back would create a
    // fresh retryable sync row for a record that is already settled, i.e.
    // re-publish data on the user's behalf for no reason. Rule 2 forbids it —
    // a readable, publication-equivalent local record is left exactly alone.
    //
    // The reporting half is the subtler one, and it is why this asserts on the
    // report as hard as on the database. Rule 2 no-ops are counted NOWHERE by
    // design, so the second import must come back with twelve zeros AND a
    // success: had those records landed in `skipped` or `conflicts` instead,
    // the screen would say «не восстановлено: 2» about a store that holds
    // every byte the file carries — sending the user to hunt for data that was
    // never missing, and refusing to clear a completeness marker that is true.
    await openMain();
    const note = await encryptEnvelopeV3(await deriveKey(MN), 'IMPORTED-TWICE', { fmt: 'plain', rev: 1 });
    const entry = await encryptSafeboxEntry(
      await deriveSafeboxMetaKey(MN),
      await deriveSafeboxSecretKey(MN),
      { title: 'bank', login: 'me', url: '', note: '', password: 'hunter2', files: [], rev: 1 },
    );
    // ONE container, handed over twice — same bytes, same createdAt, same ids.
    const json = await containerJson([note], [entry]);

    const first = await act(async () => store.prepareBackupImport(new File([json], 'backup.json')));
    const firstOutcome = await act(async () => store.applyBackupImport(first));
    expect(firstOutcome.report.counters.added).toBe(2);
    expect(importSucceeded(firstOutcome.report)).toBe(true);
    const afterFirst = await dbState();

    // A prepared import is a SESSION bound to the vault of stage A, and asking
    // for a second one supersedes it (D15) — so the repeat is prepared afresh,
    // exactly as it would be when the user picks the file again.
    const second = await act(async () => store.prepareBackupImport(new File([json], 'backup.json')));
    // Both records are still PLANNED and still reach the writer on the second
    // pass. Without this the twelve zeros below would also be satisfied by a
    // stage A that quietly planned nothing — a very different bug wearing the
    // same report.
    expect(second.plannedCount).toBe(2);
    vi.mocked(mergeBackupRecord).mockClear();
    const { report } = await act(async () => store.applyBackupImport(second));
    expect(mergeBackupRecord).toHaveBeenCalledTimes(2);

    expect(report.counters).toEqual({
      added: 0, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
      quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
      skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
    });
    expect(report.allFileRecordsApplied).toBe(true);
    expect(report.incompleteRestore).toBe(false);
    expect(importSucceeded(report)).toBe(true);

    // …and the database is byte-for-byte where the first import left it —
    // payloads, sync rows and the completeness marker alike.
    expect(await dbState()).toEqual(afterFirst);
    expect(store.notes.some(n => n.text === 'IMPORTED-TWICE')).toBe(true);
    expect(store.safeboxEntryCount).toBe(1);
    expect(uploadViaProxy).not.toHaveBeenCalled();
  });
});

describe('the export is deliberately NOT covered by the import lock (D11a)', () => {
  it('an export taken mid-import carries the committed prefix AND declares itself incomplete', async () => {
    // Both halves of this are proven separately elsewhere — the provisional
    // marker is written before the first mutation, and the snapshot is read in
    // one readonly transaction — but the case they exist for is the one where
    // they meet: an emergency copy taken while a restore is half-applied.
    //
    // The export is left OUTSIDE the lock on purpose: a user reaching for a
    // copy must never be made to queue behind a restore. The price is that the
    // container it produces can only be an intermediate state, and the two
    // things that make that price acceptable are asserted here. One: the file
    // says `incompleteRestore: true`, so the copy admits it is narrower than a
    // finished store. Two: what it holds is a COMMITTED PREFIX — whole
    // records, exactly those already in the database — never a half-written
    // one. Get either wrong and the file looks like a complete backup taken
    // from a half-rebuilt store, which is the one file a user would keep while
    // deleting the original.
    //
    // The import ends CANCELLED, and that is not an artifact of the setup: a
    // newer backup operation bumps the token and supersedes the older one
    // (D15), so the store is left holding precisely the prefix the export just
    // described — the crash-shaped ending the sticky marker exists for.
    await openMain();
    const key = await deriveKey(MN);
    const a = await encryptEnvelopeV3(key, 'PREFIX-A', { fmt: 'plain', rev: 1 });
    const b = await encryptEnvelopeV3(key, 'PREFIX-B', { fmt: 'plain', rev: 1 });
    const prepared = await act(async () => store.prepareBackupImport(
      new File([await containerJson([a, b])], 'backup.json'),
    ));

    // The first record is merged for real; the export then runs from INSIDE
    // stage B, after the provisional marker and after that first write.
    const realMerge = vi.mocked(mergeBackupRecord).getMockImplementation()!;
    let exported: ExportOutcome | undefined;
    vi.mocked(mergeBackupRecord).mockImplementationOnce(async input => {
      const outcome = await realMerge(input);
      exported = await store.exportBackupFile();
      return outcome;
    });

    await act(async () => {
      await expect(store.applyBackupImport(prepared)).rejects.toBeInstanceOf(BackupCancelledError);
    });

    const stored = await getAllNotes();
    expect(stored).toHaveLength(1); // the prefix, and nothing beyond it
    const { body } = await decodeBackup(exported!.exported.text, await deriveBackupKey(MN));
    expect(body.incompleteRestore).toBe(true);
    // Consistent, in the only sense that matters: the container's contents ARE
    // the committed prefix, and the record in it is one of the file's records
    // in full rather than a fragment of one.
    expect(body.counts).toEqual({ notes: 1, safebox: 0 });
    expect(body.notes).toEqual(stored);
    expect([a, b]).toContainEqual(body.notes[0]);
    // The marker stays set, so the NEXT export is honest too (sticky, D11a).
    expect(await getMeta<unknown>(INCOMPLETE_RESTORE_META_KEY)).toBe(true);
  });
});
