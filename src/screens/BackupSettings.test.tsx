// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// The «on» build — the block does not exist otherwise, and what it looks like
// then is the subject of the sibling file against the REAL flags.
vi.mock('../lib/flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: true,
  BACKUP_IMPORT_ENABLED: true,
}));

// jsdom has no download. What matters is WHAT would have been handed over.
vi.mock('../lib/download', () => ({ saveText: vi.fn(), saveBlob: vi.fn() }));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { BackupSettings } from './BackupSettings';
import { saveText } from '../lib/download';
import * as viewerHash from '../lib/backup-viewer-hash';
import type { VerifyReport } from '../lib/backup-actions';
import type { ImportCounters, ImportReport } from '../lib/backup-import';

/**
 * The block as the user meets it.
 *
 * The words themselves are proven in `backup-ui.test.ts`; what is proven here
 * is the wiring around them — that the second stage applies the session the
 * first produced, that a blocking warning precedes the button it is about,
 * that a failure to record a marker does not read as a failure to produce a
 * file, and that nothing is offered when the release is off (sibling file).
 */

const VERIFY = (over: Partial<VerifyReport> = {}): VerifyReport => ({
  ok: true,
  sha256: 'a'.repeat(64),
  createdAt: 1_756_000_000_000,
  counts: { notes: 3, safebox: 2 },
  incompleteRestore: false,
  containsUnsupportedRecords: false,
  issues: [],
  ...over,
});

const REPORT = (over: Partial<ImportCounters> = {}, incompleteRestore = false): ImportReport => ({
  counters: {
    added: 0, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
    quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
    skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
    ...over,
  },
  allFileRecordsApplied: true,
  incompleteRestore,
});

/** A stand-in for the prepared SESSION. Identity is the assertion: stage B
 *  must be handed this object, not a fresh one built from the same file. */
const prepared = (report: VerifyReport) => ({ report, plannedCount: 1, apply: vi.fn() });

const FILE = new File(['{}'], 'backup.json', { type: 'application/json' });

function fill(over: Record<string, unknown> = {}) {
  h.store = {
    exportBackupFile: vi.fn(async () => ({
      exported: { text: '{"container":true}', fileName: 'eternal-notes-backup-2026-08-28.json', artifact: { createdAt: 1, sha256: 'x', at: 2 } },
      markerRecorded: true,
    })),
    verifyBackupFile: vi.fn(async () => ({ report: VERIFY(), markerRecorded: true })),
    prepareBackupImport: vi.fn(async () => prepared(VERIFY())),
    applyBackupImport: vi.fn(async () => ({ report: REPORT({ added: 3 }), viewRefreshed: true })),
    readBackupFreshness: vi.fn(async () => ({})),
    estimateBackupSize: vi.fn(async () => ({ expectedFileBytes: 1024 * 1024, overCap: false })),
    downloadBackupViewer: vi.fn(async () => ({ text: '<html>', fileName: 'viewer.html', sha256: 'b'.repeat(64) })),
    ...over,
  };
}

/** Render and open the block — the body is collapsed by design. */
async function open() {
  render(<BackupSettings />);
  await act(async () => { fireEvent.click(screen.getByText('Резервная копия')); });
}

/** Pick a file through one of the two hidden inputs. */
async function choose(label: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [FILE], configurable: true });
  await act(async () => { fireEvent.change(input); });
}

beforeEach(() => { fill(); vi.mocked(saveText).mockClear(); });
afterEach(() => {
  cleanup();
  // `restoreAllMocks` undoes `spyOn`, and nothing else here needs it — but
  // without it the checksum spy from one test decides the verdict of the next,
  // which is exactly how the placeholder case would go green while broken.
  vi.restoreAllMocks();
});

