import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  checkClientFloorGate,
  checkClientFloorGateHere,
  gateModeFor,
  IMPORT_FLIP_FLOOR,
  readFlagExactlyOnce,
} from './check-client-floor-gate.mjs';
import { gitIn, MINIMUM_FLOOR, SHA_RE } from './check-worker-floor.mjs';
import { readFlag } from './check-backup-flags.mjs';

/**
 * The client floor gate (D2a) in its two modes.
 *
 * Three things are worth a failing build, and they are separate:
 *   1. the RULES — d2-floor once import is on (the floor is the import-flip
 *      release or later on its line, the candidate is the floor or later),
 *      ancestry while it is off, and «could not tell» is a refusal in both;
 *   2. that the MODE comes from the released source's DECLARATION and from
 *      nowhere else — text in comments or strings is not a declaration; a
 *      computed, missing, duplicated, non-exported or non-const flag is a
 *      refusal, never a guess; and the path the workflow executes really reads
 *      the real src/lib/flags.ts (checked against an independent reader);
 *   3. the WORKFLOW's shape — the step carries the floor variable, reads the
 *      candidate from the input, sits between the identity smoke and the
 *      deploy, and no inline equality gate is left behind to disagree.
 */

const FLOOR = 'f'.repeat(40);
const DESCENDANT = 'd'.repeat(40);
const STRANGER = '5'.repeat(40);

const flags = (exportEnabled, importEnabled) => `
export const BACKUP_EXPORT_ENABLED: boolean = ${exportEnabled};
export const BACKUP_IMPORT_ENABLED: boolean = ${importEnabled};
`;
const IMPORT_OFF = flags(false, false);
const IMPORT_ON = flags(false, true);

/** A git that answers from a fixed ancestry map; `undecided` makes it throw. */
const fakeGit = ({ ancestors = { [FLOOR]: [DESCENDANT] }, undecided = false } = {}) => ({
  isAncestor: (ancestor, descendant) => {
    if (undecided) throw new Error('git merge-base --is-ancestor exited with 128');
    return (ancestors[ancestor] ?? []).includes(descendant);
  },
});

const decide = over =>
  checkClientFloorGate({ floor: FLOOR, candidate: DESCENDANT, minimumFloor: FLOOR, flagsSource: IMPORT_OFF, git: fakeGit(), ...over });

