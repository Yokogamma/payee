// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  resetAll,
  saveNote,
  setMeta,
  setSyncRecord,
  getSyncRecord,
  getNoteById,
  getAllNotes,
  getSafeboxEntryById,
  readBackupSnapshot,
  mergeBackupRecord,
  mergeRestoredSafeboxEntry,
  getDbGeneration,
  INCOMPLETE_RESTORE_META_KEY,
  STALE_UPLOADING_MS,
  BackupMergeContractError,
  type SyncRecord,
} from './storage';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';

/**
 * The two storage-level halves of the import path: the consistent snapshot the
 * export reads, and the transaction the merge rules are applied in.
 *
 * The rule table itself is covered purely in `backup-merge.test.ts`; what can
 * only be shown against a real database is here — the live-upload no-op, the
 * TOCTOU abort, and that a snapshot cannot be taken past the cap.
 */

const NOW = 1_750_000_000_000;
const ID = '11111111-2222-4333-8444-555555555555';
const IV = 'AAAAAAAAAAAAAAAA';
const BIG_BUDGET = 32 * 1024 * 1024;

const note = (over: Partial<EncryptedNote> = {}): EncryptedNote =>
  ({ noteId: ID, ciphertext: 'QUFBQQ==', iv: IV, createdAt: NOW - 5000, ...over });

const other = note({ ciphertext: 'QkJCQg==' });

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('readBackupSnapshot', () => {
  it('returns notes, safebox entries and the marker together', async () => {
    await saveNote(note());
    await mergeRestoredSafeboxEntry({
      entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
      metaCiphertext: 'QUFBQQ==', metaIv: IV,
      secretCiphertext: 'QkJCQg==', secretIv: IV,
      createdAt: NOW, v: 4,
    }, 'tx-A', NOW, getDbGeneration());

    const result = await readBackupSnapshot(BIG_BUDGET);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.notes).toHaveLength(1);
    expect(result.snapshot.safebox).toHaveLength(1);
    expect(result.snapshot.incompleteRestore).toBe(false);
  });

  it('an absent marker means complete', async () => {
    const result = await readBackupSnapshot(BIG_BUDGET);
    expect(result.ok && result.snapshot.incompleteRestore).toBe(false);
  });

  it('anything that is not exactly `false` reads as INCOMPLETE', async () => {
    // A corrupted or half-written marker must never downgrade a warning about
    // missing data — the direction of the failure matters more than its shape.
    for (const raw of [true, 'yes', 1, 0, null, {}]) {
      await setMeta(INCOMPLETE_RESTORE_META_KEY, raw);
      const result = await readBackupSnapshot(BIG_BUDGET);
      expect(result.ok && result.snapshot.incompleteRestore, JSON.stringify(raw)).toBe(true);
    }
    await setMeta(INCOMPLETE_RESTORE_META_KEY, false);
    const result = await readBackupSnapshot(BIG_BUDGET);
    expect(result.ok && result.snapshot.incompleteRestore).toBe(false);
  });

  it('stops on the cursor instead of materializing a store past the cap', async () => {
    for (let i = 0; i < 20; i++) {
      await saveNote(note({ noteId: `1111111${i}-2222-4333-8444-555555555555` }));
    }
    // A budget only a couple of records wide: the refusal has to happen while
    // reading, because on a real over-cap store `getAll()` would kill the tab
    // before any size check could fire.
    const result = await readBackupSnapshot(200);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('over_cap');
    expect(result.readBytes).toBeGreaterThan(200);
    // ...and the database is untouched by a read that refused.
    expect(await getAllNotes()).toHaveLength(20);
  });

  it('a budget that exactly fits does not refuse', async () => {
    await saveNote(note());
    const tight = await readBackupSnapshot(BIG_BUDGET);
    expect(tight.ok).toBe(true);
  });
});

