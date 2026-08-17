import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * src/fonts.css hand-writes twelve @font-face because neither family can be
 * imported the way this project needs (see the header of that file). The gain
 * is control; the cost is that the `unicode-range`, `font-weight` and
 * `font-style` values are now COPIES of upstream data, and copies rot.
 *
 * scripts/check-no-inlined-fonts.mjs cannot help here — it compares FILENAMES,
 * and every failure this test exists for leaves the filenames untouched. A
 * subset whose range upstream gained a codepoint, or an axis whose range
 * narrowed from `200 900`, produces a build with exactly the right twelve
 * files and a glyph range silently falling back to a system serif.
 *
 * So the packages themselves are the fixture: this re-reads them from
 * node_modules on every run and fails on any divergence. That is what lets the
 * dependency stay on `^5.3.0` like every other one here instead of being
 * pinned — an upstream change turns this red in CI rather than reaching
 * production as a rendering artefact nobody screenshots.
 */

const OURS = 'src/fonts.css';

/** The four subsets the app ships. Upstream files carrying any other subset
 *  (greek, vietnamese) are expected to be absent from ours, not compared. */
const SUBSETS = ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'];

/**
 * Upstream sources, per family. Literata's italics live in their own
 * entrypoint; PT Mono keeps all four subsets in the per-weight one, and its
 * per-SUBSET files (`cyrillic-400.css`) are useless here on purpose — they
 * omit `unicode-range` entirely, which would make all four faces claim every
 * codepoint and leave the last one standing.
 */
const UPSTREAM = [
  'node_modules/@fontsource-variable/literata/wght.css',
  'node_modules/@fontsource-variable/literata/wght-italic.css',
  'node_modules/@fontsource/pt-mono/400.css',
];

/** `@font-face { … }` → the fields that decide what a browser downloads. */
export function parseFaces(css) {
  const faces = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1];
    const field = re => body.match(re)?.[1]?.trim();
    // The FIRST url() is the one that matters: browsers take the first format
    // they support, and woff2 is listed first everywhere.
    const stems = [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
      .map(m => m[1].replace(/^.*\//, '').replace(/\?.*$/, ''));
    faces.push({
      stem: stems[0]?.replace(/\.woff2?$/, '') ?? '(no url)',
      formats: stems.map(s => s.replace(/^.*\./, '')),
      family: field(/font-family:\s*([^;]+)/),
      style: field(/font-style:\s*([^;]+)/),
      weight: field(/font-weight:\s*([^;]+)/),
      display: field(/font-display:\s*([^;]+)/),
      // Normalised: upstream and ours must agree on VALUE, not on whitespace.
      range: field(/unicode-range:\s*([^;]+)/)?.replace(/\s+/g, ''),
    });
  }
  return faces;
}

/** `literata-cyrillic-ext-wght-italic` → `cyrillic-ext`. Longest match first,
 *  or `latin` would swallow `latin-ext`. */
export function subsetOf(stem) {
  return [...SUBSETS].sort((a, b) => b.length - a.length).find(s => stem.includes(`-${s}-`)) ?? null;
}

const ours = parseFaces(readFileSync(OURS, 'utf8'));
const upstream = new Map(
  UPSTREAM.flatMap(p => parseFaces(readFileSync(p, 'utf8'))).map(f => [f.stem, f]),
);

describe('src/fonts.css matches the @fontsource packages', () => {
  it('parsed both sides (guards against a broken parser)', () => {
    expect(ours).toHaveLength(12);
    expect(upstream.size).toBeGreaterThan(12);
  });

  it('every declared face exists upstream under the same stem', () => {
    const orphans = ours.filter(f => !upstream.has(f.stem)).map(f => f.stem);
    expect(orphans, `not found in the installed packages: ${orphans.join(', ')}`).toEqual([]);
  });

  it('unicode-range, weight, style and display match upstream exactly', () => {
    const diffs = [];
    for (const face of ours) {
      const up = upstream.get(face.stem);
      if (!up) continue; // reported by the test above
      for (const key of ['family', 'style', 'weight', 'display', 'range']) {
        if (face[key] !== up[key]) {
          diffs.push(`  ${face.stem} · ${key}:\n    ours     ${face[key]}\n    upstream ${up[key]}`);
        }
      }
    }
    expect(
      diffs,
      `src/fonts.css drifted from the installed @fontsource packages:\n${diffs.join('\n')}\n\n` +
        'Copy the upstream values across — do not adjust them by hand.',
    ).toEqual([]);
  });

  it('ships only the four intended subsets', () => {
    const strays = ours.filter(f => subsetOf(f.stem) === null).map(f => f.stem);
    expect(strays, `greek/vietnamese or an unrecognised subset: ${strays.join(', ')}`).toEqual([]);
    // Both styles of all four subsets for Literata, one style for PT Mono.
    expect(ours.filter(f => f.stem.startsWith('literata-'))).toHaveLength(8);
    expect(ours.filter(f => f.stem.startsWith('pt-mono-'))).toHaveLength(4);
  });

  it('declares woff2 alone — a .woff fallback is pure deploy weight', () => {
    const withLegacy = ours.filter(f => f.formats.some(x => x === 'woff')).map(f => f.stem);
    expect(
      withLegacy,
      `these declare a legacy .woff: ${withLegacy.join(', ')}. Nothing requests it — woff2 is ` +
        'listed first and has been universal since 2016 — and Vite emits every referenced file.',
    ).toEqual([]);
  });

  it('keeps the Literata weight axis full', () => {
    // A narrowed axis is the failure that looks like nothing: headings at 600
    // would quietly clamp instead of rendering wrong.
    for (const face of ours.filter(f => f.stem.startsWith('literata-'))) {
      expect(face.weight, `${face.stem} lost its axis range`).toBe('200 900');
    }
  });
});
