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
  setMeta,
  getPinConfigMeta,
  clearPinConfigMeta,
  getDbGeneration,
  StorageResetError,
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
      { noteId: 'n1', kind: 'note', txId: 'tx1', status: 'confirmed', transport: 'proxy', updatedAt: 2 },
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
      { noteId: 'n2', kind: 'note', txId: 'tx2', status: 'confirmed', transport: 'proxy', updatedAt: 2 },
    );
    const all = await getAllSyncRecords();
    const rec = all.find(r => r.noteId === 'n2');
    // syncPendingNotes skips accepted/confirmed → this note won't be re-uploaded.
    expect(rec?.status).toBe('confirmed');
  });

  it('rolls back the note if the sync write fails (atomic — both or neither)', async () => {
    // The sync store has keyPath 'noteId'; a record without it makes the second
    // put fail, which must abort the whole transaction and roll back the note.
    const badRecord = { kind: 'note', txId: 'tx3', status: 'confirmed', transport: 'proxy', updatedAt: 2 } as unknown as SyncRecord;
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
    await mergeRestoredNote(NOTE, 'tx-m1', 100, getDbGeneration());

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
    await mergeRestoredNote({ ...NOTE, noteId: 'm2' }, 'tx-m2', 100, getDbGeneration());
    expect(await getNoteById('m2')).toBeDefined();
    expect((await getRecordsByStatus('confirmed')).some(r => r.noteId === 'm2')).toBe(true);
  });

  it('REPAIRS a corrupted local payload even when the sync record is already confirmed', async () => {
    // Local ciphertext rotted (undecryptable) but sync says confirmed — restore
    // must replace the payload with the known-good on-chain copy while keeping
    // the ORIGINAL confirmed record (txId untouched).
    await saveNoteWithSync({ noteId: 'm3', ciphertext: 'CORRUPTED', iv: 'iv', createdAt: 1 },
      { noteId: 'm3', kind: 'note', txId: 'tx-old', status: 'confirmed', transport: 'proxy', updatedAt: 1 });

    await mergeRestoredNote({ noteId: 'm3', ciphertext: 'GOOD-ONCHAIN', iv: 'iv2', createdAt: 1 }, 'tx-new', 100, getDbGeneration());

    expect((await getNoteById('m3'))?.ciphertext).toBe('GOOD-ONCHAIN'); // payload repaired
    const rec = (await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm3');
    expect(rec?.txId).toBe('tx-old'); // original confirmed record preserved
  });

  it('upgrades a non-terminal sync record (e.g. error) to confirmed', async () => {
    await saveNoteWithSync({ ...NOTE, noteId: 'm4' },
      { noteId: 'm4', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 1 });
    await mergeRestoredNote({ ...NOTE, noteId: 'm4' }, 'tx-m4', 100, getDbGeneration());
    expect((await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm4')?.txId).toBe('tx-m4');
  });

  it('a reset landing INSIDE the merge (between the sync read and the write) writes nothing', async () => {
    // The caller's pre-merge generation check cannot cover this: `await
    // getSyncRecord()` is a real suspension point. Starting the merge and then
    // resetting hits exactly that window — resetAll bumps the generation and
    // creates its clear transaction while the merge is parked on the read.
    const gen = getDbGeneration();
    // The handler is attached SYNCHRONOUSLY: the rejection lands during the
    // resetAll below, and a bare pending promise would surface as an unhandled
    // rejection before the assertion ever gets to look at it.
    const merge = mergeRestoredNote({ ...NOTE, noteId: 'm5' }, 'tx-m5', 100, gen)
      .then(() => null, (e: unknown) => e);
    await resetAll();

    // Data first: «nothing was resurrected» is the invariant; the typed error
    // is only the mechanism that enforces it.
    expect(await getNoteById('m5')).toBeUndefined();
    expect(await getAllSyncRecords()).toHaveLength(0);
    expect(await merge).toBeInstanceOf(StorageResetError);
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
    const otherTab = await openDB('matamata-notes', 2);

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

describe('clearPinConfigMeta (§8 — atomic PIN cleanup)', () => {
  it('deletes pin-seed/attempts/lockout AND resets auto-lock-timeout to null', async () => {
    await setMeta('pin-seed', { ciphertext: 'ct', iv: 'iv', salt: 's' });
    await setMeta('pin-attempts', 7);
    await setMeta('pin-locked-until', Date.now() + 60_000);
    await setMeta('auto-lock-timeout', 300);

    await clearPinConfigMeta();

    expect(await getMeta('pin-seed')).toBeUndefined();
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    // null (not undefined): the reset is an explicit «Никогда», not a deletion.
    expect(await getMeta('auto-lock-timeout')).toBeNull();
  });

  it('is idempotent — succeeds with nothing configured', async () => {
    await clearPinConfigMeta();
    expect(await getMeta('pin-seed')).toBeUndefined();
    expect(await getMeta('auto-lock-timeout')).toBeNull();
  });

  it('leaves unrelated meta keys untouched', async () => {
    await setMeta('init', true);
    await setMeta('ar-enabled', true);
    await setMeta('vault-public-key', 'pk');
    await clearPinConfigMeta();
    expect(await getMeta('init')).toBe(true);
    expect(await getMeta('ar-enabled')).toBe(true);
    expect(await getMeta('vault-public-key')).toBe('pk');
  });
});

describe('getPinConfigMeta (round 5 — one consistent snapshot)', () => {
  it('returns both configured values from a single readonly transaction', async () => {
    await setMeta('pin-seed', { ciphertext: 'ct', iv: 'iv', salt: 's' });
    await setMeta('auto-lock-timeout', 300);
    expect(await getPinConfigMeta()).toEqual({
      pinSeed: { ciphertext: 'ct', iv: 'iv', salt: 's' },
      autoLockTimeout: 300,
    });
  });

  it('returns undefined values when nothing is configured', async () => {
    expect(await getPinConfigMeta()).toEqual({ pinSeed: undefined, autoLockTimeout: undefined });
  });

  it('sees the post-wipe state as one piece (never pin gone + old timeout)', async () => {
    await setMeta('pin-seed', { ciphertext: 'ct', iv: 'iv', salt: 's' });
    await setMeta('auto-lock-timeout', 1800);
    await clearPinConfigMeta();
    expect(await getPinConfigMeta()).toEqual({ pinSeed: undefined, autoLockTimeout: null });
  });
});

describe('localStorage migration validation', () => {
  it('migrates well-formed legacy notes and clears localStorage', async () => {
    localStorage.setItem('matamata-notes-encrypted', JSON.stringify([
      { ciphertext: 'ct', iv: 'iv', createdAt: 123 },
    ]));
    localStorage.setItem('matamata-notes-init', 'true');

    await recoverStorage(); // fresh DB → migration runs

    const notes = await getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].ciphertext).toBe('ct');
    expect(await getMeta('migration-v1-done')).toBe(true);
    expect(await getMeta('init')).toBe(true);
    expect(localStorage.getItem('matamata-notes-encrypted')).toBeNull();
  });

  it('rejects records with invalid shape: no marker, localStorage preserved', async () => {
    const raw = JSON.stringify([
      { ciphertext: 'ct', iv: 'iv', createdAt: 123 },
      { ciphertext: 42, iv: 'iv' }, // corrupted record
    ]);
    localStorage.setItem('matamata-notes-encrypted', raw);

    await recoverStorage();

    expect(await getAllNotes()).toHaveLength(0); // nothing partially migrated
    expect(await getMeta('migration-v1-done')).toBeUndefined();
    expect(localStorage.getItem('matamata-notes-encrypted')).toBe(raw); // kept for recovery
    localStorage.removeItem('matamata-notes-encrypted');
  });

  it('rejects a non-array payload: no marker, localStorage preserved', async () => {
    const raw = JSON.stringify({ not: 'an array' });
    localStorage.setItem('matamata-notes-encrypted', raw);

    await recoverStorage();

    expect(await getAllNotes()).toHaveLength(0);
    expect(await getMeta('migration-v1-done')).toBeUndefined();
    expect(localStorage.getItem('matamata-notes-encrypted')).toBe(raw);
    localStorage.removeItem('matamata-notes-encrypted');
  });
});

// ─── v3 pause meta + atomic quarantine helpers ──────────────────────

import {
  readV3PauseMeta,
  commitV3PausedFailure,
  clearV3UploadsPaused,
  setSyncRecord,
  getSyncRecord,
  V3_PAUSE_META_KEY,
} from './storage';

describe('commitV3PausedFailure (atomic sync+meta)', () => {
  it('a successful commit writes the SyncRecord AND the pause marker together', async () => {
    const record: SyncRecord = {
      noteId: 'p1', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 5,
      lastError: 'v3_uploads_disabled',
    };
    await commitV3PausedFailure(record, 12345);
    expect(await getSyncRecord('p1')).toEqual(record);
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 12345 });
  });

  it('preserves txId/recovery/needsRecheck fields on the committed record', async () => {
    const record: SyncRecord = {
      noteId: 'p2', kind: 'note', txId: 'TX-KEEP', status: 'accepted', transport: 'proxy',
      updatedAt: 5, needsRecheck: true,
      recovery: { txId: 'TX-KEEP', postedAt: 1, token: 'tok' },
    };
    await commitV3PausedFailure(record, 1);
    const stored = await getSyncRecord('p2');
    expect(stored?.txId).toBe('TX-KEEP');
    expect(stored?.needsRecheck).toBe(true);
    expect(stored?.recovery).toEqual(record.recovery);
  });

  it('aborts BOTH writes when the record is invalid (rollback, no half-commit)', async () => {
    // sync store keyPath is noteId — a record without it fails the first put.
    const bad = { kind: 'note', status: 'error', transport: 'proxy', updatedAt: 5 } as unknown as SyncRecord;
    await expect(commitV3PausedFailure(bad, 777)).rejects.toBeDefined();
    expect(await readV3PauseMeta()).toBeNull(); // pause marker NOT written
  });
});

describe('readV3PauseMeta (fail-closed validation)', () => {
  it('returns null when absent', async () => {
    expect(await readV3PauseMeta()).toBeNull();
  });

  it('treats a malformed present value as paused-equivalent ("malformed")', async () => {
    await setMeta(V3_PAUSE_META_KEY, 'garbage');
    expect(await readV3PauseMeta()).toBe('malformed');
    await setMeta(V3_PAUSE_META_KEY, { pausedAt: 'soon' });
    expect(await readV3PauseMeta()).toBe('malformed');
    await setMeta(V3_PAUSE_META_KEY, { pausedAt: -1 });
    expect(await readV3PauseMeta()).toBe('malformed');
  });
});

describe('clearV3UploadsPaused (compare-and-delete)', () => {
  it('removes the marker only when pausedAt matches the expectation', async () => {
    await setMeta(V3_PAUSE_META_KEY, { pausedAt: 100 });
    expect(await clearV3UploadsPaused(999)).toBe(false); // stale probe — newer marker stays
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 100 });
    expect(await clearV3UploadsPaused(100)).toBe(true);
    expect(await readV3PauseMeta()).toBeNull();
  });

  it('a stale health probe cannot erase a NEWER pause set after the probe started', async () => {
    await setMeta(V3_PAUSE_META_KEY, { pausedAt: 100 });
    // health check started, saw pausedAt=100... meanwhile a new pause landed:
    await setMeta(V3_PAUSE_META_KEY, { pausedAt: 200 });
    expect(await clearV3UploadsPaused(100)).toBe(false);
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 200 });
  });

  it("'any' clears unconditionally (manual retry), including malformed markers", async () => {
    await setMeta(V3_PAUSE_META_KEY, 'garbage');
    expect(await clearV3UploadsPaused('any')).toBe(true);
    expect(await readV3PauseMeta()).toBeNull();
  });

  it('returns false when there is no marker', async () => {
    expect(await clearV3UploadsPaused('any')).toBe(false);
  });
});