describe('the mode is a property of the released source', () => {
  it('import off → ancestry; import on → d2-floor', () => {
    expect(gateModeFor(IMPORT_OFF)).toBe('ancestry');
    expect(gateModeFor(IMPORT_ON)).toBe('d2-floor');
    expect(gateModeFor(flags(true, true))).toBe('d2-floor');
  });

  it('a computed flag is a REFUSAL, not a guess', () => {
    // The strict reader is the whole point: an env-derived flag would make the
    // artifact behave differently from its source, and a gate that guessed the
    // mode could be talked into ancestry for a build that has import on.
    const computed = 'export const BACKUP_IMPORT_ENABLED: boolean = process.env.X === "1";\n';
    expect(() => gateModeFor(computed)).toThrow(/literal initializer/);
    const verdict = decide({ flagsSource: computed });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cannot decide the gate mode/);
  });

  it('a source without the flag at all is a refusal', () => {
    const verdict = decide({ flagsSource: 'export const OTHER: boolean = true;\n' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/BACKUP_IMPORT_ENABLED/);
  });

  it('a declaration spelled in a comment cannot shadow the real one — even an INDENTED real one', () => {
    // The reviewer's reproduction against the text reader: a block comment
    // spells the declaration at the start of a line, the real export is
    // indented by one space. A line-anchored regex picked the comment (false)
    // and skipped the export (true) — ancestry mode for a build with import
    // ON. The AST reader sees one statement, exported, const, literal true.
    const reviewersCase = '/* Example:\nexport const BACKUP_IMPORT_ENABLED: boolean = false;\n*/\n export const BACKUP_IMPORT_ENABLED: boolean = true;\n';
    expect(readFlagExactlyOnce(reviewersCase, 'BACKUP_IMPORT_ENABLED')).toBe(true);
    expect(gateModeFor(reviewersCase)).toBe('d2-floor');
    expect(decide({ flagsSource: reviewersCase, candidate: DESCENDANT }).ok).toBe(false);
  });

  it('a declaration spelled inside a multi-line string is not a declaration either', () => {
    const inTemplate = 'const doc = `\nexport const BACKUP_IMPORT_ENABLED: boolean = false;\n`;\nexport const BACKUP_IMPORT_ENABLED: boolean = true;\n';
    expect(gateModeFor(inTemplate)).toBe('d2-floor');
    const inString = 'const doc = "export const BACKUP_IMPORT_ENABLED: boolean = false;";\n' + IMPORT_ON;
    expect(gateModeFor(inString)).toBe('d2-floor');
    const inLineComment = '// export const BACKUP_IMPORT_ENABLED: boolean = false;\n' + IMPORT_ON;
    expect(gateModeFor(inLineComment)).toBe('d2-floor');
  });

  it('two real declarations, a nested one, a non-exported or non-const one, or a negated initializer are refusals', () => {
    const duplicated = 'export const BACKUP_IMPORT_ENABLED: boolean = false;\n' + IMPORT_ON;
    expect(() => gateModeFor(duplicated)).toThrow(/found 2/);
    expect(decide({ flagsSource: duplicated }).ok).toBe(false);
    expect(() => gateModeFor('if (x) { export const BACKUP_IMPORT_ENABLED: boolean = true; }\n')).toThrow(/found 0/);
    expect(() => gateModeFor('const BACKUP_IMPORT_ENABLED: boolean = true;\n')).toThrow(/literal initializer/);
    expect(() => gateModeFor('export let BACKUP_IMPORT_ENABLED: boolean = true;\n')).toThrow(/literal initializer/);
    expect(() => gateModeFor('export const BACKUP_IMPORT_ENABLED: boolean = !false;\n')).toThrow(/literal initializer/);
    expect(() => gateModeFor('export const BACKUP_IMPORT_ENABLED = Boolean(1);\n')).toThrow(/literal initializer/);
  });

  it('an indented, un-annotated or trailing-comment declaration still counts — the AST does not care about layout', () => {
    expect(readFlagExactlyOnce('  export const BACKUP_IMPORT_ENABLED = true; // flipped 2026-10-01\n', 'BACKUP_IMPORT_ENABLED')).toBe(true);
    expect(readFlagExactlyOnce('export const BACKUP_IMPORT_ENABLED:boolean=false\n', 'BACKUP_IMPORT_ENABLED')).toBe(false);
  });
});

/*
 * The d2-floor line used below, oldest first:
 *
 *   OLD ── FLOOR (the import-flip release) ── RAISED ── DESCENDANT
 *     └── STRANGER (a side branch: descends from OLD, not from FLOOR)
 *
 * OLD plays the floor the import flip left behind (ff0954d in production),
 * FLOOR plays IMPORT_FLIP_FLOOR (394156d), RAISED a floor raised later on the
 * same line (the writer era), DESCENDANT a live worker above the floor (the
 * reader before the writer ships).
 */
const OLD = '0'.repeat(40);
const RAISED = 'e'.repeat(40);
const line = (over = {}) => fakeGit({
  ancestors: {
    [OLD]: [FLOOR, RAISED, DESCENDANT, STRANGER],
    [FLOOR]: [RAISED, DESCENDANT],
    [RAISED]: [DESCENDANT],
  },
  ...over,
});
const decideOn = over => checkClientFloorGate({
  floor: FLOOR, candidate: FLOOR, minimumFloor: FLOOR, importFlipFloor: FLOOR,
  flagsSource: IMPORT_ON, git: line(), ...over,
});

