import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientFloorGate, checkClientFloorGateHere, gateModeFor } from './check-client-floor-gate.mjs';
import { gitIn, MINIMUM_FLOOR, SHA_RE } from './check-worker-floor.mjs';

/**
 * The client floor gate (D2a) in its two modes.
 *
 * Three things are worth a failing build, and they are separate:
 *   1. the RULES — equality once import is on, ancestry while it is off, and
 *      «could not tell» is a refusal in both;
 *   2. that the MODE comes from the released source and from nowhere else — a
 *      computed flag, or no flag, is a refusal, never a guess;
 *   3. the WORKFLOW's shape — the step carries the floor variable, reads the
 *      candidate from the input, and no bash inline gate is left behind that
 *      could disagree with the script.
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
    expect(() => gateModeFor(computed)).toThrow(/must be declared as a literal/);
    const verdict = decide({ flagsSource: computed });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cannot decide the gate mode/);
  });

  it('a source without the flag at all is a refusal', () => {
    const verdict = decide({ flagsSource: 'export const OTHER: boolean = true;\n' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/BACKUP_IMPORT_ENABLED/);
  });
});

describe('equality mode — a client with import on', () => {
  it('passes only when the candidate IS the floor', () => {
    const ok = decide({ flagsSource: IMPORT_ON, candidate: FLOOR });
    expect(ok).toMatchObject({ ok: true, mode: 'equality' });
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

  it('never consults git — the answer does not depend on ancestry', () => {
    const verdict = decide({ flagsSource: IMPORT_ON, candidate: DESCENDANT, git: fakeGit({ undecided: true }) });
    expect(verdict).toMatchObject({ ok: false, mode: 'equality' });
  });
});

describe('ancestry mode — a client with import off (client-b1)', () => {
  it('accepts the floor itself', () => {
    expect(decide({ candidate: FLOOR })).toMatchObject({ ok: true, mode: 'ancestry' });
  });

  it('accepts a descendant of the floor and says the floor stays', () => {
    const verdict = decide({ candidate: DESCENDANT });
    expect(verdict).toMatchObject({ ok: true, mode: 'ancestry' });
    expect(verdict.reason).toMatch(/floor stays at/);
    expect(verdict.reason).toMatch(/before the import flip/);
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

  it('SHAs are compared case-insensitively and trimmed', () => {
    expect(decide({ candidate: ` ${DESCENDANT.toUpperCase()} `, floor: FLOOR.toUpperCase() }).ok).toBe(true);
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

describe('this repository', () => {
  it('the real flags and the real pin are readable through the same path the CLI uses', () => {
    // Whatever the current pair is, the mode must be decidable from the real
    // src/lib/flags.ts, and the pin must be the floor the gate compares against.
    const verdict = checkClientFloorGateHere({ floor: MINIMUM_FLOOR, candidate: MINIMUM_FLOOR });
    expect(verdict.ok).toBe(true);
    expect(['ancestry', 'equality']).toContain(verdict.mode);
  });

  it('the CLI reads the environment the workflow passes, and exits non-zero on a refusal', () => {
    const script = fileURLToPath(new URL('./check-client-floor-gate.mjs', import.meta.url));
    const run = env => spawnSync(process.execPath, [script], {
      env: { ...process.env, ...env }, encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)),
    });
    const refused = run({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: 'main' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/check-client-floor-gate: REFUSED/);
    const passed = run({ WORKER_FLOOR_SHA: MINIMUM_FLOOR, WORKER_CANDIDATE_SHA: MINIMUM_FLOOR });
    expect(passed.status).toBe(0);
    expect(passed.stdout).toMatch(/client floor gate: (ancestry|equality) mode/);
  });
});

describe('the workflow cannot be talked out of the gate by the code it judges', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-pages-cf.yml', import.meta.url)),
    'utf8',
  );

  it('runs the script gate with the floor variable and the candidate input', () => {
    expect(workflow).toContain('node scripts/check-client-floor-gate.mjs');
    expect(workflow).toMatch(/WORKER_FLOOR_SHA:\s*\$\{\{\s*vars\.WORKER_FLOOR_SHA\s*\}\}/);
    expect(workflow).toMatch(/WORKER_CANDIDATE_SHA:\s*\$\{\{\s*inputs\.worker_candidate\s*\}\}/);
  });

  it('no inline bash equality gate is left behind to disagree with the script', () => {
    expect(workflow).not.toContain('Raise the Environment floor to the smoked release before publishing');
    expect(workflow).not.toMatch(/if \[ "\$FLOOR" != "\$CANDIDATE" \]/);
  });

  it('keeps the full history the ancestry answer needs', () => {
    expect(workflow).toMatch(/fetch-depth:\s*0/);
  });

  it('still verifies the live worker identity before the gate', () => {
    const identity = workflow.indexOf('Verify the live worker is the gated release');
    const gate = workflow.indexOf('check-client-floor-gate.mjs');
    const deploy = workflow.indexOf('id: deploy');
    expect(identity).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(identity);
    expect(deploy).toBeGreaterThan(gate);
  });
});
