import { OperationInFlightError } from './store';
import { NoteTooLongError } from './limits';

/**
 * Single source of truth for the save/edit/restore-version error UX. Three
 * surfaces (Main composer, EditNoteModal, RestoreVersionDialog) share the
 * same subtle rules; keeping them in one place keeps the copy consistent and
 * the trickiest rule — OperationInFlightError — single-sourced:
 *
 *  - 'in_flight': a duplicate submit raced past the disabled button. The
 *    FIRST call owns the outcome — the caller must change NOTHING (no error
 *    text, no cleared draft, no closed modal). Surfaces that stay open may
 *    show a gentle wait notice instead of silence.
 *  - 'message': show the text inline, keep the user's text intact.
 */
export type SaveErrorOutcome =
  | { kind: 'in_flight' }
  | { kind: 'message'; text: string };

const TOO_LONG_MESSAGE = 'Заметка слишком длинная — сократите текст (лимит ~30 000 байт).';

export function classifySaveError(err: unknown, fallback: string): SaveErrorOutcome {
  if (err instanceof OperationInFlightError) return { kind: 'in_flight' };
  if (err instanceof NoteTooLongError) return { kind: 'message', text: TOO_LONG_MESSAGE };
  console.error('save failed:', err);
  return { kind: 'message', text: fallback };
}

/** Per-operation generic fallbacks (the only part that differs per surface). */
export const SAVE_FALLBACK = {
  add: 'Не удалось сохранить заметку. Попробуйте ещё раз.',
  edit: 'Не удалось сохранить версию. Попробуйте ещё раз.',
  restore: 'Не удалось вернуть версию. Попробуйте ещё раз.',
} as const;
