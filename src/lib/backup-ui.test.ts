import { describe, it, expect, vi } from 'vitest';

// The «on» build: the flag matrix is the point of half this file, and the
// shipped pair is both-off. What must hold while they ARE off gets its own
// file, against the real flags.
vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: true,
  BACKUP_IMPORT_ENABLED: true,
}));

import {
  backupActions,
  backupErrorMessage,
  formatBytes,
  freshnessSummary,
  importPreview,
  importSummary,
  sizeNotice,
  BACKUP_NEAR_CAP_FRACTION,
  verifySummary,
  INCOMPLETE_SOURCE_WARNING,
  PHASE_ONE_SCOPE,
  VIEWER_INSTRUCTION,
} from './backup-ui';
import { BACKUP_CAP_BYTES, BackupError } from './backup';
import { SKIP_COUNTERS, type ImportCounters, type ImportReport } from './backup-import';
import type { VerifyReport } from './backup-actions';

/**
 * The sentences, one rule at a time.
 *
 * Every case below is a place where the honest sentence and the comfortable
 * sentence differ, and where the comfortable one would be acted on: a user
 * deletes an original because the app said the copy was checked, or keeps a
 * file because it said something was not restored.
 */

const at = (ts: number) => `T${ts}`; // a deterministic clock, not a timezone

const REPORT = (over: Partial<ImportCounters> = {}, incompleteRestore = false): ImportReport => {
  const counters: ImportCounters = {
    added: 0, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
    quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
    skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
    ...over,
  };
  return {
    counters,
    allFileRecordsApplied: SKIP_COUNTERS.every(k => counters[k] === 0),
    incompleteRestore,
  };
};

const VERIFY = (over: Partial<VerifyReport> = {}): VerifyReport => ({
  ok: true,
  sha256: 'a'.repeat(64),
  createdAt: 1,
  counts: { notes: 3, safebox: 2 },
  incompleteRestore: false,
  containsUnsupportedRecords: false,
  issues: [],
  ...over,
});

describe('the flag matrix decides what exists, not what is greyed out (D16)', () => {
  it('with both flags on, everything is offered', () => {
    expect(backupActions()).toEqual({ canImport: true, canExport: true, anyVisible: true });
  });
});

describe('the freshness chip says only what is known (D21)', () => {
  it('«не создавалась» when nothing was ever exported', () => {
    expect(freshnessSummary({}, at)).toEqual({
      chip: 'не создавалась',
      lines: ['Резервная копия ещё не создавалась.'],
    });
  });

  it('says «unknown» when a marker could not be read — never «not created»', () => {
    // The two are different claims, and only one of them is available: an
    // unreadable marker says nothing about whether copies exist. Rendering it
    // as «ещё не создавалась» would state a fact nobody established, about the
    // very thing the user would check before deleting an original.
    const summary = freshnessSummary({ unreadable: true }, at);

    expect(summary.chip).toBe('статус неизвестен');
    expect(summary.lines.join(' ')).toContain('неизвестно');
    expect(summary.lines.join(' ')).not.toContain('ещё не создавалась');
  });

  it('«unknown» wins even when one marker survived', () => {
    // Half an answer is not an answer: showing the surviving export marker
    // alone would read as a complete picture of the copies.
    const summary = freshnessSummary(
      { lastExport: { createdAt: 1, sha256: 'a', at: 2 }, unreadable: true },
      at,
    );
    expect(summary.chip).toBe('статус неизвестен');
  });

  it('calls an export checked ONLY when the checked bytes were those bytes', () => {
    // The dangerous sentence. «Checked» said about an export whose bytes were
    // never the ones checked is what a user relies on before deleting an
    // original — so it is gated on the digest, not on the fact that a check
    // happened at some point.
    const sha = 'deadbeef';
    const summary = freshnessSummary({
      lastExport: { createdAt: 10, sha256: sha, at: 11 },
      lastVerified: { createdAt: 10, sha256: sha, at: 20 },
    }, at);

    expect(summary.chip).toBe('проверена');
    expect(summary.lines).toEqual(['Последний экспорт подготовлен T11.', 'Этот экспорт проверен T20.']);
  });

  it('a DIFFERENT file checked gets its own line, and the export stays unchecked', () => {
    const summary = freshnessSummary({
      lastExport: { createdAt: 10, sha256: 'aaa', at: 11 },
      lastVerified: { createdAt: 5, sha256: 'bbb', at: 20 },
    }, at);

    expect(summary.chip).toBe('не проверена');
    expect(summary.lines).toEqual([
      'Последний экспорт подготовлен T11.',
      // Named by ITS OWN date — that is what lets the user tell the two apart.
      'Файл от T5 проверен T20.',
    ]);
  });

  it('a file checked with nothing ever exported here is still reported', () => {
    // A copy from another device. «Не создавалась» alone would read as «nothing
    // was ever checked», which is a different and false statement.
    const summary = freshnessSummary({ lastVerified: { createdAt: 5, sha256: 'b', at: 20 } }, at);

    expect(summary.chip).toBe('не создавалась');
    expect(summary.lines[1]).toBe('Файл от T5 проверен T20.');
  });
});