describe('what the block offers with both flags on', () => {
  it('shows all four actions and the permanent viewer instruction', async () => {
    await open();

    expect(screen.getByRole('button', { name: 'Скачать резервную копию' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Скачать просмотрщик' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Проверить файл копии' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Импортировать из файла' })).toBeTruthy();
    // An instruction, not a readiness label: present before any export exists,
    // which is exactly when it is worth reading.
    expect(screen.getByText(/храните рядом с файлом копии/)).toBeTruthy();
  });

  it('says where the file goes and whose job the rest is (§7)', async () => {
    // A backup feature silent about being device-local invites «my notes are
    // backed up now» — the one belief this phase must not create.
    await open();
    expect(screen.getByText(/Хранить копию вне устройства/)).toBeTruthy();
  });

  it('shows the viewer checksum so it CAN be stored separately (D19)', async () => {
    // The instruction asks the user to keep the checksum somewhere
    // independent. That is not a request one can honour if the value is
    // nowhere on screen.
    vi.spyOn(viewerHash, 'BACKUP_VIEWER_HASH_IS_PLACEHOLDER', 'get').mockReturnValue(false);
    vi.spyOn(viewerHash, 'BACKUP_VIEWER_SHA256', 'get').mockReturnValue('f'.repeat(64));

    await open();

    expect(screen.getByText('f'.repeat(64))).toBeTruthy();
  });

  it('shows NO checksum on a build that never produced a viewer', async () => {
    // The committed constant is a placeholder, and presenting it as a checksum
    // would be worse than silence: the user would store `not-built-yet` and
    // believe they had an independent reference.
    await open();
    expect(screen.queryByText(/Контрольная сумма просмотрщика/)).toBeNull();
  });

  it('says the copy has never been made when no marker exists', async () => {
    await open();
    expect(screen.getByText('Резервная копия ещё не создавалась.')).toBeTruthy();
  });

  it('warns about the ceiling before the button refuses', async () => {
    fill({ estimateBackupSize: vi.fn(async () => ({ expectedFileBytes: 40 * 1024 * 1024, overCap: true })) });
    await open();

    await waitFor(() => { expect(screen.getByText(/экспорт откажет/)).toBeTruthy(); });
  });
});

describe('export', () => {
  it('hands over the container the action produced', async () => {
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать резервную копию' })); });

    expect(saveText).toHaveBeenCalledWith(
      '{"container":true}', 'eternal-notes-backup-2026-08-28.json', 'application/json',
    );
  });

  it('says the file was HANDED OVER, not that it was saved', async () => {
    // `<a download>.click()` starts a download and reports nothing about how
    // it ended. «Файл сохранён» is the app asserting something only the
    // browser knows — and it is simply false for a download the user
    // cancelled or a disk that filled up during it.
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать резервную копию' })); });

    expect(screen.getByText(/передан браузеру/)).toBeTruthy();
    expect(screen.queryByText(/Файл сохранён/)).toBeNull();
  });

  it('a marker that could not be written does NOT read as a failed export', async () => {
    // The moment this feature exists for is also the moment storage is most
    // likely to be full. The file is the result; the note about it is not.
    fill({
      exportBackupFile: vi.fn(async () => ({
        exported: { text: 'C', fileName: 'f.json', artifact: { createdAt: 1, sha256: 'x', at: 2 } },
        markerRecorded: false,
      })),
    });
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать резервную копию' })); });

    expect(saveText).toHaveBeenCalledWith('C', 'f.json', 'application/json');
    expect(screen.getByText(/отметку о нём записать не удалось/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal is reported without inventing a diagnosis about the file', async () => {
    const locked = Object.assign(new Error('locked'), { name: 'BackupVaultLockedError' });
    fill({ exportBackupFile: vi.fn(async () => { throw locked; }) });
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать резервную копию' })); });

    expect(screen.getByRole('alert').textContent).toContain('разблокируйте');
    expect(saveText).not.toHaveBeenCalled();
  });
});

describe('the viewer download', () => {
  it('saves exactly the bytes the delivery check approved', async () => {
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать просмотрщик' })); });

    expect(saveText).toHaveBeenCalledWith('<html>', 'viewer.html', 'text/html');
  });

  it('a digest mismatch saves nothing and says so', async () => {
    const mismatch = Object.assign(new Error('не совпал с контрольной суммой'), { name: 'ViewerDeliveryError' });
    fill({ downloadBackupViewer: vi.fn(async () => { throw mismatch; }) });
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать просмотрщик' })); });

    expect(saveText).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('не совпал');
  });
});

describe('verify', () => {
  it('reports a healthy file in its own terms', async () => {
    await open();
    await choose('Файл резервной копии для проверки');

    expect(screen.getByText(/в порядке/)).toBeTruthy();
  });

  it('a file that is not ok is an ALERT that tells the user to keep it', async () => {
    fill({
      verifyBackupFile: vi.fn(async () => ({
        report: VERIFY({ ok: false, issues: [{ kind: 'note', id: 'a', problem: 'undecryptable' }] }),
        markerRecorded: false,
      })),
    });
    await open();
    await choose('Файл резервной копии для проверки');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('есть проблемы');
    expect(alert.textContent).toContain('Не удаляйте');
  });

  it('«intact but incomplete» is not shown as a broken file', async () => {
    // Nothing about this file is damaged — it is simply narrower than the
    // vault it came from. Putting it in the same red box as a corrupted one
    // invites its owner to throw away the best copy they have.
    fill({
      verifyBackupFile: vi.fn(async () => ({
        report: VERIFY({ ok: false, incompleteRestore: true }),
        markerRecorded: false,
      })),
    });
    await open();
    await choose('Файл резервной копии для проверки');

    expect(screen.getByText(/цел и читается целиком/)).toBeTruthy();
    expect(screen.queryByText(/есть проблемы/)).toBeNull();
  });

  it('a verify whose mark could not be stored says so', async () => {
    // Otherwise the chip goes on saying «не проверена» about a file the user
    // just checked, with nothing to distinguish that from a failed check.
    fill({ verifyBackupFile: vi.fn(async () => ({ report: VERIFY(), markerRecorded: false })) });
    await open();
    await choose('Файл резервной копии для проверки');

    expect(screen.getByText(/отметку об этом записать не удалось/)).toBeTruthy();
  });

  it('says «status unknown» when the markers cannot be read at all', async () => {
    // A rejected read is not «nothing was ever exported» — that is a claim
    // about the user's copies which this failure cannot support.
    fill({ readBackupFreshness: vi.fn(async () => { throw new Error('idb is gone'); }) });
    await open();

    await waitFor(() => { expect(screen.getByText(/состояние копий неизвестно/)).toBeTruthy(); });
    expect(screen.queryByText(/ещё не создавалась/)).toBeNull();
  });
});

describe('import — two stages with a decision between them', () => {
  it('applies the SESSION stage A produced, not a fresh one', async () => {
    // The identity is the whole guarantee: the prepared session carries the
    // vault the preview was computed against, and a second one built from the
    // same file would not.
    const session = prepared(VERIFY());
    fill({ prepareBackupImport: vi.fn(async () => session) });
    await open();
    await choose('Файл резервной копии для импорта');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });

    expect(h.store.applyBackupImport).toHaveBeenCalledWith(session);
  });

  it('a partial SOURCE is an alert, and it comes before the button', async () => {
    fill({ prepareBackupImport: vi.fn(async () => prepared(VERIFY({ incompleteRestore: true }))) });
    await open();
    await choose('Файл резервной копии для импорта');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('заведомо неполна');
    // Order matters: a warning under the button it is about is a warning read
    // after the decision.
    const button = screen.getByRole('button', { name: 'Восстановить из файла' });
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cancelling applies nothing and takes the preview away', async () => {
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); });

    expect(h.store.applyBackupImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Восстановить из файла' })).toBeNull();
  });

  it('reports the result in three lines by what the user did', async () => {
    fill({
      applyBackupImport: vi.fn(async () => ({
        report: REPORT({ added: 2, repaired: 1, skipped: 3, deferred: 1 }),
        viewRefreshed: true,
      })),
    });
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });

    expect(screen.getByText('Добавлено: 2, восстановлено: 1.')).toBeTruthy();
    expect(screen.getByText('Не восстановлено: 3 — не удаляйте файл копии.')).toBeTruthy();
    expect(screen.getByText(/Требуется повторный импорт: 1/)).toBeTruthy();
    expect(screen.queryByText(/завершено полностью/)).toBeNull();
  });

  it('puts the REASONS behind a disclosure, with what to do about each', async () => {
    // §7: one number is the headline, and the three reasons have three
    // different answers. Collapsed, because most imports have none of them.
    fill({
      applyBackupImport: vi.fn(async () => ({
        report: REPORT({ added: 1, quotaStopped: 4, unsupported: 2 }),
        viewRefreshed: true,
      })),
    });
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });

    const disclosure = screen.getByText('Почему не восстановлено').closest('details');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('Не хватило места в хранилище: 4');
    expect(disclosure?.textContent).toContain('Освободите место');
    expect(disclosure?.textContent).toContain('Обновите приложение');
  });

  it('an earlier import report does not survive the next operation', async () => {
    // Two results on one screen read as one screen. The import token is bumped
    // by every operation anyway, so the old report describes a session that no
    // longer exists.
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });
    expect(screen.getByText(/Добавлено:/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скачать резервную копию' })); });

    expect(screen.queryByText(/Добавлено:/)).toBeNull();
  });

  it('offers no disclosure when everything was applied', async () => {
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });

    expect(screen.queryByText('Почему не восстановлено')).toBeNull();
  });

  it('a stale screen after a successful import is said out loud, not swallowed', async () => {
    fill({
      applyBackupImport: vi.fn(async () => ({ report: REPORT({ added: 1 }), viewRefreshed: false })),
    });
    await open();
    await choose('Файл резервной копии для импорта');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Восстановить из файла' })); });

    // The data landed; only the repaint did not. Reporting a failure here
    // would have the user import the same file a second time.
    expect(screen.getByText('Добавлено: 1, восстановлено: 0.')).toBeTruthy();
    expect(screen.getByText(/перезагрузите страницу/)).toBeTruthy();
  });
});
