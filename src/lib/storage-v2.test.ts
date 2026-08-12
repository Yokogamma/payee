// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB, deleteDB } from 'idb';
import {
  initStorage,
  closeStorage,
  resetAll,
  saveNote,
  getAllNotes,
  setSyncRecord,
  getSyncRecord,
  getAllSyncRecords,
  getRecordsByStatus,
  saveSafeboxEntryWithSync,
  mergeRestoredSafeboxEntry,
  getAllSafeboxEntries,
  getSafeboxEntryById,
  countSafeboxEntries,
  isDbVersionError,
  setMeta,
  getMeta,
  readV4PauseMeta,
  commitV4PausedFailure,
  clearV4UploadsPaused,
  readV3PauseMeta,
  V4_PAUSE_META_KEY,
  type SyncRecord,
} from './storage';
import type { EncryptedSafeboxEntry } from './crypto';

// §5 / §8: the v1→v2 migration under multi-tab reality, the safebox store
// helpers, the `kind` normalization at the read boundary and the INDEPENDENT
// v4 pause marker.

const DB_NAME = 'eternal-notes';

function entry(id: string, over: Partial<EncryptedSafeboxEntry> = {}): EncryptedSafeboxEntry {
  return {
    entryId: id,
    metaCiphertext: 'AAAA', metaIv: 'AAAAAAAAAAAAAAAA',
    secretCiphertext: 'BBBB', secretIv: 'AAAAAAAAAAAAAAAA',
    createdAt: 100, v: 4,
    ...over,
  };
}

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('DB_VERSION 1 → 2 migration (blocker B1)', () => {
  it('upgrades an EXISTING v1 database without touching its data', async () => {
    // Start from scratch with a real v1 schema holding a note.
    closeStorage();
    await deleteDB(DB_NAME);
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('notes', { keyPath: 'noteId' }).createIndex('by-timestamp', 'createdAt');
        db.createObjectStore('sync', { keyPath: 'noteId' }).createIndex('by-status', 'status');
        db.createObjectStore('meta');
      },
    });
    await v1.put('notes', { noteId: 'legacy', ciphertext: 'c', iv: 'iv', createdAt: 5 });
    await v1.put('meta', true, 'migration-v1-done');
    await v1.put('meta', true, 'init');
    v1.close();

    await initStorage(); // ← the guarded upgrade path runs here

    // The pre-existing note survived and the NEW store exists and is usable.
    expect((await getAllNotes()).map(n => n.noteId)).toEqual(['legacy']);
    expect(await getMeta('init')).toBe(true);
    await saveSafeboxEntryWithSync(entry('11111111-2222-8333-8444-555555555555'), {
      noteId: '11111111-2222-8333-8444-555555555555', kind: 'safebox',
      status: 'confirmed', transport: 'proxy', updatedAt: 1,
    });
    expect(await countSafeboxEntries()).toBe(1);
  });

  it('an OLD tab still holding v1 BLOCKS the upgrade — onBlocked fires, then it completes', async () => {
    closeStorage();
    await deleteDB(DB_NAME);
    // "Another tab": a v1 connection that ignores versionchange.
    const otherTab = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('notes', { keyPath: 'noteId' }).createIndex('by-timestamp', 'createdAt');
        db.createObjectStore('sync', { keyPath: 'noteId' }).createIndex('by-status', 'status');
        db.createObjectStore('meta');
      },
    });

    let blocked = false;
    const opening = initStorage({ onBlocked: () => { blocked = true; } });

    await new Promise(r => setTimeout(r, 50));
    expect(blocked).toBe(true); // the user is told to close the other tab…

    otherTab.close();
    await opening;              // …and the upgrade completes by itself
    await saveNote({ noteId: 'after', ciphertext: 'c', iv: 'iv', createdAt: 1 });
    expect(await getAllSafeboxEntries()).toEqual([]);
  });

  it('an OLDER build opening the migrated DB gets a VersionError we can classify', async () => {
    await initStorage(); // ensures v2 exists
    // Simulate the pre-R4 client: it asks for version 1.
    let caught: unknown;
    try {
      await openDB(DB_NAME, 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // The store's bootstrap branches on exactly this to show a RELOAD screen
    // instead of the destructive reset.
    expect(isDbVersionError(caught)).toBe(true);
    expect(isDbVersionError(new Error('quota exceeded'))).toBe(false);
  });
});

describe('safebox store helpers', () => {
  const ID = '11111111-2222-8333-8444-555555555555';

  it('saveSafeboxEntryWithSync writes both stores atomically', async () => {
    await saveSafeboxEntryWithSync(entry(ID), {
      noteId: ID, kind: 'safebox', txId: 'TX1', status: 'confirmed', transport: 'proxy', updatedAt: 2,
    });
    expect((await getSafeboxEntryById(ID))?.v).toBe(4);
    expect((await getSyncRecord(ID))?.kind).toBe('safebox');
  });

  it('rolls back the entry when the sync write fails', async () => {
    const bad = { kind: 'safebox', status: 'confirmed', transport: 'proxy', updatedAt: 2 } as unknown as SyncRecord;
    await expect(saveSafeboxEntryWithSync(entry(ID), bad)).rejects.toBeDefined();
    expect(await getSafeboxEntryById(ID)).toBeUndefined();
  });

  it('mergeRestoredSafeboxEntry repairs a corrupted payload but keeps a CONFIRMED record', async () => {
    await saveSafeboxEntryWithSync(entry(ID, { metaCiphertext: 'CORRUPT' }), {
      noteId: ID, kind: 'safebox', txId: 'TX-OLD', status: 'confirmed', transport: 'proxy', updatedAt: 1,
    });
    await mergeRestoredSafeboxEntry(entry(ID, { metaCiphertext: 'GOOD' }), 'TX-NEW', 50);
    expect((await getSafeboxEntryById(ID))?.metaCiphertext).toBe('GOOD');
    expect((await getSyncRecord(ID))?.txId).toBe('TX-OLD'); // original record preserved
  });

  it('mergeRestoredSafeboxEntry upgrades a non-terminal record to confirmed:safebox', async () => {
    await saveSafeboxEntryWithSync(entry(ID), {
      noteId: ID, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: 1,
    });
    await mergeRestoredSafeboxEntry(entry(ID), 'TX-NEW', 50);
    const rec = await getSyncRecord(ID);
    expect(rec).toMatchObject({ status: 'confirmed', txId: 'TX-NEW', kind: 'safebox' });
  });

  it('resetAll clears the safebox store too', async () => {
    await saveSafeboxEntryWithSync(entry(ID), {
      noteId: ID, kind: 'safebox', status: 'confirmed', transport: 'proxy', updatedAt: 1,
    });
    await resetAll();
    expect(await countSafeboxEntries()).toBe(0);
  });
});

