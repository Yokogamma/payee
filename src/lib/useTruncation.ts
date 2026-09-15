import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * «Does this preview overflow its ceiling?» — MEASURED, not guessed.
 *
 * The feed used to decide with a heuristic on the raw markdown source
 * (`text.length > 600 || lines > 12`), which is wrong in both directions: a
 * note long only because of table pipes and link URLs was clamped though it
 * rendered short, and a short source with a wide image chip was not. What the
 * reader sees is a rendered height, so a rendered height is what gets asked.
 *
 * THE FORMULA IS STATE-INDEPENDENT ON PURPOSE:
 *
 *     truncated = scrollHeight > lines * lineHeight + TOLERANCE * lineHeight
 *
 * and NOT `scrollHeight - clientHeight`, which reads 0 the moment the clamp is
 * dropped — the hook could then never notice the note grew back (a font swap,
 * a rotation, an edit) and could never re-clamp. `scrollHeight` is the content
 * height in BOTH states, so the answer does not depend on the answer.
 *
 * THE TOLERANCE. A note that overflows by less than three quarters of a line
 * is shown in full. Without it the feed fills with cards cut off by six
 * pixels — a fade over half a word, which reads as breakage rather than as
 * «there is more».
 */
const TOLERANCE = 0.75;

interface Options {
  /** The ceiling, in lines. */
  lines: number;
  /**
   * Identity of what is rendered inside the ref. REQUIRED, and it is the
   * invalidator: the observer below deliberately ignores height-only changes,
   * so an edit, a new version arriving from sync, or the markdown ⇄ search
   * switch would otherwise leave a stale verdict standing — none of them
   * changes the width.
   */
  contentKey: string;
}

export function useTruncation(
  ref: RefObject<HTMLElement | null>,
  { lines, contentKey }: Options,
): boolean {
  const [truncated, setTruncated] = useState(false);

  // LAYOUT effect, not a passive one, and that is what removes the need for a
  // remembered verdict: the first measurement lands before paint, so a feed
  // remounting (returning from the reading view) never shows one frame of
  // unclamped cards, and Main's own layout effect — which restores the feed's
  // scrollTop — runs AFTER these, on heights that are already final.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let lastWidth = -1;

    const measure = (): void => {
      const node = ref.current;
      if (!node) return;
      // jsdom reports `line-height: 1.55` UNITLESS and every box as 0×0. A
      // measurement there would be noise, so the hook says «not truncated» and
      // leaves the DOM alone — which is also why the OPEN control must never
      // be conditional on this verdict.
      //
      // The `px` suffix is the actual test, not `Number.isFinite`: parseFloat
      // reads '1.55' as a perfectly good 1.55 and the ceiling would come out
      // at 6.2 PIXELS, clamping everything.
      const raw = getComputedStyle(node).lineHeight;
      if (!raw.endsWith('px')) return;
      const lineHeight = parseFloat(raw);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const ceiling = lines * lineHeight;
      setTruncated(node.scrollHeight > ceiling + TOLERANCE * lineHeight);
    };

    measure();

    // Literata arrives after first paint and changes every wrap.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(measure).catch(() => {});

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? -1;
      // HEIGHT-ONLY CHANGES ARE IGNORED, and that is what keeps this from
      // oscillating: toggling the clamp changes the height, which would
      // re-enter this callback, re-measure and toggle again.
      if (width === lastWidth) return;
      lastWidth = width;
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, lines, contentKey]);

  return truncated;
}
