import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkFloorInputs,
  checkWorkerFloor,
  gitIn,
  MINIMUM_FLOOR,
  SHA_RE,
} from './check-worker-floor.mjs';

/**
 * The worker floor gate (D2a).
 *
 * Three properties are worth a failing build, and they are separate:
 *   1. the RULES — what passes, what is refused, and that «could not tell»
 *      is a refusal rather than a pass;
 *   2. the ancestry answer against a REAL repository, because the whole gate
 *      rests on one git invocation and an injected fake can only prove the
 *      wiring around it;
 *   3. the WORKFLOW's shape — the gate is worthless if the code it judges can
 *      edit it, so the checker, the floor and the ordering are asserted as
 *      structure, not as intentions.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const HEAD = 'd'.repeat(40);

/** A git that answers from a fixed ancestry map.
 *
 *  Defaults satisfy everything a test is NOT about: every named commit exists,
 *  everything is reachable from HEAD, everything carries a tag, and the pinned
 *  minimum is below the configured floor. A test that wants one of those to
 *  fail says so. */
const fakeGit = ({ present = [A, B, C, HEAD, MINIMUM_FLOOR], ancestors = {}, tagged = true } = {}) => ({
  hasCommit: sha => present.includes(sha),
  isTagged: () => tagged,
  isAncestor: (ancestor, descendant) => {
    if (ancestor === MINIMUM_FLOOR) return true;
    if (descendant === HEAD) return present.includes(ancestor);
    return (ancestors[ancestor] ?? []).includes(descendant);
  },
});

/** The floor decision, with the trust boundary satisfied unless stated. */
const decide = ({ floor, candidate, trustedHead = HEAD, git = fakeGit() }) =>
  checkWorkerFloor({ floor, candidate, trustedHead, git });

describe('what may be a floor at all', () => {
  it('an unset floor is a REFUSAL — a floor already exists', () => {
    // It would be tempting to read «no variable» as «no floor yet», since the
    // SEMANTIC floor is raised only before the import flip. But the runbook
    // records `worker-r3` as ALREADY absolute (everything below it rejects
    // App-Version=4 uploads, and safebox data exists), so passing here would
    // put a no-op in front of a constraint that already binds. The future flip
    // is a RAISE of this variable, not its first filling.
    for (const floor of [undefined, '', '   ', null]) {
      const verdict = checkFloorInputs({ floor, candidate: A });
      expect(verdict.ok, String(floor)).toBe(false);
      expect(verdict.reason).toMatch(/already exists/);
      expect(verdict.reason).toMatch(/worker-r3/);
    }
  });

  it('a TAG is refused rather than resolved', () => {
    // The whole point of pinning the SHA: a tag can be moved onto an older
    // commit, and resolving one here would let that silently lower the floor.
    for (const floor of ['worker-r3', 'refs/tags/worker-r3', 'main', 'HEAD~1']) {
      const verdict = checkFloorInputs({ floor, candidate: A });
      expect(verdict.ok, floor).toBe(false);
      expect(verdict.reason).toMatch(/tags move/);
    }
  });

  it('a short SHA is refused too', () => {
    expect(checkFloorInputs({ floor: 'a'.repeat(7), candidate: A }).ok).toBe(false);
    expect(checkFloorInputs({ floor: `${A}extra`, candidate: A }).ok).toBe(false);
  });

  it('the CANDIDATE must be a full SHA whatever the floor says', () => {
    for (const candidate of ['', 'main', 'a'.repeat(7), 'refs/heads/main', undefined]) {
      const verdict = checkFloorInputs({ floor: '', candidate });
      expect(verdict.ok, String(candidate)).toBe(false);
      expect(verdict.reason).toMatch(/full 40-character commit SHA/);
    }
  });

  it('case is not a reason to refuse — a SHA is hex, and operators copy from UIs', () => {
    const verdict = checkFloorInputs({ floor: A.toUpperCase(), candidate: A.toUpperCase() });
    expect(verdict.ok).toBe(true);
    expect(verdict.floor).toBe(A);
    expect(verdict.candidate).toBe(A);
  });
});

