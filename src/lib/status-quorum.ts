/**
 * TX-status quorum — ONE implementation for the client and the Worker.
 *
 * Pure, env-free and DOM-free on purpose: `worker/src/index.ts` imports this
 * exact file, so the dead-verdict formula cannot drift between the two halves
 * that both spend money on being wrong about it (precedent for the cross-half
 * import: `worker/test/client-parity.test.ts`).
 *
 * Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-3a «Статус — кворум».
 */

/**
 * The capability id `/health` attests, and the ONLY place it is defined.
 *
 * Deliberately a CODE constant rather than a `wrangler.toml` var: if the id
 * came from configuration, a build carrying the old single-gateway semantics
 * could be relabelled as this one and re-enable uploads — which is exactly the
 * hole the attestation exists to close. Changing the algorithm and changing
 * this string are the same edit, in the same file, in one commit.
 *
 * An emergency build that deliberately carries the PRE-quorum semantics
 * declares `legacy-single-v0` instead, and passes only the emergency deploy
 * profile (which additionally requires every upload flag to be off).
 */
export const QUORUM_POLICY_ID = 'all-configured-v1';

/**
 * Build-time floor on the number of configured status origins (PR-6).
 *
 * The runtime «how many answered» threshold of earlier drafts is GONE: `dead`
 * now requires every configured origin to say 404, so the only threshold left
 * is this one, and it is checked by the deploy config gate — a production build
 * pinned to a single gateway can never reach a `dead` verdict at all, which
 * would silently disable redrop rather than make it safe.
 */
export const MIN_STATUS_ORIGINS = 2;

/** One origin's answer. `origin` is the CANONICAL origin, and it is what the
 *  completeness check below is computed over. */
export type StatusVote =
  | { origin: string; kind: 'confirmed'; confirmations: number; blockHeight: number }
  | { origin: string; kind: 'pending' }
  | { origin: string; kind: 'dead404' }
  /** Timeout, 4xx (400 included), 5xx, network error, or a 200 whose body failed
   *  the schema. Never alive; for the dead formula it is a NON-404 outcome. */
  | { origin: string; kind: 'other' };

export type QuorumVerdict =
  | { kind: 'confirmed'; confirmations: number; blockHeight: number }
  | { kind: 'pending' }
  | { kind: 'dead' }
  | { kind: 'unavailable' };

/** Thrown when the vote set does not describe the configured set exactly. This
 *  is a PROGRAMMING error (a caller filtered or duplicated votes), not a runtime
 *  state — silently tolerating it is how a partial set of 404s becomes a false
 *  `dead`, and a false `dead` opens a paid re-post. */
export class StatusVoteSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusVoteSetError';
  }
}

/**
 * The normative verdict table (ONE table for client and Worker):
 *
 *   ≥1 origin with a valid 200        → confirmed
 *   ≥1 origin with 202, no 200        → pending
 *   EVERY configured origin said 404  → dead   (requires ≥2 configured)
 *   anything else                     → unavailable
 *
 * `dead ⟺ deadVotes === configuredOrigins.length && length >= 2`. ANY non-404
 * outcome from ANY origin — timeout, 429, 5xx, 400, malformed 200, network
 * error — makes `dead` unreachable this round. The price is understood: one
 * flapping gateway out of five defers `dead`, and that is the safe side, because
 * `dead` is the only thing that authorizes spending money, while a stuck
 * `unavailable` merely means "try later".
 *
 * `configuredOrigins` is a PARAMETER, not derived from `votes`: a function that
 * only sees the votes cannot tell a complete set of two 404s from two votes
 * filtered out of five configured origins.
 */
export function statusVerdict(
  configuredOrigins: readonly string[],
  votes: readonly StatusVote[],
): QuorumVerdict {
  assertVoteSetMatches(configuredOrigins, votes);

  const confirmed = votes.filter(
    (v): v is Extract<StatusVote, { kind: 'confirmed' }> => v.kind === 'confirmed',
  );
  if (confirmed.length > 0) {
    // CONSERVATIVE aggregation when gateways disagree: the LOWEST confirmation
    // count wins. `afterPoll` turns a confirmed record terminal at a threshold,
    // so taking the minimum can only delay terminality, never rush it.
    // Tie-breaks are deterministic and total: block height, then origin
    // lexicographically (the status order is NOT normative — see
    // serializeStatusOrigins — so "first in config" would not be stable).
    const winner = [...confirmed].sort(
      (a, b) =>
        a.confirmations - b.confirmations ||
        a.blockHeight - b.blockHeight ||
        (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0),
    )[0];
    return { kind: 'confirmed', confirmations: winner.confirmations, blockHeight: winner.blockHeight };
  }

  if (votes.some(v => v.kind === 'pending')) return { kind: 'pending' };

  const deadVotes = votes.reduce((n, v) => n + (v.kind === 'dead404' ? 1 : 0), 0);
  if (deadVotes === configuredOrigins.length && configuredOrigins.length >= MIN_STATUS_ORIGINS) {
    return { kind: 'dead' };
  }

  return { kind: 'unavailable' };
}

/**
 * Exactly one vote per configured origin — checked as SET EQUALITY, not by
 * length. A vote whose origin is not configured, a duplicate, or a missing
 * origin all throw: with only a length check, swapping one vote for a foreign
 * origin of the same set size would pass and could still produce `dead`.
 */
function assertVoteSetMatches(configuredOrigins: readonly string[], votes: readonly StatusVote[]): void {
  const configured = new Set(configuredOrigins);
  if (configured.size !== configuredOrigins.length) {
    throw new StatusVoteSetError('configuredOrigins contains duplicates');
  }
  const voted = new Set<string>();
  for (const vote of votes) {
    if (!configured.has(vote.origin)) {
      throw new StatusVoteSetError(`vote from an origin that is not configured: ${vote.origin}`);
    }
    if (voted.has(vote.origin)) {
      throw new StatusVoteSetError(`duplicate vote for origin: ${vote.origin}`);
    }
    voted.add(vote.origin);
  }
  if (voted.size !== configured.size) {
    throw new StatusVoteSetError(
      `expected one vote per configured origin (${configured.size}), got ${voted.size}`,
    );
  }
}

/**
 * The shared verdict names map onto the client's public `TxStatusResult.kind`,
 * which has said `dropped` since long before this module existed. The rename
 * happens HERE, once, so the two vocabularies cannot drift apart silently.
 */
export function toTxStatusKind(
  verdict: QuorumVerdict['kind'],
): 'confirmed' | 'pending' | 'dropped' | 'unavailable' {
  return verdict === 'dead' ? 'dropped' : verdict;
}
