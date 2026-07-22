import { useEffect, useRef } from 'react';
import { useModalA11y } from '../lib/useModalA11y';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for window.confirm() (Phase 6 / 4.4): styled, keyboard-
 * accessible (Escape cancels, Tab trapped, focus returned on close — Phase 7),
 * initial focus on the SAFE action for danger dialogs, backdrop click cancels.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const containerRef = useModalA11y<HTMLDivElement>(open, onCancel);

  useEffect(() => {
    if (open) cancelRef.current?.focus(); // safe default — Enter must not destroy data
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay confirm-overlay" onClick={onCancel}>
      <div
        ref={containerRef}
        className="modal confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
