/**
 * Eternal Notes — IndexedDB Persistence Module
 *
 * Single source of truth for all persistent data.
 * Replaces localStorage for notes/sync/meta.
 *
 * Schema: DB "eternal-notes", version 3
 *   - notes:   { noteId (PK), ciphertext, iv, createdAt } + index by-timestamp
 *   - sync:    { noteId (PK), kind, txId?, status, transport, lastError?, updatedAt } + index by-status
 *   - meta:    { key (PK), value }
 *   - safebox: { entryId (PK), metaCiphertext, metaIv, secretCiphertext,
 *                secretIv, createdAt, v } + index by-timestamp        (v2)
 *   v3 adds no store and no index — only the additive `attemptId` field on
 *   `sync` rows (D14a). It exists to lock older builds out; see DB_VERSION.
 */

import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import type { EncryptedNote, EncryptedSafeboxEntry, PinEncryptedSeed } from './crypto';
import { SafeboxPinUnavailableError, assertValidPinBlob } from './crypto';
// Runtime import is cycle-safe: sync-transitions imports ONLY types from here.
import { toUploading } from './sync-transitions';
// Cycle-safe as well: publication-equivalent imports arweave + crypto, never
// storage. The payload-CAS below asks exactly the question this module answers
// — «would these two records publish identically?» — so it must not grow a
// second, subtly different comparison of its own.
import { publicationEquivalent, type PublicationSubject } from './publication-equivalent';
import {
  QUICK_UNLOCK_META_KEY,
  judgeQuickUnlock,
  parseQuickUnlockRecord,
  quickUnlockBelongsToVault,
  quickUnlockRecordEquals,
  type QuickUnlockRecord,
  type QuickUnlockVerdict,
} from './quick-unlock';

// ─── Types ───────────────────────────────────────────────────────────

export interface SyncRecord {
  /** Primary key. For safebox records this holds the entryId (one id space —
   *  both are UUIDv8 — so ONE sync store and ONE status map serve both). */
  noteId: string;
  /**
   * WHICH store the record belongs to. Required on every transition so a
   * from-scratch reconstruction cannot silently drop it (the transitions in
   * sync-transitions.ts build a NEW object each time). Legacy rows written
   * before v4 have no field and are normalized to 'note' at the READ boundary.
   * Aggregate counters are computed per kind — mixing them drives the notes
   * «синхронизировано X из N» counter negative.
   */
  kind: 'note' | 'safebox';
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
   * Identity of the upload attempt that owns this 'uploading' row (D14a).
   *
   * Payload-CAS closes the window BEFORE the request; this closes the one
   * AFTER it. The proxy POST has no timeout by design, so an attempt can
   * outlive the ten-minute stale threshold, and its answer would otherwise be
   * applied unconditionally — writing that attempt's txId next to bytes some
   * other writer has replaced in the meantime.
   *
   * Written by beginUploadUnlessTerminal, checked by
   * commitUploadResultIfAttempt, and NOT carried by any other transition: a
   * row that left 'uploading' has no owner, so a late answer finds no match
   * and is dropped. Additive — older builds ignore the field, which is exactly
   * why a rollback below the release that introduced it is forbidden (they
   * would apply the late answer).
   */
  attemptId?: string;
  /**
   * PERMANENT local quarantine reason. A plain status:'error' is retryable —
   * the queue re-enqueues it on every poll/reload; a record with terminalError
   * is NEVER enqueued again (no HTTP). 'unsupported_version': the stored
   * record carries a `v` this build cannot serialize — uploading it would risk
   * committing garbage under the permanent noteId idempotency.
   * 'malformed_record': the stored row failed runtime validation right before
   * serialization (IndexedDB is an untrusted boundary) — retrying can only
   * ever produce the same rejection.
   * 'recovery_invalidated': the SERVER rejected the signed recovery proof
   * (400 {code:'recovery_invalid'} — e.g. the HMAC secret was rotated after a
   * compromise). The local row is intact — txId and the recovery hint are
   * preserved as evidence — but every future recheck is a guaranteed failure,
   * so the record is quarantined instead of polling forever.
   *
   * MONOTONE at the record boundary: no ordinary writer may CLEAR an
   * established terminalError (see beginUploadUnlessTerminal /
   * commitSyncUnlessTerminal). The only proof-bearing exception is the
   * seed-restore path (saveNoteWithSync / saveSafeboxEntryWithSync), which
   * clears 'recovery_invalidated' ONLY — by the time it writes, the restore
   * pipeline has established a trusted owner, an authenticated envelope and
   * an on-chain transaction, which is exactly the publication proof the
   * quarantine was waiting for. Other reasons survive even restore.
   * Still counted by reset-safety (a newer build might read it).
   */
  terminalError?: 'unsupported_version' | 'malformed_record' | 'recovery_invalidated';
}

/**
 * Normalize a row read from IndexedDB, at the READ boundary, so no downstream
 * code has to cope with the optional field.
 *
 * Two DIFFERENT cases, deliberately not collapsed:
 *  - `kind` ABSENT — every record written before v4. Those are all notes, and
 *    defaulting them is the whole point of the normalization.
 *  - `kind` PRESENT but not one of the two valid values — a corrupted row.
 *    Silently calling it a note would be fail-OPEN: it would re-enter the
 *    upload queue and be counted in the notes aggregates. It is QUARANTINED
 *    instead (`terminalError`), which keeps it out of every retry path while
 *    still counting it as at-risk data on reset. Nothing is written back here:
 *    a read must not mutate storage.
 */
function normalizeSyncRecord(raw: SyncRecord | undefined): SyncRecord | undefined {
  if (!raw) return undefined;
  if (raw.kind === 'safebox' || raw.kind === 'note') return raw;
  // `Object.hasOwn`, not `=== undefined`: the structured clone IndexedDB uses
  // PRESERVES a key explicitly stored as `undefined`, so the two are otherwise
  // indistinguishable. A legacy row predates the field entirely — it has no
  // such key. A row that stored `kind: undefined` was written by something that
  // knew about the field and got it wrong, which is corruption, not history.
  if (!Object.hasOwn(raw, 'kind')) return { ...raw, kind: 'note' }; // legacy row
  return { ...raw, kind: 'note', terminalError: 'malformed_record' };
}

/**
 * How long an 'uploading' row is believed to belong to a LIVE attempt.
 * Matches the server reservation timeout.
 *
 * Lives here, next to SyncRecord, because two very different callers must
 * agree on it: the upload queue (which refuses to re-enqueue a fresh
 * 'uploading') and the restore/import writers (which refuse to touch one,
 * D12). Two copies of this number would let the two disagree about which
 * record is in flight — and the whole point of the rule is that they cannot.
 */
export const STALE_UPLOADING_MS = 10 * 60 * 1000;

/**
 * True while a row still looks like a LIVE upload attempt.
 *
 * The freshness window is a heuristic and is treated as one: it decides only
 * whether a writer defers, never whether a late answer may be applied. That
 * second question is settled by `attemptId` (D14a), because the proxy POST has
 * no timeout and time alone proves nothing about an in-flight request.
 */
export function isFreshUploading(record: SyncRecord | undefined, now: number): boolean {
  return record?.status === 'uploading' && (now - record.updatedAt) < STALE_UPLOADING_MS;
}

// ─── Database ────────────────────────────────────────────────────────

const DB_NAME = 'eternal-notes';
/**
 * v2 adds the `safebox` store. The bump happens on the FIRST launch of R4,
 * independently of the writer flag — which is exactly why R4 is an
 * irreversible client floor (docs/ROLLBACK.md).
 *
 * v3 adds NO store and NO index. The ONLY schema change is the additive
 * `attemptId` field on SyncRecord (D14a) — which is precisely why the bump is
 * free, and why it is worth spending: the version number is the only mechanism
 * that can stop an OLDER build from opening this database.
 *
 * That matters because the server-side fingerprint does not make the old
 * client-side writers safe. A pre-D12 build re-pairs a restored payload with
 * whatever txId the sync row already held, and a pre-D14/D14a build signs a
 * payload snapshot and then applies the answer unconditionally — both
 * reproduce «payload B ↔ txId A» without the worker being involved at all.
 * An old tab therefore gets the non-destructive «update the app» screen
 * (`blocking()` below → store.tsx), and a client rollback below the release
 * that introduced v3 is FORBIDDEN and recorded in docs/ROLLBACK.md.
 */
export const DB_VERSION = 3;

let db: IDBPDatabase | null = null;
let initPromise: Promise<void> | null = null;

export interface InitStorageOptions {
  /** Another tab still holds a connection at the OLD version, so the upgrade
   *  cannot start. Without surfacing this the first R4 tab spins on 'loading'
   *  forever. The upgrade proceeds automatically once that tab closes. */
  onBlocked?: () => void;
  /** THIS tab is the one in the way: a newer build in another tab wants to
   *  upgrade the schema. Our connection is closed first (so the other tab can
   *  proceed), then this fires — every later read here would throw, so the
   *  caller MUST move the app to a non-destructive «reload» screen. */
  onBlocking?: () => void;
}

