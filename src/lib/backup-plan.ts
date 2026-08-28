/**
 * Eternal Notes — the import PLAN: what order records are applied in, and what
 * happens to the rest of a chain when one of them cannot be applied.
 *
 * Stage B writes records one at a time and is allowed to stop early — a
 * conflict, a live upload, a quarantine, a full disk. So the order is not a
 * detail: applied naively, a container could leave a descendant stored without
 * its predecessor, or strand a chain whose first version was skipped. The
 * invariant this module exists to guarantee is that **any committed prefix is
 * a valid graph** (D12a).
 *
 * Three rules produce that:
 *  - records are applied ROOT → REV ASCENDING, so a version is never written
 *    before the one it points back to;
 *  - a record that is not applied CASCADES: every later version in its chain
 *    is marked skipped with the same reason, without being attempted;
 *  - a record whose predecessor is NOT IN THE PLAN is never attempted either.
 *    That case is invisible to the cascade above, because a record this build
 *    could not read has no topology and therefore no chain to be stopped: it
 *    is set aside before ordering begins. Its descendants would then be
 *    applied on their own, each landing in the store with a `prev` the store
 *    does not have — precisely the hole D12a exists to prevent.
 *
 * The plan is pure and carries no plaintext: encrypted records, ids and
 * topology only. Deciding all of this before the first write is also what lets
 * the preview tell the user what will happen — while it still can be declined.
 */

import type { BackupRecordState, ClassifiedBackupRecord } from './backup-classify';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';

export type PlannedKind = 'note' | 'safebox';

export interface PlannedRecord {
  kind: PlannedKind;
  id: string;
  /** Still encrypted — the plan never holds plaintext. */
  record: EncryptedNote | EncryptedSafeboxEntry;
  root: string;
  rev: number;
  prev?: string;
}

/**
 * Which counter a refused record lands in (§4).
 *
 * `unsupported` keeps its D11a meaning and nothing else: «this build does not
 * know this version», possibly because a NEWER one wrote it — the case the UI
 * answers with «not restored by THIS version of the app». A record whose shape
 * is broken or whose bytes are damaged is not that, and reporting it there
 * would send the user looking for a newer build that does not exist. Both are
 * `skipped`: left unapplied, and not a version problem.
 */
export type NotAppliedCounter = 'unsupported' | 'skipped';

/** A record the plan will NOT attempt, and the counter it belongs in.
 *
 * Two ways in. Either the FILE's record is one this build cannot use — writing
 * it would have the local queue serialize it and quarantine it permanently,
 * and that quarantine is irreversible — or the record is fine but its
 * predecessor is not in the plan, in which case applying it alone would strand
 * it (D12a). The second inherits the first's counter: a descendant is missing
 * for its ancestor's reason, not for one of its own. */
export interface NotAppliedRecord {
  kind: PlannedKind;
  id: string;
  counter: NotAppliedCounter;
}

const COUNTER_OF: Record<Exclude<BackupRecordState, 'readable'>, NotAppliedCounter> = {
  unsupported: 'unsupported',
  malformed: 'skipped',
  damaged: 'skipped',
};

export interface ImportPlan {
  /** Application order. Chains may interleave; within a chain, revisions
   *  strictly ascend. */
  ordered: PlannedRecord[];
  /** Everything the plan refuses to attempt — unusable records and the
   *  descendants stranded behind them, each with its counter. */
  notApplied: NotAppliedRecord[];
}

/** One record as stage A classified it (`backup-classify.ts`), plus the
 *  encrypted record itself. The verdict is TAKEN, never re-derived: a second
 *  opinion about «can this be restored?» is exactly the drift this module must
 *  not introduce. */
export type PlanInput = ClassifiedBackupRecord & {
  record: EncryptedNote | EncryptedSafeboxEntry;
};

/** Key that identifies one chain across both collections. */
export const chainKey = (kind: PlannedKind, root: string): string => `${kind}:${root}`;

/**
 * Build the plan.
 *
 * A record with no topology is unsupported by definition: this build could not
 * decrypt it, so it has no place in any chain and must not be written.
 */
