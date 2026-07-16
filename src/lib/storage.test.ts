// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  resetAll,
  saveNoteWithSync,
  getNoteById,
  getAllSyncRecords,
  getRecordsByStatus,
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
});
