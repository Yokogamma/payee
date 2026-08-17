/**
 * The two marks the «Архив» language leans on, as geometry rather than text.
 *
 * WHY NOT JUST TYPE THEM. Neither U+221E (∞) nor U+22EF (⋯) is drawn by
 * Literata: Google's subsetter drops both, and not from one subset — from all
 * seven, so there is no subset to add. Measured in a browser rather than
 * assumed (`document.fonts.check` lies here: it answers for the whole stack):
 * with no fallback in the family list, both render at exactly the width of a
 * deliberately nonexistent font, while Cyrillic А and Latin A differ by a
 * pixel. They fall through to the platform's last-resort face.
 *
 * That is fatal for ∞ specifically. It is not decoration — it is the status
 * word of the whole design, sitting inline next to Literata on every note, in
 * the status line, on the save button and in the safebox. As a fallback glyph
 * it would arrive in Segoe UI Symbol on Windows, Apple Symbols on macOS and
 * Noto on Android: three different weights, widths and baselines, next to the
 * one typeface the redesign is built on.
 *
 * Drawn, they also inherit `currentColor`, so the three themes need no extra
 * tokens, and they scale with the text they sit in rather than with whatever
 * the fallback face thinks 1em means.
 *
 * The handoff asks for «SVG stroke icons and the ∞ glyph». This serves that
 * intent; only the delivery differs, and it differs because the glyph is not
 * there to be delivered.
 */

interface MarkProps {
  /** Extra classes; `mark` (sizing + baseline) is always applied. */
  className?: string;
}

/**
 * «Сохранено навечно». Two loops meeting at the centre, stroked to match the
 * 1.6–1.8 weight of every other icon here — a filled lemniscate would read
 * heavier than the text beside it at 13px.
 */
export function InfinityMark({ className }: MarkProps) {
  return (
    <svg
      className={`mark${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 12c-1.9-2.6-3.8-3.9-5.8-3.9a3.9 3.9 0 1 0 0 7.8c2 0 3.9-1.3 5.8-3.9Z" />
      <path d="M12 12c1.9 2.6 3.8 3.9 5.8 3.9a3.9 3.9 0 0 0 0-7.8c-2 0-3.9 1.3-5.8 3.9Z" />
    </svg>
  );
}

/* ─── Line icons ───────────────────────────────────────────────
   24-box, stroke 1.8, no fill — the weight AppNav and the settings rows
   already use. Sizing is the caller's business (.icon-btn svg, .status-btn
   svg), so these carry no dimensions of their own. */

const Line = ({ children }: { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** «Проверить обновления». */
export const IconRefresh = () => (
  <Line><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></Line>
);

/** Disclosure. Rotated by the caller when expanded. */
export const IconChevron = () => <Line><path d="m6 9 6 6 6-6" /></Line>;

/** Dismiss. Replaces the ✕ character, which is not one glyph across platforms
 *  and was the last piece of text pretending to be an icon in this line. */
export const IconClose = () => (
  <Line><path d="M6 6l12 12M18 6L6 18" /></Line>
);

/** Search. */
export const IconSearch = () => (
  <Line><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Line>
);

/**
 * The card-menu trigger. Filled dots, not strokes: at 40px inside a ring, a
 * stroked circle of this size renders as a smudge on a 1x display.
 */
export function EllipsisMark({ className }: MarkProps) {
  return (
    <svg
      className={`mark${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5.5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18.5" cy="12" r="1.5" />
    </svg>
  );
}
