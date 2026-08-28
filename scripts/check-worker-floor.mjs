// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The worker deploy gate: two questions about one candidate SHA.
 *
 *   1. TRUST — is the candidate reachable from the trusted head (the default
 *      branch this workflow was dispatched from)? Code that never went through
 *      branch protection must not be deployed, and must not even be RUN: the
 *      deploy job installs and tests the candidate in a runner that holds the
 *      Cloudflare token, so «deploy an arbitrary SHA» is «execute arbitrary
 *      code with the deploy credentials in scope».
 *   2. FLOOR (D2a) — is the candidate a descendant of the floor, i.e. not a
 *      rollback below the version released clients depend on?
 *
 * The first check is what makes the second one worth having. Without it the
 * Environment's branch policy is satisfied by the dispatch ref while the code
 * actually deployed comes from anywhere — which is how this gate was written
 * the first time, and it made the deploy strictly less safe than the «deploy
 * whatever ref you dispatched» arrangement it replaced.
 *
 * ── Why a gate at all ────────────────────────────────────────────────
 *
 * Once a client release depends on the worker proving semantic idempotency,
 * rolling the worker BELOW that version brings back the defect it exists to
 * prevent — a historical `txId` handed out for a `noteId` whose bytes have
 * changed, i.e. the pair «payload B ↔ transaction A» that two irreversible
 * floors were introduced to make impossible. A worker rollback is one click in
 * a dashboard; the damage is silent and permanent.
 *
 * ── Why ancestry, and why a SHA rather than a tag ────────────────────
 *
 * Git SHAs are not ordered, so «SHA ≥ floor» is meaningless. The relation that
 * exists is ancestry: the floor must be reachable from the candidate. A TAG
 * cannot be the source of truth either — tags move, and a moved tag would
 * silently lower the floor. Hence: the full 40-character SHA, and nothing
 * else, is accepted as the floor. A tag name is refused rather than resolved,
 * because resolving it would reintroduce exactly the movability being avoided.
 *
 * ── Why «reachable from main» rather than «is main» ──────────────────
 *
 * A rollback has to remain possible, and a rollback deploys an OLD commit —
 * one that is in main's history but is not its head. So the boundary is
 * ancestry again, in the other direction: `candidate` must be an ancestor of
 * the trusted head. That admits every commit main ever contained and nothing
 * else. An unmerged branch, a fork, a commit pushed and then force-removed:
 * all refused, because none of them is reachable from the branch the
 * protection rules actually guard.
 *
 * ── Why this file cannot be the whole answer ─────────────────────────
 *
 * A script that lives in the repository can only gate a workflow that chooses
 * to run it, from a ref that chose to keep it. That is why the deploy workflow
 * takes the candidate as an INPUT and runs this check BEFORE checking the
 * candidate out: the checker and the floor come from the protected default
 * branch, never from the code being deployed. The rest of the enforcement is
 * not code and cannot be — the Environment's deployment-branch policy, the ban
 * on administrative bypass, and the operational ban on dashboard rollbacks and
 * bare `wrangler rollback`, which no repository script can intercept.
 *
 * ── An unset floor is a REFUSAL ──────────────────────────────────────
 *
 * It would be tempting to treat «no variable» as «no floor yet», since the
 * SEMANTIC floor is only raised just before the import flip (D2a). That
 * reasoning is wrong here for a plain reason: a floor already exists. The
 * runbook records `worker-r3` as ABSOLUTE — every build below it answers 400
 * to App-Version=4 uploads, and safebox data exists — so a gate that passes
 * with no configured floor would be a no-op sitting in front of a constraint
 * that is already binding.
 *
 * So: unset is fail-closed, and the message names the fix. The future flip is
 * not the first filling of this variable but a RAISE of it, from the data
 * floor to the semantic one.
 *
 * Usage:  WORKER_FLOOR_SHA=<40-hex> WORKER_CANDIDATE_SHA=<40-hex> \
 *         WORKER_TRUSTED_HEAD=<40-hex> node scripts/check-worker-floor.mjs
 * Values are SHAs, not secrets, and are printed on purpose: a refusal a person
 * cannot diagnose gets bypassed rather than fixed.
 */

import { spawnSync } from 'node:child_process';

export const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Everything decidable without touching git.
 *
 * Returns `{ ok, floorInEffect, floor?, candidate?, reason }`. `ok: true` with
 * `floorInEffect: false` is the «no floor configured» pass.
 */
export function checkFloorInputs({ floor, candidate }) {
  // Lower-cased: a SHA is hexadecimal, and operators copy them out of UIs that
  // upper-case. Refusing a correct value on spelling is how a gate gets
  // bypassed instead of fixed.
  const trimmedCandidate = String(candidate ?? '').trim().toLowerCase();
  const trimmedFloor = String(floor ?? '').trim().toLowerCase();

  if (!SHA_RE.test(trimmedCandidate)) {
    return {
      ok: false,
      reason: `candidate "${trimmedCandidate}" is not a full 40-character commit SHA. `
        + 'The deploy takes a SHA, never a branch or a tag: a movable ref would let the '
        + 'thing deployed differ from the thing checked.',
    };
  }

  if (trimmedFloor === '') {
    return {
      ok: false,
      reason: 'WORKER_FLOOR_SHA is not set. A floor already exists — the runbook records '
        + '`worker-r3` as absolute, because every build below it rejects App-Version=4 '
        + 'uploads and safebox data exists — so an unset variable is a missing '
        + 'configuration, not an absent constraint. Set it in the `dev` Environment to the '
        + "floor's full 40-character SHA (docs/ROLLBACK.md).",
    };
  }

  if (!SHA_RE.test(trimmedFloor)) {
    return {
      ok: false,
      reason: `WORKER_FLOOR_SHA "${trimmedFloor}" is not a full 40-character commit SHA. `
        + 'A tag or branch name is refused rather than resolved: tags move, and a moved tag '
        + 'would silently lower the floor. Put the SHA in the variable; keep the tag in the '
        + 'runbook as a label for humans.',
    };
  }

  return { ok: true, floor: trimmedFloor, candidate: trimmedCandidate };
}

