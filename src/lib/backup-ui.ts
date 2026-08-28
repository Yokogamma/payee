/**
 * Eternal Notes — what the backup block SAYS, as a module rather than as JSX.
 *
 * Every rule in §7 is a rule about words: which sentence is allowed to appear
 * next to which state, which number is a sum of which counters, and which
 * statement may not be made at all. Those are decisions, and decisions belong
 * somewhere they can be checked one at a time — a `&&` in a template renders
 * fine while saying something false, and nothing in a component test would
 * notice as long as the markup matched.
 *
 * Three of these rules exist because the honest sentence and the reassuring
 * sentence differ:
 *
 *  - a checked file is only «this export, checked» when the SHA-256 matches;
 *    otherwise the app checked SOME file, and says which one (D21);
 *  - an import shows a success only when all seven skip counters are zero AND
 *    the file was not itself made by a partial restore (§4, criterion 5);
 *  - the neighbouring verification block is never presented as proof of
 *    AUTHENTICITY: whoever can rewrite the saved HTML can rewrite a checksum
 *    saved beside it (D19).
 */

import { BACKUP_CAP_BYTES } from './backup';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from './flags';
import { SKIP_COUNTERS, type ImportReport } from './backup-import';
import type { VerifyReport } from './backup-actions';

/** D21's `meta` record: which file, and when it was made or checked. */
export interface BackupArtifactMarker {
  /** When the CONTAINER was created — the file's own date. */
  createdAt: number;
  sha256: string;
  /** When this app did the thing the marker records. */
  at: number;
}

export interface BackupFreshness {
  lastExport?: BackupArtifactMarker;
  lastVerified?: BackupArtifactMarker;
}

/** Dates as words, injectable so the rules can be tested without a timezone. */
export type MomentFormatter = (timestamp: number) => string;

export const formatMoment: MomentFormatter = ts => new Date(ts).toLocaleString('ru');

// ─── Which buttons exist at all (D16) ───────────────────────────────

export interface BackupActionSet {
  /** «Проверить файл копии» and «Импортировать из файла». */
  readonly canImport: boolean;
  /** «Скачать резервную копию» and «Скачать просмотрщик». */
  readonly canExport: boolean;
  /** Anything at all — and therefore whether the viewer instruction is shown. */
  readonly anyVisible: boolean;
}

/**
 * The flag matrix, read fail-closed.
 *
 * `canExport` requires BOTH flags, not just the export one. The combination
 * «export ON / import OFF» is forbidden and a build check rejects it, but the
 * check is a build step and this is the behaviour: an export the user can
 * neither verify nor import produces files that are worse than no files, so if
 * that pair ever reaches a browser the whole block stays dark rather than
 * offering the half that misleads.
 */
export function backupActions(): BackupActionSet {
  const canImport = BACKUP_IMPORT_ENABLED;
  const canExport = BACKUP_EXPORT_ENABLED && BACKUP_IMPORT_ENABLED;
  return { canImport, canExport, anyVisible: canImport || canExport };
}

// ─── The freshness chip (D21) ───────────────────────────────────────

export interface FreshnessSummary {
  /** The one word the collapsed header carries. */
  chip: string;
  /** Full sentences for the open block, in order. */
  lines: string[];
}

/**
 * What is known about the last copy — and only what is known.
 *
 * The SHA-256 comparison is the whole point. «Checked» said about an export
 * whose bytes were never the ones checked is the single most dangerous
 * sentence this block could print: it is the sentence a user relies on before
 * deleting an original.
 */
export function freshnessSummary(
  { lastExport, lastVerified }: BackupFreshness,
  format: MomentFormatter = formatMoment,
): FreshnessSummary {
  if (!lastExport) {
    return {
      chip: 'не создавалась',
      lines: lastVerified
        // Nothing was ever exported FROM HERE, yet a file was checked here —
        // a copy from another device, and worth saying so plainly rather than
        // letting «не создавалась» read as «nothing was ever checked».
        ? [
          'Резервная копия с этого устройства ещё не создавалась.',
          `Файл от ${format(lastVerified.createdAt)} проверен ${format(lastVerified.at)}.`,
        ]
        : ['Резервная копия ещё не создавалась.'],
    };
  }

  const lines = [`Последний экспорт подготовлен ${format(lastExport.at)}.`];
  if (lastVerified && lastVerified.sha256 === lastExport.sha256) {
    lines.push(`Этот экспорт проверен ${format(lastVerified.at)}.`);
    return { chip: 'проверена', lines };
  }
  if (lastVerified) {
    // Some file was checked, and it was not this one. Naming it by its own
    // creation date is what lets the user tell the two apart.
    lines.push(`Файл от ${format(lastVerified.createdAt)} проверен ${format(lastVerified.at)}.`);
  }
  return { chip: 'не проверена', lines };
}

