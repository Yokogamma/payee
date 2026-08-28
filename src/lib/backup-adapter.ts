/**
 * Eternal Notes — the backup operations as the app performs them.
 *
 * The pure halves already exist: the container format, the merge rules, the
 * plan, the classifier, the two read-only actions. This is the seam between
 * them and the running app, and it is written as its own module rather than
 * inside the store because everything that can go wrong here is a WIRING
 * mistake — a guard captured twice, a file read twice, a flag checked in the
 * markup instead of the action — and wiring mistakes are only visible when the
 * wiring is something you can hold.
 *
 * ── The seven things this module exists to get right (§4) ────────────
 *
 *  1. Stage A runs the SAME validation as «verify this file», chain graph
 *     included. The planner checks only the preconditions of its own ordering
 *     and says so; an import that skipped the graph would hand it nodes whose
 *     links nobody proved.
 *  2. `dbGeneration` is captured ONCE for the whole operation and threaded
 *     into every writer call. Re-capturing per record would let an import that
 *     outlived a reset carry on into the new database.
 *  3. The verdict and the bytes come from ONE reading of the file. Stage B
 *     writes the very records stage A judged — never a second parse.
 *  4. The flags are checked HERE, in the operations, not in the UI. A hidden
 *     button is a layout decision, not a gate.
 *  5. Success is «no skip counters AND not incomplete», and the two halves are
 *     returned separately so the UI cannot accidentally show one for the other.
 *  6. The cross-tab lock is Web Locks, and its absence is fail-closed.
 *  7. `assertAlive` throws. A guard that returns a boolean is a guard someone
 *     eventually forgets to read.
 *
 * ── What it needs from the vault ─────────────────────────────────────
 *
 * The mnemonic, which means an UNLOCKED vault. Note what that implies for the
 * safebox: verification decrypts both halves of every entry (D11), including
 * the passwords, while the safebox SECTION may still be PIN-locked. That is
 * not a way around the PIN — the PIN protects the seed at rest, and by this
 * point the seed is already in memory, so the secrets were already derivable.
 * Worth saying out loud because the code looks like it is doing something the
 * PIN forbids, and it is not.
 */

import {
  BACKUP_EXPORT_ENABLED,
  BACKUP_IMPORT_ENABLED,
} from './flags';
import {
  exportBackup as buildExport,
  inspectBackupFile,
  type BackupActionDeps,
  type BackupArtifactRef,
  type BackupFileLike,
  type ExportedBackup,
  type InspectedRecord,
  type VerifyReport,
} from './backup-actions';
import { classifyLocalPayload } from './backup-classify';
import { planBackupImport, type ImportPlan, type PlanInput } from './backup-plan';
import { applyBackupImport, type ImportReport } from './backup-import';
import { deriveBackupKey } from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import {
  getMeta,
  getNoteById,
  getSafeboxEntryById,
  mergeBackupRecord,
  readBackupSnapshot,
  setMeta,
  INCOMPLETE_RESTORE_META_KEY,
  type BackupMergeResult,
  type LocalPayload,
  type MergeBackupRecordInput,
} from './storage';

/** D21: which file the freshness chip is about. */
export const LAST_EXPORT_ARTIFACT_KEY = 'last-export-artifact';
export const LAST_VERIFIED_ARTIFACT_KEY = 'last-verified-artifact';

/** The action was called while its release flag is off. Typed, because the UI
 *  is not the gate and something has to say so out loud when it is wrong. */
export class BackupDisabledError extends Error {
  constructor(what: 'export' | 'import') {
    super(`Backup ${what} is disabled in this build`);
    this.name = 'BackupDisabledError';
  }
}

/** No Web Locks: imports cannot be serialized across tabs, so none starts. */
export class BackupLockUnavailableError extends Error {
  constructor() {
    super('This browser has no Web Locks API — an import cannot be serialized between tabs');
    this.name = 'BackupLockUnavailableError';
  }
}

/**
 * What the adapter needs from the running vault.
 *
 * `dbGeneration` is a VALUE, not a getter, and that is the point: the caller
 * captures it once, at the start, and every writer call below is judged
 * against that one capture (criterion 2).
 */
export interface BackupVault {
  mnemonic: string;
  dbGeneration: number;
  /** Epoch, database generation and the reset token — and it THROWS. */
  assertAlive(): void;
  now(): number;
}

/** The storage surface, injectable so the wiring can be tested without a
 *  database, and bound to the real one by `liveStorage` below. */
export interface BackupStorage {
  readSnapshot(maxPlaintextBytes: number): ReturnType<typeof readBackupSnapshot>;
  getNote(id: string): Promise<EncryptedNote | undefined>;
  getEntry(id: string): Promise<EncryptedSafeboxEntry | undefined>;
  mergeRecord(input: MergeBackupRecordInput): Promise<BackupMergeResult>;
  readMeta<T>(key: string): Promise<T | undefined>;
  writeMeta(key: string, value: unknown): Promise<void>;
}

export const liveStorage: BackupStorage = {
  readSnapshot: readBackupSnapshot,
  getNote: getNoteById,
  getEntry: getSafeboxEntryById,
  mergeRecord: mergeBackupRecord,
  readMeta: getMeta,
  writeMeta: setMeta,
};

/**
 * Exclusive across tabs, and fail-closed without the API (criterion 6).
 *
 * A local mutex would serialize nothing: the tabs are separate JavaScript
 * realms sharing one database, which is exactly the case a mutex cannot see.
 */
export async function withImportLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) throw new BackupLockUnavailableError();
  return locks.request('eternal-notes-backup-import', { mode: 'exclusive' }, run) as Promise<T>;
}

