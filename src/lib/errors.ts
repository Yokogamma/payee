/**
 * User-facing error dictionary (Phase 6 / 4.3, L13).
 *
 * Transport errors carry English/HTTP text; everything the USER sees goes
 * through this map. Clock skew is detected from the server's timestamp
 * message (L13) and explained as a device-clock problem, not a generic failure.
 */
export function userFacingUploadError(kind: string, errText?: string): string {
  if (errText && /timestamp|clock|skew/i.test(errText)) {
    return 'Часы устройства расходятся с сервером. Проверьте дату и время и повторите.';
  }
  switch (kind) {
    case 'rate_limited':
      return 'Лимит загрузок исчерпан. Повторите примерно через час.';
    case 'not_registered':
      return 'Для синхронизации нужен invite-код (Настройки → Вечное хранилище).';
    case 'in_progress':
      return 'Загрузка этой заметки уже выполняется.';
    case 'unavailable':
      return 'Сервис временно недоступен. Повторим автоматически.';
    default:
      return 'Не удалось загрузить заметку. Повторим автоматически.';
  }
}
