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
  DB_VERSION,
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

  it('REPAIRS a corrupted local payload and keeps the confirmed record naming the SAME tx', async () => {
    // Local ciphertext rotted (undecryptable) but sync says confirmed — restore
    // replaces the payload with the known-good on-chain copy and keeps the
    // ORIGINAL confirmed record, because it names the transaction being merged.
    // A DIFFERENT txId no longer survives (D12: the pair moves together) —
    // both directions live in client-floor.d12.test.ts.
    await saveNoteWithSync({ noteId: 'm3', ciphertext: 'CORRUPTED', iv: 'iv', createdAt: 1 },
      { noteId: 'm3', kind: 'note', txId: 'tx-old', status: 'confirmed', transport: 'proxy', updatedAt: 1 });

    await mergeRestoredNote({ noteId: 'm3', ciphertext: 'GOOD-ONCHAIN', iv: 'iv2', createdAt: 1 }, 'tx-old', 100, getDbGeneration());

    expect((await getNoteById('m3'))?.ciphertext).toBe('GOOD-ONCHAIN'); // payload repaired
    const rec = (await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm3');
    expect(rec?.txId).toBe('tx-old');
    expect(rec?.updatedAt).toBe(1); // original record preserved as-is
  });

  it('upgrades a non-terminal sync record (e.g. error) to confirmed', async () => {
    await saveNoteWithSync({ ...NOTE, noteId: 'm4' },
      { noteId: 'm4', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 1 });
    await mergeRestoredNote({ ...NOTE, noteId: 'm4' }, 'tx-m4', 100, getDbGeneration());
    expect((await getRecordsByStatus('confirmed')).find(r => r.noteId === 'm4')?.txId).toBe('tx-m4');
  });

  it('a reset racing the merge resurrects nothing', async () => {
    // The window this used to guard against no longer exists: the merge reads
    // the row INSIDE the transaction it writes to, and `assertDbGeneration`
    // sits immediately before `transaction(...)` with nothing awaited between
    // them. A reset therefore either lands entirely before the merge starts
    // (next test) or entirely after its transaction was created — and IndexedDB
    // runs resetAll's clear AFTER that transaction, so the write is wiped.
    //
    // The invariant is about DATA, not about which mechanism fired.
    const gen = getDbGeneration();
    const merge = mergeRestoredNote({ ...NOTE, noteId: 'm5' }, 'tx-m5', 100, gen)
      .then(() => null, (e: unknown) => e);
    await resetAll();

    expect(await getNoteById('m5')).toBeUndefined();
    expect(await getAllSyncRecords()).toHaveLength(0);
    await merge; // never an unhandled rejection, whichever way it went
  });

  it('a merge started AFTER a reset is refused by the generation token', async () => {
    const staleGen = getDbGeneration();
    await resetAll(); // bumps the generation

    await expect(mergeRestoredNote({ ...NOTE, noteId: 'm6' }, 'tx-m6', 100, staleGen))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getNoteById('m6')).toBeUndefined();
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
    const otherTab = await openDB('eternal-notes', DB_VERSION);

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
  /** The row this attempt owns. The record half is attempt-scoped (D14a), so
   *  every case that expects a WRITE has to start from a row stamped with the
   *  attemptId it commits under. */
  const owning = (noteId: string, attemptId: string): SyncRecord => ({
    noteId, kind: 'note', status: 'uploading', transport: 'proxy', updatedAt: 1, attemptId,
  });

  it('a successful commit writes the SyncRecord AND the pause marker together', async () => {
    const record: SyncRecord = {
      noteId: 'p1', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 5,
      lastError: 'v3_uploads_disabled',
    };
    await setSyncRecord(owning('p1', 'A1'));
    await commitV3PausedFailure('p1', 'A1', () => record, 12345);
    expect(await getSyncRecord('p1')).toEqual(record);
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 12345 });
  });

  it('a row owned by ANOTHER attempt is NOT overwritten — but the pause marker IS set', async () => {
    // The late answer of a hung attempt: someone else has taken the row over.
    // The record must not move, yet the worker's kill switch is real and the
    // marker is version-global state, not state about this attempt.
    const takenOver = owning('p1x', 'A-other');
    await setSyncRecord(takenOver);
    await commitV3PausedFailure('p1x', 'A-mine', () => ({
      noteId: 'p1x', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 9,
    }), 555);
    expect(await getSyncRecord('p1x')).toEqual(takenOver);
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 555 });
  });

  it('preserves txId/recovery/needsRecheck fields on the committed record', async () => {
    const record: SyncRecord = {
      noteId: 'p2', kind: 'note', txId: 'TX-KEEP', status: 'accepted', transport: 'proxy',
      updatedAt: 5, needsRecheck: true,
      recovery: { txId: 'TX-KEEP', postedAt: 1, token: 'tok' },
    };
    await setSyncRecord(owning('p2', 'A2'));
    await commitV3PausedFailure('p2', 'A2', () => record, 1);
    const stored = await getSyncRecord('p2');
    expect(stored?.txId).toBe('TX-KEEP');
    expect(stored?.needsRecheck).toBe(true);
    expect(stored?.recovery).toEqual(record.recovery);
  });

  it('the builder receives the FRESH row from inside the transaction', async () => {
    const prior: SyncRecord = {
      noteId: 'p2f', kind: 'note', txId: 'TX-FRESH', status: 'uploading',
      transport: 'proxy', updatedAt: 5, attemptId: 'A3',
    };
    await setSyncRecord(prior);
    await commitV3PausedFailure('p2f', 'A3', fresh => ({
      noteId: 'p2f', kind: 'note', txId: fresh?.txId, status: 'error',
      transport: 'proxy', updatedAt: 6,
    }), 2);
    expect((await getSyncRecord('p2f'))?.txId).toBe('TX-FRESH');
  });

  it('a quarantined row is NOT overwritten — but the pause marker IS set', async () => {
    const quarantined: SyncRecord = {
      noteId: 'p2q', kind: 'note', txId: 'TX-Q', status: 'error', transport: 'proxy',
      updatedAt: 5, terminalError: 'recovery_invalidated',
    };
    await setSyncRecord(quarantined);
    await commitV3PausedFailure('p2q', 'A4', () => ({
      noteId: 'p2q', kind: 'note', status: 'error', transport: 'proxy', updatedAt: 9,
    }), 42);
    // The record half is terminal-preserving (monotone quarantine)…
    expect(await getSyncRecord('p2q')).toEqual(quarantined);
    // …but the pause is version-global state about the WORKER, and it stands.
    expect(await readV3PauseMeta()).toEqual({ pausedAt: 42 });
  });

  it('aborts BOTH writes when the record is invalid (rollback, no half-commit)', async () => {
    // sync store keyPath is noteId — a record without it fails the first put.
    const bad = { kind: 'note', status: 'error', transport: 'proxy', updatedAt: 5 } as unknown as SyncRecord;
    await setSyncRecord(owning('missing-key', 'A5'));
    await expect(commitV3PausedFailure('missing-key', 'A5', () => bad, 777)).rejects.toBeDefined();
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

// getDbGeneration уже импортирован в шапке файла; дублировать его здесь нельзя:
// парсер vitest 4 (oxc) считает повторное объявление ошибкой трансформации и
// роняет ВЕСЬ файл как suite-ошибку (vitest 3 дубль терпел).
import { noteExternalReset } from './storage';

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

// ─── Main PIN unlock commits (stage P) ──────────────────────────────

import {
  commitPinUnlockFailure,
  commitPinUnlockSuccess,
  commitPinSeedRewrap,
  pinSeedEquals,
  mainPinLockSeconds,
  MAIN_MAX_PIN_ATTEMPTS,
} from './storage';

/** The pinned v1 Argon2id profile — the only one assertValidPinBlob accepts. */
const ARGON2_V1 = { iterations: 3, memorySize: 65_536, parallelism: 1, hashLength: 32 };

const argon2Blob = (ciphertext: string): PinEncryptedSeed => ({
  ciphertext, iv: 'iv', salt: 's', kdf: 'argon2id', v: 1, argon2: { ...ARGON2_V1 },
});
/** Pre-Argon2id blob (no `kdf` field) — what the re-wrap path upgrades. */
const legacyBlob = (ciphertext: string): PinEncryptedSeed => ({ ciphertext, iv: 'iv', salt: 's' });

describe('pinSeedEquals (the ONE ownership check for the main PIN)', () => {
  it('is true for a byte-identical blob read back from storage', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    expect(pinSeedEquals(await getMeta('pin-seed'), argon2Blob('ctA'))).toBe(true);
  });

  it('is false when ciphertext, iv or salt differ', () => {
    expect(pinSeedEquals(argon2Blob('ctA'), argon2Blob('ctB'))).toBe(false);
    expect(pinSeedEquals(argon2Blob('ct'), { ...argon2Blob('ct'), iv: 'other' })).toBe(false);
    expect(pinSeedEquals(argon2Blob('ct'), { ...argon2Blob('ct'), salt: 'other' })).toBe(false);
  });

  it('is false when ONLY the kdf differs', () => {
    expect(pinSeedEquals(argon2Blob('ct'), { ...argon2Blob('ct'), kdf: 'pbkdf2' })).toBe(false);
  });

  it('is false when ONLY the version differs', () => {
    expect(pinSeedEquals(argon2Blob('ct'), { ...argon2Blob('ct'), v: 2 })).toBe(false);
  });

  it('is false when ONLY one Argon2 parameter differs — every field is normative', () => {
    for (const field of ['iterations', 'memorySize', 'parallelism', 'hashLength'] as const) {
      const tweaked = { ...argon2Blob('ct'), argon2: { ...ARGON2_V1, [field]: ARGON2_V1[field] + 1 } };
      expect(pinSeedEquals(argon2Blob('ct'), tweaked)).toBe(false);
    }
  });

  it('is false when one side carries an Argon2 profile and the other does not', () => {
    expect(pinSeedEquals(argon2Blob('ct'), legacyBlob('ct'))).toBe(false);
    expect(pinSeedEquals(legacyBlob('ct'), argon2Blob('ct'))).toBe(false);
  });

  it('treats two legacy blobs with the same fields as equal', () => {
    expect(pinSeedEquals(legacyBlob('ct'), legacyBlob('ct'))).toBe(true);
  });

  it('is false against undefined — "no PIN configured" owns nothing', () => {
    expect(pinSeedEquals(undefined, argon2Blob('ct'))).toBe(false);
    expect(pinSeedEquals(argon2Blob('ct'), undefined)).toBe(false);
    expect(pinSeedEquals(undefined, undefined)).toBe(false);
  });
});

describe('commitPinUnlockFailure (atomic metering + lockout + wipe)', () => {
  it('counts the attempt in ONE transaction — no lockout below the threshold', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out).toEqual({ outcome: 'committed', attempts: 1, lockedUntil: null, wiped: false });
    expect(await getMeta('pin-attempts')).toBe(1);
    expect(await getMeta('pin-locked-until')).toBeUndefined();
  });

  it('applies the progressive lockout schedule', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    await setMeta('pin-attempts', 3);
    const before = Date.now();
    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out.attempts).toBe(4);
    expect(mainPinLockSeconds(4)).toBe(30);
    expect(out.lockedUntil ?? 0).toBeGreaterThanOrEqual(before + 30_000);
    expect(await getMeta('pin-locked-until')).toBe(out.lockedUntil);
  });

  it('two concurrent failures BOTH count — the increment is inside the transaction', async () => {
    // The two-step getMeta+setMeta this replaced lost one of them: both reads
    // returned the same number. IndexedDB serializes readwrite transactions
    // per store, so re-reading inside the transaction cannot.
    await setMeta('pin-seed', argon2Blob('ctA'));
    const gen = getDbGeneration();
    await Promise.all([
      commitPinUnlockFailure(argon2Blob('ctA'), gen),
      commitPinUnlockFailure(argon2Blob('ctA'), gen),
    ]);
    expect(await getMeta('pin-attempts')).toBe(2);
  });

  it('the 10th strike wipes the WHOLE configuration in the same transaction', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    await setMeta('pin-attempts', MAIN_MAX_PIN_ATTEMPTS - 1);
    await setMeta('pin-locked-until', Date.now() + 1_800_000);
    await setMeta('auto-lock-timeout', 300);

    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out).toEqual({
      outcome: 'committed', attempts: MAIN_MAX_PIN_ATTEMPTS, lockedUntil: null, wiped: true,
    });
    expect(await getMeta('pin-seed')).toBeUndefined();
    // No observable "attempts = 10": the counter is gone in the same commit.
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    expect(await getMeta('auto-lock-timeout')).toBeNull();
  });

  it('a reset during the (slow) KDF does NOT resurrect attempts or a lockout', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    const stale = getDbGeneration();
    await resetAll(); // «Удалить всё» landed while Argon2 was running
    await expect(commitPinUnlockFailure(argon2Blob('ctA'), stale))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    expect(await getMeta('pin-seed')).toBeUndefined();
  });

  it('a PIN replaced by another tab during the KDF: config-changed, ZERO writes', async () => {
    await setMeta('pin-seed', argon2Blob('ctB')); // tab B already wrote its blob
    await setMeta('pin-attempts', 2);             // …and its own metering
    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out.outcome).toBe('config-changed');
    expect(out.attempts).toBe(0);
    expect(out.wiped).toBe(false);
    expect(await getMeta('pin-attempts')).toBe(2);      // NOT metered
    expect(await getMeta('pin-locked-until')).toBeUndefined();
    expect(await getMeta('pin-seed')).toEqual(argon2Blob('ctB')); // NOT wiped
  });

  it('does not WIPE a foreign configuration on what would have been the 10th strike', async () => {
    await setMeta('pin-seed', argon2Blob('ctB'));
    await setMeta('pin-attempts', MAIN_MAX_PIN_ATTEMPTS - 1);
    await setMeta('auto-lock-timeout', 300);
    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out.outcome).toBe('config-changed');
    expect(await getMeta('pin-seed')).toEqual(argon2Blob('ctB'));
    expect(await getMeta('auto-lock-timeout')).toBe(300);
  });

  it('a PIN REMOVED by another tab during the KDF: config-changed, nothing written', async () => {
    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out.outcome).toBe('config-changed');
    expect(await getMeta('pin-attempts')).toBeUndefined();
  });
});

