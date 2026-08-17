import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The light palette is maintained in TWO places by hand:
//
//   [data-theme="light"] { … }                                    ← explicit choice
//   @media (prefers-color-scheme: light) { :root:not([data-theme]) { … } }  ← OS default
//
// The stylesheet says so itself ("Values must mirror [data-theme='light']
// above") and nothing enforced it. CSS has no mixins and this project has no
// preprocessor, so duplication is the honest option — but duplication without
// a check is just a delayed bug: the two blocks drift, and the difference is
// only visible to users whose OS is light AND who never touched the theme
// picker, which is nobody on the developer's machine.
//
// A third palette (warm) makes the odds worse, so this guard also checks that
// any additional [data-theme=…] block declares the SAME KEY SET as light.
// Values must differ — that is what a theme is; a missing key silently
// inherits the dark value from :root and shows up on exactly one screen.

const CSS_PATH = 'src/index.css';

/** Layout and typography: declared once on :root, inherited by every theme.
 *  Not part of any palette, so they are excluded from every comparison here. */
const SHARED = ['--radius', '--radius-sm', '--pad-screen', '--font', '--mono'];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => '\n'.repeat((c.match(/\n/g) ?? []).length));
}

/** Body of the first block whose selector line matches, brace-counted. */
function blockBody(css, selectorRe) {
  const start = css.search(selectorRe);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

/** `--name: value` pairs, values normalised for whitespace. */
function tokens(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  }
  return out;
}

const css = stripComments(readFileSync(CSS_PATH, 'utf8'));

/** All explicit `[data-theme="x"]` palettes except dark (which shares :root). */
function themeBlocks() {
  const names = [...css.matchAll(/\[data-theme="([a-z]+)"\]/g)].map(m => m[1]);
  return [...new Set(names)].filter(n => n !== 'dark');
}

describe('theme palette parity', () => {
  const light = tokens(blockBody(css, /\[data-theme="light"\]\s*\{/) ?? '');
  const mediaBlock = blockBody(css, /@media\s*\(prefers-color-scheme:\s*light\)/) ?? '';
  const mirror = tokens(blockBody(mediaBlock, /:root:not\(\[data-theme\]\)\s*\{/) ?? '');

  it('found both light palettes (guards against a broken parser)', () => {
    expect(light.size).toBeGreaterThan(10);
    expect(mirror.size).toBeGreaterThan(10);
  });

  it('the prefers-color-scheme mirror matches [data-theme="light"] exactly', () => {
    const diffs = [];
    for (const [k, v] of light) {
      if (!mirror.has(k)) diffs.push(`  ${k}: missing from the media-query mirror`);
      else if (mirror.get(k) !== v) diffs.push(`  ${k}: light "${v}" vs mirror "${mirror.get(k)}"`);
    }
    for (const k of mirror.keys()) {
      if (!light.has(k)) diffs.push(`  ${k}: in the mirror but not in [data-theme="light"]`);
    }
    expect(diffs, `The two light palettes drifted:\n${diffs.join('\n')}`).toEqual([]);
  });

  it('every explicit theme declares the same key set as light', () => {
    for (const name of themeBlocks()) {
      if (name === 'light') continue;
      const theme = tokens(blockBody(css, new RegExp(`\\[data-theme="${name}"\\]\\s*\\{`)) ?? '');
      const missing = [...light.keys()].filter(k => !theme.has(k));
      // An unspecified token is not "inherited from light" — it falls through
      // to the DARK values on :root, which is how a warm theme ends up with
      // one dark-yellow banner nobody notices for a month.
      expect(missing, `[data-theme="${name}"] is missing: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('does not require the layout/typography tokens to be repeated', () => {
    // These live only on :root by design and cascade to every theme. Pinning
    // that keeps a future palette from copying them.
    for (const shared of SHARED) {
      expect(light.has(shared), `${shared} should NOT be redeclared in the light palette`).toBe(false);
    }
  });

  // The dark palette shares its block with `:root`, so `themeBlocks()` cannot
  // see it and it sat outside this guard entirely — the one palette that is
  // ALSO the fallback for every key another theme forgets. A key present in
  // light and missing here does not degrade: it renders whatever :root last
  // said, which after the «Архив» rewrite is an ink-on-paper value on a
  // near-black ground.
  const dark = tokens(blockBody(css, /:root,\s*\[data-theme="dark"\]\s*\{/) ?? '');

  it('found the dark palette (it shares its block with :root)', () => {
    expect(dark.size).toBeGreaterThan(10);
  });

  it('the dark palette declares the same key set as light, plus the shared tokens', () => {
    const palette = new Set([...dark.keys()].filter(k => !SHARED.includes(k)));
    const missing = [...light.keys()].filter(k => !palette.has(k));
    const extra = [...palette].filter(k => !light.has(k));
    expect(missing, `dark is missing: ${missing.join(', ')}`).toEqual([]);
    // An extra key here is worse than a missing one: it works in dark and
    // silently resolves to the dark VALUE in light, warm and system.
    expect(extra, `dark declares keys no other palette has: ${extra.join(', ')}`).toEqual([]);
  });

  it('the shared layout/typography tokens are declared exactly once, on :root', () => {
    for (const shared of SHARED) {
      expect(dark.has(shared), `${shared} must be declared on :root`).toBe(true);
    }
  });
});