describe('size is stated in the units the cap is charged in (D17)', () => {
  it('says nothing extra while the store is small', () => {
    const notice = sizeNotice(1024 * 1024, false);
    expect(notice.warning).toBeUndefined();
    expect(notice.overCap).toBe(false);
    expect(notice.text).toContain('1.0 МБ');
  });

  it('warns BEFORE the ceiling, because nothing in this app deletes records', () => {
    const notice = sizeNotice(Math.ceil(BACKUP_CAP_BYTES * BACKUP_NEAR_CAP_FRACTION), false);
    expect(notice.warning).toContain('приближается к пределу');
    expect(notice.overCap).toBe(false);
    // And it says what «near the ceiling» actually costs — measured, not
    // guessed (step 13): seconds of frozen interface and about a gigabyte of
    // peak memory. Learning that by watching a phone kill the tab is the
    // wrong way to learn it, and the warning exists to prevent exactly that.
    expect(notice.warning).toContain('на телефоне');
  });

  it('an over-cap measurement is over cap even if the NUMBER looks fine', () => {
    // The measurement stops at the budget, so the figure it returns is small
    // by construction — trusting the number alone would report a store that
    // cannot be exported as comfortable.
    const notice = sizeNotice(1024, true);
    expect(notice.overCap).toBe(true);
    expect(notice.warning).toContain('экспорт откажет');
  });

  it('formats bytes without pretending to precision it does not have', () => {
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(2048)).toBe('2.0 КБ');
    expect(formatBytes(32 * 1024 * 1024)).toBe('32 МБ');
  });
});

describe('the import preview (D11a)', () => {
  it('leads with the blocking warning when the file admits it is partial', () => {
    const preview = importPreview(VERIFY({ incompleteRestore: true }), at);
    expect(preview.blocking).toBe(INCOMPLETE_SOURCE_WARNING);
    expect(preview.blocking).toContain('Не удаляйте исходный файл');
  });

  it('has no blocking line for a complete file', () => {
    expect(importPreview(VERIFY(), at).blocking).toBeUndefined();
  });

  it('counts the file, and says what the import will and will not do', () => {
    const preview = importPreview(VERIFY({ createdAt: 7 }), at);
    expect(preview.headline).toBe('Файл от T7: 3 заметки, 2 записи сейфа.');
    expect(preview.body.join(' ')).toContain('Здоровые локальные записи не заменяются');
    expect(preview.body.join(' ')).toContain('повторная отправка бесплатна');
  });
});