describe('commitPinUnlockSuccess', () => {
  it('clears the metering of the configuration that was proved', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    await setMeta('pin-attempts', 4);
    await setMeta('pin-locked-until', Date.now() + 30_000);
    expect(await commitPinUnlockSuccess(argon2Blob('ctA'), getDbGeneration())).toBe('committed');
    expect(await getMeta('pin-attempts')).toBeUndefined();
    expect(await getMeta('pin-locked-until')).toBeUndefined();
  });

  it('leaves a foreign configuration\'s counters ALONE (the vault still opens)', async () => {
    await setMeta('pin-seed', argon2Blob('ctB'));
    await setMeta('pin-attempts', 4);
    const lockedUntil = Date.now() + 30_000;
    await setMeta('pin-locked-until', lockedUntil);
    expect(await commitPinUnlockSuccess(argon2Blob('ctA'), getDbGeneration())).toBe('config-changed');
    expect(await getMeta('pin-attempts')).toBe(4);
    expect(await getMeta('pin-locked-until')).toBe(lockedUntil);
  });

  it('refuses after a reset', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitPinUnlockSuccess(argon2Blob('ctA'), stale))
      .rejects.toBeInstanceOf(StorageResetError);
  });
});

describe('commitPinSeedRewrap (legacy → Argon2id)', () => {
  it('replaces the exact legacy blob that was unwrapped', async () => {
    await setMeta('pin-seed', legacyBlob('legacyA'));
    expect(await commitPinSeedRewrap(legacyBlob('legacyA'), argon2Blob('newA'), getDbGeneration()))
      .toBe('committed');
    expect(await getMeta('pin-seed')).toEqual(argon2Blob('newA'));
  });

  it('legacy A replaced by legacy B: the re-wrap of A does NOT overwrite B', async () => {
    // "Still legacy" would have passed here — and silently re-encrypted B's
    // configuration under A's (old) PIN.
    await setMeta('pin-seed', legacyBlob('legacyB'));
    expect(await commitPinSeedRewrap(legacyBlob('legacyA'), argon2Blob('newA'), getDbGeneration()))
      .toBe('config-changed');
    expect(await getMeta('pin-seed')).toEqual(legacyBlob('legacyB'));
  });

  it('a reset during the re-wrap does NOT resurrect pin-seed', async () => {
    await setMeta('pin-seed', legacyBlob('legacyA'));
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitPinSeedRewrap(legacyBlob('legacyA'), argon2Blob('newA'), stale))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getMeta('pin-seed')).toBeUndefined();
  });

  it('writes nothing once the PIN was removed by another tab', async () => {
    expect(await commitPinSeedRewrap(legacyBlob('legacyA'), argon2Blob('newA'), getDbGeneration()))
      .toBe('config-changed');
    expect(await getMeta('pin-seed')).toBeUndefined();
  });
});

