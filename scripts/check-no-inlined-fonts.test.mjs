import { describe, it, expect } from 'vitest';
import { findInlinedFonts, logicalFontName, diffFontSet, EXPECTED_FONTS } from './check-no-inlined-fonts.mjs';

// Unit tests for the font guard's parser, on fixtures — deliberately NOT
// touching dist/. The guard itself needs a build, so wiring it into `npm test`
// would make the suite depend on whatever stale dist/ happens to be lying
// around. The guard runs after `npm run build` in CI; this file proves the
// logic it runs with is sound.

const FACE = (family, src, range) =>
  `@font-face{font-family:'${family}';src:url(${src}) format('woff2');${range ? `unicode-range:${range};` : ''}}`;

describe('findInlinedFonts', () => {
  it('passes a normal self-hosted build', () => {
    const css = FACE('Outfit', '/assets/outfit-latin-400-normal-C1x2Y3z4.woff2') +
      FACE('JetBrains Mono', '/assets/jetbrains-mono-latin-400-normal-Ab12Cd34.woff2');
    expect(findInlinedFonts(css)).toEqual([]);
  });

  it('catches a data: URI — the failure the CSP makes silent', () => {
    const css = FACE('Outfit', 'data:font/woff2;base64,d09GMgABAAAA');
    expect(findInlinedFonts(css)).toEqual(['Outfit']);
  });

  it('catches it through quotes and whitespace', () => {
    expect(findInlinedFonts(`@font-face{font-family:"X";src:url( "data:font/woff2;base64,AA" )}`)).toEqual(['X']);
  });

  it('names the unicode-range so a subset is identifiable among six', () => {
    const css = FACE('Manrope', 'data:font/woff2;base64,AA', 'U+0301,U+0400-045F');
    expect(findInlinedFonts(css)[0]).toContain('Manrope');
    expect(findInlinedFonts(css)[0]).toContain('U+0301');
  });

  it('ignores data: URIs OUTSIDE @font-face (inlined icons are fine)', () => {
    const css = `.icon{background:url(data:image/svg+xml;base64,AA)}` +
      FACE('Outfit', '/assets/outfit-latin-400-normal-C1x2Y3z4.woff2');
    expect(findInlinedFonts(css)).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const css = FACE('A', 'data:font/woff2;base64,AA') + FACE('B', 'data:font/woff2;base64,BB');
    expect(findInlinedFonts(css)).toEqual(['A', 'B']);
  });
});

describe('logicalFontName', () => {
  it('strips the Vite content hash', () => {
    expect(logicalFontName('outfit-latin-400-normal-C1x2Y3z4.woff2')).toBe('outfit-latin-400-normal');
  });

  it('keeps hyphenated subsets intact', () => {
    expect(logicalFontName('jetbrains-mono-cyrillic-ext-500-normal-BEIGL1Tu.woff2'))
      .toBe('jetbrains-mono-cyrillic-ext-500-normal');
  });

  it('tolerates an unhashed name', () => {
    expect(logicalFontName('outfit-latin-400-normal.woff2')).toBe('outfit-latin-400-normal');
  });
});

describe('diffFontSet', () => {
  it('is quiet when the sets match', () => {
    expect(diffFontSet(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], unexpected: [] });
  });

  it('reports a missing font', () => {
    expect(diffFontSet(['a'], ['a', 'b']).missing).toEqual(['b']);
  });

  it('reports a stray font — this is the "someone imported 400.css again" case', () => {
    // A per-weight entrypoint would drag greek and vietnamese back in.
    const expected = ['manrope-latin-400-normal', 'manrope-cyrillic-400-normal'];
    const actual = [...expected, 'manrope-greek-400-normal', 'manrope-vietnamese-400-normal'];
    expect(diffFontSet(actual, expected).unexpected)
      .toEqual(['manrope-greek-400-normal', 'manrope-vietnamese-400-normal']);
  });
});

describe('EXPECTED_FONTS', () => {
  it('matches what the current imports produce: 18 mono + 10 Outfit', () => {
    expect(EXPECTED_FONTS).toHaveLength(28);
    expect(EXPECTED_FONTS.filter(f => f.startsWith('jetbrains-mono-'))).toHaveLength(18);
    expect(EXPECTED_FONTS.filter(f => f.startsWith('outfit-'))).toHaveLength(10);
  });

  it('records that Outfit ships no Cyrillic — the reason the UI face is being replaced', () => {
    expect(EXPECTED_FONTS.some(f => f.startsWith('outfit-') && f.includes('cyrillic'))).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(EXPECTED_FONTS).size).toBe(EXPECTED_FONTS.length);
  });
});