// ─── Size (D17) ─────────────────────────────────────────────────────

/** Above this share of the cap the block warns. Deletion does not exist in
 *  this app — the volume only grows — so the refusal must never be the first
 *  time the user hears about the ceiling. */
export const BACKUP_NEAR_CAP_FRACTION = 0.8;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
}

export interface SizeNotice {
  /** «Предполагаемый размер: 4,2 МБ». */
  text: string;
  /** Present once the store is close to — or past — the ceiling. */
  warning?: string;
  /** Past the ceiling: the export will refuse, and the block says so before
   *  the user finds out by pressing the button. */
  overCap: boolean;
}

export function sizeNotice(expectedFileBytes: number, overCap: boolean): SizeNotice {
  const text = `Предполагаемый размер файла: ${formatBytes(expectedFileBytes)}`;
  if (overCap || expectedFileBytes > BACKUP_CAP_BYTES) {
    return {
      text,
      overCap: true,
      warning: `Это больше предела в ${formatBytes(BACKUP_CAP_BYTES)}: экспорт откажет. `
        + 'Хранилища такого объёма фаза 1 не поддерживает — понадобится следующая версия формата.',
    };
  }
  if (expectedFileBytes >= BACKUP_CAP_BYTES * BACKUP_NEAR_CAP_FRACTION) {
    return {
      text,
      overCap: false,
      // The second sentence is a measurement, not a guess: at the ceiling a
      // desktop spends ~5.5 s exporting and ~6.6 s importing with the tab
      // frozen and about a gigabyte of peak memory (step 13). A phone has
      // neither the seconds nor the memory, and finding that out by watching
      // the tab die is the wrong way to learn it.
      warning: `Копия приближается к пределу в ${formatBytes(BACKUP_CAP_BYTES)}. `
        + 'Записи не удаляются, поэтому объём только растёт. Рядом с пределом создание и '
        + 'проверка копии занимают несколько секунд с замершим интерфейсом и требуют около '
        + 'гигабайта памяти — на телефоне вкладка может не справиться, делайте копию на компьютере.',
    };
  }
  return { text, overCap: false };
}

// ─── The import preview ─────────────────────────────────────────────

export interface ImportPreview {
  /** Shown FIRST and marked as an alert when the file admits it is partial. */
  blocking?: string;
  /** «Файл от 12.08.2026: 120 заметок, 8 записей сейфа». */
  headline: string;
  /** What the import will and will not do, in the user's terms. */
  body: string[];
  /** Records this build cannot read at all — worth naming before the import,
   *  because their fate is decided by the user's decision to keep the file. */
  issues?: string;
}

export const INCOMPLETE_SOURCE_WARNING =
  'Эта копия заведомо неполна: устройство, которое её создало, само восстанавливалось '
  + 'не полностью. Не удаляйте исходный файл, из которого восстанавливались.';

export function importPreview(
  report: VerifyReport,
  format: MomentFormatter = formatMoment,
): ImportPreview {
  return {
    blocking: report.incompleteRestore ? INCOMPLETE_SOURCE_WARNING : undefined,
    headline: `Файл от ${format(report.createdAt)}: ${plural(report.counts.notes, 'заметка', 'заметки', 'заметок')}, `
      + `${plural(report.counts.safebox, 'запись сейфа', 'записи сейфа', 'записей сейфа')}.`,
    body: [
      'Здоровые локальные записи не заменяются и ничего не удаляется; повреждённые могут быть '
      + 'восстановлены из файла.',
      'Записи без подтверждённого состояния синхронизации будут поставлены в очередь; если такая '
      + 'запись уже принята сервером, повторная отправка бесплатна. В редких авариях (запись о ней '
      + 'утрачена на сервере) возможна новая платная публикация.',
    ],
    issues: report.issues.length > 0
      ? `Записей с проблемами в файле: ${report.issues.length}. Они не будут восстановлены — `
        + 'сохраните файл, более новая версия приложения может их открыть.'
      : undefined,
  };
}

// ─── The report: three lines by what the USER did ───────────────────

/** One reason a record went unapplied, with the advice that follows from it. */
export interface NotAppliedReason {
  label: string;
  count: number;
  /** What the user can actually DO about this one. */
  advice: string;
}

