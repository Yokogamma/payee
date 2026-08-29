import { useEffect, useRef, useState, type RefObject } from 'react';
import { formatVersionStamp } from '../lib/format-date';
import { useModalA11y } from '../lib/useModalA11y';
import { badgeFor } from './syncBadge';
import { type NoteSyncInfo } from '../lib/store';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import type { NoteChain } from '../lib/chains';
import type { NoteData } from '../lib/crypto';
import { IconClose, InfinityMark } from './icons';

/**
 * The version INDEX of one chain, current-first.
 *
 * It used to be a reader as well: a row expanded in place and offered
 * «Восстановить эту версию» at the bottom of what it revealed. Two things were
 * wrong with that, and only one of them was a bug.
 *
 * The bug: every row is a flex item, and `overflow: hidden` (there to clip the
 * rounded corners) zeroes a flex item's automatic minimum size. The list, being
 * a scroll container itself, has the same property — so when the modal hit its
 * `max-height` the shortfall was passed down and the rows were CRUSHED instead
 * of the list scrolling. Measured at 17.6px of row around a 37.3px button; the
 * restore control was simply cut off. `.history-row { flex: none }` is the fix,
 * and the safebox history — which still expands in place — needed it too.
 *
 * The design mistake outlived the bug: even uncrushed, the expanded body ran to
 * 687px inside a 342px window, so the button sat half a screen below the fold
 * of a scroller inside a modal. A version is a page. So a row NAVIGATES now:
 * the index says when and which, the version opens on its own screen, and the
 * decision to bring it back is taken there, after reading it.
 *
 * What went with the expansion: `expandedId`, `focusVersionId`, and the dance
 * where Main closed this modal, opened the confirm, and reopened this modal
 * focused on the same row. The version page is a grid state, not a layer, so
 * the confirm opens straight over it.
 */

interface VersionHistoryModalProps {
  open: boolean;
  chain: NoteChain | null;
  syncStatuses: Record<string, NoteSyncInfo>;
  syncActive: boolean;
  onClose: () => void;
  /** Open the version at `ordinal` (1 = oldest). Main routes the CURRENT one
   *  to the note itself — there is nothing to bring back from it. */
  onOpenVersion: (ordinal: number) => void;
  /** Where focus goes on close when whatever opened this is gone. Entering from
   *  the feed's card menu unmounts the whole feed, so «back to the trigger»
   *  would land on `document.body`. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function VersionHistoryModal({
  open,
  chain,
  syncStatuses,
  syncActive,
  onClose,
  onOpenVersion,
  returnFocusRef,
}: VersionHistoryModalProps) {
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose, { fallbackRef: returnFocusRef });
  const firstRowRef = useRef<HTMLButtonElement>(null);

  // Initial focus is the caller's job — the hook never steals it. The first
  // row is the current version, which is both the top of the list and the most
  // likely destination.
  useEffect(() => {
    if (open) requestAnimationFrame(() => firstRowRef.current?.focus());
  }, [open]);

  if (!open || !chain) return null;

  const total = chain.versions.length;
  // Same source as each row's own badge, so the closing sentence can never
  // contradict the statuses printed right above it.
  const allPermanent = chain.versions.every(
    v => badgeFor(syncStatuses[v.id], syncActive).permanent,
  );

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
          <button className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть"><IconClose /></button>
        </div>

        <div className="history-list">
          {chain.versions.map((version, i) => {
            const ordinal = total - i; // current-first → «Версия N из N» on top
            const isCurrent = i === 0;
            const badge = badgeFor(syncStatuses[version.id], syncActive);
            // ABSOLUTE, with the clock. Three versions written within an hour
            // print «40 / 41 / 42 мин назад» under the relative formatter —
            // ordered, but placed nowhere, and the order is already the list's
            // job.
            const stamp = formatVersionStamp(version.createdAt);
            return (
              <div key={version.id} className="history-row">
                <button
                  ref={isCurrent ? firstRowRef : undefined}
                  className="history-row-head"
                  onClick={() => onOpenVersion(ordinal)}
                  aria-label={`Открыть версию ${ordinal} из ${total} от ${stamp}`}
                >
                  <span className="history-row-title">{stamp}</span>
                  <span className="history-row-meta">
                    <span className="state state--quiet">
                      Версия {ordinal} из {total}
                      {/* Текущую называет СЛОВО, а не рамка вокруг строки:
                          записи здесь разделены линейкой, как в ленте, и
                          коробки, которую можно было бы подсветить, больше
                          нет. */}
                      {isCurrent && <span className="history-current-mark"> · текущая</span>}
                    </span>
                    <span
                      className={`state sync-state ${badge.className}`}
                      title={badge.label}
                      aria-label={badge.label}
                    >
                      {badge.permanent && <InfinityMark />}
                      {badge.word}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {/* «Каждая версия навсегда сохранена в блокчейне» stood here
            unconditionally — directly under rows that can read «на устройстве»,
            «в очереди» or «ошибка». Eternity is a claim, and it is made in
            exactly one place in this app: a CONFIRMED status. Same rule as the
            ∞ mark beside each row and as the composer's destination sentence. */}
        <p className="modal-note">
          {allPermanent
            ? 'Каждая версия навсегда сохранена в блокчейне.'
            : 'Опубликованную версию изменить нельзя. Версии со статусом «на устройстве», «в очереди» или «ошибка» ещё не сохранены в блокчейне.'}{' '}
          Возврат старой версии создаёт новую версию с её текстом.
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

  // Fresh lifecycle per opening — adjusted during render (not in an effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setError('');
      setPending(false);
    }
  }
  useEffect(() => {
    if (open) cancelRef.current?.focus(); // safe default, like ConfirmDialog
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
      // This dialog STAYS OPEN, so in_flight gets a gentle wait notice here
      // (unlike the composer surfaces, where silence is the right answer).
      setError(outcome.kind === 'in_flight'
        ? 'Эта заметка уже сохраняется — подождите.'
        : outcome.text);
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
        aria-label="Вернуть эту версию?"
        onClick={e => e.stopPropagation()}
      >
        <h2>Вернуть эту версию?</h2>
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
            {pending ? '...' : 'Вернуть'}
          </button>
        </div>
      </div>
    </div>
  );
}
