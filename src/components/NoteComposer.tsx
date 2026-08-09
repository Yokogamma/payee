import { useRef, useState, type RefObject } from 'react';
import { applyFormat, type MarkdownFormat } from '../lib/markdown-insert';
import { noteJsonByteLength, MAX_NOTE_JSON_BYTES } from '../lib/limits';
import { NoteMarkdown } from './NoteMarkdown';

/**
 * Controlled, presentational composer shared by the Main screen and the edit
 * modal. It owns NOTHING persistent: value/onChange/onSubmit come from the
 * parent — draft hydration/persistence stays in Main (never mixed with an
 * edit-modal buffer), the save pipeline stays in the store.
 *
 * `markdown` (W3): shows the formatting toolbar and the editor/preview toggle.
 * The byte counter appears NEAR the limit at both flag values — the limit
 * itself is enforced in the store for R3 too, so the legacy composer must be
 * able to explain it.
 */

const TOOLBAR: Array<{ format: MarkdownFormat; label: string; title: string }> = [
  { format: 'bold',    label: 'Ж',  title: 'Жирный' },
  { format: 'italic',  label: 'К',  title: 'Курсив' },
  { format: 'heading', label: 'H',  title: 'Заголовок' },
  { format: 'ul',      label: '•',  title: 'Список' },
  { format: 'ol',      label: '1.', title: 'Нумерованный список' },
  { format: 'code',    label: '<>', title: 'Код' },
  { format: 'link',    label: '🔗', title: 'Ссылка' },
];

/** Counter appears when the note is within this many bytes of the cap. */
const COUNTER_VISIBLE_MARGIN = 6_000;

interface NoteComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  submitBusyLabel: string;
  busy: boolean;
  placeholder?: string;
  markdown: boolean;
  autoFocus?: boolean;
  /** Optional external ref to the textarea (Main refocuses it after save). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Optional line under the composer (Main renders the save error there). */
  error?: string;
  hint?: React.ReactNode;
}

export function NoteComposer({
  value,
  onChange,
  onSubmit,
  submitLabel,
  submitBusyLabel,
  busy,
  placeholder,
  markdown,
  autoFocus,
  textareaRef,
  error,
  hint,
}: NoteComposerProps) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);

  const bytes = noteJsonByteLength(value);
  const overLimit = bytes > MAX_NOTE_JSON_BYTES;
  const showCounter = bytes > MAX_NOTE_JSON_BYTES - COUNTER_VISIBLE_MARGIN;

  const setRef = (el: HTMLTextAreaElement | null) => {
    internalRef.current = el;
    if (textareaRef) textareaRef.current = el;
  };

  function handleFormat(format: MarkdownFormat) {
    const el = internalRef.current;
    if (!el) return;
    const result = applyFormat(value, el.selectionStart, el.selectionEnd, format);
    onChange(result.text);
    // Restore the selection after React re-renders the textarea value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(result.selStart, result.selEnd);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    // Ctrl/Cmd+Enter lives on the WRAPPER, not the textarea: in preview mode
    // the textarea is unmounted (focus sits on the toggle button), yet the
    // hint still promises the shortcut and the save button is live.
    <div className="note-composer" onKeyDown={handleKeyDown}>
      {markdown && (
        <div className="composer-toolbar" role="toolbar" aria-label="Форматирование">
          {TOOLBAR.map(({ format, label, title }) => (
            <button
              key={format}
              type="button"
              className="composer-tool"
              onClick={() => handleFormat(format)}
              disabled={preview || busy}
              title={title}
              aria-label={title}
            >
              {label}
            </button>
          ))}
          <div className="composer-toolbar-spacer" />
          <button
            type="button"
            className={`composer-tool composer-tool--toggle ${preview ? 'composer-tool--active' : ''}`}
            onClick={() => setPreview(p => !p)}
            aria-pressed={preview}
          >
            {preview ? 'Редактор' : 'Превью'}
          </button>
        </div>
      )}

      {markdown && preview ? (
        <div className="composer-preview note-text">
          {value.trim()
            ? <NoteMarkdown text={value} />
            : <span className="composer-preview-empty">Нечего показывать</span>}
        </div>
      ) : (
        <textarea
          ref={setRef}
          className="note-input"
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={Math.min(value.split('\n').length + 1, 8)}
          autoFocus={autoFocus}
        />
      )}

      {error && <div className="error-msg">{error}</div>}
      <div className="input-footer">
        <span className="input-hint">
          {showCounter ? (
            <span className={overLimit ? 'byte-counter byte-counter--over' : 'byte-counter'}>
              {bytes.toLocaleString('ru')} / {MAX_NOTE_JSON_BYTES.toLocaleString('ru')} байт
            </span>
          ) : hint}
        </span>
        <button
          className="btn btn-save"
          onClick={onSubmit}
          disabled={!value.trim() || busy || overLimit}
        >
          {busy ? submitBusyLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}
