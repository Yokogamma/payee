// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { SettingsModal } from './SettingsModal';

beforeEach(() => {
  h.store = {
    notes: [],
    chains: [],
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      acceptedCount: 0, confirmedCount: 0, unsyncedCount: 0, errorCount: 0,
      quarantinedCount: 0, countsReady: true,
      lastSync: null, lastError: null,
    },
    syncStatuses: {},
    updateCheck: { status: 'idle' },
    checkForUpdates: vi.fn(),
    toggleArweave: vi.fn(),
    retrySync: vi.fn(),
    registerWithInvite: vi.fn(),
    checkAccess: vi.fn(),
    hasPin: false,
    setupPin: vi.fn(),
    removePin: vi.fn(),
    showMnemonic: vi.fn(() => 'a b c'),
    // Safebox slice — defaults: nothing configured, no data.
    safeboxPinConfigured: false,
    safeboxDataPresent: false,
    safeboxUnlocked: false,
    safeboxLockGeneration: 0,
    unlockSafebox: vi.fn(async () => {}),
    changeSafeboxPin: vi.fn(async () => {}),
    deactivateSafebox: vi.fn(async () => {}),
  };
});
afterEach(cleanup);

function renderModal(open = true) {
  const onClose = vi.fn();
  return Object.assign(render(
    <SettingsModal
      open={open}
      onClose={onClose}
      theme="system"
      onThemeChange={vi.fn()}
      onRequestReset={vi.fn()}
    />,
  ), { onClose });
}

