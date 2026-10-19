// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The operator floor the dev post-deploy smoke must assert — decided by the
 * CANDIDATE's own wrangler.toml (runbook reader release §6.9, owner decision
 * 2026-09-27: automatic).
 *
 * Why: the D10 guard books money only on a quorum of at least two
 * INDEPENDENT status operators. A reader whose operator map collapses to one
 * would be live and «healthy» yet never settle a payment — reservations pile
 * up until the window cap refuses every paid upload. `/health` reports
 * `statusOperatorsCount`; the smoke must read it.
 *
 * Why candidate-aware: a historical rollback candidate (394156d) predates the
 * operator map and reports no such field — demanding it there would take the
 * rollback away. The applicability rule is the spend-limits gate's own: a
 * config that carries the `SpendGuard` binding is a build that books money
 * on a quorum, so it must show the floor.
 *
 * CLI (deploy-worker.yml, over the candidate's config, from THIS checkout):
 *   node scripts/operators-floor.mjs --config=candidate/worker/wrangler.toml
 * prints `min_operators=2`, or `min_operators=` (empty — nothing asserted).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carriesSpendGuard, DEFAULT_CONFIG } from './check-spend-limits.mjs';
import { MIN_MONEY_OPERATORS } from './check-gateways-vs-worker.mjs';

/** Pure: the floor for a config's TOML text, or null when not applicable. */
export function operatorsFloorFor(toml) {
  return carriesSpendGuard(toml) ? MIN_MONEY_OPERATORS : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv.find(a => a.startsWith('--config='));
  const path = arg ? resolve(process.cwd(), arg.slice('--config='.length)) : DEFAULT_CONFIG;
  const floor = operatorsFloorFor(readFileSync(path, 'utf8'));
  console.log(`min_operators=${floor ?? ''}`);
}
