// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * D10 spend-guard limits gate (PR-3b, PR-6): a worker that carries the
 * `SpendGuard` Durable Object must declare the three operator limits — in
 * `[vars]` AND in `[env.staging.vars]` (a named environment inherits nothing)
 * — as decimal Winston strings that make sense together. A missing or
 * malformed limit is not «no limit»: the worker answers
 * `503 spend_guard_unconfigured` on every paid path, so a deploy without them
 * would ship a worker that publishes nothing. Better refused here.
 *
 * Applicability is decided by the CANDIDATE's own wrangler.toml: a historical
 * candidate without the `SpendGuard` binding (e.g. the soak candidate
 * `394156d`) has nothing to check and passes — the floor gate, not this one,
 * decides whether such a rollback is allowed at all.
 *
 * What is NOT checked: `SPEND_ADMIN_SECRET`. Secrets never reach repo JS on
 * the deploy path (workflow invariant D); its presence is the operator's
 * step in docs/ROLLBACK.md «Spend guard».
 *
 * Dependency-free (node builtins + repo-local plain JS): runs before npm ci
 * on the deploy path, and inside the root vitest suite on every PR.
 *
 * Usage: node scripts/check-spend-limits.mjs [--config=worker/wrangler.toml]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTomlString } from './toml-scan.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CONFIG = join(ROOT, 'worker', 'wrangler.toml');

export const SPEND_LIMIT_VARS = ['WALLET_FLOOR_WINSTON', 'SPEND_WINDOW_CAP_WINSTON', 'MAX_TX_REWARD_WINSTON'];
const WINSTON_RE = /^\d{1,40}$/;
/** The two blocks the worker actually runs under. */
export const BLOCKS = [
  { prefix: '', label: '[vars]' },
  { prefix: 'env.staging.', label: '[env.staging.vars]' },
];

/** Does this config carry the guard at all? The DO binding is the marker. */
export function carriesSpendGuard(toml) {
  return /class_name\s*=\s*"SpendGuard"/.test(toml);
}

function readVar(toml, prefix, key) {
  const table = prefix === '' ? 'vars' : `${prefix}vars`;
  try { return readTomlString(toml, table, key); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Pure check over the TOML text. `{ ok, applicable, problems, limits }` —
 * `limits` per block are the parsed values (strings), for the log.
 */
export function checkSpendLimits(toml) {
  const applicable = carriesSpendGuard(toml);
  const result = { ok: true, applicable, problems: [], limits: {} };
  if (!applicable) return result;
  for (const { prefix, label } of BLOCKS) {
    const values = {};
    for (const name of SPEND_LIMIT_VARS) {
      const r = readVar(toml, prefix, name);
      if ('error' in r) { result.problems.push(`${label}: ${name}: ${r.error}`); continue; }
      if (!WINSTON_RE.test(r.value)) { result.problems.push(`${label}: ${name} must be a decimal Winston string (digits only), got ${JSON.stringify(r.value)}`); continue; }
      values[name] = r.value;
    }
    result.limits[label] = values;
    if (Object.keys(values).length !== SPEND_LIMIT_VARS.length) continue;
    const floor = BigInt(values.WALLET_FLOOR_WINSTON);
    const cap = BigInt(values.SPEND_WINDOW_CAP_WINSTON);
    const ceiling = BigInt(values.MAX_TX_REWARD_WINSTON);
    if (ceiling <= 0n) result.problems.push(`${label}: MAX_TX_REWARD_WINSTON must be > 0 (a zero ceiling refuses every quote)`);
    if (cap <= 0n) result.problems.push(`${label}: SPEND_WINDOW_CAP_WINSTON must be > 0`);
    if (ceiling > cap) result.problems.push(`${label}: MAX_TX_REWARD_WINSTON (${ceiling}) exceeds SPEND_WINDOW_CAP_WINSTON (${cap}) — no single transaction could ever fit the window`);
    void floor; // ≥ 0 by the digits rule; a zero floor is legal (staging)
  }
  result.ok = result.problems.length === 0;
  return result;
}

export function checkSpendLimitsFile(path = DEFAULT_CONFIG) {
  return checkSpendLimits(readFileSync(path, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv.find(a => a.startsWith('--config='));
  const path = arg ? join(process.cwd(), arg.slice('--config='.length)) : DEFAULT_CONFIG;
  const r = checkSpendLimitsFile(path);
  if (!r.applicable) {
    console.log('✓ spend limits: not applicable — this config carries no SpendGuard binding');
    process.exit(0);
  }
  if (!r.ok) {
    console.error('✗ spend limits gate failed:');
    for (const p of r.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const [label, values] of Object.entries(r.limits)) {
    console.log(`✓ spend limits ${label}: floor=${values.WALLET_FLOOR_WINSTON} cap=${values.SPEND_WINDOW_CAP_WINSTON} maxTx=${values.MAX_TX_REWARD_WINSTON} (Winston)`);
  }
  console.log('  SPEND_ADMIN_SECRET is a secret and is NOT checked here — see docs/ROLLBACK.md «Spend guard»');
}
