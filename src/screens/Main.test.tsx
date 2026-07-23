// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Component tests for the Phase-6 Main-screen behaviors the review called out:
// TX link with auto-sync off, clipboard success/failure, search hotkey/Escape.

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  DRAFT_STORAGE_KEY: 'eternal-notes-draft',
}));
vi.mock('../lib/theme', () => ({ useTheme: () => ['system', vi.fn()] }));

import { Main } from './Main';

function baseStore() {
  return {
    filteredNotes: [{ id: 'n1', text: 'привет мир', createdAt: Date.now() - 60_000 }],
    isEncrypting: false,
    searchQuery: '',
    addNote: vi.fn(),
    setSearchQuery: vi.fn(),
    resetApp: vi.fn(),
    notes: [{ id: 'n1', text: 'привет мир', createdAt: Date.now() - 60_000 }],
    arweave: {
      enabled: false, // ← auto-sync OFF: the TX link must still work
      online: true,
      syncing: false,
      registered: true,
      acceptedCount: 0,
      confirmedCount: 1,
      unsyncedCount: 0,
      countsReady: true,
      errorCount: 0,
      lastSync: null,
      lastError: null,
    },
    retrySync: vi.fn(),
    restoring: false,
    restoreProgress: null,
    restoreError: null,
    restoredCount: null,
    retryRestore: vi.fn(),
    clearRestoreStatus: vi.fn(),
    syncStatuses: { n1: { status: 'confirmed' as const, txId: 'TX123' } },
    dismissError: vi.fn(),
    // consumed by the (closed) SettingsModal
    toggleArweave: vi.fn(),
    registerWithInvite: vi.fn(),
    checkAccess: vi.fn(),
    hasPin: false,
    setupPin: vi.fn(),
    removePin: vi.fn(),
    showMnemonic: vi.fn(() => 'a b c'),
  };
}

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  h.store = baseStore();
  sessionStorage.clear();
});
afterEach(cleanup);

describe('Main — note card menu', () => {
  it('shows the confirmed-TX link even with auto-sync disabled', () => {
    render(<Main />);
    // A CONFIRMED note keeps its honest badge even with sync switched off —
    // it really is on-chain (unlike a merely local one, which says so).
    expect(document.querySelector('.sync-badge')?.getAttribute('aria-label'))
      .toBe('Сохранена в блокчейне');
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    const link = screen.getByText('🔗 Транзакция в блокчейне') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('TX123'); // link is NOT gated
  });

  it('clipboard success: copied-toast shown, menu closed', async () => {
    stubClipboard(vi.fn(async () => {}));
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('📋 Копировать текст'));

    expect(await screen.findByText('✓ Скопировано')).toBeTruthy();
    expect(screen.queryByText('📋 Копировать текст')).toBeNull(); // menu closed
  });

  it('clipboard REJECTION: error toast shown, menu stays open (no false success)', async () => {
    stubClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('📋 Копировать текст'));

    expect(await screen.findByText(/Не удалось скопировать/)).toBeTruthy();
    expect(screen.queryByText('✓ Скопировано')).toBeNull();
    expect(screen.getByText('📋 Копировать текст')).toBeTruthy(); // still open
  });
});

describe('Main — modal exclusivity + live badge (round 12)', () => {
  it('Settings → Reset closes the settings dialog: only ONE aria-modal at a time', () => {
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Настройки'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1); // settings open

    fireEvent.click(screen.getByText('Сбросить приложение'));
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1); // confirm replaced settings, not stacked
    expect(dialogs[0].getAttribute('aria-label')).toBe('Сбросить приложение?');
  });

  it('revealed seed does NOT survive the Reset→Cancel round-trip (round 13)', () => {
    (h.store as ReturnType<typeof baseStore>).showMnemonic = vi.fn(() => 'секретное слово фраза');
    render(<Main />);

    // 1. Open Settings, reveal the seed.
    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    expect(screen.getByText('секретное')).toBeTruthy();

    // 2-3. Reset (closes settings, opens confirm) → cancel the confirm.
    fireEvent.click(screen.getByText('Сбросить приложение'));
    fireEvent.click(screen.getByText('Отмена'));

    // 4. Reopen Settings — the seed must be hidden again, behind the toggle.
    fireEvent.click(screen.getByLabelText('Настройки'));
    expect(screen.queryByText('секретное')).toBeNull();
    expect(screen.getByText('Показать seed-фразу')).toBeTruthy();
  });

  it('reset warns about ACCEPTED-but-unconfirmed notes (they can still drop)', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.syncStatuses = { n1: { status: 'accepted' as const } }; // uploaded, NOT confirmed
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/НЕ подтверждены/);
    expect(dialog.textContent).not.toMatch(/Все заметки подтверждены/);
  });

  it('reset warns even if the aggregate looks clean but a note has no sync record', () => {
    // The round-22 case: countsReady=true and the aggregate says 0 unconfirmed
    // (a post-save refreshSyncCounts was swallowed), but the just-added note is
    // in `notes` with no syncStatuses entry. Derived-from-UI must still warn.
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.countsReady = true;
    s.syncStatuses = {}; // n1 present in notes, absent here
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/НЕ подтверждены/);
    expect(dialog.textContent).not.toMatch(/Все заметки подтверждены/);
  });

  it('reset says everything is safe only when EVERY visible note is confirmed', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.countsReady = true;
    s.syncStatuses = { n1: { status: 'confirmed' as const, txId: 'TX123' } };
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/Все заметки подтверждены/);
  });

  it('reset NEVER claims safety while sync counts are still loading', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.countsReady = false;   // placeholder state right after bootstrap
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/ещё загружается/);
    expect(dialog.textContent).not.toMatch(/Все заметки подтверждены/);
  });

  it('note shows «Только на этом устройстве» when sync is off', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = false;
    s.syncStatuses = { n1: { status: 'queued' as const } };
    render(<Main />);
    const badge = document.querySelector('.sync-badge');
    expect(badge?.getAttribute('aria-label')).toMatch(/Только на этом устройстве/);
  });

  it('per-note sync badge is a live role=status region', () => {
    (h.store as ReturnType<typeof baseStore>).arweave.enabled = true;
    render(<Main />);
    const badge = document.querySelector('.sync-badge');
    expect(badge?.getAttribute('role')).toBe('status');
    expect(badge?.getAttribute('aria-label')).toBe('Сохранена в блокчейне');
  });
});

describe('Main — search UX', () => {
  it('Ctrl+K opens the search bar, Escape closes it and clears the query', () => {
    render(<Main />);
    expect(screen.queryByPlaceholderText('Найти заметку...')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('Найти заметку...');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Найти заметку...')).toBeNull();
    expect((h.store as ReturnType<typeof baseStore>).setSearchQuery).toHaveBeenCalledWith('');
  });

  it('Cmd+K works too (macOS)', () => {
    render(<Main />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByPlaceholderText('Найти заметку...')).toBeTruthy();
  });
});
