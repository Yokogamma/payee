#!/usr/bin/env node
/**
 * The staging deploy path, with the gates a bare `wrangler deploy` skips.
 *
 * Production goes through the trusted workflow and a candidate SHA; `npm run
 * deploy` refuses for that reason. Staging still runs from an operator's
 * machine, so the checks that workflow performs have to exist here too —
 * otherwise "staging is like production" is a claim rather than a fact.
 *
 * In order:
 *   1. config gates in --repo-only mode (both sides live in the repository, so
 *      no Environment variables are needed);
 *   2. refuse a DIRTY working tree — otherwise the deployed bytes are not the
 *      commit anyone can point at afterwards;
 *   3. deploy, capturing wrangler's structured NDJSON output;
 *   4. verify the deploy landed on the expected worker and read the ACTIVATED
 *      version id from that output;
 *   5. optionally smoke the live staging worker (SMOKE_STAGING_ORIGIN).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWranglerOutput } from '../../scripts/read-wrangler-version.mjs';

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(WORKER_DIR);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. Config gates — the same code the deploy workflow runs.
run(process.execPath, ['scripts/check-gateways-vs-worker.mjs', '--repo-only']);

// 2. A dirty tree means the artifact has no reviewable identity.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty !== '') {
  console.error('✗ refusing to deploy from a DIRTY working tree:');
  console.error(dirty.split('\n').map(l => `    ${l}`).join('\n'));
  console.error('  Commit or stash first — otherwise what ran is not any commit.');
  process.exit(1);
}

// 3. Deploy, capturing the structured output.
const outDir = mkdtempSync(join(tmpdir(), 'wrangler-out-'));
const outFile = join(outDir, 'output.ndjson');
try {
  run('npx', ['wrangler', 'deploy', '--env', 'staging'], {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile },
  });

  // 4. Identity: a deploy that landed elsewhere is exactly what this catches.
  const parsed = parseWranglerOutput(readFileSync(outFile, 'utf8'));
  if (parsed.error) {
    console.error(`✗ ${parsed.error}`);
    process.exit(1);
  }
  console.log(`✓ deployed version ${parsed.versionId}`);

  // 5. Smoke, when there is somewhere to smoke.
  if (process.env.SMOKE_STAGING_ORIGIN) {
    run(process.execPath, ['worker/scripts/smoke-gateways.mjs', '--staging', '--profile=normal'], {
      env: { ...process.env, EXPECT_WORKER_VERSION_ID: parsed.versionId },
    });
  } else {
    console.log(
      'note: SMOKE_STAGING_ORIGIN is unset, so the live smoke was skipped.\n' +
      '      Staging has no pinned origin until [env.staging] is provisioned.',
    );
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
