/**
 * Eternal Notes — IndexedDB Persistence Module
 *
 * Single source of truth for all persistent data.
 * Replaces localStorage for notes/sync/meta.
 *
 * Schema: DB "eternal-notes", version 1
 *   - notes: { noteId (PK), ciphertext, iv, createdAt } + index by-timestamp
 *   - sync:  { noteId (PK), txId?, status, transport, lastError?, updatedAt } + index by-status
 *   - meta:  { key (PK), value }
 */

import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import type { EncryptedNote } from './crypto';

// ─── Types ───────────────────────────────────────────────────────────

export interface SyncRecord {
  noteId: string;
  txId?: string;
  /** 'uploading' with updatedAt > 10 min = stale → retryable */
  status: 'uploading' | 'accepted' | 'confirmed' | 'error';
  transport: 'proxy';
  lastError?: string;
  updatedAt: number;
  /**
   * An 'accepted' TX that polling found dropped/invalid, or pending past the
   * timeout. Re-upload with recheck=true so the server re-verifies and re-posts
   * if the TX is truly gone. Cleared once accepted afresh or confirmed.
   */
  needsRecheck?: boolean;
  /**
   * Server-signed recovery hint from a triple-failure upload (POST ok, but the
   * server couldn't record it). Echoed back on recheck so the server reconciles
   * without a duplicate re-post. Cleared once committed.
   */
  recovery?: { txId: string; postedAt: number; token: string };
  /**
   * PERMANENT local quarantine reason. A plain status:'error' is retryable —
   * the queue re-enqueues it on every poll/reload; a record with terminalError
   * is NEVER enqueued again (no HTTP). 'unsupported_version': the stored
   * EncryptedNote carries a `v` this build cannot serialize — uploading it
   * would risk committing garbage under the permanent noteId idempotency.
   * Still counted by reset-safety (a newer build might read it).
   */
  terminalError?: 'unsupported_version';
}

// ─── Database ────────────────────────────────────────────────────────

const DB_NAME = 'eternal-notes';
const DB_VERSION = 1;

let db: IDBPDatabase | null = null;
let initPromise: Promise<void> | null = null;

export async function initStorage(): Promise<void> {
  // Single-flight guard. On rejection the promise is cleared so the NEXT call
  // retries a clean init instead of sticking to the rejected promise forever.
  initPromise ??= doInit().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function doInit(): Promise<void> {
  if (db) return;

  const database = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Notes store
      const notesStore = database.createObjectStore('notes', { keyPath: 'noteId' });
      notesStore.createIndex('by-timestamp', 'createdAt');

      // Sync state store
      const syncStore = database.createObjectStore('sync', { keyPath: 'noteId' });
      syncStore.createIndex('by-status', 'status');

      // Meta KV store
      database.createObjectStore('meta');
    },
  });

  // Run migration from localStorage (idempotent). `db` is published only after
  // the migration settles, so a failed init never leaves a half-ready handle.
  try {
    await migrateFromLocalStorage(database);
  } catch (err) {
    database.close();
    throw err;
  }
  db = database;
}

export function closeStorage(): void {
  if (db) {
    db.close();
    db = null;
  }
  initPromise = null;
}

/**
 * Last-resort recovery from a broken/corrupted database: close any open handle
 * and DELETE the database entirely, then re-initialize from scratch. Works even
 * when the DB cannot be opened (unlike resetAll, which needs an open DB).
 * Destroys all local data — the caller must warn the user first.
 *
 * A blocked deletion CANNOT be cancelled: once `deleteDatabase` is requested it
 * WILL complete whenever the last other connection closes. So this function
 * never pretends the reset was aborted — on `blocked` it notifies the caller
 * (show "close the other tabs") and keeps WAITING; the promise resolves only
 * after the database was actually deleted and re-initialized.
 */
export async function recoverStorage(opts: { onBlocked?: () => void } = {}): Promise<void> {
  dbGeneration++; // destructive path — same reset-exclusivity token as resetAll
  try { db?.close(); } catch { /* already closed */ }
  db = null;
  initPromise = null;

  await deleteDB(DB_NAME, {
    blocked() {
      opts.onBlocked?.();
    },
  });

  await initStorage();
}

function getDB(): IDBPDatabase {
  if (!db) throw new Error('Storage not initialized. Call initStorage() first.');
  return db;
}

// ─── Notes ───────────────────────────────────────────────────────────

export async function saveNote(note: EncryptedNote): Promise<void> {
  await getDB().put('notes', note);
}

