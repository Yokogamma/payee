// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Deploy gate: the WORKER's trusted-owner set must contain every address this
 * project has ever posted under, and must agree with the CLIENT's (D2).
 *
 * ── What breaks without it ───────────────────────────────────────────
 *
 * D9 lets the worker bind an existing `txId` to a publication fingerprint only
 * after authenticating the publication, and `address ∈ TRUSTED_OWNERS` is one
 * of its steps. A set that is missing an address does not fail loudly: it
 * re-classifies the project's OWN older publications as unverifiable, and the
 * upload path then answers a conflict or a 503 for records that are perfectly
 * healthy. Narrowing the set is therefore a silent, data-visible regression,
 * which is exactly the shape of failure a gate has to catch before a deploy
 * rather than after.
 *
 * ── Three separate questions, deliberately not merged ────────────────
 *
 *  1. MONOTONICITY — does the repo registry still contain everything it must?
 *     (`owner-pins.mjs`: `HISTORICAL_OWNERS ⊇ NEVER_REMOVE`.) This one needs no
 *     configuration at all and runs in CI on every pull request.
 *  2. WORKER COVERAGE — does each `TRUSTED_OWNERS` table in wrangler.toml
 *     contain the whole registry? Checked per BLOCK, because a named
 *     environment inherits NOTHING: a correct production table says nothing
 *     about staging, and a file-wide search would let one cover for the other.
 *  3. CLIENT/WORKER AGREEMENT — the two halves must trust the same set. Both
 *     verify the same on-chain history, and a divergence means one half
 *     accepts what the other refuses.
 *  4. CONTOUR SEPARATION — staging may run on its OWN wallet (runbook P11)
 *     without that test wallet reaching the shipped client. So agreement is
 *     per contour: production must EQUAL the client; staging must equal the
 *     client once its own wallets (`STAGING_ONLY_OWNERS`, pinned in
 *     owner-pins.mjs, append-only) are set aside, must carry EVERY one of
 *     them and may add nothing else. A staging-only wallet in production, in
 *     the client or in the historical registry is refused outright — adding
 *     it there «to make the gate pass» is exactly the move this rule exists
 *     to stop.
 *
 *     `--contour=dev` (the dev deploy job, which ships `[vars]` and nothing
 *     else) waives ONE staging rule: that the candidate's staging table carry
 *     every pinned staging wallet. A historical rollback candidate predates
 *     the pin, and refusing it for a table that deploy does not ship would
 *     take away the rollback. The staging table of the repo is still held to
 *     it on every pull request (CI), before Pages, and wherever staging ships.
 *
 * Containment, never equality: after a rotation the deployed sets legitimately
 * carry addresses the registry has not caught up with yet, and demanding
 * equality would either block a correct deploy or push someone to delete an old
 * owner — the precise move this file exists to prevent.
 *
 * Runs in both deploy workflows and, in `--repo-only` mode, in CI, where both
 * sides of question 2 are in the repository and no Environment is needed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrustedOwners } from './trusted-owners-parse.mjs';
import { readTomlString } from './toml-scan.mjs';
import {
  HISTORICAL_OWNERS,
  NEVER_REMOVE,
  HISTORICAL_OWNERS_CSV,
  STAGING_ONLY_OWNERS,
  STAGING_NEVER_REMOVE,
} from './owner-pins.mjs';
import { candidateLacksVar } from './historical-candidates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read `TRUSTED_OWNERS` out of one wrangler.toml table.
 *
 * A SCANNER, not `indexOf`: a decoy `[vars]` inside another table's multi-line
 * string would be read while wrangler honours the real one (scripts/toml-scan.mjs).
 */
