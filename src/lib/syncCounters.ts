/**
 * Sync counters, per NOTE (chain) and per VERSION (transaction).
 *
 * Extracted from the settings panel so the status line and the panel cannot
 * drift: two places computing "how much is safely on chain" from the same data
 * with slightly different rules is a contradiction the user would have to
 * resolve themselves.
 *
 * «В блокчейне» is `confirmed`-ONLY, deliberately: the reset warning treats
 * exactly that status as recoverable, and a counter that called an `accepted`
 * note "saved" would contradict the dialog that is about to wipe it.
 *
 * A chain qualifies only when EVERY version does (`every`, not `some`) — a
 * half-uploaded note must not look finished. The two lines are disjoint by
 * construction, and a chain that still holds a queued/errored version falls
 * into NEITHER: it is neither stored nor fully transmitted, and its versions
 * are already visible in «Ожидают загрузки» / «Ошибки».
 */

import type { NoteChain } from './chains';
// `import type` only — erased at compile time, so no runtime cycle with the
// store even though the store is the bigger module.
import type { NoteSyncInfo } from './store';

export interface SyncCounters {
  /** Chains whose every version is `confirmed`. */
  confirmedChains: number;
  /** Chains fully transmitted but not yet confirmed (at least one `accepted`). */
  pendingChains: number;
  /**
   * Every stored version, from the storage-backed aggregates — NOT
   * `notes.length`, which omits versions this build cannot decrypt.
   */
  totalVersions: number;
}

export interface SyncAggregates {
  confirmedCount: number;
  acceptedCount: number;
  unsyncedCount: number;
}

export function computeSyncCounters(
  chains: readonly NoteChain[],
  syncStatuses: Record<string, NoteSyncInfo>,
  arweave: SyncAggregates,
): SyncCounters {
  const statusOf = (id: string) => syncStatuses[id]?.status;
  return {
    confirmedChains: chains.filter(
      c => c.versions.every(v => statusOf(v.id) === 'confirmed'),
    ).length,
    pendingChains: chains.filter(
      c =>
        c.versions.every(v => statusOf(v.id) === 'confirmed' || statusOf(v.id) === 'accepted') &&
        c.versions.some(v => statusOf(v.id) === 'accepted'),
    ).length,
    totalVersions: arweave.confirmedCount + arweave.acceptedCount + arweave.unsyncedCount,
  };
}

/**
 * What a quarantined record actually is, in one sentence, in ONE place.
 *
 * `SyncRecord.terminalError` is `'unsupported_version' | 'malformed_record'`:
 * either a record a newer build wrote, or a row that is simply broken. Naming
 * only the first — as both the status line and the settings panel did, in two
 * separately-worded copies — tells the owner of a corrupted row to «update the
 * app», which will not help and hides the real problem.
 *
 * Exported rather than duplicated for the same reason the scrub selector is:
 * two copies of one explanation drift, and the drift is invisible until someone
 * reads both.
 */
export const QUARANTINE_EXPLANATION =
  'эта версия приложения не может обработать такие записи; повтор не поможет';
