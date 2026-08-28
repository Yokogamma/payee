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

// Real storage throughout — one function is left spy-able so a repaint can be
// made to fail without faking the database the import actually writes to.
vi.mock('./storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage')>();
  return { ...actual, getAllNotes: vi.fn(actual.getAllNotes) };
});

import { NotesProvider, useNotes } from './store';
import { encodeBackup, deriveBackupKey } from './backup';
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
  getMeta,
  getNoteById,
  getSafeboxEntryById,
  getSyncRecord,
  initStorage,
  resetAll,
} from './storage';
import {
  BackupCancelledError,
  BackupVaultLockedError,
  LAST_EXPORT_ARTIFACT_KEY,
  LAST_VERIFIED_ARTIFACT_KEY,
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
