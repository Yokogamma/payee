// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The client-side floor gate of the Pages deploy (D2a), in two modes — and
 * the mode is a PROPERTY OF THE BUILD being released, never an input.
 *
 * A client ships on top of a worker release named by `worker_candidate`. The
 * other steps of the workflow already prove that the candidate is the LIVE
 * worker (release identity from the worker run, `/health` under the normal
 * profile). This gate answers one more question: does the floor recorded in
 * `WORKER_FLOOR_SHA` stand in the right relation to that release?
 *
 *   EQUALITY  — the floor must BE the release the client ships on. Required
 *               the moment the released source has `BACKUP_IMPORT_ENABLED =
 *               true`: from then on a client stores txIds under semantic
 *               idempotency, so a worker below that release must be
 *               undeployable (docs/ROLLBACK.md «Release order — and the
 *               two-stage floor raise»). "Candidate is a descendant of the
 *               floor" would be satisfied by the OLD floor too, which is
 *               exactly the mistake equality exists to catch.
 *
 *   ANCESTRY  — while the released source has `BACKUP_IMPORT_ENABLED = false`
 *               nothing in the client depends on semantic idempotency, and the
 *               plan (D2a) keeps the worker's rollback window OPEN until the
 *               import flip: the floor is raised immediately BEFORE that flip,
 *               not before the DB3 client floor `client-b1`. So the candidate
 *               must be the floor or a DESCENDANT of it — the floor itself
 *               stays where it is.
 *
 * Why the mode is read from `src/lib/flags.ts` of the checkout that gets
 * built, and only from there: the flags are source-controlled literals (the
 * strict `readFlag` of check-backup-flags.mjs refuses anything computed), the
 * Pages workflow builds the very checkout this script runs in, and the
 * workflow itself lives on the protected default branch. A workflow input or
 * an operator switch could be set to «relax» for a build that has import on;
 * a literal in the released source cannot. Equality therefore comes back
 * automatically with the first build that turns import on — nobody has to
 * remember to flip the gate.
 *
 * In BOTH modes the Environment floor must equal the repo-pinned
 * `MINIMUM_FLOOR`: the two stages of a floor raise (the variable, then the
 * protected commit) must agree, so a raise is never half-done and the variable
 * can never sit below the pin.
 *
 * Runs inside the root vitest suite (the sibling test asserts the rules and
 * the real repository wiring) and as the gate step of deploy-pages-cf.yml.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFlag } from './check-backup-flags.mjs';
import { checkFloorInputs, gitIn, MINIMUM_FLOOR } from './check-worker-floor.mjs';

const FLAGS_PATH = fileURLToPath(new URL('../src/lib/flags.ts', import.meta.url));

/**
 * Which mode the released source demands.
 *
 * Throws (via `readFlag`) when the flag is not a literal boolean — a computed
 * flag would make the artifact's behavior differ from its source, and a gate
 * that guessed would be a gate that can be talked into the wrong mode.
 */
export function gateModeFor(flagsSource) {
  return readFlag(flagsSource, 'BACKUP_IMPORT_ENABLED') ? 'equality' : 'ancestry';
}

/**
 * The full decision. `git` is injected like in check-worker-floor.mjs:
 *   - `isAncestor(a, b)` → boolean, and THROWS on anything that is neither a
 *     yes nor a no — an undecided gate must never read as a pass.
 *
 * Returns `{ ok, mode?, reason }`. `reason` explains the verdict either way,
 * so the run log carries the evidence of WHICH mode judged the release and why.
 */
