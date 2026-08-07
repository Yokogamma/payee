// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { SettingsModal } from './SettingsModal';

beforeEach(() => {
  h.store = {
    notes: [],
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
  };
});
afterEach(cleanup);

function renderModal(open = true) {
  const onClose = vi.fn();
  render(
    <SettingsModal
      open={open}
      onClose={onClose}
      theme="system"
      onThemeChange={vi.fn()}
      onRequestReset={vi.fn()}
    />,
  );
  return { onClose };
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
