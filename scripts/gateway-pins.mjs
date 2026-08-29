/**
 * The APPROVED gateway composition, pinned in the repository (D1/D7).
 *
 * Why pinned here and not only "present in the Environment": the build reads
 * these lists and the CSP is generated from them, so an edit in Settings would
 * silently redirect a stable Owner-Hash, a stable IP and every txId this vault
 * asks about to hosts nobody approved — and the CSP would allow it, because the
 * CSP is generated from the same edited value. Pinning turns "change the
 * gateway set" into a reviewed pull request, which is exactly what D1 means by
 * «смена = релиз».
 *
 * Composition and the acceptance probes behind it: docs/ARWEAVE-RESILIENCE-PLAN.md §2.1.
 */

/**
 * Probed in PARALLEL for the dead quorum, so the ORDER here is not normative —
 * only the SET is. All five answered consistently in the acceptance probes
 * (missing txId → 404, existing → 200) and send `Access-Control-Allow-Origin: *`.
 */
export const STATUS_GATEWAYS = Object.freeze([
  'https://arweave.net',
  'https://ar-io.dev',
  'https://vilenarios.com',
  'https://frostor.xyz',
  'https://permagate.io',
]);

/**
 * Tried in ORDER, and the order IS normative: arweave.net first, then the
 * community mirrors whose cold `/raw` is slower.
 *
 * `permagate.io` is deliberately ABSENT: its cold `/raw` timed out past 25 s in
 * the probes (and answered in 12 s from cache on a later run). Unstable on the
 * cold path disqualifies it from PAYLOAD — while leaving it a perfectly good
 * STATUS origin, where only the HTTP code matters.
 */
export const PAYLOAD_GATEWAYS = Object.freeze([
  'https://arweave.net',
  'https://vilenarios.com',
  'https://ar-io.dev',
  'https://frostor.xyz',
]);

/**
 * LOGICAL index sources: groups separated by `,`, transport-fallbacks for the
 * SAME index by `|`.
 *
 * There are exactly TWO independent index implementations — arweave.net and
 * Goldsky. `vilenarios.com/graphql` is a transport-fallback for the first, NOT
 * a third opinion: every ar.io gateway serves the index it built itself, so for
 * our purposes they are one logical source. Recording that in the grouping is
 * what keeps PR-4's completeness count honest.
 */
export const INDEX_SOURCES =
  'https://arweave.net/graphql|https://vilenarios.com/graphql,https://arweave-search.goldsky.com/graphql';

/** Build-time floor: below two configured origins `dead` is unreachable, so a
 *  production build pinned to one gateway would silently disable redrop. */
export const MIN_STATUS_ORIGINS = 2;

export const EXPECTED_STATUS_CSV = STATUS_GATEWAYS.join(',');
export const EXPECTED_PAYLOAD_CSV = PAYLOAD_GATEWAYS.join(',');
