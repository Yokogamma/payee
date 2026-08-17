/**
 * User-facing error dictionary (Phase 6 / 4.3, L13).
 *
 * Transport errors carry English/HTTP text; everything the USER sees goes
 * through this map. Clock skew is detected from the server's timestamp
 * message (L13) and explained as a device-clock problem, not a generic failure.
 */
/** Registration/invite errors → Russian, with the clock-skew hint first. */
export function userFacingRegistrationError(raw: string): string {
  if (/timestamp|clock|skew/i.test(raw)) {
    return 'Часы устройства расходятся с сервером. Проверьте дату и время и повторите.';
  }
  if (/invalid or used invite/i.test(raw)) {
    return 'Неверный или уже использованный invite-код.';
  }
  if (/too many attempts/i.test(raw)) {
    return 'Слишком много попыток. Подождите и попробуйте снова.';
  }
  return 'Не удалось активировать invite-код. Проверьте код и попробуйте ещё раз.';
}

export function userFacingUploadError(kind: string, errText?: string): string {
  if (errText && /timestamp|clock|skew/i.test(errText)) {
    return 'Часы устройства расходятся с сервером. Проверьте дату и время и повторите.';
  }
  switch (kind) {
    case 'rate_limited':
      return 'Лимит загрузок исчерпан. Повторите примерно через час.';
    case 'not_registered':
      return 'Для синхронизации нужен invite-код (в настройках, раздел «Вечное хранилище»).';
    case 'in_progress':
      return 'Загрузка этой заметки уже выполняется.';
    case 'unavailable':
      return 'Сервис временно недоступен. Повторим автоматически.';
    default:
      return 'Не удалось загрузить заметку. Повторим автоматически.';
  }
}
