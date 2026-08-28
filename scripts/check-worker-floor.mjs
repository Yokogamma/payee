// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The worker floor gate (D2a): refuse to deploy a candidate that is not a
 * descendant of the last worker version the client depends on.
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
 * ── The empty floor is a PASS, loudly ────────────────────────────────
 *
 * The floor is raised only just before the import flip (D2a: the client-floor
 * release with both flags off does not yet depend on the contract, and taking
 * away its rollback window early would cure nothing and cost a forward-fix).
 * So an unset variable is the normal state for now — and it prints a line
 * saying the gate is not in effect, because a silent no-op gate is worse than
 * none: it looks like protection in the log.
 *
 * Usage:  WORKER_FLOOR_SHA=<40-hex|empty> WORKER_CANDIDATE_SHA=<40-hex> \
 *           node scripts/check-worker-floor.mjs
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
      ok: true,
      floorInEffect: false,
      candidate: trimmedCandidate,
      reason: 'WORKER_FLOOR_SHA is not set — the worker floor is NOT in effect. '
        + 'This is the expected state until the floor is raised (D2a: immediately before '
        + 'the import flip, never earlier).',
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

  return { ok: true, floorInEffect: true, floor: trimmedFloor, candidate: trimmedCandidate };
}

/**
 * The full decision. `git` is injected so the rules can be tested without a
 * repository shaped for each case:
 *   - `hasCommit(sha)` → boolean
 *   - `isAncestor(a, b)` → boolean, and THROWS on anything that is neither a
 *     yes nor a no. A git that cannot answer must never read as «yes».
 */
export function checkWorkerFloor({ floor, candidate, git }) {
  const inputs = checkFloorInputs({ floor, candidate });
  if (!inputs.ok || inputs.floorInEffect !== true) return inputs;

  if (!git.hasCommit(inputs.floor)) {
    return {
      ok: false,
      reason: `the floor commit ${inputs.floor} is not in this clone. The checkout needs `
        + '`fetch-depth: 0` — ancestry cannot be computed from a shallow history.',
    };
  }
  if (!git.hasCommit(inputs.candidate)) {
    return {
      ok: false,
      reason: `the candidate commit ${inputs.candidate} is not in this clone. Fetch it first `
        + '(`git fetch --no-tags origin <sha>`); a SHA that cannot be found is refused rather '
        + 'than assumed to be fine.',
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
    floorInEffect: true,
    floor: inputs.floor,
    candidate: inputs.candidate,
    reason: `candidate ${inputs.candidate} is a descendant of the floor ${inputs.floor}`,
  };
}

/** The real git, in the two questions this gate asks it. */
export const gitAdapter = {
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

const git = args => spawnSync('git', args, { stdio: 'ignore' });

// CLI
if (process.argv[1] && process.argv[1].endsWith('check-worker-floor.mjs')) {
  const verdict = checkWorkerFloor({
    floor: process.env.WORKER_FLOOR_SHA,
    candidate: process.env.WORKER_CANDIDATE_SHA ?? process.argv[2],
    git: gitAdapter,
  });

  if (!verdict.ok) {
    console.error(`check-worker-floor: REFUSED — ${verdict.reason}`);
    process.exit(1);
  }
  console.log(
    verdict.floorInEffect
      ? `check-worker-floor: OK — ${verdict.reason}`
      : `check-worker-floor: NO FLOOR — ${verdict.reason}`,
  );
}