describe('mergeBackupRecord — rule 0: a live attempt is untouchable', () => {
  it('a FRESH uploading row defers, and neither payload nor row moves', async () => {
    await saveNote(note());
    const live: SyncRecord = {
      noteId: ID, kind: 'note', status: 'uploading', transport: 'proxy',
      updatedAt: NOW - 1000, attemptId: 'attempt-live',
    };
    await setSyncRecord(live);

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: note() }, now: NOW,
    });

    expect(outcome).toBe('deferred');
    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ==');
    expect(await getSyncRecord(ID)).toEqual(live);
  });

  it('a STALE uploading row is merged normally', async () => {
    await saveNote(note());
    await setSyncRecord({
      noteId: ID, kind: 'note', status: 'uploading', transport: 'proxy',
      updatedAt: NOW - STALE_UPLOADING_MS - 1, attemptId: 'attempt-hung',
    });

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: note() }, now: NOW,
    });

    expect(outcome).toBe('repaired');
    expect((await getNoteById(ID))?.ciphertext).toBe('QkJCQg==');
    // The hung attempt no longer owns the row: its answer will not match.
    expect((await getSyncRecord(ID))?.attemptId).toBeUndefined();
  });
});

describe('mergeBackupRecord — D13: the classification must still describe the row', () => {
  it('aborts when the stored payload moved while we were decrypting', async () => {
    await saveNote(note());
    const before = await getNoteById(ID);

    // The caller classified against `note()`, but the store now holds `other`.
    await saveNote(other);

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: note({ ciphertext: 'Q0NDQw==' }), local: { state: 'corrupt', record: before }, now: NOW,
    });

    expect(outcome).toBe('concurrentChange');
    // Nothing applied: every conclusion about that record was stale.
    expect((await getNoteById(ID))?.ciphertext).toBe('QkJCQg==');
    expect(await getSyncRecord(ID)).toBeUndefined();
  });

  it('aborts when the caller classified «absent» but a payload appeared', async () => {
    await saveNote(note());

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'absent' }, now: NOW,
    });

    expect(outcome).toBe('concurrentChange');
    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ==');
  });

  it('a re-ordered but identical record is NOT a change', async () => {
    // IndexedDB returns a structured clone whose key order is not part of the
    // value. Comparing raw JSON would report a false conflict here.
    await saveNote(note());
    const reordered = {
      createdAt: NOW - 5000, iv: IV, ciphertext: 'QUFBQQ==', noteId: ID,
    } as EncryptedNote;

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: reordered }, now: NOW,
    });

    expect(outcome).toBe('repaired');
  });
});

describe('mergeBackupRecord — the pair is written atomically', () => {
  it('added: payload written, no sync row invented', async () => {
    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: note(), local: { state: 'absent' }, now: NOW,
    });

    expect(outcome).toBe('added');
    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ==');
    expect(await getSyncRecord(ID)).toBeUndefined();
  });

  it('repaired: payload and a retryable row land together, with no txId', async () => {
    await saveNote(note());
    await setSyncRecord({
      noteId: ID, kind: 'note', status: 'confirmed', transport: 'proxy',
      updatedAt: NOW - 1, txId: 'TX-OLD',
    });

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: note() }, now: NOW,
    });

    expect(outcome).toBe('repaired');
    expect((await getNoteById(ID))?.ciphertext).toBe('QkJCQg==');
    const row = await getSyncRecord(ID);
    expect(row).toEqual({ noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW });
    expect(row?.txId).toBeUndefined();
  });

  it('a readable equivalent record changes nothing at all', async () => {
    await saveNote(note());
    await setSyncRecord({
      noteId: ID, kind: 'note', status: 'confirmed', transport: 'proxy', updatedAt: NOW - 1, txId: 'TX-KEEP',
    });

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: note(), local: { state: 'readable', record: note() }, now: NOW,
    });

    expect(outcome).toBe('noop');
    expect((await getSyncRecord(ID))?.txId).toBe('TX-KEEP');
  });

  it('a quarantined record keeps its evidence while its bytes are repaired', async () => {
    await saveNote(note());
    const quarantined: SyncRecord = {
      noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1,
      txId: 'TX-EVIDENCE', terminalError: 'publication_conflict',
    };
    await setSyncRecord(quarantined);

    const outcome = await mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: note() }, now: NOW,
    });

    expect(outcome).toBe('quarantinedDataRepaired');
    expect((await getNoteById(ID))?.ciphertext).toBe('QkJCQg==');
    expect(await getSyncRecord(ID)).toEqual(quarantined); // block and evidence intact
  });
});

