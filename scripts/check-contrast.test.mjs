import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * WCAG 2.2 SC 1.4.3 (contrast minimum, 4.5:1 for normal text) computed from
 * the palettes themselves, not from a screenshot.
 *
 * This exists because the «Архив» handoff specifies --text-dim as #77705e,
 * and that value passes on the card ground and FAILS on the screen ground:
 *
 *   #77705e on #faf6ea (card)    4.56:1   ✓
 *   #77705e on #f2ecdf (screen)  4.18:1   ✗
 *
 * The gap is invisible to the eye and fatal to the audit, and the screen
 * ground is precisely where the design puts the search placeholder, the dates,
 * the note counter and every sync status — 13–16.5px normal text, all of it.
 * The palette therefore carries #6f6857 (4.70:1) as a deliberate, documented
 * deviation from a high-fidelity handoff.
 *
 * A deviation nobody can re-derive is a deviation that gets «fixed» back to
 * the spec by the next person reading the handoff. Hence this file: the
 * numbers are recomputed on every run, and restoring the specified value turns
 * the suite red with the measured ratio in the message.
 *
 * Non-text contrast (SC 1.4.11, 3:1 for control boundaries) is NOT asserted
 * here yet — see the note at the bottom.
 */

const CSS_PATH = 'src/index.css';

/** Minimum for normal-size text. The design floors text at 13px and the
 *  large-text exemption starts at 18.66px bold / 24px regular, so nothing in
 *  this palette qualifies for the relaxed 3:1. */
const AA_NORMAL = 4.5;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => '\n'.repeat((c.match(/\n/g) ?? []).length));
}

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

function tokens(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/** `--text-muted: var(--text-dim)` has to resolve before it can be measured.
 *  One level is all the palettes use, and a deeper chain should fail loudly
 *  rather than silently measure the wrong colour. */
export function resolve(map, name) {
  const raw = map.get(name);
  if (!raw) return null;
  const ref = raw.match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/);
  if (!ref) return raw;
  const target = map.get(ref[1]);
  if (!target || /^var\(/.test(target)) return null;
  return target;
}

/** `#rrggbb` → [r, g, b]. The palettes are all six-digit hex by convention;
 *  anything else (rgba, a named colour) returns null and is skipped rather
 *  than silently measured as black. */
export function parseHex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec(value?.trim() ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
export function luminance([r, g, b]) {
  const lin = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const css = stripComments(readFileSync(CSS_PATH, 'utf8'));

const PALETTES = {
  dark: blockBody(css, /:root,\s*\[data-theme="dark"\]\s*\{/),
  light: blockBody(css, /\[data-theme="light"\]\s*\{/),
  warm: blockBody(css, /\[data-theme="warm"\]\s*\{/),
  'light (system mirror)': blockBody(
    blockBody(css, /@media\s*\(prefers-color-scheme:\s*light\)/) ?? '',
    /:root:not\(\[data-theme\]\)\s*\{/,
  ),
};

/** Every foreground that lands on a themed ground, and the grounds it lands
 *  on. --accent-text is checked against --accent instead: it exists only to
 *  sit on the filled button. */
const ON_GROUNDS = ['--text', '--text-dim', '--text-muted', '--red', '--yellow'];
const GROUNDS = ['--bg', '--bg-card', '--bg-input'];

describe('WCAG contrast of the theme palettes', () => {
  it('found all four palettes (guards against a broken parser)', () => {
    for (const [name, body] of Object.entries(PALETTES)) {
      expect(body, `palette not found: ${name}`).toBeTruthy();
      expect(tokens(body ?? '').size).toBeGreaterThan(10);
    }
  });

  for (const [name, body] of Object.entries(PALETTES)) {
    it(`${name}: every text colour clears ${AA_NORMAL}:1 on every ground`, () => {
      const map = tokens(body ?? '');
      const failures = [];
      for (const fgName of ON_GROUNDS) {
        const fg = parseHex(resolve(map, fgName));
        if (!fg) continue;
        for (const bgName of GROUNDS) {
          const bg = parseHex(resolve(map, bgName));
          if (!bg) continue;
          const ratio = contrast(fg, bg);
          if (ratio < AA_NORMAL) {
            failures.push(
              `  ${fgName} (${resolve(map, fgName)}) on ${bgName} (${resolve(map, bgName)}): ` +
                `${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
      expect(failures, `${name} palette fails SC 1.4.3:\n${failures.join('\n')}`).toEqual([]);
    });

    it(`${name}: button text clears ${AA_NORMAL}:1 on the filled accent`, () => {
      const map = tokens(body ?? '');
      const fg = parseHex(resolve(map, '--accent-text'));
      const bg = parseHex(resolve(map, '--accent'));
      expect(fg, '--accent-text is not a plain hex').toBeTruthy();
      expect(bg, '--accent is not a plain hex').toBeTruthy();
      const ratio = contrast(fg, bg);
      expect(ratio, `--accent-text on --accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it('the handoff value for --text-dim is the one this deviates from', () => {
    // Pinning the REASON, not just the outcome: if someone restores #77705e
    // from the design file, this states plainly what it measures and why the
    // palette carries something else. 4.18 < 4.5.
    const specified = contrast(parseHex('#77705e'), parseHex('#f2ecdf'));
    expect(specified).toBeLessThan(AA_NORMAL);
    expect(specified).toBeCloseTo(4.18, 1);

    const shipped = tokens(PALETTES.light ?? '');
    const actual = contrast(parseHex(resolve(shipped, '--text-dim')), parseHex(resolve(shipped, '--bg')));
    expect(actual).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

/* SC 1.4.11 (non-text contrast, 3:1) is deliberately absent for now.
 *
 * The handoff makes a 1.5px --border-strong rule one of the two things that
 * says «this is a button» — and #c9bda1 measures 1.56:1 against #f2ecdf.
 * Reaching 3:1 needs roughly #93856a, which is a visibly darker interface, not
 * a rounding of the specified colour the way --text-dim was.
 *
 * That is a design decision rather than a defect fix, it belongs to the pass
 * that actually applies borders to controls, and it is open with the design
 * owner. When it lands, assert --border-strong against --bg and --bg-card at
 * 3:1 here. */
