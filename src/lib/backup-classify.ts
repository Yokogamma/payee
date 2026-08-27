/**
 * Eternal Notes — what this build makes of ONE record read from a container.
 *
 * Stage A of the import and the standalone «verify this file» are the same
 * question asked twice, so they ask it through this module and not through two
 * lookalike loops. A second definition of «a record this build can restore»
 * would drift from the first exactly where drift is most expensive: one side
 * calls a file healthy, the other writes something the queue then refuses.
 *
 * ── The order of verdicts is normative (D11, D14b) ───────────────────
 *
 *  1. SHAPE first, against the very barrier the upload path applies before
 *     signing. A record can decrypt perfectly and still be unsendable — the
 *     barrier judges the id namespace, canonical base64, a 12-byte IV and a
 *     ciphertext no shorter than the GCM tag, and a successful decryption
 *     disproves none of that. Restoring such a record would have the queue
 *     quarantine it as `malformed_record` on its next pass, which is the
 *     import CREATING a quarantine — the one thing D8 (2) forbids outright.
 *
 *     Running it BEFORE the version is not an oversight and does not seal an
 *     opaque record as broken: the barrier judges STABLE fields
 *     unconditionally and version-dependent ones only when it recognizes the
 *     version (D14b). So a safebox entry of an unknown version with an id
 *     outside the safebox space is `malformed` — provably broken, therefore
 *     repairable — while the same entry with a good id passes through to the
 *     version verdict below.
 *  2. VERSION next. An unrecognized version is `unsupported` — possibly
 *     written by a NEWER build — and such a record is never written to the
 *     store and never replaces anything (D5a, D11a). Deciding this by which
 *     error a decrypt threw would be wrong: «too new for this build» and
 *     «these bytes are damaged» lead to opposite advice, and the exception
 *     types do not separate them.
 *  3. DECRYPTION last. Only now does a failure mean what it says: `damaged`.
 *
 * ── The plaintext rule (D11) ─────────────────────────────────────────
 *
 * Records are decrypted here and the plaintext dies here. What leaves is the
 * verdict and the non-secret topology — ids, revisions and links. Note text,
 * titles, logins, passwords and attachment bytes never appear in the return
 * value, in an error, or in a log line: the guarantee is that the secret does
 * not leave this function, not that it is scrubbed after it does.
 */

import { isOpaqueEntry, isOpaqueNote } from './backup';
import {
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import { isUploadableItem } from './upload-flow';

export type BackupRecordKind = 'note' | 'safebox';

export type BackupRecordState =
  /** Decrypts with this build AND would be accepted by the upload path. */
  | 'readable'
  /** A version this build does not know. Never written, never replaced. */
  | 'unsupported'
  /** Decryptable or not, its SHAPE is provably wrong: the upload barrier
   *  refuses it, so restoring it would only earn it a fresh quarantine. */
  | 'malformed'
  /** The right shape, but the bytes do not authenticate. */
  | 'damaged';

/** Non-secret topology — the only thing that may leave the decryption. */
export interface RecordTopology {
  root: string;
  rev: number;
  prev?: string;
}

/** Shaped so the impossible pair cannot be written down: a readable record
 *  always has topology, and no other verdict ever carries one — the same
 *  discipline `LocalPayload` follows in `storage.ts`. */
export type ClassifiedBackupRecord =
  | { kind: BackupRecordKind; id: string; state: 'readable'; topology: RecordTopology }
  | { kind: BackupRecordKind; id: string; state: Exclude<BackupRecordState, 'readable'> };

export interface BackupRecordKeys {
  note: CryptoKey;
  safeboxMeta: CryptoKey;
  safeboxSecret: CryptoKey;
}

export async function classifyBackupRecord(
  keys: BackupRecordKeys,
  kind: BackupRecordKind,
  record: EncryptedNote | EncryptedSafeboxEntry,
): Promise<ClassifiedBackupRecord> {
  return kind === 'note'
    ? classifyNote(keys, record as EncryptedNote)
    : classifyEntry(keys, record as EncryptedSafeboxEntry);
}

async function classifyNote(
  keys: BackupRecordKeys,
  note: EncryptedNote,
): Promise<ClassifiedBackupRecord> {
  const id = String(note.noteId);
  if (!passesUploadShape('note', note)) return { kind: 'note', id, state: 'malformed' };
  if (isOpaqueNote(note)) return { kind: 'note', id, state: 'unsupported' };
  try {
    // The plaintext exists only inside this expression: `text` and `createdAt`
    // are deliberately not destructured, so nothing but topology can escape.
    const { meta } = await decryptNote(keys.note, note);
    return {
      kind: 'note',
      id,
      state: 'readable',
      topology: { root: meta.root, rev: meta.rev, prev: meta.prev },
    };
  } catch {
    // Nothing from the error travels out — its message can quote content.
    return { kind: 'note', id, state: 'damaged' };
  }
}

async function classifyEntry(
  keys: BackupRecordKeys,
  entry: EncryptedSafeboxEntry,
): Promise<ClassifiedBackupRecord> {
  const id = String(entry.entryId);
  if (!passesUploadShape('safebox', entry)) return { kind: 'safebox', id, state: 'malformed' };
  if (isOpaqueEntry(entry)) return { kind: 'safebox', id, state: 'unsupported' };
  try {
    const meta = await decryptSafeboxMeta(keys.safeboxMeta, entry);
    // BOTH halves, always. A container whose meta opens and whose secret does
    // not restores an entry with no password in it — and the user would find
    // that out at the worst possible time.
    await decryptSafeboxSecret(keys.safeboxSecret, entry, meta.files);
    return {
      kind: 'safebox',
      id,
      state: 'readable',
      topology: { root: meta.root, rev: meta.rev, prev: meta.prev },
    };
  } catch {
    return { kind: 'safebox', id, state: 'damaged' };
  }
}

/** The upload path's own barrier, asked as a question. Total by construction:
 *  any refusal reads as «no». It carries D14b's ordering inside it — stable
 *  fields unconditionally, version-dependent ones only for a version it knows —
 *  which is what makes it safe to ask before the version verdict. */
function passesUploadShape(
  kind: BackupRecordKind,
  record: EncryptedNote | EncryptedSafeboxEntry,
): boolean {
  return isUploadableItem(
    kind === 'note'
      ? { kind: 'note', record: record as EncryptedNote }
      : { kind: 'safebox', record: record as EncryptedSafeboxEntry },
  );
}
