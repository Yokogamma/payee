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
import { HISTORICAL_OWNERS, NEVER_REMOVE, HISTORICAL_OWNERS_CSV } from './owner-pins.mjs';

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
 */
export function checkTrustedOwners(clientCsv, toml, { repoOnly = false } = {}) {
  const problems = [];

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

  // ── 2. Worker coverage, per block ──
  const workerSets = new Map();
  for (const [label, prefix] of [['production', ''], ['staging', 'env.staging.']]) {
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
    for (const [label, owners] of workerSets) {
      const sortedWorker = [...owners].sort().join(',');
      const sortedClient = [...client].sort().join(',');
      if (sortedWorker !== sortedClient) {
        problems.push(
          `${label}: worker and client trusted-owner sets differ (worker: ${sortedWorker}; ` +
            `client: ${sortedClient}). Both halves authenticate the SAME on-chain history, ` +
            'so a divergence means one accepts a publication the other refuses.',
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('check-trusted-owners.mjs')) {
  const repoOnly = process.argv.includes('--repo-only');
  // --config points at the wrangler.toml that will ACTUALLY be deployed. For a
  // candidate deploy that is candidate/worker/wrangler.toml, not the trusted
  // checkout's own copy.
  const configArg = process.argv
    .find((a) => a.startsWith('--config='))
    ?.slice('--config='.length);
  const toml = readFileSync(configArg ?? join(ROOT, 'worker', 'wrangler.toml'), 'utf8');

  const { ok, problems } = checkTrustedOwners(process.env.VITE_TRUSTED_OWNERS, toml, { repoOnly });
  if (!ok) {
    console.error('✗ check-trusted-owners:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ check-trusted-owners: worker tables cover the repo registry ` +
      `(${HISTORICAL_OWNERS.length} owner(s))${repoOnly ? '' : ' and agree with the client'}`,
  );
}