describe('SyncRecord.terminalError round-trip', () => {
  it('persists the quarantine reason', async () => {
    await setSyncRecord({
      noteId: 'q1', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 1,
      terminalError: 'unsupported_version',
    });
    expect((await getSyncRecord('q1'))?.terminalError).toBe('unsupported_version');
  });
});

describe('v3 EncryptedNote round-trip', () => {
  it('stores and merges a v3 record like any other version', async () => {
    const note = { noteId: 'v3n', ciphertext: 'c', iv: 'iv', createdAt: 9, v: 3 as const };
    await mergeRestoredNote(note, 'TX-V3', 10, getDbGeneration());
    expect((await getNoteById('v3n'))?.v).toBe(3);
    expect((await getSyncRecord('v3n'))?.status).toBe('confirmed');
  });
});

// ─── DB generation (reset-exclusivity token, P1) ────────────────────

import { getDbGeneration, noteExternalReset } from './storage';

describe('dbGeneration', () => {
  it('bumps on resetAll — a captured token from before the wipe goes stale', async () => {
    const before = getDbGeneration();
    await resetAll();
    expect(getDbGeneration()).toBe(before + 1);
  });

  it('bumps on noteExternalReset (another tab announced the wipe)', () => {
    const before = getDbGeneration();
    noteExternalReset();
    expect(getDbGeneration()).toBe(before + 1);
  });
});

