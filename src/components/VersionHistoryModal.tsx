import { useEffect, useRef, useState } from 'react';
import { useModalA11y } from '../lib/useModalA11y';
import { NoteMarkdown } from './NoteMarkdown';
import { badgeFor } from './syncBadge';
import { OperationInFlightError, type NoteSyncInfo } from '../lib/store';
import { NoteTooLongError } from '../lib/limits';
import type { NoteChain } from '../lib/chains';
import type { NoteData } from '../lib/crypto';

/**
 * Version history of one chain (current-first). Versions are numbered by
 * ORDINAL position («Версия k из N»), not by raw rev — duplicate revs from a
 * fork must never render confusingly. Tapping a row expands its content
 * (rendered per its OWN fmt); «Восстановить эту версию» hands off to the
 * async restore-confirm dialog (Main closes THIS modal first — never two
 * aria-modal layers at once — and reopens it with focus on the same row if
 * the user cancels).
 */

interface VersionHistoryModalProps {
  open: boolean;
  chain: NoteChain | null;
  syncStatuses: Record<string, NoteSyncInfo>;
  syncActive: boolean;
  onClose: () => void;
  onRequestRestore: (version: NoteData) => void;
  /** Version row to focus on (re)open — the cancel path of the confirm. */
  focusVersionId?: string | null;
  formatDate: (ts: number) => string;
}

export function VersionHistoryModal({
  open,
  chain,
  syncStatuses,
  syncActive,
  onClose,
  onRequestRestore,
  focusVersionId,
  formatDate,
}: VersionHistoryModalProps) {
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  // Explicit focus restore for the cancel-from-confirm path: the row button is
  // re-mounted by then, so useModalA11y's "previous element" cannot find it.
  useEffect(() => {
    if (open && focusVersionId) {
      setExpandedId(focusVersionId);
      requestAnimationFrame(() => rowRefs.current.get(focusVersionId)?.focus());
    }
  }, [open, focusVersionId]);

  if (!open || !chain) return null;

  const total = chain.versions.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="История версий"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>История версий</h2>
          <button className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть">✕</button>
        </div>

        <div className="history-list">
          {chain.versions.map((version, i) => {
            const ordinal = total - i; // current-first → «Версия N из N» on top
            const isCurrent = i === 0;
            const badge = badgeFor(syncStatuses[version.id], syncActive);
            const expanded = expandedId === version.id;
            return (
              <div key={version.id} className={`history-row ${isCurrent ? 'history-row--current' : ''}`}>
                <button
                  ref={el => {
                    if (el) rowRefs.current.set(version.id, el);
                    else rowRefs.current.delete(version.id);
                  }}
                  className="history-row-head"
                  onClick={() => setExpandedId(expanded ? null : version.id)}
                  aria-expanded={expanded}
                >
                  <span className="history-row-title">
                    Версия {ordinal} из {total}
                    {isCurrent && <span className="history-current-mark"> · текущая</span>}
                  </span>
                  <span className="history-row-meta">
                    <span className="note-time">{formatDate(version.createdAt)}</span>
                    <span
                      className={`sync-badge ${badge.className}`}
                      title={badge.label}
                      aria-label={badge.label}
                    >
                      {badge.icon}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div className="history-row-body">
                    <div className="note-text">
                      {version.fmt === 'md'
                        ? <NoteMarkdown text={version.text} />
                        : version.text}
                    </div>
                    {!isCurrent && (
                      <button
                        className="btn btn-ghost history-restore-btn"
                        onClick={() => onRequestRestore(version)}
                      >
                        ↩️ Восстановить эту версию
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="modal-note">
          Каждая версия навсегда сохранена в блокчейне. Восстановление старой
          версии создаёт новую версию с её текстом.
        </p>
      </div>
    </div>
  );
}

// ─── Async restore-confirm (state machine: idle → pending → error/done) ──

interface RestoreVersionDialogProps {
  open: boolean;
  version: NoteData | null;
  /** store.editNote(root, version.text, {fmt: version.fmt}) pre-bound by Main. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * ConfirmDialog is synchronous — restoring a version is not: it encrypts and
 * persists. This dialog owns the async lifecycle: pending disables BOTH
 * buttons (no double submit, no cancel that races the write), an error shows
 * INSIDE without closing (the action stays retryable), success is reported by
 * the parent closing the dialog.
 */
export function RestoreVersionDialog({ open, version, onConfirm, onCancel }: RestoreVersionDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const guardedCancel = () => { if (!pending) onCancel(); };
  const containerRef = useModalA11y<HTMLDivElement>(open, guardedCancel);

  useEffect(() => {
    if (open) {
      setError('');
      setPending(false);
      cancelRef.current?.focus();
    }
  }, [open]);

  if (!open || !version) return null;

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      if (err instanceof OperationInFlightError) {
        setError('Эта заметка уже сохраняется — подождите.');
      } else if (err instanceof NoteTooLongError) {
        setError('Версия слишком длинная для текущего лимита.');
      } else {
        console.error('restore version failed:', err);
        setError('Не удалось восстановить версию. Попробуйте ещё раз.');
      }
      setPending(false);
    }
    // Success: the parent closes this dialog (and moves focus) itself.
  }

  return (
    <div className="modal-overlay confirm-overlay" onClick={guardedCancel}>
      <div
        ref={containerRef}
        className="modal confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Восстановить версию?"
        onClick={e => e.stopPropagation()}
      >
        <h2>Восстановить эту версию?</h2>
        <p className="confirm-message">
          Текст выбранной версии станет новой (текущей) версией заметки.
          История не изменится — все версии сохранятся.
        </p>
        {error && <div className="error-msg" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn btn-ghost" onClick={guardedCancel} disabled={pending}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? '...' : 'Восстановить'}
          </button>
        </div>
      </div>
    </div>
  );
}
