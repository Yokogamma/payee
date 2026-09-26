#!/usr/bin/env node
/**
 * The staging deploy path, with the gates a bare `wrangler deploy` skips.
 *
 * Production goes through the trusted workflow and a candidate SHA; `npm run
 * deploy` refuses for that reason. Staging still runs from an operator's
 * machine, so the checks that workflow performs have to exist here too —
 * otherwise "staging is like production" is a claim rather than a fact. Every
 * step below is MANDATORY (runbook reader release M6); the rules live in
 * staging-deploy-rules.mjs, tested.
 *
 * In order:
 *   0. require SMOKE_STAGING_ORIGIN (a bare https origin) — the live smoke is
 *      not optional, so it is checked before anything is deployed;
 *   1. config gates in --repo-only mode (both sides live in the repository):
 *      status pool, per-contour trusted owners, spend limits;
 *   1b. the pinned Cloudflare account;
 *   2. refuse UNCLEAN deployed sources — tracked changes anywhere, untracked
 *      files under worker/ and src/ (what the bundle is built from) —
 *      otherwise the deployed bytes are not the commit anyone can point at;
 *   3. deploy with `--var RELEASE_SHA:<HEAD of that clean tree>`, capturing
 *      wrangler's structured NDJSON output;
 *   4. verify the deploy landed on the expected worker and read the ACTIVATED
 *      version id from that output;
 *   5. smoke the live staging worker: profile, SHA, activated version id,
 *      and at least two independent status operators.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWranglerOutput } from '../../scripts/read-wrangler-version.mjs';
import { ACCOUNT_ID, WORKER_NAME } from './smoke-target.mjs';
import {
  DEPLOYED_SOURCE_ROOTS, STAGING_CONFIG_GATES,
  releaseShaOf, stagingDeployArgs, stagingSmokeEnv, stagingSmokeOrigin, uncleanDeploySources,
} from './staging-deploy-rules.mjs';

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(WORKER_DIR);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** The pinned CLI from the lockfile, not whatever npx would fetch. */
const WRANGLER_BIN = 'node_modules/wrangler/bin/wrangler.js';

// 0. The smoke target, before anything else: a deploy that cannot be smoked
// is not a rehearsal.
const smoke = stagingSmokeOrigin(process.env.SMOKE_STAGING_ORIGIN);
if (!smoke.ok) {
  console.error(`✗ ${smoke.reason}`);
  process.exit(1);
}

// 1. Config gates — the same code the deploy workflow and CI run.
for (const [script, ...args] of STAGING_CONFIG_GATES) run(process.execPath, [script, ...args]);

// 1b. The account is pinned: credentials pointing somewhere else are exactly
// what an identity check exists to catch, and whoami is where that shows up.
const whoami = spawnSync(process.execPath, [WRANGLER_BIN, 'whoami'],
  { cwd: WORKER_DIR, encoding: 'utf8' });
if (whoami.status !== 0 || !String(whoami.stdout).includes(ACCOUNT_ID)) {
  console.error(`✗ wrangler is not authenticated against the pinned account ${ACCOUNT_ID}`);
  console.error('  Check which account the token belongs to before deploying.');
  process.exit(1);
}

// 2. Unclean deployed sources mean the artifact has no reviewable identity.
// Tracked changes anywhere; untracked files only under the bundle's roots —
// an ignored local file (editor settings, a build dir) is not part of the
// artifact and must not block a deploy.
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const unclean = uncleanDeploySources(
  git('status', '--porcelain', '--untracked-files=no'),
  git('status', '--porcelain', '--untracked-files=all', '--', ...DEPLOYED_SOURCE_ROOTS),
);
if (unclean.length > 0) {
  console.error('✗ refusing to deploy from UNCLEAN sources:');
  console.error(unclean.map(l => `    ${l}`).join('\n'));
  console.error('  Commit, stash or remove them first — otherwise what ran is not any commit,');
  console.error('  and the RELEASE_SHA staging reports would name bytes it does not run.');
  process.exit(1);
}
const sha = releaseShaOf(git('rev-parse', 'HEAD'));
if (sha === null) {
  console.error('✗ HEAD is not a full commit SHA — refusing to deploy without a release identity');
  process.exit(1);
}

// 3. Deploy, capturing the structured output.
const outDir = mkdtempSync(join(tmpdir(), 'wrangler-out-'));
const outFile = join(outDir, 'output.ndjson');
try {
  // The LOCAL wrangler from the lockfile, never an auto-installed one: the
  // tool that talks to Cloudflare should be the pinned, Dependabot-tracked one.
  run(process.execPath, [WRANGLER_BIN, ...stagingDeployArgs(sha)], {
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
  console.log(`✓ deployed version ${parsed.versionId} of ${sha} (clean sources)`);

  // 5. The live smoke — mandatory.
  run(process.execPath, ['worker/scripts/smoke-gateways.mjs', '--staging', '--profile=normal'], {
    env: { ...stagingSmokeEnv(process.env, { sha, versionId: parsed.versionId }), SMOKE_STAGING_ORIGIN: smoke.origin },
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