export function readWorkerOwners(toml, blockPrefix = '') {
  const table = blockPrefix === '' ? 'vars' : `${blockPrefix}vars`;
  try {
    return readTomlString(toml, table, 'TRUSTED_OWNERS');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Addresses of `required` that `have` does not contain. */
function missingFrom(have, required) {
  const present = new Set(have);
  return required.filter((a) => !present.has(a));
}

/**
 * Pure core. `clientCsv` is the value the client build will compile in
 * (ignored in repo-only mode, where there is no Environment to read).
 *
 * Returns `{ ok, problems }`. Owner addresses are PUBLIC — they are on chain
 * and compiled into the client bundle — so naming them in a message leaks
 * nothing and is what makes a refusal diagnosable.
 *
 * `stagingOnly` / `stagingNeverRemove` default to the pins and exist so tests
 * can exercise a provisioned staging wallet before one is pinned. `contour`
 * is `'dev'` only for the dev deploy job (see question 4 above); anything
 * else keeps every rule.
 */
export function checkTrustedOwners(
  clientCsv,
  toml,
  {
    repoOnly = false,
    candidate = null,
    contour = null,
    stagingOnly = STAGING_ONLY_OWNERS,
    stagingNeverRemove = STAGING_NEVER_REMOVE,
  } = {},
) {
  const problems = [];
  const stagingOnlySet = new Set(stagingOnly);

  // ── 1. The registry itself ──
  const registryGaps = missingFrom(HISTORICAL_OWNERS, NEVER_REMOVE);
  if (registryGaps.length > 0) {
    problems.push(
      `owner-pins.mjs: HISTORICAL_OWNERS no longer contains ${registryGaps.join(', ')}. ` +
        'The registry is APPEND-ONLY: transactions signed by a removed address stay on ' +
        'chain forever, and dropping it makes them permanently unverifiable.',
    );
  }
  if (HISTORICAL_OWNERS.length === 0) {
    problems.push('owner-pins.mjs: HISTORICAL_OWNERS is empty — D9 would have nothing to check against');
  }
  const registeredStaging = HISTORICAL_OWNERS.filter((a) => stagingOnlySet.has(a));
  if (registeredStaging.length > 0) {
    problems.push(
      `owner-pins.mjs: ${registeredStaging.join(', ')} is both a staging-only wallet and a HISTORICAL ` +
        'owner. The registry is what the shipped client must contain, so this would force the ' +
        'staging wallet into restore. A staging wallet belongs in STAGING_ONLY_OWNERS alone.',
    );
  }
  const stagingGaps = missingFrom(stagingOnly, stagingNeverRemove);
  if (stagingGaps.length > 0) {
    problems.push(
      `owner-pins.mjs: STAGING_ONLY_OWNERS no longer contains ${stagingGaps.join(', ')}. It is ` +
        'APPEND-ONLY: staging publications signed by a removed wallet stop authenticating, and ' +
        'dropping it from the list would also lift the ban on it reaching the client.',
    );
  }

  // ── 2. Worker coverage, per block ──
  //
  // Skipped for ONE registered historical candidate and nothing else: a build
  // that predates D9 has no TRUSTED_OWNERS and no code that would read it, so
  // there is nothing to cover. The registry (step 1) is still checked — it is
  // the repo's, not the candidate's. Keyed by full SHA in
  // scripts/historical-candidates.mjs; nothing here can widen it.
  const skipWorker = candidateLacksVar(candidate, 'TRUSTED_OWNERS');
  const workerSets = new Map();
  for (const [label, prefix] of skipWorker ? [] : [['production', ''], ['staging', 'env.staging.']]) {
    const read = readWorkerOwners(toml, prefix);
    if (read.error) {
      // A MISSING key is the likeliest way this gate fires, and the bare
      // scanner message ("missing TRUSTED_OWNERS in [...]") does not say why
      // the staging table needs its own copy. Everything else — a duplicate
      // table, a non-string value — is already self-explaining.
      problems.push(
        /^missing TRUSTED_OWNERS\b/.test(read.error)
          ? `${label}: TRUSTED_OWNERS is not declared in this table. A named environment ` +
            'inherits NOTHING, so it must be spelled out here; without it the worker ' +
            'refuses /upload fail-closed.'
          : `${label}: ${read.error}`,
      );
      continue;
    }
    let owners;
    try {
      owners = parseTrustedOwners(read.value);
    } catch (e) {
      problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (owners.length === 0) {
      problems.push(`${label}: TRUSTED_OWNERS is empty — D9 cannot authenticate any publication`);
      continue;
    }
    const gaps = missingFrom(owners, HISTORICAL_OWNERS);
    if (gaps.length > 0) {
      problems.push(
        `${label}: worker TRUSTED_OWNERS is missing ${gaps.join(', ')} from the repo registry ` +
          `(${HISTORICAL_OWNERS_CSV}). Publications signed by those wallets would stop ` +
          'authenticating, and healthy records would answer a conflict or a 503.',
      );
      continue;
    }
    workerSets.set(label, owners);
  }

  // ── 2b. Contour separation (question 4 above) — both modes: every side of
  // it is in the repository, so CI refuses it before any deploy does ──
  const production = workerSets.get('production');
  const staging = workerSets.get('staging');
  if (production) {
    const leaked = production.filter((a) => stagingOnlySet.has(a));
    if (leaked.length > 0) {
      problems.push(
        `production: TRUSTED_OWNERS contains the staging-only wallet ${leaked.join(', ')}. The dev ` +
          'contour must equal the shipped client, so this would put a test wallet into restore.',
      );
    }
  }
  if (production && staging) {
    const prodSet = new Set(production);
    const stagingSet = new Set(staging);
    const unpinned = staging.filter((a) => !prodSet.has(a) && !stagingOnlySet.has(a));
    if (unpinned.length > 0) {
      problems.push(
        `staging: TRUSTED_OWNERS adds ${unpinned.join(', ')} beyond the production set. Staging may ` +
          'add only its own wallet, pinned in STAGING_ONLY_OWNERS (scripts/owner-pins.mjs).',
      );
    }
    const dropped = production.filter((a) => !stagingSet.has(a));
    if (dropped.length > 0) {
      problems.push(
        `staging: TRUSTED_OWNERS lacks ${dropped.join(', ')}, which production trusts. Staging is the ` +
          'production set plus its own pinned wallet(s).',
      );
    }
    // Waived for the dev deploy job only — it does not ship this table
    // (question 4 above).
    if (contour !== 'dev') {
      const lost = stagingOnly.filter((a) => !stagingSet.has(a));
      if (lost.length > 0) {
        problems.push(
          `staging: TRUSTED_OWNERS is missing the pinned staging wallet ${lost.join(', ')}. Every ` +
            'wallet in STAGING_ONLY_OWNERS stays trusted by staging — publications it signed ' +
            'would stop authenticating (D9). Rotation APPENDS; the old address stays.',
        );
      }
    }
  }

  // ── 3. Client/worker agreement ──
  if (!repoOnly) {
    let client;
    try {
      client = parseTrustedOwners(clientCsv ?? '');
    } catch (e) {
      problems.push(`VITE_TRUSTED_OWNERS: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, problems };
    }
    if (client.length === 0) {
      problems.push('VITE_TRUSTED_OWNERS is missing or empty — the client would disable restore fail-closed');
      return { ok: false, problems };
    }
    const clientGaps = missingFrom(client, HISTORICAL_OWNERS);
    if (clientGaps.length > 0) {
      problems.push(
        `VITE_TRUSTED_OWNERS is missing ${clientGaps.join(', ')} from the repo registry ` +
          `(${HISTORICAL_OWNERS_CSV}) — notes posted under those wallets would not restore.`,
      );
    }
    const clientStaging = client.filter((a) => stagingOnlySet.has(a));
    if (clientStaging.length > 0) {
      problems.push(
        `VITE_TRUSTED_OWNERS contains the staging-only wallet ${clientStaging.join(', ')} — the ` +
          'shipped client must never trust the staging wallet.',
      );
    }
    const sortedClient = [...new Set(client)].sort().join(',');
    for (const [label, owners] of workerSets) {
      // Staging is compared with its own wallets set aside (rule 4); what
      // remains must be exactly the client's set, like production.
      const compared = label === 'staging' ? owners.filter((a) => !stagingOnlySet.has(a)) : owners;
      const sortedWorker = [...new Set(compared)].sort().join(',');
      if (sortedWorker !== sortedClient) {
        problems.push(
          `${label}: worker and client trusted-owner sets differ (worker` +
            `${label === 'staging' && compared.length !== owners.length ? ' without its staging-only wallet' : ''}: ` +
            `${sortedWorker}; client: ${sortedClient}). Both halves authenticate the SAME on-chain ` +
            'history, so a divergence means one accepts a publication the other refuses.',
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, skippedWorkerCoverage: skipWorker };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('check-trusted-owners.mjs')) {
  const repoOnly = process.argv.includes('--repo-only');
  const contourArg = process.argv.find((a) => a.startsWith('--contour='))?.slice('--contour='.length) ?? null;
  if (contourArg !== null && contourArg !== 'dev') {
    console.error(`✗ check-trusted-owners: unknown --contour=${contourArg} (only "dev" is defined)`);
    process.exit(1);
  }
  // --config points at the wrangler.toml that will ACTUALLY be deployed. For a
  // candidate deploy that is candidate/worker/wrangler.toml, not the trusted
  // checkout's own copy.
  const configArg = process.argv
    .find((a) => a.startsWith('--config='))
    ?.slice('--config='.length);
  const toml = readFileSync(configArg ?? join(ROOT, 'worker', 'wrangler.toml'), 'utf8');

  const candidate = process.env.WORKER_CANDIDATE_SHA ?? null;
  const { ok, problems, skippedWorkerCoverage } = checkTrustedOwners(process.env.VITE_TRUSTED_OWNERS, toml, { repoOnly, candidate, contour: contourArg });
  if (!ok) {
    console.error('✗ check-trusted-owners:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    (skippedWorkerCoverage
      ? `✓ check-trusted-owners: worker coverage SKIPPED for historical candidate ${candidate.slice(0, 7)} (no D9 in that build); registry itself verified `
      : `✓ check-trusted-owners: worker tables cover the repo registry `) +
      `(${HISTORICAL_OWNERS.length} owner(s))${repoOnly ? '' : ' and agree with the client'}`,
  );
}
