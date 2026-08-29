// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Deploy gate: the CLIENT and the WORKER must probe the SAME status pool.
 *
 * The dead formula is ONE formula for both halves (src/lib/status-quorum.ts),
 * and it is unanimity over «every configured origin». If the two halves are
 * configured differently, the same transaction can be `dead` for one and
 * `unavailable` for the other — and `dead` is what authorizes spending money.
 * So the lists are compared NORMALIZED (canonized + deduplicated with the same
 * parser both sides compile in), not textually: `https://a/` and `https://a`
 * are the same pool, while a duplicate entry is not a second witness.
 *
 * Also enforces MIN_STATUS_ORIGINS: with a single origin `dead` is unreachable
 * by construction, which would disable redrop rather than make it safe.
 *
 * Runs in BOTH deploy workflows and, in `--repo-only` mode, on the local
 * staging path — where both sides of the comparison are in the repository
 * (the pins here and worker/wrangler.toml), so no Environment variables are
 * needed at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOriginList } from './gateways-parse.mjs';
import { EXPECTED_STATUS_CSV, MIN_STATUS_ORIGINS } from './gateway-pins.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read `STATUS_GATEWAYS` out of a wrangler.toml block.
 *
 * A tiny targeted reader rather than a TOML parser: this script runs BEFORE
 * `npm ci` in the deploy workflows (that is the whole point of an early gate),
 * so it must stay dependency-free.
 *
 * `blockPrefix` is '' for the production `[vars]` table and 'env.staging.' for
 * the staging one — a named environment inherits NOTHING, so the two are
 * genuinely separate declarations and both are checked.
 */
export function readTomlVar(toml, blockPrefix, key) {
  const header = blockPrefix === '' ? '[vars]' : `[${blockPrefix}vars]`;
  const start = toml.indexOf(header);
  if (start < 0) return { error: `missing ${header} block in wrangler.toml` };
  // The block ends at the next table header at line start. Scoping matters: a
  // bare grep over the file would happily match a line from [env.staging.vars]
  // and report it as the production value.
  const rest = toml.slice(start + header.length);
  const nextTable = rest.search(/^\[/m);
  const block = nextTable < 0 ? rest : rest.slice(0, nextTable);
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block);
  if (!match) return { error: `missing ${key} in ${header}` };
  return { value: match[1] };
}

export function readWorkerStatusGateways(toml, blockPrefix = '') {
  return readTomlVar(toml, blockPrefix, 'STATUS_GATEWAYS');
}

/**
 * Every upload switch of ONE block must be exactly "false".
 *
 * This is what DEFINES an emergency release, and it is checked BEFORE the
 * deploy — discovering it afterwards would mean the unsafe build was already
 * activated. Block-scoped on purpose: the staging table legitimately carries
 * the same key names, so a file-wide grep would let a production "true" pass
 * because staging happened to say "false".
 */
export function checkUploadSwitchesOff(toml, blockPrefix = '') {
  const problems = [];
  for (const key of ['UPLOADS_ENABLED', 'V3_UPLOADS_ENABLED', 'V4_UPLOADS_ENABLED']) {
    const read = readTomlVar(toml, blockPrefix, key);
    if (read.error) { problems.push(read.error); continue; }
    if (read.value !== 'false') {
      problems.push(`${key} is "${read.value}", the emergency profile requires "false"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Pure core. `clientCsv` is the value the client build will compile in.
 * Returns `{ ok, problems }`; problems name variables and expectations but
 * never echo secrets (there are none here — gateway lists are public).
 */
export function checkGateways(clientCsv, toml, { repoOnly = false } = {}) {
  const problems = [];

  const pinned = parseOriginList(EXPECTED_STATUS_CSV);

  // In repo-only mode the client side IS the pin: there is no Environment to
  // read, and comparing the pin with itself would prove nothing — so the
  // meaningful check is worker-vs-pin, done below for both blocks.
  const client = repoOnly ? pinned : parseOriginList(clientCsv ?? '');

  if (!repoOnly) {
    if (client.length === 0) {
      problems.push('VITE_STATUS_GATEWAYS is missing, empty or fully unparseable');
      // Order-insensitive below: status probes run in parallel, so only the SET
      // is pinned. (The payload pool IS ordered — that pin lives in the deploy
      // config gate, where the order carries meaning.)
    } else if ([...client].sort().join(',') !== [...pinned].sort().join(',')) {
      problems.push(
        `VITE_STATUS_GATEWAYS does not match the repo-pinned set (${EXPECTED_STATUS_CSV})`,
      );
    }
  }

  if (client.length > 0 && client.length < MIN_STATUS_ORIGINS) {
    problems.push(
      `fewer than MIN_STATUS_ORIGINS (${MIN_STATUS_ORIGINS}) status origins: ` +
        'the dead verdict would be unreachable, silently disabling redrop',
    );
  }

  for (const [label, prefix] of [['production', ''], ['staging', 'env.staging.']]) {
    const read = readWorkerStatusGateways(toml, prefix);
    if (read.error) { problems.push(`${label}: ${read.error}`); continue; }
    const worker = parseOriginList(read.value);
    if (worker.length === 0) {
      problems.push(`${label}: STATUS_GATEWAYS is empty or fully unparseable`);
      continue;
    }
    if ([...worker].sort().join(',') !== [...pinned].sort().join(',')) {
      problems.push(
        `${label}: worker STATUS_GATEWAYS does not match the repo-pinned set (${EXPECTED_STATUS_CSV})`,
      );
      continue;
    }
    // Set equality, order-insensitive: status probes run in parallel, so the
    // order carries no meaning — but a MISSING or EXTRA origin does.
    if ([...worker].sort().join(',') !== [...client].sort().join(',')) {
      problems.push(
        `${label}: worker and client status pools differ — the dead formula ` +
          'would not mean the same thing on the two halves',
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('check-gateways-vs-worker.mjs')) {
  const repoOnly = process.argv.includes('--repo-only');
  // --config points at the wrangler.toml that will ACTUALLY be deployed. For a
  // candidate deploy that is candidate/worker/wrangler.toml, not the trusted
  // root's copy: checking the wrong file would let a historical rollback ship
  // an unapproved pool and only fail the post-deploy smoke.
  const configArg = process.argv.find(a => a.startsWith('--config='))?.split('=')[1];
  const toml = readFileSync(configArg ?? join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
  const { ok, problems } = checkGateways(process.env.VITE_STATUS_GATEWAYS, toml, { repoOnly });
  if (!ok) {
    console.error('✗ gateway config gate failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\n  The approved composition is pinned in scripts/gateway-pins.mjs' +
        '\n  (docs/ARWEAVE-RESILIENCE-PLAN.md §2.1). Changing it is a reviewed PR.',
    );
    process.exit(1);
  }
  console.log(
    `✓ gateway config gate: client and worker agree on the pinned status pool` +
      `${repoOnly ? ' (repo-only mode)' : ''}`,
  );
}