describe('SettingsModal a11y (Phase 7)', () => {
  it('renders as role=dialog with a label; closed renders nothing', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeTruthy();
    cleanup();
    renderModal(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes the modal', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Shift+Tab right after opening stays INSIDE the dialog (container is a boundary)', () => {
    renderModal();
    // Initial focus is the dialog container itself (tabIndex=-1).
    const dialog = screen.getByRole('dialog', { name: 'Настройки' });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    const active = document.activeElement as HTMLElement;
    expect(dialog.contains(active)).toBe(true);      // never escapes behind the modal
    expect(active).not.toBe(dialog);                 // wrapped to a real control
    expect(active.textContent).toBe('Сброс приложения'); // LAST focusable = last block header
  });

  it('theme picker exposes the active option via aria-pressed', () => {
    renderModal();
    // Theme now lives inside a collapsed block — expand it first. "Системная"
    // also appears as the block's status chip, so target the buttons by role.
    fireEvent.click(screen.getByText('Тема'));
    const system = screen.getByRole('button', { name: 'Системная' });
    const dark = screen.getByRole('button', { name: 'Тёмная' });
    expect(system.getAttribute('aria-pressed')).toBe('true');
    expect(dark.getAttribute('aria-pressed')).toBe('false');
  });

  it('PIN block: "Установить" with no PIN; "Сменить" + "Удалить" once set', () => {
    renderModal();
    fireEvent.click(screen.getByText('PIN-код'));
    expect(screen.getByText('Установить PIN-код')).toBeTruthy();
    expect(screen.queryByText('Сменить PIN-код')).toBeNull();
    cleanup();

    h.store.hasPin = true;
    renderModal();
    fireEvent.click(screen.getByText('PIN-код'));
    expect(screen.getByText('Сменить PIN-код')).toBeTruthy();
    expect(screen.getByText('Удалить PIN-код')).toBeTruthy();
  });
});

describe('SettingsModal — safebox seed gate (§2)', () => {
  it('без сейфа: seed-фраза показывается как раньше', () => {
    renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    expect(screen.getByText('a')).toBeTruthy(); // the words render
  });

  it('с настроенным сейфом seed прячется ЗА PIN сейфа', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxDataPresent = true;
    renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    // The phrase is NOT rendered yet — a PIN prompt is.
    expect(screen.queryByText('Показать после ввода PIN')).toBeTruthy();
    expect(h.store.showMnemonic).not.toHaveBeenCalled();

    const input = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(input, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Показать после ввода PIN')); });

    // Unlocking the safebox IS the proof (it runs the metered PIN path).
    expect(h.store.unlockSafebox).toHaveBeenCalledWith('135790');
  });

  it('данные сейфа БЕЗ конфига: показ seed запрещён с подсказкой про сброс по seed', () => {
    h.store.safeboxPinConfigured = false;
    h.store.safeboxDataPresent = true;
    renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    // A 10-strike wipe must NOT become a shortcut to the seed phrase.
    expect(screen.getByText(/Просмотр seed-фразы закрыт/)).toBeTruthy();
    expect(h.store.showMnemonic).not.toHaveBeenCalled();
  });

  it('блок «Защищённый сейф» виден только при данных или конфиге', () => {
    renderModal();
    expect(screen.queryByText('Защищённый сейф')).toBeNull();
    cleanup();

    h.store.safeboxPinConfigured = true;
    renderModal();
    expect(screen.getByText('Защищённый сейф')).toBeTruthy();
  });

  it('смена PIN сейфа требует ТЕКУЩИЙ PIN', async () => {
    h.store.safeboxPinConfigured = true;
    renderModal();
    fireEvent.click(screen.getByText('Защищённый сейф'));
    fireEvent.click(screen.getByText('Сменить PIN сейфа'));

    const current = document.querySelector('#sbx-cur-code') as HTMLInputElement;
    const next = document.querySelector('#sbx-next-code') as HTMLInputElement;
    const confirm = document.querySelector('#sbx-next-code-2') as HTMLInputElement;
    expect(current).toBeTruthy();
    fireEvent.change(current, { target: { value: '135790' } });
    fireEvent.change(next, { target: { value: '246810' } });
    fireEvent.change(confirm, { target: { value: '246810' } });
    await act(async () => { fireEvent.click(screen.getByText('Сменить PIN')); });
    expect(h.store.changeSafeboxPin).toHaveBeenCalledWith('135790', '246810');
  });

  it('деактивация требует текущий PIN и обещает сохранность записей', async () => {
    h.store.safeboxPinConfigured = true;
    renderModal();
    fireEvent.click(screen.getByText('Защищённый сейф'));
    fireEvent.click(screen.getByText('Деактивировать сейф (записи сохранятся)'));
    expect(screen.getByText(/Записи сейфа НЕ удаляются/)).toBeTruthy();

    const current = document.querySelector('#sbx-cur-code') as HTMLInputElement;
    fireEvent.change(current, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Деактивировать')); });
    expect(h.store.deactivateSafebox).toHaveBeenCalledWith('135790');
  });
});

describe('SettingsModal — the seed gate is LIVE, not a one-time flag', () => {
  it('a safebox lock after the gate was passed hides the phrase again', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxUnlocked = false;
    const { rerender } = renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    // Pass the gate: unlockSafebox resolves ⇒ the session is open.
    h.store.safeboxUnlocked = true;
    const input = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Показать после ввода PIN')); });
    expect(h.store.showMnemonic).toHaveBeenCalled();

    // The idle timer / an app lock / another tab closes the section: the gate
    // closes WITH it — the phrase must not stay on screen.
    (h.store.showMnemonic as ReturnType<typeof vi.fn>).mockClear();
    h.store.safeboxUnlocked = false;
    rerender(
      <SettingsModal open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );
    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect(screen.getByText('Показать после ввода PIN')).toBeTruthy(); // asks again
  });

  it('a REJECTED unlock (lock during the KDF) never opens the gate', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.unlockSafebox = vi.fn(async () => { throw new Error('Сейф заблокирован.'); });
    renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    const input = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Показать после ввода PIN')); });

    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect(screen.getByText('Сейф заблокирован.')).toBeTruthy();
  });
});

