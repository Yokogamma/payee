import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Every `var(--x)` in the stylesheet must resolve to a declared `--x`.
//
// A typo'd custom property does not throw, does not warn, and does not show up
// in a diff review — the declaration is simply dropped and the element renders
// with the inherited or initial value. With a fallback (`var(--x, monospace)`)
// it is even quieter: the page looks deliberate and is wrong.
//
// This is not hypothetical. `.safebox-revealed code` asked for
// `var(--font-mono, monospace)` while the variable has always been `--mono`,
// so revealed passwords rendered in the browser's default monospace — losing
// exactly the 0/O and 1/l/I disambiguation a password needs most.
//
// Nothing in src/ sets a custom property from JS (no `setProperty` anywhere),
// so the stylesheet is the complete universe and the check can be strict.

const CSS_PATH = 'src/index.css';

/**
 * CSS comments cannot nest, so a non-greedy sweep is exact. Each comment is
 * replaced by its OWN newlines rather than by nothing: a multi-line banner
 * comment would otherwise shift every line number below it, and a guard that
 * reports the wrong line is a guard people learn to distrust.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => '\n'.repeat((c.match(/\n/g) ?? []).length));
}

function declaredNames(css) {
  return new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(m => m[1]));
}

/** Every reference, WITH its line, so a failure points at a line number. */
function references(css) {
  const out = [];
  css.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      out.push({ name: m[1], line: i + 1, hasFallback: /var\(\s*--[A-Za-z0-9_-]+\s*,/.test(m[0] + line.slice(m.index + m[0].length, m.index + m[0].length + 2)) });
    }
  });
  return out;
}

describe('CSS custom properties', () => {
  const raw = readFileSync(CSS_PATH, 'utf8');
  const css = stripComments(raw);
  const declared = declaredNames(css);
  const refs = references(css);

  it('declares every variable it references', () => {
    const undeclared = refs.filter(r => !declared.has(r.name));
    const report = undeclared.map(r => `  ${CSS_PATH}:${r.line} → var(${r.name})`).join('\n');
    expect(undeclared, `Undeclared custom properties:\n${report}\n` +
      `A fallback does not make this safe — it makes the wrong value look intentional.`)
      .toEqual([]);
  });

  it('actually found something to check (guards against a broken parser)', () => {
    // A regex that silently matches nothing would make the test above pass
    // forever. Pin both sides to a plausible floor.
    expect(declared.size).toBeGreaterThan(15);
    expect(refs.length).toBeGreaterThan(50);
  });

  it('parses the tokens the themes are built from', () => {
    for (const name of ['--bg', '--text', '--accent', '--border', '--font', '--mono', '--radius']) {
      expect(declared.has(name), `${name} should be declared in ${CSS_PATH}`).toBe(true);
    }
  });

  it('ignores variables that appear only inside comments', () => {
    expect(declaredNames(stripComments('/* --ghost: red; */ :root { --real: blue; }')))
      .toEqual(new Set(['--real']));
  });
});
