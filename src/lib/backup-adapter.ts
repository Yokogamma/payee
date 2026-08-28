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
 *  2. ONE `dbGeneration` for the WHOLE import — both stages, not one each.
 *     See `PreparedImport`: the confirmation the user gives is about a
 *     particular vault, and applying it to a different one is not a
 *     bookkeeping detail (below).
 *  3. The verdict and the bytes come from ONE reading of the file. Stage B
 *     writes the very records stage A judged — never a second parse.
 *  4. The flags are checked HERE, in the operations, and BEFORE anything else
 *     is touched. A hidden button is a layout decision, not a gate.
 *  5. Success is «no skip counters AND not incomplete», and the two halves are
 *     returned separately so the UI cannot accidentally show one for the other.
 *  6. The cross-tab lock is Web Locks, its absence is fail-closed, and waiting
 *     for it is cancellable.
 *  7. `assertAlive` throws, and it answers for epoch AND database generation
 *     AND the operation token — the last of which is what a page hide moves.
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
 *
 * ── Bookkeeping never destroys the result ────────────────────────────
 *
 * Two of these operations produce something the user needs — a container, a
 * report — and then write a small `meta` key about it. That write can fail,
 * and it fails most readily when storage is full: precisely the moment the
 * user is trying to get an emergency copy out. So the key is written after the
 * result exists, its failure is REPORTED rather than thrown, and the result is
 * returned either way.
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
import { applyBackupImport as runStageB, type ImportReport } from './backup-import';
import { deriveBackupKey, expectedContainerBytes, BACKUP_PLAINTEXT_BUDGET_BYTES } from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  sha256Hex,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import {
  estimateBackupPlaintextBytes,
  getMeta,
  getNoteById,
  getSafeboxEntryById,
  mergeBackupRecord,
  readBackupSnapshot,
  setMeta,
  INCOMPLETE_RESTORE_META_KEY,
  type BackupMergeResult,
  type BackupSizeEstimate,
  type LocalPayload,
  type MergeBackupRecordInput,
} from './storage';
import type { BackupArtifactMarker, BackupFreshness } from './backup-ui';

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

/** Every backup operation needs the mnemonic, and the mnemonic exists only
 *  while the vault is open. Typed so the UI can say «unlock first» instead of
 *  showing whatever a null dereference produces. */
export class BackupVaultLockedError extends Error {
  constructor() {
    super('The vault is locked — backup operations need the seed phrase in memory');
    this.name = 'BackupVaultLockedError';
  }
}

/**
 * The operation was cancelled — the tab went away, the vault was locked or
 * reset, or a newer backup operation superseded this one.
 *
 * A named type because it must never be mistaken for a verdict about the
 * user's data: swallowed by a per-record `catch`, it would turn «you left the
 * page» into «this record is damaged» (`backup-classify.ts` re-throws it by
 * name for exactly that reason).
 */
export class BackupCancelledError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'BackupCancelledError';
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
 * captures it once and every writer call below is judged against that one
 * capture. `assertAlive` is the same capture in throwing form — epoch,
 * database generation and the operation token together.
 */
export interface BackupVault {
  mnemonic: string;
  dbGeneration: number;
  /** Epoch, database generation and the operation token — and it THROWS. */
  assertAlive(): void;
  now(): number;
  /** Aborted when the operation is cancelled: passed to the lock request so
   *  WAITING for another tab is cancellable too, not only working. */
  signal?: AbortSignal;
}

/** The storage surface, injectable so the wiring can be tested without a
 *  database, and bound to the real one by `liveStorage` below. */
export interface BackupStorage {
  readSnapshot(maxPlaintextBytes: number): ReturnType<typeof readBackupSnapshot>;
  estimateSize(maxPlaintextBytes: number): Promise<BackupSizeEstimate>;
  getNote(id: string): Promise<EncryptedNote | undefined>;
  getEntry(id: string): Promise<EncryptedSafeboxEntry | undefined>;
  mergeRecord(input: MergeBackupRecordInput): Promise<BackupMergeResult>;
  readMeta<T>(key: string): Promise<T | undefined>;
  writeMeta(key: string, value: unknown): Promise<void>;
}

export const liveStorage: BackupStorage = {
  readSnapshot: readBackupSnapshot,
  estimateSize: estimateBackupPlaintextBytes,
  getNote: getNoteById,
  getEntry: getSafeboxEntryById,
  mergeRecord: mergeBackupRecord,
  readMeta: getMeta,
  writeMeta: setMeta,
};

/**
 * A result the user needs, plus whether the note-to-self about it got written.
 *
 * Separate fields rather than a throw: the container in `exported` is the
 * emergency copy, and losing it because a `meta` key could not be stored —
 * which is exactly what a full disk does — would be the feature failing at the
 * one moment it exists for.
 */