export interface ImportSummary {
  /** «Добавлено: N, восстановлено: M» — always shown. */
  restored: string;
  /** Everything unapplied, together. Blocking: the file must be kept. */
  notApplied?: string;
  /**
   * The same number, split by reason — shown behind a disclosure (§7).
   *
   * One number is the right headline and the wrong whole answer: «не хватило
   * места» is fixed by freeing space and retrying, «не понимает эта версия» by
   * updating the app, and «конфликт публикации» by neither. A user who cannot
   * tell them apart cannot act on any of them, and the summary would be
   * telling them to keep a file forever for reasons it declines to name.
   *
   * Only non-zero reasons appear: a list padded with zeroes is a list nobody
   * reads to the end.
   */
  notAppliedReasons?: NotAppliedReason[];
  /** Outcomes that a second import can still fix. */
  retryable?: string;
  /** Shown ONLY at seven zeroes AND a source that was not itself partial. */
  success?: string;
  /** The file's own admission, repeated here (D11a). */
  blocking?: string;
}

/** The counters that mean «this record was put right», in the plan's order. */
const RESTORED_KEYS = [
  'repaired', 'quarantinedRepaired', 'quarantinedDataRepaired', 'quarantineStale',
] as const;

/**
 * Everything unapplied — as ONE number in the headline, and as these five
 * reasons behind the disclosure.
 *
 * The eleven internal counters are a diagnostic, and a user reading eleven of
 * them cannot tell which ones mean «your data is still only in the file». But
 * collapsing to one number and stopping there loses the only thing the user
 * can act on, so the split is the same list, kept in one place: adding a
 * counter to `NOT_APPLIED_KEYS` without a sentence here is impossible, because
 * the keys ARE this list.
 */
const NOT_APPLIED_REASONS = [
  {
    key: 'conflicts',
    label: 'Конфликт публикации',
    advice: 'Локальная запись и запись из файла разошлись на цепочке. Автоматического '
      + 'разрешения в этой версии нет — сохраните файл.',
  },
  {
    key: 'unsupported',
    label: 'Эта версия приложения не понимает запись из файла',
    advice: 'Обновите приложение и повторите импорт того же файла — более новая версия '
      + 'может её восстановить.',
  },
  {
    key: 'unsupportedLocal',
    label: 'Локальная запись новее, чем понимает это приложение',
    advice: 'Она не заменяется намеренно, чтобы не затереть то, что записала более новая '
      + 'версия. Обновите приложение.',
  },
  {
    key: 'skipped',
    label: 'Запись повреждена или неправильной формы',
    advice: 'Восстановить её эта версия не может. Файл сохраните: более новая может.',
  },
  {
    key: 'quotaStopped',
    label: 'Не хватило места в хранилище',
    advice: 'Освободите место на устройстве и повторите импорт того же файла — импорт '
      + 'остановился, а не сломался.',
  },
] as const satisfies readonly { key: keyof ImportReport['counters']; label: string; advice: string }[];

const NOT_APPLIED_KEYS = NOT_APPLIED_REASONS.map(r => r.key);

/** Repeatable outcomes: a send was in flight, or another tab changed the data.
 *  Both are answered by importing the same file again. */
const RETRYABLE_KEYS = ['deferred', 'concurrentChange'] as const;

export function importSummary(report: ImportReport): ImportSummary {
  const sum = (keys: readonly (keyof ImportReport['counters'])[]) =>
    keys.reduce((total, key) => total + report.counters[key], 0);

  const notApplied = sum(NOT_APPLIED_KEYS);
  const retryable = sum(RETRYABLE_KEYS);
  // Derived from the shared list, not from a second one written out here: a
  // counter added there and forgotten here would be a counter invisible to the
  // user, which is the one thing §7 forbids outright.
  const everythingApplied = SKIP_COUNTERS.every(key => report.counters[key] === 0);

  return {
    restored: `Добавлено: ${report.counters.added}, восстановлено: ${sum(RESTORED_KEYS)}.`,
    notApplied: notApplied > 0
      ? `Не восстановлено: ${notApplied} — не удаляйте файл копии.`
      : undefined,
    notAppliedReasons: notApplied > 0
      ? NOT_APPLIED_REASONS
        .map(r => ({ label: r.label, advice: r.advice, count: report.counters[r.key] }))
        .filter(r => r.count > 0)
      : undefined,
    retryable: retryable > 0
      ? `Требуется повторный импорт: ${retryable}. Данные изменились или отправлялись во время `
        + 'импорта — повторите импорт того же файла.'
      : undefined,
    // Two conditions, and the second is not a formality: a file made by a
    // partial restore can apply perfectly and still leave the store narrower
    // than the vault it ultimately came from.
    success: everythingApplied && !report.incompleteRestore
      ? 'Восстановление завершено полностью.'
      : undefined,
    blocking: report.incompleteRestore ? INCOMPLETE_SOURCE_WARNING : undefined,
  };
}

