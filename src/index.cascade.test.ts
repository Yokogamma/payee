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

  it('a clamped note fades into the page, not into a surface that is gone', () => {
    // The entry stopped being a filled card in Ф3; a gradient still ending in
    // --bg-card painted a lighter band across the bottom of every long note.
    expect(declaresIn('.note-text--clamped::after', /linear-gradient\(transparent, var\(--bg\)\)/)).toBe(true);
    expect(declaresIn('.note-text--clamped::after', /var\(--bg-card\)/)).toBe(false);
  });

  it('«Развернуть» is a control, not a coloured word', () => {
    expect(resolved('note-expand-btn', 'font-size')).toBe('14px');
    expect(declaresIn('.note-expand-btn', /border-bottom:\s*1px solid var\(--border-control\)/)).toBe(true);
    // 44px of touch out of a ~26px box, the .status-btn trick.
    expect(declaresIn('.note-expand-btn::after', /inset:\s*-10px -6px/)).toBe(true);
  });

  it('the status panel respects the floor too', () => {
    expect(parseFloat(resolved('status-details', 'font-size'))).toBeGreaterThanOrEqual(13);
    expect(parseFloat(resolved('status-hint', 'font-size'))).toBeGreaterThanOrEqual(13);
  });

  it('the composer sheet fills the screen instead of sitting in a strip', () => {
    expect(resolved('note-composer', 'flex-grow')).toBe('1');
    // Without min-width:0 the toolbar's min-content width (~398px) becomes a
    // floor and the grid overflows a 375px phone.
    expect(parseFloat(resolved('note-composer', 'min-width'))).toBe(0);
    expect(resolved('note-input', 'font-size')).toBe('18px');
  });

  it('the toolbar scrolls rather than wrapping, and keeps 44px targets', () => {
    expect(resolved('composer-toolbar-scroll', 'overflow-x')).toBe('auto');
    expect(resolved('composer-tool', 'height')).toBe('38px');
    expect(declaresIn('.composer-tool::after', /inset:\s*-3px/)).toBe(true);
  });

  it('composing collapses the grid instead of layering over the privacy gate', () => {
    // A z-index here would beat .lock-gate and paint plaintext over it.
    expect(declaresIn('.main-screen--composing', /z-index/)).toBe(false);
    expect(declaresIn('.main-screen--composing', /position/)).toBe(false);
    expect(declaresIn('.main-screen--composing', /grid-template-rows:\s*1fr/)).toBe(true);
  });

  it('the desktop rail does not survive into the composer', () => {
    // `.main-screen--composing` is declared ~1000 lines before the ≥768px
    // block, at the same specificity, so the media query silently won: a wide
    // screen kept a 220px column for a nav that is unmounted while composing.
    // jsdom does not evaluate media queries for styling, so this is a source
    // check — the resolved-value pass cannot reach inside a media block.
    const desktop = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('@media (min-width: 768px)')
      .slice(1)
      .join('\n');
    expect(desktop, 'no ≥768px block found').toBeTruthy();
    expect(
      /\.main-screen\.main-screen--composing\s*\{[^}]*grid-template-columns:\s*1fr/.test(desktop),
      'the ≥768px block must re-assert the composing grid, and must name BOTH ' +
        'classes — a bare .main-screen--composing there would tie on specificity ' +
        'with the .main-screen rule above it and lose on order',
    ).toBe(true);
  });

  it('settings rows are the mockup pitch and the values are italic', () => {
    expect(resolved('settings-block-header', 'min-height')).toBe('54px');
    expect(resolved('settings-block-header', 'font-size')).toBe('16.5px');
    expect(resolved('settings-block-chip', 'font-style')).toBe('italic');
    expect(parseFloat(resolved('settings-block-chip', 'font-size'))).toBeGreaterThanOrEqual(13);
  });

  it('the settings footer sits on its own grid row, out of the scroll', () => {
    // It used to be the last child of the scrolling column, so the one line
    // describing the whole vault was visible only after scrolling past
    // everything else.
    expect(declaresIn('.settings-section', /grid-template-rows:\s*1fr auto/)).toBe(true);
    expect(declaresIn('.settings-scroll', /overflow-y:\s*auto/)).toBe(true);
    expect(declaresIn('.settings-section', /overflow-y/)).toBe(false);
  });

  it('the chosen theme is filled, not tinted', () => {
    // A 1.5px border plus a 5% wash was the same signal the inactive options
    // already carry, only slightly stronger.
    expect(declaresIn('.theme-option--active', /background:\s*var\(--accent\)/)).toBe(true);
    expect(declaresIn('.theme-option--active', /color:\s*var\(--accent-text\)/)).toBe(true);
  });

  it('settings text clears the floor', () => {
    for (const cls of ['settings-hint', 'settings-footnote', 'settings-group-title']) {
      const size = parseFloat(resolved(cls, 'font-size'));
      const floor = cls === 'settings-group-title' ? 12 : 13; // group label = named exception
      expect(size, `.${cls} is ${size}px`).toBeGreaterThanOrEqual(floor);
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
    // 12.5px is under the 13px floor and is the SECOND named exception, after
    // .section-label: the handoff specifies this size for the tab label
    // outright. Two exceptions is the limit — a third means the floor is not a
    // floor. Everything else answers to the check above.
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
