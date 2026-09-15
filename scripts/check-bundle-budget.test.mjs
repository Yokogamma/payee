import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The gate has one job — «is the bundle under the ceiling» — and two ways to
 * answer it wrong.
 *
 * The pass is exercised by every CI build, so a regression there is loud. The
 * REFUSALS are not: «no build here» must be distinguishable from «over
 * budget», because the first is a broken pipeline and the second is a
 * decision, and a script that returns the same code for both gets read as the
 * wrong one at the worst moment.
 *
 * (The D18 guard that used to live here — fail once `src/lib/gateways.ts`
 * appears, to force a re-measure of a provisional ceiling — is gone with the
 * ceiling it guarded: the 300 KB limit is a deliberate decision rather than a
 * placeholder, so there is nothing left to force anyone back to.)
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
