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
 * ── RAISED 200_000 → 307_200 (300 KB) — owner's decision, 2026-08-29 ───────
 *
 * A tripwire set a few kilobytes above the current size stops being a
 * tripwire and becomes a toll booth: two legitimate tracks in a row spent
 * their whole headroom, and each time the ceiling had to be argued about
 * before the work could land. That argument was not buying anything — nobody
 * was ever going to answer «this feature is not worth 3 KB» — so the ceiling
 * moves far enough out to catch what it was written for: a DEPENDENCY that
 * balloons, not a feature that grows.
 *
 * Measured on the day of the decision, same fake-owner production build:
 *   main                          191.1 KB gz
 *   main + PR-3a (#130)           194.2 KB gz   (+3.1 — multi-gateway + D9)
 *   backup stack tip              199.9 KB gz   (+8.8 — container, viewer, UI)
 *   both together, projected      ~203  KB gz
 *
 * So ~97 KB of the new ceiling is genuinely spare. That is deliberate: at
 * this distance a red build means something went wrong, which is the only
 * state in which anyone reads the message.
 *
 * What this does NOT excuse: the gate measures GZIPPED JS ONLY, and JS is
 * about a third of what a user actually downloads (24 precache entries,
 * ~574 KB gz — fonts are the larger half; `scripts/report-precache.mjs`).
 * A ceiling this generous therefore watches an even smaller share of the
 * real cost, and the precache report — not this number — is what to look at
 * before adding a font or an asset.
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
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_GZ_BYTES = 307_200;

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