describe('d2-floor mode — a client with import on', () => {
  it('passes when the floor IS the import-flip release and the candidate IS the floor, with no git at all', () => {
    const ok = decideOn({ git: line({ undecided: true }) });
    expect(ok).toMatchObject({ ok: true, mode: 'd2-floor' });
    expect(ok.reason).toMatch(/WORKER_FLOOR_SHA == MINIMUM_FLOOR == /);
    expect(ok.reason).toMatch(/the floor is the import-flip release/);
    expect(ok.reason).toMatch(/is the floor itself/);
  });

  it('passes a live worker ABOVE the floor — the reader before the writer ships', () => {
    const verdict = decideOn({ candidate: DESCENDANT });
    expect(verdict).toMatchObject({ ok: true, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/descends from the floor/);
  });

  it('passes a floor raised above the import-flip release: flip → floor → candidate', () => {
    const verdict = decideOn({ floor: RAISED, minimumFloor: RAISED, candidate: DESCENDANT });
    expect(verdict).toMatchObject({ ok: true, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/the floor descends from the import-flip release/);
  });

  it('passes a raised floor that IS the candidate: candidate == floor > flip', () => {
    const verdict = decideOn({ floor: RAISED, minimumFloor: RAISED, candidate: RAISED });
    expect(verdict).toMatchObject({ ok: true, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/is the floor itself/);
  });

  it('(2) refuses the floor the flip left behind — the mistake the old equality rule existed to catch', () => {
    // «Candidate descends from the floor» alone holds here: FLOOR descends from
    // OLD. Only the import-flip condition refuses it.
    const verdict = decideOn({ floor: OLD, minimumFloor: OLD, candidate: FLOOR });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/neither the import-flip release .* nor a descendant of it/);
  });

  it('(2) refuses a floor on a side branch of the import-flip release', () => {
    const verdict = decideOn({ floor: STRANGER, minimumFloor: STRANGER, candidate: STRANGER });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/neither the import-flip release/);
  });

  it('(3) refuses a candidate below the floor', () => {
    const verdict = decideOn({ floor: RAISED, minimumFloor: RAISED, candidate: FLOOR });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/does not descend from the floor/);
  });

  it('(3) refuses a candidate off the line', () => {
    const verdict = decideOn({ candidate: STRANGER });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/does not descend from the floor/);
  });

  it('(1) refuses floors whose two stages disagree, before any ancestry question', () => {
    const verdict = decideOn({ floor: RAISED, minimumFloor: FLOOR, candidate: RAISED, git: line({ undecided: true }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/WORKER_FLOOR_SHA \(.*\) ≠ MINIMUM_FLOOR/);
  });

  it('an undecided git is a refusal in the import-flip question (2)', () => {
    const verdict = decideOn({ floor: RAISED, minimumFloor: RAISED, candidate: RAISED, git: line({ undecided: true }) });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/could not decide whether the floor .* descends from the import-flip release/);
  });

  it('an undecided git is a refusal in the candidate question (3)', () => {
    const verdict = decideOn({ candidate: DESCENDANT, git: line({ undecided: true }) });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/could not decide whether .* descends from the floor/);
  });

  it('an import-flip release that is not a full SHA is a refusal, not a pass', () => {
    const verdict = decideOn({ importFlipFloor: 'worker-r4' });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toMatch(/not a full 40-character commit SHA/);
  });

  it('defaults to the production import-flip release when the caller passes none', () => {
    // FLOOR is not the production release: without the fixture override the
    // floor is judged against IMPORT_FLIP_FLOOR — and git (from the line map)
    // does not know it, so the gate refuses rather than guess.
    const verdict = checkClientFloorGate({
      floor: FLOOR, candidate: FLOOR, minimumFloor: FLOOR, flagsSource: IMPORT_ON, git: line(),
    });
    expect(verdict).toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(verdict.reason).toContain(IMPORT_FLIP_FLOOR);
  });
});

describe('ancestry mode — a client with import off (client-b1)', () => {
  it('accepts the floor itself', () => {
    const verdict = decide({ candidate: FLOOR });
    expect(verdict).toMatchObject({ ok: true, mode: 'ancestry' });
    expect(verdict.reason).toMatch(/WORKER_FLOOR_SHA == MINIMUM_FLOOR == /);
  });

  it('accepts a descendant of the floor and says the floor stays', () => {
    const verdict = decide({ candidate: DESCENDANT });
    expect(verdict).toMatchObject({ ok: true, mode: 'ancestry' });
    expect(verdict.reason).toMatch(/the floor stays/);
    expect(verdict.reason).toMatch(/before the import flip/);
    expect(verdict.reason).toMatch(/WORKER_FLOOR_SHA == MINIMUM_FLOOR == /);
  });

  it('refuses a candidate that does not descend from the floor', () => {
    const verdict = decide({ candidate: STRANGER });
    expect(verdict).toMatchObject({ ok: false, mode: 'ancestry' });
    expect(verdict.reason).toMatch(/does not descend from the floor/);
  });

  it('an undecided git is a refusal, not a pass', () => {
    const verdict = decide({ candidate: DESCENDANT, git: fakeGit({ undecided: true }) });
    expect(verdict).toMatchObject({ ok: false, mode: 'ancestry' });
    expect(verdict.reason).toMatch(/could not decide/);
  });

  it('a regression that judged an import-on build in ancestry mode would be caught', () => {
    // Same inputs, only the source flips import on: a floor left BELOW the
    // import-flip release is fine for ancestry (the candidate descends from it)
    // and MUST be a refusal for d2-floor.
    const same = { floor: OLD, minimumFloor: OLD, candidate: DESCENDANT, importFlipFloor: FLOOR, git: line() };
    expect(decide({ ...same, flagsSource: IMPORT_OFF })).toMatchObject({ ok: true, mode: 'ancestry' });
    expect(decide({ ...same, flagsSource: IMPORT_ON })).toMatchObject({ ok: false, mode: 'd2-floor' });
  });
});