export interface ExportOutcome {
  exported: ExportedBackup;
  /** False when the freshness marker could not be stored. The file is fine. */
  markerRecorded: boolean;
}

export interface VerifyOutcome {
  report: VerifyReport;
  markerRecorded: boolean;
}

/**
 * Exclusive across tabs, fail-closed without the API, and cancellable while
 * waiting (criterion 6).
 *
 * A local mutex would serialize nothing: the tabs are separate JavaScript
 * realms sharing one database, which is exactly the case a mutex cannot see.
 * The signal matters because the wait can be long — another tab may be
 * importing a 30 MB container — and a tab that has gone away must stop
 * queueing for a turn it no longer wants.
 */
export async function withImportLock<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) throw new BackupLockUnavailableError();
  return locks.request(
    'eternal-notes-backup-import',
    signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' },
    run,
  ) as Promise<T>;
}

async function vaultKeys(mnemonic: string): Promise<BackupActionDeps['keys']> {
  return {
    note: await deriveKey(mnemonic),
    safeboxMeta: await deriveSafeboxMetaKey(mnemonic),
    safeboxSecret: await deriveSafeboxSecretKey(mnemonic),
    container: await deriveBackupKey(mnemonic),
  };
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

/** Write a `meta` note-to-self without letting it take the result down. */
async function recordArtifact(
  storage: BackupStorage,
  key: string,
  artifact: BackupArtifactRef,
): Promise<boolean> {
  try {
    await storage.writeMeta(key, artifact);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce a container and record which file it was (D21).
 *
 * The flag is checked before the vault is even asked for: with the release
 * flag off, «the vault is locked» is a true statement and the wrong answer.
 */
export async function runExport(
  makeVault: () => BackupVault,
  storage: BackupStorage = liveStorage,
): Promise<ExportOutcome> {
  if (!BACKUP_EXPORT_ENABLED) throw new BackupDisabledError('export');
  const vault = makeVault();
  const exported = await buildExport(await actionDeps(vault, storage));
  vault.assertAlive();
  return {
    exported,
    markerRecorded: await recordArtifact(storage, LAST_EXPORT_ARTIFACT_KEY, exported.artifact),
  };
}

/**
 * The dry-run. Writes exactly one key, and only when the file is flawless —
 * `ok` already means «intact AND complete AND every record readable» (D11).
 */
export async function runVerify(
  makeVault: () => BackupVault,
  file: BackupFileLike,
  storage: BackupStorage = liveStorage,
): Promise<VerifyOutcome> {
  if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
  const vault = makeVault();
  const deps = await actionDeps(vault, storage);
  const report = (await inspectBackupFile(deps, file)).report;
  vault.assertAlive();
  if (!report.ok) return { report, markerRecorded: false };
  return {
    report,
    markerRecorded: await recordArtifact(storage, LAST_VERIFIED_ARTIFACT_KEY, {
      createdAt: report.createdAt,
      sha256: report.sha256,
      at: vault.now(),
    }),
  };
}

/**
 * What the freshness chip is allowed to say (D21).
 *
 * NOT gated by a flag and NOT needing a vault: it reads two `meta` keys and
 * makes no claim of its own. The rule about what those keys MEAN together —
 * «this export, checked» only on a SHA-256 match — lives in `backup-ui`, next
 * to the sentence it authorizes.
 */
export async function readBackupFreshness(
  storage: BackupStorage = liveStorage,
): Promise<BackupFreshness> {
  const [lastExport, lastVerified] = await Promise.all([
    storage.readMeta<BackupArtifactMarker>(LAST_EXPORT_ARTIFACT_KEY),
    storage.readMeta<BackupArtifactMarker>(LAST_VERIFIED_ARTIFACT_KEY),
  ]);
  return { lastExport, lastVerified };
}

export interface BackupSizeReport {
  /** In the units the cap is charged in: the FINAL file size (D17). */
  expectedFileBytes: number;
  /** The measurement stopped at the budget — the real figure is larger. */
  overCap: boolean;
}

/**
 * How big an export would be, without making one.
 *
 * Gated with the export flag for the same reason the export itself is: it
 * describes a file only that release can produce. No vault — the measurement
 * reads ciphertext lengths and decrypts nothing.
 */
export async function estimateBackupSize(
  storage: BackupStorage = liveStorage,
): Promise<BackupSizeReport> {
  if (!BACKUP_EXPORT_ENABLED) throw new BackupDisabledError('export');
  const { plaintextBytes, overCap } = await storage.estimateSize(BACKUP_PLAINTEXT_BUDGET_BYTES);
  return { expectedFileBytes: expectedContainerBytes(plaintextBytes), overCap };
}

/**
 * Stage A's result: everything the user needs in order to decide, and a
 * SESSION that can only be applied to the vault it was prepared against.
 *
 * The binding is the point, and it is not a nicety. Stage A and stage B are
 * separated by a human decision, and a human decision takes time: enough to
 * lock the app, reset it, and open a DIFFERENT seed. If stage B accepted a
 * freshly built vault, that second vault's database generation would satisfy
 * the writer, its keys would classify the local side — and the container's
 * ciphertext, encrypted to the FIRST seed, would be written into the second
 * vault. Nothing downstream would catch it: the records are well-formed, so
 * the queue would sign and publish them under the new identity as permanently
 * undecryptable data.
 *
 * So the vault, the plan and the file's own completeness marker live behind
 * private fields, and applying is a method rather than a function anyone can
 * hand a different vault to. Refusal happens through the captured
 * `assertAlive`, before the provisional marker and before the first merge.
 */
export class PreparedImport {
  /** What the preview shows. Public because that is its entire purpose. */
  readonly report: VerifyReport;

  readonly #vault: BackupVault;
  readonly #plan: ImportPlan;
  readonly #storage: BackupStorage;

  constructor(init: {
    report: VerifyReport;
    vault: BackupVault;
    plan: ImportPlan;
    storage: BackupStorage;
  }) {
    this.report = init.report;
    this.#vault = init.vault;
    this.#plan = init.plan;
    this.#storage = init.storage;
  }

  /** How many records would be written at all — what the preview counts. */
  get plannedCount(): number {
    return this.#plan.ordered.length;
  }

  /**
   * Stage B. Takes no vault: it has one, and that is the guarantee.
   *
   * `fileIsComplete` is derived from the report rather than carried beside it
   * — one source of truth for «was this file itself made by a partial
   * restore», so the two cannot drift into disagreeing.
   */
  async apply(): Promise<ImportReport> {
    if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
    const vault = this.#vault;
    // Before anything: the vault this was prepared against must still be the
    // one in front of us. A lock, a reset or a page hide moved one of the
    // three numbers, and none of them is recoverable by trying harder.
    vault.assertAlive();
    const keys = await vaultKeys(vault.mnemonic);
    vault.assertAlive();

    return runStageB(
      {
        now: vault.now,
        assertAlive: vault.assertAlive,
        classifyLocal: async (kind, id) => {
          const stored = kind === 'note'
            ? await this.#storage.getNote(id)
            : await this.#storage.getEntry(id);
          vault.assertAlive();
          const state = await classifyLocalPayload(keys, kind, stored, vault.assertAlive);
          return (state === 'absent'
            ? { state: 'absent' }
            : { state, record: stored }) as LocalPayload<EncryptedNote> | LocalPayload<EncryptedSafeboxEntry>;
        },
        mergeRecord: (kind, incoming, local, now) => this.#storage.mergeRecord(
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
          const raw = await this.#storage.readMeta<unknown>(INCOMPLETE_RESTORE_META_KEY);
          // Anything that is not exactly `false` reads as «incomplete» — the same
          // rule the export's snapshot applies, for the same reason: a half-written
          // marker must never downgrade a warning about missing data.
          return raw !== undefined && raw !== false;
        },
        writeIncompleteMarker: value => this.#storage.writeMeta(INCOMPLETE_RESTORE_META_KEY, value),
        withExclusiveLock: run => withImportLock(run, vault.signal),
      },
      this.#plan,
      !this.report.incompleteRestore,
    );
  }
}

export async function prepareImport(
  makeVault: () => BackupVault,
  file: BackupFileLike,
  storage: BackupStorage = liveStorage,
): Promise<PreparedImport> {
  if (!BACKUP_IMPORT_ENABLED) throw new BackupDisabledError('import');
  const vault = makeVault();
  const deps = await actionDeps(vault, storage);
  // The SAME pass the dry-run makes — chain validation included (criterion 1).
  const inspected = await inspectBackupFile(deps, file);
  vault.assertAlive();

  return new PreparedImport({
    report: inspected.report,
    vault,
    plan: planBackupImport(inspected.records.map(toPlanInput)),
    storage,
  });
}

/** A readable record always carries topology (the classifier's type says so);
 *  anything else is refused as `damaged` — fail-closed against a shape that
 *  should be impossible rather than a cast that pretends it is. */
const toPlanInput = (record: InspectedRecord): PlanInput => (
  record.state === 'readable' && record.topology !== undefined
    ? { kind: record.kind, id: record.id, state: 'readable', topology: record.topology, record: record.record }
    : {
      kind: record.kind,
      id: record.id,
      state: record.state === 'readable' ? 'damaged' : record.state,
      record: record.record,
    }
);

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
