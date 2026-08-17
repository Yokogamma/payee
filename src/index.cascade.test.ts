// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What the base layer RESOLVES to, not what it declares.
 *
 * The «Архив» type scale sets `.section-title` to 30px near the top of
 * index.css. Nineteen hundred lines later a second `.section-title` — same
 * specificity, so it wins — set it back to 16px. The redesign's screen title
 * never rendered at its intended size on a single screen, `npm test` stayed
 * green through two phases, and nothing caught it because the only screen
 * anyone had opened (landing) has no `.section-title` on it.
 *
 * Declaration-level checks cannot see this: both rules are perfectly valid and
 * a duplicate-property scan over a 2200-line stylesheet is mostly noise
 * (twenty-two hits, nearly all of them deliberate @media overrides). The only
 * thing worth asserting is the value the browser ends up with, so this mounts
 * the real stylesheet and reads it back.
 *
 * SCOPE: literal values only. jsdom resolves the cascade but does not resolve
 * `var()`, so anything themed reads back as the raw `var(--x)` string —
 * colours belong to scripts/check-contrast.test.mjs, which works from the
 * palettes directly. Here: sizes, weights and touch targets.
 */

const CSS = readFileSync('src/index.css', 'utf8');

beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
});

/** Mount an element with the given classes and read one resolved property.
 *
 *  Reads through the camelCase accessor as well as `getPropertyValue`: in
 *  jsdom the latter returns '' for SHORTHANDS (`border-bottom`, `background`)
 *  while the accessor returns them. Both are needed — longhands only answer to
 *  `getPropertyValue` when the shorthand they came from had no `var()` in it. */
function resolved(className: string, property: string, tag = 'div'): string {
  const el = document.createElement(tag);
  el.className = className;
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const camel = property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const value = cs.getPropertyValue(property) || (cs as unknown as Record<string, string>)[camel] || '';
  el.remove();
  return value.trim();
}

/**
 * Static fallback for declarations jsdom refuses to resolve.
 *
 * A shorthand whose value contains `var()` — `border: 1.5px solid var(--x)`,
 * `background: var(--accent)` — is dropped by jsdom's parser: the longhands
 * read back empty and `getPropertyValue('border')` returns ''. Verified
 * against a fixture, not assumed. Every themed boundary in this stylesheet is
 * written that way, so the contract they encode has to be read from the text.
 *
 * This is weaker than a resolved value — it cannot see a later rule winning —
 * which is why it is used ONLY where jsdom leaves nothing to check, and the
 * sizes above stay on the real cascade.
 */
function declaresIn(selector: string, pattern: RegExp): boolean {
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === selector))
    .map(m => m[2]);
  return bodies.some(body => pattern.test(body));
}

