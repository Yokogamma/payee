/**
 * Eternal Notes — the two READ-ONLY backup actions: export, and verifying a
 * file that already exists.
 *
 * Neither touches `notes`, `safebox` or `sync`, ever, under any outcome. The
 * single write either can make is one `meta` key recording which artifact was
 * produced or checked (D21), and verify writes even that only when the file is
 * flawless. Import — the mutating half — lives elsewhere.
 *
 * ── The plaintext rule (D11) ────────────────────────────────────────
 *
 * Verification is a FULL dry-run: every note and BOTH halves of every safebox
 * entry are actually decrypted, because a green tick that only proves the
 * outer shell is intact would be a lie in the one moment it matters. That
 * means this module holds every secret the vault has, briefly.
 *
 * So the contract is `decrypt → validate → extract only non-secret topology
 * and a verdict → discard`. What may leave the loop: ids, versions,
 * `root/prev/rev`, counts and «readable / damaged / unsupported». What may
 * never leave it, in a report, an error message, a log line or a returned
 * object: note text, titles, logins, passwords, attachment bytes, or any key.
 * Clearing references afterwards is best effort and is not claimed as
 * zeroization — the guarantee here is that the secret never leaves this
 * function, not that it is scrubbed after it does.
 */

import {
  BACKUP_CAP_BYTES,
  BACKUP_PLAINTEXT_BUDGET_BYTES,
  BackupError,
  backupFileName,
  decodeBackup,
  encodeBackup,
  type BackupHeader,
} from './backup';
import { validateChains, type ChainIssue, type ChainNode } from './backup-chains';
import {
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import type { BackupSnapshotResult } from './storage';

/** Which file an artifact marker refers to. The SHA is what makes the marker
 *  about a FILE rather than about a moment: exporting A and then verifying an
 *  older B must not leave the UI implying that A was checked (D21). */
export interface BackupArtifactRef {
  createdAt: number;
  sha256: string;
  at: number;
}

export type VerifyProblem =
  /** The record did not decrypt — damaged, or not what it claims to be. */
  | 'undecryptable'
  /** A version this build cannot read. Expected in a forward-compatible file;
   *  it is a WARNING about completeness, not damage. */
  | 'unsupported_version'
  /** Chain topology — see `backup-chains.ts`. */
  | 'chain';

export interface VerifyIssue {
  kind: 'note' | 'safebox';
  id: string;
  problem: VerifyProblem;
  /** Present only for `problem: 'chain'`. */
  detail?: ChainIssue['problem'];
}

export interface VerifyReport {
  /** Cryptographically intact AND complete AND every record readable. The only
   *  state that earns a green tick and writes `last-verified-artifact`. */
  ok: boolean;
  sha256: string;
  createdAt: number;
  counts: { notes: number; safebox: number };
  /** The file is narrower than the one its device restored from (D11a). A
   *  container can be perfectly intact and still not be a complete backup —
   *  two different questions that must never be merged into one verdict. */
  incompleteRestore: boolean;
  containsUnsupportedRecords: boolean;
  /** Records this build could not read, and broken chain links. Ids and
   *  verdicts only — never content. */
  issues: VerifyIssue[];
}

export interface BackupVaultKeys {
  note: CryptoKey;
  safeboxMeta: CryptoKey;
  safeboxSecret: CryptoKey;
  container: CryptoKey;
}

export interface BackupActionDeps {
  now(): number;
  keys: BackupVaultKeys;
  readSnapshot(maxPlaintextBytes: number): Promise<BackupSnapshotResult>;
  sha256Hex(text: string): Promise<string>;
  /** D15: epoch / dbGeneration / token. Throws to cancel — a lock, a reset or
   *  a page hide must stop the work rather than let it finish against a vault
   *  that is no longer the one it started with. Called after every await that
   *  could span user action. */
  assertAlive(): void;
}

/** The store holds more than a container can carry. Distinct from
 *  `BackupError('too_large')` on the way IN: nothing was produced, and the
 *  honest message is «this device is past the limit», not «that file is». */
export class BackupStoreTooLargeError extends Error {
  readonly readBytes: number;
  constructor(readBytes: number) {
    super(`Store exceeds the backup limit (${readBytes} bytes read)`);
    this.name = 'BackupStoreTooLargeError';
    this.readBytes = readBytes;
  }
}

export interface ExportedBackup {
  text: string;
  fileName: string;
  artifact: BackupArtifactRef;
}

/**
 * Produce one container from a consistent snapshot.
 *
 * Note what is NOT here: any decryption. The export copies ciphertext that is
 * already at rest, so plaintext is never materialized — which is also why it
 * needs no PIN and no unlocked safebox.
 */
export async function exportBackup(deps: BackupActionDeps): Promise<ExportedBackup> {
  deps.assertAlive();
  const snapshot = await deps.readSnapshot(BACKUP_PLAINTEXT_BUDGET_BYTES);
  deps.assertAlive();
  if (!snapshot.ok) throw new BackupStoreTooLargeError(snapshot.readBytes);

  const { notes, safebox, incompleteRestore } = snapshot.snapshot;
  const createdAt = deps.now();
  const text = await encodeBackup({
    notes: notes as unknown as Record<string, unknown>[],
    safebox: safebox as unknown as Record<string, unknown>[],
    incompleteRestore,
    // Decided by VERSION, not by trying to decrypt: the flag is about what the
    // container holds, and a cheap version check answers that without the
    // export ever touching a key.
    containsUnsupportedRecords: notes.some(isOpaqueNote) || safebox.some(isOpaqueEntry),
    createdAt,
  }, deps.keys.container);
  deps.assertAlive();

  return {
    text,
    fileName: backupFileName(new Date(createdAt)),
    artifact: { createdAt, sha256: await deps.sha256Hex(text), at: deps.now() },
  };
}

const isOpaqueNote = (n: EncryptedNote): boolean =>
  n.v !== undefined && n.v !== 1 && n.v !== 2 && n.v !== 3;
const isOpaqueEntry = (e: EncryptedSafeboxEntry): boolean => e.v !== 4;

/** A file, in the only two aspects this module needs. Narrow on purpose: the
 *  size must be readable WITHOUT pulling the contents into memory (D17). */
export interface BackupFileLike {
  size: number;
  text(): Promise<string>;
}

/**
 * The full dry-run. Reads a file, decrypts everything in it, and reports —
 * without changing a single stored record.
 */
export async function verifyBackupFile(
  deps: BackupActionDeps,
  file: BackupFileLike,
): Promise<VerifyReport> {
  // Size FIRST, before the contents are ever pulled into memory. A file past
  // the cap is refused as a fact about the file, not discovered halfway
  // through parsing it.
  if (file.size > BACKUP_CAP_BYTES) {
    throw new BackupError('too_large', `File is ${file.size} bytes, over the ${BACKUP_CAP_BYTES} cap`);
  }
  deps.assertAlive();

  const text = await file.text();
  deps.assertAlive();
  const sha256 = await deps.sha256Hex(text);

  const { header, body } = await decodeBackup(text, deps.keys.container);
  deps.assertAlive();

  const issues: VerifyIssue[] = [];
  const nodes: ChainNode[] = [];

  for (const record of body.notes) {
    const note = record as unknown as EncryptedNote;
    const id = String(note.noteId);
    if (isOpaqueNote(note)) {
      // Decided by the declared VERSION, never by which error a decrypt threw.
      // «Too new for this build» and «these bytes are damaged» lead to
      // opposite advice — keep the file vs replace it — and the exception
      // types do not separate them: the safebox envelope raises the same class
      // for a wrong version and for tampering.
      issues.push({ kind: 'note', id, problem: 'unsupported_version' });
      continue;
    }
    try {
      // The plaintext exists only inside this expression. Only the topology is
      // kept; `text` and `createdAt` are deliberately not destructured.
      const { meta } = await decryptNote(deps.keys.note, note);
      nodes.push({ kind: 'note', id, rev: meta.rev, root: meta.root, prev: meta.prev });
    } catch {
      // Nothing from the error is carried out — its message can quote content.
      issues.push({ kind: 'note', id, problem: 'undecryptable' });
    }
    deps.assertAlive();
  }

  for (const record of body.safebox) {
    const entry = record as unknown as EncryptedSafeboxEntry;
    const id = String(entry.entryId);
    if (isOpaqueEntry(entry)) {
      issues.push({ kind: 'safebox', id, problem: 'unsupported_version' });
      continue;
    }
    try {
      const meta = await decryptSafeboxMeta(deps.keys.safeboxMeta, entry);
      // BOTH halves, always. A container whose meta opens and whose secret does
      // not is a container that restores an entry with no password in it — and
      // the user would find that out at the worst possible time.
      await decryptSafeboxSecret(deps.keys.safeboxSecret, entry, meta.files);
      nodes.push({ kind: 'safebox', id, rev: meta.rev, root: meta.root, prev: meta.prev });
    } catch {
      issues.push({ kind: 'safebox', id, problem: 'undecryptable' });
    }
    deps.assertAlive();
  }

  for (const issue of validateChains(nodes)) {
    issues.push({ kind: issue.kind, id: issue.id, problem: 'chain', detail: issue.problem });
  }

  assertHeaderHonest(header, issues);

  return {
    // Green requires all three: nothing unreadable, no broken chain, and a
    // container that claims to be complete. «Intact» and «complete» are
    // different questions (D11a) and only their conjunction is a backup the
    // user may rely on.
    ok: issues.length === 0 && !body.incompleteRestore,
    sha256,
    createdAt: header.createdAt,
    counts: body.counts,
    incompleteRestore: body.incompleteRestore,
    containsUnsupportedRecords: header.containsUnsupportedRecords,
    issues,
  };
}

/**
 * The asymmetric header check (D11a).
 *
 * Header `false` while unsupported records are actually present → the writer
 * lied or the file was altered: fail closed. Header `true` while this reader
 * sees none → normal, the reader is simply newer; the warning just drops.
 *
 * Strict equality here would reject a valid backup at exactly the build able
 * to restore it, which is the one case forward compatibility exists for.
 */
function assertHeaderHonest(header: BackupHeader, issues: VerifyIssue[]): void {
  const sawUnsupported = issues.some(i => i.problem === 'unsupported_version');
  if (sawUnsupported && !header.containsUnsupportedRecords) {
    throw new BackupError(
      'corrupt',
      'Header claims every record is supported, but some are not',
    );
  }
}
