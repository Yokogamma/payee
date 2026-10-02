/**
 * PR-4 «Multi-index restore union» — the PURE half.
 *
 * Everything here is env-free and fetch-free so the rules that decide which
 * candidates a restore sees, in which order, and when a disagreement between
 * indexes becomes a user-visible `incomplete`, can be tested exhaustively
 * without a gateway in the loop. The network half (paging each logical source
 * through its transports, probing statuses) lives in `arweave.ts`.
 *
 * Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-4 and D11 (§2, v16), plus the
 * three clarifications of the 2026-09-23 review (operator map in the gateway
 * config; `block: null` ordering as ONE comparison function; `incomplete` by
 * ANY cause never advances `sweep-full-at`).
 */

import type { StatusVote } from './status-quorum';

// ─── D11 thresholds (PRELIMINARY — calibrated on PR-2/PR-3a shadow metrics) ──

/** Age in CONFIRMATIONS (never milliseconds — `/tx/<id>/status` reports
 *  `number_of_confirmations`, and turning that into wall-clock time would put a
 *  block-time estimate into the trusted path). ~2 min per block ⇒ 50 is well
 *  past any honest index lag. */
export const MIN_PRESENCE_CONFIRMATIONS = 50;
/** Two honest status origins may sit on different chain tips. */
export const MAX_STATUS_HEIGHT_SKEW = 5;
/** Ceiling on presence disagreements probed per sweep; beyond it: metric,
 *  no flag (the safe side — the note itself is already restored by the union). */
export const MAX_PRESENCE_PROBES_PER_SWEEP = 20;
/** Age is established only by ≥2 INDEPENDENT operators (D11, v16 M4). */
export const MIN_INDEPENDENT_AGE_VOTES = 2;

// ─── Shapes ─────────────────────────────────────────────────────────────

/** One edge as ONE index returned it. `height` is the index's own,
 *  UNSIGNED `block.height` — it orders candidates and does nothing else. */
export interface IndexEdge {
  txId: string;
  noteId: string;
  version: string;
  height: number | null;
}

/** What one LOGICAL source (a group of transports for the same index) yielded. */
export interface SourceSweep {
  /** Position in `INDEX_SOURCES`; only used for diagnostics. */
  source: number;
  /** `true` ⟺ the source was read to its end through ONE transport. A source
   *  that failed mid-walk is `false` — and its silence about a txId is NOT a
   *  disagreement (v16). */
  complete: boolean;
  edges: readonly IndexEdge[];
  /** `true` when `edges` were assembled from MORE THAN ONE transport (a
   *  failed primary's finds appended to the fallback's walk). Such a list is
   *  not one index's HEIGHT_DESC stream any more, so the single-source
   *  «keep the edge order» guarantee does not apply to it (review 24.09 #2):
   *  the union must apply the total order even with one logical source. */
  merged?: boolean;
}

/** A txId after the union: the identity the sweep will act on, and who said so. */
export interface UnionCandidate {
  txId: string;
  noteId: string;
  version: string;
  /** Deterministic ordering height: the MAX of the non-null heights the sources
   *  reported (an index cannot push a candidate DOWN by under-reporting), or
   *  null when no source knew one. Never a trust input. */
  height: number | null;
  /** Indexes of the sources that returned this txId. */
  seenBy: readonly number[];
  /** Sources disagreed about a SIGNED field (Note-Id / App-Version). The
   *  candidate is kept — the verified header (D9) is the arbiter — but its tag
   *  identity is untrusted: it is never treated as known and never dropped
   *  below a sentinel. Fail open towards MORE work, never less. */
  metadataConflict: boolean;
}

export interface UnionResult {
  /** Candidates in the order the sentinel pass and the claim pass will use. */
  ordered: UnionCandidate[];
  /** txIds returned by some COMPLETE source and absent from another COMPLETE
   *  source — the D11 presence disagreements, deterministic order (txId ASC). */
  presenceDisagreements: string[];
  /** Number of txIds whose signed-field metadata differed between sources. */
  metadataConflicts: number;
  /** `true` when the deterministic total ordering was applied: ≥2 sources,
   *  or one source whose edges came from more than one transport. `false`
   *  only for ONE source read through ONE transport, where the index's own
   *  edge order is kept byte-for-byte (regression anchor:
   *  arweave.incremental.test.ts). */
  resorted: boolean;
}

// ─── Ordering ───────────────────────────────────────────────────────────

/**
 * THE comparison function for the multi-source order (clarification 2 of the
 * review): height DESC for known heights, every null-height candidate after
 * every known one, ties broken by txId ASC. Total and deterministic, so any
 * permutation of source answers yields the same sequence — which is what keeps
 * the sentinel drop and the claim pass independent of which index answered
 * first.
 */
export function compareCandidates(
  a: { height: number | null; txId: string },
  b: { height: number | null; txId: string },
): number {
  if (a.height !== null && b.height !== null && a.height !== b.height) return b.height - a.height;
  if (a.height === null && b.height !== null) return 1;
  if (a.height !== null && b.height === null) return -1;
  return a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0;
}

// ─── Union ──────────────────────────────────────────────────────────────

