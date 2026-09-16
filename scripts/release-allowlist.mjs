/**
 * Commits that may be deployed as a worker release, other than the trusted head.
 *
 * ── Why a tag was not enough ───────────────────────────────────────────────
 *
 * The floor gate used to accept "the head, or any TAGGED ancestor". Tags are
 * not branch protection: unless a tag ruleset is configured and proven, anyone
 * who can push a tag can make an arbitrary intermediate commit of a merged pull
 * request deployable — and every such commit IS an ancestor of the default
 * branch. That turns "only reviewed states ship" back into "anything that ever
 * existed ships", in a job holding the Cloudflare token.
 *
 * So the allowlist is a FILE on the protected default branch: adding an entry
 * is a reviewed change, exactly like raising MINIMUM_FLOOR. Being empty is the
 * correct steady state — the normal path deploys the head, and a rollback
 * target is added deliberately, in a pull request that says why.
 *
 * Entries are FULL 40-character SHAs. A short SHA is ambiguous, and ambiguity
 * is the thing this file exists to remove.
 */

export const RELEASE_ALLOWLIST = Object.freeze([
  // Format:
  //   'a'.repeat(40), // worker-rN — why this state is deployable
  //
  // Steady state is SHORT: the normal path deploys the trusted head, and an
  // entry here exists so that a rollback has somewhere to go BEFORE it is
  // needed. A red smoke is a detector, not a rollback (docs/ROLLBACK.md) — the
  // recovery is a dispatch of a SHA this list already admits, and a list that
  // is empty at that moment turns «roll back» into «open a pull request first».

  // worker-r4 — the PR-3a release (#130), the live worker since 2026-08-29
  // (run 33243712840, smoked green), and the value of MINIMUM_FLOOR. It is the
  // last state proven safe on the dev contour before semantic idempotency; a
  // D2 release found broken during its soak rolls back HERE — legitimately,
  // because the floor is not raised until the import flip (D2a).
  'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1',

  // The client-b1-era worker — head of main after #183, live since 2026-09-16
  // (run 35089754710, smoked green under `normal`): the first worker carrying
  // the server side of D14b (#180) on top of the semantic-idempotency line.
  // It is the version the client-b1 client is released against, so a client
  // rollback must have THIS worker to come back to while the floor is still
  // ff0954d — and the head of main has already moved past it (a docs merge).
  // Listed for the C10 rehearsal of docs/ROLLBACK.md «allowlist the live SHA
  // first, then dispatch it»: a redeploy of the pinned SHA through the gate,
  // bytes identical to what is running. It stays as the rollback target for
  // the releases that follow; it is not a fix for a defect in itself.
  '394156d5998dbaef5b1d273898ee8006104227f8',
]);

const SHA_RE = /^[0-9a-f]{40}$/;

/** Exact, case-sensitive membership. No prefix matching — see the header. */
export function isAllowedRelease(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return false;
  return RELEASE_ALLOWLIST.includes(sha);
}
