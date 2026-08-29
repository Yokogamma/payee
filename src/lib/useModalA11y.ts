import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where focus may NOT be parked on close.
 *
 *  `isConnected` is not the test it looks like. When the element that opened a
 *  dialog is unmounted while the dialog is up — the feed's card menu, whose
 *  whole feed goes away the moment the note opens — the browser moves focus to
 *  `document.body`, which is very much connected. Returning focus «to the
 *  previous element» would then park it on the body: no announcement, and Tab
 *  restarts from the top of the document. A touch tap has the same effect
 *  without any unmounting at all. */
function unusableTarget(el: Element | null): boolean {
  return el === null || !el.isConnected || el === document.body || el === document.documentElement;
}

/**
 * Dialog accessibility (Phase 7): while `open`,
 *  - Escape closes;
 *  - Tab / Shift+Tab are TRAPPED inside the returned container (wrap-around);
 *  - on close, focus returns to the element focused before the dialog opened,
 *    or to `opts.fallbackRef` when that element is no longer a usable target.
 * Initial focus stays the caller's responsibility (e.g. the SAFE button of a
 * danger dialog) — the hook never steals it.
 */
export function useModalA11y<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  opts: { fallbackRef?: RefObject<HTMLElement | null> } = {},
) {
  const containerRef = useRef<T | null>(null);
  // Ref'd so an inline onClose doesn't re-run the effect (its cleanup would
  // return focus to the trigger while the dialog is still open). Synced in an
  // effect — refs must not be written during render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Same treatment, same reason: the caller passes a fresh options object every
  // render, and the effect below must keep depending on `open` alone.
  const fallbackRef = useRef(opts.fallbackRef);
  useEffect(() => {
    fallbackRef.current = opts.fallbackRef;
  }, [opts.fallbackRef]);

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
      const target = unusableTarget(previous) ? fallbackRef.current?.current ?? null : previous;
      target?.focus?.();
    };
  }, [open]);

  return containerRef;
}