describe('mergeBackupRecord — the contract is checked before anything is read', () => {
  it('a record with no usable id is refused, and nothing is written', async () => {
    await saveNote(note());
    const before = await getNoteById(ID);

    for (const noteId of ['', undefined, 42]) {
      const broken = { ...note(), noteId } as unknown as EncryptedNote;
      await expect(mergeBackupRecord({
        kind: 'note', incoming: broken, local: { state: 'absent' }, now: NOW,
      }), String(noteId)).rejects.toBeInstanceOf(BackupMergeContractError);
    }
    expect(await getNoteById(ID)).toEqual(before);
    expect(await getAllNotes()).toHaveLength(1);
  });

  it('a sync row of the OTHER kind refuses the merge instead of guessing', async () => {
    // Note and safebox ids are disjoint spaces (D10), so this means the store
    // disagrees with itself. Choosing a side is how a merge destroys the half
    // it chose against.
    await saveNote(note());
    await setSyncRecord({
      noteId: ID, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: NOW - 1,
    });

    await expect(mergeBackupRecord({
      kind: 'note', incoming: other, local: { state: 'corrupt', record: note() }, now: NOW,
    })).rejects.toBeInstanceOf(BackupMergeContractError);

    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ=='); // untouched
  });

  it('the key written is the one the CAS checked — it comes from `incoming`', async () => {
    // The defect this shape removes: with a separate `id` argument, the CAS
    // could verify one row while `put` stored under the record's own keyPath,
    // overwriting a healthy record that was never examined.
    const unrelated = '99999999-2222-4333-8444-555555555555';
    await saveNote(note({ noteId: unrelated, ciphertext: 'SEVBTFRIWQ==' }));

    await mergeBackupRecord({
      kind: 'note', incoming: note(), local: { state: 'absent' }, now: NOW,
    });

    expect((await getNoteById(unrelated))?.ciphertext).toBe('SEVBTFRIWQ==');
    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ==');
  });
});

describe('readBackupSnapshot — the size measure is an upper bound in BYTES', () => {
  it('counts UTF-8 bytes, not UTF-16 units', async () => {
    // An emoji is four UTF-8 bytes but two UTF-16 units. Measuring in units
    // would let a store several times the cap read as fitting.
    await saveNote({ ...note(), ciphertext: '🙂'.repeat(40) } as unknown as EncryptedNote);

    const inUnitsWouldFit = await readBackupSnapshot(120);
    expect(inUnitsWouldFit.ok).toBe(false);

    const generous = await readBackupSnapshot(BIG_BUDGET);
    expect(generous.ok).toBe(true);
  });

  it('a value JSON cannot carry stops the export loudly, not silently', async () => {
    // IndexedDB accepts an ArrayBuffer; `JSON.stringify` renders it as `{}`, so
    // the record would be measured — and later written — as nothing at all.
    await saveNote({ ...note(), extra: new ArrayBuffer(8) } as unknown as EncryptedNote);

    await expect(readBackupSnapshot(BIG_BUDGET)).rejects.toMatchObject({ code: 'unsupported_value' });
  });
});

