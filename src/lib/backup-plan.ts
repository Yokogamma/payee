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
 * Two rules produce that:
 *  - records are applied ROOT → REV ASCENDING, so a version is never written
 *    before the one it points back to;
 *  - a record that is not applied CASCADES: every later version in its chain
 *    is marked skipped with the same reason, without being attempted.
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

/** A record the FILE carries that this build cannot read (D11a). Never written
 *  to the store: the local queue would try to serialize it and quarantine it
 *  permanently as `unsupported_version`, and that quarantine is irreversible.
 *  It is counted, warned about, and left in the file. */
export interface UnsupportedRecord {
  kind: PlannedKind;
  id: string;
}

export interface ImportPlan {
  /** Application order. Chains may interleave; within a chain, revisions
   *  strictly ascend. */
  ordered: PlannedRecord[];
  unsupported: UnsupportedRecord[];
  /** Chain key → the ordered ids in it, so a stopped chain can be accounted
   *  for without walking the whole plan again. */
  chainOf: Map<string, string>;
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
  const ordered: PlannedRecord[] = [];
  const unsupported: UnsupportedRecord[] = [];
  const chainOf = new Map<string, string>();

  for (const input of inputs) {
    if (input.topology === undefined) {
      unsupported.push({ kind: input.kind, id: input.id });
      continue;
    }
    ordered.push({
      kind: input.kind,
      id: input.id,
      record: input.record,
      root: input.topology.root,
      rev: input.topology.rev,
      prev: input.topology.prev,
    });
    chainOf.set(`${input.kind}:${input.id}`, chainKey(input.kind, input.topology.root));
  }

  // Ascending `rev` within a chain IS the topological order: `prev` always
  // points at a lower revision of the same chain, so nothing can be written
  // before what it depends on. Chains are then kept together, which is not
  // required for correctness but makes a stopped import easy to read.
  ordered.sort((a, b) => {
    const chainA = chainKey(a.kind, a.root);
    const chainB = chainKey(b.kind, b.root);
    if (chainA !== chainB) return chainA < chainB ? -1 : 1;
    return a.rev - b.rev;
  });

  return { ordered, unsupported, chainOf };
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