// ─── Quick unlock: atomic reader + conditional commits (stage 1) ─────

import {
  readClientConfigSnapshot,
  commitQuickUnlockSeedWrite,
  commitQuickUnlockSeedDelete,
  commitQuickUnlockSeedDeleteIfMatches,
  commitQuickUnlockSeedCleanup,
} from './storage';
import {
  QUICK_UNLOCK_META_KEY,
  parseQuickUnlockRecord,
  bytesToBase64Url,
  type QuickUnlockRecord,
} from './quick-unlock';
import { bufferToBase64 } from './crypto';

const qb64 = (n: number, fill = 1) => bufferToBase64(new Uint8Array(n).fill(fill));
const VAULT_PK = qb64(32, 9);
const OTHER_PK = qb64(32, 8);

function quickRecord(over: Partial<QuickUnlockRecord> = {}): QuickUnlockRecord {
  return {
    v: 1,
    credentialId: bytesToBase64Url(new Uint8Array(32).fill(1)),
    prfSalt: qb64(32, 2),
    hkdfSalt: qb64(32, 3),
    iv: qb64(12, 4),
    ciphertext: qb64(48, 5),
    pk: VAULT_PK,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** A configured vault: PIN set and the identity bound. */
async function configuredVault(): Promise<void> {
  await setMeta('pin-seed', argon2Blob('ctA'));
  await setMeta('vault-public-key', VAULT_PK);
}

describe('readClientConfigSnapshot (ONE transaction, four keys)', () => {
  it('returns all four values and the record verdict together', async () => {
    await configuredVault();
    await setMeta('auto-lock-timeout', 300);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());

    const snap = await readClientConfigSnapshot();
    expect(snap.pinSeed).toEqual(argon2Blob('ctA'));
    expect(snap.autoLockTimeout).toBe(300);
    expect(snap.vaultPublicKey).toBe(VAULT_PK);
    expect(snap.quickUnlock).toEqual({ kind: 'valid', record: quickRecord() });
  });

  it('reports an empty configuration without inventing one', async () => {
    const snap = await readClientConfigSnapshot();
    expect(snap).toEqual({
      pinSeed: undefined,
      autoLockTimeout: undefined,
      vaultPublicKey: undefined,
      quickUnlock: { kind: 'none' },
    });
  });

  it('never shows a HALF-APPLIED wipe: PIN gone AND threshold reset AND record gone', async () => {
    await configuredVault();
    await setMeta('auto-lock-timeout', 1800);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());

    await clearPinConfigMeta(); // the atomic wipe another tab may run

    const snap = await readClientConfigSnapshot();
    expect(snap.pinSeed).toBeUndefined();
    expect(snap.autoLockTimeout).toBeNull();
    expect(snap.quickUnlock).toEqual({ kind: 'none' });
  });

  it('a record left by an OLDER client (PIN gone) reads as stale, not valid', async () => {
    await setMeta('vault-public-key', VAULT_PK);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord()); // no pin-seed at all
    expect((await readClientConfigSnapshot()).quickUnlock).toEqual({ kind: 'stale', reason: 'no-pin' });
  });

  it('a record from ANOTHER vault reads as stale', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord({ pk: OTHER_PK }));
    expect((await readClientConfigSnapshot()).quickUnlock).toEqual({ kind: 'stale', reason: 'foreign-vault' });
  });
});