describe('the floor itself, in both modes', () => {
  it.each([
    ['ancestry', IMPORT_OFF],
    ['d2-floor', IMPORT_ON],
  ])('%s: the Environment floor must equal MINIMUM_FLOOR', (_mode, flagsSource) => {
    const half = decide({ flagsSource, floor: DESCENDANT, candidate: DESCENDANT, minimumFloor: FLOOR });
    expect(half.ok).toBe(false);
    expect(half.reason).toMatch(/WORKER_FLOOR_SHA \(.*\) ≠ MINIMUM_FLOOR/);
    expect(half.reason).toMatch(/two stages of a floor raise must agree/);
  });

  it('an unset floor is a refusal — a floor already exists', () => {
    const verdict = decide({ floor: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/WORKER_FLOOR_SHA is not set/);
  });

  it('a tag or a short SHA is refused as the floor', () => {
    expect(decide({ floor: 'worker-r4' }).reason).toMatch(/not a full 40-character commit SHA/);
    expect(decide({ floor: FLOOR.slice(0, 7) }).reason).toMatch(/not a full 40-character commit SHA/);
  });

  it('a candidate that is not a full SHA is refused', () => {
    expect(decide({ candidate: 'main' }).reason).toMatch(/candidate "main" is not a full 40-character/);
  });

  it('SHAs are compared case-insensitively and trimmed — floor, candidate and pin alike', () => {
    expect(decide({ candidate: ` ${DESCENDANT.toUpperCase()} `, floor: FLOOR.toUpperCase() }).ok).toBe(true);
    expect(decide({ minimumFloor: ` ${FLOOR.toUpperCase()} ` }).ok).toBe(true);
  });
});

describe('against a real repository', () => {
  let repo;
  let first;
  let second;
  let third;
  let offBranch;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'client-floor-'));
    const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const commit = message => {
      writeFileSync(join(repo, 'file.txt'), `${message}\n`);
      run('add', '-A');
      run('commit', '-q', '-m', message);
      return head();
    };
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'client-floor-test@example.invalid');
    run('config', 'user.name', 'Client Floor Test');
    run('config', 'commit.gpgsign', 'false');
    first = commit('first — the floor');
    second = commit('second — a later worker release');
    third = commit('third — a release above it on the same line');
    run('checkout', '-q', '-b', 'unmerged', first);
    offBranch = commit('off the line — not a descendant of second');
    run('checkout', '-q', 'main');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const real = over =>
    checkClientFloorGate({ floor: first, minimumFloor: first, flagsSource: IMPORT_OFF, git: gitIn(repo), ...over });

  it('the fixture is what the tests think it is', () => {
    for (const sha of [first, second, third, offBranch]) expect(SHA_RE.test(sha)).toBe(true);
    expect(new Set([first, second, third, offBranch]).size).toBe(4);
  });

  it('ancestry: a later release on the line passes, a commit off the line does not', () => {
    expect(real({ candidate: second })).toMatchObject({ ok: true, mode: 'ancestry' });
    // offBranch descends from `first` too; make the floor `second` to have a true non-descendant.
    const verdict = real({ floor: second, minimumFloor: second, candidate: offBranch });
    expect(verdict).toMatchObject({ ok: false, mode: 'ancestry' });
  });

  // d2-floor, with `second` playing the import-flip release.
  const onFlip = over => real({ flagsSource: IMPORT_ON, importFlipFloor: second, ...over });

  it('d2-floor: the floor the flip left behind is refused once import is on — even though the candidate descends from it', () => {
    expect(real({ candidate: second })).toMatchObject({ ok: true, mode: 'ancestry' });
    expect(onFlip({ candidate: second })).toMatchObject({ ok: false, mode: 'd2-floor' });
  });

  it('d2-floor: a candidate above a floor that IS the import-flip release passes', () => {
    expect(onFlip({ floor: second, minimumFloor: second, candidate: third })).toMatchObject({ ok: true, mode: 'd2-floor' });
    expect(onFlip({ floor: second, minimumFloor: second, candidate: second })).toMatchObject({ ok: true, mode: 'd2-floor' });
  });

  it('d2-floor: a floor raised above the import-flip release passes, as the candidate itself too', () => {
    expect(onFlip({ floor: third, minimumFloor: third, candidate: third })).toMatchObject({ ok: true, mode: 'd2-floor' });
  });

  it('d2-floor: a floor beside the import-flip release, or a candidate off the floor\'s line, is refused', () => {
    expect(onFlip({ floor: offBranch, minimumFloor: offBranch, candidate: offBranch }))
      .toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(onFlip({ floor: second, minimumFloor: second, candidate: offBranch }))
      .toMatchObject({ ok: false, mode: 'd2-floor' });
    expect(onFlip({ floor: third, minimumFloor: third, candidate: second }))
      .toMatchObject({ ok: false, mode: 'd2-floor' });
  });
});

