import type { ReactElement } from 'react';
import { useRoute, navigate, type Section } from '../lib/route';

/**
 * The three top-level destinations.
 *
 * WHY THIS EXISTS AT ALL: the safebox lock used to take away the exit as well
 * as the content. «Закрыть сейф» locked the section and left the user in front
 * of a PIN pad with no way back to their notes — the only escape was a header
 * icon that read as «enter the safebox», sitting next to a nearly identical
 * one. Navigation and locking are separate axes now: a locked section loses
 * its CONTENT, never its exit.
 *
 * `<button>`, not `<a href="#/x">`: an anchor lets the browser push the
 * history entry itself, which would create a second write path alongside
 * `navigate()` (see the single-writer note in lib/route.ts).
 *
 * `aria-current="page"` rather than `aria-pressed`: this is navigation, not a
 * toggle. The old header button was a toggle and `aria-pressed` was correct
 * there; carrying it over would misdescribe what these do.
 */

interface Props {
  /**
   * The safebox holds nothing yet — no PIN configured and no entries. The item
   * is DIMMED, never disabled: it is the only way into activation, and a
   * disabled control would strand a new user. Dimming is also announced, not
   * just painted.
   */
  safeboxDimmed: boolean;
}

const ICONS: Record<Section, ReactElement> = {
  notes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" />
    </svg>
  ),
  safebox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M12 15v3" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </svg>
  ),
};

const LABELS: Record<Section, string> = {
  notes: 'Заметки',
  safebox: 'Сейф',
  settings: 'Настройки',
};

export function AppNav({ safeboxDimmed }: Props) {
  const { section } = useRoute();

  return (
    <nav className="app-nav" aria-label="Разделы">
      {/* The wordmark lost its home when the header went. On a wide screen the
          rail has room for it; on a phone the section title carries the
          context and a second title would just eat a row. */}
      <div className="app-nav-brand" aria-hidden="true">
        <span className="app-nav-mark">∞</span>
        <span>Eternal Notes</span>
      </div>
      {(Object.keys(LABELS) as Section[]).map(id => {
        const active = section === id;
        const dim = id === 'safebox' && safeboxDimmed;
        return (
          <button
            key={id}
            type="button"
            className={`app-nav-item${active ? ' app-nav-item--active' : ''}${dim ? ' app-nav-item--dim' : ''}`}
            aria-current={active ? 'page' : undefined}
            /* The state belongs in the NAME, not only in the paint. A nested
               visually-hidden span would work too, but the name algorithm
               inserts a space between nodes («Сейф , не настроен»); an explicit
               label keeps it exact. The visible text is still contained in the
               name, so «Label in Name» holds. */
            aria-label={dim ? `${LABELS[id]}, не настроен` : undefined}
            onClick={() => navigate(id)}
          >
            {ICONS[id]}
            <span className="app-nav-label">{LABELS[id]}</span>
          </button>
        );
      })}
    </nav>
  );
}
