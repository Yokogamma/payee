import { useEffect, useRef, type ReactNode } from 'react';
import { EllipsisMark } from './icons';

/**
 * The ⋯ menu behind a card's secondary actions.
 *
 * WHY IT EXISTS. The safebox row carried five outline buttons side by side —
 * «Копировать пароль», «Логин», «Показать», «Изменить», «История (2)» — which
 * on a 360px screen wrapped onto three lines and gave equal weight to
 * «copy the password», the thing done every time, and «open the version
 * history», the thing done twice a year. The redesign keeps two buttons and
 * puts the rest here. The notes feed already had a menu of its own; this is
 * that menu, made shareable, rather than a second one.
 *
 * CONTROLLED, not self-managing: the parent owns «which card has its menu
 * open», because the rule is one per section and only the parent can see the
 * other cards.
 *
 * FOCUS IS RETURNED BY REASON, not on every close. Returning it always looks
 * tidy and is wrong in two of the four cases:
 *
 *   Escape, programmatic  → back to the trigger. The user asked to leave the
 *                           menu and is still where they were.
 *   outside click         → leave it. The click has its own target, and
 *                           dragging focus back to the trigger would undo a
 *                           deliberate move.
 *   item selected         → leave it. The action usually opens a dialog that
 *                           wants focus; stealing it first makes the dialog's
 *                           own focus management fight this one.
 *   unmount / lock        → nothing to do. The trigger is gone with the rest
 *                           of the section, and touching a detached node is
 *                           how a lock ends up throwing.
 */

export type CardMenuCloseReason = 'escape' | 'outside' | 'select' | 'programmatic';

export interface CardMenuItem {
  /** Stable key; also the test handle. */
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /**
   * A button item. Mutually exclusive with `href`.
   *
   * Return `false` to KEEP THE MENU OPEN. There is one caller that needs it
   * and the reason is worth stating: «Копировать текст» leaves the menu up
   * when the clipboard write is REJECTED, so the note is still on screen to
   * be selected by hand. Closing on every select looks tidier and quietly
   * removes the fallback from the only case that has no other one.
   */
  onSelect?: () => void | false | Promise<void | false>;
  /** A link item — the blockchain transaction. */
  href?: string;
  danger?: boolean;
}

interface CardMenuProps {
  open: boolean;
  /** `reason` decides what happens to focus — see the note above. */
  onOpenChange: (open: boolean, reason?: CardMenuCloseReason) => void;
  /** Accessible name of the trigger, e.g. «Меню заметки». */
  label: string;
  /** Ties `aria-controls` to the popup; must be unique on the page. */
  id: string;
  items: CardMenuItem[];
  /** Explanatory footer — the immutability note under the notes menu. */
  hint?: ReactNode;
  /**
   * Lets the OWNER land focus on this trigger later. Main needs it after a
   * version restore: the «Восстановить» button that started the flow is gone
   * by the time it finishes, and the ⋯ that opened the menu is the only stable
   * thing left on the card to come back to.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function CardMenu({ open, onOpenChange, label, id, items, hint, triggerRef: externalRef }: CardMenuProps) {
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = externalRef ?? ownRef;
  const popupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Stop the event before an outer handler reads it as «close the modal»
      // or «clear the search» — the innermost open layer owns Escape.
      e.stopPropagation();
      onOpenChange(false, 'escape');
      triggerRef.current?.focus();
    }

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // Focus deliberately NOT moved: the click has its own target.
      onOpenChange(false, 'outside');
    }

    // `capture` on Escape so it is seen before a parent's handler; pointerdown
    // rather than click so the menu is gone before the click lands on whatever
    // is underneath it.
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn icon-btn--ring card-menu-btn"
        onClick={() => onOpenChange(!open, open ? 'programmatic' : undefined)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
      >
        <EllipsisMark />
      </button>

      {open && (
        <div ref={popupRef} id={id} className="card-menu" role="menu">
          {items.map(item => {
            const className = `card-menu-item${item.danger ? ' card-menu-item--danger' : ''}`;
            // A link, so it keeps middle-click and «open in new tab» — an
            // onClick-only div would take those away from a transaction the
            // user may well want beside the app.
            return item.href ? (
              <a
                key={item.key}
                role="menuitem"
                className={className}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onOpenChange(false, 'select')}
              >
                {item.icon}
                {item.label}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={className}
                onClick={() => {
                  // Awaited so an action can veto the close — see `onSelect`.
                  void Promise.resolve(item.onSelect?.()).then(result => {
                    if (result !== false) onOpenChange(false, 'select');
                  });
                }}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
          {hint && <div className="card-menu-hint">{hint}</div>}
        </div>
      )}
    </>
  );
}
