import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkFloorInputs,
  checkWorkerFloor,
  gitAdapter,
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

/** A git that answers from a fixed ancestry map. */
const fakeGit = ({ present = [A, B, C], ancestors = {} } = {}) => ({
  hasCommit: sha => present.includes(sha),
  isAncestor: (ancestor, descendant) => (ancestors[ancestor] ?? []).includes(descendant),
});

describe('what may be a floor at all', () => {
  it('an unset or blank floor passes LOUDLY — the gate is not in effect yet', () => {
    // The floor is raised immediately before the import flip and not earlier
    // (D2a), so «unset» is the normal state today. What must not happen is a
    // silent pass: a no-op gate looks like protection in the log.
    for (const floor of [undefined, '', '   ', null]) {
      const verdict = checkFloorInputs({ floor, candidate: A });
      expect(verdict.ok, String(floor)).toBe(true);
      expect(verdict.floorInEffect, String(floor)).toBe(false);
      expect(verdict.reason).toMatch(/NOT in effect/);
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
    const verdict = checkWorkerFloor({
      floor: A, candidate: B, git: fakeGit({ ancestors: { [A]: [B] } }),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.floorInEffect).toBe(true);
  });

  it('the floor itself passes — redeploying it is not a rollback', () => {
    const verdict = checkWorkerFloor({
      floor: A, candidate: A, git: fakeGit({ ancestors: { [A]: [A] } }),
    });
    expect(verdict.ok).toBe(true);
  });

  it('an ancestor is refused, and the message says what returns', () => {
    const verdict = checkWorkerFloor({
      floor: B, candidate: A, git: fakeGit({ ancestors: { [A]: [B] } }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/NOT a descendant/);
    expect(verdict.reason).toMatch(/historical txId/);
  });

  it('an unrelated commit is refused', () => {
    const verdict = checkWorkerFloor({ floor: A, candidate: C, git: fakeGit() });
    expect(verdict.ok).toBe(false);
  });

  it('a floor missing from the clone is refused, and blames the shallow checkout', () => {
    const verdict = checkWorkerFloor({ floor: A, candidate: B, git: fakeGit({ present: [B] }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/fetch-depth: 0/);
  });

  it('a candidate missing from the clone is refused rather than assumed fine', () => {
    const verdict = checkWorkerFloor({ floor: A, candidate: B, git: fakeGit({ present: [A] }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/git fetch/);
  });

  it('«git could not tell» is a REFUSAL — an undecided gate is an open gate', () => {
    const verdict = checkWorkerFloor({
      floor: A,
      candidate: B,
      git: {
        hasCommit: () => true,
        isAncestor: () => { throw new Error('exited with 128'); },
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/undecided gate/);
  });
});

describe('against a real repository', () => {
  // The fake above proves the wiring; this proves the one git invocation the
  // whole gate rests on. If `--is-ancestor` ever changed its exit-code
  // contract, every test above would still pass.
  const sha = ref => execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim();

  it('says yes down the history and no back up it', () => {
    const head = sha('HEAD');
    const older = sha('HEAD~3');
    expect(SHA_RE.test(head) && SHA_RE.test(older)).toBe(true);

    expect(checkWorkerFloor({ floor: older, candidate: head, git: gitAdapter }).ok).toBe(true);
    expect(checkWorkerFloor({ floor: head, candidate: older, git: gitAdapter }).ok).toBe(false);
  });

  it('refuses a SHA that is well-formed but not in the repository', () => {
    const verdict = checkWorkerFloor({ floor: sha('HEAD'), candidate: 'f'.repeat(40), git: gitAdapter });
    expect(verdict.ok).toBe(false);
  });
});

describe('the workflow cannot be talked out of the gate by the code it judges', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-worker.yml', import.meta.url)),
    'utf8',
  );
  const at = needle => workflow.indexOf(needle);

  it('takes the candidate as an input, and the floor from a protected variable', () => {
    expect(workflow).toMatch(/inputs:\s*\n\s*candidate:/);
    expect(workflow).toContain('WORKER_FLOOR_SHA: ${{ vars.WORKER_FLOOR_SHA }}');
    expect(workflow).toContain('WORKER_CANDIDATE_SHA: ${{ inputs.candidate }}');
  });

  it('runs the gate BEFORE the candidate is checked out', () => {
    // The ordering is the whole mechanism. A gate that runs after the code is
    // on disk is a gate the code could have replaced — and a `run:` step from
    // the candidate would execute before it in that case.
    const gate = at('node scripts/check-worker-floor.mjs');
    const candidateCheckout = at('ref: ${{ inputs.candidate }}');
    expect(gate).toBeGreaterThan(-1);
    expect(candidateCheckout).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(candidateCheckout);
  });

  it('keeps the candidate in its own directory, never over the trusted checkout', () => {
    expect(workflow).toMatch(/ref: \$\{\{ inputs\.candidate \}\}\s*\n\s*path: candidate/);
    expect(workflow).toContain('workingDirectory: candidate/worker');
    for (const step of ['npm ci --ignore-scripts', 'npm --prefix worker test']) {
      const index = at(step);
      expect(index, step).toBeGreaterThan(-1);
      expect(workflow.slice(index, index + 200), step).toContain('working-directory: candidate');
    }
  });

  it('fetches the whole history, or ancestry has nothing to stand on', () => {
    expect(at('fetch-depth: 0')).toBeGreaterThan(-1);
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
