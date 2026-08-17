import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The theme lives in FOUR files, and only one of them is a stylesheet.
 *
 *   src/index.css      --bg per palette          what the page paints
 *   src/lib/theme.ts   THEME_BG                  the runtime <meta theme-color>
 *   index.html         <meta name="theme-color"> the pre-hydration value
 *   vite.config.ts     manifest theme/background the OS splash and task switcher
 *
 * theme.ts says it itself: «This is the touchpoint most easily missed, because
 * the symptom only appears on a real device with the PWA installed.» The
 * symptom is a status bar or a splash screen in the PREVIOUS design's colour —
 * invisible in every browser, every test and every screenshot taken on a
 * desktop, and glaring on a phone.
 *
 * So the stylesheet is the source of truth and this pins the other three to it.
 */

const CSS = readFileSync('src/index.css', 'utf8');
const THEME_TS = readFileSync('src/lib/theme.ts', 'utf8');
const INDEX_HTML = readFileSync('index.html', 'utf8');
const VITE_CONFIG = readFileSync('vite.config.ts', 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => '\n'.repeat((c.match(/\n/g) ?? []).length));
}

/** Block and line comments. Crude — a `//` inside a string literal would be
 *  cut too — which is fine for a colour scan and wrong for anything else. */
function stripJs(src) {
  return stripComments(src).replace(/^\s*\/\/.*$/gm, '');
}

function stripHtml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/** `--bg` of the block whose selector matches. */
export function bgOf(css, selectorRe) {
  const start = css.search(selectorRe);
  if (start === -1) return null;
  return css.slice(start).match(/--bg:\s*([^;]+);/)?.[1]?.trim() ?? null;
}

const clean = stripComments(CSS);
const PALETTE_BG = {
  dark: bgOf(clean, /:root,\s*\[data-theme="dark"\]\s*\{/),
  light: bgOf(clean, /\[data-theme="light"\]\s*\{/),
  warm: bgOf(clean, /\[data-theme="warm"\]\s*\{/),
};

/** The `THEME_BG` object literal from theme.ts, as { theme: '#hex' }. */
export function parseThemeBg(src) {
  const body = src.match(/const THEME_BG[^{]*\{([^}]*)\}/)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(m => [m[1], m[2]]),
  );
}

describe('theme colours outside the stylesheet', () => {
  it('read every palette --bg (guards against a broken parser)', () => {
    for (const [name, value] of Object.entries(PALETTE_BG)) {
      expect(value, `--bg not found for ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('THEME_BG matches the palette each theme actually paints', () => {
    const themeBg = parseThemeBg(THEME_TS);
    expect(Object.keys(themeBg).sort()).toEqual(['dark', 'light', 'warm']);
    for (const [name, expected] of Object.entries(PALETTE_BG)) {
      expect(themeBg[name], `THEME_BG.${name} drifted from --bg in ${name}`).toBe(expected);
    }
  });

  it('the pre-hydration <meta theme-color> matches the DARK palette', () => {
    // Before any data-theme attribute exists, :root is what renders — and
    // :root carries the dark palette. Anything else flashes the wrong colour
    // on every cold start.
    const meta = INDEX_HTML.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/)?.[1];
    expect(meta, 'no <meta name="theme-color"> in index.html').toBeTruthy();
    expect(meta).toBe(PALETTE_BG.dark);
  });

  it('the PWA manifest colours match the DARK palette', () => {
    // The OS paints the splash from the manifest before any JS runs, so it
    // cannot know the preference and must agree with the unstyled render.
    const theme = VITE_CONFIG.match(/theme_color:\s*"([^"]+)"/)?.[1];
    const background = VITE_CONFIG.match(/background_color:\s*"([^"]+)"/)?.[1];
    expect(theme, 'no theme_color in the manifest').toBeTruthy();
    expect(background, 'no background_color in the manifest').toBeTruthy();
    expect(theme).toBe(PALETTE_BG.dark);
    expect(background).toBe(PALETTE_BG.dark);
  });

  it('no palette still carries a colour from the pre-redesign language', () => {
    // The violet UI's grounds. Finding one of these means a palette, or one of
    // the three touchpoints above, was missed during the «Архив» rewrite.
    //
    // COMMENTS ARE EXCLUDED on purpose. Half the value of this codebase's
    // comments is that they quote what a line used to say and why it changed —
    // «was background: var(--green); color: #0a0a0f» is exactly the note that
    // should survive. Scanning raw text would make documenting a removal
    // indistinguishable from failing to remove it.
    const retired = ['#0a0a0f', '#f5f5f7', '#f3ebdf'];
    const sources = {
      'src/index.css': stripComments(CSS),
      'src/lib/theme.ts': stripJs(THEME_TS),
      'index.html': stripHtml(INDEX_HTML),
      'vite.config.ts': stripJs(VITE_CONFIG),
    };
    for (const [name, body] of Object.entries(sources)) {
      for (const colour of retired) {
        expect(body.toLowerCase(), `${name} still uses ${colour}`).not.toContain(colour);
      }
    }
  });
});
