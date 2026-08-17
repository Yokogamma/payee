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

/** The four subsets every family here ships: Russian, Ukrainian, Serbian and
 *  European diacritics. Greek and vietnamese are deliberately absent. */
const SUBSETS = ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'];

/** `family` × `subsets` × `weights` → the @fontsource logical stems. */
function fontSet(family, subsets, weights) {
  return subsets.flatMap(s => weights.map(w => `${family}-${s}-${w}-normal`));
}

/** Variable families name the AXIS where a static one names the weight, and
 *  they ship a separate file per style rather than synthesising the italic. */
function variableFontSet(family, subsets, axis, styles) {
  return subsets.flatMap(s => styles.map(st => `${family}-${s}-${axis}-${st}`));
}

/**
 * The exact set of woff2 the build is expected to emit.
 *
 * Keep this in the SAME commit as any change to the imports in src/main.tsx —
 * a diff here is the visible half of a decision about what users download.
 */
export const EXPECTED_FONTS = [
  // Reading face: Literata, variable on the WEIGHT axis only. The `opsz` axis
  // would double the payload (557 KB against 263 KB for these four subsets)
  // for optical-size compensation that is barely legible between 13px and
  // 30px — recorded as a deliberate deviation from the design handoff.
  //
  // Both styles are real files. The redesign uses italics for meaning rather
  // than emphasis — search placeholders, settings values, the note counter —
  // and a synthetic slant shears the serifs visibly at 13px.
  ...variableFontSet('literata', SUBSETS, 'wght', ['normal', 'italic']),
  // Mono: time, sync status, section labels. One weight is all PT Mono ships.
  ...fontSet('pt-mono', SUBSETS, [400]),
].sort();

/** Legacy `.woff` beside every `.woff2`. @fontsource lists both in `src`, so
 *  taking a package CSS entrypoint made Vite emit BOTH — the previous build
 *  carried 34 of them, 333.7 KB that no browser this PWA supports would ever
 *  request (woff2 comes first in `src` and has been universal since 2016).
 *  They never reached users — the workbox glob precaches woff2 only — but they
 *  shipped to the origin on every deploy. The hand-written @font-face in
 *  src/fonts.css declare woff2 alone, and this asserts it stays that way. */
export const EXPECTED_LEGACY_WOFF_COUNT = 0;

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
  const legacy = entries.filter(f => f.endsWith('.woff'));

  console.log(`Fonts: ${actual.length} woff2 in ${ASSETS_DIR} (expected ${EXPECTED_FONTS.length})`);

  if (
    inlined.length === 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    legacy.length === EXPECTED_LEGACY_WOFF_COUNT
  ) {
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
  if (legacy.length !== EXPECTED_LEGACY_WOFF_COUNT) {
    console.error(
      `\nLEGACY .woff EMITTED: ${legacy.length} file(s), expected ${EXPECTED_LEGACY_WOFF_COUNT}. ` +
        `Nothing requests these — woff2 comes first in every \`src\` — so they are pure deploy weight.\n` +
        `Almost always the cause is a @fontsource CSS entrypoint imported somewhere instead of a ` +
        `hand-written @font-face in src/fonts.css: the package \`src\` lists a .woff fallback and Vite emits it.`,
    );
  }
  process.exit(1);
}

// Importing from the test must not run the CLI.
const invoked = process.argv[1]?.replace(/\\/g, '/');
if (invoked && import.meta.url === `file://${invoked.startsWith('/') ? '' : '/'}${invoked}`) {
  main();
}
