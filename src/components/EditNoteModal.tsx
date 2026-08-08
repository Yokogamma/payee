import { useState } from 'react';
import { useModalA11y } from '../lib/useModalA11y';
import { NoteComposer } from './NoteComposer';
import { OperationInFlightError } from '../lib/store';
import { NoteTooLongError } from '../lib/limits';
import type { NoteChain } from '../lib/chains';

/**
 * Edit modal (W3): prefilled with the CURRENT version's text; saving creates a
 * NEW permanent version via store.editNote. The modal closes ONLY after the
 * save resolves — on failure the text stays in the buffer with an inline
 * error. No draft persistence here (deliberate: a lock mid-edit discards the
 * in-progress edit; the Main composer's draft machinery is never mixed in).
 */

interface EditNoteModalProps {
  open: boolean;
  chain: NoteChain | null;
  onClose: () => void;
  /** store.editNote pre-bound by Main. Rejects on failure. */
  onSave: (rootId: string, text: string) => Promise<void>;
}

export function EditNoteModal({ open, chain, onClose, onSave }: EditNoteModalProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose);

  // Re-prefill once per OPENED CHAIN — keyed by root, adjusted during render.
  // Never keyed by the chain OBJECT: the store rebuilds every chain whenever
  // `notes` changes (a background restore merging a version into a DIFFERENT
  // chain included), and an identity-keyed effect would silently overwrite
  // the user's unsaved edit with the stored text.
  const openKey = open && chain ? chain.root : null;
  const [prevOpenKey, setPrevOpenKey] = useState<string | null>(null);
  if (openKey !== prevOpenKey) {
    setPrevOpenKey(openKey);
    if (openKey && chain) {
      setText(chain.current.text);
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
      // A double submit raced ahead of the disabled button: the FIRST call is
      // still running and owns the outcome — change nothing, claim nothing.
      if (err instanceof OperationInFlightError) return;
      if (err instanceof NoteTooLongError) {
        setError('Заметка слишком длинная — сократите текст.');
      } else {
        console.error('edit save failed:', err);
        setError('Не удалось сохранить версию. Попробуйте ещё раз.');
      }
      return; // text stays, modal stays
    } finally {
      setBusy(false);
    }
    onClose(); // only after a successful save
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal edit-note-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Редактирование заметки"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Редактирование</h2>
          <button className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть">✕</button>
        </div>
        <NoteComposer
          value={text}
          onChange={setText}
          onSubmit={() => void handleSave()}
          submitLabel="🔐 Сохранить новую версию"
          submitBusyLabel="🔐..."
          busy={busy}
          markdown
          autoFocus
          error={error}
          hint={<span className="kbd-hint">Ctrl+Enter — сохранить</span>}
        />
        <p className="modal-note">
          Правка создаёт новую версию — прежние версии навсегда остаются в истории.
        </p>
      </div>
    </div>
  );
}
