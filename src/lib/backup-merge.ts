/**
 * Eternal Notes — the backup import merge rules, as a pure decision function.
 *
 * Import is a MERGE, never a replacement, and every case it can meet is
 * decided here rather than inside a transaction: the rules are the part worth
 * reading, and keeping them pure makes the whole table testable without
 * IndexedDB — the same reason `sync-transitions.ts` exists.
 *
 * Two things this function will never do, whatever the input:
 *  - write a `txId`. A file cannot prove «these bytes were published by that
 *    transaction», so the link to a publication is established by the server
 *    and by nothing else;
 *  - create a quarantine. The container carries no sync store, so a
 *    `terminalError` from a file does not exist as a phenomenon. Only the fate
 *    of a LOCAL quarantine is decided, and only by its reason.
 *
 * The order below is the rule order, and it is load-bearing.
 */

import type { SyncRecord } from './storage';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import { publicationEquivalent, type PublicationSubject } from './publication-equivalent';

/** What this build can make of the LOCAL payload. Determined by actually
 *  trying to decrypt it — which is asynchronous, and therefore happens BEFORE
 *  the transaction (D13); the transaction only re-checks that the row has not
 *  moved since. */
export type LocalPayloadState =
  /** No local payload row at all. A sync row may still exist. */
  | 'absent'
  /** Decrypts with this build. */
  | 'readable'
  /** Present but unusable: AEAD authentication failed. Provably damaged. */
  | 'corrupt'
  /** A version this build cannot read — possibly written by a NEWER one. */
  | 'opaque';

/**
 * What happened to one record. Every value is a distinct user-visible outcome
 * except `noop`, which is deliberately NOT counted anywhere (§4): an incoming
 * record that is already present and publication-equivalent has been fully
 * honoured, and counting it as skipped would make a complete, correctly
 * applied import report itself as incomplete.
 */
export type BackupMergeOutcome =
  | 'added'
  | 'repaired'
  | 'quarantinedRepaired'
  | 'quarantinedDataRepaired'
  | 'quarantineStale'
  | 'unsupportedLocal'
  | 'conflicts'
  | 'deferred'
  | 'noop';

export interface BackupMergeInput {
  id: string;
  kind: SyncRecord['kind'];
  /** The record from the file — already schema-validated by `backup.ts`. */
  incoming: EncryptedNote | EncryptedSafeboxEntry;
  /** The local payload the classification was computed from, if any. */
  local: EncryptedNote | EncryptedSafeboxEntry | undefined;
  localState: LocalPayloadState;
  /** The CURRENT sync row, re-read inside the transaction. */
  sync: SyncRecord | undefined;
  now: number;
}

export interface BackupMergeDecision {
  /** Write `incoming` into the payload store. */
  writePayload: boolean;
  /** The sync row to write, or `null` to leave whatever is there untouched. */
  sync: SyncRecord | null;
  outcome: BackupMergeOutcome;
}

const leave = (outcome: BackupMergeOutcome): BackupMergeDecision =>
  ({ writePayload: false, sync: null, outcome });

/** A retryable, publication-free row: the record must be sent again, and this
 *  import has nothing truthful to say about any transaction. */
const retryable = (id: string, kind: SyncRecord['kind'], now: number): SyncRecord =>
  ({ noteId: id, kind, status: 'error', transport: 'proxy', updatedAt: now });

/** Is this record one the local build simply cannot judge? An opaque payload is
 *  never replaced, under ANY rule: it may be a NEWER format, and overwriting it
 *  from an older backup would destroy data that is not recoverable elsewhere. */
const isOpaque = (state: LocalPayloadState) => state === 'opaque';

/** Damaged or missing — the two states in which the file's copy is strictly
 *  better than what is on disk. */
const needsPayload = (state: LocalPayloadState) => state === 'absent' || state === 'corrupt';