describe('this repository — the path the workflow executes', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const realFlags = readFileSync(join(repoRoot, 'src', 'lib', 'flags.ts'), 'utf8');
  // Derived by an INDEPENDENT reader (the regex of check-backup-flags.mjs,
  // which is right for the real, unshadowed file) from the same file the
  // workflow builds: a wiring that silently hard-coded import=false (ancestry
  // for a build with import ON) would disagree with this the day import flips,
  // and so would an AST reader that started reading the wrong declaration.
  const expectedMode = readFlag(realFlags, 'BACKUP_IMPORT_ENABLED') ? 'd2-floor' : 'ancestry';
  expect(readFlagExactlyOnce(realFlags, 'BACKUP_IMPORT_ENABLED')).toBe(readFlag(realFlags, 'BACKUP_IMPORT_ENABLED'));

  // The CI test job checks out SHALLOW (only the deploy workflows fetch full
  // history, see «keeps the full history» below). While the pin IS the
  // import-flip release, the real path is decided by equal SHAs alone and needs
  // no history. Once the pin is raised above it, «does the pin descend from the
  // flip?» needs history: those tests then run where it exists and are skipped
  // in a shallow clone — the deploy run itself still answers that question.
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, encoding: 'utf8' }).trim() === 'true';
  const needsHistory = expectedMode === 'd2-floor' && MINIMUM_FLOOR !== IMPORT_FLIP_FLOOR;

  it('the import-flip release is a full SHA and the very one ROLLBACK records as the floor raised before the flip', () => {
    expect(SHA_RE.test(IMPORT_FLIP_FLOOR)).toBe(true);
    const rollback = readFileSync(join(repoRoot, 'docs', 'ROLLBACK.md'), 'utf8');
    expect(rollback).toContain(`**DONE 2026-10-02** — target \`${IMPORT_FLIP_FLOOR}\``);
  });

  it.skipIf(needsHistory && shallow)('the real pin is the import-flip release or a later release on its line', () => {
    if (MINIMUM_FLOOR === IMPORT_FLIP_FLOOR) return;
    expect(gitIn(repoRoot).isAncestor(IMPORT_FLIP_FLOOR, MINIMUM_FLOOR)).toBe(true);
  });

  it.skipIf(needsHistory && shallow)('checkClientFloorGateHere reads the real src/lib/flags.ts and the real pin', () => {
    const verdict = checkClientFloorGateHere({ floor: MINIMUM_FLOOR, candidate: MINIMUM_FLOOR });
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe(expectedMode);
    expect(verdict.reason).toContain(`WORKER_FLOOR_SHA == MINIMUM_FLOOR == ${MINIMUM_FLOOR}`);
  });

  const script = join(repoRoot, 'scripts', 'check-client-floor-gate.mjs');
  // Deliberately NOT run from the repo root: flags, pin and git must resolve
  // from the script's own location, whatever the process cwd is.
  const runCli = env => spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env }, encoding: 'utf8', cwd: tmpdir(),
  });

  // The refusal needs no history (the candidate is not even a SHA), so it is
  // never skipped — a CLI that stopped exiting non-zero is caught in any clone.
  it('the CLI exits non-zero on a refusal', () => {
    const refused = runCli({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: 'main' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/check-client-floor-gate: REFUSED/);
  });

  it.skipIf(needsHistory && shallow)('the CLI reads the environment the workflow passes and reports the real mode', () => {
    const passed = runCli({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: MINIMUM_FLOOR });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(`client floor gate: ${expectedMode} mode`);
  });

  it.skipIf(expectedMode !== 'd2-floor' || (needsHistory && shallow))(
    'the import-flip release cannot be lowered from the environment — the CLI judges against the literal',
    () => {
      // Plausible names an operator (or a future workflow edit) might try. Were
      // any of them honoured, the floor would be judged against an all-ones SHA
      // this repository does not have, and git would refuse; the literal keeps
      // the verdict a pass and names itself in the reason.
      const bogus = '1'.repeat(40);
      const passed = runCli({
        WORKER_FLOOR_SHA: MINIMUM_FLOOR,
        WORKER_CANDIDATE_SHA: MINIMUM_FLOOR,
        IMPORT_FLIP_FLOOR: bogus,
        IMPORT_FLIP_FLOOR_SHA: bogus,
        INPUT_IMPORT_FLIP_FLOOR: bogus,
      });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain(`import-flip release ${IMPORT_FLIP_FLOOR}`);
      expect(passed.stdout).not.toContain(bogus);
    },
  );
});