describe('SettingsModal — a section lock clears ITS safebox secrets too', () => {
  it('the PIN-change form is remounted on a lock-generation bump', () => {
    h.store.safeboxPinConfigured = true;
    const { rerender } = renderModal();
    fireEvent.click(screen.getByText('Защищённый сейф'));
    fireEvent.click(screen.getByText('Сменить PIN сейфа'));

    const current = document.querySelector('#sbx-cur-code') as HTMLInputElement;
    fireEvent.change(current, { target: { value: '135790' } });
    expect((document.querySelector('#sbx-cur-code') as HTMLInputElement).value).toBe('135790');
    // The Settings modal sits OUTSIDE the subtree Main remounts, so it has to
    // react to the lock generation itself.
    expect(current.className).toContain('safebox-secret-field');

    h.store.safeboxLockGeneration = 1;
    rerender(
      <SettingsModal open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );

    // Back to the idle state: the typed current PIN is gone with the remount.
    expect(document.querySelector('#sbx-cur-code')).toBeNull();
    fireEvent.click(screen.getByText('Сменить PIN сейфа'));
    expect((document.querySelector('#sbx-cur-code') as HTMLInputElement).value).toBe('');
  });

  it('the seed-gate PIN and its passed state are cleared on a lock', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxUnlocked = true;
    const { rerender } = renderModal();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    const gate = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    expect(gate.className).toContain('safebox-secret-field'); // in the sync scrub
    fireEvent.change(gate, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Показать после ввода PIN')); });
    expect(h.store.showMnemonic).toHaveBeenCalled();

    (h.store.showMnemonic as ReturnType<typeof vi.fn>).mockClear();
    h.store.safeboxLockGeneration = 1;   // a hidden edge locked the section
    h.store.safeboxUnlocked = false;
    rerender(
      <SettingsModal open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );

    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect((document.querySelector('#sbx-gate-seed') as HTMLInputElement).value).toBe('');
  });
});

// ─── «Вечное хранилище»: проверка обновлений и счётчики ─────────────

/** Only one block is ever expanded in these tests, so its body is unambiguous. */
function storageBlockText(): string {
  return (document.querySelector('.settings-block.is-open .settings-block-body') as HTMLElement).textContent ?? '';
}
function openStorageBlock() {
  fireEvent.click(screen.getByText('Вечное хранилище'));
}
/** A chain fixture: only `versions[].id` and the chain count are read here. */
function chainOf(root: string, versionIds: string[]) {
  const versions = versionIds.map(id => ({ id, root, rev: 1, createdAt: 1 }));
  return { root, current: versions[0], versions };
}

