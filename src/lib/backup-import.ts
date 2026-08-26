/**
 * Eternal Notes — stage B of the import: applying a planned container.
 *
 * Everything risky about restoring from a file lives here, so the rules it
 * obeys are worth stating up front.
 *
 *  - **Nothing is decided in here.** Each record's fate comes from the pure
 *    merge rules; this module classifies, calls, counts and stops.
 *  - **The completeness marker is fail-SAFE, not fail-late.** It is set to
 *    `true` BEFORE the first mutation, so a crash, a hidden page or a full
 *    disk halfway through leaves the store honestly marked incomplete. Setting
 *    it at the end would mean the one case it exists for — an import that did
 *    not finish — is exactly the case where it never gets written.
 *  - **Imports are serialized across tabs** by an exclusive lock, and the
 *    absence of that lock is fail-closed: an import that cannot be serialized
 *    does not start. Two tabs importing at once could otherwise observe each
 *    other's half-applied state, and the marker below would be decided from a
 *    value that was already stale when it was read.
 *  - **Every record is counted at most once**, and successful no-ops are not
 *    counted at all: an import that honoured the whole file must not report
 *    itself incomplete.
 */

import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import type { BackupMergeResult, LocalPayload } from './storage';
import { cascades, chainKey, type ImportPlan, type PlannedKind, type PlannedRecord } from './backup-plan';

export interface ImportCounters {
  added: number;
  repaired: number;
  quarantinedRepaired: number;
  quarantinedDataRepaired: number;
  quarantineStale: number;
  unsupportedLocal: number;
  conflicts: number;
  deferred: number;
  skipped: number;
  unsupported: number;
  concurrentChange: number;
  quotaStopped: number;
}

/** The seven ways a record can go UNAPPLIED. Any of them non-zero means the
 *  file still holds something the store does not, and the UI must say so
 *  rather than show a success. */
export const SKIP_COUNTERS = [
  'unsupported',
  'unsupportedLocal',
  'conflicts',
  'deferred',
  'skipped',
  'concurrentChange',
  'quotaStopped',
] as const satisfies readonly (keyof ImportCounters)[];

export interface ImportReport {
  counters: ImportCounters;
  /** Every skip counter is zero. The ONLY state a success may be shown for. */
  complete: boolean;
  /** The marker's value after this import — what the next export will carry. */
  incompleteRestore: boolean;
}

export interface ImportDeps {
  now(): number;
  assertAlive(): void;
  /** Try to read the LOCAL record and say what this build makes of it. Async
   *  because it decrypts, which is precisely why it cannot happen inside the
   *  merge transaction (D13). */
  classifyLocal(
    kind: PlannedKind,
    id: string,
  ): Promise<LocalPayload<EncryptedNote> | LocalPayload<EncryptedSafeboxEntry>>;
  mergeRecord(
    kind: PlannedKind,
    incoming: EncryptedNote | EncryptedSafeboxEntry,
    local: LocalPayload<EncryptedNote> | LocalPayload<EncryptedSafeboxEntry>,
    now: number,
  ): Promise<BackupMergeResult>;
  readIncompleteMarker(): Promise<boolean>;
  writeIncompleteMarker(value: boolean): Promise<void>;
  /** Exclusive across tabs. MUST reject rather than run unguarded when the
   *  platform offers no such lock. */
  withExclusiveLock<T>(run: () => Promise<T>): Promise<T>;
}

const emptyCounters = (): ImportCounters => ({
  added: 0, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
  quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
  skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
});

const isQuotaError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

/**
 * Apply a planned container.
 *
 * `fileIsComplete` is the container's own `incompleteRestore`, inverted: a file
 * that was itself produced by an incomplete restore can never leave this device
 * marked complete, however cleanly it applies. That transitivity is the whole
 * point of the marker — «this copy is narrower than the one it came from» is a
 * fact about lineage, not about today's import.
 */
export async function applyBackupImport(
  deps: ImportDeps,
  plan: ImportPlan,
  fileIsComplete: boolean,
): Promise<ImportReport> {
  return deps.withExclusiveLock(async () => {
    // Read INSIDE the lock. Two tabs that both read `false` before acquiring
    // it could otherwise race: the partial import sets `true`, and the other,
    // holding a value captured earlier, clears it again.
    const startedIncomplete = await deps.readIncompleteMarker();
    deps.assertAlive();

    // Provisional mark BEFORE the first mutation. If even this write fails,
    // NOTHING is touched — better to import nothing than to import half and
    // claim it was whole.
    await deps.writeIncompleteMarker(true);
    deps.assertAlive();

    const counters = emptyCounters();
    counters.unsupported = plan.unsupported.length;

    await runPlan(deps, plan, counters);

    // Sticky: once true, it stays true. It may be rolled back ONLY when this
    // import began at `false`, the file itself claimed completeness, and
    // nothing at all went unapplied. Anything weaker would be a guess: a full
    // import of an OLDER complete file also produces zero skips, and clearing
    // the mark there would hide a record that was lost long before.
    const nothingSkipped = SKIP_COUNTERS.every(name => counters[name] === 0);
    const incompleteRestore = !(!startedIncomplete && fileIsComplete && nothingSkipped);
    if (!incompleteRestore) await deps.writeIncompleteMarker(false);

    return { counters, complete: nothingSkipped, incompleteRestore };
  });
}

async function runPlan(deps: ImportDeps, plan: ImportPlan, counters: ImportCounters): Promise<void> {
  /** Chains already abandoned, with the reason that abandoned them. */
  const stoppedChains = new Map<string, keyof ImportCounters>();
  let quotaStop = false;

  for (let i = 0; i < plan.ordered.length; i++) {
    const planned = plan.ordered[i];
    const chain = chainKey(planned.kind, planned.root);

    if (quotaStop) {
      counters.quotaStopped++;
      continue;
    }

    // A descendant of a record that was not applied is not attempted at all:
    // writing it would leave a version whose predecessor the store does not
    // have, and any committed prefix must be a valid graph (D12a). It is
    // counted under the reason that stopped the chain, which tells the user
    // WHY a whole chain is missing rather than just that it is.
    const stoppedBy = stoppedChains.get(chain);
    if (stoppedBy !== undefined) {
      counters[stoppedBy]++;
      continue;
    }

    let outcome: BackupMergeResult;
    try {
      outcome = await applyOne(deps, planned);
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      // Out of space. What is already written stays — it is an additive
      // prefix, and a valid graph. Everything left, including this record,
      // is reported as stopped by quota.
      quotaStop = true;
      counters.quotaStopped++;
      continue;
    }
    deps.assertAlive();

    if (outcome !== 'noop') counters[outcome]++;
    if (cascades(outcome)) stoppedChains.set(chain, outcome as keyof ImportCounters);
  }
}

/**
 * One record: classify, merge, and retry EXACTLY once if the row moved under
 * us.
 *
 * One retry, not a loop: a single retry absorbs an ordinary interleaving —
 * another tab finishing an upload, a sweep writing a repair — while looping
 * would let a busy tab hold the import open indefinitely. The second failure
 * is reported rather than fought.
 */
async function applyOne(deps: ImportDeps, planned: PlannedRecord): Promise<BackupMergeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const local = await deps.classifyLocal(planned.kind, planned.id);
    deps.assertAlive();
    const outcome = await deps.mergeRecord(planned.kind, planned.record, local, deps.now());
    if (outcome !== 'concurrentChange') return outcome;
  }
  return 'concurrentChange';
}
