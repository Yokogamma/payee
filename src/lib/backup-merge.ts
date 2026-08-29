/**
 * Eternal Notes — the backup import merge rules, as a pure decision function.
 *
 * Import is a MERGE, never a replacement, and every case it can meet is
 * decided here rather than inside a transaction: the rules are the part worth
 * reading, and keeping them pure makes the whole table testable without
 * IndexedDB — the same reason `sync-transitions.ts` exists.
 *
 * Three things this function will never do, whatever the input:
 *  - write a `txId`. A file cannot prove «these bytes were published by that
 *    transaction», so the link to a publication is established by the server
 *    and by nothing else;
 *  - create a quarantine. The container carries no sync store, so a
 *    `terminalError` from a file does not exist as a phenomenon. Only the fate
 *    of a LOCAL quarantine is decided, and only by its reason. That promise
 *    extends to quarantines created INDIRECTLY, which is why the file's bytes
 *    must pass the upload shape barrier before they are written at all;
 *  - report a repair it did not make. Lifting a quarantine and writing bytes
 *    the queue will refuse is worse than doing nothing: the user is told the
 *    record is back while it is on its way to being quarantined again.
 *
 * The order below is the rule order, and it is load-bearing.
 */

import type { SyncRecord } from './storage';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import { publicationEquivalent, type PublicationSubject } from './publication-equivalent';
// The question «is this record still malformed?» IS «would the upload barrier
// reject it?». Reusing that barrier keeps ONE definition of a well-formed
// record; a second one here would drift and re-quarantine what this module
// just declared repaired.
import { assertUploadableItem, type UploadItem } from './upload-flow';

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
  | 'skipped'
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

/**
 * The rules, plus the one refusal that is not a rule: bytes from the FILE must
 * pass the same shape barrier the upload path applies before signing (D14b).
 *
 * It sits here, over the whole decision, rather than at each write site, so no
 * later branch can quietly escape it — and it is applied even though stage A
 * classified the file already, because this writer does not trust its caller,
 * for the same reason the worker does not trust the client.
 *
 * Why it is not a mis-count. A record that decrypts but violates the shape is
 * not healthy: the queue quarantines it as `malformed_record` on its very next
 * pass, so writing it would make the import CREATE a quarantine — which D8 (2)
 * forbids outright. Worse in the D5a cell where a damaged local payload is
 * repaired from the file: that same write also LIFTS the existing quarantine
 * and reports `quarantinedRepaired`, a repair that did not happen, announced
 * to a user who is deciding whether the file is still needed.
 *
 * The outcome is `skipped` rather than a silent no-op: nothing was applied,
 * and «осталось непримененным» is exactly what that counter is for (§4).
 *
 * SCOPE, because it is easy to read this as broader than it is: the barrier
 * gates the WRITE. Branches that write nothing are decided by the LOCAL row
 * and are not affected by the file's shape — `quarantineStale` lifts a
 * quarantine because the local payload reads and passes the barrier, not
 * because of anything in the file. Running the check before the rules instead
 * would turn «the local record is present and publication-equivalent» into
 * `skipped` whenever the file's copy differs in a field that never reaches the
 * chain — and a complete, correctly applied import would report itself
 * incomplete, which is the one thing §4 spends a paragraph forbidding.
 */
export function decideBackupMerge(input: BackupMergeInput): BackupMergeDecision {
  const decision = decide(input);
  if (!decision.writePayload) return decision;
  return passesUploadShape(input.kind, input.incoming) ? decision : leave('skipped');
}

