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
 */

import { buildUploadPayload, type UploadResult } from './arweave';
import { bufferToBase64, type EncryptedNote } from './crypto';
import type { SyncRecord } from './storage';
import { toUploading, toAccepted, afterInProgress, afterFailure } from './sync-transitions';

/** Vault keys captured ONCE by the caller before the attempt — refs are never
 *  re-read mid-flight (post-lock they are null; the captured locals stay
 *  valid for the signature that may already be in progress). */
export interface UploadKeys {
  signingKey: Uint8Array;
  ownerHash: string;
  publicKey: Uint8Array;
}

export interface UploadAttemptDeps {
  now(): number;
  /** Live read of vaultEpochRef — compared against the caller's captured epoch. */
  currentEpoch(): number;
  getSyncRecord(noteId: string): Promise<SyncRecord | undefined>;
  setSyncRecord(record: SyncRecord): Promise<void>;
  /** ATOMIC sync+meta write for the v3_disabled result: persists the failure
   *  record AND the v3-uploads-paused marker in one IndexedDB transaction.
   *  Called INSTEAD of setSyncRecord for that branch — sequential writes would
   *  reopen the crash window (error saved, pause lost → burst after unlock). */
  commitV3PausedFailure(record: SyncRecord, pausedAt: number): Promise<void>;
  signPayload(privateKey: Uint8Array, payload: string): Promise<string>;
  uploadViaProxy(bodyText: string, publicKeyB64: string, signature: string): Promise<UploadResult>;
}

export type UploadAttemptOutcome =
  /** Lock happened before the point of no return: no HTTP, no writes. */
  | { kind: 'cancelled' }
  /** Past the point of no return: dispatched and the result persisted. */
  | { kind: 'committed'; result: UploadResult };

export async function runUploadAttempt(
  note: EncryptedNote,
  keys: UploadKeys,
  myEpoch: number,
  deps: UploadAttemptDeps,
): Promise<UploadAttemptOutcome> {
  // A dropped/timed-out TX asks the server to re-verify + re-post (C1).
  const prev = await deps.getSyncRecord(note.noteId);
  const recheck = prev?.needsRecheck === true;

  // 1) Build + sign — locals only. A lock during the (slow) signature is fine:
  //    it is caught at step 2 and the request is never sent.
  const payload = buildUploadPayload(note, keys.ownerHash, deps.now(), recheck, prev?.recovery);
  const bodyText = JSON.stringify(payload);
  const signature = await deps.signPayload(keys.signingKey, bodyText);
  const publicKeyB64 = bufferToBase64(keys.publicKey);

  // 2) ── POINT OF NO RETURN: the ONLY epoch check, BEFORE toUploading ──
  if (deps.currentEpoch() !== myEpoch) return { kind: 'cancelled' };

  // 3) Committed: uploading + dispatch + persist run unconditionally from here.
  await deps.setSyncRecord(toUploading(note.noteId, prev, deps.now()));
  const result = await deps.uploadViaProxy(bodyText, publicKeyB64, signature);

  // 4) EVERY processed result branch persists — none leaves 'uploading'.
  if (result.kind === 'accepted') {
    await deps.setSyncRecord(toAccepted(note.noteId, prev, result, deps.now()));
  } else if (result.kind === 'in_progress') {
    // 409 with a prior accepted TX → restore it; WITHOUT one there is nothing
    // to restore — record a RETRYABLE failure, never a stranded 'uploading'
    // (round-5 #1).
    await deps.setSyncRecord(
      afterInProgress(note.noteId, prev, deps.now())
        ?? afterFailure(note.noteId, prev, recheck, 'in_progress', deps.now()),
    );
  } else if (result.kind === 'v3_disabled') {
    // Worker v3 kill switch: a PAUSE, not an error. The failure record (which
    // preserves txId/recovery/needsRecheck via afterFailure) and the pause
    // marker commit in ONE transaction, still inside the unconditional
    // post-point-of-no-return window (no epoch gate — same as every other
    // result persist).
    const now = deps.now();
    await deps.commitV3PausedFailure(
      afterFailure(note.noteId, prev, recheck, result.error, now),
      now,
    );
  } else {
    const errText = 'error' in result ? result.error : undefined;
    await deps.setSyncRecord(afterFailure(note.noteId, prev, recheck, errText, deps.now()));
  }

  return { kind: 'committed', result };
}
