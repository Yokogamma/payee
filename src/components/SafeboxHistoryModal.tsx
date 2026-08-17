import { useEffect, useRef, useState } from 'react';
import { formatNoteDate } from '../lib/format-date';
import { useModalA11y } from '../lib/useModalA11y';
import { badgeFor } from './syncBadge';
import { type NoteSyncInfo } from '../lib/store';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import type { SafeboxChain } from '../lib/chains';
import type { SafeboxEntryData } from '../lib/crypto';
import { IconClose, IconEye, IconRestore } from './icons';

/**
 * Version history of one safebox entry (current-first), mirroring
 * VersionHistoryModal: ordinal numbering, one expanded row at a time, and the
 * async restore-confirm as a SEPARATE dialog (never two aria-modal layers).
 *
 * Old passwords are NOT shown here: a row lists the non-secret fields, and the
 * password is only ever revealed through an explicit per-version action, which
 * decrypts on demand exactly like the card does.
 */

interface SafeboxHistoryModalProps {
  open: boolean;
  chain: SafeboxChain | null;
  syncStatuses: Record<string, NoteSyncInfo>;
  syncActive: boolean;
  /** Writer flag: when false the «Вернуть эту версию» control is hidden
   *  entirely (history itself stays readable — that is a reader feature). */
  canRestore: boolean;
  onClose: () => void;
  onRequestRestore: (version: SafeboxEntryData) => void;
  onRevealVersion: (versionId: string) => Promise<string>;
  focusVersionId?: string | null;
}

export function SafeboxHistoryModal({
  open, chain, syncStatuses, syncActive, canRestore,
  onClose, onRequestRestore, onRevealVersion, focusVersionId,
}: SafeboxHistoryModalProps) {
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [revealError, setRevealError] = useState('');
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const [appliedFocusId, setAppliedFocusId] = useState<string | null>(null);
  if (open && focusVersionId && appliedFocusId !== focusVersionId) {
    setAppliedFocusId(focusVersionId);
    setExpandedId(focusVersionId);
  }
  if (!open && appliedFocusId !== null) setAppliedFocusId(null);

  useEffect(() => {
    if (open && focusVersionId) {
      requestAnimationFrame(() => rowRefs.current.get(focusVersionId)?.focus());
    }
  }, [open, focusVersionId]);

  // A closed modal must never keep a revealed password around. Adjusted DURING
  // render (the documented alternative to setState-in-effect) so the value is
  // gone before the next paint, not one cascading render later.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) { setRevealed(null); setRevealError(''); }
  }

  // Auto-hide a revealed password after 20 s (a second look = a new decrypt).
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 20_000);
    return () => clearTimeout(t);
  }, [revealed]);

  if (!open || !chain) return null;

  const total = chain.versions.length;

  async function reveal(versionId: string) {
    setRevealError('');
    try {
      setRevealed({ id: versionId, value: await onRevealVersion(versionId) });
    } catch (err) {
      setRevealed(null);
      setRevealError(err instanceof Error ? err.message : 'Не удалось показать пароль.');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="modal history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="История версий записи сейфа"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>История версий</h2>
          <button className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть"><IconClose /></button>
        </div>

        <div className="history-list">
          {chain.versions.map((version, i) => {
            const ordinal = total - i;
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
                    <span className="note-time">{formatNoteDate(version.createdAt)}</span>
                    <span className={`state sync-state ${badge.className}`} title={badge.label} aria-label={badge.label}>
                      {badge.word}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div className="history-row-body">
                    <div className="safebox-field"><span>Название:</span> {version.title}</div>
                    {version.login && <div className="safebox-field"><span>Логин:</span> {version.login}</div>}
                    {version.url && <div className="safebox-field"><span>URL:</span> {version.url}</div>}
                    {version.note && <div className="safebox-field"><span>Заметка:</span> {version.note}</div>}
                    {version.files.length > 0 && (
                      <div className="safebox-field">
                        <span>Вложения:</span> {version.files.map(f => f.name).join(', ')}
                      </div>
                    )}
                    <button
                      className="btn btn-ghost"
                      onClick={() => void reveal(version.id)}
                    >
                      <IconEye /> Показать пароль этой версии
                    </button>
                    {revealed?.id === version.id && (
                      <div className="safebox-revealed" role="status">
                        <code>{revealed.value}</code>
                        <span className="settings-hint"> (скроется автоматически)</span>
                      </div>
                    )}
                    {canRestore && !isCurrent && (
                      <button
                        className="btn btn-ghost history-restore-btn"
                        onClick={() => onRequestRestore(version)}
                      >
                        <IconRestore /> Вернуть эту версию
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {revealError && <div className="error-msg" role="alert">{revealError}</div>}

        <p className="modal-note">
          Старые версии паролей навсегда остаются в зашифрованной истории.
          Возврат старой версии создаёт новую версию с её содержимым.
        </p>
      </div>
    </div>
  );
}

// ─── Async restore-confirm (idle → pending → error) ─────────────────

interface SafeboxRestoreDialogProps {
  open: boolean;
  version: SafeboxEntryData | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export function SafeboxRestoreDialog({ open, version, onConfirm, onCancel }: SafeboxRestoreDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const guardedCancel = () => { if (!pending) onCancel(); };
  const containerRef = useModalA11y<HTMLDivElement>(open, guardedCancel);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) { setError(''); setPending(false); }
  }
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open || !version) return null;

  async function handleConfirm() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      const outcome = classifySaveError(err, SAVE_FALLBACK.restore);
      setError(outcome.kind === 'in_flight'
        ? 'Эта запись уже сохраняется — подождите.'
        : outcome.text);
      setPending(false);
    }
  }

  return (
    <div className="modal-overlay confirm-overlay" onClick={guardedCancel}>
      <div
        ref={containerRef}
        className="modal confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Вернуть эту версию?"
        onClick={e => e.stopPropagation()}
      >
        <h2>Вернуть эту версию?</h2>
        <p className="confirm-message">
          Содержимое выбранной версии целиком (название, логин, URL, заметка,
          пароль и вложения) станет новой текущей версией. История не
          изменится — все версии сохранятся.
        </p>
        {error && <div className="error-msg" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn btn-ghost" onClick={guardedCancel} disabled={pending}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? '...' : 'Вернуть'}
          </button>
        </div>
      </div>
    </div>
  );
}
