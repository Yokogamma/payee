// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// W3 UI matrix: Main with the writer flag mocked ON — edit/history/restore
// controls, markdown rendering, the search plain-fallback and the composer
// preview toggle. Separate file: the flag is a build-time constant.

vi.mock('../lib/flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: false }));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  DRAFT_STORAGE_KEY: 'eternal-notes-draft',
  OperationInFlightError: class OperationInFlightError extends Error {},
  WriterDisabledError: class WriterDisabledError extends Error {},
}));
vi.mock('../lib/theme', () => ({ useTheme: () => ['system', vi.fn()] }));

import { Main } from './Main';
import { groupChains } from '../lib/chains';
import type { NoteData } from '../lib/crypto';

function note(over: Partial<NoteData> & { id: string; text: string }): NoteData {
  return { createdAt: Date.now() - 60_000, fmt: 'md', rev: 1, root: over.id, ...over };
}

function makeStore(notes: NoteData[]) {
  const chains = groupChains(notes);
  return {
    filteredNotes: notes,
    notes,
    chains,
    filteredChains: chains,
    v3Paused: false,
    v4Paused: false,
    resumeV4Uploads: vi.fn(async () => {}),
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
    addNote: vi.fn(async () => {}),
    editNote: vi.fn(async () => {}),
    resumeV3Uploads: vi.fn(async () => {}),
    setSearchQuery: vi.fn(),
    resetApp: vi.fn(),
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      acceptedCount: 0, confirmedCount: 0, unsyncedCount: 0, countsReady: true,
      errorCount: 0, quarantinedCount: 0,
      resetRisk: { notes: 0, safebox: 0 },
      safebox: {
        unsyncedCount: 0, acceptedCount: 0, confirmedCount: 0,
        errorCount: 0, quarantinedCount: 0,
      },
      lastSync: null, lastError: null,
    },
    retrySync: vi.fn(),
    restoring: false,
    restoreProgress: null,
    restoreError: null,
    restoredCount: null,
    restoredUpdatedCount: null,
    retryRestore: vi.fn(),
    clearRestoreStatus: vi.fn(),
    syncStatuses: {} as Record<string, { status: string; txId?: string }>,
    dismissError: vi.fn(),
    persistDraft: vi.fn(async () => {}),
    readDraft: vi.fn(async () => null),
    clearDraft: vi.fn(),
    autoLockTimeout: null,
    setAutoLockTimeout: vi.fn(async () => {}),
    toggleArweave: vi.fn(),
    registerWithInvite: vi.fn(),
    checkAccess: vi.fn(),
    hasPin: false,
    setupPin: vi.fn(),
    removePin: vi.fn(),
    showMnemonic: vi.fn(() => 'a b c'),
  };
}

/** One chain: root (v1) + current markdown edit (v2). */
function chainNotes(): NoteData[] {
  return [
    note({ id: 'root1', text: 'исходный текст', fmt: 'plain', createdAt: 1000 }),
    note({ id: 'edit1', text: '# Заголовок\n\n**жирный** текст', rev: 2, root: 'root1', prev: 'root1', createdAt: 2000 }),
  ];
}

beforeEach(() => {
  h.store = makeStore(chainNotes());
  sessionStorage.clear();
});
afterEach(cleanup);

describe('Main W3 — markdown rendering', () => {
  it('renders the CURRENT md version as a markdown element tree (no raw #)', () => {
    render(<Main />);
    const heading = document.querySelector('.note-md h1');
    expect(heading?.textContent).toBe('Заголовок');
    expect(document.querySelector('.note-md strong')?.textContent).toBe('жирный');
    // one card per chain
    expect(document.querySelectorAll('.note-card')).toHaveLength(1);
    // version badge visible
    expect(screen.getByText('v2')).toBeTruthy();
  });

  it('falls back to PLAIN text with <mark> while a search query is active', () => {
    (h.store as ReturnType<typeof makeStore>).searchQuery = 'жирный';
    render(<Main />);
    expect(document.querySelector('.note-md')).toBeNull(); // markdown off
    expect(document.querySelector('mark')?.textContent).toBe('жирный');
    expect(document.querySelector('.note-text')?.textContent).toContain('**жирный**'); // raw markdown text
  });

  it('a plain-fmt current version renders as text even without a query', () => {
    h.store = makeStore([note({ id: 'p1', text: '*звёзды* литеральны', fmt: 'plain' })]);
    render(<Main />);
    expect(document.querySelector('.note-md')).toBeNull();
    expect(document.querySelector('.note-text')?.textContent).toContain('*звёзды*');
  });
});