export function decideBackupMerge(input: BackupMergeInput): BackupMergeDecision {
  const { id, kind, incoming, local, localState, sync, now } = input;

  // ── Rule 1: a LOCAL quarantine decides by its REASON ────────────────
  //
  // Not by whether a txId is present — that was the old formula and it was
  // wrong. «Can these bytes be read again?» and «may this record be
  // published?» are different questions, and only the second one is what
  // publication_conflict and recovery_invalidated actually forbid.
  //
  // Rule 0 (a live upload) is checked by the caller BEFORE this function: it
  // needs the freshness window, and it is a full no-op including the payload.
  if (sync?.terminalError !== undefined) {
    const reason = sync.terminalError;

    // An opaque local record is never replaced, whatever the reason. The
    // quarantine and the bytes both stay exactly as they are.
    if (isOpaque(localState)) return leave('unsupportedLocal');

    if (reason === 'unsupported_version' || reason === 'malformed_record') {
      if (localState === 'readable') {
        // The sentence has expired: it said «this build cannot handle such a
        // record», and this build just read it. Lifting it is honest, and the
        // readable payload is NOT touched.
        return { writePayload: false, sync: retryable(id, kind, now), outcome: 'quarantineStale' };
      }
      if (reason === 'malformed_record' && needsPayload(localState)) {
        // Provably damaged bytes, repaired from the file. Safe precisely
        // because they are damaged rather than newer — and txId/recovery go
        // with them, because they described the bytes that are gone.
        return { writePayload: true, sync: retryable(id, kind, now), outcome: 'quarantinedRepaired' };
      }
      // 'unsupported_version' with damaged or missing bytes is a state the
      // table calls impossible (that reason cannot produce an AEAD failure).
      // If it happens anyway, fail closed: never replace, never lift.
      return leave('unsupportedLocal');
    }

    // publication_conflict / recovery_invalidated forbid PUBLISHING, not
    // READING. Blocking a repair with them would be dishonest — but their
    // evidence (terminalError, txId, recovery) is preserved untouched, and the
    // record stays out of the queue.
    if (needsPayload(localState)) {
      return { writePayload: true, sync: null, outcome: 'quarantinedDataRepaired' };
    }
    return leave('noop'); // readable and blocked: nothing to do, nothing to say
  }

  // ── Rule 2: a readable local payload is never overwritten ───────────
  if (localState === 'readable') {
    const equivalent = local !== undefined && samePublication(kind, local, incoming);
    // Equivalent → the record is already honoured; NOT counted (§4).
    // Different → a genuine conflict this phase does not resolve: nothing is
    // written, and the user is told the file still holds something they do not
    // have locally.
    return leave(equivalent ? 'noop' : 'conflicts');
  }

  // ── Rule 3: bytes that are missing or unusable are restored ─────────
  if (isOpaque(localState)) {
    // No quarantine yet, but still unreadable here: a newer format. Same
    // protection as under rule 1 — never replaced.
    return leave('unsupportedLocal');
  }

  // Any existing sync row is replaced UNCONDITIONALLY by a retryable one — not
  // «if it carries a txId». An `accepted`/`confirmed` row WITHOUT a txId is
  // dead too: the queue skips it by status and polling skips it for want of a
  // txId, so leaving it would restore data that will never be sent. If there
  // is no row, none is created: the record then looks new, which it is.
  return {
    writePayload: true,
    sync: sync === undefined ? null : retryable(id, kind, now),
    outcome: localState === 'absent' ? 'added' : 'repaired',
  };
}

/** `publicationEquivalent` over the pair, with the kind supplied by the caller
 *  rather than sniffed off either record. Total by construction — an
 *  unsupported version or a malformed row reads as «not equivalent». */
function samePublication(
  kind: SyncRecord['kind'],
  local: EncryptedNote | EncryptedSafeboxEntry,
  incoming: EncryptedNote | EncryptedSafeboxEntry,
): boolean {
  const subject = (record: EncryptedNote | EncryptedSafeboxEntry): PublicationSubject =>
    kind === 'note'
      ? { kind: 'note', record: record as EncryptedNote }
      : { kind: 'safebox', record: record as EncryptedSafeboxEntry };
  return publicationEquivalent(subject(local), subject(incoming));
}
