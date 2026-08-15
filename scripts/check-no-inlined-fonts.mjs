/**
 * Post-build guard for the font pipeline. Two failure modes, both SILENT at
 * runtime — no build error, no console error, just text rendered in a system
 * font that nobody notices until someone looks closely at a screenshot.
 *
 * 1. AN INLINED FONT IS A BLOCKED FONT. The CSP pins `font-src 'self'`
 *    (scripts/postbuild.mjs), so a `url(data:…)` inside `@font-face` is
 *    refused by the browser and that glyph range falls back. This already
 *    happened once in production: nine @fontsource subsets sat under Vite's
 *    default 4 KB inline threshold and shipped as data URIs. The fix lives in
 *    vite.config.ts (`assetsInlineLimit` returns false for font extensions) —
 *    this script is the check that the fix is still working.
 *
 * 2. THE SET OF SHIPPED FONTS DRIFTED. @fontsource per-weight entrypoints
 *    (`@fontsource/x/400.css`) pull EVERY subset that family ships — six of
 *    them for Manrope and JetBrains Mono, including greek and vietnamese.
 *    Importing per-subset (`cyrillic-400.css`) is the only way to choose, and
 *    it is one careless "simplification" away from silently tripling the
 *    precache. So the expected set is exact: a missing file and an unexpected
 *    file are equally an error.
 *
 * Filenames in dist carry a content hash (`outfit-latin-400-normal-C1x2Y3z4.woff2`),
 * so the allowlist is on the LOGICAL stem, which is stable across rebuilds.
 *
 * Pure helpers are exported for scripts/check-no-inlined-fonts.test.mjs, which
 * exercises them on fixtures and never touches dist/.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS_DIR = 'dist/assets';

/** `family` × `subsets` × `weights` → the @fontsource logical stems. */
function fontSet(family, subsets, weights) {
  return subsets.flatMap(s => weights.map(w => `${family}-${s}-${w}-normal`));
}

/**
 * The exact set of woff2 the build is expected to emit.
 *
 * Keep this in the SAME commit as any change to the imports in src/main.tsx —
 * a diff here is the visible half of a decision about what users download.
 */
export const EXPECTED_FONTS = [
  // Mono: per-weight entrypoints, so all six subsets ship. Deliberately left
  // as-is — narrowing it is a separate decision with its own measurement.
  ...fontSet('jetbrains-mono', ['cyrillic', 'cyrillic-ext', 'greek', 'latin', 'latin-ext', 'vietnamese'], [400, 500, 600]),
  // UI face: Manrope, imported per SUBSET so greek and vietnamese stay out.
  // A slip back to the per-weight entrypoint would add 8 files here and this
  // exact-set check is what catches it.
  ...fontSet('manrope', ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'], [400, 500, 600, 700]),
].sort();

/** Strip Vite's `-[hash]` before the extension. */
export function logicalFontName(filename) {
  return filename.replace(/-[A-Za-z0-9_-]{8}\.woff2$/, '').replace(/\.woff2$/, '');
}

/**
 * `@font-face` blocks whose `src` is a data URI. Returns the offending family
 * names (or a placeholder) so the message points somewhere useful.
 */
export function findInlinedFonts(css) {
  const offenders = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1];
    if (!/url\(\s*["']?data:/i.test(body)) continue;
    const family = body.match(/font-family:\s*['"]?([^;'"]+)/i)?.[1]?.trim() ?? '(unknown family)';
    const range = body.match(/unicode-range:\s*([^;]+)/i)?.[1]?.trim();
    offenders.push(range ? `${family} [${range.slice(0, 40)}…]` : family);
  }
  return offenders;
}

/** Set difference both ways — a missing font and a stray font are equal errors. */
export function diffFontSet(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter(x => !a.has(x)).sort(),
    unexpected: [...a].filter(x => !e.has(x)).sort(),
  };
}

function main() {
  if (!existsSync(ASSETS_DIR)) {
    console.error(`${ASSETS_DIR} not found — run \`npm run build\` first.`);
    process.exit(1);
  }
  const entries = readdirSync(ASSETS_DIR);

  const inlined = entries
    .filter(f => f.endsWith('.css'))
    .flatMap(f => findInlinedFonts(readFileSync(join(ASSETS_DIR, f), 'utf8')));

  const actual = entries.filter(f => f.endsWith('.woff2')).map(logicalFontName).sort();
  const { missing, unexpected } = diffFontSet(actual, EXPECTED_FONTS);

  console.log(`Fonts: ${actual.length} woff2 in ${ASSETS_DIR} (expected ${EXPECTED_FONTS.length})`);

  if (inlined.length === 0 && missing.length === 0 && unexpected.length === 0) {
    console.log('Font guard OK');
    return;
  }

  if (inlined.length > 0) {
    console.error(
      `\nINLINED FONT(S) — blocked at runtime by \`font-src 'self'\`, the glyph range ` +
        `will silently fall back to a system font:\n` +
        inlined.map(f => `  - ${f}`).join('\n') +
        `\nCheck \`assetsInlineLimit\` in vite.config.ts — it must return false for font extensions.`,
    );
  }
  if (missing.length > 0) {
    console.error(`\nMISSING (expected but not built):\n` + missing.map(f => `  - ${f}`).join('\n'));
  }
  if (unexpected.length > 0) {
    console.error(
      `\nUNEXPECTED (built but not in the allowlist):\n` +
        unexpected.map(f => `  - ${f}`).join('\n') +
        `\nIf this is intentional, update EXPECTED_FONTS in this file IN THE SAME COMMIT ` +
        `as the import change in src/main.tsx.`,
    );
  }
  process.exit(1);
}

// Importing from the test must not run the CLI.
const invoked = process.argv[1]?.replace(/\\/g, '/');
if (invoked && import.meta.url === `file://${invoked.startsWith('/') ? '' : '/'}${invoked}`) {
  main();
}