describe('SyncRecord.kind normalization at the READ boundary', () => {
  it('a legacy record written without `kind` reads back as a note', async () => {
    const legacy = { noteId: 'legacy', status: 'error', transport: 'proxy', updatedAt: 1 } as unknown as SyncRecord;
    await setSyncRecord(legacy);
    expect((await getSyncRecord('legacy'))?.kind).toBe('note');
    expect((await getAllSyncRecords()).find(r => r.noteId === 'legacy')?.kind).toBe('note');
    expect((await getRecordsByStatus('error')).find(r => r.noteId === 'legacy')?.kind).toBe('note');
  });

  it('an explicit safebox record keeps its kind through every read path', async () => {
    await setSyncRecord({
      noteId: 'sbx', kind: 'safebox', status: 'accepted', transport: 'proxy', updatedAt: 1,
    });
    expect((await getSyncRecord('sbx'))?.kind).toBe('safebox');
    expect((await getRecordsByStatus('accepted')).find(r => r.noteId === 'sbx')?.kind).toBe('safebox');
  });

  it('a PRESENT but invalid `kind` is QUARANTINED, not silently called a note', async () => {
    await setSyncRecord({
      noteId: 'weird', kind: 'nonsense', status: 'error', transport: 'proxy', updatedAt: 1,
    } as unknown as SyncRecord);

    const rec = (await getSyncRecord('weird'))!;
    // Fail-CLOSED: a corrupted row must never re-enter the upload queue, and
    // must not be counted in the notes aggregates as if it were a valid note.
    expect(rec.terminalError).toBe('malformed_record');
    // …and the read does not mutate storage.
    const raw = await getMeta('nothing');
    expect(raw).toBeUndefined();
    const all = await getAllSyncRecords();
    expect(all.find(r => r.noteId === 'weird')?.terminalError).toBe('malformed_record');
  });

  it('an EXPLICIT `kind: undefined` is corruption, not a legacy row', async () => {
    // Structured clone (what IndexedDB uses) PRESERVES a key stored as
    // undefined, so `=== undefined` cannot tell this apart from a legacy row.
    // A legacy row predates the field entirely; this one was written by
    // something that knew about the field and got it wrong.
    await setSyncRecord({
      noteId: 'explicit-undef', kind: undefined, status: 'error',
      transport: 'proxy', updatedAt: 1,
    } as unknown as SyncRecord);

    const rec = (await getSyncRecord('explicit-undef'))!;
    expect(rec.terminalError).toBe('malformed_record');
  });

  it('an ABSENT kind (legacy row) is NOT quarantined — it is simply a note', async () => {
    const legacy = { noteId: 'old', status: 'error', transport: 'proxy', updatedAt: 1 } as unknown as SyncRecord;
    await setSyncRecord(legacy);
    const rec = (await getSyncRecord('old'))!;
    expect(rec.kind).toBe('note');
    expect(rec.terminalError).toBeUndefined(); // retryable, as it always was
  });
});

describe('v4 pause marker (independent of v3)', () => {
  const REC: SyncRecord = {
    noteId: 'p4', kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: 5,
    lastError: 'v4_uploads_disabled',
  };

  it('commits the failure record and the v4 marker together — and NOT the v3 one', async () => {
    await commitV4PausedFailure(REC, 999);
    expect(await getSyncRecord('p4')).toEqual(REC);
    expect(await readV4PauseMeta()).toEqual({ pausedAt: 999 });
    expect(await readV3PauseMeta()).toBeNull(); // pausing v4 must not stall notes
  });

  it('compare-and-delete: a stale probe cannot erase a newer pause', async () => {
    await setMeta(V4_PAUSE_META_KEY, { pausedAt: 100 });
    await setMeta(V4_PAUSE_META_KEY, { pausedAt: 200 });
    expect(await clearV4UploadsPaused(100)).toBe(false);
    expect(await readV4PauseMeta()).toEqual({ pausedAt: 200 });
    expect(await clearV4UploadsPaused(200)).toBe(true);
    expect(await readV4PauseMeta()).toBeNull();
  });

  it('a malformed marker reads as "malformed" (paused, fail closed) and clears only via "any"', async () => {
    await setMeta(V4_PAUSE_META_KEY, 'garbage');
    expect(await readV4PauseMeta()).toBe('malformed');
    expect(await clearV4UploadsPaused('any')).toBe(true);
    expect(await readV4PauseMeta()).toBeNull();
  });
});
