/**
 * The round «+», shared by the notes feed and the safebox list.
 *
 * IN FLOW, NOT FIXED — and that is a load-bearing choice, not a style one.
 * A `position: fixed` FAB needs a `z-index` to clear the list, and anything at
 * or above 100 would paint OVER the privacy lock gate (invariant I2: the gate
 * wins on source order alone, at `z-index: 100`). A sticky, in-flow element
 * with no `z-index` cannot get there. It also keeps `env(safe-area-inset-bottom)`
 * working and stays clear of the iOS keyboard, which overlaps fixed elements
 * but not the visual viewport's flow.
 */
interface FabProps {
  onClick: () => void;
  label: string;
  /** Renders the amber dot: something unsaved is waiting behind this button. */
  marked?: boolean;
  /**
   * Main lands focus here when the fullscreen composer closes. A ref rather
   * than a `document.querySelector('.fab')`: the safebox renders a FAB of its
   * own, so a global lookup could focus the WRONG one if the route changed
   * while an async save was in flight. React nulls this on unmount, which
   * makes «the notes FAB is no longer on screen» express itself as «there is
   * nothing to focus» for free.
   */
  ref?: React.Ref<HTMLButtonElement>;
  /**
   * Overrides the «+». The reading view puts EDIT in this corner — the same
   * place, the same thumb, a different verb — so the glyph has to vary while
   * everything else about the control stays identical. Defaults to the plus,
   * so the two existing callers are untouched.
   */
  icon?: React.ReactNode;
}

export function Fab({ onClick, label, marked, ref, icon }: FabProps) {
  return (
    <div className="fab-slot">
      <button ref={ref} type="button" className="fab" onClick={onClick} aria-label={label} title={label}>
        {icon ?? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        {marked && <span className="fab-mark" aria-hidden="true" />}
      </button>
    </div>
  );
}
