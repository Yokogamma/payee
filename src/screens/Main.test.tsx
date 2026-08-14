// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Component tests for the Phase-6 Main-screen behaviors the review called out:
// TX link with auto-sync off, clipboard success/failure, search hotkey/Escape.

// Writer-OFF (R3) UI matrix — flag pinned explicitly; the ON surface lives in
// Main.v3.test.tsx. Keeps the W3 flip a pure one-line change.
vi.mock('../lib/flags', () => ({ V3_WRITER_ENABLED: false, SAFEBOX_WRITER_ENABLED: false }));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  DRAFT_STORAGE_KEY: 'eternal-notes-draft',
  // Main (and the modals) `instanceof` these — the mock must export REAL classes.
  OperationInFlightError: class OperationInFlightError extends Error {},
  WriterDisabledError: class WriterDisabledError extends Error {},
}));
vi.mock('../lib/theme', () => ({ useTheme: () => ['system', vi.fn()] }));

import { Main } from './Main';
import { resetRoute } from '../test-stubs/route-reset';
import { groupChains } from '../lib/chains';
import type { NoteData } from '../lib/crypto';

function note(over: Partial<NoteData> & { id: string; text: string }): NoteData {
  return { createdAt: Date.now() - 60_000, fmt: 'plain', rev: 1, root: over.id, ...over };
}