// ─── The permanent viewer instruction (D19) ─────────────────────────

/**
 * Not a readiness label — an instruction, shown whenever any backup button is.
 *
 * The two threats are separated because the answers differ, and conflating
 * them would sell the neighbouring verification block as something it is not.
 * Corruption is caught by comparing the file with a checksum the app holds;
 * SUBSTITUTION is not, because whoever can rewrite the file in that folder can
 * rewrite anything else stored in the same folder.
 */
export const VIEWER_INSTRUCTION = [
  'Для чтения копии без приложения нужен просмотрщик — скачайте его и храните рядом с файлом копии.',
  'Блок проверки рядом с ним ловит случайную порчу файла.',
  'Чтобы проверить подлинность — сохраните контрольную сумму отдельно от файла: в менеджере паролей '
  + 'или на бумаге рядом с seed-фразой.',
];

/** Phase 1 is honest about where the file goes: nowhere but the download
 *  folder. Off-device storage is the user's job until phases 3–4. */
export const PHASE_ONE_SCOPE =
  'Файл сохраняется туда, куда его кладёт браузер. Хранить копию вне устройства — пока задача '
  + 'пользователя: приложение никуда её не отправляет.';

// ─── What went wrong, in the user's terms ───────────────────────────

/**
 * Every failure this block can produce, mapped to one sentence.
 *
 * Matched by error NAME and by `code`, the same duck-typing the classifier
 * uses for cancellation — and for the same reason: this module holds the
 * words, and importing the modules that hold the machinery to name their error
 * classes would drag storage and crypto behind the sentences.
 *
 * The default matters as much as the cases. An unrecognized failure gets a
 * sentence that claims nothing about the file, because the one thing this UI
 * must never do is invent a diagnosis: «копия повреждена» said about a full
 * disk would have the user throw away a working file.
 */
export function backupErrorMessage(error: unknown): string {
  const named = error as { name?: unknown; code?: unknown; message?: unknown };
  switch (named?.name) {
    case 'BackupVaultLockedError':
      return 'Хранилище заблокировано — разблокируйте его и повторите.';
    case 'BackupDisabledError':
      return 'Эта возможность выключена в текущей версии приложения.';
    case 'BackupCancelledError':
      return 'Операция прервана: хранилище было заблокировано, сброшено или страница закрыта.';
    case 'BackupLockUnavailableError':
      return 'Этот браузер не умеет разделять импорт между вкладками, поэтому импорт не начат. '
        + 'Откройте приложение в более новом браузере.';
    case 'BackupStoreTooLargeError':
      return `Хранилище больше предела в ${formatBytes(BACKUP_CAP_BYTES)} — копию такого размера `
        + 'фаза 1 создать не может.';
    case 'ViewerDeliveryError':
      // Already written for the user, and more specific than anything that
      // could be reconstructed from the reason code here.
      return typeof named.message === 'string' ? named.message : 'Не удалось загрузить просмотрщик.';
    case 'BackupError':
      return containerErrorMessage(named.code);
    default:
      return 'Не удалось выполнить действие. Файл копии не изменялся — попробуйте ещё раз.';
  }
}

function containerErrorMessage(code: unknown): string {
  switch (code) {
    case 'too_large':
      return `Файл больше предела в ${formatBytes(BACKUP_CAP_BYTES)} — эта версия его не открывает.`;
    case 'not_a_container':
      return 'Это не файл резервной копии Eternal Notes.';
    case 'too_new':
      return 'Файл создан более новой версией приложения. Обновите приложение и повторите.';
    case 'undecryptable':
      // GCM cannot tell a wrong key from damaged bytes, and guessing which one
      // it was would send the user to fix the wrong thing.
      return 'Файл не открылся: он либо от другой seed-фразы, либо повреждён. '
        + 'Проверьте, что это копия ЭТОГО хранилища, и не удаляйте файл.';
    case 'corrupt':
      return 'Файл открылся, но его содержимое несогласованно — восстановление по нему небезопасно. '
        + 'Не удаляйте файл: более новая версия приложения может справиться.';
    case 'unsupported_value':
      return 'В хранилище есть запись, которую этот формат копии не может перенести без потерь. '
        + 'Копия не создана.';
    default:
      return 'Файл резервной копии не удалось обработать.';
  }
}

// ─── Small helpers ──────────────────────────────────────────────────

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}
