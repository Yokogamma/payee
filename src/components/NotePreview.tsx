import { useRef, type ReactNode, type RefObject } from 'react';
import { NoteMarkdown } from './NoteMarkdown';
import { useTruncation } from '../lib/useTruncation';

/**
 * A feed entry's date and preview, plus the control that opens the note.
 *
 * WHY THIS IS ITS OWN COMPONENT: the truncation measurement is a hook, and
 * hooks cannot run inside the `filteredChains.map()` in Main. Everything else
 * about the card — the sync badge, the version count, the ⋯ menu — stays in
 * Main, where the store lives.
 *
 * WHY THE BUTTON IS AN OVERLAY, not a wrapper: `<button>` takes phrasing
 * content, and a preview is `<p>`, `<ul>`, `<h2>` — flow content. Wrapping
 * would be invalid HTML that browsers merely tolerate. The overlay is a real
 * button with a real accessible name, and the preview stays plain text
 * underneath it. The cost is deliberate and stated in the plan: text cannot be
 * selected in the feed any more (select inside the opened note, or use
 * «Копировать текст» in the ⋯ menu).
 *
 * The button is the LAST child of `.note-open-area`: `.note-preview` is
 * positioned too (it carries the fade), and two positioned siblings at
 * `z-index: auto` are hit-tested in paint order. No `z-index` appears here —
 * the meta row must stay unpositioned so `.card-menu` keeps `.note-card` as
 * its containing block.
 */
interface NotePreviewProps {
  /** Rendered inside the preview: markdown, or highlighted plain text. */
  children: ReactNode;
  /** Mono date label, exactly as the feed prints it. */
  date: string;
  /** Absolute date for the control's accessible name. */
  dateFull: string;
  /** Identity of the rendered content — invalidates the measurement. */
  contentKey: string;
  onOpen: () => void;
  openRef?: RefObject<HTMLButtonElement | null>;
  lines?: number;
}

export function NotePreview({
  children,
  date,
  dateFull,
  contentKey,
  onOpen,
  openRef,
  lines = 4,
}: NotePreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const truncated = useTruncation(previewRef, { lines, contentKey });

  return (
    <div className="note-open-area">
      <div className="note-date section-label">{date}</div>
      <div
        ref={previewRef}
        className={`note-text note-preview${truncated ? ' note-preview--clamped' : ''}`}
      >
        {children}
      </div>
      <button
        type="button"
        ref={openRef}
        className="note-open"
        onClick={onOpen}
        aria-label={`Открыть заметку от ${dateFull}`}
      />
    </div>
  );
}

/** The preview's markdown surface — links and image chips are inert here. */
export function NotePreviewMarkdown({ text }: { text: string }) {
  return <NoteMarkdown text={text} preview />;
}
