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
import { ACCOUNT_ID, WORKER_NAME } from './smoke-target.mjs';

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(WORKER_DIR);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** The pinned CLI from the lockfile, not whatever npx would fetch. */
const WRANGLER_BIN = 'node_modules/wrangler/bin/wrangler.js';

// 1. Config gates — the same code the deploy workflow runs.
run(process.execPath, ['scripts/check-gateways-vs-worker.mjs', '--repo-only']);

// 1b. The account is pinned: credentials pointing somewhere else are exactly
// what an identity check exists to catch, and whoami is where that shows up.
const whoami = spawnSync(process.execPath, [WRANGLER_BIN, 'whoami'],
  { cwd: WORKER_DIR, encoding: 'utf8' });
if (whoami.status !== 0 || !String(whoami.stdout).includes(ACCOUNT_ID)) {
  console.error(`✗ wrangler is not authenticated against the pinned account ${ACCOUNT_ID}`);
  console.error('  Check which account the token belongs to before deploying.');
  process.exit(1);
}

// 2. A dirty tree means the artifact has no reviewable identity.
// TRACKED files only: an ignored local file (editor settings, a build dir)
// is not part of the artifact and must not block a deploy.
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
  { cwd: ROOT, encoding: 'utf8' }).trim();
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
  // The LOCAL wrangler from the lockfile, never an auto-installed one: the
  // tool that talks to Cloudflare should be the pinned, Dependabot-tracked one.
  run(process.execPath, [WRANGLER_BIN, 'deploy', '--env', 'staging'], {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile },
  });

  // 4. Identity: a deploy that landed elsewhere is exactly what this catches.
  // Staging lands on a DIFFERENT worker name — expecting the production one
  // would report a failure for a perfectly correct deploy.
  const parsed = parseWranglerOutput(readFileSync(outFile, 'utf8'), WORKER_NAME + '-staging');
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