describe('the workflow cannot be talked out of the gate by the code it judges', () => {
  const workflowText = readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-pages-cf.yml', import.meta.url)),
    'utf8',
  );
  const workflow = loadYaml(workflowText);
  const steps = workflow.jobs['build-and-deploy'].steps;
  const runOf = step => (typeof step.run === 'string' ? step.run : '');
  const index = pred => steps.findIndex(pred);

  it('runs the script gate with the floor variable and the candidate input, as one step', () => {
    const gate = steps.filter(s => runOf(s).includes('scripts/check-client-floor-gate.mjs'));
    expect(gate).toHaveLength(1);
    expect(gate[0].env.WORKER_FLOOR_SHA).toBe('${{ vars.WORKER_FLOOR_SHA }}');
    expect(gate[0].env.WORKER_CANDIDATE_SHA).toBe('${{ inputs.worker_candidate }}');
    expect(runOf(gate[0]).trim()).toBe('node scripts/check-client-floor-gate.mjs');
  });

  it('no inline bash equality gate is left behind to disagree with the script', () => {
    for (const step of steps) {
      expect(runOf(step)).not.toMatch(/\[ "\$FLOOR" != "\$CANDIDATE" \]/);
      expect(runOf(step)).not.toContain('MINIMUM_FLOOR');
    }
    expect(workflowText).not.toContain('Raise the Environment floor to the smoked release before publishing');
  });

  it('keeps the full history the ancestry answer needs', () => {
    const checkout = steps.find(s => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    expect(checkout.with['fetch-depth']).toBe(0);
  });

  it('refuses a dispatch from anything but the default branch before doing anything else', () => {
    const refuse = index(s => runOf(s).includes('must be dispatched from the') && runOf(s).includes('DEFAULT'));
    expect(refuse).toBeGreaterThan(-1);
    expect(steps[refuse].env.REF).toBe('${{ github.ref }}');
    expect(steps[refuse].env.DEFAULT).toBe('${{ github.event.repository.default_branch }}');
    const firstRun = index(s => runOf(s) !== '');
    expect(refuse).toBe(firstRun);
  });

  it('judges the release in this order: identity from the worker run → live /health smoke → floor gate → deploy', () => {
    const identity = index(s => s.id === 'identity');
    const smoke = index(s => runOf(s).includes('worker/scripts/smoke-gateways.mjs --profile=normal'));
    const gate = index(s => runOf(s).includes('scripts/check-client-floor-gate.mjs'));
    const deploy = index(s => s.id === 'deploy');
    expect(identity).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(identity);
    expect(gate).toBeGreaterThan(smoke);
    expect(deploy).toBeGreaterThan(gate);
  });
});
