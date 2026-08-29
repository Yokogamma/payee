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
import { readTomlString } from './toml-scan.mjs';
import { EXPECTED_STATUS_CSV, EXPECTED_PAYLOAD_CSV, MIN_STATUS_ORIGINS } from './gateway-pins.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read one key out of a wrangler.toml table.
 *
 * `blockPrefix` is '' for the production `[vars]` table and 'env.staging.' for
 * the staging one — a named environment inherits NOTHING, so the two are
 * genuinely separate declarations and both are checked.
 */
export function readTomlVar(toml, blockPrefix, key) {
  // A SCANNER, not indexOf: `toml.indexOf('[vars]')` is exploitable — a decoy
  // `[vars]` inside a multi-line string of another table would be read while
  // wrangler honours the real one. See scripts/toml-scan.mjs.
  const table = blockPrefix === '' ? 'vars' : `${blockPrefix}vars`;
  try {
    return readTomlString(toml, table, key);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function readWorkerStatusGateways(toml, blockPrefix = '') {
  return readTomlVar(toml, blockPrefix, 'STATUS_GATEWAYS');
}

export function readWorkerPayloadGateways(toml, blockPrefix = '') {
  return readTomlVar(toml, blockPrefix, 'PAYLOAD_GATEWAYS');
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

  // ── The PAYLOAD pool (D2/D9) ──
  //
  // A separate pin from the status pool, and compared with its ORDER: the pool
  // is tried in sequence, and the sequence is the approved one (§2.1). Order is
  // meaningless for status probes — they run in parallel — which is why the
  // comparison above is set-only and this one is not.
  //
  // Checked per BLOCK, like everything else here: a named environment inherits
  // nothing, so a correct production table says nothing about staging.
  const pinnedPayload = parseOriginList(EXPECTED_PAYLOAD_CSV);
  for (const [label, prefix] of [['production', ''], ['staging', 'env.staging.']]) {
    const read = readWorkerPayloadGateways(toml, prefix);
    if (read.error) { problems.push(`${label}: ${read.error}`); continue; }
    const worker = parseOriginList(read.value);
    if (worker.length === 0) {
      problems.push(`${label}: PAYLOAD_GATEWAYS is empty or fully unparseable`);
      continue;
    }
    if (worker.join(',') !== pinnedPayload.join(',')) {
      problems.push(
        `${label}: worker PAYLOAD_GATEWAYS does not match the repo-pinned list in order ` +
          `(${EXPECTED_PAYLOAD_CSV}). The order is part of the pin: the pool is tried in ` +
          'sequence, and a reordered list silently changes which gateway is asked first.',
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
    `✓ gateway config gate: client and worker agree on the pinned status pool, ` +
      `and the worker's payload pool matches the pin in order` +
      `${repoOnly ? ' (repo-only mode)' : ''}`,
  );
}
