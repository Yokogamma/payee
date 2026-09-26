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
 * only the SET is. Each answered consistently in the acceptance probes
 * (missing txId → 404, existing → 200) and sends `Access-Control-Allow-Origin: *`.
 *
 * `ar-io.dev` was REMOVED on 2026-09-27 (owner decision, runbook reader
 * release; payee-private-docs `arweave-status-operators-independence-2026-09-27.md`):
 * AR.IO's own documentation lists it as the SHARED TESTNET SANDBOX gateway —
 * «a testbed rather than a production plane» (https://docs.ar.io/build/testnet)
 * — and its certificate no longer matches the host. Under `all-configured-v1`
 * an origin that never answers makes the `dead` verdict unreachable for
 * everyone, so a dead member is not neutral: it disables redrop.
 */
export const STATUS_GATEWAYS = Object.freeze([
  'https://arweave.net',
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

/**
 * `canonicalOrigin → operatorId` for the STATUS pool (PR-4 / D11, v16 M4).
 *
 * The age of a txId one index returned and another omitted — and, since D10,
 * whether money is booked — is established only by status origins run by
 * DIFFERENT operators: two origins of one operator are one voice.
 *
 * Four origins, FOUR GROUPS BY THE ACCEPTED MODEL (owner decision 2026-09-27,
 * research in payee-private-docs `arweave-status-operators-independence-2026-09-27.md`):
 *   arweave.net   — Forward Research (HyperBEAM; formerly operated by AR.IO);
 *   vilenarios.com — AR.IO: run by its founder, the CEO of Permanent Data
 *                    Solutions — so it carries the operator id `ar-io`, and any
 *                    future AR.IO-run origin must map to `ar-io` too;
 *   frostor.xyz   — Memetic Block;
 *   permagate.io  — a separate operator. Its independence from AR.IO is an
 *                   ASSUMPTION the owner accepted (its 2024 registry note names
 *                   «DTF», plausibly a former AR.IO engineer), not a proof.
 * The client's built-in default (`src/lib/gateways.ts`, DEFAULT_STATUS_OPERATORS)
 * must say the same thing; `VITE_STATUS_OPERATORS`, when set, must equal this pin.
 */
export const STATUS_OPERATORS =
  'https://arweave.net=arweave,https://vilenarios.com=ar-io,'
  + 'https://frostor.xyz=frostor,https://permagate.io=permagate';

/** Build-time floor: below two configured origins `dead` is unreachable, so a
 *  production build pinned to one gateway would silently disable redrop. */
export const MIN_STATUS_ORIGINS = 2;

export const EXPECTED_STATUS_CSV = STATUS_GATEWAYS.join(',');
export const EXPECTED_PAYLOAD_CSV = PAYLOAD_GATEWAYS.join(',');

/**
 * The pools a HISTORICAL rollback target was built with — keyed by the FULL
 * SHA of ONE verified build, never a range (the same rule as
 * scripts/historical-candidates.mjs). Changing the pin above would otherwise
 * refuse the rollback the runbook promises: the gates compare the candidate's
 * own wrangler.toml with the pin, and the post-deploy smoke expects the pin's
 * hash and count on the live /health.
 *
 * For a listed SHA the gates hold the candidate to ITS pools (in order, for
 * payload) and the WORKER deploy's smoke — explicitly, with
 * `--allow-historical-pool` — expects ITS hash; every other candidate is held
 * to the current pin. The Pages pre-publish smoke never admits it: the client
 * it publishes is built on the current pin. Deliberately NOT a profile: the
 * rollback to 394156d runs under `normal` (runbook §5.1), and its /health
 * reports the same profile fields as any modern build.
 */
export const HISTORICAL_POOLS = Object.freeze({
  // The soak v3 candidate (worker 394156d, versionId 41773298…): live when the
  // pool changed on 2026-09-27; its /health attests statusGatewaysHash
  // ea0e6282b314266b over these five.
  '394156d5998dbaef5b1d273898ee8006104227f8': Object.freeze({
    status: Object.freeze([
      'https://arweave.net', 'https://ar-io.dev', 'https://vilenarios.com', 'https://frostor.xyz', 'https://permagate.io',
    ]),
    payload: Object.freeze(['https://arweave.net', 'https://vilenarios.com', 'https://ar-io.dev', 'https://frostor.xyz']),
    reason: 'soak v3 candidate — the pool before ar-io.dev was removed (2026-09-27)',
  }),
});

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The pinned pools a candidate must match: its historical entry, or the
 * current pin. `historical` tells the gate it is judging a rollback across a
 * pool change.
 */
export function poolsFor(candidate) {
  const entry = typeof candidate === 'string' && FULL_SHA_RE.test(candidate) ? HISTORICAL_POOLS[candidate] ?? null : null;
  return entry
    ? { statusCsv: entry.status.join(','), payloadCsv: entry.payload.join(','), historical: true }
    : { statusCsv: EXPECTED_STATUS_CSV, payloadCsv: EXPECTED_PAYLOAD_CSV, historical: false };
}