/**
 * Merge the sweeps of every logical source into one candidate list.
 *
 * Rules (§4.PR-4, v15/v16):
 *  - the union NEVER drops a txId: every candidate goes on to verify+decrypt;
 *  - a signed-field disagreement between sources is a metric and marks the
 *    candidate `metadataConflict` (identity untrusted); the txId stays;
 *  - a height disagreement is resolved by the ordering rule alone;
 *  - presence is judged ONLY between COMPLETE sources;
 *  - with ONE source read through ONE transport the edge order is preserved
 *    exactly (no re-sort); a source assembled from several transports is
 *    ordered like a multi-source union (its edges are no single stream).
 */
export function unionSweeps(sweeps: readonly SourceSweep[]): UnionResult {
  const byId = new Map<string, {
    txId: string; noteId: string; version: string; height: number | null;
    seenBy: number[]; metadataConflict: boolean;
  }>();
  const firstSeenOrder: string[] = [];

  for (const sweep of sweeps) {
    // A source that returned the same txId twice (paging glitch) is one vote.
    const seenHere = new Set<string>();
    for (const edge of sweep.edges) {
      if (seenHere.has(edge.txId)) continue;
      seenHere.add(edge.txId);
      const held = byId.get(edge.txId);
      if (held === undefined) {
        byId.set(edge.txId, {
          txId: edge.txId, noteId: edge.noteId, version: edge.version, height: edge.height,
          seenBy: [sweep.source], metadataConflict: false,
        });
        firstSeenOrder.push(edge.txId);
        continue;
      }
      held.seenBy.push(sweep.source);
      if (held.noteId !== edge.noteId || held.version !== edge.version) held.metadataConflict = true;
      if (edge.height !== null && (held.height === null || edge.height > held.height)) held.height = edge.height;
    }
  }

  const candidates = firstSeenOrder.map(id => {
    const c = byId.get(id)!;
    return { ...c, seenBy: [...c.seenBy] as readonly number[] };
  });

  const resorted = sweeps.length > 1 || sweeps.some(s => s.merged === true);
  if (resorted) candidates.sort(compareCandidates);

  const completeSources = sweeps.filter(s => s.complete).map(s => s.source);
  const presenceDisagreements: string[] = [];
  if (completeSources.length >= 2) {
    for (const c of candidates) {
      const seenByComplete = c.seenBy.filter(s => completeSources.includes(s)).length;
      if (seenByComplete > 0 && seenByComplete < completeSources.length) presenceDisagreements.push(c.txId);
    }
    presenceDisagreements.sort();
  }

  return {
    ordered: candidates,
    presenceDisagreements,
    metadataConflicts: candidates.reduce((n, c) => n + (c.metadataConflict ? 1 : 0), 0),
    resorted,
  };
}

// ─── D11 age from the STATUS quorum ─────────────────────────────────────

/**
 * Is this txId PROVABLY older than any honest index lag?
 *
 * Decided by the status origins alone — what any index said in `block` plays
 * no part, in either direction (v15 M2). Votes are deduplicated by operator:
 * two origins of one operator are ONE voice, and an origin without a known
 * operator is no voice at all (fail-closed). Required: at least
 * `MIN_INDEPENDENT_AGE_VOTES` distinct operators, each reporting `confirmed`
 * with `confirmations ≥ MIN_PRESENCE_CONFIRMATIONS`, and their block heights
 * within `MAX_STATUS_HEIGHT_SKEW` of each other. A disagreement about the fact
 * of inclusion is not counted against them — it simply is not a vote for age —
 * but a height spread beyond the skew means the voices do not describe one
 * chain and the age is NOT established.
 */
export function ageProvenByQuorum(
  votes: readonly StatusVote[],
  operatorOf: (origin: string) => string | null,
  thresholds: {
    minConfirmations?: number;
    maxHeightSkew?: number;
    minOperators?: number;
  } = {},
): boolean {
  const minConfirmations = thresholds.minConfirmations ?? MIN_PRESENCE_CONFIRMATIONS;
  const maxHeightSkew = thresholds.maxHeightSkew ?? MAX_STATUS_HEIGHT_SKEW;
  const minOperators = thresholds.minOperators ?? MIN_INDEPENDENT_AGE_VOTES;

  // One voice per operator: the LOWEST confirmation count that operator
  // reported (conservative, as in statusVerdict).
  const byOperator = new Map<string, { confirmations: number; blockHeight: number }>();
  for (const vote of votes) {
    if (vote.kind !== 'confirmed') continue;
    const operator = operatorOf(vote.origin);
    if (operator === null) continue;
    const held = byOperator.get(operator);
    if (held === undefined || vote.confirmations < held.confirmations) {
      byOperator.set(operator, { confirmations: vote.confirmations, blockHeight: vote.blockHeight });
    }
  }
  const voices = [...byOperator.values()].filter(v => v.confirmations >= minConfirmations);
  if (voices.length < minOperators) return false;
  const heights = voices.map(v => v.blockHeight);
  return Math.max(...heights) - Math.min(...heights) <= maxHeightSkew;
}

/**
 * Which disagreements to probe, and in what order: deterministic (txId ASC —
 * the local `firstSeenAt` the plan names as the primary key is not part of the
 * `known` map the sweep receives, so the tie-break is the whole key here; that
 * gap is recorded in the plan), capped by the per-sweep budget.
 */
export function selectPresenceProbes(
  disagreements: readonly string[],
  budget: number = MAX_PRESENCE_PROBES_PER_SWEEP,
): { probe: string[]; budgetExhausted: boolean } {
  const sorted = [...disagreements].sort();
  return { probe: sorted.slice(0, budget), budgetExhausted: sorted.length > budget };
}
