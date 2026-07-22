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

  it('theme picker exposes the active option via aria-pressed', () => {
    renderModal();
    const system = screen.getByText('Системная');
    const dark = screen.getByText('Тёмная');
    expect(system.getAttribute('aria-pressed')).toBe('true');
    expect(dark.getAttribute('aria-pressed')).toBe('false');
  });
});