describe('clearPinConfigMeta removes the quick-unlock record', () => {
  it('deletes it in the SAME transaction as the PIN', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    await clearPinConfigMeta();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('the 10-strike wipe takes it too — one transaction, no window', async () => {
    await setMeta('pin-seed', argon2Blob('ctA'));
    await setMeta('vault-public-key', VAULT_PK);
    await setMeta('pin-attempts', MAIN_MAX_PIN_ATTEMPTS - 1);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());

    const out = await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration());
    expect(out.wiped).toBe(true);
    expect(await getMeta('pin-seed')).toBeUndefined();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('leaves it ALONE when the wipe is refused (foreign configuration)', async () => {
    await setMeta('pin-seed', argon2Blob('ctB')); // another tab's PIN
    await setMeta('vault-public-key', VAULT_PK);
    await setMeta('pin-attempts', MAIN_MAX_PIN_ATTEMPTS - 1);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());

    expect((await commitPinUnlockFailure(argon2Blob('ctA'), getDbGeneration())).outcome).toBe('config-changed');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(quickRecord());
  });
});

describe('resetAll clears the quick-unlock record', () => {
  it('the whole meta store goes, so nothing survives a reset', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    await resetAll();
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });
});

describe('commitQuickUnlockSeedWrite (conditional, first-writer-wins)', () => {
  it('writes when the vault is configured and nothing is set up yet', async () => {
    await configuredVault();
    expect(await commitQuickUnlockSeedWrite(quickRecord(), getDbGeneration())).toBe('written');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(quickRecord());
  });

  it('refuses when the PIN was removed between the snapshot and the commit', async () => {
    await setMeta('vault-public-key', VAULT_PK); // no pin-seed
    expect(await commitQuickUnlockSeedWrite(quickRecord(), getDbGeneration())).toBe('no-pin');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('refuses a record bound to a DIFFERENT vault', async () => {
    await configuredVault();
    expect(await commitQuickUnlockSeedWrite(quickRecord({ pk: OTHER_PK }), getDbGeneration()))
      .toBe('foreign-vault');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('TWO concurrent setups: the first wins, the second does NOT clobber it', async () => {
    await configuredVault();
    const first = quickRecord({ credentialId: bytesToBase64Url(new Uint8Array(32).fill(1)) });
    const second = quickRecord({ credentialId: bytesToBase64Url(new Uint8Array(32).fill(2)) });
    const gen = getDbGeneration();

    const outcomes = await Promise.all([
      commitQuickUnlockSeedWrite(first, gen),
      commitQuickUnlockSeedWrite(second, gen),
    ]);

    expect(outcomes.filter(o => o === 'written')).toHaveLength(1);
    expect(outcomes.filter(o => o === 'already-configured')).toHaveLength(1);
    // Whichever won, the stored record is intact — not a mix of the two.
    const stored = parseQuickUnlockRecord(await getMeta(QUICK_UNLOCK_META_KEY));
    expect([first.credentialId, second.credentialId]).toContain(stored?.credentialId);
  });

  it('OVERWRITES a void record — a stale one is nobody’s working setup', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, { v: 2, junk: true }); // unparseable
    expect(await commitQuickUnlockSeedWrite(quickRecord(), getDbGeneration())).toBe('written');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(quickRecord());
  });

  it('refuses after a reset in another tab', async () => {
    await configuredVault();
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitQuickUnlockSeedWrite(quickRecord(), stale))
      .rejects.toBeInstanceOf(StorageResetError);
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });
});

describe('commitQuickUnlockSeedDelete (unconditional, manual only)', () => {
  it('removes whatever is there', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    await commitQuickUnlockSeedDelete(getDbGeneration());
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('is idempotent and touches nothing else', async () => {
    await configuredVault();
    await commitQuickUnlockSeedDelete(getDbGeneration());
    expect(await getMeta('pin-seed')).toEqual(argon2Blob('ctA'));
    expect(await getMeta('vault-public-key')).toBe(VAULT_PK);
  });

  it('refuses after a reset', async () => {
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitQuickUnlockSeedDelete(stale)).rejects.toBeInstanceOf(StorageResetError);
  });
});

describe('commitQuickUnlockSeedDeleteIfMatches (conditional)', () => {
  it('deletes the exact record it was given', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    expect(await commitQuickUnlockSeedDeleteIfMatches(quickRecord(), getDbGeneration())).toBe('deleted');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it("returns 'changed' and KEEPS a record another tab replaced meanwhile", async () => {
    // The whole point: while this tab waited on the system sheet, tab B could
    // remove the record and set up a NEW one. dbGeneration does not move for
    // that, so a mismatch computed against the old snapshot must not delete
    // the new, working record.
    await configuredVault();
    const replacement = quickRecord({ credentialId: bytesToBase64Url(new Uint8Array(32).fill(7)) });
    await setMeta(QUICK_UNLOCK_META_KEY, replacement);

    expect(await commitQuickUnlockSeedDeleteIfMatches(quickRecord(), getDbGeneration())).toBe('changed');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(replacement);
  });

  it("returns 'absent' when the record is already gone", async () => {
    await configuredVault();
    expect(await commitQuickUnlockSeedDeleteIfMatches(quickRecord(), getDbGeneration())).toBe('absent');
  });

  it("treats an unparseable current record as 'changed', not as a match", async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, { v: 2 });
    expect(await commitQuickUnlockSeedDeleteIfMatches(quickRecord(), getDbGeneration())).toBe('changed');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual({ v: 2 });
  });
});