describe('mergeBackupRecord — safebox entries land in their OWN store', () => {
  const ENTRY_ID = '88888888-9999-8aaa-baaa-cccccccccccc';
  const entry = (over: Partial<EncryptedSafeboxEntry> = {}): EncryptedSafeboxEntry => ({
    entryId: ENTRY_ID,
    metaCiphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', metaIv: IV,
    secretCiphertext: 'QkJCQkJCQkJCQkJCQkJCQg==', secretIv: IV,
    createdAt: NOW - 5000, v: 4, ...over,
  });

  it('added: the entry goes to `safebox`, not `notes`, and no note appears', async () => {
    // `kind` picks the store, and nothing about the record is sniffed. Worth
    // proving against a real database: a mis-chosen store would write a
    // safebox entry into the notes list, where it would decrypt as garbage.
    const outcome = await mergeBackupRecord({
      kind: 'safebox', incoming: entry(), local: { state: 'absent' }, now: NOW,
    });

    expect(outcome).toBe('added');
    expect((await getSafeboxEntryById(ENTRY_ID))?.secretCiphertext).toBe('QkJCQkJCQkJCQkJCQkJCQg==');
    expect(await getNoteById(ENTRY_ID)).toBeUndefined();
    expect(await getAllNotes()).toHaveLength(0);
  });

  it('repaired: both halves and a SAFEBOX-kinded retryable row land together', async () => {
    await mergeBackupRecord({
      kind: 'safebox', incoming: entry(), local: { state: 'absent' }, now: NOW,
    });
    await setSyncRecord({
      noteId: ENTRY_ID, kind: 'safebox', status: 'confirmed',
      transport: 'proxy', updatedAt: NOW - 1, txId: 'TX-OLD',
    });

    const outcome = await mergeBackupRecord({
      kind: 'safebox',
      incoming: entry({ secretCiphertext: 'Q0NDQ0NDQ0NDQ0NDQ0NDQw==' }),
      local: { state: 'corrupt', record: entry() },
      now: NOW,
    });

    expect(outcome).toBe('repaired');
    expect((await getSafeboxEntryById(ENTRY_ID))?.secretCiphertext).toBe('Q0NDQ0NDQ0NDQ0NDQ0NDQw==');
    expect(await getSyncRecord(ENTRY_ID)).toEqual({
      noteId: ENTRY_ID, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: NOW,
    });
  });

  it('the TOCTOU check reads the safebox store too', async () => {
    await mergeBackupRecord({
      kind: 'safebox', incoming: entry(), local: { state: 'absent' }, now: NOW,
    });

    const outcome = await mergeBackupRecord({
      kind: 'safebox',
      incoming: entry({ secretCiphertext: 'Q0NDQ0NDQ0NDQ0NDQ0NDQw==' }),
      local: { state: 'absent' }, // stale: an entry exists now
      now: NOW,
    });

    expect(outcome).toBe('concurrentChange');
    expect((await getSafeboxEntryById(ENTRY_ID))?.secretCiphertext).toBe('QkJCQkJCQkJCQkJCQkJCQg==');
  });
});

describe('mergeBackupRecord — a failing write leaves nothing behind', () => {
  it('rolls the transaction back and preserves the previous state', async () => {
    // A value IndexedDB cannot structured-clone makes the payload `put`
    // reject. What is being proven is the discipline around it: the explicit
    // abort in the catch, and that a pre-existing row is untouched afterwards.
    //
    // The mirror case — the payload written and the sync `put` then failing —
    // is not reachable through this API, because the sync row is built by the
    // pure decision from validated fields rather than supplied by the caller.
    // Its atomicity rests on both writes sharing ONE transaction, which the
    // successful cases above already exercise.
    await saveNote(note());
    const priorRow: SyncRecord = {
      noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1,
    };
    await setSyncRecord(priorRow);

    const unclonable = { ...note(), ciphertext: 'QkJCQkJCQkJCQkJCQkJCQg==', hook: () => 1 } as unknown as EncryptedNote;

    await expect(mergeBackupRecord({
      kind: 'note', incoming: unclonable, local: { state: 'corrupt', record: note() }, now: NOW,
    })).rejects.toBeDefined();

    expect((await getNoteById(ID))?.ciphertext).toBe('QUFBQQ==');
    expect(await getSyncRecord(ID)).toEqual(priorRow);
  });
});
