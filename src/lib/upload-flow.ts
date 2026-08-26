/**
 * Eternal Notes — single upload attempt state-machine (§7 auto-lock plan).
 *
 * The invariant this module exists for (round-5 blocker): ONE epoch check,
 * placed BEFORE the `toUploading` write, is the upload's point of no return.
 *
 *  - BEFORE it (payload build + signature): a lock cancels the attempt — no
 *    HTTP request is dispatched and NOTHING is written to IndexedDB.
 *  - AFTER it the upload is COMMITTED: `toUploading` → dispatch → result
 *    persist run unconditionally, with no further epoch checks. A lock during
 *    this window cannot cancel the in-flight HTTP request anyway, so the only
 *    safe course is to record its outcome — every processed result branch
 *    persists, and none leaves the record in 'uploading'. (A hard kill between
 *    `toUploading` and the persist is recovered by the existing stale-upload
 *    mechanism, ~10 min.)
 *
 * Extracted from store.tsx with injected deps so these guarantees are
 * unit-testable without React/IndexedDB. React-state side effects (registration
 * flag, lastSync, counters) stay in the store, gated on the CURRENT epoch.
 *
 * The attempt is kind-agnostic: the caller passes a QUEUE ITEM tagged
 * 'note' | 'safebox' (never a shape sniff on the record read back from
 * IndexedDB), and the payload builder / pause-commit are selected from it.
 */