describe('the report is three lines by what the user did (§7)', () => {
  it('sums the four repair counters into one «восстановлено»', () => {
    const summary = importSummary(REPORT({
      added: 2, repaired: 1, quarantinedRepaired: 1, quarantinedDataRepaired: 1, quarantineStale: 1,
    }), false);
    expect(summary.restored).toBe('Добавлено: 2, восстановлено: 4.');
  });

  it('sums everything unapplied into ONE number with «не удаляйте файл»', () => {
    const summary = importSummary(REPORT({
      conflicts: 1, unsupported: 2, unsupportedLocal: 3, skipped: 4, quotaStopped: 5,
    }), false);
    expect(summary.notApplied).toBe('Не восстановлено: 15 — не удаляйте файл копии.');
    expect(summary.success).toBeUndefined();
  });

  it('keeps the repeatable outcomes apart from the lost ones', () => {
    // «Try again» is true for these two and false for the other five; merging
    // them would send the user to retry something no retry can fix.
    const summary = importSummary(REPORT({ deferred: 1, concurrentChange: 2 }), false);
    expect(summary.retryable).toContain('Требуется повторный импорт: 3');
    expect(summary.notApplied).toBeUndefined();
  });

  it.each(SKIP_COUNTERS)('a single %s is withheld from success AND visible to the user', counter => {
    // The invariant §7 states outright: no skip counter may be invisible, and
    // it has TWO halves. Hiding the success line is the easy one. The other is
    // that the number reaches one of the three lines — a counter added to the
    // report and forgotten by both groups here would silently vanish, and the
    // report would say «Не восстановлено: 0» over data still only in the file.
    const summary = importSummary(REPORT({ [counter]: 7 }), false);

    expect(summary.success).toBeUndefined();
    expect([summary.restored, summary.notApplied, summary.retryable].join(' ')).toContain('7');
  });

  it('withholds it for a partial SOURCE too, at seven zeroes', () => {
    // Different question: everything in the file was applied, and the file was
    // never a complete backup of the vault it descends from.
    const summary = importSummary(REPORT({ added: 5 }, true), true);
    expect(summary.success).toBeUndefined();
    expect(summary.blocking).toBe(INCOMPLETE_SOURCE_WARNING);
    // One sentence, not two: the file IS the reason, so repeating it as a
    // fact about the store would say the same thing twice and neither would
    // be read.
    expect(summary.storeIncomplete).toBeUndefined();
  });

  it('does NOT blame the file when the mark was raised by this import', () => {
    // The bug this replaces: `ImportReport.incompleteRestore` is the state of
    // the local marker afterwards — also raised by anything left unapplied —
    // and it was being rendered as «the device that made this file was itself
    // partially restored». That is a fact about somebody else's device,
    // invented from a boolean that never said it, and it sends the user
    // looking for a problem that is not there.
    const summary = importSummary(REPORT({ added: 1, quotaStopped: 2 }, true), false);

    expect(summary.blocking).toBeUndefined();
    expect(summary.storeIncomplete).toContain('Хранилище помечено');
    expect(summary.storeIncomplete).toContain('Не удаляйте файл копии');
  });

  it('splits «не восстановлено» by reason, because the reasons have different answers', () => {
    // One number is the right headline and the wrong whole answer: «не хватило
    // места» is fixed by freeing space, «не понимает эта версия» by updating,
    // «конфликт публикации» by neither.
    const summary = importSummary(REPORT({ conflicts: 1, unsupported: 2, quotaStopped: 4 }), false);

    expect(summary.notApplied).toContain('7');
    expect(summary.notAppliedReasons?.map(r => [r.label, r.count])).toEqual([
      // Named by what actually happened: `conflicts` is «the local bytes and
      // the file's bytes differ», which is not the same thing as a publication
      // conflict and must not be labelled as one.
      ['Локальная запись отличается от записи в файле', 1],
      ['Эта версия приложения не понимает запись из файла', 2],
      ['Не хватило места в хранилище', 4],
    ]);
    // And each carries what to DO — the reason exists for the advice.
    expect(summary.notAppliedReasons?.map(r => r.advice).join(' ')).toContain('Освободите место');
  });

  it('omits the reasons that did not happen', () => {
    // A list padded with zeroes is a list nobody reads to the end.
    const summary = importSummary(REPORT({ skipped: 1 }), false);
    expect(summary.notAppliedReasons).toHaveLength(1);
  });

  it('has no breakdown when nothing went unapplied', () => {
    expect(importSummary(REPORT({ deferred: 1 }), false).notAppliedReasons).toBeUndefined();
  });

  it('shows it only at seven zeroes AND a complete source', () => {
    const summary = importSummary(REPORT({ added: 5 }), false);
    expect(summary.success).toBe('Восстановление завершено полностью.');
    expect(summary.blocking).toBeUndefined();
  });
});

describe('the honest scope of phase 1', () => {
  it('says where the file goes and whose job the rest is', () => {
    // Not decoration: a backup feature that stays silent about being
    // device-local invites the reading «my notes are backed up now», which is
    // the one belief this phase must not create.
    expect(PHASE_ONE_SCOPE).toContain('куда его кладёт браузер');
    expect(PHASE_ONE_SCOPE).toContain('вне устройства');
    expect(PHASE_ONE_SCOPE).toContain('никуда её не отправляет');
  });
});

describe('the viewer instruction separates the two threats (D19)', () => {
  it('offers the neighbouring check for CORRUPTION and the separate copy for authenticity', () => {
    const text = VIEWER_INSTRUCTION.join(' ');
    expect(text).toContain('случайную порчу');
    expect(text).toContain('отдельно от файла');
    // Never the other claim: whoever can rewrite the HTML in that folder can
    // rewrite a checksum stored beside it.
    expect(text).not.toMatch(/блок.{0,40}подлинност/i);
  });
});