describe('commitQuickUnlockSeedCleanup (re-checks inside its own transaction)', () => {
  it('deletes an orphaned record (PIN gone)', async () => {
    await setMeta('vault-public-key', VAULT_PK);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    expect(await commitQuickUnlockSeedCleanup(getDbGeneration())).toBe('deleted');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toBeUndefined();
  });

  it('deletes a foreign-vault record', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord({ pk: OTHER_PK }));
    expect(await commitQuickUnlockSeedCleanup(getDbGeneration())).toBe('deleted');
  });

  it('deletes an unparseable record', async () => {
    await configuredVault();
    await setMeta(QUICK_UNLOCK_META_KEY, { nonsense: true });
    expect(await commitQuickUnlockSeedCleanup(getDbGeneration())).toBe('deleted');
  });

  it('a PIN that REAPPEARED between the snapshot and the cleanup CANCELS the delete', async () => {
    // The readonly snapshot said «orphaned»; by the time we got here another
    // tab had configured a PIN again, which makes the record valid. Deleting
    // it now would destroy a working setup.
    await setMeta('vault-public-key', VAULT_PK);
    await setMeta(QUICK_UNLOCK_META_KEY, quickRecord());
    await setMeta('pin-seed', argon2Blob('ctA')); // reappeared

    expect(await commitQuickUnlockSeedCleanup(getDbGeneration())).toBe('kept');
    expect(await getMeta(QUICK_UNLOCK_META_KEY)).toEqual(quickRecord());
  });

  it("returns 'kept' when there is nothing to clean up", async () => {
    await configuredVault();
    expect(await commitQuickUnlockSeedCleanup(getDbGeneration())).toBe('kept');
  });

  it('refuses after a reset', async () => {
    const stale = getDbGeneration();
    await resetAll();
    await expect(commitQuickUnlockSeedCleanup(stale)).rejects.toBeInstanceOf(StorageResetError);
  });
});