export function checkClientFloorGate({ floor, candidate, minimumFloor = MINIMUM_FLOOR, flagsSource, git }) {
  const inputs = checkFloorInputs({ floor, candidate });
  if (!inputs.ok) return { ok: false, reason: inputs.reason };
  const { floor: floorSha, candidate: candidateSha } = inputs;

  const pin = String(minimumFloor ?? '').trim().toLowerCase();
  if (floorSha !== pin) {
    return {
      ok: false,
      reason: `WORKER_FLOOR_SHA is ${floorSha} but MINIMUM_FLOOR (scripts/check-worker-floor.mjs) is ${pin}. `
        + 'The two stages of a floor raise must agree before a client ships: raise the Environment '
        + 'variable AND land the protected commit raising MINIMUM_FLOOR (docs/ROLLBACK.md «Release '
        + 'order — and the two-stage floor raise»). A variable below the pin is a lowered floor; a '
        + 'variable above it is a raise that is only half done.',
    };
  }

  let mode;
  try {
    mode = gateModeFor(flagsSource);
  } catch (error) {
    return { ok: false, reason: `cannot decide the gate mode from src/lib/flags.ts: ${error.message}` };
  }

  if (mode === 'equality') {
    if (candidateSha !== floorSha) {
      return {
        ok: false,
        mode,
        reason: `client floor gate: equality mode — BACKUP_IMPORT_ENABLED=true in src/lib/flags.ts, so the `
          + `floor must BE the release this client ships on. WORKER_FLOOR_SHA is ${floorSha} but this client `
          + `ships against ${candidateSha}. Raise the Environment floor (and MINIMUM_FLOOR) to the smoked `
          + 'release before publishing a client with import on (D2a).',
      };
    }
    return {
      ok: true,
      mode,
      reason: `client floor gate: equality mode — BACKUP_IMPORT_ENABLED=true in src/lib/flags.ts; `
        + `WORKER_FLOOR_SHA == MINIMUM_FLOOR == candidate ${candidateSha}.`,
    };
  }

  // ancestry mode
  if (candidateSha === floorSha) {
    return {
      ok: true,
      mode,
      reason: `client floor gate: ancestry mode — BACKUP_IMPORT_ENABLED=false in src/lib/flags.ts; `
        + `candidate ${candidateSha} is the floor itself.`,
    };
  }
  let descends;
  try {
    descends = git.isAncestor(floorSha, candidateSha);
  } catch (error) {
    return {
      ok: false,
      mode,
      reason: `client floor gate: ancestry mode — git could not decide whether ${candidateSha} descends `
        + `from the floor ${floorSha} (${error.message}). An undecided gate is a refusal, not a pass; `
        + 'the workflow checks out with fetch-depth: 0 for exactly this reason.',
    };
  }
  if (!descends) {
    return {
      ok: false,
      mode,
      reason: `client floor gate: ancestry mode — BACKUP_IMPORT_ENABLED=false in src/lib/flags.ts, but `
        + `candidate ${candidateSha} does not descend from the floor ${floorSha}. A client never ships `
        + 'on a worker below the floor.',
    };
  }
  return {
    ok: true,
    mode,
    reason: `client floor gate: ancestry mode — BACKUP_IMPORT_ENABLED=false in src/lib/flags.ts; the floor `
      + `stays at ${floorSha} (it rises immediately before the import flip, D2a) and candidate `
      + `${candidateSha} descends from it.`,
  };
}

/** The real repository: flags of THIS checkout, the pin of THIS checkout, git of THIS checkout. */
export function checkClientFloorGateHere({ floor, candidate, cwd = process.cwd() }) {
  return checkClientFloorGate({
    floor,
    candidate,
    minimumFloor: MINIMUM_FLOOR,
    flagsSource: readFileSync(FLAGS_PATH, 'utf8'),
    git: gitIn(cwd),
  });
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('check-client-floor-gate.mjs')) {
  const verdict = checkClientFloorGateHere({
    floor: process.env.WORKER_FLOOR_SHA,
    candidate: process.env.WORKER_CANDIDATE_SHA ?? process.argv[2],
  });
  if (verdict.ok) {
    console.log(`✓ ${verdict.reason}`);
  } else {
    console.error(`check-client-floor-gate: REFUSED — ${verdict.reason}`);
    process.exit(1);
  }
}
