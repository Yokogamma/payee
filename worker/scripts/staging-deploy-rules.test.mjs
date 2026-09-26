import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYED_SOURCE_ROOTS, STAGING_CONFIG_GATES, STAGING_MIN_OPERATORS,
  releaseShaOf, stagingDeployArgs, stagingSmokeEnv, stagingSmokeOrigin, uncleanDeploySources,
} from './staging-deploy-rules.mjs';

// Runbook reader release M6 (review 25.09): the staging rehearsal's checks are
// mandatory in the script — gates, clean deployed sources, RELEASE_SHA, the
// live smoke.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const SHA = '394156d5998dbaef5b1d273898ee8006104227f8';

describe('config gates', () => {
  it('spend limits, per-contour trusted owners (full rules, no --contour) and the status pool — all present in the repo', () => {
    const scripts = STAGING_CONFIG_GATES.map(([s]) => s);
    expect(scripts).toEqual(expect.arrayContaining([
      'scripts/check-spend-limits.mjs', 'scripts/check-trusted-owners.mjs', 'scripts/check-gateways-vs-worker.mjs',
    ]));
    for (const s of scripts) expect(existsSync(join(ROOT, s)), s).toBe(true);
    const owners = STAGING_CONFIG_GATES.find(([s]) => s === 'scripts/check-trusted-owners.mjs');
    expect(owners.some(a => a.startsWith('--contour'))).toBe(false);
  });
});

describe('stagingSmokeOrigin — required before the deploy', () => {
  it('missing → refused, naming the rule', () => {
    for (const raw of [undefined, '']) {
      const r = stagingSmokeOrigin(raw);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/SMOKE_STAGING_ORIGIN is required/);
    }
  });
  it('anything but a bare https origin → refused', () => {
    for (const raw of ['http://staging.example.com', 'https://staging.example.com/health', 'https://staging.example.com/?x=1', 'https://u:p@staging.example.com', 'not a url']) {
      expect(stagingSmokeOrigin(raw).ok, raw).toBe(false);
    }
  });
  it('a bare https origin → accepted', () => {
    expect(stagingSmokeOrigin('https://eternal-notes-proxy-staging.sopi-88c.workers.dev')).toEqual({ ok: true, origin: 'https://eternal-notes-proxy-staging.sopi-88c.workers.dev' });
  });
});

