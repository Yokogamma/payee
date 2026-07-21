// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import {
  initStorage,
  resetAll,
  recoverStorage,
  saveNoteWithSync,
  mergeRestoredNote,
  saveNote,
  getNoteById,
  getAllNotes,
  getAllSyncRecords,
  getRecordsByStatus,
  getMeta,
  type SyncRecord,
} from './storage';

// jsdom gives us localStorage (for the migration path); fake-indexeddb gives us
// IndexedDB. Together they let storage.ts run under Node.

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('saveNoteWithSync', () => {
  it('persists the note and its sync record together', async () => {
    await saveNoteWithSync(
      { noteId: 'n1', ciphertext: 'c', iv: 'iv', createdAt: 1, v: 2 },
      { noteId: 'n1', txId: 'tx1', status: 'confirmed', transport: 'proxy', updatedAt: 2 },
    );

    const note = await getNoteById('n1');
    expect(note).toBeDefined();
    expect(note?.v).toBe(2);

    const confirmed = await getRecordsByStatus('confirmed');
    expect(confirmed.map(r => r.noteId)).toContain('n1');
    expect(confirmed.find(r => r.noteId === 'n1')?.txId).toBe('tx1');
  });

  it('marks a restored note confirmed so it is not counted as pending', async () => {
    await saveNoteWithSync(
      { noteId: 'n2', ciphertext: 'c', iv: 'iv', createdAt: 1 },
      { noteId: 'n2', txId: 'tx2', status: 'confirmed', transport: 'proxy', updatedAt: 2 },
    );
    const all = await getAllSyncRecords();
    const rec = all.find(r => r.noteId === 'n2');
    // syncPendingNotes skips accepted/confirmed → this note won't be re-uploaded.
    expect(rec?.status).toBe('confirmed');
  });

  it('rolls back the note if the sync write fails (atomic — both or neither)', async () => {
    // The sync store has keyPath 'noteId'; a record without it makes the second
    // put fail, which must abort the whole transaction and roll back the note.
    const badRecord = { txId: 'tx3', status: 'confirmed', transport: 'proxy', updatedAt: 2 } as unknown as SyncRecord;
    await expect(
      saveNoteWithSync({ noteId: 'n3', ciphertext: 'c', iv: 'iv', createdAt: 1 }, badRecord),
    ).rejects.toBeDefined();

    expect(await getNoteById('n3')).toBeUndefined(); // note rolled back
    const all = await getAllSyncRecords();
    expect(all.find(r => r.noteId === 'n3')).toBeUndefined();
  });
});

