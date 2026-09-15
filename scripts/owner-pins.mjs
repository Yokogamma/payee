/**
 * The HISTORICAL set of Arweave wallet addresses this project has ever posted
 * under — pinned in the repository, and APPEND-ONLY (D2, §2 «Предусловие»).
 *
 * ── Why the worker needs a list at all ───────────────────────────────
 *
 * D9 authenticates a publication before the worker is allowed to bind a `txId`
 * to a fingerprint, and one of its steps is `address ∈ TRUSTED_OWNERS`. Without
 * it the protocol is weakened to «some well-formed transaction exists», which
 * an attacker can satisfy by posting their own. The worker had no such list:
 * the only wallet it knows is its CURRENT `ARWEAVE_JWK`, and that is precisely
 * the wrong thing to check against — after a rotation it would fail to confirm
 * the project's OWN older transactions, turning healthy records into conflicts.
 *
 * ── Why append-only, and why pinned HERE ─────────────────────────────
 *
 * Configuration drifts in one direction: someone removes an owner that «looks
 * unused», forgets the staging table, or points `ARWEAVE_JWK` at an address
 * outside the set. Every one of those silently narrows the trust set, and a
 * narrowed set does not fail loudly — it re-classifies old, healthy
 * publications as unverifiable, which the upload path must then answer with a
 * conflict or a 503.
 *
 * So the registry lives in a file on the protected default branch, and
 * `scripts/check-trusted-owners.mjs` refuses a deploy whose configured set does
 * not CONTAIN all of it. Adding an owner is a reviewed pull request; removing
 * one is refused outright by the frozen tuple below.
 *
 * ── Rotation runbook (docs/ROLLBACK.md) ──────────────────────────────
 *
 *   1. add the NEW address here AND to both `TRUSTED_OWNERS` tables in
 *      worker/wrangler.toml AND to `VITE_TRUSTED_OWNERS`;
 *   2. deploy the worker and the client;
 *   3. only THEN switch `ARWEAVE_JWK` to the new wallet.
 *
 * Never in the other order: the worker refuses `/upload` while its own wallet
 * address is outside the set (fail-closed), so switching the key first takes
 * uploads down.
 */

/**
 * Every address the project has posted under, oldest first.
 *
 * Appending is a reviewed change. REMOVING an entry is not a change but a
 * defect: transactions signed by it stay on chain forever, and dropping the
 * address makes them permanently unverifiable.
 */
export const HISTORICAL_OWNERS = Object.freeze([
  // The dev-contour proxy wallet — the only wallet used so far. Same value the
  // client pin in scripts/check-deploy-config.mjs requires VITE_TRUSTED_OWNERS
  // to include.
  'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE',
]);

/**
 * The monotonicity floor: entries that may NEVER leave `HISTORICAL_OWNERS`.
 *
 * Deliberately a SECOND literal rather than a derived value. The registry above
 * is edited by people, and «append-only» enforced only by review is a habit,
 * not a gate — the same reasoning that put `MINIMUM_FLOOR` in
 * `scripts/check-worker-floor.mjs` next to the movable Environment variable.
 * A test asserts containment, so shrinking the registry turns red instead of
 * shipping.
 *
 * New owners are appended to `HISTORICAL_OWNERS` first and land here in the
 * same pull request, which is what makes their removal refused from then on.
 */
export const NEVER_REMOVE = Object.freeze([
  'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE',
]);

/** Canonical CSV spelling, for messages and for the wrangler.toml pin. */
export const HISTORICAL_OWNERS_CSV = HISTORICAL_OWNERS.join(',');
