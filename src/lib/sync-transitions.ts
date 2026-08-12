/**
 * Eternal Notes — pure SyncRecord transition logic.
 *
 * The upload/poll orchestration in store.tsx delegates every SyncRecord
 * mutation here so the recovery-protocol invariants are unit-testable without
 * React or IndexedDB:
 *  - the server-signed `recovery` hint survives every non-terminal transition
 *    (uploading, 409, transient failures);
 *  - an accepted txId is never downgraded or lost by a transient failure;
 *  - `confirmed` becomes terminal ONLY after server reconciliation finished
 *    (needsRecheck cleared by an authoritative committed:true).
 *
 * EVERY transition below rebuilds the record FROM SCRATCH. Any field that is
 * not threaded through explicitly is therefore silently dropped — which is why
 * `kind` is a REQUIRED parameter (a safebox record demoted to a note would
 * corrupt both sets of counters) and `terminalError` is carried over
 * explicitly (it used to be lost here; harmless only because quarantined
 * records never re-enter the queue).
 */

import type { SyncRecord } from './storage';
import type { RecoveryHint, TxStatusResult } from './arweave';

export type SyncKind = SyncRecord['kind'];

/** Transition into 'uploading' before a proxy attempt. Preserves the prior
 *  txId + recheck intent + recovery proof — a crash or aborted request mid-
 *  recheck must not lose the accepted TX or its only signed recovery hint. */
export function toUploading(
  noteId: string,
  kind: SyncKind,
  prev: SyncRecord | undefined,
  now: number,
): SyncRecord {
  return {
    noteId,
    kind,
    txId: prev?.txId,
    status: 'uploading',
    transport: 'proxy',
    updatedAt: now,
    needsRecheck: prev?.needsRecheck === true,
    recovery: prev?.recovery,
    terminalError: prev?.terminalError,
  };
}

/** Server accepted the upload (200). needsRecheck clears ONLY on a confirmed
 *  server commit; recovery persists until committed (fresh hint wins). */
export function toAccepted(
  noteId: string,
  kind: SyncKind,
  prev: SyncRecord | undefined,
  result: { txId: string; committed: boolean; recovery?: RecoveryHint },
  now: number,
): SyncRecord {
  return {
    noteId,
    kind,
    txId: result.txId,
    status: 'accepted',
    transport: 'proxy',
    updatedAt: now,
    needsRecheck: !result.committed,
    recovery: result.committed ? undefined : (result.recovery ?? prev?.recovery),
    terminalError: prev?.terminalError,
  };
}

/** 409 — a server reservation is alive. Restore the prior accepted state so
 *  txId/recovery aren't stranded in 'uploading' if the app closes now.
 *  Returns null when there is nothing to restore (never accepted). */
export function afterInProgress(
  noteId: string,
  kind: SyncKind,
  prev: SyncRecord | undefined,
  now: number,
): SyncRecord | null {
  if (!prev?.txId) return null;
  return {
    noteId,
    kind,
    txId: prev.txId,
    status: 'accepted',
    transport: 'proxy',
    updatedAt: now,
    needsRecheck: true,
    recovery: prev.recovery,
    terminalError: prev.terminalError,
  };
}

/** Non-definitive outcome (unavailable / rate_limited / not_registered / error).
 *  An already-accepted note keeps 'accepted' + txId + recovery and stays in the
 *  recheck loop; only a never-accepted note becomes a hard 'error'. */
export function afterFailure(
  noteId: string,
  kind: SyncKind,
  prev: SyncRecord | undefined,
  wasRecheck: boolean,
  errText: string | undefined,
  now: number,
): SyncRecord {
  if (prev?.txId) {
    return {
      noteId,
      kind,
      txId: prev.txId,
      status: 'accepted',
      transport: 'proxy',
      updatedAt: now,
      needsRecheck: true,
      lastError: errText,
      recovery: prev.recovery,
      terminalError: prev.terminalError,
    };
  }
  return {
    noteId,
    kind,
    status: 'error',
    transport: 'proxy',
    lastError: errText,
    updatedAt: now,
    needsRecheck: wasRecheck,
    recovery: prev?.recovery,
    terminalError: prev?.terminalError,
  };
}

/** Restore-UI decision: should this restored note be ADDED to the visible list
 *  (and counted in «Восстановлено N»)? Claims the id in `visibleIds` on true,
 *  so a repair of an already-visible note — or a second occurrence of the same
 *  id — never inflates the counter. */
export function claimRestoredForUi(visibleIds: Set<string>, noteId: string): boolean {
  if (visibleIds.has(noteId)) return false;
  visibleIds.add(noteId);
  return true;
}

/** Polling transition for an 'accepted' record. Returns the next record, or
 *  null when nothing must change ('unavailable' gateway, fresh pending, or a
 *  confirmation that must wait for server reconciliation). */
export function afterPoll(
  record: SyncRecord,
  status: TxStatusResult,
  now: number,
  confirmThreshold: number,
  txTimeoutMs: number,
): SyncRecord | null {
  if (status.kind === 'confirmed' && status.confirmations >= confirmThreshold) {
    // Terminal ONLY when reconciliation is done: a needsRecheck record still
    // owes the server a commit/quota fix — confirming it would drop it from
    // the queue with the DO stuck in `posted` (or without any anchor) forever.
    if (record.needsRecheck) return null;
    return { ...record, status: 'confirmed', needsRecheck: false, updatedAt: now };
  }
  if (status.kind === 'dropped' || status.kind === 'invalid') {
    return record.needsRecheck ? null : { ...record, needsRecheck: true, updatedAt: now };
  }
  if (status.kind === 'pending' && (now - record.updatedAt) > txTimeoutMs) {
    return record.needsRecheck ? null : { ...record, needsRecheck: true, updatedAt: now };
  }
  return null; // unavailable / fresh pending / below threshold → no change
}