describe('mergeRestoredNote (restore repair)', () => {
  const NOTE = { noteId: 'm1', ciphertext: 'c', iv: 'iv', createdAt: 1 };

  it('repairs an EXISTING note that has no SyncRecord: writes confirmed', async () => {
    // The old-version-restore scenario: note present, sync state missing.
    await saveNote(NOTE);
    await mergeRestoredNote(NOTE, 'tx-m1', 100);

    // Now confirmed → syncPendingNotes' skip-set covers it (no re-upload).
    const confirmed = await getRecordsByStatus('confirmed');
    const rec = confirmed.find(r => r.noteId === 'm1');
    expect(rec?.txId).toBe('tx-m1');

    const allNotes = await getAllNotes();
    const unsynced = allNotes.filter(n =>
      !confirmed.some(r => r.noteId === n.noteId));
    expect(unsynced.find(n => n.noteId === 'm1')).toBeUndefined(); // pending set empty for m1
  });

  it('writes a brand-new note atomically with its confirmed record', async () => {
    await mergeRestoredNote({ ...NOTE, noteId: 'm2' }, 'tx-m2', 100);
    expect(await getNoteById('m2')).toBeDefined();
    expect((await getRecordsByStatus('confirmed')).some(r => r.noteId === 'm2')).toBe(true);
  });

  it('REPAIRS a corrupted local payload even when the sync record is already confirmed', async () => {
    // Local ciphertext rotted (undecryptable) but sync says confirmed — restore
    // must replace the payload with the known-good on-chain copy while keeping
    // the ORIGINAL confirmed record (txId untouched).
    await saveNoteWithSync({ noteId: 'm3', ciphertext: 'CORRUPTED', iv: 'iv', createdAt: 1 },
      { noteId: 'm3', txId: 'tx-old', status: 'confirmed', transport: 'proxy', updatedAt: 1 });

    await mergeRestoredNote({ noteId: 'm3', ciphertext: 'GOOD-ONCHAIN', iv: 'iv2', createdAt: 1 }, 'tx-new', 100);

    expect((await getNoteById('m3'))?.ciphertext).toBe('GOOD-ONCHAIN'); // payload repaired
    const rec = (await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm3');
    expect(rec?.txId).toBe('tx-old'); // original confirmed record preserved
  });

  it('upgrades a non-terminal sync record (e.g. error) to confirmed', async () => {
    await saveNoteWithSync({ ...NOTE, noteId: 'm4' },
      { noteId: 'm4', status: 'error', transport: 'proxy', updatedAt: 1 });
    await mergeRestoredNote({ ...NOTE, noteId: 'm4' }, 'tx-m4', 100);
    expect((await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm4')?.txId).toBe('tx-m4');
  });
});

describe('recoverStorage', () => {
  it('deletes the database and re-initializes to a clean, working state', async () => {
    await saveNote({ noteId: 'keep', ciphertext: 'c', iv: 'iv', createdAt: 1 });
    await recoverStorage();

    // Old data gone, storage usable again without an explicit initStorage call.
    expect(await getNoteById('keep')).toBeUndefined();
    await saveNote({ noteId: 'fresh', ciphertext: 'c', iv: 'iv', createdAt: 2 });
    expect(await getNoteById('fresh')).toBeDefined();
  });

  it('waits out a blocking tab (onBlocked fires) and completes once it closes — never pretends cancelled', async () => {
    // Simulate another tab: an independent connection that ignores versionchange.
    const otherTab = await openDB('eternal-notes', 1);

    let blockedSignalled = false;
    const recovery = recoverStorage({ onBlocked: () => { blockedSignalled = true; } });

    // The user is told to close other tabs; the deletion is PENDING, not
    // cancelled (deleteDatabase cannot be aborted once requested).
    await new Promise(r => setTimeout(r, 50));
    expect(blockedSignalled).toBe(true);

    // The blocking "tab" closes → the pending deletion completes and recovery
    // resolves with a fresh, working database.
    otherTab.close();
    await recovery;
    await saveNote({ noteId: 'after-block', ciphertext: 'c', iv: 'iv', createdAt: 1 });
    expect(await getNoteById('after-block')).toBeDefined();
  });
});

describe('localStorage migration validation', () => {
  it('migrates well-formed legacy notes and clears localStorage', async () => {
    localStorage.setItem('eternal-notes-encrypted', JSON.stringify([
      { ciphertext: 'ct', iv: 'iv', createdAt: 123 },
    ]));
    localStorage.setItem('eternal-notes-init', 'true');

    await recoverStorage(); // fresh DB → migration runs

    const notes = await getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].ciphertext).toBe('ct');
    expect(await getMeta('migration-v1-done')).toBe(true);
    expect(await getMeta('init')).toBe(true);
    expect(localStorage.getItem('eternal-notes-encrypted')).toBeNull();
  });

  it('rejects records with invalid shape: no marker, localStorage preserved', async () => {
    const raw = JSON.stringify([
      { ciphertext: 'ct', iv: 'iv', createdAt: 123 },
      { ciphertext: 42, iv: 'iv' }, // corrupted record
    ]);
    localStorage.setItem('eternal-notes-encrypted', raw);

    await recoverStorage();

    expect(await getAllNotes()).toHaveLength(0); // nothing partially migrated
    expect(await getMeta('migration-v1-done')).toBeUndefined();
    expect(localStorage.getItem('eternal-notes-encrypted')).toBe(raw); // kept for recovery
    localStorage.removeItem('eternal-notes-encrypted');
  });

  it('rejects a non-array payload: no marker, localStorage preserved', async () => {
    const raw = JSON.stringify({ not: 'an array' });
    localStorage.setItem('eternal-notes-encrypted', raw);

    await recoverStorage();

    expect(await getAllNotes()).toHaveLength(0);
    expect(await getMeta('migration-v1-done')).toBeUndefined();
    expect(localStorage.getItem('eternal-notes-encrypted')).toBe(raw);
    localStorage.removeItem('eternal-notes-encrypted');
  });
});