describe('base layer, as the browser resolves it', () => {
  it('jsdom is applying the stylesheet at all (guards the guard)', () => {
    // If this fails, every other assertion here is vacuously true.
    expect(resolved('btn', 'min-height')).toBe('44px');
  });

  it('the screen title is the redesign size, not the old 16px', () => {
    // The regression this file was written for.
    expect(resolved('section-title', 'font-size', 'h2')).toBe('30px');
    expect(resolved('section-title', 'font-weight', 'h2')).toBe('600');
  });

  it('the section label is mono, uppercase and spaced', () => {
    expect(resolved('section-label', 'font-size')).toBe('12px');
    expect(resolved('section-label', 'text-transform')).toBe('uppercase');
    expect(resolved('section-label', 'letter-spacing')).toBe('0.12em');
  });

  it('body text is the reading size', () => {
    document.body.classList.remove('x');
    expect(getComputedStyle(document.body).fontSize).toBe('16.5px');
  });

  it('nothing in the base layer drops below the 13px floor', () => {
    // The floor was 12 here, which made the name of this test a lie: a
    // regression of .state or .btn-tiny to 12px would have passed.
    for (const cls of ['state', 'search-count', 'btn-tiny', 'subtitle']) {
      const size = parseFloat(resolved(cls, 'font-size'));
      expect(size, `.${cls} is ${size}px, under the 13px floor`).toBeGreaterThanOrEqual(13);
    }
  });

  it('the section label is the ONE thing allowed under the floor', () => {
    // The handoff sets the floor at 13px and then specifies these labels at
    // PT Mono 12px itself. It is not prose: uppercase, spaced 0.12em, mono,
    // and never longer than two words. Naming it as an exception is what
    // keeps «13px floor» honest for everything else.
    expect(parseFloat(resolved('section-label', 'font-size'))).toBe(12);
  });

  it('every button variant keeps the 44px target', () => {
    for (const variant of ['btn-primary', 'btn-outline', 'btn-ghost', 'btn-danger', 'btn-save']) {
      expect(resolved(`btn ${variant}`, 'min-height'), `.${variant}`).toBe('44px');
    }
  });

  it('the neutral icon target is 44px and the ringed one is a 40px circle', () => {
    expect(resolved('icon-btn', 'min-width')).toBe('44px');
    expect(resolved('icon-btn', 'min-height')).toBe('44px');
    // The ring trades the box for a ::after that restores the touch area —
    // that is why the two numbers differ, and why 40 here is not a regression.
    expect(resolved('icon-btn icon-btn--ring', 'width')).toBe('40px');
    expect(resolved('icon-btn icon-btn--ring', 'border-radius')).toBe('50%');
  });

  it('the note menu trigger really is the ringed control', () => {
    // .note-menu-btn is declared TWICE further down the file, both times with
    // min-width/min-height — a cross-class override the duplicate-selector
    // check cannot see, only the resolved value can.
    const w = resolved('icon-btn icon-btn--ring note-menu-btn', 'border-radius');
    expect(w, 'the menu trigger lost its ring to a later rule').toBe('50%');
  });

  it('the nav carries its active state in weight as well as colour', () => {
    // Colour alone would be the only channel — the nav has no underline and no
    // fill — and ink-vs-dim is a step a low-vision user may not resolve.
    expect(resolved('app-nav-item', 'font-size')).toBe('12.5px');
    expect(resolved('app-nav-item app-nav-item--active', 'font-weight')).toBe('600');
    // The inactive item declares no weight at all — jsdom reports '' rather
    // than the inherited '400', so the check is that it is not the bold one.
    expect(resolved('app-nav-item', 'font-weight')).not.toBe('600');
  });

  it('the status line reserves both of its lines', () => {
    // The row is sized for two lines whether it uses them or not: the feed
    // must not move when the message changes length.
    expect(resolved('status-line', 'min-height')).toBe('62px');
    expect(resolved('status-text', '-webkit-line-clamp')).toBe('2');
  });

  it('the status refresh is the mockup ring, not a square', () => {
    expect(resolved('status-btn', 'width')).toBe('36px');
    expect(resolved('status-btn', 'border-radius')).toBe('50%');
  });

  it('a feed entry is a ruled line, not a card', () => {
    // The box is what made a list of notes read as a dashboard. Checked
    // statically: an ABSENT property reads back as '' in jsdom, which is
    // indistinguishable from a property the parser choked on, so «no radius»
    // has to be asserted against the source.
    expect(declaresIn('.note-card', /border-radius/)).toBe(false);
    expect(declaresIn('.note-card', /background/)).toBe(false);
    expect(declaresIn('.note-card', /box-shadow/)).toBe(false);
    expect(declaresIn('.note-card', /border-bottom:\s*1px solid var\(--border\)/)).toBe(true);
  });

  it('note text is the reading size and the date leads it', () => {
    expect(resolved('note-text', 'font-size')).toBe('18px');
    expect(resolved('note-date section-label', 'text-transform')).toBe('uppercase');
    expect(declaresIn('.section-label', /font-family:\s*var\(--mono\)/)).toBe(true);
  });

  it('sync state is words without a capsule — except the retry, which is a button', () => {
    expect(declaresIn('.sync-state', /border:\s*none/)).toBe(true);
    // The one status you can press keeps its rule and its touch target.
    expect(declaresIn('.sync-state--error', /border:\s*1\.5px solid currentColor/)).toBe(true);
    expect(resolved('state sync-state sync-state--error', 'min-height')).toBe('44px');
  });

  it('the FAB is the mockup size', () => {
    expect(resolved('fab', 'width')).toBe('56px');
    expect(resolved('fab', 'border-radius')).toBe('50%');
  });

  it('a text action is underlined rather than bare', () => {
    // The one sanctioned exception to «fill or 1.5px rule»: the mockup draws
    // «Свернуть» as text with a rule under it. Bare text would be
    // indistinguishable from prose.
    expect(parseFloat(resolved('btn btn-ghost', 'border-radius'))).toBe(0);
    expect(declaresIn('.btn-ghost', /border-bottom:\s*1px solid var\(--border-control\)/)).toBe(true);
  });

  it('a control still declares a boundary — fill or rule, never nothing', () => {
    // The Ф1 contract, checked rather than asserted in prose.
    for (const variant of ['btn-primary', 'btn-outline', 'btn-ghost', 'btn-danger', 'btn-save']) {
      const filled = declaresIn(`.${variant}`, /background:\s*var\(--accent\)/);
      const ruled = declaresIn(`.${variant}`, /border(-bottom)?:\s*\d+(\.\d+)?px\s+solid/);
      expect(filled || ruled, `.${variant} has neither a fill nor a rule`).toBe(true);
    }
  });
});
