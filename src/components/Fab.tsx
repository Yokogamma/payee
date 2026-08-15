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
}

export function Fab({ onClick, label, marked }: FabProps) {
  return (
    <div className="fab-slot">
      <button type="button" className="fab" onClick={onClick} aria-label={label} title={label}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {marked && <span className="fab-mark" aria-hidden="true" />}
      </button>
    </div>
  );
}