export async function initStorage(opts: InitStorageOptions = {}): Promise<void> {
  // Single-flight guard. On rejection the promise is cleared so the NEXT call
  // retries a clean init instead of sticking to the rejected promise forever.
  initPromise ??= doInit(opts).catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * True for the DOMException IndexedDB raises when the STORED database is newer
 * than the version this build asks for — i.e. an older client opened after an
 * R4+ tab already migrated. The caller must show a "reload / update" screen and
 * MUST NOT offer the destructive storage reset (the data is intact and fully
 * readable by the newer build; deleting it would throw away everything
 * unsynced).
 */
export function isDbVersionError(err: unknown): boolean {
  return (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'VersionError')
    || (err instanceof Error && err.name === 'VersionError');
}

async function doInit(opts: InitStorageOptions): Promise<void> {
  if (db) return;

  // Captured for the `blocking` callback: it may fire before `db` is published
  // (or after another init replaced it), so closing the module-level handle is
  // not the same thing as closing THIS connection.
  let opened: IDBPDatabase | null = null;

  const database = await openDB(DB_NAME, DB_VERSION, {
    // GUARDED per-version steps: `upgrade` also runs for a v1→v2 migration on
    // an EXISTING database, where the v1 stores already exist and an
    // unconditional createObjectStore would throw ConstraintError.
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        // Notes store
        const notesStore = database.createObjectStore('notes', { keyPath: 'noteId' });
        notesStore.createIndex('by-timestamp', 'createdAt');

        // Sync state store
        const syncStore = database.createObjectStore('sync', { keyPath: 'noteId' });
        syncStore.createIndex('by-status', 'status');

        // Meta KV store
        database.createObjectStore('meta');
      }
      if (oldVersion < 2) {
        // Safebox entries (v4). Existing notes/sync/meta data is untouched.
        const safeboxStore = database.createObjectStore('safebox', { keyPath: 'entryId' });
        safeboxStore.createIndex('by-timestamp', 'createdAt');
      }
      // v3: NOTHING to migrate. `attemptId` is an additive optional field on
      // rows of the existing `sync` store, so every stored row is already
      // valid at v3 and rewriting them would be pure risk. The version exists
      // to lock OLD builds out, not to reshape data — see DB_VERSION above.
    },
    blocked() {
      opts.onBlocked?.();
    },
    blocking() {
      // A NEWER version wants to upgrade and we are the connection in the way.
      // Close THIS connection immediately (not merely whatever `db` currently
      // points at) so the other tab can proceed; our own reads then fail
      // loudly instead of silently serving a stale schema.
      try { (opened ?? db)?.close(); } catch { /* already closed */ }
      if (opened === null || db === opened) db = null;
      initPromise = null;
      opts.onBlocking?.();
    },
  });
  opened = database;

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
 *
 * CONTRACT: the transaction is created SYNCHRONOUSLY on entry. Callers that
 * guard against a concurrent reset rely on it — an await added before the
 * `transaction(...)` line would silently reopen the resurrection window.
 *
 * QUARANTINE RULE (per reason, decided on the row re-read INSIDE this
 * transaction — the caller's earlier getSyncRecord is a suspension point and
 * must not be trusted):
 *  - no terminalError → write `record` as given (the normal restore path);
 *  - 'recovery_invalidated' → CLEARED. This is the authorized cryptographic
 *    reconciliation path: by the time restore writes, the pipeline has
 *    established a TRUSTED OWNER (owners: TRUSTED_OWNERS filter), an
 *    AUTHENTICATED envelope (it just decrypted under the vault key) and an
 *    on-chain transaction — exactly the publication proof the quarantine was
 *    waiting for. Clearing here is the model's designed completion, not a
 *    bypass;
 *  - 'unsupported_version' / 'malformed_record' → PRESERVED. The local row is
 *    unusable for a different reason; whether replacing it with the on-chain
 *    copy is safe is a separate decision, not a restore side effect. The
 *    payload is still written (upsert-repair), the quarantine flag stays.
 */
