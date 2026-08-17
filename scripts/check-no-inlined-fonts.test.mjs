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

  it('handles the variable-font stem, which names an axis where a static one names a weight', () => {
    expect(logicalFontName('literata-cyrillic-ext-wght-italic-DrMGjC4f.woff2'))
      .toBe('literata-cyrillic-ext-wght-italic');
  });
});

describe('diffFontSet', () => {
  it('is quiet when the sets match', () => {
    expect(diffFontSet(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], unexpected: [] });
  });

  it('reports a missing font', () => {
    expect(diffFontSet(['a'], ['a', 'b']).missing).toEqual(['b']);
  });

  it('reports a stray font — this is the "someone imported wght.css again" case', () => {
    // The variable package publishes no per-subset CSS, so its entrypoint drags
    // greek and vietnamese back in. That is why src/fonts.css hand-writes them.
    const expected = ['literata-latin-wght-normal', 'literata-cyrillic-wght-normal'];
    const actual = [...expected, 'literata-greek-wght-normal', 'literata-vietnamese-wght-normal'];
    expect(diffFontSet(actual, expected).unexpected)
      .toEqual(['literata-greek-wght-normal', 'literata-vietnamese-wght-normal']);
  });
});

describe('EXPECTED_FONTS', () => {
  it('matches what src/fonts.css declares: 8 Literata + 4 PT Mono', () => {
    expect(EXPECTED_FONTS).toHaveLength(12);
    expect(EXPECTED_FONTS.filter(f => f.startsWith('literata-'))).toHaveLength(8);
    expect(EXPECTED_FONTS.filter(f => f.startsWith('pt-mono-'))).toHaveLength(4);
  });

  it('both faces carry Cyrillic — this is a Russian app', () => {
    expect(EXPECTED_FONTS.filter(f => f.startsWith('literata-') && f.includes('cyrillic')))
      .toHaveLength(4); // cyrillic + cyrillic-ext × normal/italic
    expect(EXPECTED_FONTS.filter(f => f.startsWith('pt-mono-') && f.includes('cyrillic')))
      .toHaveLength(2);
  });

  it('greek and vietnamese stay out of both families', () => {
    // Their presence would mean someone replaced fonts.css with a package import.
    expect(EXPECTED_FONTS.some(f => f.includes('-greek'))).toBe(false);
    expect(EXPECTED_FONTS.some(f => f.includes('-vietnamese'))).toBe(false);
  });

  it('italics are real files, not a synthetic slant', () => {
    // The redesign uses italic for meaning — placeholders, settings values —
    // and an obliqued serif reads as a rendering fault at 13px.
    expect(EXPECTED_FONTS.filter(f => f.endsWith('-italic'))).toHaveLength(4);
  });

  it('the opsz axis is not shipped — 557 KB against 263 KB, deliberate', () => {
    expect(EXPECTED_FONTS.some(f => f.includes('-opsz-') || f.includes('-standard-'))).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(EXPECTED_FONTS).size).toBe(EXPECTED_FONTS.length);
  });
});