describe('Main W3 — composer toolbar/preview', () => {
  it('shows the toolbar; a bold click wraps the selection', async () => {
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'слово' } });
    input.setSelectionRange(0, 5);
    fireEvent.click(screen.getByLabelText('Жирный'));
    await waitFor(() => expect(input.value).toBe('**слово**'));
  });

  it('preview toggle renders the draft as markdown and back', () => {
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '# Черновик' } });
    fireEvent.click(screen.getByText('Превью'));
    expect(document.querySelector('.composer-preview .note-md h1')?.textContent).toBe('Черновик');
    fireEvent.click(screen.getByText('Редактор'));
    expect((document.querySelector('.note-input') as HTMLTextAreaElement).value).toBe('# Черновик');
  });
});

describe('Main W3 — edit flow', () => {
  it('menu → Редактировать opens the modal prefilled; save calls editNote and closes', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('✏️ Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('# Заголовок\n\n**жирный** текст'); // current version prefilled

    fireEvent.change(textarea, { target: { value: 'новая версия' } });
    fireEvent.click(screen.getByText('🔐 Сохранить новую версию'));
    await waitFor(() => expect(s.editNote).toHaveBeenCalledWith('root1', 'новая версия'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // closed on success
  });

  it('a failed save keeps the modal open with the text and an inline error', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    s.editNote = vi.fn(async () => { throw new Error('quota'); });
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('✏️ Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'не сохранится' } });
    fireEvent.click(screen.getByText('🔐 Сохранить новую версию'));

    expect(await screen.findByText(/Не удалось сохранить версию/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Редактирование заметки' })).toBeTruthy(); // still open
    expect((dialog.querySelector('.note-input') as HTMLTextAreaElement).value).toBe('не сохранится');
  });
});

describe('Main W3 — history + restore-version flow', () => {
  it('history lists versions ordinally with dates; restore goes through the async confirm', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('🕓 История версий (2)'));

    // History modal open — exactly one dialog.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText(/Версия 2 из 2/)).toBeTruthy();
    expect(screen.getByText(/Версия 1 из 2/)).toBeTruthy();

    // Expand the OLD version → restore button appears.
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('↩️ Вернуть эту версию'));

    // Modal-stack: history replaced by the confirm — still exactly ONE dialog.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute('aria-label')).toBe('Вернуть эту версию?');

    // Confirm: editNote is called with the OLD text AND its original fmt.
    fireEvent.click(screen.getByText('Вернуть'));
    await waitFor(() =>
      expect(s.editNote).toHaveBeenCalledWith('root1', 'исходный текст', { fmt: 'plain' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancelling the confirm reopens history focused on the same version row', async () => {
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('🕓 История версий (2)'));
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('↩️ Вернуть эту версию'));
    fireEvent.click(screen.getByText('Отмена'));

    // History back, one dialog, the old-version row focused + expanded.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute('aria-label')).toBe('История версий');
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain('Версия 1 из 2');
    });
  });

  it('a failing restore shows the error INSIDE the confirm without closing it', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    s.editNote = vi.fn(async () => { throw new Error('offline db'); });
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('🕓 История версий (2)'));
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('↩️ Вернуть эту версию'));
    fireEvent.click(screen.getByText('Вернуть'));

    expect(await screen.findByText(/Не удалось вернуть версию/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Вернуть эту версию?' })).toBeTruthy();
  });

  it('the updated immutability hint mentions versions', () => {
    render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    expect(screen.getByText(/редактирование добавляет новую версию/)).toBeTruthy();
  });
});

describe('Main W3 — edit buffer survives background chain rebuilds (review regression)', () => {
  it('typing in the edit modal is NOT overwritten when the store rebuilds chain objects', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    const { rerender } = render(<Main />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('✏️ Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'несохранённый черновик правки' } });

    // Background publishNotes (e.g. a restore sweep) rebuilds EVERY chain
    // object with fresh identities — same data, new references.
    h.store = { ...s, ...makeStore(chainNotes()) };
    rerender(<Main />);

    const after = screen.getByRole('dialog', { name: 'Редактирование заметки' })
      .querySelector('.note-input') as HTMLTextAreaElement;
    expect(after.value).toBe('несохранённый черновик правки'); // edit preserved
  });
});

describe('Main W3 — Ctrl+Enter works in preview mode (review fix)', () => {
  it('submits from the preview surface where the textarea is unmounted', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main />);
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'из превью' } });
    fireEvent.click(screen.getByText('Превью'));
    expect(document.querySelector('.note-input')).toBeNull(); // textarea gone

    const preview = document.querySelector('.composer-preview') as HTMLElement;
    fireEvent.keyDown(preview, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(s.addNote).toHaveBeenCalledWith('из превью'));
  });
});
