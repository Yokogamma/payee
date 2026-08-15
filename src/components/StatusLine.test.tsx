// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { StatusLine } from './StatusLine';

function baseStore() {
  return {
    chains: [],
    syncStatuses: {},
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      countsReady: true, confirmedCount: 0, acceptedCount: 0, unsyncedCount: 0,
      errorCount: 0, quarantinedCount: 0, lastError: null,
    },
    restoring: false, restoreProgress: null, restoreError: null,
    restoredCount: null, restoredUpdatedCount: null,
    retryRestore: vi.fn(), clearRestoreStatus: vi.fn(),
    updateCheck: { status: 'idle' as const }, checkForUpdates: vi.fn(),
    v3Paused: false, resumeV3Uploads: vi.fn(),
    v4Paused: false, resumeV4Uploads: vi.fn(),
    retrySync: vi.fn(), dismissError: vi.fn(),
  };
}
type Store = ReturnType<typeof baseStore>;
const s = () => h.store as Store;

const done = (over: Partial<{ addedNotes: number; updatedNotes: number; changedSafebox: number; partial: boolean }> = {}) => ({
  status: 'done' as const, at: 1_700_000_000_000,
  addedNotes: 0, updatedNotes: 0, changedSafebox: 0, partial: false, ...over,
});

beforeEach(() => { h.store = baseStore(); });
afterEach(cleanup);

const text = () => document.querySelector('.status-text') as HTMLElement;

describe('StatusLine — лестница приоритетов', () => {
  it('спокойное состояние', () => {
    render(<StatusLine />);
    expect(text().textContent).toMatch(/Синхронизировано/);
  });

  it('выключенная синхронизация не притворяется синхронизацией', () => {
    s().arweave.enabled = false;
    render(<StatusLine />);
    expect(text().textContent).toMatch(/выключена/);
  });

  it('восстановление бьёт всё остальное и показывает прогресс', () => {
    s().restoring = true;
    s().restoreProgress = { done: 3, total: 10 };
    s().arweave.online = false; //ниже по лестнице
    render(<StatusLine />);
    expect(text().textContent).toMatch(/Восстанавливаем… 3\/10/);
  });

  it('проверка обновлений показывает done/total прямо в строке', () => {
    s().updateCheck = { status: 'checking', progress: { done: 34, total: 120 } };
    render(<StatusLine />);
    expect(text().textContent).toMatch(/34\/120/);
  });

  it('оффлайн', () => {
    s().arweave.online = false;
    render(<StatusLine />);
    expect(text().textContent).toMatch(/Оффлайн/);
  });
});

describe('StatusLine — срочность не сглажена', () => {
  it('ошибка синхронизации объявляется как alert, а не как вежливый status', () => {
    s().arweave.lastError = 'сеть недоступна';
    render(<StatusLine />);
    expect(text().getAttribute('role')).toBe('alert');
  });

  it('ошибка восстановления — тоже alert', () => {
    s().restoreError = 'не удалось прочитать индекс';
    render(<StatusLine />);
    expect(text().getAttribute('role')).toBe('alert');
  });

  it('обычное состояние — вежливый status', () => {
    render(<StatusLine />);
    expect(text().getAttribute('role')).toBe('status');
    expect(text().getAttribute('aria-live')).toBe('polite');
  });

  it('у ошибки НЕТ aria-live: явный polite перекрыл бы assertive от role="alert"', () => {
    // role="alert" implies aria-live="assertive"; an explicit aria-live on the
    // SAME element wins. Setting both would announce errors politely — the
    // flattening this ladder exists to avoid. Asserting only the role would
    // pass while the announcement stayed wrong.
    s().arweave.lastError = 'сеть недоступна';
    render(<StatusLine />);
    expect(text().getAttribute('role')).toBe('alert');
    expect(text().getAttribute('aria-live')).toBeNull();
  });

  it('partial — ПРЕДУПРЕЖДЕНИЕ, а не ошибка: что дошло, то смержено', () => {
    s().updateCheck = done({ addedNotes: 2, partial: true });
    const { container } = render(<StatusLine />);
    expect(container.querySelector('.status-line--warn')).toBeTruthy();
    expect(container.querySelector('.status-line--error')).toBeNull();
    expect(text().textContent).toMatch(/получено 2/);
  });
});