describe('commitGlobalPausedFailure — its OWN key, not the version ones', () => {
  it('writes only the global marker', async () => {
    const {
      commitGlobalPausedFailure, readGlobalPauseMeta, readV3PauseMeta, readV4PauseMeta,
    } = await import('./storage');
    const record: SyncRecord = {
      noteId: 'g1', kind: 'note', status: 'error', transport: 'proxy',
      updatedAt: 1, needsRecheck: false, lastError: 'uploads_disabled',
    };
    await commitGlobalPausedFailure('g1', 'G1', () => record, 4242);

    expect(await readGlobalPauseMeta()).toEqual({ pausedAt: 4242 });
    // The version markers stay untouched: they gate only v3/safebox items, so
    // writing them instead would have left v1/v2 uploading against a worker
    // that refuses everything.
    expect(await readV3PauseMeta()).toBeNull();
    expect(await readV4PauseMeta()).toBeNull();
  });

  it('is lifted by compare-and-delete, like the version markers', async () => {
    const { commitGlobalPausedFailure, clearGlobalUploadsPaused, readGlobalPauseMeta } =
      await import('./storage');
    const record: SyncRecord = {
      noteId: 'g2', kind: 'note', status: 'error', transport: 'proxy',
      updatedAt: 1, needsRecheck: false,
    };
    await commitGlobalPausedFailure('g2', 'G2', () => record, 100);
    // A stale probe must never erase a NEWER pause.
    expect(await clearGlobalUploadsPaused(99)).toBe(false);
    expect(await readGlobalPauseMeta()).toEqual({ pausedAt: 100 });
    expect(await clearGlobalUploadsPaused(100)).toBe(true);
    expect(await readGlobalPauseMeta()).toBeNull();
  });
});
