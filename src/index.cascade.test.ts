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
    // jsdom ≥30 RESOLVES relative units in computed style (0.12em × 12px →
    // '1.44px'); jsdom ≤29 echoes the authored '0.12em'. Both are the same
    // declaration — accept either so the assertion survives the bump without
    // weakening the intent (a spaced label).
    expect(['0.12em', '1.44px']).toContain(resolved('section-label', 'letter-spacing'));
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

      // EVERY declaration in the block, then the one the browser actually
      // applies. Reading only the first left `.x { font-size:16px;
      // font-size:10px }` green while the page rendered 10px — a guard that
      // reports the losing value is worse than no guard, because it reads as
      // coverage. Later wins; an `!important` beats every plain one, and among
      // `!important`s the last still wins.
      //
      // And every FORM has to be understood too: anything that is not a plain
      // `px|rem|em|%` is reported below rather than skipped, so `calc()`,
      // `var()`, `clamp()` and the keywords cannot pass unseen.
      const all = [...m[2].matchAll(/(?:^|;)\s*font-size:\s*([^;]+)/g)].map(d => d[1].trim());
      if (all.length === 0) continue;
      const important = all.filter(v => /!important/i.test(v));
      const winner = important.length ? important[important.length - 1] : all[all.length - 1];
      // `!important` is a valid form and the scan found a real one on its first
      // run — `.invite-btn` carries it. Stripped, not reported: the flag
      // changes who wins, not what the size is.
      const value = winner.replace(/!important/i, '').trim();
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

  it('a clamped preview fades into the ground actually behind it', () => {
    // The entry stopped being a filled card in Ф3; a gradient still ending in
    // --bg-card painted a lighter band across the bottom of every long note.
    // The ground is now a variable because pressing the card paints an OPAQUE
    // --bg-hover under it — fading to --bg there would repaint the same seam.
    expect(declaresIn('.note-preview--clamped::after', /linear-gradient\(transparent, var\(--preview-ground/)).toBe(true);
    expect(declaresIn('.note-preview--clamped::after', /var\(--bg-card\)/)).toBe(false);
    expect(declaresIn('.note-open-area', /--preview-ground:\s*var\(--bg\)/)).toBe(true);
  });

  it('the feed reserves the scrollbar gutter — the measurement watches width', () => {
    // Where the scrollbar takes width, its appearance narrows the line box,
    // rewraps every preview and changes their heights — which can flip the
    // scrollbar back off. `useTruncation` re-measures on WIDTH changes, so a
    // width that moves by itself is the one input it cannot be robust against.
    expect(declaresIn('.notes-feed', /scrollbar-gutter:\s*stable/)).toBe(true);
  });

  it('the preview ceiling is four lines, and it cannot drift from the reading size', () => {
    // TWO ASSERTIONS THAT ARE ONE. The ceiling is expressed in `em` against
    // `.note-text`'s line-height, so pinning only the calc would let a change
    // to that line-height silently resize every card. `1lh` is deliberately
    // not used: where it is unsupported the whole declaration is invalid and
    // the ceiling disappears instead of degrading.
    expect(declaresIn('.note-preview', /--preview-lines:\s*4/)).toBe(true);
    expect(declaresIn('.note-preview--clamped', /max-height:\s*calc\(var\(--preview-lines\) \* 1\.55em\)/)).toBe(true);
    expect(resolved('note-text', 'line-height')).toBe('1.55');

    // `overflow` must be identical in both states: it establishes a block
    // formatting context, so toggling it would change how margins collapse —
    // and therefore the very scrollHeight the measurement reads.
    expect(declaresIn('.note-preview', /overflow:\s*hidden/)).toBe(true);
    expect(declaresIn('.note-preview--clamped', /overflow/)).toBe(false);
  });

  it('the whole entry is the open control, and it adds no stacking context', () => {
    expect(declaresIn('.note-open', /position:\s*absolute/)).toBe(true);
    expect(declaresIn('.note-open', /inset:\s*0/)).toBe(true);
    // A z-index anywhere in the card would create a stacking context, and the
    // NEXT card's meta row would then paint over an open .card-menu.
    expect(declaresIn('.note-open', /z-index/)).toBe(false);
    expect(declaresIn('.note-open-area', /z-index/)).toBe(false);
    // The tint is painted on the AREA, under the content — an overlay with a
    // background of its own would cover the very text it highlights.
    expect(declaresIn('.note-open', /background:\s*var\(--accent-glow\)/)).toBe(false);
  });

  it('reading is a grid state like composing, not a layer', () => {
    expect(declaresIn('.main-screen--reading', /grid-template-areas:\s*'content'/)).toBe(true);
    expect(declaresIn('.main-screen--reading', /grid-template-rows:\s*1fr/)).toBe(true);
    // Same invariant the composer carries: z-index >= 100 would paint over the
    // privacy gate, so the fullscreen states must not layer at all.
    expect(declaresIn('.main-screen--reading', /z-index/)).toBe(false);
    expect(declaresIn('.main-screen--reading', /position/)).toBe(false);
  });

  it('the reader anchors its own card menu and keeps the reading measure', () => {
    // The reader carries no ⋯ menu any more — its actions are a labelled bar
    // at the bottom, in the thumb's reach — so the meta row is facts only and
    // needs no positioning of its own.
    expect(declaresIn('.note-reader-meta', /position:/)).toBe(false);
    // 13px, not the tab bar's 12.5px: that size is a named exception granted
    // to `.app-nav-item` alone, and a third exception would end the floor.
    expect(declaresIn('.note-action', /font-size:\s*13px/)).toBe(true);
    expect(declaresIn('.note-action', /min-height:\s*56px/)).toBe(true);
    // The date labels the screen at the same size as the control beside it.
    expect(declaresIn('.note-reader-title', /font-size:\s*15px/)).toBe(true);
    // The body keeps `.note-text` as its wrapper — that is where the 18px and
    // the `pre-wrap` unformatted notes depend on live. `.note-reading` only
    // opens the rhythm and sets the measure.
    expect(declaresIn('.note-reading', /max-width:\s*34em/)).toBe(true);
    expect(resolved('note-text note-reading', 'line-height')).toBe('1.62');

    // THE BODY MUST GROW, and it must do so as a FLEX child. Its parent
    // `.main-content` is a flex column, so a `grid-area` here is inert: the
    // body fell back to `flex: 0 1 auto`, sized itself to its content, and on
    // a one-line note the sticky edit FAB ended up floating mid-screen with
    // ~540px of empty ground below it.
    expect(declaresIn('.note-reader-body', /flex:\s*1 1 auto/)).toBe(true);
    expect(declaresIn('.note-reader-body', /grid-area/)).toBe(false);
    expect(declaresIn('.note-reader-body', /min-height:\s*0/)).toBe(true);
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
    // BOTH fullscreen states, and both must name both classes. A bare
    // `--composing` / `--reading` there would tie on specificity with the
    // `.main-screen` rule above it and lose on order — leaving a 220px rail
    // for a nav that is unmounted.
    expect(
      /\.main-screen\.main-screen--composing[^{]*\{[^}]*grid-template-columns:\s*1fr/.test(desktop),
      'the ≥768px block must re-assert the composing grid naming BOTH classes',
    ).toBe(true);
    expect(
      /\.main-screen\.main-screen--reading[^{]*\{[^}]*grid-template-columns:\s*1fr/.test(desktop),
      'the ≥768px block must re-assert the READING grid naming BOTH classes',
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

  it('the status ROW reserves both of its lines, and the container does not', () => {
    // The row is sized for two lines whether it uses them or not: the feed
    // must not move when the message changes length.
    expect(resolved('status-row', 'min-height')).toBe('42px');
    expect(resolved('status-text', '-webkit-line-clamp')).toBe('2');

    // AND NOT ON THE CONTAINER. `.status-details` is the container's other
    // child; while the 62px sat on `.status-line`, opening the details
    // satisfied the reservation with the PANEL and the top row fell back to
    // its natural height — the row visibly shrank under the chevron that had
    // just been pressed. A container cannot tell which child fills it, so the
    // reservation has to name the row.
    expect(declaresIn('.status-line', /min-height/)).toBe(false);

    // A column, so the panel breaks onto its own row by being a child — the
    // `flex-basis: 100%` that did that in the old wrapping row would now size
    // the panel to the full height instead.
    expect(resolved('status-line', 'flex-direction')).toBe('column');
    expect(declaresIn('.status-details', /flex-basis/)).toBe(false);
  });

  it('the wide-screen release follows the reservation onto the row', () => {
    // The release names `.status-line` no more: with the reservation moved,
    // that override would silently stop doing anything and a wide screen would
    // keep 42px of emptiness it does not need. jsdom does not evaluate media
    // queries for styling, so this reads the source.
    const desktop = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('@media (min-width: 768px)')
      .slice(1)
      .join('\n');
    expect(desktop, 'no ≥768px block found').toBeTruthy();
    expect(
      /\.status-row\s*\{[^}]*min-height:\s*0/.test(desktop),
      'the ≥768px block must release .status-row — the reservation lives there now',
    ).toBe(true);
    expect(
      /\.status-line\s*\{[^}]*min-height/.test(desktop),
      'releasing .status-line is a no-op: it has no min-height to release',
    ).toBe(false);
  });

  it('a toast is centred by margins, and its buttons keep their own width', () => {
    // `left: 50%` + `translateX(-50%)` centred the toast visually and lied
    // about its width: a fixed box anchored at the midpoint has only the right
    // HALF of the viewport to lay out in, so shrink-to-fit resolved to
    // min-content and the declared max-width never applied. Measured on a
    // 390px phone: toast 275px instead of 345, «Доступна новая версия
    // приложения» broken over three lines, and «Обновить» squeezed into a
    // 57px box around 79px of label — 22px of the word drawn OUTSIDE its own
    // border, because nothing clips it.
    // Being fixed to the viewport also put it ON TOP of the bottom navigation
    // — for a toast that waits to be pressed rather than fading, that is
    // covering the way out. It lives in the grid's `content` area now, which
    // is the ONE area present in all four of `.main-screen`'s grid states, so
    // «above the nav» needs no nav-height constant to drift out of sync.
    expect(declaresIn('.toast', /position:\s*fixed/)).toBe(false);
    expect(declaresIn('.toast', /left:\s*50%/)).toBe(false);
    expect(declaresIn('.toast', /transform:\s*translateX/)).toBe(false);
    expect(resolved('toast', 'grid-area')).toContain('content');
    expect(resolved('toast', 'align-self')).toBe('end');
    expect(resolved('toast', 'justify-self')).toBe('center');
    expect(resolved('toast', 'width')).toBe('fit-content');

    // The area the toast is placed into has to exist in EVERY grid state, or
    // it silently falls back to auto-placement and lands in a row of its own,
    // pushing the feed instead of floating over it.
    const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const areaBlocks = [...clean.matchAll(/grid-template-areas:\s*([^;]+);/g)].map(m => m[1]);
    expect(areaBlocks.length, 'grid-template-areas не найдены').toBeGreaterThan(0);
    for (const decl of areaBlocks) {
      expect(decl, `в состоянии сетки ${decl.trim()} нет области content`).toContain('content');
    }

    // And the second half: a control may not shrink below its own label. This
    // button lives in flex rows next to text that will happily take the room.
    expect(declaresIn('.banner-btn', /flex:\s*none/)).toBe(true);
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

  it('markdown keeps ONE rhythm, and the loose-list normaliser is what does it', () => {
    // A list written with blank lines between items becomes <li><p>…</p></li>.
    // Stripping that paragraph's margins is the single declaration that makes
    // «how the author typed it» stop being visible; without it the CSS above is
    // just spacing and the two forms drift apart again.
    expect(declaresIn('.note-md li > p', /margin:\s*0/)).toBe(true);
    expect(declaresIn('.note-md li > p + p', /margin-top/)).toBe(true);

    // Heading sizes stay in px. In `em` they would need a RELATIVE_PARENT entry
    // (see the floor scan above); in `rem` h3 resolved to 16.8px against an
    // 18px body — a heading smaller than the text it introduces.
    expect(declaresIn('.note-md h3', /font-size:\s*18\.5px/)).toBe(true);
    expect(declaresIn('.note-md h4', /font-size:\s*18px/)).toBe(true);

    // The table is drawn in rules. A filled header is a surface, and a feed
    // entry has none — the same rule `.note-card` lost its box for. (What the
    // header may and may not declare is pinned separately below.)
    expect(declaresIn('.note-md th', /background/)).toBe(false);
    expect(declaresIn('.note-md td', /border-bottom:\s*1px solid var\(--border-inner\)/)).toBe(true);
  });

  it('the task-list box is sized by the NOTE, not by the form control', () => {
    const box = '.note-md .task-list-item > input[type="checkbox"]';
    expect(declaresIn(box, /appearance:\s*none/)).toBe(true);

    // A form control does not inherit font-size, so an `em` box resolved
    // against the UA's own ~13.3px and rendered 13px inside an 18px note.
    // `font-size: inherit` is not the way out either — the floor scan above
    // parses px/rem/em/% and reports a keyword as unreadable. So the box is
    // resolved by hand, and THESE TWO ASSERTIONS ARE ONE: 19px is 1.05 × the
    // reading size, and the reading size is pinned right here beside it, so a
    // future change to `.note-text` cannot silently shrink the box again.
    expect(declaresIn(box, /width:\s*19px/)).toBe(true);
    expect(resolved('note-text', 'font-size')).toBe('18px');
    // …and no em anywhere in the box or its tick, which is what regressed.
    expect(declaresIn(box, /em\b/)).toBe(false);
    expect(declaresIn(`${box}:checked::after`, /em\b/)).toBe(false);
  });

  it('a done task-list item dims whole, and an open one does not', () => {
    const done = '.note-md .task-list-item:has(> input[type="checkbox"]:checked)';
    expect(declaresIn(done, /color:\s*var\(--text-dim\)/)).toBe(true);
    // No strikethrough: struck text stops being readable, and a done item is
    // still the record of what was done.
    expect(declaresIn(done, /text-decoration/)).toBe(false);
    // The open item carries no colour of its own — it is body text.
    expect(declaresIn('.note-md .task-list-item', /color:/)).toBe(false);
    // …and a DONE parent must not dim its still-open children: colour inherits,
    // so a nested list restarts at body ink.
    expect(declaresIn('.note-md .task-list-item > ul', /color:\s*var\(--text\)/)).toBe(true);

    // The tick is drawn in `currentColor`, and these inputs are `disabled` —
    // Chromium's UA sheet gives a disabled control its own #545454, which the
    // tick then inherited (2.24:1 on the dark ground, measured in a browser).
    // A STATIC pin on purpose: jsdom carries no such UA rule, so nothing in
    // this suite can observe the failure it prevents.
    expect(declaresIn('.note-md .task-list-item > input[type="checkbox"]', /color:\s*inherit/)).toBe(true);
  });

  it('the task list survives BOTH markdown forms and a mixed list', () => {
    // A loose task list wraps the item's content in <p>, so the box is a
    // grandchild. Without the second selector the item falls back to the raw OS
    // checkbox, in flow, inside the gutter reserved for the drawn one — while
    // `li > p { margin: 0 }` has already made the two forms vertically
    // identical, leaving a broken control as the only visible difference.
    const loose = '.note-md .task-list-item > p > input[type="checkbox"]';
    expect(declaresIn(loose, /appearance:\s*none/)).toBe(true);
    expect(declaresIn(`${loose}:checked::after`, /content/)).toBe(true);
    expect(declaresIn('.note-md .task-list-item:has(> p > input[type="checkbox"]:checked)', /color:\s*var\(--text-dim\)/)).toBe(true);

    // ONE task item stamps `contains-task-list` on the WHOLE list, so the
    // marker must be dropped per ITEM. Dropping it on the container stripped
    // the bullet — and in an <ol> the number — from every ordinary sibling.
    expect(declaresIn('.note-md .contains-task-list', /list-style/)).toBe(false);
    expect(declaresIn('.note-md .contains-task-list', /padding-left/)).toBe(false);
    expect(declaresIn('.note-md .task-list-item', /list-style:\s*none/)).toBe(true);
  });

  it('a table header does not re-parent relative sizes or re-case the author', () => {
    // `font-size` here would make the cell the parent of `.note-md code`'s
    // 0.88em — 11.44px against a 13px header, under the project's own floor —
    // while the floor scan stays green, because RELATIVE_PARENT still measures
    // that selector against `.note-text`. The header is a weight and a rule.
    expect(declaresIn('.note-md th', /font-size/)).toBe(false);
    expect(declaresIn('.note-md th', /text-transform/)).toBe(false);
    expect(declaresIn('.note-md th', /font-family/)).toBe(false);
    expect(declaresIn('.note-md th', /border-bottom:\s*1px solid var\(--border-control\)/)).toBe(true);
  });

  it('the plain-text and search paths keep their preserved newlines', () => {
    // LOAD-BEARING. The blank-line bug was fixed in the element tree, not here
    // (stripStructuralWhitespace in NoteMarkdown.tsx). `.note-text` also renders
    // unformatted notes and search results as raw strings — VersionHistoryModal
    // prints `{version.text}` bare — and both depend on this declaration. Any
    // future attempt to fix markdown spacing by touching it breaks them
    // silently.
    expect(resolved('note-text', 'white-space')).toBe('pre-wrap');
  });

  it('sync state is words without a capsule — except the retry, which is a button', () => {
    expect(declaresIn('.sync-state', /border:\s*none/)).toBe(true);

    // The button chrome hangs on `--retry`, NOT on `--error`. Being an error
    // and being a control are different facts: the feed card and the safebox
    // card both offer a retry, while both history modals render the same state
    // inside the row's own expand <button>, where a rule, a pointer cursor and
    // a 44px floor promised a retry that pressing it could not perform — and
    // made an errored row twice its neighbours' height into the bargain.
    // SyncStateBadge is the one place that decides which of the two it is.
    expect(declaresIn('.sync-state--retry', /border:\s*1\.5px solid currentColor/)).toBe(true);
    expect(resolved('state sync-state sync-state--error sync-state--retry', 'min-height')).toBe('44px');

    // The bare state carries colour and nothing else.
    expect(declaresIn('.sync-state--error', /border|cursor|min-height|padding/)).toBe(false);
    expect(resolved('state sync-state sync-state--error', 'min-height')).not.toBe('44px');
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

describe('dialogs, after the «Архив» pass', () => {
  it('a history row cannot be crushed by the flex it lives in', () => {
    // THE DEFECT THIS FILE CANNOT SEE, pinned by the declarations that fix it.
    // jsdom does not lay out flex, so the crush itself is unreproducible here;
    // it was measured in a browser — 17.6px of row around a 37.3px button,
    // with the restore control cut off — because `overflow: hidden` zeroes a
    // flex item's automatic minimum size and the list above passes its own
    // shortfall down instead of scrolling.
    expect(declaresIn('.history-row', /flex:\s*none/)).toBe(true);
    expect(declaresIn('.history-row', /overflow/)).toBe(false);
    // And the box it was clipping is gone: entries are separated by a rule.
    expect(declaresIn('.history-row', /border-radius/)).toBe(false);
    expect(declaresIn('.history-row', /border-bottom:\s*1px solid var\(--border-inner\)/)).toBe(true);
  });

  it('the modal is a sheet on a scrim, not a card with a frame', () => {
    expect(declaresIn('.modal', /border:/)).toBe(false);
    expect(declaresIn('.modal', /box-shadow:\s*0 8px 32px var\(--scrim\)/)).toBe(true);
    // Same shadow token as the toast — one vocabulary, not two.
    expect(declaresIn('.toast', /box-shadow:\s*0 8px 32px var\(--scrim\)/)).toBe(true);
  });

  it('a dialog title is a declared step of the scale, not the old 18px', () => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const h2 = document.createElement('h2');
    modal.appendChild(h2);
    document.body.appendChild(modal);
    const size = getComputedStyle(h2).fontSize;
    modal.remove();
    expect(size).toBe('22px');
  });

  it('the card menu no longer glows', () => {
    // On the dark theme the accent IS the paper colour, so `--accent-glow`
    // drew a pale halo around a dark menu — the last one left over from the
    // previous language.
    expect(declaresIn('.card-menu', /box-shadow:\s*0 4px 20px var\(--scrim\)/)).toBe(true);
    expect(declaresIn('.card-menu', /accent-glow/)).toBe(false);
  });

  it('the question in a confirm is not set quieter than the text around it', () => {
    expect(resolved('confirm-message', 'font-size')).toBe('15.5px');
  });
});