async function vaultKeys(mnemonic: string): Promise<BackupActionDeps['keys']> {
  return {
    note: await deriveKey(mnemonic),
    safeboxMeta: await deriveSafeboxMetaKey(mnemonic),
    safeboxSecret: await deriveSafeboxSecretKey(mnemonic),
    container: await deriveBackupKey(mnemonic),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function actionDeps(vault: BackupVault, storage: BackupStorage): Promise<BackupActionDeps> {
  return {
    now: vault.now,
    keys: await vaultKeys(vault.mnemonic),
    readSnapshot: storage.readSnapshot,
    sha256Hex,
    assertAlive: vault.assertAlive,
  };
}

/**
 * Produce a container and record which file it was (D21).
 *
 * The marker is written AFTER the bytes exist and only then: a chip claiming
 * an export that failed halfway is worse than no chip.
 */
export async function runExport(
  vault: BackupVault,
  storage: BackupStorage = liveStorage,
): Promise<ExportedBackup> {
  if (!BACKUP_EXPORT_ENABLED) throw new BackupDisabledError('export');
  const exported = await buildExport(await actionDeps(vault, storage));
  vault.assertAlive();
  await storage.writeMeta(LAST_EXPORT_ARTIFACT_KEY, exported.artifact);
  return exported;
}

/**
 * The dry-run. Writes exactly one key, and only when the file is flawless —
 * `ok` already means «intact AND complete AND every record readable» (D11).
 */
export async function runVerify(
  vault: BackupVault,
  file: BackupFileLike,
  storage: BackupStorage = liveStorage,
): Promise<VerifyReport> {
  if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
  const deps = await actionDeps(vault, storage);
  const report = (await inspectBackupFile(deps, file)).report;
  vault.assertAlive();
  if (report.ok) {
    const artifact: BackupArtifactRef = {
      createdAt: report.createdAt,
      sha256: report.sha256,
      at: vault.now(),
    };
    await storage.writeMeta(LAST_VERIFIED_ARTIFACT_KEY, artifact);
  }
  return report;
}

/**
 * Stage A: everything the user needs to decide, and nothing applied yet.
 *
 * The plan carries the very records the report was formed from (criterion 3),
 * so the confirmation the user gives is a confirmation about THESE bytes.
 */
export interface PreparedImport {
  report: VerifyReport;
  plan: ImportPlan;
  /** The container's own marker — stage B needs it, and it is not in the
   *  report, which describes the file rather than what an import would leave. */
  fileIsComplete: boolean;
}

export async function prepareImport(
  vault: BackupVault,
  file: BackupFileLike,
  storage: BackupStorage = liveStorage,
): Promise<PreparedImport> {
  if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
  const deps = await actionDeps(vault, storage);
  // The SAME pass the dry-run makes — chain validation included (criterion 1).
  const inspected = await inspectBackupFile(deps, file);
  vault.assertAlive();

  return {
    report: inspected.report,
    plan: planBackupImport(inspected.records.map(toPlanInput)),
    fileIsComplete: !inspected.incompleteRestore,
  };
}

const toPlanInput = (record: InspectedRecord): PlanInput => (
  record.state === 'readable' && record.topology !== undefined
    ? { kind: record.kind, id: record.id, state: 'readable', topology: record.topology, record: record.record }
    : { kind: record.kind, id: record.id, state: record.state === 'readable' ? 'damaged' : record.state, record: record.record }
);

/**
 * Stage B: apply what the user confirmed.
 *
 * Everything mutating in the whole feature happens under this one lock, and
 * `dbGeneration` reaches every writer from the single capture on `vault`.
 */
export async function applyPreparedImport(
  vault: BackupVault,
  prepared: PreparedImport,
  storage: BackupStorage = liveStorage,
): Promise<ImportReport> {
  if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
  const keys = await vaultKeys(vault.mnemonic);

  return applyBackupImport(
    {
      now: vault.now,
      assertAlive: vault.assertAlive,
      classifyLocal: async (kind, id) => {
        const stored = kind === 'note' ? await storage.getNote(id) : await storage.getEntry(id);
        const state = await classifyLocalPayload(keys, kind, stored);
        return (state === 'absent'
          ? { state: 'absent' }
          : { state, record: stored }) as LocalPayload<EncryptedNote> | LocalPayload<EncryptedSafeboxEntry>;
      },
      mergeRecord: (kind, incoming, local, now) => storage.mergeRecord(
        kind === 'note'
          ? {
            kind: 'note',
            incoming: incoming as EncryptedNote,
            local: local as LocalPayload<EncryptedNote>,
            now,
            expectedDbGeneration: vault.dbGeneration,
          }
          : {
            kind: 'safebox',
            incoming: incoming as EncryptedSafeboxEntry,
            local: local as LocalPayload<EncryptedSafeboxEntry>,
            now,
            expectedDbGeneration: vault.dbGeneration,
          },
      ),
      readIncompleteMarker: async () => {
        const raw = await storage.readMeta<unknown>(INCOMPLETE_RESTORE_META_KEY);
        // Anything that is not exactly `false` reads as «incomplete» — the same
        // rule the export's snapshot applies, for the same reason: a half-written
        // marker must never downgrade a warning about missing data.
        return raw !== undefined && raw !== false;
      },
      writeIncompleteMarker: value => storage.writeMeta(INCOMPLETE_RESTORE_META_KEY, value),
      withExclusiveLock: withImportLock,
    },
    prepared.plan,
    prepared.fileIsComplete,
  );
}

/**
 * The one verdict the UI may show a success for (criterion 5).
 *
 * Both halves are required and they are different questions: «did everything
 * in the file get applied» and «is the store now a complete backup of
 * anything». A file made by an incomplete restore can apply perfectly and
 * still leave the second one false.
 */
export const importSucceeded = (report: ImportReport): boolean =>
  report.allFileRecordsApplied && !report.incompleteRestore;
