import type { NoteSyncStatus, NoteSyncInfo } from '../lib/store';

/**
 * Sync state as WORDS.
 *
 * It used to be a glyph: ○ ⏳ ✓ ⚠️ 📱. Five symbols carrying five different
 * facts, three of them platform emoji that arrived in colour beside a
 * monochrome interface, and none of them legible without the tooltip that
 * held the actual sentence. The redesign states status in language — «∞
 * навечно», «отправляется…», «на устройстве» — because that is the one form
 * that needs no legend.
 *
 * `word` is what the card prints; `label` stays the full sentence for the
 * tooltip and assistive tech, where there is room to be explicit.
 *
 * `permanent` drives the ∞ mark, and it is the ONLY status that gets it. The
 * mark is a claim about eternity and it must not appear on a note that is
 * merely on its way — see the same rule in StatusLine.
 */

export interface SyncBadge {
  /** Printed on the card, next to the mark when `permanent`. */
  word: string;
  /** Full sentence — tooltip and accessible name. */
  label: string;
  /** Whether the ∞ mark precedes the word. */
  permanent: boolean;
  className: string;
}

/** Sync is off or was never set up: the note exists ONLY on this device.
 *  Never leave the card blank — a user must not mistake a local note for an
 *  eternal one and lose it by clearing the browser. */
export const LOCAL_ONLY_BADGE: SyncBadge = {
  word: 'на устройстве',
  label: 'Только на этом устройстве — не сохранена в блокчейне',
  permanent: false,
  className: 'sync-state--local',
};

export const SYNC_BADGE: Record<NoteSyncStatus, SyncBadge> = {
  queued: {
    word: 'в очереди',
    label: 'Ожидает загрузки',
    permanent: false,
    className: 'sync-state--queued',
  },
  uploading: {
    word: 'отправляется…',
    label: 'Загружается в блокчейн',
    permanent: false,
    className: 'sync-state--busy',
  },
  accepted: {
    // Deliberately the SAME word as `uploading`. The difference between «sent»
    // and «sent and awaiting network confirmation» is real, and it is a
    // distinction the network makes, not one the reader can act on. The
    // tooltip keeps it; the card does not spend a line on it.
    word: 'отправляется…',
    label: 'Отправлена, ожидает подтверждения в сети',
    permanent: false,
    className: 'sync-state--busy',
  },
  confirmed: {
    word: 'навечно',
    label: 'Сохранена в блокчейне навсегда',
    permanent: true,
    className: 'sync-state--permanent',
  },
  error: {
    word: 'ошибка',
    // THE FACT, not the offer. This badge appears in three places and only one
    // of them can retry: the feed card wraps it in a real <button> and appends
    // «— повторить» itself. The history modals render it inside the row's
    // expand <button> (a nested button is invalid HTML), where pressing it
    // opens the version and retries nothing — so promising a retry there was
    // simply untrue, to screen readers most of all.
    label: 'Ошибка загрузки',
    permanent: false,
    className: 'sync-state--error',
  },
};

/**
 * The badge for a version given its sync info and the global sync mode —
 * shared by the feed card (current version) and the history modal rows.
 *
 * A CONFIRMED note keeps its badge when sync is switched off. It really is on
 * chain; the switch governs uploads, not history, and telling the user their
 * permanent note is now «на устройстве» would be a lie they might act on.
 */
export function badgeFor(info: NoteSyncInfo | undefined, syncActive: boolean): SyncBadge {
  const status = info?.status ?? 'queued';
  if (syncActive) return SYNC_BADGE[status];
  return status === 'confirmed' ? SYNC_BADGE.confirmed : LOCAL_ONLY_BADGE;
}
