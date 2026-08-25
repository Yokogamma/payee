// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  resetAll,
  setSyncRecord,
  getSyncRecord,
  getNoteById,
  getSafeboxEntryById,
  saveNoteWithSync,
  mergeRestoredNote,
  mergeRestoredSafeboxEntry,
  getDbGeneration,
  StorageResetError,
  STALE_UPLOADING_MS,
  type SyncRecord,
} from './storage';

/**
 * D12 — the (payload, txId) pair is written together or not at all.
 *
 * The defect this closes was purely LOCAL: the restore writer overwrote the
 * note bytes while preserving whatever `confirmed` row already existed, so a
 * record could end up holding payload B next to txId A — a claim that those
 * bytes are that publication, made by the client, with no server involved.
 *
 * The last block reproduces the OLD writer against the new storage. That is
 * the entire argument for making DB_VERSION 3 an irreversible client floor:
 * an older build recreates the defect on its own, with no worker rollback and
 * nothing for the server-side fingerprint to catch.
 */

const NOW = 1_750_000_000_000;

const noteA = { noteId: 'n-1', ciphertext: 'QUFBQQ==', iv: 'AAAAAAAAAAAAAAAA', createdAt: NOW - 5000 };
const noteB = { ...noteA, ciphertext: 'QkJCQg==' };

const entryA = {
  entryId: 'aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee',
  metaCiphertext: 'AAAA', metaIv: 'AAAAAAAAAAAAAAAA',
  secretCiphertext: 'QUFBQQ==', secretIv: 'AAAAAAAAAAAAAAAA',
  createdAt: NOW - 5000, v: 4 as const,
};
const entryB = { ...entryA, secretCiphertext: 'QkJCQg==' };

const confirmed = (txId: string, over: Partial<SyncRecord> = {}): SyncRecord => ({
  noteId: 'n-1', kind: 'note', txId, status: 'confirmed', transport: 'proxy',
  updatedAt: NOW - 100_000, ...over,
});

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('D12 — restore merges the pair atomically (notes)', () => {
  it('a DIFFERENT on-chain transaction replaces the txId together with the bytes', async () => {
    await saveNoteWithSync(noteA, confirmed('tx-A'));

    const outcome = await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    expect(outcome).toBe('merged');
    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
    // The old writer kept 'tx-A' here — the whole defect in one assertion.
    expect((await getSyncRecord('n-1'))?.txId).toBe('tx-B');
  });

  it('the SAME transaction preserves the existing record untouched (original updatedAt)', async () => {
    await saveNoteWithSync(noteB, confirmed('tx-A'));

    await mergeRestoredNote(noteA, 'tx-A', NOW, getDbGeneration());

    // The bytes are repaired from the known-good on-chain copy...
    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteA.ciphertext);
    // ...and the record is left exactly as it was: same txId, same updatedAt.
    const sync = await getSyncRecord('n-1');
    expect(sync?.txId).toBe('tx-A');
    expect(sync?.updatedAt).toBe(NOW - 100_000);
  });

  it('an ALREADY BROKEN pair is repaired: the bytes of the recorded txId win', async () => {
    // Exactly what a pre-D12 build leaves behind: payload B stored under txId A.
    await saveNoteWithSync(noteB, confirmed('tx-A'));

    await mergeRestoredNote(noteA, 'tx-A', NOW, getDbGeneration());

    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteA.ciphertext);
    expect((await getSyncRecord('n-1'))?.txId).toBe('tx-A');
  });

  it('a non-confirmed record is upgraded to confirmed with the on-chain txId', async () => {
    await setSyncRecord({
      noteId: 'n-1', kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1000,
    });

    await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    const sync = await getSyncRecord('n-1');
    expect(sync?.status).toBe('confirmed');
    expect(sync?.txId).toBe('tx-B');
    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
  });

  it('a FRESH uploading row is not touched at all — payload included', async () => {
    await saveNoteWithSync(noteA, {
      noteId: 'n-1', kind: 'note', status: 'uploading', transport: 'proxy',
      updatedAt: NOW - 1000, attemptId: 'attempt-live',
    });

    const outcome = await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    // Reported, not silent: a deferred record has NOT been repaired, so the
    // sweep must keep it in the «undecryptable, re-download it» set instead of
    // hiding a still-broken payload until the next full sweep.
    expect(outcome).toBe('deferred');
    // Rewriting the bytes under a live attempt would let its answer bind a
    // txId to a payload that attempt never sent.
    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteA.ciphertext);
    const sync = await getSyncRecord('n-1');
    expect(sync?.status).toBe('uploading');
    expect(sync?.attemptId).toBe('attempt-live');
  });

  it('a STALE uploading row is merged normally — its late answer is stopped by the attempt-CAS, not by this rule', async () => {
    await saveNoteWithSync(noteA, {
      noteId: 'n-1', kind: 'note', status: 'uploading', transport: 'proxy',
      updatedAt: NOW - STALE_UPLOADING_MS - 1, attemptId: 'attempt-hung',
    });

    await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
    const sync = await getSyncRecord('n-1');
    expect(sync?.status).toBe('confirmed');
    expect(sync?.txId).toBe('tx-B');
    // The hung attempt no longer owns the row: its answer will not match.
    expect(sync?.attemptId).toBeUndefined();
  });

  it('the freshness boundary is exactly STALE_UPLOADING_MS', async () => {
    await saveNoteWithSync(noteA, {
      noteId: 'n-1', kind: 'note', status: 'uploading', transport: 'proxy',
      updatedAt: NOW - STALE_UPLOADING_MS, attemptId: 'attempt-edge',
    });

    await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    // Exactly at the threshold is NO LONGER fresh → merged.
    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
  });

  it('the per-reason quarantine rules are unchanged by the txId comparison', async () => {
    await saveNoteWithSync(noteB, confirmed('tx-A', { terminalError: 'malformed_record' }));

    await mergeRestoredNote(noteA, 'tx-B', NOW, getDbGeneration());

    const sync = await getSyncRecord('n-1');
    expect(sync?.txId).toBe('tx-B');                       // pair still atomic
    expect(sync?.terminalError).toBe('malformed_record');  // non-proof reason survives
  });

  it('recovery_invalidated is still cleared by this proof-bearing path', async () => {
    await saveNoteWithSync(noteB, confirmed('tx-A', { terminalError: 'recovery_invalidated' }));

    await mergeRestoredNote(noteA, 'tx-B', NOW, getDbGeneration());

    expect((await getSyncRecord('n-1'))?.terminalError).toBeUndefined();
  });

  it('a reset landing inside the merge still aborts the write (assertDbGeneration)', async () => {
    await saveNoteWithSync(noteA, confirmed('tx-A'));
    const staleGeneration = getDbGeneration();
    await resetAll(); // bumps the generation

    await expect(mergeRestoredNote(noteB, 'tx-B', NOW, staleGeneration))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getNoteById('n-1')).toBeUndefined();
  });
});

