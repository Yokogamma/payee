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

/** A record the plan will NOT apply, and which is therefore counted, warned
 *  about, and left in the file.
 *
 * Two ways in, one outcome. Either the FILE's record is one this build cannot
 * read (D11a) — writing it would have the local queue serialize it and
 * quarantine it permanently, and that quarantine is irreversible — or the
 * record is readable but its predecessor is not in the plan, in which case
 * applying it alone would strand it (D12a). The user hears the same sentence
 * for both: something is still in the file that is not in the store. */
export interface UnsupportedRecord {
  kind: PlannedKind;
  id: string;
}

export interface ImportPlan {
  /** Application order. Chains may interleave; within a chain, revisions
   *  strictly ascend. */
  ordered: PlannedRecord[];
  /** Everything the plan refuses to attempt — unreadable records and the
   *  descendants stranded behind them. */
  unsupported: UnsupportedRecord[];
}

export interface PlanInput {
  kind: PlannedKind;
  id: string;
  record: EncryptedNote | EncryptedSafeboxEntry;
  /** Topology from the decrypted envelope, or `undefined` when this build
   *  could not read the record at all. */
  topology?: { root: string; rev: number; prev?: string };
}

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
  const unsupported: UnsupportedRecord[] = [];

  for (const input of inputs) {
    if (input.topology === undefined) {
      unsupported.push({ kind: input.kind, id: input.id });
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

  // One forward pass in that order decides who has a predecessor to stand on.
  // A record whose `prev` has not already been accepted is stranded, and so is
  // everything behind it — the memo carries the verdict down the chain without
  // walking it again.
  //
  // «Not already accepted» is deliberately stricter than «present somewhere»:
  // on input stage A would have rejected — a forward reference, a link into
  // another chain — the predecessor is not in the memo yet and the record is
  // set aside. Fail-closed is the right direction for a graph that is already
  // known to be wrong.
  const accepted = new Set<string>();
  const ordered: PlannedRecord[] = [];
  for (const record of readable) {
    const stands = record.prev === undefined || accepted.has(`${record.kind}:${record.prev}`);
    if (!stands) {
      unsupported.push({ kind: record.kind, id: record.id });
      continue;
    }
    accepted.add(`${record.kind}:${record.id}`);
    ordered.push(record);
  }

  return { ordered, unsupported };
}

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