function baseStore() {
  const notes = [note({ id: 'n1', text: 'привет мир' })];
  const chains = groupChains(notes);
  return {
    filteredNotes: notes,
    notes,
    chains,
    filteredChains: chains,
    v3Paused: false,
    v4Paused: false,
    resumeV4Uploads: vi.fn(async () => {}),
    // Safebox slice (R4 defaults: no data, no PIN → entry point hidden)
    safeboxUnlocked: false,
    safeboxPinConfigured: false,
    safeboxDataPresent: false,
    safeboxEntryCount: 0,
    safeboxEntries: [],
    safeboxChains: [],
    filteredSafeboxChains: [],
    safeboxSearchQuery: '',
    restoredSafeboxCount: null,
    setSafeboxSearchQuery: vi.fn(),
    activateSafebox: vi.fn(async () => {}),
    unlockSafebox: vi.fn(async () => {}),
    lockSafebox: vi.fn(),
    touchSafebox: vi.fn(),
    changeSafeboxPin: vi.fn(async () => {}),
    deactivateSafebox: vi.fn(async () => {}),
    resetSafeboxPinWithSeed: vi.fn(async () => {}),
    getSafeboxPinLockState: vi.fn(async () => ({ lockedSeconds: 0, attempts: 0, configured: false })),
    addSafeboxEntry: vi.fn(async () => {}),
    editSafeboxEntry: vi.fn(async () => {}),
    restoreSafeboxVersion: vi.fn(async () => {}),
    revealSafeboxSecret: vi.fn(async () => 'secret'),
    copySafeboxPassword: vi.fn(async () => true),
    downloadSafeboxAttachment: vi.fn(async () => {}),
    isEncrypting: false,
    searchQuery: '',
    addNote: vi.fn(),
    editNote: vi.fn(async () => {}),
    resumeV3Uploads: vi.fn(async () => {}),
    setSearchQuery: vi.fn(),
    resetApp: vi.fn(),
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
      quarantinedCount: 0,
      resetRisk: { notes: 0, safebox: 0 },
      safebox: {
        unsyncedCount: 0, acceptedCount: 0, confirmedCount: 0,
        errorCount: 0, quarantinedCount: 0,
      },
      lastSync: null,
      lastError: null,
    },
    retrySync: vi.fn(),
    restoring: false,
    restoreProgress: null,
    restoreError: null,
    restoredCount: null,
    restoredUpdatedCount: null,
    retryRestore: vi.fn(),
    clearRestoreStatus: vi.fn(),
    updateCheck: { status: 'idle' as const },
    checkForUpdates: vi.fn(),
    syncStatuses: { n1: { status: 'confirmed' as const, txId: 'TX123' } },
    dismissError: vi.fn(),
    // encrypted-at-rest draft API (§2)
    persistDraft: vi.fn(async () => {}),
    readDraft: vi.fn(async () => null),
    clearDraft: vi.fn(),
    autoLockTimeout: null,
    setAutoLockTimeout: vi.fn(async () => {}),
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
  resetRoute(); // the section is in location.hash and jsdom keeps one per file
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

    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
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
    fireEvent.click(screen.getByText('Seed-фраза')); // expand the block
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    expect(screen.getByText('секретное')).toBeTruthy();

    // 2-3. Reset (closes settings, opens confirm) → cancel the confirm.
    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
    fireEvent.click(screen.getByText('Сбросить приложение'));
    fireEvent.click(screen.getByText('Отмена'));

    // 4. Reopen Settings — the seed must be hidden again, behind the toggle.
    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Seed-фраза')); // expand the block again
    expect(screen.queryByText('секретное')).toBeNull();
    expect(screen.getByText('Показать seed-фразу')).toBeTruthy();
  });

  it('reset warns when ANY stored record is unconfirmed (storage-backed resetRiskCount)', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.resetRisk = { notes: 1, safebox: 0 }; // e.g. accepted-but-unconfirmed — can still drop
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/НЕ подтверждены/);
    expect(dialog.textContent).not.toMatch(/Все записи подтверждены/);
  });

  it('reset warns for INVISIBLE at-risk records (historical version / quarantined)', () => {
    // The card feed shows one confirmed chain, but storage holds an extra
    // unconfirmed record the UI cannot display (historical version of another
    // fork, a quarantined unsupported-version note, a corrupted ciphertext).
    // The storage-backed counter must warn regardless of what is visible.
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.countsReady = true;
    s.syncStatuses = { n1: { status: 'confirmed' as const, txId: 'TX123' } }; // visible looks safe
    s.arweave.resetRisk = { notes: 1, safebox: 0 }; // …but storage says otherwise
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/НЕ подтверждены/);
    expect(dialog.textContent).not.toMatch(/Все записи подтверждены/);
  });

  it('reset says everything is safe only when EVERY stored record is confirmed', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.countsReady = true;
    s.arweave.resetRisk = { notes: 0, safebox: 0 };
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialog = screen.getByRole('dialog', { name: 'Сбросить приложение?' });
    expect(dialog.textContent).toMatch(/Все записи подтверждены/);
  });

  it('reset NEVER claims safety while sync counts are still loading', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.countsReady = false;   // placeholder state right after bootstrap
    render(<Main />);

    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сброс приложения')); // expand the reset block
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

describe('Main — draft hydration dirty guard (§2)', () => {
  it('hydrates the stored draft into a pristine composer', async () => {
    (h.store as ReturnType<typeof baseStore>).readDraft =
      vi.fn(async () => 'сохранённый черновик');
    render(<Main />);
    await waitFor(() => {
      const input = document.querySelector('.note-input') as HTMLTextAreaElement;
      expect(input.value).toBe('сохранённый черновик');
    });
  });

  it('does NOT resurrect the draft over text the user typed and DELETED (review finding 4)', async () => {
    let resolveDraft!: (v: string | null) => void;
    (h.store as ReturnType<typeof baseStore>).readDraft =
      vi.fn(() => new Promise<string | null>(r => { resolveDraft = r; }));
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;

    // The user types and deletes everything while the read is in flight —
    // the composer is EMPTY but not pristine.
    fireEvent.change(input, { target: { value: 'набрал' } });
    fireEvent.change(input, { target: { value: '' } });

    await act(async () => { resolveDraft('старый черновик'); });
    expect(input.value).toBe(''); // the user's deletion wins
  });

  it('does not overwrite text the user typed before hydration resolved', async () => {
    let resolveDraft!: (v: string | null) => void;
    (h.store as ReturnType<typeof baseStore>).readDraft =
      vi.fn(() => new Promise<string | null>(r => { resolveDraft = r; }));
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'свежий ввод' } });
    await act(async () => { resolveDraft('старый черновик'); });
    expect(input.value).toBe('свежий ввод');
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

describe('Main — R3 (writer OFF) surface', () => {
  it('the card menu has NO edit/history items while the writer flag is off', () => {
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    expect(screen.queryByText(/Редактировать/)).toBeNull();
    expect(screen.queryByText(/История версий/)).toBeNull();
    expect(screen.getByText(/неизменяема/)).toBeTruthy(); // legacy hint intact
  });

  it('shows the v3-pause standing banner with a resume button', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.v3Paused = true;
    render(<Main />);
    expect(screen.getByText(/временно приостановлена/)).toBeTruthy();
    fireEvent.click(screen.getByText('Возобновить'));
    expect(s.resumeV3Uploads).toHaveBeenCalled();
  });

  it('restore banner reports both new and updated chains (M/K)', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.restoredCount = 2;
    s.restoredUpdatedCount = 3;
    render(<Main />);
    expect(screen.getByText(/Восстановлено заметок: 2, обновлено: 3/)).toBeTruthy();
  });

  it('restore banner: K only (0 new chains, some updated) still reads as found work', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    s.restoredCount = 0;
    s.restoredUpdatedCount = 1;
    render(<Main />);
    expect(screen.getByText(/Восстановлено заметок: 0, обновлено: 1/)).toBeTruthy();
  });

  it('NoteTooLongError shows the dedicated size message and keeps the text', async () => {
    const { NoteTooLongError } = await import('../lib/limits');
    const s = h.store as ReturnType<typeof baseStore>;
    s.addNote = vi.fn(async () => { throw new NoteTooLongError(31_000); });
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'длинный текст' } });
    fireEvent.click(screen.getByText('🔐 Сохранить'));

    expect(await screen.findByText(/слишком длинная/)).toBeTruthy();
    expect(input.value).toBe('длинный текст'); // draft NOT cleared
    expect(s.clearDraft).not.toHaveBeenCalled();
  });

  it('a second submit racing the first (OperationInFlightError) neither clears the draft nor errors', async () => {
    const storeModule = await import('../lib/store');
    const s = h.store as ReturnType<typeof baseStore>;
    let calls = 0;
    s.addNote = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new storeModule.OperationInFlightError();
      await new Promise(r => setTimeout(r, 30)); // first call still running
    });
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'двойной клик' } });

    const saveBtn = screen.getByText('🔐 Сохранить');
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn); // second submit before the first resolves

    // The second call must not leave a false error…
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(document.querySelector('.error-msg')).toBeNull();
    // …and the composer is cleared exactly once — by the FIRST call's success.
    expect(input.value).toBe('');
  });

  it('search count reflects CHAINS, not raw versions', () => {
    const s = h.store as ReturnType<typeof baseStore>;
    const versions = [
      note({ id: 'r1', text: 'корень', createdAt: 100 }),
      note({ id: 'e1', text: 'правка', createdAt: 200, rev: 2, root: 'r1', prev: 'r1', fmt: 'md' }),
    ];
    s.notes = versions;
    s.chains = groupChains(versions);
    s.filteredChains = s.chains;
    s.searchQuery = 'прав';
    render(<Main />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByText('1 из 1')).toBeTruthy(); // one chain either side
  });
});

