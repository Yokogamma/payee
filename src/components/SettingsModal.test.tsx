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
      lastSync: null, lastError: null,
    },
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