/**
 * The full decision. `git` is injected so the rules can be tested without a
 * repository shaped for each case:
 *   - `hasCommit(sha)` → boolean
 *   - `isAncestor(a, b)` → boolean, and THROWS on anything that is neither a
 *     yes nor a no. A git that cannot answer must never read as «yes».
 *
 * `trustedHead` is the commit the workflow itself is running from. It is
 * required: a caller that has no trusted head has no trust boundary either,
 * and defaulting it to «anything» is exactly the mistake this parameter
 * exists to prevent.
 */
export function checkWorkerFloor({ floor, candidate, trustedHead, git }) {
  const inputs = checkFloorInputs({ floor, candidate });
  if (!inputs.ok) return inputs;

  const head = String(trustedHead ?? '').trim().toLowerCase();
  if (!SHA_RE.test(head)) {
    return {
      ok: false,
      reason: `trusted head "${head}" is not a full 40-character commit SHA. The gate needs to `
        + 'know what it is trusting; without it the candidate could be any commit in the world.',
    };
  }
  if (!git.hasCommit(head)) {
    return { ok: false, reason: `the trusted head ${head} is not in this clone.` };
  }
  if (!git.hasCommit(inputs.candidate)) {
    return {
      ok: false,
      reason: `the candidate commit ${inputs.candidate} is not in this clone. With a full-history `
        + 'checkout every commit reachable from the default branch is present, so a missing one '
        + 'is a commit that was never on it.',
    };
  }

  let onTrustedBranch;
  try {
    onTrustedBranch = git.isAncestor(inputs.candidate, head);
  } catch (error) {
    return {
      ok: false,
      reason: `git could not decide whether the candidate is on the trusted branch `
        + `(${error instanceof Error ? error.message : String(error)}). Refusing.`,
    };
  }
  if (!onTrustedBranch) {
    return {
      ok: false,
      reason: `candidate ${inputs.candidate} is not reachable from the trusted head ${head}. `
        + 'Only commits the default branch actually contains may be deployed: anything else '
        + 'has not passed branch protection, and this job installs and runs what it deploys '
        + 'in a runner that holds the deploy token.',
    };
  }

  if (!git.hasCommit(inputs.floor)) {
    return {
      ok: false,
      reason: `the floor commit ${inputs.floor} is not in this clone. The checkout needs `
        + '`fetch-depth: 0` — ancestry cannot be computed from a shallow history.',
    };
  }
  let descendant;
  try {
    descendant = git.isAncestor(inputs.floor, inputs.candidate);
  } catch (error) {
    return {
      ok: false,
      reason: `git could not decide ancestry (${error instanceof Error ? error.message : String(error)}). `
        + 'Refusing: an undecided gate is an open gate.',
    };
  }

  if (!descendant) {
    return {
      ok: false,
      reason: `candidate ${inputs.candidate} is NOT a descendant of the floor ${inputs.floor}. `
        + 'Deploying it would take the worker below the version the released client depends on, '
        + 'and the defect that returns is silent: a historical txId handed out for bytes that '
        + 'have since changed.',
    };
  }

  return {
    ok: true,
    floor: inputs.floor,
    candidate: inputs.candidate,
    reason: `candidate ${inputs.candidate} is reachable from the trusted head and is a `
      + `descendant of the floor ${inputs.floor}`,
  };
}

/**
 * The real git, in the two questions this gate asks it, bound to a directory.
 *
 * The directory is a parameter so the tests can build a repository of their
 * own with a known shape instead of asserting against whatever history the
 * checkout happens to have — a test that needs `HEAD~3` fails on a shallow CI
 * clone, which is exactly how the first version of this file shipped red.
 */
export function gitIn(cwd) {
  const git = args => spawnSync('git', args, { cwd, stdio: 'ignore' });
  return {
    hasCommit(sha) {
      const { status, error } = git(['cat-file', '-e', `${sha}^{commit}`]);
      return !error && status === 0;
    },
    isAncestor(ancestor, descendant) {
      // `--is-ancestor` answers with the exit code: 0 yes, 1 no. ANYTHING else
      // is «git could not tell», and the caller turns that into a refusal — an
      // undecided gate must never read as a yes.
      const { status, error } = git(['merge-base', '--is-ancestor', ancestor, descendant]);
      if (error) throw error;
      if (status === 0) return true;
      if (status === 1) return false;
      throw new Error(`git merge-base --is-ancestor exited with ${String(status)}`);
    },
  };
}

export const gitAdapter = gitIn(process.cwd());

// CLI
if (process.argv[1] && process.argv[1].endsWith('check-worker-floor.mjs')) {
  const verdict = checkWorkerFloor({
    floor: process.env.WORKER_FLOOR_SHA,
    candidate: process.env.WORKER_CANDIDATE_SHA ?? process.argv[2],
    trustedHead: process.env.WORKER_TRUSTED_HEAD ?? process.argv[3],
    git: gitAdapter,
  });

  if (!verdict.ok) {
    console.error(`check-worker-floor: REFUSED — ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`check-worker-floor: OK — ${verdict.reason}`);
}