// ─── Vault identity + first-writer-wins PIN write ───────────────────

import { bindVaultIdentity, commitPinSeedIfAbsent } from './storage';
import type { PinEncryptedSeed } from './crypto';

const PK_A = 'pk-aaa';
const PK_B = 'pk-bbb';
const BLOB_A = { ciphertext: 'ctA', iv: 'iv', salt: 's' } as PinEncryptedSeed;
const BLOB_B = { ciphertext: 'ctB', iv: 'iv', salt: 's' } as PinEncryptedSeed;

describe('bindVaultIdentity', () => {
  it('binds the key on an empty database', async () => {
    expect(await bindVaultIdentity(PK_A, { initialize: false }, getDbGeneration())).toBe('bound');
    expect(await getMeta('vault-public-key')).toBe(PK_A);
    expect(await getMeta('init')).toBeUndefined(); // initialize:false writes no init
  });

  it('writes `init` in the SAME commit when asked', async () => {
    expect(await bindVaultIdentity(PK_A, { initialize: true }, getDbGeneration())).toBe('bound');
    expect(await getMeta('vault-public-key')).toBe(PK_A);
    expect(await getMeta('init')).toBe(true);
  });

  it('accepts the same key again and can initialize an already-bound vault', async () => {
    await bindVaultIdentity(PK_A, { initialize: false }, getDbGeneration());
    expect(await bindVaultIdentity(PK_A, { initialize: true }, getDbGeneration())).toBe('same');
    expect(await getMeta('init')).toBe(true);
  });

  it('refuses a FOREIGN key and writes nothing — not the key, not init', async () => {
    await bindVaultIdentity(PK_A, { initialize: false }, getDbGeneration());
    expect(await bindVaultIdentity(PK_B, { initialize: true }, getDbGeneration())).toBe('foreign');
    expect(await getMeta('vault-public-key')).toBe(PK_A);
    expect(await getMeta('init')).toBeUndefined();
  });

  it('two tabs, EMPTY database, different seeds: first-writer-wins', async () => {
    // The whole point of doing this in one transaction: the loser can never
    // leave its own key (or init) behind next to the winner's PIN.
    expect(await bindVaultIdentity(PK_A, { initialize: true }, getDbGeneration())).toBe('bound');
    expect(await bindVaultIdentity(PK_B, { initialize: true }, getDbGeneration())).toBe('foreign');
    expect(await getMeta('vault-public-key')).toBe(PK_A);
  });

  it('throws StorageResetError on a stale generation (wiped meanwhile)', async () => {
    const stale = getDbGeneration();
    await resetAll(); // bumps the generation
    await expect(bindVaultIdentity(PK_A, { initialize: true }, stale))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getMeta('vault-public-key')).toBeUndefined();
    expect(await getMeta('init')).toBeUndefined();
  });
});