describe('SettingsModal — «Проверить обновления»', () => {
  it('кнопка вызывает checkForUpdates', () => {
    renderModal();
    openStorageBlock();
    fireEvent.click(screen.getByText('↻ Проверить обновления'));
    expect(h.store.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('остаётся доступной при ВЫКЛЮЧЕННОЙ автосинхронизации — чтение не требует записи', () => {
    h.store.arweave = { ...(h.store.arweave as object), enabled: false, registered: false };
    renderModal();
    openStorageBlock();
    const btn = screen.getByText('↻ Проверить обновления') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(h.store.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('во время проверки кнопка заблокирована и показывает прогресс', () => {
    h.store.updateCheck = { status: 'checking', progress: { done: 12, total: 40 } };
    renderModal();
    openStorageBlock();
    const btn = screen.getByText('⏳ Проверяем… 12/40') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('результат: сколько получено с других устройств', () => {
    h.store.updateCheck = {
      status: 'done', at: Date.now(), addedNotes: 2, updatedNotes: 1, changedSafebox: 3, partial: false,
    };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Получено с других устройств: 2');
    expect(text).toContain('обновлено: 1');
    expect(text).toContain('в сейфе: 3');
  });

  it('результат: пустая проверка отличается от «не запускалась»', () => {
    h.store.updateCheck = {
      status: 'done', at: Date.now(), addedNotes: 0, updatedNotes: 0, changedSafebox: 0, partial: false,
    };
    renderModal();
    openStorageBlock();
    expect(storageBlockText()).toContain('новых заметок нет');
  });

  it('partial — предупреждение, но НЕ ошибка: полученное всё равно показано', () => {
    h.store.updateCheck = {
      status: 'done', at: Date.now(), addedNotes: 1, updatedNotes: 0, changedSafebox: 0, partial: true,
    };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Получено с других устройств: 1');
    expect(text).toContain('не полностью');
    expect(text).not.toContain('Не удалось проверить обновления');
  });

  it('error — отдельная формулировка, без «не полностью»', () => {
    h.store.updateCheck = { status: 'error', at: Date.now() };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Не удалось проверить обновления');
    expect(text).not.toContain('не полностью');
  });
});

describe('SettingsModal — счётчик по заметкам, а не по версиям', () => {
  it('одна заметка из трёх подтверждённых версий — это «1 из 1»', () => {
    h.store.chains = [chainOf('r1', ['v1', 'v2', 'v3'])];
    h.store.notes = [{}, {}, {}];
    h.store.syncStatuses = {
      v1: { status: 'confirmed' }, v2: { status: 'confirmed' }, v3: { status: 'confirmed' },
    };
    h.store.arweave = { ...(h.store.arweave as object), confirmedCount: 3 };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Заметки в блокчейне: 1 из 1');
    expect(text).toContain('версий (транзакций): 3 из 3');
  });

  it('цепочка confirmed+accepted НЕ «в блокчейне», а «ждёт подтверждения»', () => {
    // The reset dialog treats only `confirmed` as recoverable — this counter
    // must not promise more than the wipe warning does.
    h.store.chains = [chainOf('r1', ['v1', 'v2'])];
    h.store.syncStatuses = { v1: { status: 'confirmed' }, v2: { status: 'accepted' } };
    h.store.arweave = { ...(h.store.arweave as object), confirmedCount: 1, acceptedCount: 1 };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Заметки в блокчейне: 0 из 1');
    expect(text).toContain('Передано, ждёт подтверждения: 1');
    expect(text).toContain('версий (транзакций): 1 из 2');
  });

  it('цепочка accepted+queued не попадает НИ В ОДНУ из двух строк', () => {
    h.store.chains = [chainOf('r1', ['v1', 'v2'])];
    h.store.syncStatuses = { v1: { status: 'accepted' } }; // v2 ещё не выгружалась
    h.store.arweave = { ...(h.store.arweave as object), acceptedCount: 1, unsyncedCount: 1 };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Заметки в блокчейне: 0 из 1');
    expect(text).not.toContain('Передано, ждёт подтверждения');
    expect(text).toContain('версий (транзакций): 0 из 2');
  });

  it('знаменатель версий берётся из хранилища — нерасшифровываемая версия тоже считается', () => {
    // One visible confirmed chain, plus a stored version that this build cannot
    // decrypt: it is absent from `chains`/`notes` but present in the aggregates.
    h.store.chains = [chainOf('r1', ['v1'])];
    h.store.notes = [{}];
    h.store.syncStatuses = { v1: { status: 'confirmed' } };
    h.store.arweave = { ...(h.store.arweave as object), confirmedCount: 1, unsyncedCount: 1 };
    renderModal();
    openStorageBlock();
    expect(storageBlockText()).toContain('версий (транзакций): 1 из 2');
  });

  it('пока агрегаты не прочитаны — «загружается», а не честно выглядящий ноль', () => {
    h.store.chains = [chainOf('r1', ['v1'])];
    h.store.syncStatuses = {};
    h.store.arweave = { ...(h.store.arweave as object), countsReady: false };
    renderModal();
    openStorageBlock();
    const text = storageBlockText();
    expect(text).toContain('Синхронизировано: загружается…');
    expect(text).not.toContain('Заметки в блокчейне');
  });
});