describe('D12 — restore merges the pair atomically (safebox)', () => {
  const confirmedEntry = (txId: string): SyncRecord => ({
    noteId: entryA.entryId, kind: 'safebox', txId, status: 'confirmed',
    transport: 'proxy', updatedAt: NOW - 100_000,
  });

  it('a DIFFERENT transaction replaces the txId together with both halves', async () => {
    await mergeRestoredSafeboxEntry(entryA, 'tx-A', NOW, getDbGeneration());
    await setSyncRecord(confirmedEntry('tx-A'));

    await mergeRestoredSafeboxEntry(entryB, 'tx-B', NOW, getDbGeneration());

    expect((await getSafeboxEntryById(entryA.entryId))?.secretCiphertext).toBe(entryB.secretCiphertext);
    expect((await getSyncRecord(entryA.entryId))?.txId).toBe('tx-B');
  });

  it('the SAME transaction preserves the record and still repairs the bytes', async () => {
    await mergeRestoredSafeboxEntry(entryB, 'tx-A', NOW, getDbGeneration());
    await setSyncRecord(confirmedEntry('tx-A'));

    await mergeRestoredSafeboxEntry(entryA, 'tx-A', NOW, getDbGeneration());

    expect((await getSafeboxEntryById(entryA.entryId))?.secretCiphertext).toBe(entryA.secretCiphertext);
    const sync = await getSyncRecord(entryA.entryId);
    expect(sync?.txId).toBe('tx-A');
    expect(sync?.updatedAt).toBe(NOW - 100_000);
  });

  it('a FRESH uploading row is not touched at all', async () => {
    await mergeRestoredSafeboxEntry(entryA, 'tx-A', NOW, getDbGeneration());
    await setSyncRecord({
      noteId: entryA.entryId, kind: 'safebox', status: 'uploading',
      transport: 'proxy', updatedAt: NOW - 1000, attemptId: 'attempt-live',
    });

    const outcome = await mergeRestoredSafeboxEntry(entryB, 'tx-B', NOW, getDbGeneration());

    expect(outcome).toBe('deferred');
    expect((await getSafeboxEntryById(entryA.entryId))?.secretCiphertext).toBe(entryA.secretCiphertext);
    expect((await getSyncRecord(entryA.entryId))?.status).toBe('uploading');
  });
});

describe('why the client floor exists: the PRE-D12 writer against the new storage', () => {
  /** Verbatim behaviour of the writer that shipped before D12: preserve ANY
   *  existing confirmed record, whatever transaction it names. Reproduced here
   *  rather than described in a comment, because it is the whole reason
   *  DB_VERSION 3 has to be irreversible — an older build needs no help from
   *  the server to recreate the forbidden pair. */
  async function legacyMergeRestoredNote(
    note: typeof noteA, txId: string, now: number,
  ): Promise<void> {
    const sync = await getSyncRecord(note.noteId);
    const record: SyncRecord = sync?.status === 'confirmed'
      ? sync
      : { noteId: note.noteId, kind: 'note', txId, status: 'confirmed', transport: 'proxy', updatedAt: now };
    await saveNoteWithSync(note, record);
  }

  it('produces the forbidden pair «payload B ↔ txId A»', async () => {
    await saveNoteWithSync(noteA, confirmed('tx-A'));

    await legacyMergeRestoredNote(noteB, 'tx-B', NOW);

    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
    expect((await getSyncRecord('n-1'))?.txId).toBe('tx-A'); // ← the defect
  });

  it('the current writer, on the same input, does not', async () => {
    await saveNoteWithSync(noteA, confirmed('tx-A'));

    await mergeRestoredNote(noteB, 'tx-B', NOW, getDbGeneration());

    expect((await getNoteById('n-1'))?.ciphertext).toBe(noteB.ciphertext);
    expect((await getSyncRecord('n-1'))?.txId).toBe('tx-B');
  });
});
