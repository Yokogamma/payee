/**
 * Arweave gateway configuration — PINNED AT BUILD TIME (D1).
 *
 * Like `VITE_TRUSTED_OWNERS`, these lists are build-time constants and never
 * fetched at runtime: restore must not depend on a live endpoint, and the CSP
 * `connect-src` is generated from exactly these values (scripts/postbuild.mjs).
 * Changing the set is therefore a release — and, because a swapped list would
 * quietly redirect a stable Owner-Hash, IP and txId to hosts nobody approved,
 * the values are ALSO repo-pinned in `scripts/check-deploy-config.mjs`, so the
 * change is a reviewed PR rather than a Settings edit.
 *
 * Approved composition: docs/ARWEAVE-RESILIENCE-PLAN.md §2.1.
 *
 * ── The empty env is NOT the old behavior ──────────────────────────────────
 *
 * With no variables set these lists fall back to the single `arweave.net` the
 * code used before, but the STATUS SEMANTICS around them changed regardless: a
 * lone 404 is no longer `dropped`, because `dead` now requires every configured
 * origin to agree AND at least two of them to exist (status-quorum.ts). With one
 * configured origin `dead` is simply unreachable — deliberately, and the
 * production deploy gate refuses to ship that configuration at all.
 */

import { parseIndexSources, parseOriginList } from './gateways-parse';

export { MIN_STATUS_ORIGINS, QUORUM_POLICY_ID } from './status-quorum';

const DEFAULT_ORIGIN = 'https://arweave.net';
const DEFAULT_INDEX_URL = `${DEFAULT_ORIGIN}/graphql`;

function originsOrDefault(raw: string): string[] {
  const parsed = parseOriginList(raw);
  return parsed.length > 0 ? parsed : [DEFAULT_ORIGIN];
}

/**
 * Probed in PARALLEL for the dead-quorum, so this order is NOT normative — and
 * the `/health` attestation hash sorts before hashing for that very reason.
 */
export const STATUS_GATEWAYS: readonly string[] = originsOrDefault(
  import.meta.env.VITE_STATUS_GATEWAYS ?? '',
);

/**
 * Tried in ORDER, and the order IS normative (§2.1): `arweave.net` first, then
 * the community mirrors whose cold `/raw` is slower. `permagate.io` is
 * deliberately absent — its cold `/raw` timed out in the acceptance probes —
 * while it remains a perfectly good STATUS origin.
 */
export const PAYLOAD_GATEWAYS: readonly string[] = originsOrDefault(
  import.meta.env.VITE_PAYLOAD_GATEWAYS ?? '',
);

/**
 * LOGICAL index sources: each entry is one source, listed as its primary URL
 * plus transport-fallbacks for the SAME index (`a|a-fallback,b`). Grouping is
 * load-bearing for PR-4, where completeness is counted per logical source: a
 * transport-fallback failing must not mark a sweep incomplete while both
 * independent indexes are alive.
 *
 * PR-3a only reads the first URL of the first source (the discovery query is
 * still single-index — the union is PR-4); the grouping and the CSP entries
 * land now so the configuration and the policy ship together.
 */
export const INDEX_SOURCES: readonly (readonly string[])[] = (() => {
  const parsed = parseIndexSources(import.meta.env.VITE_INDEX_SOURCES ?? '');
  return parsed.length > 0 ? parsed : [[DEFAULT_INDEX_URL]];
})();

/** The discovery endpoint used by the restore sweep (PR-3a: single index). */
export const INDEX_QUERY_URL: string = INDEX_SOURCES[0][0];
