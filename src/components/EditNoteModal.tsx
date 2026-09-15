import { useState } from 'react';
import { useModalA11y } from '../lib/useModalA11y';
import { NoteComposer } from './NoteComposer';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import type { NoteChain } from '../lib/chains';
import { IconClose } from './icons';

/**
 * Edit modal (W3): prefilled with the current version's text — or with the
 * text of ONE OLDER VERSION when `seed` is given. Saving creates a NEW
 * permanent version via store.editNote either way; on failure the text stays
 * in the buffer with an inline error. No draft persistence here (deliberate: a
 * lock mid-edit discards the in-progress edit; the Main composer's draft
 * machinery is never mixed in).
 *
 * THIS COMPONENT DOES NOT CLOSE ITSELF AFTER A SUCCESSFUL SAVE, and that is
 * load-bearing rather than a style choice. `onClose` is a closure over a LIVE
 * `Main`; an async save that resolves after the user has closed this dialog
 * and opened another one would close THAT one and take its unsaved buffer with
 * it. Unmounting does not help — the prop outlives the component. So the whole
 * success tail (closing, navigating, moving focus) belongs to `Main`, which
 * owns the session token that says whether it still applies. `onClose` here is
 * only for ×, Escape and the backdrop, where the user IS the trigger.
 */

/** One older version, opened for editing from the version page. */
export interface EditSeed {
  versionId: string;
  text: string;
  /** Position of that version, 1 = oldest — for the title. */
  ordinal: number;
  total: number;
}

interface EditNoteModalProps {
  open: boolean;
  chain: NoteChain | null;
  /** Absent/null = edit the CURRENT version, the original behaviour. */
  seed?: EditSeed | null;
  onClose: () => void;
  /** store.editNote pre-bound by Main. Rejects on failure. Resolving hands the
   *  whole success tail back to Main — see the note above. */
  onSave: (rootId: string, text: string) => Promise<void>;
}

export function EditNoteModal({ open, chain, seed = null, onClose, onSave }: EditNoteModalProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose);

  // Re-prefill once per OPENED SOURCE — keyed by root AND by which version is
  // being edited, adjusted during render. Never keyed by the chain OBJECT: the
  // store rebuilds every chain whenever `notes` changes (a background restore
  // merging a version into a DIFFERENT chain included), and an identity-keyed
  // effect would silently overwrite the user's unsaved edit with the stored
  // text.
  //
  // The version half of the key is what the plain `chain.root` could not do:
  // moving from one version's edit straight to another's keeps the same root,
  // so the buffer would never be refilled and the second version would open
  // showing the first one's text.
  const openKey = open && chain ? `${chain.root}|${seed?.versionId ?? 'current'}` : null;
  const [prevOpenKey, setPrevOpenKey] = useState<string | null>(null);
  if (openKey !== prevOpenKey) {
    setPrevOpenKey(openKey);
    if (openKey && chain) {
      setText(seed ? seed.text : chain.current.text);
      setError('');
    }
  }

  if (!open || !chain) return null;

  async function handleSave() {
    if (!chain || busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSave(chain.root, text);
    } catch (err) {
      const outcome = classifySaveError(err, SAVE_FALLBACK.edit);
      // in_flight: the first submit owns the outcome — change nothing.
      if (outcome.kind === 'message') setError(outcome.text);
      return; // text stays, modal stays
    } finally {
      setBusy(false);
    }
    // NO onClose() here. The success tail — closing this dialog, leaving the
    // version page, restoring focus — belongs to Main; see the note at the top
    // of this file for why calling it from a stale closure is a data-loss bug
    // rather than a tidiness one.
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal edit-note-modal"
        role="dialog"
        aria-modal="true"
        aria-label={seed ? `Правка версии ${seed.ordinal} из ${seed.total}` : 'Редактирование заметки'}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{seed ? `Правка версии ${seed.ordinal} из ${seed.total}` : 'Редактирование'}</h2>
          <button className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть"><IconClose /></button>
        </div>
        <NoteComposer
          value={text}
          onChange={setText}
          onSubmit={() => void handleSave()}
          submitLabel="Сохранить новую версию"
          submitBusyLabel="Шифруем…"
          busy={busy}
          markdown
          autoFocus
          error={error}
          hint={<span className="kbd-hint">Ctrl+Enter — сохранить</span>}
        />
        <p className="modal-note">
          {seed
            // Правка СТАРОЙ версии — это и есть возврат с изменениями: тот же
            // вызов, что «Вернуть», только с другим текстом. Сказать это здесь
            // важнее, чем на кнопке: «Изменить» на странице версии иначе
            // читается как «поправить старую версию на месте», чего не бывает.
            ? 'Правка этой версии создаст новую (текущую) версию заметки. Прежние версии останутся в истории.'
            : 'Правка создаёт новую версию — прежние версии навсегда остаются в истории.'}
        </p>
      </div>
    </div>
  );
}