function decide(input: BackupMergeInput): BackupMergeDecision {
  const { id, kind, incoming, local, localState, sync, now } = input;

  // ── The conflict check is ORTHOGONAL to everything below ────────────
  //
  // A readable local payload that DIFFERS from the file is a conflict, and it
  // stays one whatever else is true of the record — quarantined or not, and
  // whatever the quarantine's reason. This has to come first, because every
  // branch further down answers a question about the LOCAL row and none of
  // them looks at the file at all.
  //
  // Letting a quarantine short-circuit this was a silent data-loss path, not a
  // cosmetic mis-count: the file's bytes were not applied, nothing was
  // counted, so the import could report complete success, clear the
  // provisional `incompleteRestore`, and leave the user confident enough to
  // delete the only copy of a record they no longer have.
  //
  // Nothing is written in this case — not even a stale quarantine is lifted.
  // Lifting one while refusing the bytes would mix two decisions that happen
  // to be adjacent, and the user is being told about the conflict anyway.
  if (localState === 'readable' && !samePublication(kind, local, incoming)) {
    return leave('conflicts');
  }

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

    // The two «version» reasons look alike but expire on DIFFERENT evidence.
    if (reason === 'unsupported_version') {
      if (localState === 'readable') {
        // The sentence has expired on its own terms: it said «this build
        // cannot handle such a record», and this build just read it. Lifting
        // it is honest, and the readable payload is NOT touched.
        return { writePayload: false, sync: retryable(id, kind, now), outcome: 'quarantineStale' };
      }
      // Damaged or missing bytes under this reason is a state the table calls
      // impossible (it cannot produce an AEAD failure). If it happens anyway,
      // fail closed: never replace, never lift.
      return leave('unsupportedLocal');
    }

    if (reason === 'malformed_record') {
      if (localState === 'readable') {
        // «Readable» is NOT the evidence this reason expires on. It is set for
        // SHAPE violations — a negative createdAt, an id from the wrong UUID
        // namespace, non-canonical base64, a ciphertext shorter than the GCM
        // tag — and none of those is disproved by a successful decryption. A
        // record can decrypt perfectly and still be unsendable.
        //
        // So the quarantine is lifted only if the record now passes the very
        // barrier that set it. Otherwise it stays, and the outcome is
        // `skipped` rather than a silent no-op: reporting a repair that did
        // not happen would be worse than reporting nothing, because the next
        // queue pass quarantines it again and the user is left with a
        // «restored» record that never sends.
        return passesUploadShape(kind, local)
          ? { writePayload: false, sync: retryable(id, kind, now), outcome: 'quarantineStale' }
          : leave('skipped');
      }
      if (needsPayload(localState)) {
        // Provably damaged bytes, repaired from the file. Safe precisely
        // because they are damaged rather than newer — and txId/recovery go
        // with them, because they described the bytes that are gone.
        return { writePayload: true, sync: retryable(id, kind, now), outcome: 'quarantinedRepaired' };
      }
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
  // Only the EQUIVALENT case can reach this line — the differing one was
  // answered above. The record is already honoured, so it is NOT counted (§4):
  // counting it would make a complete, correctly applied import report itself
  // as incomplete.
  if (localState === 'readable') return leave('noop');

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

/** Would the upload path accept this record as it stands? Total by
 *  construction: any refusal — including a version this build cannot serialize
 *  — reads as «no». */
function passesUploadShape(
  kind: SyncRecord['kind'],
  record: EncryptedNote | EncryptedSafeboxEntry | undefined,
): boolean {
  if (record === undefined) return false;
  try {
    assertUploadableItem({ kind, record } as UploadItem);
    return true;
  } catch {
    return false;
  }
}

/** `publicationEquivalent` over the pair, with the kind supplied by the caller
 *  rather than sniffed off either record. Total by construction — an
 *  unsupported version, a malformed row, or a missing local record all read as
 *  «not equivalent», which is the fail-closed direction: the caller is then
 *  told the file holds something the store does not. */
function samePublication(
  kind: SyncRecord['kind'],
  local: EncryptedNote | EncryptedSafeboxEntry | undefined,
  incoming: EncryptedNote | EncryptedSafeboxEntry,
): boolean {
  if (local === undefined) return false;
  const subject = (record: EncryptedNote | EncryptedSafeboxEntry): PublicationSubject =>
    kind === 'note'
      ? { kind: 'note', record: record as EncryptedNote }
      : { kind: 'safebox', record: record as EncryptedSafeboxEntry };
  return publicationEquivalent(subject(local), subject(incoming));
}