describe('StatusLine — паузы стоят, а не всплывают', () => {
  it('пауза v3 с кнопкой возобновления', () => {
    s().v3Paused = true;
    render(<StatusLine />);
    expect(text().textContent).toMatch(/приостановлена/);
    fireEvent.click(screen.getByText('Возобновить'));
    expect(s().resumeV3Uploads).toHaveBeenCalled();
  });

  it('пауза v4 тоже', () => {
    s().v4Paused = true;
    render(<StatusLine />);
    expect(text().textContent).toMatch(/сейфа приостановлена/);
  });
});

describe('StatusLine — проверка обновлений', () => {
  it('«в сейфе: N» показывается при ЗАПЕРТОМ сейфе', () => {
    // The count comes from the sweep, not from the section: it needs no key and
    // reveals nothing. Silence here would leave an unexplained data change.
    s().updateCheck = done({ addedNotes: 1, changedSafebox: 3 });
    render(<StatusLine />);
    expect(text().textContent).toMatch(/в сейфе 3/);
  });

  it('результат сформулирован как факт, а не как объявление — он не протухает', () => {
    s().updateCheck = done({ addedNotes: 4 });
    render(<StatusLine />);
    expect(text().textContent).toMatch(/Проверено в /);
  });

  it('пустая проверка отчитывается словами, а не молчанием', () => {
    s().updateCheck = done();
    render(<StatusLine />);
    expect(text().textContent).toMatch(/новых записей нет/);
  });

  it('кнопка заблокирована во время ВОССТАНОВЛЕНИЯ, не только во время проверки', () => {
    // Both drive the same sweep behind one guard, so a second press was
    // silently ignored while the button still looked live.
    s().restoring = true;
    render(<StatusLine />);
    expect((screen.getByLabelText('Проверить обновления') as HTMLButtonElement).disabled).toBe(true);
  });

  it('кнопка вызывает проверку', () => {
    render(<StatusLine />);
    fireEvent.click(screen.getByLabelText('Проверить обновления'));
    expect(s().checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('StatusLine — подробности', () => {
  it('счётчики свёрнуты по умолчанию и раскрываются', () => {
    render(<StatusLine />);
    expect(screen.queryByText(/Заметки в блокчейне/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Показать подробности'));
    expect(screen.getByText(/Заметки в блокчейне/)).toBeTruthy();
  });

  it('пока счётчики не загружены, не рисуется честно выглядящая ложь «0 из N»', () => {
    s().arweave.countsReady = false;
    render(<StatusLine />);
    fireEvent.click(screen.getByLabelText('Показать подробности'));
    expect(screen.getByText(/загружается/)).toBeTruthy();
    expect(screen.queryByText(/Заметки в блокчейне/)).toBeNull();
  });
});

describe('StatusLine — карантин объясняется верно', () => {
  it('называет настоящую причину, а не «созданы до регистрации»', () => {
    // terminalError is 'unsupported_version' | 'malformed_record' — a record
    // this build cannot process. The old wording described a different
    // situation and pointed at the wrong recovery.
    s().arweave.quarantinedCount = 2;
    render(<StatusLine />);
    fireEvent.click(screen.getByLabelText('Показать подробности'));
    const hint = screen.getByText(/Отложено: 2/);
    expect(hint.textContent).toMatch(/не может обработать/);
    expect(hint.textContent).not.toMatch(/до регистрации/);
  });

  it('без карантина строки нет', () => {
    render(<StatusLine />);
    fireEvent.click(screen.getByLabelText('Показать подробности'));
    expect(screen.queryByText(/Отложено/)).toBeNull();
  });
});