export async function saveNoteWithSync(
  note: EncryptedNote,
  record: SyncRecord,
): Promise<void> {
  const tx = getDB().transaction(['notes', 'sync'], 'readwrite');
  try {
    await tx.objectStore('notes').put(note);
    const syncStore = tx.objectStore('sync');
    await syncStore.put(await applyRestoreQuarantineRule(syncStore, record));
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

/** The per-reason quarantine decision, as a PURE function of the row that was
 *  read inside the writer's transaction. Pure so the merge below can make every
 *  decision from ONE in-transaction read instead of reading twice. */
function resolveRestoreQuarantine(
  fresh: SyncRecord | undefined,
  record: SyncRecord,
): SyncRecord {
  if (fresh?.terminalError === undefined) return record;
  if (fresh.terminalError === 'recovery_invalidated') {
    const cleared = { ...record };
    delete cleared.terminalError;
    return cleared;
  }
  return { ...record, terminalError: fresh.terminalError };
}

/** The per-reason quarantine decision shared by both restore writers. Runs on
 *  the row re-read INSIDE the caller's transaction (TOCTOU-safe: a quarantine
 *  set after the caller's preliminary read still wins/clears correctly). */
async function applyRestoreQuarantineRule(
  syncStore: { get(key: string): Promise<unknown> },
  record: SyncRecord,
): Promise<SyncRecord> {
  const fresh = normalizeSyncRecord(await syncStore.get(record.noteId) as SyncRecord | undefined);
  return resolveRestoreQuarantine(fresh, record);
}

/**
 * The D12 merge itself: ONE readwrite transaction over the payload store and
 * `sync`, in which the row is read ONCE and every decision is made from that
 * read — «is an attempt live?», «does the existing confirmed row name this
 * transaction?» and the per-reason quarantine rule alike.
 *
 * Reading the row BEFORE the transaction (as this used to) is a TOCTOU window
 * with real consequences: between that read and the write, another tab can
 * begin an upload and stamp the row with its `attemptId`. The merge would then
 * overwrite both the payload and that row — the late answer is still discarded
 * by the attempt-CAS, but the HTTP request has already gone out against bytes
 * the store no longer holds, which can mean a second paid publication and a DO
 * that disagrees with the device. Deferring is only meaningful if the check and
 * the write cannot be separated.
 *
 * CONTRACT, same as save*WithSync: `assertDbGeneration` and the transaction
 * creation are adjacent and synchronous. An await between them silently
 * reopens the reset-resurrection window.
 */
async function mergeRestoredPair(
  payloadStore: 'notes' | 'safebox',
  kind: SyncRecord['kind'],
  id: string,
  payload: EncryptedNote | EncryptedSafeboxEntry,
  txId: string,
  now: number,
  expectedDbGeneration: number,
): Promise<MergeRestoredOutcome> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction([payloadStore, 'sync'], 'readwrite');
  try {
    const syncStore = tx.objectStore('sync');
    const fresh = normalizeSyncRecord(await syncStore.get(id) as SyncRecord | undefined);
    if (isFreshUploading(fresh, now)) {
      await tx.done;
      return 'deferred'; // a live attempt owns these bytes — touch nothing
    }
    const record: SyncRecord = fresh?.status === 'confirmed' && fresh.txId === txId
      ? fresh
      : { noteId: id, kind, txId, status: 'confirmed', transport: 'proxy', updatedAt: now };

    await tx.objectStore(payloadStore).put(payload);
    await syncStore.put(resolveRestoreQuarantine(fresh, record));
    await tx.done;
    return 'merged';
  } catch (e) {
    // Same rollback discipline as save*WithSync: an error on the SECOND put
    // must not let the transaction auto-commit with only the payload written.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/**
 * Did the restore merge actually write? 'deferred' means a live upload attempt
 * owns the record and it was left completely alone (D12).
 *
 * The caller MUST branch on this: a deferred record has NOT been repaired, so
 * dropping it from the «undecryptable, re-download it» set would hide a
 * still-broken payload until the next full sweep.
 */
export type MergeRestoredOutcome = 'merged' | 'deferred';

/**
 * Merge one successfully-decrypted on-chain note into local storage during
 * restore. ALWAYS upserts BOTH pieces atomically:
 *  - the note payload: the on-chain copy is known-good (it just decrypted),
 *    while the local ciphertext may be corrupted even when the sync record says
 *    'confirmed' — skipping the write would make restore unable to repair it;
 *  - the sync state: a note without a confirmed record (older app versions
 *    wrote none) would be re-queued and could re-upload an already-on-chain
 *    note (duplicate paid TX if the server's old idempotency record is gone).
 *
 * THE PAIR IS WRITTEN TOGETHER OR NOT AT ALL (D12). An existing CONFIRMED
 * record is preserved as-is — with its original txId and updatedAt — ONLY when
 * it names the SAME transaction we are merging. Preserving it unconditionally
 * (the previous behaviour) kept txId A next to freshly written payload B: the
 * exact false claim «these bytes are that publication» that the whole backup
 * track exists to make impossible, and it was created locally, without the
 * server being involved at all. A different txId means the local row describes
 * a different publication, so it is replaced together with the bytes it
 * describes.
 *
 * A FRESH 'uploading' row is not touched at all — payload included. Rewriting
 * the bytes under a live attempt would let its answer bind a txId to a payload
 * that attempt never sent. A STALE one is handled normally, which is only safe
 * because the attempt-CAS (D14a) drops the late answer: time alone proves
 * nothing about a POST that has no timeout.
 *
 * All three decisions are made INSIDE one transaction, from ONE read of the
 * row (mergeRestoredPair). Checking «is an attempt live?» before the
 * transaction would leave a window in which another tab starts an upload and
 * this merge overwrites it anyway.
 *
 * UI visibility is the CALLER's decision (against the currently-decrypted note
 * list, not DB presence — a corrupted-but-present note is invisible in the UI).
 */
export async function mergeRestoredNote(
  note: EncryptedNote,
  txId: string,
  now: number,
  expectedDbGeneration: number,
): Promise<MergeRestoredOutcome> {
  return mergeRestoredPair('notes', 'note', note.noteId, note, txId, now, expectedDbGeneration);
}

/** Get all notes sorted by createdAt DESC (newest first) */
export async function getAllNotes(): Promise<EncryptedNote[]> {
  const all = await getDB().getAllFromIndex('notes', 'by-timestamp');
  return all.reverse() as EncryptedNote[];
}

/** Cheap key-only listing for the incremental sweep: a sync record counts as
 *  «known» only when its note PHYSICALLY exists in its own store — a record
 *  whose row was lost to DB damage must fall out of the known set and be
 *  re-downloaded. Payloads are not read. */
export async function getAllNoteIds(): Promise<string[]> {
  return getDB().getAllKeys('notes') as Promise<string[]>;
}

export async function getNoteById(noteId: string): Promise<EncryptedNote | undefined> {
  return getDB().get('notes', noteId) as Promise<EncryptedNote | undefined>;
}

// ─── Safebox entries (v4) ────────────────────────────────────────────

/** All safebox entries, newest first (outer createdAt — index order only;
 *  «currentness» always comes from the authenticated envelope fields). */
export async function getAllSafeboxEntries(): Promise<EncryptedSafeboxEntry[]> {
  const all = await getDB().getAllFromIndex('safebox', 'by-timestamp');
  return all.reverse() as EncryptedSafeboxEntry[];
}

export async function getSafeboxEntryById(entryId: string): Promise<EncryptedSafeboxEntry | undefined> {
  return getDB().get('safebox', entryId) as Promise<EncryptedSafeboxEntry | undefined>;
}

/** Key-only listing, mirror of getAllNoteIds — see the comment there. */
export async function getAllSafeboxEntryIds(): Promise<string[]> {
  return getDB().getAllKeys('safebox') as Promise<string[]>;
}

/** Cheap count for hydration + reset-safety — works with the safebox LOCKED
 *  (no decryption, no keys). */
export async function countSafeboxEntries(): Promise<number> {
  return getDB().count('safebox');
}

/** Persist an entry and its sync record together in a SINGLE transaction —
 *  same contract as saveNoteWithSync, including the synchronous creation of the
 *  transaction on entry AND the per-reason quarantine rule (in-transaction
 *  re-read; 'recovery_invalidated' cleared by this proof-bearing path, other
 *  reasons preserved). Used by the restore merge, which records the
 *  already-on-chain TX as `confirmed`. */
export async function saveSafeboxEntryWithSync(
  entry: EncryptedSafeboxEntry,
  record: SyncRecord,
): Promise<void> {
  const tx = getDB().transaction(['safebox', 'sync'], 'readwrite');
  try {
    await tx.objectStore('safebox').put(entry);
    const syncStore = tx.objectStore('sync');
    await syncStore.put(await applyRestoreQuarantineRule(syncStore, record));
    await tx.done;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/** Restore-merge upsert-repair, mirroring mergeRestoredNote — including the
 *  D12 rules: the (payload, txId) pair is written together, an existing
 *  CONFIRMED record survives ONLY when it names the same transaction, and a
 *  FRESH 'uploading' row is left completely untouched. See mergeRestoredNote
 *  for why each of the three matters. */
export async function mergeRestoredSafeboxEntry(
  entry: EncryptedSafeboxEntry,
  txId: string,
  now: number,
  expectedDbGeneration: number,
): Promise<MergeRestoredOutcome> {
  return mergeRestoredPair('safebox', 'safebox', entry.entryId, entry, txId, now, expectedDbGeneration);
}

/** The safebox PIN configuration was replaced or removed between the start of
 *  an operation and its commit (another tab, a wipe, a re-activation). The
 *  operation is abandoned: a secret must never be published — and a failed
 *  attempt must never be charged — against a config we no longer own. */
export class SafeboxConfigChangedError extends Error {
  constructor() {
    super('Конфигурация PIN сейфа изменилась — повторите операцию.');
    this.name = 'SafeboxConfigChangedError';
  }
}

/**
 * Write ONE safebox entry version, re-verifying the PIN config INSIDE the same
 * readwrite transaction (§6). A separate `getMeta()` followed by a separate
 * write leaves a window in which another tab replaces/deletes the config — and
 * the version lands anyway, behind a PIN that is no longer the one the user
 * unlocked with.
 */
export async function commitSafeboxEntry(
  entry: EncryptedSafeboxEntry,
  expectedConfigId: string,
  expectedDbGeneration: number,
): Promise<void> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction(['meta', 'safebox'], 'readwrite');
  try {
    const raw: unknown = await tx.objectStore('meta').get(SAFEBOX_PIN_META_KEY);
    if (raw === undefined) throw new SafeboxConfigChangedError();
    const config = assertValidSafeboxPinConfig(raw);
    if (config.configId !== expectedConfigId) throw new SafeboxConfigChangedError();
    await tx.objectStore('safebox').put(entry);
    await tx.done;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

// ─── Safebox PIN configuration (single record, transactional) ────────
//
// ONE meta record holds the blob AND its metering state. Every mutation runs
// inside a single readwrite `meta` transaction that RE-READS the record —
// IndexedDB serializes readwrite transactions per store, so two tabs failing a
// PIN concurrently can never lose an increment (the getMeta/setMeta pattern the
// MAIN PIN still uses does lose them; that is a separate, known issue).

export const SAFEBOX_PIN_META_KEY = 'safebox-pin';

export interface SafeboxPinConfig {
  blob: PinEncryptedSeed;
  /** Opaque nonce, regenerated on EVERY create/replace of the blob. Any change
   *  of ownership is observable without a persistent tombstone: a
   *  delete→recreate cycle cannot land on the same value (unlike a monotonic
   *  counter living inside the deleted record). */
  configId: string;
  attempts: number;          // 0..9 — 10 triggers the wipe
  lockedUntil: number | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
export const SAFEBOX_MAX_PIN_ATTEMPTS = 10;

/**
 * Runtime-validate the WHOLE config on every read — IndexedDB is an untrusted
 * runtime boundary (same reasoning as assertValidPinBlob). Extra AND missing
 * fields are rejected.
 *
 * Throws SafeboxPinUnavailableError, which callers must treat fail-closed: the
 * attempt is NOT spent and the lockout is NOT touched (a corrupted record may
 * neither disable the lockout nor block seed recovery).
 */
export function assertValidSafeboxPinConfig(raw: unknown): SafeboxPinConfig {
  const fail = (why: string): never => {
    throw new SafeboxPinUnavailableError(`Malformed safebox PIN config: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('shape');
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  const expected = ['blob', 'configId', 'attempts', 'lockedUntil'];
  if (keys.length !== expected.length || keys.some(k => !expected.includes(k))) fail('keys');
  if (typeof o.configId !== 'string' || !UUID_REGEX.test(o.configId)) fail('configId');
  if (!Number.isSafeInteger(o.attempts) || (o.attempts as number) < 0
      || (o.attempts as number) >= SAFEBOX_MAX_PIN_ATTEMPTS) {
    fail('attempts');
  }
  if (o.lockedUntil !== null
      && (!Number.isSafeInteger(o.lockedUntil) || (o.lockedUntil as number) < 0
          || (o.lockedUntil as number) > MAX_TIMESTAMP_MS)) {
    fail('lockedUntil');
  }
  if (typeof o.blob !== 'object' || o.blob === null || Array.isArray(o.blob)) fail('blob');
  const blob = o.blob as PinEncryptedSeed;
  // The FULL blob check — the same one the KDF path runs (base64, 12-byte IV,
  // 16-byte salt, ciphertext ≥ tag length, known kdf, pinned Argon2 profile).
  // A shallow "three strings are present" test here would let a hostile blob
  // reach Argon2 with arbitrary parameters.
  try {
    assertValidPinBlob(blob);
  } catch (e) {
    fail(`blob: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    blob,
    configId: o.configId as string,
    attempts: o.attempts as number,
    lockedUntil: o.lockedUntil as number | null,
  };
}

/** Read + validate the config. `null` = not configured; a malformed record
 *  THROWS SafeboxPinUnavailableError (never silently "not configured" — that
 *  would present the activation flow and let a wipe look like a fresh start). */
export async function readSafeboxPinConfig(): Promise<SafeboxPinConfig | null> {
  const raw = await getMeta<unknown>(SAFEBOX_PIN_META_KEY);
  if (raw === undefined) return null;
  return assertValidSafeboxPinConfig(raw);
}

/** Presence check for hydration/UI visibility — never throws. A malformed
 *  record still COUNTS as configured (fail closed: show the safebox with its
 *  «сбросить PIN по seed-фразе» path rather than the first-activation flow). */
export async function hasSafeboxPinConfig(): Promise<boolean> {
  return (await getMeta<unknown>(SAFEBOX_PIN_META_KEY)) !== undefined;
}

/** Progressive lockout — identical schedule to the main PIN. */
export function safeboxLockSeconds(attempts: number): number {
  if (attempts <= 3) return 0;
  if (attempts <= 5) return 30;
  if (attempts <= 7) return 300;
  return 1800;
}

/** The subset of the meta object store the mutators need. */
interface MetaStoreWriter {
  put(value: unknown, key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** …plus the read, for mutators that re-read inside their own transaction. */
interface MetaStoreReadWriter extends MetaStoreWriter {
  get(key: string): Promise<unknown>;
}

/**
 * The vault this operation belongs to was DESTROYED (resetAll / another tab's
 * reset) while the operation was in flight. Writing now would resurrect the PIN
 * configuration inside a wiped database — or, worse, attach it to whatever
 * vault is opened next.
 */
export class StorageResetError extends Error {
  constructor() {
    super('Приложение было сброшено — операция отменена.');
    this.name = 'StorageResetError';
  }
}

/** Synchronous reset-exclusivity check, to be called IMMEDIATELY before the
 *  transaction is created (single-threaded JS ⇒ no TOCTOU window). */
function assertDbGeneration(expected: number): void {
  if (dbGeneration !== expected) throw new StorageResetError();
}

/** One readwrite `meta` transaction: re-read, verify ownership, mutate. */
async function mutateSafeboxPinConfig<T>(
  expectedConfigId: string,
  expectedDbGeneration: number,
  apply: (config: SafeboxPinConfig, store: MetaStoreWriter) => Promise<T> | T,
): Promise<T> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const raw: unknown = await tx.store.get(SAFEBOX_PIN_META_KEY);
    if (raw === undefined) throw new SafeboxConfigChangedError();
    const config = assertValidSafeboxPinConfig(raw);
    // The blob may have been replaced since this operation started: a failure
    // must not be charged to — and a success must not unlock — a config we no
    // longer own.
    if (config.configId !== expectedConfigId) throw new SafeboxConfigChangedError();
    const result = await apply(config, tx.store);
    await tx.done;
    return result;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

export interface SafeboxPinFailureOutcome {
  attempts: number;
  lockedUntil: number | null;
  /** The 10th strike removed the PIN CONFIGURATION. Entries are untouched —
   *  the section switches to «восстановите доступ по seed-фразе». */
  wiped: boolean;
}

/** Count one wrong-PIN attempt (and wipe the configuration on the 10th). */
export async function commitSafeboxPinFailure(
  expectedConfigId: string,
  now: number,
  expectedDbGeneration: number,
): Promise<SafeboxPinFailureOutcome> {
  return mutateSafeboxPinConfig(expectedConfigId, expectedDbGeneration, async (config, store) => {
    const attempts = config.attempts + 1;
    if (attempts >= SAFEBOX_MAX_PIN_ATTEMPTS) {
      await store.delete(SAFEBOX_PIN_META_KEY);
      return { attempts, lockedUntil: null, wiped: true };
    }
    const lockSeconds = safeboxLockSeconds(attempts);
    const lockedUntil = lockSeconds > 0 ? now + lockSeconds * 1000 : null;
    await store.put({ ...config, attempts, lockedUntil }, SAFEBOX_PIN_META_KEY);
    return { attempts, lockedUntil, wiped: false };
  });
}

/** Successful unlock: clear the metering (the blob and configId stay). */
export async function commitSafeboxPinSuccess(
  expectedConfigId: string,
  expectedDbGeneration: number,
): Promise<void> {
  await mutateSafeboxPinConfig(expectedConfigId, expectedDbGeneration, async (config, store) => {
    if (config.attempts === 0 && config.lockedUntil === null) return;
    await store.put({ ...config, attempts: 0, lockedUntil: null }, SAFEBOX_PIN_META_KEY);
  });
}

/** Deactivation / explicit removal. Ownership-checked like every mutation. */
export async function commitSafeboxPinDelete(
  expectedConfigId: string,
  expectedDbGeneration: number,
): Promise<void> {
  await mutateSafeboxPinConfig(expectedConfigId, expectedDbGeneration, async (_config, store) => {
    await store.delete(SAFEBOX_PIN_META_KEY);
  });
}

/**
 * Write a new configuration under a precondition, inside ONE readwrite
 * transaction. A brand-new `configId` is minted here — that is what makes the
 * change observable to every other tab, with or without BroadcastChannel.
 *
 * The precondition matters because Argon2id takes ~1 s: between reading the
 * config and writing the new blob, another tab can create or replace one.
 *  - 'absent'          — first activation. Fails if a config already exists,
 *                        so a racing activation cannot be silently clobbered.
 *  - <configId>        — PIN change. Fails unless THAT exact config is still
 *                        the current one.
 *  - 'seed-authorized' — the seed-phrase reset. Deliberately unconditional:
 *                        proof of the seed outranks any configuration, which
 *                        is the whole point of the recovery path.
 */
export async function commitSafeboxPinWrite(
  blob: PinEncryptedSeed,
  precondition: 'absent' | 'seed-authorized' | { configId: string },
  expectedDbGeneration: number,
): Promise<string> {
  assertDbGeneration(expectedDbGeneration);
  const configId = crypto.randomUUID();
  const next: SafeboxPinConfig = { blob, configId, attempts: 0, lockedUntil: null };

  const tx = getDB().transaction('meta', 'readwrite');
  try {
    if (precondition !== 'seed-authorized') {
      const raw: unknown = await tx.store.get(SAFEBOX_PIN_META_KEY);
      if (precondition === 'absent') {
        if (raw !== undefined) throw new SafeboxConfigChangedError();
      } else {
        if (raw === undefined) throw new SafeboxConfigChangedError();
        if (assertValidSafeboxPinConfig(raw).configId !== precondition.configId) {
          throw new SafeboxConfigChangedError();
        }
      }
    }
    await tx.store.put(next, SAFEBOX_PIN_META_KEY);
    await tx.done;
    return configId;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

// ─── Sync Records ────────────────────────────────────────────────────

export async function getSyncRecord(noteId: string): Promise<SyncRecord | undefined> {
  return normalizeSyncRecord(await getDB().get('sync', noteId) as SyncRecord | undefined);
}

export async function setSyncRecord(record: SyncRecord): Promise<void> {
  await getDB().put('sync', record);
}

/** Why an atomic begin refused. Both outcomes mean the SAME thing to the
 *  caller — dispatch no HTTP — and are distinguished only so the queue and the
 *  tests can tell «someone quarantined this row» from «these bytes are no
 *  longer what the store holds». */
export type BeginUploadOutcome =
  | { ok: true; attemptId: string }
  | { ok: false; reason: 'blocked' | 'stale' };

/**
 * ATOMIC begin of an upload attempt: ONE readwrite transaction that re-reads
 * the current sync row AND the current payload, refuses on either guard, and
 * otherwise writes the 'uploading' transition stamped with a fresh
 * `attemptId`. On refusal the caller must NOT dispatch any HTTP.
 *
 * Three things happen here, and each closes a different window:
 *
 *  1. QUARANTINE (pre-existing). Between the queue reading `prev` and this
 *     write another tab may have set `terminalError`; a plain setSyncRecord
 *     would erase it before the request even started.
 *
 *  2. PAYLOAD-CAS (D14). The body was serialized and SIGNED from a snapshot
 *     the queue captured earlier (upload-flow.ts step 1). If a restore or an
 *     import has replaced the stored bytes since then, sending the signed
 *     snapshot would bind the resulting txId to a payload the store no longer
 *     has. The comparison is `publicationEquivalent`, not raw deep equality:
 *     the question is whether the two would publish identically, and a change
 *     confined to a field that never reaches the chain (the outer `createdAt`
 *     of a v2+ record) is not a reason to abandon a signed attempt.
 *
 *  3. ATTEMPT STAMP (D14a). `attemptId` identifies THIS attempt so its answer
 *     can be matched later; see commitUploadResultIfAttempt.
 *
 * The CAS is synchronous by construction: only IndexedDB requests are awaited
 * inside the transaction, and `publicationEquivalent` performs no async work
 * and never throws. A `crypto.subtle` call or any non-IDB await here would let
 * the transaction go inactive and turn the guard into a no-op.
 */
export async function beginUploadUnlessTerminal(
  noteId: string,
  snapshot: PublicationSubject,
  now: number,
): Promise<BeginUploadOutcome> {
  const payloadStore = snapshot.kind === 'note' ? 'notes' : 'safebox';
  const tx = getDB().transaction([payloadStore, 'sync'], 'readwrite');
  const store = tx.objectStore('sync');
  const fresh = normalizeSyncRecord(await store.get(noteId) as SyncRecord | undefined);
  if (fresh?.terminalError !== undefined) {
    await tx.done;
    return { ok: false, reason: 'blocked' };
  }

  const current = await tx.objectStore(payloadStore).get(noteId);
  if (current === undefined) {
    // The row vanished under us (a wipe, a damaged store). Fail closed: there
    // is nothing left to prove the snapshot still describes local data.
    await tx.done;
    return { ok: false, reason: 'stale' };
  }
  const live: PublicationSubject = snapshot.kind === 'note'
    ? { kind: 'note', record: current as EncryptedNote }
    : { kind: 'safebox', record: current as EncryptedSafeboxEntry };
  if (!publicationEquivalent(snapshot, live)) {
    await tx.done;
    return { ok: false, reason: 'stale' };
  }

  const attemptId = crypto.randomUUID();
  await store.put(toUploading(noteId, snapshot.kind, fresh, now, attemptId));
  await tx.done;
  return { ok: true, attemptId };
}

/**
 * Terminal-preserving writer for EVERY ordinary sync-record result (upload
 * response, late poll, BFCache resurrection): ONE readwrite transaction
 * re-reads the CURRENT row and applies `build(fresh)` only if the row is not
 * quarantined. `terminalError` is MONOTONE at the record boundary — an
 * in-flight result finishing after a quarantine was set must never erase it,
 * whatever the request's outcome was. The quarantined row already preserves
 * txId and the recovery hint, so dropping the stale result loses nothing.
 *
 * `build` runs INSIDE the transaction and must be synchronous/pure (the
 * sync-transitions builders are). It MAY itself set terminalError — the
 * quarantine SETTERS go through here too, which also guarantees a second
 * reason never overwrites the first. Returning null = deliberate no-op.
 *
 * The only writers allowed to bypass this monotonicity are the proof-bearing
 * restore writers (saveNoteWithSync / saveSafeboxEntryWithSync — see their
 * per-reason rules) and resetAll(), which is a deliberate user wipe.
 */
export async function commitSyncUnlessTerminal(
  noteId: string,
  build: (fresh: SyncRecord | undefined) => SyncRecord | null,
): Promise<'applied' | 'blocked' | 'noop'> {
  const tx = getDB().transaction('sync', 'readwrite');
  const store = tx.objectStore('sync');
  const fresh = normalizeSyncRecord(await store.get(noteId) as SyncRecord | undefined);
  if (fresh?.terminalError !== undefined) {
    await tx.done;
    return 'blocked';
  }
  const next = build(fresh);
  if (next === null) {
    await tx.done;
    return 'noop';
  }
  await store.put(next);
  await tx.done;
  return 'applied';
}

/**
 * The ONLY writer allowed to persist the result of an upload ATTEMPT (D14a).
 *
 * Payload-CAS (D14) makes sure the right bytes are sent; this makes sure the
 * answer is applied to the row that asked for it. The proxy POST has no
 * timeout by design, so an attempt can outlive the ten-minute stale window,
 * another writer can legitimately take over the record in the meantime, and
 * the answer that finally arrives then describes bytes that are no longer
 * there. Applying it would write that attempt's txId next to someone else's
 * payload — locally, with no server involvement.
 *
 * Mandatory for EVERY result branch, not merely the successful one: an
 * `in_progress`, a quarantine verdict or a generic 5xx applied to the wrong
 * row is just as wrong as an accepted txId.
 *
 * Kept SEPARATE from commitSyncUnlessTerminal on purpose. The polling paths
 * have their own discipline and no attempt of their own; giving them an
 * optional attemptId parameter would make «no id passed» silently mean «apply
 * unconditionally», which is precisely the behaviour being removed here.
 *
 * Returns 'stale' when the row no longer belongs to this attempt, and
 * 'blocked' when it is quarantined — two names for one behaviour (refuse
 * before building anything), kept apart so a test can say which guard fired.
 */
export async function commitUploadResultIfAttempt(
  noteId: string,
  attemptId: string,
  build: (fresh: SyncRecord | undefined) => SyncRecord | null,
): Promise<'applied' | 'blocked' | 'noop' | 'stale'> {
  const tx = getDB().transaction('sync', 'readwrite');
  const store = tx.objectStore('sync');
  const fresh = normalizeSyncRecord(await store.get(noteId) as SyncRecord | undefined);
  // Quarantine is reported FIRST so 'blocked' keeps meaning exactly what it
  // meant before D14a. The order is diagnostic only: both guards refuse before
  // `build` runs, so neither can let a write through that the other would have
  // stopped — and a quarantine set mid-flight would fail the attempt check too
  // (the transition that set it rebuilt the row without `attemptId`).
  if (fresh?.terminalError !== undefined) {
    await tx.done;
    return 'blocked';
  }
  if (fresh?.attemptId !== attemptId) {
    await tx.done;
    return 'stale';
  }
  const next = build(fresh);
  if (next === null) {
    await tx.done;
    return 'noop';
  }
  await store.put(next);
  await tx.done;
  return 'applied';
}

export async function getRecordsByStatus(status: SyncRecord['status']): Promise<SyncRecord[]> {
  const all = await getDB().getAllFromIndex('sync', 'by-status', status) as SyncRecord[];
  return all.map(r => normalizeSyncRecord(r)!);
}

export async function getAllSyncRecords(): Promise<SyncRecord[]> {
  const all = await getDB().getAll('sync') as SyncRecord[];
  return all.map(r => normalizeSyncRecord(r)!);
}

// ─── Meta ────────────────────────────────────────────────────────────

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return getDB().get('meta', key) as Promise<T | undefined>;
}

/**
 * Runtime-validate the «last full sweep» meta value (`sweep-full-at`).
 * `getMeta<number>` is a type ASSERTION, not a check: a string, NaN, Infinity
 * or a far-future timestamp landing in meta through DB corruption would make
 * `now − lastFull > MAX_AGE` permanently false — silently disabling the very
 * safety net that exists to repair corruption. Anything but a finite integer
 * in [0, now + 5 min] reads as «no mark» (0): a data error must cause EXTRA
 * work, never a skip.
 */
export function sanitizeFullSweepAt(raw: unknown, now: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 0; // string/NaN/Infinity/fractional
  if (raw < 0 || raw > now + 5 * 60 * 1000) return 0;
  return raw;
}

// ─── v3 upload pause (worker kill switch, client side) ──────────────
//
// Shared, persisted, authoritative across tabs: the queue re-reads this meta
// right before every v3 dispatch. Written ATOMICALLY with the failure
// SyncRecord (commitV3PausedFailure) — separate writes would leave a crash
// window where the error is recorded but the pause is lost, and the next
// unlock bursts the whole v3 backlog again.

export const V3_PAUSE_META_KEY = 'v3-uploads-paused';
/** Independent marker for the SAFEBOX kill switch: pausing one version must
 *  never stop the other, so the two never share a key or a lift condition. */
export const V4_PAUSE_META_KEY = 'v4-uploads-paused';
/**
 * The GLOBAL kill switch marker — its OWN key, not the two version ones.
 *
 * Writing v3+v4 instead would still leave v1/v2 uploading: the queue only
 * consults a version marker for v3/safebox items, so a global 503 would stop
 * part of the backlog and let the rest keep spending the per-IP budget against
 * a worker that refuses everything. The global pause is a different STATE, so
 * it gets a different key and its own gate before every dispatch.
 */
export const GLOBAL_PAUSE_META_KEY = 'uploads-paused';

export interface V3PauseMeta {
  pausedAt: number;
}
export type PauseMeta = V3PauseMeta;

/** Runtime-validated read. 'malformed' = a value is PRESENT but unreadable —
 *  fail closed: treat as paused (clearable via manual retry / valid health). */
async function readPauseMeta(key: string): Promise<PauseMeta | 'malformed' | null> {
  const raw = await getMeta<unknown>(key);
  if (raw === undefined) return null;
  if (typeof raw === 'object' && raw !== null) {
    const pausedAt = (raw as { pausedAt?: unknown }).pausedAt;
    if (typeof pausedAt === 'number' && Number.isSafeInteger(pausedAt) && pausedAt >= 0) {
      return { pausedAt };
    }
  }
  return 'malformed';
}

export function readV3PauseMeta(): Promise<PauseMeta | 'malformed' | null> {
  return readPauseMeta(V3_PAUSE_META_KEY);
}
export function readV4PauseMeta(): Promise<PauseMeta | 'malformed' | null> {
  return readPauseMeta(V4_PAUSE_META_KEY);
}
export function readGlobalPauseMeta(): Promise<PauseMeta | 'malformed' | null> {
  return readPauseMeta(GLOBAL_PAUSE_META_KEY);
}

/**
 * Persist a vN_disabled upload failure AND the pause marker in ONE transaction
 * over sync+meta. Called from the committed part of runUploadAttempt INSTEAD
 * of the terminal-preserving result commit (never in addition — two writes
 * reopen the crash window this exists to close).
 *
 * Terminal-preserving AND attempt-scoped for the RECORD half (D14a: the row is
 * written only while it still belongs to this attempt), but the PAUSE MARKER is
 * written unconditionally. The asymmetry is deliberate and load-bearing: the
 * pause is version-global state about the WORKER, not about this record, and
 * the server did answer vN_disabled regardless of who owns the row now.
 * Dropping the marker because of a stale attemptId would let the next unlock
 * burst the whole backlog at a worker that has already said no.
 */
async function commitPausedFailure(
  keys: readonly string[],
  noteId: string,
  attemptId: string,
  buildRecord: (fresh: SyncRecord | undefined) => SyncRecord,
  pausedAt: number,
): Promise<void> {
  const tx = getDB().transaction(['sync', 'meta'], 'readwrite');
  try {
    const syncStore = tx.objectStore('sync');
    const fresh = normalizeSyncRecord(await syncStore.get(noteId) as SyncRecord | undefined);
    if (fresh?.attemptId === attemptId && fresh.terminalError === undefined) {
      await syncStore.put(buildRecord(fresh));
    }
    // All markers in the SAME transaction: the global kill switch pauses every
    // version at once, and writing the two halves separately would reopen the
    // crash window this function exists to close.
    const metaStore = tx.objectStore('meta');
    for (const key of keys) {
      await metaStore.put({ pausedAt } satisfies PauseMeta, key);
    }
    await tx.done;
  } catch (e) {
    // Same rollback discipline as saveNoteWithSync: an error on the SECOND put
    // must not let the transaction auto-commit with only the record written.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

export function commitV3PausedFailure(
  noteId: string,
  attemptId: string,
  buildRecord: (fresh: SyncRecord | undefined) => SyncRecord,
  pausedAt: number,
): Promise<void> {
  return commitPausedFailure([V3_PAUSE_META_KEY], noteId, attemptId, buildRecord, pausedAt);
}
export function commitV4PausedFailure(
  noteId: string,
  attemptId: string,
  buildRecord: (fresh: SyncRecord | undefined) => SyncRecord,
  pausedAt: number,
): Promise<void> {
  return commitPausedFailure([V4_PAUSE_META_KEY], noteId, attemptId, buildRecord, pausedAt);
}

/**
 * The GLOBAL kill switch (503 {code:'uploads_disabled'}) pauses EVERY version.
 *
 * It is not «v3 and v4 happen to both be off»: the worker refuses v1–v4 alike,
 * before the body is even read. Without this the queue would keep marching
 * through the backlog, burning the per-IP budget against a worker that answers
 * 503 to all of it — and the incident lever would not actually stop anything.
 *
 * Both markers are set, so the existing resume path applies unchanged: they
 * lift only once /health reports the version usable again, and after PR-3a
 * that verdict already requires the global `uploads` flag to be true.
 */
export function commitGlobalPausedFailure(
  noteId: string,
  attemptId: string,
  buildRecord: (fresh: SyncRecord | undefined) => SyncRecord,
  pausedAt: number,
): Promise<void> {
  return commitPausedFailure([GLOBAL_PAUSE_META_KEY], noteId, attemptId, buildRecord, pausedAt);
}

/**
 * Conditionally lift the pause (compare-and-delete): the marker is removed only
 * while its pausedAt still equals `expectedPausedAt` — a stale successful
 * /health probe must never erase a NEWER pause set after the probe started.
 * Pass 'any' for the unconditional manual-retry path. Returns whether the
 * marker was removed.
 */
async function clearUploadsPaused(
  key: string,
  expectedPausedAt: number | 'any',
): Promise<boolean> {
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const raw: unknown = await meta.get(key);
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
    await meta.delete(key);
    await tx.done;
    return true;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

export function clearV3UploadsPaused(expectedPausedAt: number | 'any'): Promise<boolean> {
  return clearUploadsPaused(V3_PAUSE_META_KEY, expectedPausedAt);
}
export function clearGlobalUploadsPaused(expectedPausedAt: number | 'any'): Promise<boolean> {
  return clearUploadsPaused(GLOBAL_PAUSE_META_KEY, expectedPausedAt);
}
export function clearV4UploadsPaused(expectedPausedAt: number | 'any'): Promise<boolean> {
  return clearUploadsPaused(V4_PAUSE_META_KEY, expectedPausedAt);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await getDB().put('meta', value, key);
}

export async function deleteMeta(key: string): Promise<void> {
  await getDB().delete('meta', key);
}

// ─── Vault identity ─────────────────────────────────────────────────

/** Outcome of binding a seed's public key to THIS database.
 *  `'revoked'` = the caller passed a `requireQuickUnlock` precondition and it
 *  no longer holds (the record or the PIN went away). NOTHING was written. */
export type VaultBindResult = 'bound' | 'same' | 'foreign' | 'revoked';

/**
 * Bind the vault identity — and, optionally, mark the database initialized — in
 * ONE readwrite `meta` transaction:
 *   no key yet    → write the key (+ `init` when initialize) → 'bound'
 *   same key      → (+ `init` when initialize)               → 'same'
 *   foreign key   → write NOTHING                            → 'foreign'
 *
 * First-writer-wins. A plain `setMeta('vault-public-key', pk)` after the
 * read-only guard in prepareVaultSnapshot leaves a window in which two tabs
 * opening DIFFERENT seeds against an EMPTY database both pass the guard and
 * then overwrite each other — one tab's key with the other tab's PIN. Inside
 * one transaction that cannot happen, and `init` can never be written apart
 * from the key it belongs to.
 *
 * Returns 'foreign' instead of throwing: VaultMismatchError lives in the store
 * (importing it here would be a cycle), and the caller owns the user-facing
 * error text.
 *
 * BOUNDARY: like every reset-exclusivity check in this file, this sees only
 * resets THIS tab knows about (dbGeneration). A database cleared by another tab
 * whose 'reset' broadcast has not arrived yet is indistinguishable from a
 * never-initialized one — the accepted residual window (see the dbGeneration
 * comment below).
 */
export async function bindVaultIdentity(
  pkB64: string,
  opts: { initialize: boolean; requireQuickUnlock?: QuickUnlockRecord },
  expectedDbGeneration: number,
): Promise<VaultBindResult> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');

    // AUTHORIZATION RE-CHECK, inside the transaction that is the point of no
    // return for identity. Only the quick-unlock path passes this, and only it
    // needs it: its authorization IS a stored record, so deleting the record —
    // or the PIN it depends on — is a REVOCATION, not merely a config change.
    // A check outside this transaction (however late) still leaves the key
    // derivation in prepareVaultSnapshot as a window; here there is none.
    //
    // The PIN path deliberately does NOT use this: its authorization is a
    // proof of knowledge, and removing the PIN elsewhere does not retroactively
    // unprove a PIN the user typed correctly.
    if (opts.requireQuickUnlock) {
      const [pinSeed, rawQuickUnlock] = await Promise.all([
        meta.get('pin-seed'),
        meta.get(QUICK_UNLOCK_META_KEY),
      ]);
      // Both halves matter: «no pin-seed ⇒ the record is void» is the rule an
      // OLDER client trips by clearing the PIN without knowing about the
      // record, and exact equality catches a removal or a re-configuration.
      if (pinSeed === undefined
          || !quickUnlockRecordEquals(parseQuickUnlockRecord(rawQuickUnlock), opts.requireQuickUnlock)) {
        await tx.done; // nothing written
        return 'revoked';
      }
    }

    const saved = await meta.get('vault-public-key') as string | undefined;
    if (saved !== undefined && saved !== pkB64) {
      await tx.done;
      return 'foreign';
    }
    if (saved === undefined) await meta.put(pkB64, 'vault-public-key');
    if (opts.initialize) await meta.put(true, 'init');
    await tx.done;
    return saved === undefined ? 'bound' : 'same';
  } catch (e) {
    // Same rollback discipline as saveNoteWithSync: a failure on the second put
    // must not let the transaction auto-commit with only the first written.
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
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

/** The PIN-configuration wipe itself, as a set of writes on an ALREADY OPEN
 *  meta store. Shared by `clearPinConfigMeta` and the 10th-strike branch of
 *  `commitPinUnlockFailure`, so the two can never drift on WHAT a wipe is —
 *  the strike wipe has to happen inside the metering transaction, and a second
 *  copy of this list is exactly how a key would get forgotten in one of them. */
async function wipePinConfigInto(meta: MetaStoreWriter): Promise<void> {
  await meta.delete('pin-seed');
  await meta.delete('pin-attempts');
  await meta.delete('pin-locked-until');
  // Quick unlock is a SECOND KEY TO THE SAME SEED, gated on the PIN existing.
  // It therefore dies in the SAME transaction as the PIN — manual removal and
  // the 10-strike wipe alike. Doing it here rather than at the call sites is
  // what makes «PIN gone ⇒ quick unlock gone» atomic instead of a two-step
  // sequence with a window in the middle.
  await meta.delete(QUICK_UNLOCK_META_KEY);
  await meta.put(null, 'auto-lock-timeout');
}

export async function clearPinConfigMeta(): Promise<void> {
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    await wipePinConfigInto(tx.objectStore('meta'));
    await tx.done;
  } catch (e) {
    // Same rollback discipline as saveNoteWithSync: an error after the first
    // delete must not let the transaction auto-commit half the cleanup.
    tx.done.catch(() => {}); // swallow the resulting abort rejection (we rethrow e)
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/**
 * First-writer-wins PIN write for the RESTORE flow. ONE readwrite `meta`
 * transaction: `pin-seed` is written ONLY when absent, and the metering is
 * cleared in the same commit so a fresh configuration can never inherit a
 * stale lockout.
 *
 * `false` = another tab configured a PIN first; its blob is left ALONE. The
 * restore flow must not silently replace a PIN the user set elsewhere —
 * replacing one is an explicit action, and it lives in the settings screen.
 *
 * `auto-lock-timeout` is untouched, exactly like the onboarding `setupPin`.
 */
export async function commitPinSeedIfAbsent(
  blob: PinEncryptedSeed,
  expectedDbGeneration: number,
): Promise<boolean> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const existing: unknown = await meta.get('pin-seed');
    if (existing !== undefined) {
      await tx.done;
      return false;
    }
    await meta.put(blob, 'pin-seed');
    await meta.delete('pin-attempts');
    await meta.delete('pin-locked-until');
    await tx.done;
    return true;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

// ─── Main PIN unlock: generation-guarded atomic commits (stage P) ────
//
// The unlock verdict is produced OUTSIDE any transaction (Argon2id runs for
// ~1 s in the store), so every write it triggers has to survive two things
// that can happen inside that second:
//
//  1. a RESET — this tab's «Удалить всё» or another tab's, arriving as a
//     dbGeneration bump. Guarded by assertDbGeneration, exactly like every
//     other write in this file: attempts, a lockout or a re-wrapped blob must
//     never reappear in a database that was just cleared (the resetAll
//     invariant the two-step getMeta+setMeta metering used to break);
//  2. a PIN CHANGE in another tab. dbGeneration does NOT move for that — the
//     database is the same one — so the guard has to be the blob itself: each
//     commit re-reads `pin-seed` inside its own transaction and refuses unless
//     it is still byte-for-byte the blob the verdict was produced against.
//     Without it a wrong-PIN verdict for blob A would meter (and, on the 10th
//     strike, WIPE) configuration B.
//
// Same shape as the safebox commits above — the difference is only the
// ownership token: an opaque configId there, the blob itself here (the main
// PIN's schema has no configId, and adding one would change the stored format
// for no gain: salt and IV are random per wrap, so equal fields ⇔ same blob).

export const MAIN_MAX_PIN_ATTEMPTS = 10;

/** Progressive lockout for the MAIN PIN — the schedule the unlock path has
 *  always used, moved next to the metering that applies it. */
export function mainPinLockSeconds(attempts: number): number {
  if (attempts <= 3) return 0;
  if (attempts <= 5) return 30;
  if (attempts <= 7) return 300;
  return 1800;
}

function isPinSeedRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Semantic equality of two stored PIN blobs — the ONE named answer to «is this
 * still the blob I verified?».
 *
 * Every NORMATIVE field is listed explicitly: `ciphertext`, `iv`, `salt`,
 * `kdf`, `v` and the whole Argon2 profile. Deliberately not `===` (the blob is
 * re-read from IndexedDB, so it is always a different object) and deliberately
 * not `JSON.stringify` (key order is not part of any contract, and a silent
 * schema addition would change the answer without anyone deciding to).
 *
 * Anything that is not an object — `undefined` for «no PIN configured»
 * included — is unequal to everything, which is the fail-safe direction: the
 * caller then writes nothing at all.
 */
export function pinSeedEquals(a: unknown, b: unknown): boolean {
  if (!isPinSeedRecord(a) || !isPinSeedRecord(b)) return false;
  if (a.ciphertext !== b.ciphertext) return false;
  if (a.iv !== b.iv) return false;
  if (a.salt !== b.salt) return false;
  if (a.kdf !== b.kdf) return false;
  if (a.v !== b.v) return false;
  const pa = a.argon2;
  const pb = b.argon2;
  if (pa === undefined || pb === undefined) return pa === pb;
  if (!isPinSeedRecord(pa) || !isPinSeedRecord(pb)) return false;
  return pa.iterations === pb.iterations
    && pa.memorySize === pb.memorySize
    && pa.parallelism === pb.parallelism
    && pa.hashLength === pb.hashLength;
}

/** `'config-changed'` = the `pin-seed` this operation was checking is no
 *  longer the stored one (replaced or removed by another tab). ZERO writes
 *  happened; the outcome belongs to a configuration that no longer exists. */
export type PinCommitOutcome = 'committed' | 'config-changed';

/** Run `apply` in ONE readwrite `meta` transaction, but only while `pin-seed`
 *  is still `expectedPinSeed`. Generation-checked before the transaction is
 *  created (single-threaded JS ⇒ no TOCTOU window), rolled back with
 *  `tx.abort()` on any error — the saveNoteWithSync discipline. */
async function mutateVerifiedPinConfig<T>(
  expectedPinSeed: unknown,
  expectedDbGeneration: number,
  apply: (meta: MetaStoreReadWriter) => Promise<T>,
): Promise<T | 'config-changed'> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta: MetaStoreReadWriter = tx.objectStore('meta');
    const current: unknown = await meta.get('pin-seed');
    if (!pinSeedEquals(current, expectedPinSeed)) {
      await tx.done; // nothing was written — let it commit empty
      return 'config-changed';
    }
    const result = await apply(meta);
    await tx.done;
    return result;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

export interface PinUnlockFailureOutcome {
  outcome: PinCommitOutcome;
  /** Attempts AFTER this one. `0` when `outcome === 'config-changed'` —
   *  nothing was counted, so there is no number to report. */
  attempts: number;
  lockedUntil: number | null;
  /** The 10th strike removed the whole PIN configuration in THIS transaction.
   *  Notes and safebox entries are untouched — seed re-entry it is. */
  wiped: boolean;
}

/**
 * Count one wrong-PIN attempt against the configuration that was actually
 * checked, and apply the progressive lockout — or, on the 10th strike, wipe
 * the configuration, all inside ONE transaction.
 *
 * ONLY a genuine WrongPinError (AES-GCM authentication failure) may reach
 * here. Environment failures never spend an attempt — a project-wide rule the
 * caller owns, and this function has no way to re-check.
 */
export async function commitPinUnlockFailure(
  expectedPinSeed: unknown,
  expectedDbGeneration: number,
): Promise<PinUnlockFailureOutcome> {
  const result = await mutateVerifiedPinConfig(
    expectedPinSeed,
    expectedDbGeneration,
    async (meta): Promise<PinUnlockFailureOutcome> => {
      // A missing, negative or otherwise unusable counter restarts at zero
      // rather than being arithmetic'd into a wipe: storage damage is an
      // environment failure, and those never destroy a working PIN (the same
      // rule that keeps PinUnlockUnavailableError out of the metering).
      const stored = await meta.get('pin-attempts');
      const previous = typeof stored === 'number' && Number.isSafeInteger(stored) && stored > 0
        ? stored
        : 0;
      const attempts = previous + 1;
      if (attempts >= MAIN_MAX_PIN_ATTEMPTS) {
        await wipePinConfigInto(meta);
        return { outcome: 'committed', attempts, lockedUntil: null, wiped: true };
      }
      await meta.put(attempts, 'pin-attempts');
      const lockSeconds = mainPinLockSeconds(attempts);
      const lockedUntil = lockSeconds > 0 ? Date.now() + lockSeconds * 1000 : null;
      if (lockedUntil !== null) await meta.put(lockedUntil, 'pin-locked-until');
      return { outcome: 'committed', attempts, lockedUntil, wiped: false };
    },
  );
  if (result === 'config-changed') {
    return { outcome: 'config-changed', attempts: 0, lockedUntil: null, wiped: false };
  }
  return result;
}

/**
 * Successful unlock: clear the metering — but only if the counters still
 * belong to the configuration that was proved. `'config-changed'` is NOT a
 * failure for the caller: the same seed came out of the blob, so the vault
 * still opens; it is only the counters that are somebody else's now.
 */
export async function commitPinUnlockSuccess(
  expectedPinSeed: unknown,
  expectedDbGeneration: number,
): Promise<PinCommitOutcome> {
  return mutateVerifiedPinConfig(expectedPinSeed, expectedDbGeneration, async meta => {
    await meta.delete('pin-attempts');
    await meta.delete('pin-locked-until');
    return 'committed' as const;
  });
}

/**
 * Transparent legacy PBKDF2 → Argon2id re-wrap, written ONLY over the exact
 * legacy blob that was just unwrapped.
 *
 * «Still legacy» would not be enough: another (older) client can replace one
 * legacy blob with a DIFFERENT legacy blob — a PIN change — and this re-wrap
 * carries the OLD PIN. It would silently make the user's new PIN stop working.
 */
export async function commitPinSeedRewrap(
  expectedPinSeed: unknown,
  newBlob: PinEncryptedSeed,
  expectedDbGeneration: number,
): Promise<PinCommitOutcome> {
  return mutateVerifiedPinConfig(expectedPinSeed, expectedDbGeneration, async meta => {
    await meta.put(newBlob, 'pin-seed');
    return 'committed' as const;
  });
}

// ─── Quick unlock: atomic reader + conditional commits ───────────────

/** One CONSISTENT snapshot of the whole client configuration: FOUR keys read
 *  inside a single readonly transaction, plus the verdict on the quick-unlock
 *  record.
 *
 *  Why four and not «two here, two there»: `getPinConfigMeta()` + a separate
 *  record read are two DIFFERENT transactions, and a single reconcile token
 *  does not fuse them — it orders publications, it does not make two snapshots
 *  one. Bootstrap and the cross-tab config reconcile could otherwise publish a
 *  combination of PIN + threshold + record that never existed at any instant.
 *  The fourth key costs nothing (same transaction) and removes the class.
 *
 *  NOT for the auto-lock verdict: that path runs under VERDICT_DEADLINE_MS and
 *  keeps its two-key `getPinConfigMeta()`. Widening the reader on a deadline
 *  path is forbidden, and a third reader is not to be introduced. */
export interface ClientConfigSnapshot {
  pinSeed: unknown;
  autoLockTimeout: unknown;
  vaultPublicKey: unknown;
  quickUnlock: QuickUnlockVerdict;
}

export async function readClientConfigSnapshot(): Promise<ClientConfigSnapshot> {
  const tx = getDB().transaction('meta', 'readonly');
  const meta = tx.objectStore('meta');
  const [pinSeed, autoLockTimeout, rawQuickUnlock, vaultPublicKey] = await Promise.all([
    meta.get('pin-seed'),
    meta.get('auto-lock-timeout'),
    meta.get(QUICK_UNLOCK_META_KEY),
    meta.get('vault-public-key'),
  ]);
  await tx.done;
  return {
    pinSeed,
    autoLockTimeout,
    vaultPublicKey,
    quickUnlock: judgeQuickUnlock(rawQuickUnlock, pinSeed, vaultPublicKey),
  };
}

/**
 * `'written'` — this tab created the record.
 * `'already-configured'` — a racing tab got there first; its record is LEFT
 *   ALONE (first-writer-wins, the same choice `commitPinSeedIfAbsent` makes).
 *   Last-writer-wins would let two tabs create DIFFERENT credentials and
 *   silently clobber each other's working record while both report success —
 *   which breaks the product invariant that orphaning a platform credential is
 *   always a deliberate act.
 * `'no-pin'` / `'foreign-vault'` — the preconditions failed between the
 *   caller's snapshot and this transaction. Reported separately rather than
 *   folded into `'already-configured'`: they need different, honest messages
 *   («Сначала установите PIN» is not «уже настроен»).
 *
 * All three preconditions are re-checked INSIDE this transaction, because
 * React state (and any snapshot the caller read before the ~2 system prompts
 * of the ceremony) can lag behind another tab by an arbitrary amount.
 */
export type QuickUnlockWriteOutcome = 'written' | 'already-configured' | 'no-pin' | 'foreign-vault';

export async function commitQuickUnlockSeedWrite(
  record: QuickUnlockRecord,
  expectedDbGeneration: number,
): Promise<QuickUnlockWriteOutcome> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const [pinSeed, vaultPublicKey, existing] = await Promise.all([
      meta.get('pin-seed'),
      meta.get('vault-public-key'),
      meta.get(QUICK_UNLOCK_META_KEY),
    ]);

    let outcome: QuickUnlockWriteOutcome = 'written';
    if (pinSeed === undefined) outcome = 'no-pin';
    else if (!quickUnlockBelongsToVault(record, vaultPublicKey)) outcome = 'foreign-vault';
    else if (judgeQuickUnlock(existing, pinSeed, vaultPublicKey).kind === 'valid') outcome = 'already-configured';

    // A record that is present but VOID (unparseable, or bound to another
    // vault) does not block the write — it is not somebody's working setup.
    if (outcome === 'written') await meta.put(record, QUICK_UNLOCK_META_KEY);
    await tx.done;
    return outcome;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/** UNCONDITIONAL removal — for the manual «Удалить быстрый вход» only. The
 *  user is looking at the button; they mean this record, whatever it is. */
export async function commitQuickUnlockSeedDelete(expectedDbGeneration: number): Promise<void> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    await tx.objectStore('meta').delete(QUICK_UNLOCK_META_KEY);
    await tx.done;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/**
 * CONDITIONAL removal — for the automatic paths (a GCM mismatch, a foreign
 * `pk`). While tab A waited on the system sheet, tab B could have removed the
 * record and configured a NEW one; `dbGeneration` does not move for that, so a
 * mismatch computed against A's stale snapshot has no right to delete B's
 * working record. The full record is compared inside the transaction.
 */
export type QuickUnlockConditionalDeleteOutcome = 'deleted' | 'changed' | 'absent';

export async function commitQuickUnlockSeedDeleteIfMatches(
  expected: QuickUnlockRecord,
  expectedDbGeneration: number,
): Promise<QuickUnlockConditionalDeleteOutcome> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const raw: unknown = await meta.get(QUICK_UNLOCK_META_KEY);
    let outcome: QuickUnlockConditionalDeleteOutcome;
    if (raw === undefined) {
      outcome = 'absent';
    } else if (!quickUnlockRecordEquals(parseQuickUnlockRecord(raw), expected)) {
      // Includes «the current record no longer parses»: either way it is not
      // the one whose unwrap failed, so it is not ours to delete here.
      outcome = 'changed';
    } else {
      await meta.delete(QUICK_UNLOCK_META_KEY);
      outcome = 'deleted';
    }
    await tx.done;
    return outcome;
  } catch (e) {
    tx.done.catch(() => {});
    try { tx.abort(); } catch { /* already aborting/aborted */ }
    throw e;
  }
}

/** Housekeeping for an orphaned/invalid record. RE-EVALUATES the verdict
 *  inside its own readwrite transaction: the readonly snapshot that prompted
 *  the cleanup may be stale by now — a `pin-seed` that reappeared between the
 *  two makes the record valid again, and deleting it then would destroy a
 *  working setup. */
export type QuickUnlockCleanupOutcome = 'deleted' | 'kept';

export async function commitQuickUnlockSeedCleanup(
  expectedDbGeneration: number,
): Promise<QuickUnlockCleanupOutcome> {
  assertDbGeneration(expectedDbGeneration);
  const tx = getDB().transaction('meta', 'readwrite');
  try {
    const meta = tx.objectStore('meta');
    const [pinSeed, vaultPublicKey, raw] = await Promise.all([
      meta.get('pin-seed'),
      meta.get('vault-public-key'),
      meta.get(QUICK_UNLOCK_META_KEY),
    ]);
    const stale = judgeQuickUnlock(raw, pinSeed, vaultPublicKey).kind === 'stale';
    if (stale) await meta.delete(QUICK_UNLOCK_META_KEY);
    await tx.done;
    return stale ? 'deleted' : 'kept';
  } catch (e) {
    tx.done.catch(() => {});
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

/** Clear ALL IndexedDB data (notes, safebox, sync, meta). Used for app reset. */
export async function resetAll(): Promise<void> {
  // Bump FIRST: any generation check that runs after this line refuses to
  // write; any write whose check passed earlier lost the transaction-order
  // race and gets cleared below.
  dbGeneration++;
  const database = getDB();
  const tx = database.transaction(['notes', 'safebox', 'sync', 'meta'], 'readwrite');
  await tx.objectStore('notes').clear();
  await tx.objectStore('safebox').clear();
  await tx.objectStore('sync').clear();
  await tx.objectStore('meta').clear();
  await tx.done;
}
