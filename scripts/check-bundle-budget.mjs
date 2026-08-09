#!/usr/bin/env node
/**
 * Bundle-size budget gate (CI, after `npm run build`).
 *
 * react-markdown is the first dependency in this app's history that can
 * silently balloon through transitive remark/mdast plugins — this fails the
 * build when the summed GZIPPED size of dist JS crosses the budget, instead
 * of letting an offline-first PWA precache quietly grow.
 *
 * Baseline at introduction (v3 branch): ~170 KB gz total JS.
 * Budget = baseline + headroom; raise it CONSCIOUSLY in this file when a
 * deliberate dependency lands, never as a green-build side effect.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_GZ_BYTES = 190_000;

const assetsDir = join(process.cwd(), 'dist', 'assets');
if (!existsSync(assetsDir)) {
  console.error('check-bundle-budget: dist/assets not found — run `npm run build` first');
  process.exit(2);
}

let total = 0;
const rows = [];
for (const name of readdirSync(assetsDir)) {
  if (!name.endsWith('.js')) continue;
  const gz = gzipSync(readFileSync(join(assetsDir, name)), { level: 9 }).length;
  total += gz;
  rows.push(`  ${name}: ${(gz / 1024).toFixed(1)} KB gz`);
}

console.log('JS bundle (gzipped):');
console.log(rows.join('\n'));
console.log(`  TOTAL: ${(total / 1024).toFixed(1)} KB gz (budget ${(BUDGET_GZ_BYTES / 1024).toFixed(0)} KB)`);

if (total > BUDGET_GZ_BYTES) {
  console.error(
    `\nBUNDLE BUDGET EXCEEDED: ${total} > ${BUDGET_GZ_BYTES} bytes gz.\n` +
    'If the growth is deliberate, raise BUDGET_GZ_BYTES in scripts/check-bundle-budget.mjs ' +
    'in the same commit and say why.',
  );
  process.exit(1);
}
console.log('Bundle budget OK');
