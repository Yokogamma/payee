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
 *
 * ── RAISED 190_000 → 200_000 for the «Архив» redesign ──────────────────────
 *
 * Measured, both with the same fake-owner production build:
 *   origin/main            183.4 KB gz
 *   feat/archive-redesign  185.4 KB gz     (+2.0 KB)
 *
 * The old ceiling was 185.5 KB, so the branch landed with about a hundred
 * bytes of room — which is not a budget, it is a tripwire on the next commit
 * whatever that commit does.
 *
 * WHERE THE 2 KB WENT, and why none of it is a dependency:
 *   - src/components/icons.tsx — twenty-odd drawn icons. The redesign removes
 *     every emoji from the interface (scripts/check-no-emoji-glyphs.test.mjs
 *     enforces it), and a drawn icon is SVG path data in the bundle where a
 *     glyph was one character costing nothing. This is the trade the design
 *     asked for: platform emoji render as three different pictures on three
 *     operating systems.
 *   - src/components/CardMenu.tsx — one shared menu replacing two ad-hoc ones,
 *     plus the WAI-ARIA keyboard model that neither of them had.
 *   - src/lib/format-date.ts — moved out of a screen component, not new code.
 *
 * NO JAVASCRIPT DEPENDENCY WAS ADDED — and to be exact, package.json did change:
 * @fontsource/manrope and @fontsource/jetbrains-mono were replaced by
 * @fontsource-variable/literata and @fontsource/pt-mono. Those ship CSS and
 * woff2, not JavaScript, so the JS dependency graph this gate measures is the
 * same as on main; the font payload is a separate number and lives in
 * scripts/report-precache.mjs.
 *
 * The new ceiling restores roughly 10 KB of headroom, which is what the gate
 * had before this work started.
 *
 * ── RAISED 200_000 → 210_000 for the backup UI block (step 12b) ────────────
 *
 * Measured, both with the same fake-owner production build:
 *   feat/backup-store-actions (12a)  193.4 KB gz
 *   feat/backup-ui-block      (12b)  197.9 KB gz     (+4.5 KB)
 *
 * NO DEPENDENCY WAS ADDED. The 4.5 KB is source, and most of it is prose:
 *   - src/lib/backup-ui.ts — the sentences §7 specifies, as data. Russian text
 *     costs two UTF-8 bytes per character and compresses worse than the code
 *     around it, so a screen's worth of copy is measured in kilobytes rather
 *     than in hundreds of bytes. It is also the least compressible thing here
 *     and the least optional: the plan writes these sentences out because the
 *     honest one and the comfortable one differ.
 *   - src/screens/BackupSettings.tsx — the block itself.
 *   - src/lib/viewer-delivery.ts, src/lib/download.ts — small.
 *
 * The backup MACHINERY was already in the bundle before this branch: the store
 * imports the adapter, and the adapter pulls the container, the classifier,
 * the plan and the merge rules with it. This branch adds the interface, not
 * the engine.
 *
 * Worth stating plainly, because it is a real cost with no user today: both
 * release flags ship FALSE, so in release 1 this block renders nothing and the
 * bytes are inert. That is what D16 asks for — the gate lives in the actions,
 * the code ships with them — and the alternative (a build that omits the block
 * entirely) would mean the release that flips the flags is not the release
 * that was tested. Step 13 re-measures precache and near-cap and is where this
 * ceiling gets its final look.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_GZ_BYTES = 210_000;

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