describe('failures become sentences that claim nothing extra', () => {
  it.each([
    ['BackupVaultLockedError', 'разблокируйте'],
    ['BackupDisabledError', 'выключена'],
    ['BackupCancelledError', 'прервана'],
    ['BackupLockUnavailableError', 'вкладками'],
    ['BackupStoreTooLargeError', 'больше предела'],
  ])('%s', (name, fragment) => {
    const error = new Error('raw');
    error.name = name;
    expect(backupErrorMessage(error)).toContain(fragment);
  });

  it('does not guess between a wrong seed phrase and damaged bytes', () => {
    // GCM cannot tell them apart, and naming one would send the user to fix
    // the wrong thing — or to throw away a file that is fine.
    const message = backupErrorMessage(new BackupError('undecryptable', 'auth failed'));
    expect(message).toContain('другой seed-фразы');
    expect(message).toContain('повреждён');
    expect(message).toContain('не удаляйте файл');
  });

  it('an unknown failure says nothing about the file at all', () => {
    // The default is the one that matters: «копия повреждена» said about a
    // full disk would have the user throw away a working file.
    const message = backupErrorMessage(new Error('QuotaExceededError'));
    expect(message).toContain('Файл копии не изменялся');
    expect(message).not.toMatch(/поврежд/i);
  });
});

describe('a verify has THREE answers, not two', () => {
  it('a healthy file is simply in order', () => {
    const summary = verifySummary(VERIFY(), at);
    expect(summary.tone).toBe('ok');
    expect(summary.issues).toEqual([]);
  });

  it('«intact but narrower» is its own answer, not a defect', () => {
    // `report.ok` folds three questions into one boolean — intact, complete,
    // every record readable — which is right for the freshness marker and
    // wrong for a person. Nothing about this file is broken, and putting it in
    // the same red box as a corrupted one invites its owner to throw away the
    // best copy they have.
    const summary = verifySummary(VERIFY({ ok: false, incompleteRestore: true }), at);

    expect(summary.tone).toBe('incomplete');
    expect(summary.headline).toContain('цел и читается целиком');
    expect(summary.headline).toContain('ЗАВЕДОМО НЕПОЛОН');
    expect(summary.headline).not.toContain('проблемы');
  });

  it('a damaged record is NOT told to wait for a newer version', () => {
    // The advice that used to be given for every failure. It is true for one
    // reason only — a record this build is too old to read — and false for
    // damage, which no version will ever open.
    const summary = verifySummary(VERIFY({
      ok: false,
      issues: [{ kind: 'note', id: 'a', problem: 'undecryptable' }],
    }), at);

    expect(summary.tone).toBe('bad');
    expect(summary.issues).toHaveLength(1);
    expect(summary.issues[0].text).toContain('не лечится обновлением');
    expect(summary.issues[0].text).not.toContain('более новая версия приложения сможет');
  });

  it('…but a record from a NEWER build is, and blocks', () => {
    const summary = verifySummary(VERIFY({
      ok: false,
      issues: [{ kind: 'note', id: 'a', problem: 'unsupported_version' }],
    }), at);

    expect(summary.issues[0].blocking).toBe(true);
    expect(summary.issues[0].text).toContain('более новая версия приложения');
  });

  it('a broken graph gets the reason that fits it, and no upgrade advice', () => {
    const summary = verifySummary(VERIFY({
      ok: false,
      issues: [{ kind: 'note', id: 'a', problem: 'chain', detail: 'missing_prev' }],
    }), at);

    expect(summary.issues[0].text).toContain('несходящимися связями');
    expect(summary.issues[0].text).not.toContain('обновит');
  });
});

describe('the sticky marker is described as sticky', () => {
  it('does not promise a removal the import can never perform', () => {
    // `incompleteRestore` is cleared only when the import STARTED with the
    // mark absent — so once a store carries it, no repeat import takes it off.
    // Telling the user «повторите импорт и пометка снимется» sends them to do
    // something that cannot work, twice, on the data they are most worried
    // about.
    const summary = importSummary(REPORT({ added: 1, quotaStopped: 1 }, true), false);

    expect(summary.storeIncomplete).toContain('ЛИПКАЯ');
    expect(summary.storeIncomplete).toContain('чистом устройстве');
    expect(summary.storeIncomplete).not.toContain('пометка снимется, когда');
  });
});