describe('the ancestry decision', () => {
  it('a descendant passes', () => {
    const verdict = decide({ floor: A, candidate: B, git: fakeGit({ ancestors: { [A]: [B] } }) });
    expect(verdict.ok).toBe(true);
  });

  it('the floor itself passes — redeploying it is not a rollback', () => {
    const verdict = decide({ floor: A, candidate: A, git: fakeGit({ ancestors: { [A]: [A] } }) });
    expect(verdict.ok).toBe(true);
  });

  it('an ancestor is refused, and the message says what returns', () => {
    const verdict = decide({ floor: B, candidate: A, git: fakeGit({ ancestors: { [A]: [B] } }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/NOT a descendant/);
    expect(verdict.reason).toMatch(/historical txId/);
  });

  it('an unrelated commit is refused', () => {
    expect(decide({ floor: A, candidate: C }).ok).toBe(false);
  });

  it('a floor naming a commit this repository does not have is refused', () => {
    // And the message blames the VALUE, not the checkout: with `fetch-depth: 0`
    // a shallow clone is not the explanation, and a message that sends the
    // operator to audit a correct workflow setting leaves them with no
    // sanctioned way forward.
    const verdict = decide({
      floor: A, candidate: B, git: fakeGit({ present: [B, HEAD, MINIMUM_FLOOR] }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/is not in this repository/);
    expect(verdict.reason).toMatch(/docs\/ROLLBACK\.md/);
  });

  it('«git could not tell» is a REFUSAL — an undecided gate is an open gate', () => {
    const verdict = decide({
      floor: A,
      candidate: B,
      git: { hasCommit: () => true, isAncestor: () => { throw new Error('exited with 128'); } },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/Refusing|undecided gate/);
  });
});

describe('the trust boundary', () => {
  it('a candidate that is not reachable from the trusted head is refused', () => {
    // The regression this exists for: with the candidate free-form, the
    // Environment's branch policy is satisfied by the DISPATCH ref while the
    // deployed code comes from anywhere — and this job installs and runs that
    // code in a runner holding the deploy token.
    const verdict = decide({
      floor: A,
      candidate: C,
      git: { hasCommit: () => true, isAncestor: (a, b) => !(a === C && b === HEAD) },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not reachable from the trusted head/);
    expect(verdict.reason).toMatch(/branch protection/);
  });

  it('is checked BEFORE the floor — an off-branch commit is refused whatever the floor says', () => {
    const verdict = decide({
      floor: A,
      candidate: C,
      git: { hasCommit: () => true, isAncestor: (a, b) => (a === A && b === C) || false },
    });
    expect(verdict.reason).toMatch(/not reachable from the trusted head/);
  });

  it('a missing or malformed trusted head is refused, never defaulted', () => {
    // Called directly, not through the `decide` helper: its default would
    // supply exactly the value this test is about the absence of.
    for (const trustedHead of [undefined, '', 'main', 'a'.repeat(7)]) {
      const verdict = checkWorkerFloor({ floor: A, candidate: B, trustedHead, git: fakeGit() });
      expect(verdict.ok, String(trustedHead)).toBe(false);
      expect(verdict.reason, String(trustedHead)).toMatch(/trusted head/);
    }
  });
});

describe('which commits are deployable at all', () => {
  it('an untagged commit that is not the head is refused', () => {
    // Every intermediate commit of every merged pull request is an ancestor of
    // the default branch. Those states were never judged as deployable, and
    // «reachable from main» alone cannot tell them from a release.
    const verdict = decide({
      floor: A, candidate: B, git: fakeGit({ ancestors: { [A]: [B] }, tagged: false }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/neither the trusted head nor a tagged commit/);
  });

  it('the head itself needs no tag', () => {
    const verdict = decide({
      floor: A, candidate: HEAD, git: fakeGit({ ancestors: { [A]: [HEAD] }, tagged: false }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('a tagged commit below the head passes — that is what a rollback is', () => {
    const verdict = decide({
      floor: A, candidate: B, git: fakeGit({ ancestors: { [A]: [B] }, tagged: true }),
    });
    expect(verdict.ok).toBe(true);
  });
});

describe('the floor has a floor', () => {
  it('a configured floor BELOW the pinned minimum is refused', () => {
    // An Environment variable moves as freely as the tag this gate refuses to
    // resolve, and leaves less of a trace: no history, no diff, no review.
    const verdict = decide({
      floor: A,
      candidate: B,
      git: {
        hasCommit: () => true,
        isTagged: () => true,
        isAncestor: (ancestor, descendant) => (
          ancestor === MINIMUM_FLOOR ? false : (ancestor === A && descendant === B) || descendant === HEAD
        ),
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/BELOW the minimum pinned in this file/);
  });

  it('the minimum itself is a legal floor', () => {
    const verdict = decide({
      floor: MINIMUM_FLOOR,
      candidate: B,
      git: fakeGit({ ancestors: { [MINIMUM_FLOOR]: [B] } }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('a minimum missing from the repository is a refusal, not a shrug', () => {
    const verdict = decide({
      floor: A, candidate: B, git: fakeGit({ present: [A, B, HEAD], ancestors: { [A]: [B] } }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/pinned minimum floor/);
  });
});

describe('against a real repository, built for the purpose', () => {
  // The fake above proves the wiring; this proves the two git invocations the
  // whole gate rests on. Built here rather than asserted against THIS
  // repository's history: the first version of this file asked for `HEAD~3`
  // and went red on CI, which checks out shallow. A gate whose test depends on
  // the depth of someone else's clone is a gate that gets deleted.
  let repo;
  let first;
  let second;
  let third;
  let offBranch;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'worker-floor-'));
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const commit = message => {
      writeFileSync(join(repo, 'file.txt'), `${message}\n`);
      run('add', '-A');
      run('commit', '-q', '-m', message);
      return head();
    };

    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'floor-test@example.invalid');
    run('config', 'user.name', 'Floor Test');
    run('config', 'commit.gpgsign', 'false');
    first = commit('first');
    second = commit('second');
    third = commit('third');
    // `second` is a release; `first` is only the minimum. `third` is the head
    // and needs no tag of its own.
    run('tag', 'worker-r2', second);
    run('tag', 'worker-r1', first);
    // A branch that was never merged — the shape the trust boundary exists for.
    run('checkout', '-q', '-b', 'unmerged', first);
    offBranch = commit('off the default branch');
    run('checkout', '-q', 'main');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  // The pinned minimum belongs to THIS repository, so the hermetic one supplies
  // its own — the rule under test is «not below the minimum», not the value.
  const real = over =>
    checkWorkerFloor({ trustedHead: third, git: gitIn(repo), minimumFloor: first, ...over });

  it('the fixture is what the tests think it is', () => {
    for (const sha of [first, second, third, offBranch]) expect(SHA_RE.test(sha)).toBe(true);
    expect(new Set([first, second, third, offBranch]).size).toBe(4);
  });

  it('deploying the head passes', () => {
    expect(real({ floor: first, candidate: third }).ok).toBe(true);
  });

  it('rolling back INSIDE the branch history passes', () => {
    expect(real({ floor: first, candidate: second }).ok).toBe(true);
  });

  it('rolling back below the floor is refused', () => {
    const verdict = real({ floor: second, candidate: first });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/NOT a descendant/);
  });

  it('a commit from an unmerged branch is refused — the boundary, on real git', () => {
    const verdict = real({ floor: first, candidate: offBranch });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not reachable from the trusted head/);
  });

  it('a well-formed SHA that is in no repository is refused', () => {
    expect(real({ floor: first, candidate: 'f'.repeat(40) }).ok).toBe(false);
  });

  it('an untagged commit in the history is refused, a tagged one is not', () => {
    // On real git, with real `git tag --points-at`.
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    run('tag', '-d', 'worker-r2');
    expect(real({ floor: first, candidate: second }).ok, 'untagged').toBe(false);
    run('tag', 'worker-r2', second);
    expect(real({ floor: first, candidate: second }).ok, 'tagged again').toBe(true);
  });

  it('a personal bookmark is not a release tag', () => {
    // `git tag --points-at` answers «yes» to any name — `wip`,
    // `before-refactor`, whatever someone types while debugging. The runbook's
    // allowlist is «tags in this list», and every entry in it is `worker-rN`;
    // accepting an arbitrary name let a private bookmark satisfy a gate whose
    // whole purpose is that only judged states get deployed.
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    run('tag', '-d', 'worker-r2');
    run('tag', 'wip-debugging', second);
    expect(real({ floor: first, candidate: second }).ok, 'bookmark only').toBe(false);

    run('tag', 'worker-r2', second);
    expect(real({ floor: first, candidate: second }).ok, 'release tag present too').toBe(true);
  });

  it('a floor below the pinned minimum is refused on real git too', () => {
    // `first` is the minimum here, so a floor at… there is nothing below it.
    // Instead: raise the minimum to `second` and offer `first` as the floor.
    const verdict = checkWorkerFloor({
      floor: first, candidate: third, trustedHead: third, git: gitIn(repo), minimumFloor: second,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/BELOW the minimum/);
  });

  it('the CLI reads the environment the workflow passes, and exits non-zero on a refusal', () => {
    // The seam nothing else covers: every other test calls the functions
    // directly, so a renamed env var would leave them all green while the gate
    // in the workflow decided on `undefined`.
    const script = fileURLToPath(new URL('./check-worker-floor.mjs', import.meta.url));
    const run = env => spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

    const ok = run({
      WORKER_FLOOR_SHA: first, WORKER_CANDIDATE_SHA: third, WORKER_TRUSTED_HEAD: third,
      WORKER_MINIMUM_FLOOR: first,
    });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/check-worker-floor: OK/);

    const belowFloor = run({
      WORKER_FLOOR_SHA: second, WORKER_CANDIDATE_SHA: first, WORKER_TRUSTED_HEAD: third,
      WORKER_MINIMUM_FLOOR: first,
    });
    expect(belowFloor.status).toBe(1);
    expect(belowFloor.stderr).toMatch(/REFUSED/);

    const noFloor = run({
      WORKER_FLOOR_SHA: '', WORKER_CANDIDATE_SHA: third, WORKER_TRUSTED_HEAD: third,
      WORKER_MINIMUM_FLOOR: first,
    });
    expect(noFloor.status).toBe(1);
    expect(noFloor.stderr).toMatch(/already exists/);
  });
});

describe('the workflow cannot be talked out of the gate by the code it judges', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-worker.yml', import.meta.url)),
    'utf8',
  );
  const at = needle => workflow.indexOf(needle);

  /** One step's own YAML — comments elsewhere in the file cannot answer for
   *  it. The `fetch-depth` check used to match the sentence ABOUT the setting
   *  two lines above the setting, and would have stayed green if the setting
   *  itself were deleted. */
  const step = marker => {
    const start = workflow.indexOf(marker);
    expect(start, `no step matching ${marker}`).toBeGreaterThan(-1);
    const from = workflow.lastIndexOf('\n      - ', start) + 1;
    const next = workflow.indexOf('\n      - ', start);
    return workflow.slice(from, next === -1 ? workflow.length : next);
  };

  it('takes the candidate as an input, and the floor from a protected variable', () => {
    expect(workflow).toMatch(/inputs:\s*\n\s*candidate:/);
    const gate = step('node scripts/check-worker-floor.mjs');
    expect(gate).toContain('WORKER_FLOOR_SHA: ${{ vars.WORKER_FLOOR_SHA }}');
    expect(gate).toContain('WORKER_CANDIDATE_SHA: ${{ inputs.candidate }}');
    expect(gate).toContain('WORKER_TRUSTED_HEAD: ${{ github.sha }}');
  });

  it('materializes the candidate from the already-trusted history, not the network', () => {
    // A second `actions/checkout` would fetch the candidate by ref — which is
    // how an off-branch commit got in. A worktree can only produce a commit
    // this clone already has, and the gate ran before it.
    expect(workflow.match(/uses: actions\/checkout/g) ?? []).toHaveLength(1);
    expect(step('git worktree add')).toContain('--detach candidate');
  });

  it('checks the ref by its FULL name — a tag can share a branch\'s name', () => {
    expect(step('Refuse to deploy from anything but')).toContain('refs/heads/$DEFAULT');
    expect(step('Refuse to deploy from anything but')).toContain('REF: ${{ github.ref }}');
  });

  it('runs the gate BEFORE any file of the candidate exists', () => {
    // The ordering is the whole mechanism. A gate that runs after the code is
    // on disk is a gate the code could have replaced — and a `run:` step from
    // the candidate would execute before it in that case.
    const gate = at('node scripts/check-worker-floor.mjs');
    const materialize = at('git worktree add');
    expect(gate).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(materialize);
  });

  it('keeps the candidate in its own directory, never over the trusted checkout', () => {
    expect(workflow).toContain('workingDirectory: candidate/worker');
    for (const marker of ['npm ci --ignore-scripts', 'npm --prefix worker test']) {
      expect(step(marker), marker).toContain('working-directory: candidate');
    }
  });

  it('fetches the whole history and keeps no credential for the candidate to find', () => {
    const checkout = step('uses: actions/checkout');
    expect(checkout).toContain('fetch-depth: 0');
    expect(checkout).toContain('persist-credentials: false');
    expect(at('fetch-depth: 0')).toBeLessThan(at('node scripts/check-worker-floor.mjs'));
  });

  it('never uses a TAG as the gate\'s input', () => {
    // `WORKER_FLOOR_TAG` stays a human-readable label in the runbook. The plan
    // asks for this as a static check precisely because the tag is the thing
    // everyone remembers and the SHA is the thing that is true.
    expect(workflow).not.toContain('WORKER_FLOOR_TAG');
  });

  it('passes the candidate through env, not into a shell line', () => {
    // Operator-supplied text interpolated straight into `run:` is a script
    // injection in a job that holds the deploy token.
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*inputs\.candidate\s*\}\}/);
  });
});
