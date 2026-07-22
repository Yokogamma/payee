import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Dialog accessibility (Phase 7): while `open`,
 *  - Escape closes;
 *  - Tab / Shift+Tab are TRAPPED inside the returned container (wrap-around);
 *  - on close, focus returns to the element focused before the dialog opened.
 * Initial focus stays the caller's responsibility (e.g. the SAFE button of a
 * danger dialog) — the hook never steals it.
 */
export function useModalA11y<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const containerRef = useRef<T | null>(null);
  // Ref'd so an inline onClose doesn't re-run the effect (its cleanup would
  // return focus to the trigger while the dialog is still open). Synced in an
  // effect — refs must not be written during render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => !el.hasAttribute('disabled'));
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && container.contains(active);
      // The container itself (tabIndex=-1 initial focus) is a BOUNDARY, not an
      // interior position: without this, Shift+Tab right after opening would
      // let the browser move focus to whatever sits behind the dialog.
      const atBoundary = !inside || active === container;
      if (e.shiftKey) {
        if (atBoundary || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (atBoundary || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);

  return containerRef;
}
