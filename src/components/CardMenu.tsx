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
 *   Escape          → moved back to the trigger. The user asked to leave the
 *                     menu and is still where they were.
 *   outside click   → left alone. The click has its own target, and dragging
 *                     focus back to the trigger would undo a deliberate move.
 *   item selected   → left alone. The action usually opens a dialog that wants
 *                     focus; stealing it first makes the dialog's own focus
 *                     management fight this one.
 *   Tab             → left alone, deliberately. Tab means «move on»; catching
 *                     the focus and putting it back would trap the user in the
 *                     one place they just asked to leave. It closes with the
 *                     `programmatic` reason but takes no focus action.
 *   trigger clicked → nothing to do: focus is already on the trigger, because
 *                     clicking it is what put it there.
 *   unmount / lock  → nothing to do. The trigger is gone with the rest of the
 *                     section, and touching a detached node is how a lock ends
 *                     up throwing.
 *
 * So exactly ONE path moves focus, and it is the one where the user is left
 * with nowhere else to be.
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
  /** Set when the menu was opened from the keyboard, so focus enters it. */
  const focusOnOpenRef = useRef<'first' | 'last' | null>(null);

  /** The focusable items, in DOM order. */
  function itemNodes(): HTMLElement[] {
    return popupRef.current
      ? Array.from(popupRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];
  }

  function moveFocus(delta: number | 'first' | 'last') {
    const nodes = itemNodes();
    if (nodes.length === 0) return;
    if (delta === 'first') return nodes[0].focus();
    if (delta === 'last') return nodes[nodes.length - 1].focus();
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    if (current === -1) {
      // Focus is on the TRIGGER — the menu was opened by mouse and never
      // entered. Arithmetic on -1 happened to give the right answer for Down
      // (index 0) and the wrong one for Up: `(-1 - 1 + n) % n` is the
      // SECOND-to-last item, not the last. Enter from the appropriate end.
      return (delta > 0 ? nodes[0] : nodes[nodes.length - 1]).focus();
    }
    // Wraps, per the APG pattern: Down on the last item lands on the first.
    const next = (current + delta + nodes.length) % nodes.length;
    nodes[next].focus();
  }

  function closeAndRestore(reason: CardMenuCloseReason) {
    onOpenChange(false, reason);
    triggerRef.current?.focus();
  }

  /**
   * Focus enters the menu on open — ALWAYS, not only when it was opened from
   * the keyboard.
   *
   * The first version only did this for keyboard opens, which left a real hole:
   * after a mouse click focus sits on the trigger (or, where the browser does
   * not focus buttons on click, on `<body>`), and every arrow key then had to
   * be interpreted relative to «not an item». That is what produced the
   * off-by-one on ArrowUp, and patching the arithmetic only fixed the symptom.
   * APG's model assumes focus is inside an open menu; putting it there removes
   * the case instead of handling it.
   *
   * Only Up asks for the last item — that is the one keystroke whose whole
   * meaning is «start from the bottom».
   */
  useEffect(() => {
    if (!open) return;
    const where = focusOnOpenRef.current ?? 'first';
    focusOnOpenRef.current = null;
    moveFocus(where);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      // Only while this menu holds focus — otherwise two open menus on a page
      // would both answer an arrow key.
      const inside = popupRef.current?.contains(document.activeElement)
        || document.activeElement === triggerRef.current;

      if (e.key === 'Escape') {
        // Stop the event before an outer handler reads it as «close the modal»
        // or «clear the search» — the innermost open layer owns Escape.
        e.stopPropagation();
        closeAndRestore('escape');
        return;
      }
      if (!inside) return;

      // The APG menu-button keyboard model. Announcing role="menu" and then
      // not implementing this is the mismatch worth avoiding: a screen-reader
      // user is told «menu» and then finds arrow keys do nothing.
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); moveFocus(1); break;
        case 'ArrowUp': e.preventDefault(); moveFocus(-1); break;
        case 'Home': e.preventDefault(); moveFocus('first'); break;
        case 'End': e.preventDefault(); moveFocus('last'); break;
        // Tab leaves the menu entirely rather than walking its items — a menu
        // is one stop in the tab order, not a container of stops.
        case 'Tab': onOpenChange(false, 'programmatic'); break;
        default: break;
      }
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
    // `triggerRef` is stable for the life of a card — either the caller's ref
    // object or `ownRef`, both created once — so it is not a dependency that
    // can change under this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onOpenChange]);

  // A trigger with nothing behind it is a button that opens an empty box.
  // It happens for real: with SAFEBOX_WRITER_ENABLED off — the rollback path
  // the flag exists for — a single-version entry with no login and no
  // attachments contributes no items at all.
  if (items.length === 0) return null;

  const triggerId = `${id}-trigger`;

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="icon-btn icon-btn--ring card-menu-btn"
        onClick={() => onOpenChange(!open, open ? 'programmatic' : undefined)}
        onKeyDown={e => {
          if (open) return;
          // Down/Up open the menu AND enter it, which is the whole point of
          // the pattern: a keyboard user should not have to press twice.
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusOnOpenRef.current = 'first';
            onOpenChange(true);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusOnOpenRef.current = 'last';
            onOpenChange(true);
          } else if (e.key === 'Enter' || e.key === ' ') {
            // The click handler still fires and does the opening; this only
            // records that focus should follow.
            focusOnOpenRef.current = 'first';
          }
        }}
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
      >
        <EllipsisMark />
      </button>

      {open && (
        // Named by the button that controls it, per APG. A `role="menu"` with
        // no accessible name is announced as a bare «menu» — the one word that
        // tells the listener nothing about which card they are in, on a screen
        // that can hold a dozen identical triggers.
        <div ref={popupRef} id={id} className="card-menu" role="menu" aria-labelledby={triggerId}>
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
                tabIndex={-1}
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
                tabIndex={-1}
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
