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

  it('NOTHING in the stylesheet drops below the 13px floor', () => {
    // Was four hand-picked classes, which is not a floor — it is four spot
    // checks wearing the name of one. `.seed-num`, `.modal-note` and
    // `.safebox-size` all sat under 13px while this passed green.
    //
    // Scans every rule instead. Two selectors are exempt and both are named in
    // the handoff at their exact size; a third would mean the floor is gone.
    const EXEMPT = new Map([
      ['.section-label', 12],   // «Метки секций: PT Mono 12px»
      ['.app-nav-item', 12.5],  // «подпись 12.5px»
    ]);

    /**
     * Relative sizes, resolved against a DECLARED parent — not against a
     * number somebody typed here.
     *
     * The previous version listed the computed px by hand («0.88em of 18px =
     * 15.8»), which pins nothing: change `.note-text` to 13px and 0.85em
     * silently becomes 11.05px while this test stays green. The map now names
     * the SELECTOR the em resolves against, and the parent's size is read out
     * of the stylesheet, so the arithmetic follows the CSS instead of
     * remembering it.
     *
     * `em` compounds, so a scan cannot resolve it in general — this is the
     * narrow case where the parent is a single known rule. Anything else has
     * to be written in px.
     */
    const RELATIVE_PARENT = new Map([
      ['.note-md code', '.note-text'],
      ['.note-md pre code', '.note-text'],
      ['.md-img-chip', '.note-text'],
    ]);

    /**
     * Parent size through the REAL cascade, not through the first matching
     * declaration in the file.
     *
     * `declaredPx()` used to walk the stylesheet text and return the first
     * `.note-text { font-size: … }` it found. That resolves the case where
     * someone EDITS the existing rule, and misses the one where someone ADDS a
     * later one — which is the ordering trap this stylesheet has already
     * sprung three times. jsdom has the cascade mounted a few lines up; asking
     * it costs nothing and cannot disagree with the browser.
     */
    const cascadedPx = (selector: string): number | null => {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      if (!cls) return null; // only simple class parents are supported
      const px = parseFloat(resolved(cls, 'font-size'));
      return Number.isFinite(px) ? px : null;
    };

    const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders: string[] = [];
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, ' ');
      if (selector.startsWith('@')) continue;

      // EVERY font-size has to be understood. The previous version matched
      // `px|rem|em|%` and let everything else fall through the `continue`
      // below — so `calc()`, `var()`, `clamp()` and the keywords would have
      // passed unseen, which is the same silent gap as the unresolved `em`.
      const anySize = m[2].match(/(?:^|;)\s*font-size:\s*([^;]+)/);
      if (!anySize) continue;
      // `!important` is a valid form and the scan found a real one on its first
      // run — `.invite-btn` carries it. Stripped, not reported: the flag
      // changes who wins, not what the size is.
      const value = anySize[1].replace(/!important/i, '').trim();
      const decl = value.match(/^([0-9.]+)(px|rem|em|%)$/);
      if (!decl) {
        offenders.push(`  ${selector} → font-size: ${value} — форма не разбирается, размер не проверен`);
        continue;
      }

      if (decl[2] === 'em' || decl[2] === '%') {
        const parent = RELATIVE_PARENT.get(selector);
        if (!parent) {
          offenders.push(`  ${selector} → ${decl[1]}${decl[2]} — относительный размер без объявленного родителя`);
          continue;
        }
        const base = cascadedPx(parent);
        if (base === null) {
          offenders.push(`  ${selector} → родитель ${parent} не разрешается в px, считать не от чего`);
          continue;
        }
        const factor = decl[2] === '%' ? parseFloat(decl[1]) / 100 : parseFloat(decl[1]);
        const resolved = base * factor;
        if (resolved < 13) {
          offenders.push(`  ${selector} → ${decl[1]}${decl[2]} от ${parent} (${base}px) = ${resolved.toFixed(2)}px`);
        }
        continue;
      }

      const px = decl[2] === 'rem' ? parseFloat(decl[1]) * 16 : parseFloat(decl[1]);
      if (px >= 13 || EXEMPT.get(selector) === px) continue;
      offenders.push(`  ${selector} → ${px}px`);
    }
    expect(
      offenders,
      'Пол 13px. Исключения — только названные хендоффом поимённо ' +
        `(${[...EXEMPT.keys()].join(', ')}):\n${offenders.join('\n')}`,
    ).toEqual([]);
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

  it('очистка поиска держит 44px касания, не занимая высоту строки', () => {
    // Кнопка МОНТИРУЕТСЯ ВМЕСТЕ С ЗАПРОСОМ, поэтому её высота становится
    // высотой строки поиска ровно в момент набора. При литеральных 44px строка
    // росла 45.5 → 64.9 (замер в браузере на 390px): поле уезжало вниз из-под
    // пальца, который в него печатал. Порог касания жив, он в ::after.
    const h = parseFloat(resolved('search-clear', 'height'));
    expect(h, 'у .search-clear нет собственной коробки').toBeGreaterThan(0);
    expect(
      h,
      `видимая коробка ${h}px — всё, что выше строчного бокса поля, снова сдвинет строку`,
    ).toBeLessThanOrEqual(24);

    // min-height здесь опаснее height: он переживает любую правку height.
    const minH = parseFloat(resolved('search-clear', 'min-height')) || 0;
    expect(minH, `min-height: ${minH}px вернёт тот же скачок`).toBeLessThanOrEqual(h);

    // 24 + 2 × 10 = 44.
    expect(declaresIn('.search-clear::after', /inset:\s*-10px/)).toBe(true);
  });

  it('the toolbar fade never reaches the last button or its focus ring', () => {
    // The fix could be undone by editing either number, and nothing here
    // noticed: the mask dims the trailing N px of the box, so the scroller's
    // trailing padding has to exceed the fade by at least the focus ring —
    // measured at ~5px in a browser (2.7px outline + 2px offset). At 25px the
    // ring's outer edge landed exactly on the gradient's start.
    const RING = 5;
    const fade = Number(CSS.match(/mask-image:[^;]*calc\(100% - (\d+)px\)/)?.[1]);
    const pad = parseFloat(resolved('composer-toolbar-scroll', 'padding-right'));

    expect(fade, 'ширина затухания не найдена в маске').toBeGreaterThan(0);
    expect(pad, 'хвостовой отступ скроллера не задан').toBeGreaterThan(0);
    expect(
      pad,
      `хвостовой отступ ${pad}px не перекрывает затухание ${fade}px плюс кольцо фокуса ${RING}px — ` +
        'последняя кнопка на конце прокрутки окажется полупрозрачной',
    ).toBeGreaterThanOrEqual(fade + RING);
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

  it('the settings group label takes its type from .section-label', () => {
    // It no longer declares a size of its own — that duplicate 12px read as a
    // third exception to the floor when it is the same one. The markup carries
    // both classes; this checks the resolved result rather than the rule.
    expect(resolved('section-label settings-group-title', 'font-size')).toBe('12px');
    expect(resolved('section-label settings-group-title', 'text-transform')).toBe('uppercase');
    for (const cls of ['settings-hint', 'settings-footnote']) {
      expect(parseFloat(resolved(cls, 'font-size')), `.${cls}`).toBeGreaterThanOrEqual(13);
    }
  });

  it('both named exceptions are still exactly their specified size', () => {
    // The handoff sets the floor at 13px and then names these two smaller,
    // each for a specific element. Neither is prose: one is a mono uppercase
    // group label, the other the tab caption.
    expect(parseFloat(resolved('section-label', 'font-size'))).toBe(12);
    expect(parseFloat(resolved('app-nav-item', 'font-size'))).toBe(12.5);
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