describe('Main — safebox entry point (R4 visibility formula)', () => {
  it('is HIDDEN on R4 when the device has neither data nor a PIN config', () => {
    render(<Main />);
    expect(screen.queryByLabelText('Защищённый сейф')).toBeNull();
  });

  it('appears when safebox DATA exists (a restored/rolled-back device)', () => {
    h.store.safeboxDataPresent = true;
    render(<Main />);
    expect(screen.getByLabelText('Защищённый сейф')).toBeTruthy();
  });

  it('appears when a PIN CONFIG exists even with no entries yet', () => {
    h.store.safeboxPinConfigured = true;
    render(<Main />);
    expect(screen.getByLabelText('Защищённый сейф')).toBeTruthy();
  });

  it('switching to the safebox hides the notes composer and feed', () => {
    h.store.safeboxDataPresent = true;
    const { container } = render(<Main />);
    fireEvent.click(screen.getByLabelText('Защищённый сейф'));
    expect(container.querySelector('.note-input-wrap')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.notes-feed')?.hasAttribute('hidden')).toBe(true);
  });

  it('offers a one-tap safebox lock while the section is unlocked', () => {
    h.store.safeboxDataPresent = true;
    h.store.safeboxUnlocked = true;
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Закрыть сейф'));
    expect(h.store.lockSafebox).toHaveBeenCalled();
  });

  it('the reset warning counts LOCKED safebox entries as at risk', () => {
    h.store.arweave.resetRisk = { notes: 0, safebox: 2 };
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Настройки'));
    fireEvent.click(screen.getByText('Сброс приложения'));
    fireEvent.click(screen.getByText('Сбросить приложение'));
    expect(screen.getByText(/2 записей ещё НЕ подтверждены/)).toBeTruthy();
    expect(screen.getByText(/в защищённом сейфе: 2/)).toBeTruthy();
  });
});

describe('Main — the safebox subtree is remounted on every lock', () => {
  it('a lock-generation bump clears whatever was typed into the safebox forms', () => {
    h.store.safeboxDataPresent = true;      // activation form (with the seed grid)
    h.store.safeboxLockGeneration = 1;
    const { rerender } = render(<Main />);
    fireEvent.click(screen.getByLabelText('Защищённый сейф'));

    const pin = document.querySelector('#sbx-new-code') as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '135790' } });
    const firstWord = screen.getAllByLabelText(/Слово \d+ из 12/)[0] as HTMLInputElement;
    fireEvent.change(firstWord, { target: { value: 'abandon' } });
    expect((document.querySelector('#sbx-new-code') as HTMLInputElement).value).toBe('135790');

    // A hidden edge / idle lock / app lock bumps the generation.
    h.store.safeboxLockGeneration = 2;
    rerender(<Main />);

    // Remounted from scratch: no PIN and no seed word survives.
    expect((document.querySelector('#sbx-new-code') as HTMLInputElement).value).toBe('');
    expect((screen.getAllByLabelText(/Слово \d+ из 12/)[0] as HTMLInputElement).value).toBe('');
  });
});

