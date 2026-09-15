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
  readFlagExactlyOnce,
} from './check-client-floor-gate.mjs';
import { gitIn, MINIMUM_FLOOR, SHA_RE } from './check-worker-floor.mjs';

/**
 * The client floor gate (D2a) in its two modes.
 *
 * Three things are worth a failing build, and they are separate:
 *   1. the RULES — equality once import is on, ancestry while it is off, and
 *      «could not tell» is a refusal in both;
 *   2. that the MODE comes from the released source and from nowhere else —
 *      a computed, missing or DUPLICATED flag is a refusal, never a guess, and
 *      the path the workflow executes really reads the real src/lib/flags.ts;
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
  it('import off → ancestry; import on → equality', () => {
    expect(gateModeFor(IMPORT_OFF)).toBe('ancestry');
    expect(gateModeFor(IMPORT_ON)).toBe('equality');
    expect(gateModeFor(flags(true, true))).toBe('equality');
  });

  it('a computed flag is a REFUSAL, not a guess', () => {
    // The strict reader is the whole point: an env-derived flag would make the
    // artifact behave differently from its source, and a gate that guessed the
    // mode could be talked into ancestry for a build that has import on.
    const computed = 'export const BACKUP_IMPORT_ENABLED: boolean = process.env.X === "1";\n';
    expect(() => gateModeFor(computed)).toThrow(/exactly one line-anchored declaration/);
    const verdict = decide({ flagsSource: computed });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cannot decide the gate mode/);
  });

  it('a source without the flag at all is a refusal', () => {
    const verdict = decide({ flagsSource: 'export const OTHER: boolean = true;\n' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/BACKUP_IMPORT_ENABLED/);
  });

  it('a declaration spelled in a comment or a string cannot shadow the real one', () => {
    // A first-match reader would pick the `= false` inside the doc comment and
    // put an import-ON build into ancestry mode. The reader is line-anchored
    // and demands exactly one match, so the shadowed source is a refusal — and
    // an indented (commented-out) copy does not count as a declaration.
    const shadowedAhead = `/** example: export const BACKUP_IMPORT_ENABLED: boolean = false; */\n${IMPORT_ON}`;
    expect(() => gateModeFor(shadowedAhead)).not.toThrow();
    expect(gateModeFor(shadowedAhead)).toBe('equality');
    const duplicated = `export const BACKUP_IMPORT_ENABLED: boolean = false;\n${IMPORT_ON}`;
    expect(() => gateModeFor(duplicated)).toThrow(/found 2/);
    expect(decide({ flagsSource: duplicated }).ok).toBe(false);
    const stringLiteral = `const doc = "export const BACKUP_IMPORT_ENABLED: boolean = false;";\n${IMPORT_ON}`;
    expect(gateModeFor(stringLiteral)).toBe('equality');
  });

  it('readFlagExactlyOnce is anchored at line start', () => {
    expect(readFlagExactlyOnce(IMPORT_ON, 'BACKUP_IMPORT_ENABLED')).toBe(true);
    expect(readFlagExactlyOnce(IMPORT_OFF, 'BACKUP_IMPORT_ENABLED')).toBe(false);
    expect(() => readFlagExactlyOnce('  export const BACKUP_IMPORT_ENABLED: boolean = true;\n', 'BACKUP_IMPORT_ENABLED')).toThrow(/found 0/);
  });
});

describe('equality mode — a client with import on', () => {
  it('passes only when the candidate IS the floor, and needs no git to say so', () => {
    const ok = decide({ flagsSource: IMPORT_ON, candidate: FLOOR, git: fakeGit({ undecided: true }) });
    expect(ok).toMatchObject({ ok: true, mode: 'equality' });
    expect(ok.reason).toMatch(/WORKER_FLOOR_SHA == MINIMUM_FLOOR == /);
  });

  it('refuses a candidate that merely descends from the floor', () => {
    // Descent is satisfied by the OLD floor too — exactly the mistake equality
    // exists to catch: shipping a client with import on while the floor still
    // points at the previous worker release.
    const verdict = decide({ flagsSource: IMPORT_ON, candidate: DESCENDANT });
    expect(verdict).toMatchObject({ ok: false, mode: 'equality' });
    expect(verdict.reason).toMatch(/equality mode/);
    expect(verdict.reason).toMatch(/ships against/);
  });

  it('never consults git — the refusal does not depend on ancestry', () => {
    const verdict = decide({ flagsSource: IMPORT_ON, candidate: DESCENDANT, git: fakeGit({ undecided: true }) });
    expect(verdict).toMatchObject({ ok: false, mode: 'equality' });
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

  it('a regression that switched to ancestry with import ON would be caught', () => {
    // Same inputs as the accepting ancestry case, only the source flips import
    // on: the verdict MUST flip to a refusal.
    expect(decide({ candidate: DESCENDANT, flagsSource: IMPORT_OFF }).ok).toBe(true);
    expect(decide({ candidate: DESCENDANT, flagsSource: IMPORT_ON }).ok).toBe(false);
  });
});

describe('the floor itself, in both modes', () => {
  it.each([
    ['ancestry', IMPORT_OFF],
    ['equality', IMPORT_ON],
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
    for (const sha of [first, second, offBranch]) expect(SHA_RE.test(sha)).toBe(true);
    expect(new Set([first, second, offBranch]).size).toBe(3);
  });

  it('ancestry: a later release on the line passes, a commit off the line does not', () => {
    expect(real({ candidate: second })).toMatchObject({ ok: true, mode: 'ancestry' });
    // offBranch descends from `first` too; make the floor `second` to have a true non-descendant.
    const verdict = real({ floor: second, minimumFloor: second, candidate: offBranch });
    expect(verdict).toMatchObject({ ok: false, mode: 'ancestry' });
  });

  it('equality: the same later release is refused once import is on', () => {
    expect(real({ flagsSource: IMPORT_ON, candidate: second })).toMatchObject({ ok: false, mode: 'equality' });
    expect(real({ flagsSource: IMPORT_ON, candidate: first })).toMatchObject({ ok: true, mode: 'equality' });
  });
});

describe('this repository — the path the workflow executes', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const realFlags = readFileSync(join(repoRoot, 'src', 'lib', 'flags.ts'), 'utf8');
  // Derived independently of the wiring under test, from the same file the
  // workflow builds: a wiring that silently hard-coded import=false (ancestry
  // for a build with import ON) would disagree with this the day import flips.
  const expectedMode = readFlagExactlyOnce(realFlags, 'BACKUP_IMPORT_ENABLED') ? 'equality' : 'ancestry';

  it('checkClientFloorGateHere reads the real src/lib/flags.ts and the real pin', () => {
    const verdict = checkClientFloorGateHere({ floor: MINIMUM_FLOOR, candidate: MINIMUM_FLOOR });
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe(expectedMode);
    expect(verdict.reason).toContain(`WORKER_FLOOR_SHA == MINIMUM_FLOOR == ${MINIMUM_FLOOR}`);
  });

  it('the CLI reads the environment the workflow passes, reports the real mode, and exits non-zero on a refusal', () => {
    const script = join(repoRoot, 'scripts', 'check-client-floor-gate.mjs');
    // Deliberately NOT run from the repo root: flags, pin and git must resolve
    // from the script's own location, whatever the process cwd is.
    const run = env => spawnSync(process.execPath, [script], {
      env: { ...process.env, ...env }, encoding: 'utf8', cwd: tmpdir(),
    });
    const refused = run({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: 'main' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/check-client-floor-gate: REFUSED/);
    const passed = run({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: MINIMUM_FLOOR });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain(`client floor gate: ${expectedMode} mode`);
  });
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