/**
 * Persist a note and its sync record together in a SINGLE transaction, so a
 * crash can never leave a note without its sync state (or vice versa). Used on
 * restore to record the already-on-chain TX as `confirmed`, which stops
 * syncPendingNotes from re-uploading it (and, for v2 notes, mis-serializing).
 */
export async function saveNoteWithSync(
  note: EncryptedNote,
  record: SyncRecord,
): Promise<void> {
  const tx = getDB().transaction(['notes', 'sync'], 'readwrite');
  try {
    await tx.objectStore('notes').put(note);
    await tx.objectStore('sync').put(record);
    await tx.done;
  } catch (e) {
    // Explicitly roll back so a failure on the SECOND put can't leave the first
    // committed (a sync keyPath error throws synchronously and would otherwise
    // let the transaction auto-commit with only the note written).
    tx.done.catch(() => {}); // swallow the resulting abort rejection (we rethrow e)
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/**
 * Merge one successfully-decrypted on-chain note into local storage during
 * restore. ALWAYS upserts BOTH pieces atomically:
 *  - the note payload: the on-chain copy is known-good (it just decrypted),
 *    while the local ciphertext may be corrupted even when the sync record says
 *    'confirmed' — skipping the write would make restore unable to repair it;
 *  - the sync state: a note without a confirmed record (older app versions
 *    wrote none) would be re-queued and could re-upload an already-on-chain
 *    note (duplicate paid TX if the server's old idempotency record is gone).
 * An existing CONFIRMED record is preserved as-is (original txId/updatedAt);
 * anything else is upgraded to confirmed with the on-chain txId.
 *
 * UI visibility is the CALLER's decision (against the currently-decrypted note
 * list, not DB presence — a corrupted-but-present note is invisible in the UI).
 */
export async function mergeRestoredNote(
  note: EncryptedNote,
  txId: string,
  now: number,
): Promise<void> {
  const sync = await getSyncRecord(note.noteId);
  const record: SyncRecord = sync?.status === 'confirmed'
    ? sync
    : { noteId: note.noteId, txId, status: 'confirmed', transport: 'proxy', updatedAt: now };
  await saveNoteWithSync(note, record);
}

/** Get all notes sorted by createdAt DESC (newest first) */
export async function getAllNotes(): Promise<EncryptedNote[]> {
  const all = await getDB().getAllFromIndex('notes', 'by-timestamp');
  return all.reverse() as EncryptedNote[];
}

export async function getNoteById(noteId: string): Promise<EncryptedNote | undefined> {
  return getDB().get('notes', noteId) as Promise<EncryptedNote | undefined>;
}

// ─── Sync Records ────────────────────────────────────────────────────

export async function getSyncRecord(noteId: string): Promise<SyncRecord | undefined> {
  return getDB().get('sync', noteId) as Promise<SyncRecord | undefined>;
}

export async function setSyncRecord(record: SyncRecord): Promise<void> {
  await getDB().put('sync', record);
}

export async function getRecordsByStatus(status: SyncRecord['status']): Promise<SyncRecord[]> {
  return getDB().getAllFromIndex('sync', 'by-status', status) as Promise<SyncRecord[]>;
}

export async function getAllSyncRecords(): Promise<SyncRecord[]> {
  return getDB().getAll('sync') as Promise<SyncRecord[]>;
}

// ─── Meta ────────────────────────────────────────────────────────────

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return getDB().get('meta', key) as Promise<T | undefined>;
}

// ─── v3 upload pause (worker kill switch, client side) ──────────────
//
// Shared, persisted, authoritative across tabs: the queue re-reads this meta
// right before every v3 dispatch. Written ATOMICALLY with the failure
// SyncRecord (commitV3PausedFailure) — separate writes would leave a crash
// window where the error is recorded but the pause is lost, and the next
// unlock bursts the whole v3 backlog again.

export const V3_PAUSE_META_KEY = 'v3-uploads-paused';

export interface V3PauseMeta {
  pausedAt: number;
}

/** Runtime-validated read. 'malformed' = a value is PRESENT but unreadable —
 *  fail closed: treat as paused (clearable via manual retry / valid health). */
export async function readV3PauseMeta(): Promise<V3PauseMeta | 'malformed' | null> {
  const raw = await getMeta<unknown>(V3_PAUSE_META_KEY);
  if (raw === undefined) return null;
  if (typeof raw === 'object' && raw !== null) {
    const pausedAt = (raw as { pausedAt?: unknown }).pausedAt;
    if (typeof pausedAt === 'number' && Number.isSafeInteger(pausedAt) && pausedAt >= 0) {
      return { pausedAt };
    }
  }
  return 'malformed';
}

/**
 * Persist a v3_disabled upload failure AND the pause marker in ONE transaction
 * over sync+meta. Called from the committed part of runUploadAttempt INSTEAD
 * of the final setSyncRecord (never in addition — two writes reopen the crash
 * window this exists to close).
 */
export async function commitV3PausedFailure(
  record: SyncRecord,
  pausedAt: number,
): Promise<void> {
  const tx = getDB().transaction(['sync', 'meta'], 'readwrite');
  try {
    await tx.objectStore('sync').put(record);
    await tx.objectStore('meta').put({ pausedAt } satisfies V3PauseMeta, V3_PAUSE_META_KEY);
    await tx.done;
  } catch (e) {
    // Same rollback discipline as saveNoteWithSync: an error on the SECOND put
    // must not let the transaction auto-commit with only the record written.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/**
 * Conditionally lift the pause (compare-and-delete): the marker is removed only
 * while its pausedAt still equals `expectedPausedAt` — a stale successful
 * /health probe must never erase a NEWER pause set after the probe started.
 * Pass 'any' for the unconditional manual-retry path. Returns whether the
 * marker was removed.
 */
export async function clearV3UploadsPaused(
  expectedPausedAt: number | 'any',
): Promise<boolean> {
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const raw: unknown = await meta.get(V3_PAUSE_META_KEY);
    if (raw === undefined) {
      await tx.done;
      return false;
    }
    if (expectedPausedAt !== 'any') {
      const pausedAt = (typeof raw === 'object' && raw !== null)
        ? (raw as { pausedAt?: unknown }).pausedAt
        : undefined;
      if (pausedAt !== expectedPausedAt) {
        await tx.done;
        return false; // a newer (or malformed) marker — leave it
      }
    }
    await meta.delete(V3_PAUSE_META_KEY);
    await tx.done;
    return true;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await getDB().put('meta', value, key);
}

export async function deleteMeta(key: string): Promise<void> {
  await getDB().delete('meta', key);
}

/**
 * Atomically clear the ENTIRE PIN configuration in ONE transaction over the
 * meta store: delete pin-seed, pin-attempts and pin-locked-until, and reset
 * the auto-lock timeout to null («Никогда»). Removing the PIN — manually or
 * via the 10-strike wipe — must also disable auto-lock (§8), and a failure
 * mid-cleanup must never leave a PARTIAL configuration (say, an auto-lock
 * timeout armed with no PIN to unlock with). Commits fully or not at all.
 */
/** One CONSISTENT snapshot of the PIN/auto-lock configuration: both keys read
 *  inside a single readonly transaction, so the atomic clearPinConfigMeta in
 *  another tab can never be observed half-applied — e.g. pin-seed already
 *  gone while the old timeout still looks armed (round 5 gap). */
export async function getPinConfigMeta(): Promise<{ pinSeed: unknown; autoLockTimeout: unknown }> {
  const tx = getDB().transaction('meta', 'readonly');
  const meta = tx.objectStore('meta');
  const [pinSeed, autoLockTimeout] = await Promise.all([
    meta.get('pin-seed'),
    meta.get('auto-lock-timeout'),
  ]);
  await tx.done;
  return { pinSeed, autoLockTimeout };
}

export async function clearPinConfigMeta(): Promise<void> {
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    await meta.delete('pin-seed');
    await meta.delete('pin-attempts');
    await meta.delete('pin-locked-until');
    await meta.put(null, 'auto-lock-timeout');
    await tx.done;
  } catch (e) {
    // Same rollback discipline as saveNoteWithSync: an error after the first
    // delete must not let the transaction auto-commit half the cleanup.
    tx.done.catch(() => {}); // swallow the resulting abort rejection (we rethrow e)
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

// ─── Migration from localStorage ────────────────────────────────────

/**
 * One-time idempotent migration from localStorage to IndexedDB.
 *
 * Sync state is NOT migrated (see comments below for rationale).
 * All migrated notes get new noteIds (crypto.randomUUID).
 */
async function migrateFromLocalStorage(database: IDBPDatabase): Promise<{ notesMigrated: number }> {
  // 1. Check migration marker
  const migrated = await database.get('meta', 'migration-v1-done');
  if (migrated) return { notesMigrated: 0 };

  // 2. Read from localStorage
  const raw = localStorage.getItem('eternal-notes-encrypted');
  if (!raw) {
    await database.put('meta', true, 'migration-v1-done');
    return { notesMigrated: 0 };
  }

  let oldNotes: Array<{
    ciphertext: string;
    iv: string;
    createdAt: number;
    hash?: string;
  }>;
  try {
    oldNotes = JSON.parse(raw);
  } catch (err) {
    // Do NOT mark migration as done — will retry on next launch.
    // localStorage data preserved for future retry.
    console.error('Migration: failed to parse localStorage data, will retry next launch', err);
    return { notesMigrated: 0 };
  }

  // Validate the SHAPE, not just "is an array": a corrupted record migrated
  // as-is would be undecryptable forever while the marker claims success.
  // On any invalid record: keep localStorage intact, don't set the marker.
  const isValidRecord = (n: unknown): n is { ciphertext: string; iv: string; createdAt: number } =>
    typeof n === 'object' && n !== null &&
    typeof (n as Record<string, unknown>).ciphertext === 'string' &&
    typeof (n as Record<string, unknown>).iv === 'string' &&
    typeof (n as Record<string, unknown>).createdAt === 'number';

  if (!Array.isArray(oldNotes) || !oldNotes.every(isValidRecord)) {
    console.error('Migration: localStorage data has invalid shape, preserved for manual recovery');
    return { notesMigrated: 0 };
  }

  let count = 0;

  // 3. Write to IndexedDB in a single transaction
  const tx = database.transaction(['notes', 'meta'], 'readwrite');

  for (const n of oldNotes) {
    const noteId = crypto.randomUUID();
    // hash field is NOT migrated (R1). Only data needed for decrypt.
    const migratedNote: EncryptedNote = {
      noteId,
      ciphertext: n.ciphertext,
      iv: n.iv,
      createdAt: n.createdAt,
    };
    await tx.objectStore('notes').put(migratedNote);
    count++;
  }

  // 4. Migrate meta flags
  if (localStorage.getItem('eternal-notes-init') === 'true') {
    await tx.objectStore('meta').put(true, 'init');
  }
  if (localStorage.getItem('eternal-notes-ar-enabled') === 'true') {
    await tx.objectStore('meta').put(true, 'ar-enabled');
  }

  // 5. Sync state is NOT migrated.
  //    Reason: old notes were uploaded under old ownerHash = SHA-256(seed[32:64]),
  //    new ownerHash = SHA-256(Ed25519_publicKey). Old TX on chain are unreachable
  //    via new ownerHash (different GraphQL query).
  //    Leaving without SyncRecord = implicitly pending → will be re-uploaded via proxy.
  //    Cost: ~$0.001 per note. Old chain copies are harmless orphaned data.
  try {
    localStorage.removeItem('eternal-notes-ar-synced');
  } catch { /* skip */ }

  // 6. Write migration marker (same transaction)
  await tx.objectStore('meta').put(true, 'migration-v1-done');
  await tx.done;

  // 7. Clear localStorage ONLY after successful commit
  localStorage.removeItem('eternal-notes-encrypted');
  localStorage.removeItem('eternal-notes-init');
  localStorage.removeItem('eternal-notes-ar-enabled');
  localStorage.removeItem('eternal-notes-ar-synced');

  return { notesMigrated: count };
}

// ─── Reset ───────────────────────────────────────────────────────────

// DB generation — the reset-exclusivity token (P1 review). Every background
// flow that persists vault data (uploads, restore merges, poll transitions,
// note saves) captures the generation when it starts and re-checks it
// SYNCHRONOUSLY right before creating its write transaction. The two possible
// interleavings are both clean:
//  - the flow's check ran before the reset bumped the counter → the flow's
//    transaction was also CREATED before the reset's clear transaction, and
//    IndexedDB serializes readwrite transactions per store in creation order,
//    so the clear wipes that write;
//  - the reset bumped first → the check fails and the write is skipped.
// There is no TOCTOU window between check and transaction creation: both are
// synchronous in single-threaded JS. Cross-tab, the reset broadcasts a
// 'reset' message and the receiving tab bumps its OWN generation
// (noteExternalReset) — the residual window is broadcast delivery latency
// only (milliseconds), instead of an entire in-flight upload.
let dbGeneration = 0;

export function getDbGeneration(): number {
  return dbGeneration;
}

/** Another tab announced a destructive reset: invalidate every write this tab
 *  might still commit for the vault that is being destroyed. */
export function noteExternalReset(): void {
  dbGeneration++;
}

/** Clear ALL IndexedDB data (notes, sync, meta). Used for app reset. */
export async function resetAll(): Promise<void> {
  // Bump FIRST: any generation check that runs after this line refuses to
  // write; any write whose check passed earlier lost the transaction-order
  // race and gets cleared below.
  dbGeneration++;
  const database = getDB();
  const tx = database.transaction(['notes', 'sync', 'meta'], 'readwrite');
  await tx.objectStore('notes').clear();
  await tx.objectStore('sync').clear();
  await tx.objectStore('meta').clear();
  await tx.done;
}