describe('Main — «Проверить обновления» в шапке', () => {
  const done = (over: Partial<{ addedNotes: number; updatedNotes: number; changedSafebox: number }> = {}) => ({
    status: 'done' as const,
    at: 1_700_000_000_000,
    addedNotes: 0, updatedNotes: 0, changedSafebox: 0, partial: false,
    ...over,
  });

  it('иконка вызывает checkForUpdates', () => {
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Проверить обновления'));
    expect(h.store.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('во время проверки иконка заблокирована', () => {
    h.store.updateCheck = { status: 'checking', progress: null };
    render(<Main />);
    const btn = screen.getByLabelText('Проверить обновления') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('тост показывает, сколько всего пришло — заметки, правки и сейф вместе', async () => {
    const { rerender } = render(<Main />);
    h.store.updateCheck = done({ addedNotes: 2, updatedNotes: 1, changedSafebox: 3 });
    rerender(<Main />);
    expect(await screen.findByText('✓ Получено с других устройств: 6')).toBeTruthy();
  });

  it('пустая проверка тоста не даёт', () => {
    const { rerender } = render(<Main />);
    h.store.updateCheck = done();
    rerender(<Main />);
    expect(screen.queryByText(/Получено с других устройств/)).toBeNull();
  });

  it('проверка, завершившаяся при ОТКРЫТЫХ настройках, не всплывает тостом после их закрытия', () => {
    const { rerender } = render(<Main />);
    fireEvent.click(screen.getByLabelText('Настройки'));

    // Finishes while the panel is open — the panel's own result line reports it.
    h.store.updateCheck = done({ addedNotes: 2 });
    rerender(<Main />);
    expect(screen.queryByText(/Получено с других устройств/)).toBeNull();

    // Closing must NOT resurrect the news out of context.
    fireEvent.click(screen.getByLabelText('Закрыть настройки'));
    expect(screen.queryByText(/Получено с других устройств/)).toBeNull();
  });
});

// ─── Stage 1: the section lives in the address ──────────────────────

describe('Main — раздел в адресе', () => {
  const inSafebox = (c: HTMLElement) => c.querySelector('.note-input-wrap')?.hasAttribute('hidden') === true;

  it('открывается на разделе из адреса — перезагрузка не теряет место', () => {
    h.store.safeboxDataPresent = true;
    window.history.replaceState(null, '', '#/safebox');
    const { container } = render(<Main />);
    expect(inSafebox(container)).toBe(true);
  });

  it('переключатель пишет адрес, а не локальный стейт', () => {
    h.store.safeboxDataPresent = true;
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Защищённый сейф'));
    expect(window.location.hash).toBe('#/safebox');
    fireEvent.click(screen.getByLabelText('Защищённый сейф'));
    expect(window.location.hash).toBe('#/notes');
  });

  it('мусорный хеш канонизируется, а не оставляет пустой экран', async () => {
    window.history.replaceState(null, '', '#/zzz');
    const { container } = render(<Main />);
    await waitFor(() => expect(window.location.hash).toBe('#/notes'));
    expect(inSafebox(container)).toBe(false);
  });

  it('мусор, введённый поверх АКТИВНОГО раздела, тоже канонизируется', async () => {
    // Both hashes parse to 'notes'; only the raw hash moves. A parsed-value
    // snapshot would skip the render and leave the junk in the address bar.
    const { container } = render(<Main />);
    await act(async () => {
      window.history.replaceState(null, '', '#/zzz');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(window.location.hash).toBe('#/notes'));
    expect(inSafebox(container)).toBe(false);
  });

  it('системная «назад» из сейфа возвращает в заметки', async () => {
    h.store.safeboxDataPresent = true;
    const { container } = render(<Main />);
    fireEvent.click(screen.getByLabelText('Защищённый сейф'));
    expect(inSafebox(container)).toBe(true);

    // jsdom's history.back() is async and flaky; the mechanism under test is
    // "does the app follow popstate", which this drives directly.
    await act(async () => {
      window.history.replaceState(null, '', '#/notes');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(inSafebox(container)).toBe(false);
  });

  it('неизвестный раздел из БУДУЩЕЙ сборки не рисует пустоту (случай отката)', async () => {
    window.history.replaceState(null, '', '#/settings');
    const { container } = render(<Main />);
    await waitFor(() => expect(window.location.hash).toBe('#/notes'));
    expect(container.querySelector('.notes-feed')).toBeTruthy();
  });
});
