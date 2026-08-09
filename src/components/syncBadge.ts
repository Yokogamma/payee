import type { NoteSyncStatus, NoteSyncInfo } from '../lib/store';

/** Shown when sync is off / not set up: the note exists ONLY on this device.
 *  Never leave the card blank — a user must not mistake a local note for an
 *  eternal one and lose it by clearing the browser. */
export const LOCAL_ONLY_BADGE = {
  icon: '📱',
  label: 'Только на этом устройстве — не сохранена в блокчейне',
  className: 'sync-badge--local',
} as const;

export const SYNC_BADGE: Record<NoteSyncStatus, { icon: string; label: string; className: string }> = {
  queued:    { icon: '○',  label: 'Ожидает загрузки',            className: 'sync-badge--queued' },
  uploading: { icon: '⏳', label: 'Загружается...',              className: 'sync-badge--uploading' },
  accepted:  { icon: '⏳', label: 'Ожидает подтверждения в сети', className: 'sync-badge--accepted' },
  confirmed: { icon: '✓',  label: 'Сохранена в блокчейне',       className: 'sync-badge--confirmed' },
  error:     { icon: '⚠️', label: 'Ошибка загрузки — повторить', className: 'sync-badge--error' },
};

/** The badge for a version given its sync info and the global sync mode —
 *  shared by the feed card (current version) and the history modal rows. */
export function badgeFor(
  info: NoteSyncInfo | undefined,
  syncActive: boolean,
): { icon: string; label: string; className: string } {
  const status = info?.status ?? 'queued';
  if (syncActive) return SYNC_BADGE[status];
  return status === 'confirmed' ? SYNC_BADGE.confirmed : LOCAL_ONLY_BADGE;
}
