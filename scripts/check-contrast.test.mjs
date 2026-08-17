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
 * Non-text contrast (SC 1.4.11, 3:1 for control boundaries) is asserted for
 * --border-control, the token that identifies a control.
 */

const CSS_PATH = 'src/index.css';

/** Minimum for normal-size text. The design floors text at 13px and the
 *  large-text exemption starts at 18.66px bold / 24px regular, so nothing in
 *  this palette qualifies for the relaxed 3:1. */
const AA_NORMAL = 4.5;

/** SC 1.4.11, non-text contrast: the visual boundary that identifies a control
 *  must clear 3:1 against what it sits on. */
const AA_NON_TEXT = 3;

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

  for (const [name, body] of Object.entries(PALETTES)) {
    it(`${name}: --border-control clears ${AA_NON_TEXT}:1 — it is what identifies a control`, () => {
      // SC 1.4.11. The handoff draws every 1.5px line in one colour and makes
      // that line one of the two signals for «this is a button»; the specified
      // #c9bda1 is 1.56:1 and cannot carry that, so --border-control holds a
      // darker value. (A second token kept #c9bda1 for decorative rules until
      // Ф7 — by then it had no users, because every 1.5px line in the mockups
      // turned out to sit on a control. See the palette comment.)
      const map = tokens(body ?? '');
      const fg = parseHex(resolve(map, '--border-control'));
      expect(fg, '--border-control is missing or not a plain hex').toBeTruthy();
      const failures = [];
      for (const bgName of GROUNDS) {
        const bg = parseHex(resolve(map, bgName));
        if (!bg) continue;
        const ratio = contrast(fg, bg);
        if (ratio < AA_NON_TEXT) {
          failures.push(`  --border-control on ${bgName} (${resolve(map, bgName)}): ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures, `${name} fails SC 1.4.11:\n${failures.join('\n')}`).toEqual([]);
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

/**
 * The accent pair, enforced structurally rather than by measurement.
 *
 * Two rules shipped a hard-coded label colour on top of `var(--accent)`:
 * `.btn-primary { color: white }` and `.fab { color: #fff }`. Both were
 * correct for as long as the accent was violet — dark in every theme. The
 * moment the accent became ink, which is dark on paper and PALE on the ink
 * theme, they turned into buttons with no visible label. A third,
 * `.btn-save { color: #0a0a0f }` over `var(--green)`, failed the same way.
 *
 * No contrast computation can catch this: the values are literals, not tokens,
 * so there is no palette entry to measure. What is checkable is the PAIRING —
 * a themed fill takes a themed label.
 */
describe('themed fills carry a themed label', () => {
  /** `selector { … }` bodies, comments already stripped. */
  function rules(source) {
    return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(m => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
      .filter(r => !r.selector.startsWith('@'));
  }

  /** Fills whose lightness flips between themes, and the label each demands. */
  const PAIRS = [
    { fill: '--accent', label: '--accent-text' },
    { fill: '--text', label: '--bg' },
    { fill: '--green', label: '--accent-text' },
  ];

  it('no rule paints a literal colour on top of a themed fill', () => {
    const offenders = [];
    for (const { selector, body } of rules(css)) {
      const fill = PAIRS.find(p => new RegExp(`background(-color)?:\\s*var\\(${p.fill}\\)`).test(body));
      if (!fill) continue;
      const colour = body.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1]?.trim();
      if (!colour) continue; // inherits — fine, and often deliberate
      if (!colour.startsWith('var(')) {
        offenders.push(`  ${selector} — background var(${fill.fill}), color ${colour}`);
      }
    }
    expect(
      offenders,
      'A literal colour on a themed fill assumes which half of the pair is dark, ' +
        `and that assumption breaks on the theme where it is not:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * No literal colours outside the palettes.
 *
 * The last violet in the codebase survived seven phases inside
 * `.toast--update { border-color: rgba(108, 99, 255, 0.4) }` — a value nobody
 * reads, on a rule nobody opens, in a state that appears once per release.
 * Ф0 said the violet was gone; it was gone from everywhere anyone looked.
 *
 * A colour written as a literal cannot answer to a theme, so this is also the
 * check that keeps the three palettes meaningful: every colour in the
 * stylesheet either IS a palette entry or refers to one.
 */
const RESET_MARKER = '*, *::before';

describe('colour lives in the palettes and nowhere else', () => {
  it('found the boundary between palettes and rules (guards the guard)', () => {
    // Without this the `indexOf` below can return -1, `slice(-1)` yields one
    // character, and the whole check passes on an empty haystack — green, and
    // measuring nothing.
    expect(css.indexOf(RESET_MARKER)).toBeGreaterThan(0);
  });

  it('no rule outside the palette blocks carries a literal colour', () => {
    // Everything before the reset is palette; everything after is rules.
    const rules = css.slice(css.indexOf(RESET_MARKER));
    // Split on `;` rather than on line starts. `.foo { color: #fff; }` written
    // on ONE line has no declaration at the beginning of a line, and the first
    // version of this scan walked straight past it.
    const literals = [
      ...new Set(
        rules
          .split(/[;{}]/)
          .map(d => d.trim())
          .filter(d => /^[a-z-]+\s*:/.test(d))
          .filter(d => /rgba?\([0-9]|#[0-9a-fA-F]{3,6}\b/.test(d)),
      ),
    ];
    expect(
      literals,
      'A literal colour cannot answer to a theme. Add a token to all four ' +
        `palettes instead:\n${literals.map(l => `  ${l}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the violet is gone from the whole file, palettes included', () => {
    for (const gone of ['#6c63ff', '#5b52ee', '#5b4fd1', '108, 99, 255']) {
      expect(css.toLowerCase(), `the pre-redesign accent ${gone} is back`).not.toContain(gone);
    }
  });
});

/* --border-strong is deliberately NOT asserted at 3:1. It keeps the handoff's
 * #c9bda1 and is only ever a decorative rule — the search underline, the line
 * between feed entries, group boundaries. SC 1.4.11 governs what identifies a
 * control, and none of those do; --border-control took that job precisely so
 * this one could stay at the specified colour.
 *
 * If a control ever borrows --border-strong for its boundary, that is the bug,
 * and it is a code review question rather than something this file can see. */
