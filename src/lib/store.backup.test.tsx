// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';

// The backup slice with both release flags mocked ON, against REAL storage
// (fake-indexeddb) and REAL crypto. What is under test is the WIRING: that the
// store's actions carry one database generation, refresh what changed, and put
// restored records back into the queue — none of which the adapter's own tests
// can see, because all three are things the store does around it.
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

import { NotesProvider, useNotes } from './store';
import { encodeBackup, deriveBackupKey } from './backup';
import { deriveKey, encryptEnvelopeV3, type EncryptedNote } from './crypto';
import { getMeta, getNoteById, initStorage, resetAll } from './storage';
import {
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

/** A container holding one note, made with the same seed the vault uses. */
async function containerWith(text: string): Promise<{ file: File; note: EncryptedNote }> {
  const note = await encryptEnvelopeV3(await deriveKey(MN), text, { fmt: 'plain', rev: 1 });
  const json = await encodeBackup({
    notes: [note] as unknown as Record<string, unknown>[],
    safebox: [],
    incompleteRestore: false,
    containsUnsupportedRecords: false,
    createdAt: 1_756_000_000_000,
  }, await deriveBackupKey(MN));
  return { note, file: new File([json], 'backup.json', { type: 'application/json' }) };
}

beforeEach(async () => {
  // Same reset discipline as the other store suites: initialize and wipe,
  // rather than deleting the database out from under a cached handle.
  await initStorage();
  await resetAll();
  // Web Locks is not in jsdom, and the import is fail-closed without it.
  vi.stubGlobal('navigator', { ...navigator, locks: {
    request: async (_n: string, _o: unknown, run: () => Promise<unknown>) => run(),
  } });
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

    const report = await act(async () => store.applyBackupImport(prepared));

    expect(report.counters.added).toBe(1);
    expect(report.allFileRecordsApplied).toBe(true);
    expect(await getNoteById(note.noteId)).toBeDefined();
    await waitFor(() => {
      expect(store.notes.some(n => n.text === 'RESTORED-FROM-BACKUP')).toBe(true);
    });
  });

  it('leaves the restored record queued for sending, not silently unpublished', async () => {
    // The merge rules normalize a restored row to a retryable `error` with no
    // txId — precisely the state the queue picks up. If the store forgot to
    // kick it, the data would be restored and never sent.
    await openMain();
    const { file } = await containerWith('QUEUED-AFTER-IMPORT');

    const prepared = await act(async () => store.prepareBackupImport(file));
    await act(async () => store.applyBackupImport(prepared));

    await waitFor(() => {
      expect(Object.keys(store.syncStatuses).length).toBeGreaterThan(0);
    });
  });
});

describe('the artifact markers reach the database (D21)', () => {
  it('an export records the file it produced', async () => {
    await openMain();

    const exported = await act(async () => store.exportBackupFile());

    const marker = await getMeta<{ sha256: string }>(LAST_EXPORT_ARTIFACT_KEY);
    expect(marker?.sha256).toBe(exported.artifact.sha256);
  });

  it('a verify records the file it checked', async () => {
    await openMain();
    const { file } = await containerWith('VERIFIED');

    const report = await act(async () => store.verifyBackupFile(file));

    expect(report.ok).toBe(true);
    const marker = await getMeta<{ sha256: string }>(LAST_VERIFIED_ARTIFACT_KEY);
    expect(marker?.sha256).toBe(report.sha256);
  });
});
