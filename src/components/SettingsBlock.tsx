import { useState, type ReactNode } from 'react';

// ─── Inline SVG icons (self-hosted — the CSP forbids external icon fonts) ───
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const IconChevron = () => <Svg><path d="m6 9 6 6 6 -6" /></Svg>;

/** One settings row. Collapsed by default; the header stays a button so the
 *  keyboard treats it as one stop.
 *
 *  NO LEADING ICON, deliberately. Each row used to carry a 20px accent glyph,
 *  which is 31px of the row's width spent on decoration that repeats the label
 *  it sits next to. The approved mockup has none, and on a 360px phone that
 *  width is the difference between «Авто-блокировка · Через 5 мин» fitting and
 *  wrapping. Icons stay where they disambiguate — the three nav items.
 *
 *  Its own module because the backup block lives in its own file too, and a
 *  block importing the row from the section that renders it would be a cycle. */
export function SettingsBlock({ title, chip, chipClass, danger, children }: {
  title: string;
  chip?: string;
  chipClass?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`settings-block${danger ? ' settings-block--danger' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="settings-block-header"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="settings-block-title">{title}</span>
        {chip && <span className={`settings-block-chip${chipClass ? ' ' + chipClass : ''}`}>{chip}</span>}
        <span className="settings-block-chev"><IconChevron /></span>
      </button>
      {open && <div className="settings-block-body">{children}</div>}
    </div>
  );
}
