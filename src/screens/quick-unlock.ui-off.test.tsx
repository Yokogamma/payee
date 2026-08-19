// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The FLAG-OFF half of the UI matrix (§9, §10). Visibility is
// `QUICK_UNLOCK_ENABLED || hasQuickUnlock`: with the flag rolled back, a user
// who already configured quick unlock must still be able to REMOVE it. The
// alternative — hiding the block — leaves a live record with no control, which
// is exactly the failure mode the «no reconfigure button» rule exists to
// prevent.

vi.mock('../lib/flags', () => ({
  V3_WRITER_ENABLED: false,
  SAFEBOX_WRITER_ENABLED: false,
  QUICK_UNLOCK_ENABLED: false,
}));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/store')>();
  return { ...actual, useNotes: () => h.store };
});

import { SettingsSection } from './SettingsSection';

function baseStore(): Record<string, unknown> {
  return {
    notes: [], chains: [],
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      acceptedCount: 0, confirmedCount: 0, unsyncedCount: 0, errorCount: 0,
      quarantinedCount: 0, countsReady: true,
      resetRisk: { notes: 0, safebox: 0 }, lastSync: null, lastError: null,
    },
    syncStatuses: {}, updateCheck: { status: 'idle' },
    checkForUpdates: vi.fn(), toggleArweave: vi.fn(), retrySync: vi.fn(),
    registerWithInvite: vi.fn(), checkAccess: vi.fn(),
    hasPin: true, setupPin: vi.fn(), removePin: vi.fn(),
    showMnemonic: vi.fn(() => 'a b c'),
    autoLockTimeout: 300, setAutoLockTimeout: vi.fn(),
    quickUnlockMeta: null,
    hasQuickUnlock: false,
    quickUnlockCapability: 'ready',
    setupQuickUnlock: vi.fn(async () => {}),
    removeQuickUnlock: vi.fn(async () => {}),
    unlockWithQuickUnlock: vi.fn(async () => {}),
    refreshQuickUnlockCapability: vi.fn(),
    safeboxPinConfigured: false, safeboxDataPresent: false,
    safeboxUnlocked: false, safeboxLockGeneration: 0,
    unlockSafebox: vi.fn(async () => {}), changeSafeboxPin: vi.fn(async () => {}),
    deactivateSafebox: vi.fn(async () => {}), resetApp: vi.fn(),
  };
}

beforeEach(() => { h.store = baseStore(); });
afterEach(cleanup);

const renderSection = () => render(<SettingsSection theme="system" onThemeChange={vi.fn()} />);

describe('QUICK_UNLOCK_ENABLED = false', () => {
  it('без записи блок не показывается вовсе', () => {
    renderSection();
    const titles = Array.from(document.querySelectorAll('.settings-block-title')).map(el => el.textContent);
    expect(titles).not.toContain('Быстрый вход');
  });

  it('С записью блок ВИДЕН и предлагает только удаление', () => {
    h.store = { ...baseStore(), hasQuickUnlock: true, quickUnlockMeta: { createdAt: 1_700_000_000_000 } };
    renderSection();

    const header = screen.getByRole('button', { name: /Быстрый вход/ });
    expect(header).toBeTruthy();
    fireEvent.click(header);

    expect(screen.getByRole('button', { name: 'Удалить быстрый вход' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Настроить быстрый вход' })).toBeNull();
  });
});
