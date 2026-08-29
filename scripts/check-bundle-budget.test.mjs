import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The budget gate has two jobs, and only one of them used to be exercised.
 *
 * The ordinary one — «is the bundle under the ceiling» — is run on every CI
 * build, so a regression there is loud. The other is the D18 guard: the
 * current ceiling was raised BEFORE PR-3a exists and is therefore provisional,
 * so the script must refuse to keep passing once PR-3a lands. That branch runs
 * exactly never today, which is the definition of code nobody has checked —
 * and it is the branch whose failure mode is silent: a placeholder ceiling
 * that ships because nothing ever forced anyone back to it.
 *
 * Run against a TEMPORARY tree rather than the repository: the script reads
 * `process.cwd()`, and the whole point is to control what it finds there.
 */

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-bundle-budget.mjs');

let dir;

/** A dist with one tiny JS asset — comfortably under any ceiling. */
function seedDist(root) {
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(root, 'dist', 'assets', 'index-test.js'), 'console.log(1);\n');
}

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'budget-gate-'));
  seedDist(dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the ordinary path', () => {
  it('passes a small bundle', () => {
    const result = run(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Bundle budget OK');
  });

  it('refuses to guess when there is no build', () => {
    const empty = mkdtempSync(join(tmpdir(), 'budget-gate-empty-'));
    try {
      const result = run(empty);
      // A distinct code from both «over budget» (1) and «PR-3a landed» (2):
      // «I could not measure» is not a verdict about the bundle.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('run `npm run build` first');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the D18 guard: a provisional ceiling cannot outlive PR-3a', () => {
  it('fails as soon as src/lib/gateways.ts exists, and says what to do', () => {
    // `gateways.ts` is the artifact of PR-3a. Its appearance means the bundle
    // base has changed and the reserved headroom for the D9 verification is
    // now spoken for — so the ceiling raised for the backup block stops being
    // a defensible placeholder and has to be re-measured ONCE, on the new base.
    const withPr3a = mkdtempSync(join(tmpdir(), 'budget-gate-pr3a-'));
    try {
      seedDist(withPr3a);
      mkdirSync(join(withPr3a, 'src', 'lib'), { recursive: true });
      writeFileSync(join(withPr3a, 'src', 'lib', 'gateways.ts'), 'export const PAYLOAD_GATEWAYS = [];\n');

      const result = run(withPr3a);

      expect(result.status).toBe(2);
      // The message has to name the action, not just the problem: a gate that
      // cannot be satisfied and does not say how is a gate someone deletes.
      expect(result.stderr).toContain('BUDGET_IS_PROVISIONAL=false');
      expect(result.stderr).toContain('D18');
      // …and it fires BEFORE measuring, so it cannot be mistaken for the
      // bundle having grown.
      expect(result.stdout).not.toContain('TOTAL');
    } finally {
      rmSync(withPr3a, { recursive: true, force: true });
    }
  });
});
