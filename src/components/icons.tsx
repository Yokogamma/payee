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
      width="1em"
      height="1em"
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

/**
 * `width`/`height` DEFAULT TO 1em, and that is a safety net rather than a
 * style choice.
 *
 * An `<svg>` with no dimensions and no CSS sizing it falls back to the
 * replaced-element default — about 300×150px. Not «a bit large»: a single
 * unsized icon takes over the screen it is on. Every container here does set a
 * size, but «every container» is a claim that has to stay true across every
 * future caller, and the failure is silent in tests and spectacular in the
 * browser. Sizing to the surrounding text means a missed rule costs a slightly
 * wrong icon instead of a broken layout, and any container that wants a
 * specific size still overrides this from CSS.
 *
 * `flex: none` for the same reason: in a flex row an icon must not be the
 * thing that shrinks.
 */
const Line = ({ children }: { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    style={{ flex: 'none' }}
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

/* Card-menu icons. These replace 📋 ✏️ 🕓 🔗 — platform emoji that arrived in
   colour, at a size the font decided, beside monochrome strokes everywhere
   else. */

/** Copy to clipboard. */
export const IconCopy = () => (
  <Line>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Line>
);

/** Edit — a nib, not a pencil: this archive appends versions, it does not rub
 *  anything out, and an eraser-ended pencil says the opposite. */
export const IconEdit = () => (
  <Line><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="M14 6l4 4" /></Line>
);

/** Version history. */
export const IconHistory = () => (
  <Line><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Line>
);

/** Something needs attention. Replaces ⚠️, which arrived as a colour emoji —
 *  the one saturated object on a monochrome page, and at a size the platform
 *  font chose. */
export const IconWarning = () => (
  <Line><path d="M12 4.5 2.8 20h18.4L12 4.5Z" /><path d="M12 10v4.5" /><path d="M12 17.4v.2" /></Line>
);

/** Done, confirmed. Replaces ✓. */
export const IconCheck = () => <Line><path d="m4.5 12.5 5 5 10-11" /></Line>;

/** Hide a revealed secret — the counterpart of IconEye. */
export const IconEyeOff = () => (
  <Line>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.3A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9" />
    <path d="M6.6 7.6C3.9 9.2 2 12 2 12s3.5 6 10 6c1.5 0 2.9-.3 4.1-.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Line>
);

/** Generate a new random password. A pair of shuffling arrows rather than a
 *  die: 🎲 promised chance, and what the button offers is regeneration. */
export const IconShuffle = () => (
  <Line><path d="M3 7h4l10 10h4" /><path d="M17 3l4 4-4 4" /><path d="M3 17h4l3-3" /><path d="M17 21l4-4" /></Line>
);

/** Bring an old version back. Replaces ↩. */
export const IconRestore = () => (
  <Line><path d="M4 10h9a5 5 0 0 1 0 10H8" /><path d="m8 6-4 4 4 4" /></Line>
);

/** The vault. Replaces 🔐 in the safebox activation, the PIN pad and the
 *  landing feature list. */
export const IconVault = () => (
  <Line>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 15.5V18" />
  </Line>
);

/** Waiting on the network. Replaces ⏳. */
export const IconHourglass = () => (
  <Line><path d="M7 3h10" /><path d="M7 21h10" /><path d="M7 3c0 5 5 6 5 9s-5 4-5 9" /><path d="M17 3c0 5-5 6-5 9s5 4 5 9" /></Line>
);

/** Uploads are paused. Replaces ⏸. */
export const IconPause = () => (
  <Line><path d="M9 5v14" /><path d="M15 5v14" /></Line>
);

/** A written note — the empty state. Replaces 📝. */
export const IconNote = () => (
  <Line><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></Line>
);

/** The seed phrase: twelve words that are the only key. Replaces 🌱. */
export const IconKey = () => (
  <Line><circle cx="8" cy="12" r="4" /><path d="M12 12h9" /><path d="M17 12v4" /><path d="M20.5 12v3" /></Line>
);

/** An image in rendered markdown. Replaces 🖼. */
export const IconImage = () => (
  <Line><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m4 17 5-5 4 4 2-2 5 5" /></Line>
);

/** Download an attachment. */
export const IconDownload = () => (
  <Line><path d="M12 4v11" /><path d="m8 11 4 4 4-4" /><path d="M5 19h14" /></Line>
);

/** Closed padlock — «Запереть», and the safebox's own state glyph. */
export const IconLock = () => (
  <Line><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Line>
);

/** Reveal a secret. */
export const IconEye = () => (
  <Line><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" /></Line>
);

/** External link — the blockchain transaction. */
export const IconLink = () => (
  <Line><path d="M14 5h5v5" /><path d="M19 5l-8 8" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Line>
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
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5.5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18.5" cy="12" r="1.5" />
    </svg>
  );
}