import { buildUploadPayload, buildSafeboxUploadPayload, type UploadResult } from './arweave';
import {
  bufferToBase64,
  base64ToBuffer,
  isCanonicalBase64,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import type { BeginUploadOutcome, SyncRecord } from './storage';
import {
  toAccepted,
  afterInProgress,
  afterFailure,
  toRecoveryInvalidated,
} from './sync-transitions';

/** Vault keys captured ONCE by the caller before the attempt — refs are never
 *  re-read mid-flight (post-lock they are null; the captured locals stay
 *  valid for the signature that may already be in progress). */
export interface UploadKeys {
  signingKey: Uint8Array;
  ownerHash: string;
  publicKey: Uint8Array;
}

/** A queue item. `kind` is the ONLY dispatch signal — the record itself is
 *  never shape-sniffed (a corrupted row must fail validation, not silently
 *  serialize as the other version). */
export type UploadItem =
  | { kind: 'note'; record: EncryptedNote }
  | { kind: 'safebox'; record: EncryptedSafeboxEntry };

/** Stable id of a queue item across both stores. */
export function uploadItemId(item: UploadItem): string {
  return item.kind === 'note' ? item.record.noteId : item.record.entryId;
}

export interface UploadAttemptDeps {
  now(): number;
  /** Live read of vaultEpochRef — compared against the caller's captured epoch. */
  currentEpoch(): number;
  getSyncRecord(noteId: string): Promise<SyncRecord | undefined>;
  /** ATOMIC begin (storage.beginUploadUnlessTerminal + the reset guard): in ONE
   *  transaction re-read the current row, REFUSE if quarantined, else write
   *  'uploading' built from the FRESH row. Two refusals are possible:
   *  'blocked' (quarantined) and 'stale' (the stored bytes no longer match the
   *  snapshot this body was signed from, D14); on either, the caller
   *  dispatches NO HTTP. On success the row carries a fresh `attemptId`
   *  (D14a). Direct setSyncRecord is banned on this path: between the queue's
   *  `prev` read and this write another tab may have quarantined the record,
   *  and a plain put would erase that.
   *
   *  The snapshot passed here is the QUEUE ITEM — the very object the body was
   *  built from a few lines earlier, never a re-read. */
  beginUpload(item: UploadItem, now: number): Promise<BeginUploadOutcome>;
  /** Attempt-scoped, terminal-preserving result persist
   *  (storage.commitUploadResultIfAttempt + the reset guard): applies
   *  build(fresh) in one transaction unless the row is quarantined or no
   *  longer belongs to this attempt. A late result must neither erase an
   *  established quarantine nor land on bytes another writer has replaced —
   *  whatever the request's outcome was (D14a). */
  commitResult(
    noteId: string,
    attemptId: string,
    build: (fresh: SyncRecord | undefined) => SyncRecord | null,
  ): Promise<void>;
  /** ATOMIC sync+meta write for a vN_disabled result: persists the failure
   *  record (terminal-preserving, like commitResult) AND that version's
   *  uploads-paused marker in one IndexedDB transaction. Called INSTEAD of
   *  commitResult for that branch — sequential writes would reopen the crash
   *  window (error saved, pause lost → burst after unlock).
   *
   *  The MARKER is written even when the record half is skipped by the
   *  attempt-CAS: it is state about the worker's kill switch, not about this
   *  attempt. */
  commitV3PausedFailure(
    noteId: string,
    attemptId: string,
    build: (fresh: SyncRecord | undefined) => SyncRecord,
    pausedAt: number,
  ): Promise<void>;
  commitV4PausedFailure(
    noteId: string,
    attemptId: string,
    build: (fresh: SyncRecord | undefined) => SyncRecord,
    pausedAt: number,
  ): Promise<void>;
  signPayload(privateKey: Uint8Array, payload: string): Promise<string>;
  uploadViaProxy(bodyText: string, publicKeyB64: string, signature: string): Promise<UploadResult>;
}

/** The stored row failed runtime validation right before serialization.
 *  PERMANENT quarantine (terminalError:'malformed_record') — no HTTP is made
 *  and no retry can ever change the outcome. */
export class MalformedRecordError extends Error {
  constructor(why: string) {
    super(`Malformed record: ${why}`);
    this.name = 'MalformedRecordError';
  }
}

/** Any RFC-shaped UUID, capturing the version nibble — the same regex shape the
 *  worker's namespace barrier uses (`worker/src/index.ts`), so the two sides
 *  cannot disagree about what «a valid id» means. */
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The id namespace barrier, enforced on the CLIENT before anything is signed.
 *
 * v1/v2 ids are UUIDv4 and v3/v4 ids are UUIDv8 — DISJOINT namespaces, and the
 * worker rejects a mismatch with a plain 400. Leaving the check to the server
 * is not free: a plain 400 is not typed, so the client turns it into a
 * RETRYABLE error (`arweave.ts`), the record returns to the queue on every
 * pass, and a single corrupted row becomes an endless request loop. Nothing is
 * ever published and no wallet is spent, but the loop burns the shared IP rate
 * limit and can crowd out healthy uploads.
 *
 * So the row is quarantined here instead: `MalformedRecordError` → permanent
 * local `malformed_record`, with no HTTP at all. Retrying could only ever
 * reproduce the same rejection.
 */
function assertIdNamespace(id: unknown, expected: '4' | '8', field: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new MalformedRecordError(field);
  const match = UUID_ANY.exec(id);
  if (!match) throw new MalformedRecordError(`${field} uuid`);
  if (match[1].toLowerCase() !== expected) throw new MalformedRecordError(`${field} namespace`);
}

/**
 * Canonical base64, not merely decodable (D14b). `atob` accepts missing
 * padding, embedded whitespace and non-zero trailing bits, so the SAME bytes
 * have many accepted spellings — and the spelling is what gets published: the
 * outer `data` is a JSON string, so two spellings are two different
 * publications with two different fingerprints under one permanent id.
 */
function assertCanonicalBase64(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new MalformedRecordError(field);
  if (!isCanonicalBase64(value)) throw new MalformedRecordError(`${field} base64`);
  return base64ToBuffer(value);
}

function assertIv12(value: unknown, field: string): void {
  const bytes = assertCanonicalBase64(value, field);
  if (bytes.byteLength !== 12) throw new MalformedRecordError(`${field} length`);
}

/** AES-GCM output is plaintext + a 128-bit tag, so ANY genuine ciphertext this
 *  app produces is at least 16 bytes — an empty plaintext still carries the
 *  tag. */
const GCM_TAG_BYTES = 16;

function assertCiphertext(value: unknown, field: string): void {
  const bytes = assertCanonicalBase64(value, field);
  // Shorter than the tag = provably not something AES-GCM produced. Without
  // this the row passes validation and gets PUBLISHED under a permanent,
  // per-id idempotency — paid, irreversible, and undecryptable forever. Being
  // valid base64 says nothing about being a cipher envelope.
  if (bytes.byteLength < GCM_TAG_BYTES) throw new MalformedRecordError(`${field} length`);
}

/**
 * IndexedDB is an untrusted runtime boundary: a row corrupted on disk (or
 * written by a build with a different shape) must be quarantined BEFORE the
 * signed body is built, never posted under the permanent per-id idempotency.
 */
export function assertUploadableItem(item: UploadItem): void {
  if (item.kind === 'note') {
    const n = item.record;
    // The namespace expected for THIS record's version. An unrecognized `v` is
    // deliberately NOT judged here: the payload builder raises
    // UnsupportedNoteVersionError for it, and that distinction is load-bearing.
    // D5a treats an OPAQUE record — one a newer build wrote — differently from
    // a malformed one, and must never replace it; labelling it
    // 'malformed_record' here would throw that protection away.
    if (n.v === undefined || n.v === 1 || n.v === 2) assertIdNamespace(n.noteId, '4', 'noteId');
    else if (n.v === 3) assertIdNamespace(n.noteId, '8', 'noteId');
    else if (typeof n.noteId !== 'string' || n.noteId.length === 0) throw new MalformedRecordError('noteId');
    if (!Number.isSafeInteger(n.createdAt) || n.createdAt < 0) throw new MalformedRecordError('createdAt');
    assertCiphertext(n.ciphertext, 'ciphertext');
    assertIv12(n.iv, 'iv');
    return;
  }
  const e = item.record;
  if (e.v !== 4) throw new MalformedRecordError('safebox v');
  assertIdNamespace(e.entryId, '8', 'entryId');
  if (!Number.isSafeInteger(e.createdAt) || e.createdAt < 0) throw new MalformedRecordError('createdAt');
  assertCiphertext(e.metaCiphertext, 'metaCiphertext');
  assertIv12(e.metaIv, 'metaIv');
  assertCiphertext(e.secretCiphertext, 'secretCiphertext');
  assertIv12(e.secretIv, 'secretIv');
}

export type UploadAttemptOutcome =
  /** Lock happened before the point of no return: no HTTP, no writes. */
  | { kind: 'cancelled' }
  /** The record was quarantined (terminalError) between enqueue and the atomic
   *  begin — e.g. by another tab. No HTTP was dispatched, nothing written. */
  | { kind: 'blocked' }
  /** The stored payload changed between the queue snapshot and the atomic
   *  begin — a restore or an import replaced it (D14). No HTTP was dispatched
   *  and nothing was written: the signed body describes bytes the store no
   *  longer has. The record keeps its previous status, so the next queue pass
   *  picks it up again with the CURRENT bytes. */
  | { kind: 'stale' }
  /** Past the point of no return: dispatched and the result persisted. */
  | { kind: 'committed'; result: UploadResult };

export async function runUploadAttempt(
  item: UploadItem,
  keys: UploadKeys,
  myEpoch: number,
  deps: UploadAttemptDeps,
): Promise<UploadAttemptOutcome> {
  const id = uploadItemId(item);
  const kind = item.kind;

  // 0) Fail-closed shape validation of the STORED row (untrusted boundary).
  //    Throws MalformedRecordError → the caller quarantines it permanently,
  //    with no HTTP request and nothing written to the sync record here.
  assertUploadableItem(item);

  // A dropped/timed-out TX asks the server to re-verify + re-post (C1).
  const prev = await deps.getSyncRecord(id);
  const recheck = prev?.needsRecheck === true;

  // 1) Build + sign — locals only. A lock during the (slow) signature is fine:
  //    it is caught at step 2 and the request is never sent.
  const payload = item.kind === 'note'
    ? buildUploadPayload(item.record, keys.ownerHash, deps.now(), recheck, prev?.recovery)
    : buildSafeboxUploadPayload(item.record, keys.ownerHash, deps.now(), recheck, prev?.recovery);
  const bodyText = JSON.stringify(payload);
  const signature = await deps.signPayload(keys.signingKey, bodyText);
  const publicKeyB64 = bufferToBase64(keys.publicKey);

  // 2) ── POINT OF NO RETURN: the ONLY epoch check, BEFORE the begin write ──
  if (deps.currentEpoch() !== myEpoch) return { kind: 'cancelled' };

  // 3) Atomic begin: re-read + refuse-if-terminal + 'uploading' in ONE
  //    transaction. A refusal means another writer quarantined the record
  //    between enqueue and here — the attempt stops with NO HTTP dispatched.
  //    Past a successful begin the upload is committed: dispatch + persist run
  //    unconditionally, with no further epoch checks.
  //    The payload-CAS compares against the SNAPSHOT `item` — the same object
  //    step 1 serialized and signed — so «what is about to be sent» and «what
  //    is checked» cannot drift apart.
  const began = await deps.beginUpload(item, deps.now());
  if (!began.ok) return { kind: began.reason };
  const attemptId = began.attemptId;
  const result = await deps.uploadViaProxy(bodyText, publicKeyB64, signature);

  // 4) EVERY processed result branch persists through the attempt-scoped,
  //    terminal-preserving commit — none leaves 'uploading', none can erase a
  //    quarantine set while the request was in flight, and none can be applied
  //    to a row this attempt no longer owns (D14a). Applying only the SUCCESS
  //    branch under the attempt check would be worse than useless: a late
  //    `in_progress` or 5xx landing on someone else's row is the same defect
  //    with a different value. Builders receive the FRESH row (the
  //    re-read happens inside the commit's transaction), so late results
  //    cannot resurrect stale state either.
  if (result.kind === 'accepted') {
    await deps.commitResult(id, attemptId, fresh => toAccepted(id, kind, fresh, result, deps.now()));
  } else if (result.kind === 'in_progress') {
    // 409 with a prior accepted TX → restore it; WITHOUT one there is nothing
    // to restore — record a RETRYABLE failure, never a stranded 'uploading'
    // (round-5 #1).
    await deps.commitResult(id, attemptId, fresh =>
      afterInProgress(id, kind, fresh, deps.now())
        ?? afterFailure(id, kind, fresh, recheck, 'in_progress', deps.now()));
  } else if (result.kind === 'v3_disabled' || result.kind === 'v4_disabled') {
    // Worker kill switch: a PAUSE, not an error. The failure record (which
    // preserves txId/recovery/needsRecheck via afterFailure) and the pause
    // marker commit in ONE transaction, still inside the unconditional
    // post-point-of-no-return window (no epoch gate — same as every other
    // result persist). The marker written is the one for the version the
    // SERVER refused, never the item's kind (they always agree, but the
    // server's answer is the authority).
    const now = deps.now();
    if (result.kind === 'v3_disabled') {
      await deps.commitV3PausedFailure(id, attemptId, fresh => afterFailure(id, kind, fresh, recheck, result.error, now), now);
    } else {
      await deps.commitV4PausedFailure(id, attemptId, fresh => afterFailure(id, kind, fresh, recheck, result.error, now), now);
    }
  } else if (result.kind === 'recovery_invalid') {
    // The server rejected the signed recovery proof (rotated key / forged
    // hint): PERMANENT quarantine instead of an endless recheck of a
    // guaranteed failure. txId + the hint are preserved as evidence; only
    // proof-bearing paths (seed restore) may clear this state.
    await deps.commitResult(id, attemptId, fresh => toRecoveryInvalidated(id, kind, fresh, result.error, deps.now()));
  } else {
    const errText = 'error' in result ? result.error : undefined;
    await deps.commitResult(id, attemptId, fresh => afterFailure(id, kind, fresh, recheck, errText, deps.now()));
  }

  return { kind: 'committed', result };
}