describe('uncleanDeploySources', () => {
  it('clean → nothing; tracked changes anywhere and untracked files under the roots → listed', () => {
    expect(uncleanDeploySources('', '')).toEqual([]);
    expect(uncleanDeploySources(' M README.md\n', '')).toEqual([' M README.md']);
    // The roots listing repeats tracked changes under the roots; only its
    // untracked lines are added, so nothing is listed twice.
    expect(uncleanDeploySources(' M worker/src/index.ts\n', ' M worker/src/index.ts\n?? worker/src/extra.ts\n'))
      .toEqual([' M worker/src/index.ts', '?? worker/src/extra.ts']);
  });

  it('against real git: an untracked module under worker/src or src/lib blocks; an ignored file or a root scratch file does not', () => {
    const repo = mkdtempSync(join(tmpdir(), 'staging-clean-'));
    try {
      const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
      g('init', '-q');
      g('config', 'user.email', 't@example.com');
      g('config', 'user.name', 't');
      mkdirSync(join(repo, 'worker', 'src'), { recursive: true });
      mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), 'worker/node_modules/\n');
      writeFileSync(join(repo, 'worker', 'src', 'index.ts'), 'export {};\n');
      g('add', '-A');
      g('commit', '-q', '-m', 'init');
      const status = () => uncleanDeploySources(
        g('status', '--porcelain', '--untracked-files=no'),
        g('status', '--porcelain', '--untracked-files=all', '--', ...DEPLOYED_SOURCE_ROOTS),
      );
      expect(status()).toEqual([]);

      mkdirSync(join(repo, 'worker', 'node_modules'), { recursive: true });
      writeFileSync(join(repo, 'worker', 'node_modules', 'x.js'), '');
      writeFileSync(join(repo, 'scratch.txt'), 'notes');
      expect(status()).toEqual([]);

      writeFileSync(join(repo, 'worker', 'src', 'extra.ts'), 'export const x = 1;\n');
      writeFileSync(join(repo, 'src', 'lib', 'shared.ts'), 'export const y = 2;\n');
      expect(status()).toEqual(['?? src/lib/shared.ts', '?? worker/src/extra.ts']);

      rmSync(join(repo, 'worker', 'src', 'extra.ts'));
      rmSync(join(repo, 'src', 'lib', 'shared.ts'));
      writeFileSync(join(repo, 'worker', 'src', 'index.ts'), 'export const changed = 1;\n');
      expect(status()).toEqual([' M worker/src/index.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('release identity', () => {
  it('releaseShaOf accepts only a full lower-case SHA', () => {
    expect(releaseShaOf(`${SHA}\n`)).toBe(SHA);
    for (const raw of ['394156d', SHA.toUpperCase(), '', undefined, `${SHA}0`]) expect(releaseShaOf(raw)).toBeNull();
  });

  it('stagingDeployArgs passes RELEASE_SHA as a var of the staging deploy, and refuses anything but a full SHA', () => {
    expect(stagingDeployArgs(SHA)).toEqual(['deploy', '--env', 'staging', '--var', `RELEASE_SHA:${SHA}`]);
    expect(() => stagingDeployArgs('394156d')).toThrow(/full 40-hex SHA/);
  });

  it('stagingSmokeEnv asserts the SHA, the activated version and the operator floor on the live /health', () => {
    const e = stagingSmokeEnv({ PATH: 'p' }, { sha: SHA, versionId: 'v-1' });
    expect(e).toMatchObject({ PATH: 'p', EXPECT_RELEASE_SHA: SHA, EXPECT_WORKER_VERSION_ID: 'v-1', EXPECT_MIN_OPERATORS: String(STAGING_MIN_OPERATORS) });
    expect(STAGING_MIN_OPERATORS).toBe(2);
  });
});

describe('deploy-staging.mjs applies every rule (static)', () => {
  const src = readFileSync(join(HERE, 'deploy-staging.mjs'), 'utf8');

  it('the smoke origin is checked BEFORE the gates and the deploy; the smoke is never skipped', () => {
    const origin = src.indexOf('stagingSmokeOrigin(process.env.SMOKE_STAGING_ORIGIN)');
    expect(origin).toBeGreaterThan(-1);
    expect(origin).toBeLessThan(src.indexOf('STAGING_CONFIG_GATES) run('));
    expect(origin).toBeLessThan(src.indexOf('stagingDeployArgs(sha)'));
    expect(src).not.toMatch(/smoke was skipped/);
    expect(src).not.toMatch(/if \(process\.env\.SMOKE_STAGING_ORIGIN\)/);
    expect(src).toMatch(/smoke-gateways\.mjs', '--staging'/);
    expect(src).toMatch(/stagingSmokeEnv\(process\.env, \{ sha, versionId: parsed\.versionId \}\)/);
  });

  it('every config gate runs; the clean-sources check covers the bundle roots; the deploy carries RELEASE_SHA', () => {
    expect(src).toMatch(/for \(const \[script, \.\.\.args\] of STAGING_CONFIG_GATES\) run\(/);
    expect(src).toMatch(/'--untracked-files=all', '--', \.\.\.DEPLOYED_SOURCE_ROOTS/);
    expect(src).toMatch(/uncleanDeploySources\(/);
    expect(src).toMatch(/\[WRANGLER_BIN, \.\.\.stagingDeployArgs\(sha\)\]/);
    // The clean check comes before the SHA is read, and both before the deploy.
    expect(src.indexOf('uncleanDeploySources(')).toBeLessThan(src.indexOf("releaseShaOf(git('rev-parse', 'HEAD'))"));
    expect(src.indexOf("releaseShaOf(git('rev-parse', 'HEAD'))")).toBeLessThan(src.indexOf('stagingDeployArgs(sha)'));
  });
});