describe('commitPinSeedIfAbsent (first-writer-wins)', () => {
  it('writes the blob when none is configured', async () => {
    expect(await commitPinSeedIfAbsent(BLOB_A, getDbGeneration())).toBe(true);
    expect(await getMeta('pin-seed')).toEqual(BLOB_A);
  });

  it('clears stale metering in the SAME commit', async () => {
    await setMeta('pin-attempts', 7);
    await setMeta('pin-locked-until', Date.now() + 60_000);
    expect(await commitPinSeedIfAbsent(BLOB_A, getDbGeneration())).toBe(true);
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
  });

  it('refuses to overwrite a PIN another tab configured first', async () => {
    await setMeta('pin-seed', BLOB_A);
    expect(await commitPinSeedIfAbsent(BLOB_B, getDbGeneration())).toBe(false);
    expect(await getMeta('pin-seed')).toEqual(BLOB_A); // foreign blob untouched
  });

  it('leaves the metering alone when it refuses', async () => {
    await setMeta('pin-seed', BLOB_A);
    await setMeta('pin-attempts', 3);
    expect(await commitPinSeedIfAbsent(BLOB_B, getDbGeneration())).toBe(false);
    expect(await getMeta('pin-attempts')).toBe(3);
  });

  it('throws StorageResetError on a stale generation', async () => {
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitPinSeedIfAbsent(BLOB_A, stale)).rejects.toBeInstanceOf(StorageResetError);
    expect(await getMeta('pin-seed')).toBeUndefined();
  });
});
