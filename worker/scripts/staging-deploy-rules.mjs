// NO SHEBANG: imported by deploy-staging.mjs and its test
// (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The rules of the staging deploy path, pure and tested (runbook reader
 * release M6, review 25.09): the checks a rehearsal relies on are MANDATORY
 * in the script, not remembered by the operator.
 *
 *   - config gates: the same repo-only gates CI runs, plus the spend limits
 *     and the per-contour trusted owners (both blocks of wrangler.toml);
 *   - the deployed SOURCES are clean: tracked changes anywhere, and untracked
 *     files under the roots the bundle is built from — an untracked module
 *     imported by the worker would ship while being in no commit, and the
 *     RELEASE_SHA the worker reports would then be a lie;
 *   - RELEASE_SHA = the HEAD of that clean tree, passed as `--var`, so
 *     `/health.releaseSha` of staging names a commit (it was null before);
 *   - the live smoke is required: no SMOKE_STAGING_ORIGIN, no deploy.
 */

/** Gates run before anything talks to Cloudflare — `[script, ...args]`,
 *  from the repository root. */
export const STAGING_CONFIG_GATES = Object.freeze([
  Object.freeze(['scripts/check-gateways-vs-worker.mjs', '--repo-only']),
  // Full rule set, no --contour: staging is exactly what ships here.
  Object.freeze(['scripts/check-trusted-owners.mjs', '--repo-only']),
  Object.freeze(['scripts/check-spend-limits.mjs']),
]);

/** Roots the worker bundle is built from: its own tree and the shared
 *  `src/lib` modules it imports (`../../src/lib/*`). */
export const DEPLOYED_SOURCE_ROOTS = Object.freeze(['worker', 'src']);

/** Below this many independent status operators no money quorum forms. */
export const STAGING_MIN_OPERATORS = 2;

const SHA_RE = /^[0-9a-f]{40}$/;

/** SMOKE_STAGING_ORIGIN must exist and be a bare https origin — checked
 *  BEFORE the deploy, so a missing smoke can never follow a live deploy. */
export function stagingSmokeOrigin(raw) {
  if (!raw) {
    return {
      ok: false,
      reason: 'SMOKE_STAGING_ORIGIN is required: the live smoke is mandatory on the staging path (runbook M6). ' +
        'Name the staging worker origin; nothing is deployed without it.',
    };
  }
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'SMOKE_STAGING_ORIGIN is not a URL' }; }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    return { ok: false, reason: 'SMOKE_STAGING_ORIGIN must be a bare https origin' };
  }
  return { ok: true, origin: url.origin };
}

/**
 * The lines that make the deployed sources unclean: every tracked change
 * (`git status --porcelain --untracked-files=no`, whole repository) and every
 * untracked, non-ignored file under DEPLOYED_SOURCE_ROOTS
 * (`git status --porcelain --untracked-files=all -- <roots>`). Empty = clean.
 */
export function uncleanDeploySources(trackedPorcelain, rootsPorcelain) {
  const lines = (s) => String(s ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
  const untracked = lines(rootsPorcelain).filter((l) => l.startsWith('?? '));
  return [...lines(trackedPorcelain), ...untracked];
}

/** `git rev-parse HEAD` output → the full SHA, or null when it is not one. */
export function releaseShaOf(revParseOutput) {
  const sha = String(revParseOutput ?? '').trim();
  return SHA_RE.test(sha) ? sha : null;
}

/** The wrangler arguments of the staging deploy, RELEASE_SHA included. */
export function stagingDeployArgs(sha) {
  if (!SHA_RE.test(sha)) throw new Error(`RELEASE_SHA must be a full 40-hex SHA, got ${JSON.stringify(sha)}`);
  return ['deploy', '--env', 'staging', '--var', `RELEASE_SHA:${sha}`];
}

/** The env of the post-deploy smoke: the SHA, the activated version and the
 *  operator floor are all asserted on the live `/health`. */
export function stagingSmokeEnv(baseEnv, { sha, versionId }) {
  return {
    ...baseEnv,
    EXPECT_RELEASE_SHA: sha,
    EXPECT_WORKER_VERSION_ID: versionId,
    EXPECT_MIN_OPERATORS: String(STAGING_MIN_OPERATORS),
  };
}