export function planBackupImport(inputs: readonly PlanInput[]): ImportPlan {
  const readable: PlannedRecord[] = [];
  const notApplied: NotAppliedRecord[] = [];

  for (const input of inputs) {
    if (input.state !== 'readable') {
      notApplied.push({ kind: input.kind, id: input.id, counter: COUNTER_OF[input.state] });
      continue;
    }
    readable.push({
      kind: input.kind,
      id: input.id,
      record: input.record,
      root: input.topology.root,
      rev: input.topology.rev,
      prev: input.topology.prev,
    });
  }

  // Ascending `rev` within a chain IS the topological order — but only because
  // stage A proved `prev` is the PREVIOUS revision of the SAME chain
  // (`backup-chains.ts`). Chains are then kept together, which is not required
  // for correctness but makes a stopped import easy to read.
  readable.sort((a, b) => {
    const chainA = chainKey(a.kind, a.root);
    const chainB = chainKey(b.kind, b.root);
    if (chainA !== chainB) return chainA < chainB ? -1 : 1;
    return a.rev - b.rev;
  });

  // One forward pass in that order decides who may be ordered at all. A record
  // that may not is set aside, and so is everything behind it — the memo
  // carries the verdict down the chain without walking it again.
  //
  // ── What this pass checks, and why exactly these three ──────────────
  //
  // This is not a second `validateChains`, and it must not become one. It is
  // the set of preconditions THIS module's guarantee rests on — «every ordered
  // record has its predecessor ordered before it, in a chain that is a line» —
  // and nothing else:
  //
  //  1. a rev-1 record names ITSELF as its chain and claims no predecessor;
  //  2. `prev` is accepted, in the SAME chain, exactly one revision back.
  //
  // The rest of the graph verdict is stage A's and stays there, because these
  // two already imply it for ordering purposes: a link into another collection
  // cannot even be looked up (the key carries the kind); a chain whose root
  // record is absent has no rev-1 to stand on, so (1) and (2) refuse it; and a
  // non-integer or descending `rev` can never bottom out at a rev-1 record, so
  // the whole run of them is refused.
  //
  // A FORK IS NOT REFUSED, and an earlier version of this list said it was.
  // Two records may share `(kind, root, rev)`: `rev` is assigned locally as
  // `current.rev + 1`, so two devices editing offline produce one position by
  // construction, and the app keeps both versions on purpose (`chains.ts`).
  // Refusing the second one dropped an ordinary two-device edit on the floor
  // and counted it as `skipped` — the import reporting data as unrestorable
  // that the app itself considers current history. Ordering never needed the
  // rule: every record names its predecessor BY ID, so a child sorts after its
  // own parent whichever branch it is on.
  //
  // Checked here rather than trusted from the caller for the same reason the
  // merge writer re-applies the upload barrier: the guarantee is this module's
  // to make, and an invariant that holds only while every caller remembers to
  // validate first is not an invariant.
  const accepted = new Map<string, PlannedRecord>();
  const refused = new Map<string, NotAppliedCounter>();
  for (const record of notApplied) refused.set(key(record.kind, record.id), record.counter);

  const ordered: PlannedRecord[] = [];
  for (const record of readable) {
    const prevKey = record.prev === undefined ? undefined : key(record.kind, record.prev);
    const prev = prevKey === undefined ? undefined : accepted.get(prevKey);
    const linked = record.rev === 1
      // A chain's first version names itself: a rev-1 record pointing at
      // someone else's chain would be a SECOND first version there.
      ? record.root === record.id && record.prev === undefined
      : prev !== undefined && prev.root === record.root && prev.rev === record.rev - 1;

    if (!linked) {
      // A descendant is missing for its ANCESTOR's reason (D12a). A link stage
      // A would have rejected outright has no ancestor to inherit from, and
      // «left unapplied» is all that can honestly be said about it.
      const counter = (prevKey === undefined ? undefined : refused.get(prevKey)) ?? 'skipped';
      notApplied.push({ kind: record.kind, id: record.id, counter });
      refused.set(key(record.kind, record.id), counter);
      continue;
    }
    accepted.set(key(record.kind, record.id), record);
    ordered.push(record);
  }

  return { ordered, notApplied };
}

const key = (kind: PlannedKind, id: string): string => `${kind}:${id}`;

/**
 * Outcomes after which the rest of the chain must NOT be attempted.
 *
 * The test is «did this record end up present and agreeing with the file?»,
 * not «did anything change». A no-op leaves the record present and equivalent,
 * so its descendants are still safe to apply. A conflict does not: the local
 * version differs from the file's, so a later version written from the file
 * would sit on top of a predecessor the file does not describe — exactly the
 * inconsistent graph this planning exists to prevent (D12a).
 */
export const CASCADING_OUTCOMES = new Set([
  'conflicts',
  'unsupportedLocal',
  'deferred',
  'skipped',
  'concurrentChange',
  'quotaStopped',
]);

export const cascades = (outcome: string): boolean => CASCADING_OUTCOMES.has(outcome);
