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
 * The flag is read from the TypeScript AST, not from the text: exactly one
 * top-level `export const BACKUP_IMPORT_ENABLED` whose initializer is the
 * literal `true` or `false`. Text inside comments and strings is not a
 * declaration, so it cannot shadow the real one; a missing, duplicated,
 * non-exported, non-const or computed declaration is a refusal — a gate that
 * guessed the mode would be a gate that can be talked into the wrong one.
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
import ts from 'typescript';
import { checkFloorInputs, gitIn, MINIMUM_FLOOR } from './check-worker-floor.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FLAGS_PATH = fileURLToPath(new URL('../src/lib/flags.ts', import.meta.url));

/**
 * The one declaration of a flag, or a throw — read from the AST.
 *
 * Why not a regex: a line that LOOKS like the declaration inside a block
 * comment or a template string is not a declaration, and the real one may be
 * indented; a text reader was shown to pick the comment and skip the export.
 * The TypeScript parser sees statements, not lines. Accepted shape, and only
 * this shape: a top-level `export const NAME = true|false` (a type annotation
 * is fine), exactly once in the file. Anything else — no declaration, two of
 * them, `let`/`var`, no `export`, a computed or negated initializer, a
 * declaration nested in a block — throws. Exported for the test; not a general
 * utility.
 */
export function readFlagExactlyOnce(source, name) {
  const file = ts.createSourceFile('flags.ts', String(source ?? ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declarator of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declarator.name) || declarator.name.text !== name) continue;
      const exported = (ts.getModifiers(statement) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const init = declarator.initializer;
      const literal = init && init.kind === ts.SyntaxKind.TrueKeyword ? true
        : init && init.kind === ts.SyntaxKind.FalseKeyword ? false
        : null;
      found.push({ exported, isConst, literal });
    }
  }
  if (found.length !== 1) {
    throw new Error(
      `check-client-floor-gate: expected exactly one top-level declaration of ${name} ` +
      `in src/lib/flags.ts, found ${found.length}. A missing or duplicated declaration cannot decide the gate mode.`,
    );
  }
  const [decl] = found;
  if (!decl.exported || !decl.isConst || decl.literal === null) {
    throw new Error(
      `check-client-floor-gate: ${name} must be declared as \`export const ${name}: boolean = true|false;\` ` +
      'with a literal initializer — a non-exported, non-const, computed or negated value would make the ' +
      'release artifact behave differently from what the gate reads.',
    );
  }
  return decl.literal;
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
