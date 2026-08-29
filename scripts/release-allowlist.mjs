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
  // Empty on purpose: nothing but the trusted head is deployable right now.
]);

const SHA_RE = /^[0-9a-f]{40}$/;

/** Exact, case-sensitive membership. No prefix matching — see the header. */
export function isAllowedRelease(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return false;
  return RELEASE_ALLOWLIST.includes(sha);
}
