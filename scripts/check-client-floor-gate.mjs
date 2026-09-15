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
 * built, and only from there: the flags are source-controlled literals; the
 * Pages workflow builds the very checkout this script runs in; and the job
 * runs under the `dev` Environment, whose deployment-branch policy admits only
 * `main` — so the checkout whose flags are read is a protected-branch state,
 * and the mode inherits exactly the strength of that policy (docs/SECRETS.md).
 * A workflow input or an operator switch could be set to «relax» for a build
 * that has import on; a literal in the released source cannot. Equality
 * therefore comes back automatically with the first build that turns import
 * on — nobody has to remember to flip the gate.
 *
 * The flag is read STRICTLY: exactly one declaration, at the start of a line,
 * with a literal `true` or `false`. Zero matches, two matches (a comment or a
 * string that spells the declaration ahead of the real one) or a computed
 * value are refusals — a gate that guessed the mode would be a gate that can
 * be talked into the wrong one.
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
import { checkFloorInputs, gitIn, MINIMUM_FLOOR } from './check-worker-floor.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FLAGS_PATH = fileURLToPath(new URL('../src/lib/flags.ts', import.meta.url));

/**
 * The one declaration of a flag, or a throw.
 *
 * Anchored at the start of a line (`m`), and it must match EXACTLY ONCE: the
 * first-match reader of check-backup-flags.mjs is right for the pair check,
 * but here a second spelling of the declaration — in a comment, a string, a
 * doc example — could shadow the real one and pick the other mode. Exported
 * for the test; not a general utility.
 */
export function readFlagExactlyOnce(source, name) {
  const re = new RegExp(`^export const ${name}\\s*:\\s*boolean\\s*=\\s*(true|false)\\s*;`, 'gm');
  const matches = [...String(source ?? '').matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(
      `check-client-floor-gate: expected exactly one line-anchored declaration ` +
      `\`export const ${name}: boolean = true|false;\` in src/lib/flags.ts, found ${matches.length}. ` +
      'A missing, computed or duplicated declaration cannot decide the gate mode.',
    );
  }
  return matches[0][1] === 'true';
}

/** Which mode the released source demands. Throws when it cannot tell. */
export function gateModeFor(flagsSource) {
  return readFlagExactlyOnce(flagsSource, 'BACKUP_IMPORT_ENABLED') ? 'equality' : 'ancestry';
}

/**
 * The full decision. `git` is injected like in check-worker-floor.mjs:
 *   - `isAncestor(a, b)` → boolean, and THROWS on anything that is neither a
 *     yes nor a no — an undecided gate must never read as a pass.
 *
 * Returns `{ ok, mode?, reason }`. `reason` explains the verdict either way,
 * naming the mode, what was compared and the floor/pin agreement, so the run
 * log carries the evidence of WHICH rule judged the release and why.
 */
export function checkClientFloorGate({ floor, candidate, minimumFloor = MINIMUM_FLOOR, flagsSource, git }) {
  const inputs = checkFloorInputs({ floor, candidate });
  if (!inputs.ok) return { ok: false, reason: inputs.reason };
  const { floor: floorSha, candidate: candidateSha } = inputs;

  const pin = String(minimumFloor ?? '').trim().toLowerCase();
  if (floorSha !== pin) {
    return {
      ok: false,
      reason: `WORKER_FLOOR_SHA (${floorSha}) ≠ MINIMUM_FLOOR (${pin}, scripts/check-worker-floor.mjs). `
        + 'The two stages of a floor raise must agree before a client ships: raise the Environment '
        + 'variable AND land the protected commit raising MINIMUM_FLOOR to the same SHA (docs/ROLLBACK.md '
        + '«Release order — and the two-stage floor raise»).',
    };
  }
  const agreed = `WORKER_FLOOR_SHA == MINIMUM_FLOOR == ${floorSha}`;

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
          + `floor must BE the release this client ships on. ${agreed}, but this client ships against `
          + `${candidateSha}. Raise the Environment floor and MINIMUM_FLOOR to the smoked release before `
          + 'publishing a client with import on (D2a).',
      };
    }
    return {
      ok: true,
      mode,
      reason: `client floor gate: equality mode — BACKUP_IMPORT_ENABLED=true in src/lib/flags.ts; `
        + `${agreed} == candidate.`,
    };
  }

  // ancestry mode
  if (candidateSha === floorSha) {
    return {
      ok: true,
      mode,
      reason: `client floor gate: ancestry mode — BACKUP_IMPORT_ENABLED=false in src/lib/flags.ts; `
        + `${agreed}; candidate ${candidateSha} is the floor itself.`,
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
    reason: `client floor gate: ancestry mode — BACKUP_IMPORT_ENABLED=false in src/lib/flags.ts; `
      + `${agreed}; the floor stays (it rises immediately before the import flip, D2a) and candidate `
      + `${candidateSha} descends from it.`,
  };
}

/**
 * The real repository: flags of THIS checkout, the pin of THIS checkout, git
 * of THIS checkout — all three resolved from the script's own location, so
 * they are provably the same tree whatever the process cwd is.
 */
export function checkClientFloorGateHere({ floor, candidate, cwd = REPO_ROOT }) {
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
    candidate: process.env.WORKER_CANDIDATE_SHA,
  });
  if (verdict.ok) {
    console.log(`✓ ${verdict.reason}`);
  } else {
    console.error(`check-client-floor-gate: REFUSED — ${verdict.reason}`);
    process.exit(1);
  }
}
