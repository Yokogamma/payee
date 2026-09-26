import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYED_SOURCE_ROOTS, STAGING_CONFIG_GATES, STAGING_GATE_ENV_STRIP, STAGING_MIN_OPERATORS,
  releaseShaOf, stagingDeployArgs, stagingGateEnv, stagingSmokeEnv, stagingSmokeOrigin, uncleanDeploySources,
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

// Review of #224 (Medium): the gates are shared with the trusted dev deploy
// and read WORKER_CANDIDATE_SHA from the environment. Inherited from the
// operator's shell (say, the full SHA of ff0954d), it made the staging run
// skip owner coverage as for that historical build and PASS a wrong config.
describe('the gates run without the variables that steer them', () => {
  const FF = 'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1';

  it('stagingGateEnv strips every steering variable, case-insensitively, and keeps the rest', () => {
    const env = stagingGateEnv({
      PATH: '/bin', WORKER_CANDIDATE_SHA: FF, worker_candidate_sha: FF, Deploy_Profile: 'emergency',
      VITE_STATUS_GATEWAYS: 'x', VITE_TRUSTED_OWNERS: 'y', SMOKE_STAGING_ORIGIN: 'https://s.example',
    });
    expect(env).toEqual({ PATH: '/bin', SMOKE_STAGING_ORIGIN: 'https://s.example' });
  });

  it('every environment variable a gate (or a local module it imports) reads is stripped — a new lever cannot slip in', () => {
    const seen = new Set();
    const reads = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      expect(text, `${file}: bracket access to process.env hides the name`).not.toMatch(/process\.env\s*\[/);
      for (const m of text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) reads.add(m[1]);
      for (const m of text.matchAll(/from '(\.\.?\/[^']+\.mjs)'/g)) visit(join(dirname(file), m[1]));
    };
    for (const [script] of STAGING_CONFIG_GATES) visit(join(ROOT, script));
    expect(reads.size).toBeGreaterThan(0);
    for (const name of reads) expect(STAGING_GATE_ENV_STRIP, `${name} steers a staging gate`).toContain(name);
  });

  it('reproduction: a wrong staging config PASSES with an inherited historical SHA, and is REFUSED under stagingGateEnv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-gate-env-'));
    try {
      const A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
      const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'; // an unpinned staging address
      const toml = join(dir, 'wrangler.toml');
      writeFileSync(toml, `[vars]\nTRUSTED_OWNERS = "${A}"\n\n[env.staging.vars]\nTRUSTED_OWNERS = "${A},${C}"\n`);
      const gate = (env) => spawnSync(process.execPath, ['scripts/check-trusted-owners.mjs', '--repo-only', `--config=${toml}`], { cwd: ROOT, encoding: 'utf8', env });
      const inherited = { ...process.env, WORKER_CANDIDATE_SHA: FF };

      const raw = gate(inherited);
      expect(raw.status).toBe(0);
      expect(raw.stdout).toMatch(/SKIPPED/);

      const stripped = gate(stagingGateEnv(inherited));
      expect(stripped.status).toBe(1);
      expect(stripped.stderr).toMatch(/staging: TRUSTED_OWNERS adds C+ beyond the production set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(src).toMatch(/const gateEnv = stagingGateEnv\(process\.env\);/);
    expect(src).toMatch(/for \(const \[script, \.\.\.args\] of STAGING_CONFIG_GATES\) run\(process\.execPath, \[script, \.\.\.args\], \{ env: gateEnv \}\);/);
    expect(src).toMatch(/'--untracked-files=all', '--', \.\.\.DEPLOYED_SOURCE_ROOTS/);
    expect(src).toMatch(/uncleanDeploySources\(/);
    expect(src).toMatch(/\[WRANGLER_BIN, \.\.\.stagingDeployArgs\(sha\)\]/);
    // The clean check comes before the SHA is read, and both before the deploy.
    expect(src.indexOf('uncleanDeploySources(')).toBeLessThan(src.indexOf("releaseShaOf(git('rev-parse', 'HEAD'))"));
    expect(src.indexOf("releaseShaOf(git('rev-parse', 'HEAD'))")).toBeLessThan(src.indexOf('stagingDeployArgs(sha)'));
  });
});
