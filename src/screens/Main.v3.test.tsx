// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// W3 UI matrix: Main with the writer flag mocked ON — edit/history/restore
// controls, markdown rendering, the search plain-fallback and the composer
// preview toggle. Separate file: the flag is a build-time constant.

vi.mock('../lib/flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: false, QUICK_UNLOCK_ENABLED: false }));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  DRAFT_STORAGE_KEY: 'eternal-notes-draft',
  OperationInFlightError: class OperationInFlightError extends Error {},
  WriterDisabledError: class WriterDisabledError extends Error {},
}));
vi.mock('../lib/theme', () => ({ useTheme: () => ['system', vi.fn()] }));

import { Main } from './Main';
import { resetRoute } from '../test-stubs/route-reset';
import { groupChains } from '../lib/chains';
import { noteSearchText } from '../lib/note-search-text';
import type { NoteData } from '../lib/crypto';

function note(over: Partial<NoteData> & { id: string; text: string }): NoteData {
  return { createdAt: Date.now() - 60_000, fmt: 'md', rev: 1, root: over.id, ...over };
}

// `filteredChains` used to be handed in as the FULL list whatever the query
// was, so this matrix could not have noticed the store filtering on raw
// markdown while the card printed stripped text. It mirrors the real filter in
// store.tsx now — same helper, same comparison.
function applyQuery<T extends { text: string; fmt?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(n => noteSearchText(n).toLowerCase().includes(q));
}

function makeStore(notes: NoteData[], searchQuery = '') {
  const chains = groupChains(notes);
  return {
    filteredNotes: applyQuery(notes, searchQuery),
    notes,
    chains,
    filteredChains: chains.filter(c => applyQuery([c.current], searchQuery).length > 0),
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
    searchQuery,
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
    updateCheck: { status: 'idle' as const },
    checkForUpdates: vi.fn(),
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

/** The composer is collapsed by default now — open it before typing. */
function openComposer() {
  fireEvent.click(screen.getByRole('button', { name: /Новая заметка/ }));
}

beforeEach(() => {
  h.store = makeStore(chainNotes());
  sessionStorage.clear();
  resetRoute(); // the section is in location.hash and jsdom keeps one per file
});
afterEach(cleanup);

describe('Main W3 — markdown rendering', () => {
  it('renders the CURRENT md version as a markdown element tree (no raw #)', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    const heading = document.querySelector('.note-md h1');
    expect(heading?.textContent).toBe('Заголовок');
    expect(document.querySelector('.note-md strong')?.textContent).toBe('жирный');
    // one card per chain
    expect(document.querySelectorAll('.note-card')).toHaveLength(1);
    // «v2» был жаргоном системы контроля версий на экране для людей
    expect(screen.getByText('2-я версия')).toBeTruthy();
  });

  it('falls back to PLAIN text with <mark> while a search query is active', () => {
    h.store = makeStore(chainNotes(), 'жирный');
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    expect(document.querySelector('.note-md')).toBeNull(); // markdown off
    expect(document.querySelector('mark')?.textContent).toBe('жирный');

    // …but PLAIN text, not SOURCE. This line used to assert `**жирный**` —
    // it was describing the bug rather than guarding against it, and the
    // asterisks reached a real phone: typing a query turned every markdown
    // note in the feed into its own syntax. The markers are stripped for
    // display only; the stored note is untouched.
    const shown = document.querySelector('.note-text')?.textContent ?? '';
    expect(shown).toContain('жирный');
    expect(shown, 'разметка не должна показываться читателю').not.toMatch(/[*#`]/);
  });

  it('фраза через маркер жирности находится и подсвечивается', () => {
    // Фильтр и подсветка обязаны читать одну строку. Пока фильтр смотрел в
    // исходник, карточка с «до **важное**» не находилась по «до важное» —
    // ровно по той фразе, которую пользователь видит на экране.
    h.store = makeStore([note({ id: 'r2', text: 'до **важное** после' })], 'до важное');
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    expect(document.querySelectorAll('.note-card')).toHaveLength(1);
    expect(document.querySelector('mark')?.textContent).toBe('до важное');
  });

  it('совпадение в адресе ссылки не даёт карточку без видимой подсветки', () => {
    h.store = makeStore(
      [note({ id: 'r3', text: 'см. [документацию](https://example.invalid/secret-path)' })],
      'secret-path',
    );
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    expect(document.querySelectorAll('.note-card')).toHaveLength(0);
  });

  it('a plain-fmt current version renders as text even without a query', () => {
    h.store = makeStore([note({ id: 'p1', text: '*звёзды* литеральны', fmt: 'plain' })]);
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    expect(document.querySelector('.note-md')).toBeNull();
    expect(document.querySelector('.note-text')?.textContent).toContain('*звёзды*');
  });
});

describe('Main W3 — composer toolbar/preview', () => {
  it('shows the toolbar; a bold click wraps the selection', async () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openComposer();
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'слово' } });
    input.setSelectionRange(0, 5);
    fireEvent.click(screen.getByLabelText('Жирный'));
    await waitFor(() => expect(input.value).toBe('**слово**'));
  });

  it('preview toggle renders the draft as markdown and back', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openComposer();
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
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('# Заголовок\n\n**жирный** текст'); // current version prefilled

    fireEvent.change(textarea, { target: { value: 'новая версия' } });
    fireEvent.click(screen.getByText('Сохранить новую версию'));
    await waitFor(() => expect(s.editNote).toHaveBeenCalledWith('root1', 'новая версия'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // closed on success
  });

  it('a failed save keeps the modal open with the text and an inline error', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    s.editNote = vi.fn(async () => { throw new Error('quota'); });
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'не сохранится' } });
    fireEvent.click(screen.getByText('Сохранить новую версию'));

    expect(await screen.findByText(/Не удалось сохранить версию/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Редактирование заметки' })).toBeTruthy(); // still open
    expect((dialog.querySelector('.note-input') as HTMLTextAreaElement).value).toBe('не сохранится');
  });
});

describe('Main W3 — history + restore-version flow', () => {
  it('history lists versions ordinally with dates; restore goes through the async confirm', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('История версий (2)'));

    // History modal open — exactly one dialog.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText(/Версия 2 из 2/)).toBeTruthy();
    expect(screen.getByText(/Версия 1 из 2/)).toBeTruthy();

    // Expand the OLD version → restore button appears.
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('Вернуть эту версию'));

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
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('История версий (2)'));
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('Вернуть эту версию'));
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
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('История версий (2)'));
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    fireEvent.click(screen.getByText('Вернуть эту версию'));
    fireEvent.click(screen.getByText('Вернуть'));

    expect(await screen.findByText(/Не удалось вернуть версию/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Вернуть эту версию?' })).toBeTruthy();
  });

  it('подсказка говорит о неизменяемости ОПУБЛИКОВАННОГО, а не о факте публикации', () => {
    // Прежний текст обещал «каждая версия навсегда сохраняется в блокчейне»
    // под КАЖДОЙ заметкой — включая лежащую только на устройстве. Здесь
    // синхронизация выключена (baseStore), и подсказка не должна ничего
    // обещать про блокчейн для этой записи.
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    const hint = document.querySelector('.card-menu-hint')!.textContent!;
    expect(hint).toMatch(/добавляет новую версию/);
    expect(hint).toMatch(/уже опубликованную/);
    expect(hint, 'безусловного обещания «каждая версия сохраняется» быть не должно')
      .not.toMatch(/Каждая версия навсегда сохраняется/);
  });
});

describe('Main W3 — edit buffer survives background chain rebuilds (review regression)', () => {
  it('typing in the edit modal is NOT overwritten when the store rebuilds chain objects', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    const { rerender } = render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('Редактировать'));

    const dialog = screen.getByRole('dialog', { name: 'Редактирование заметки' });
    const textarea = dialog.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'несохранённый черновик правки' } });

    // Background publishNotes (e.g. a restore sweep) rebuilds EVERY chain
    // object with fresh identities — same data, new references.
    h.store = { ...s, ...makeStore(chainNotes()) };
    rerender(<Main theme="system" onThemeChange={vi.fn()} />);

    const after = screen.getByRole('dialog', { name: 'Редактирование заметки' })
      .querySelector('.note-input') as HTMLTextAreaElement;
    expect(after.value).toBe('несохранённый черновик правки'); // edit preserved
  });
});

describe('Main W3 — Ctrl+Enter works in preview mode (review fix)', () => {
  it('submits from the preview surface where the textarea is unmounted', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openComposer();
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'из превью' } });
    fireEvent.click(screen.getByText('Превью'));
    expect(document.querySelector('.note-input')).toBeNull(); // textarea gone

    const preview = document.querySelector('.composer-preview') as HTMLElement;
    fireEvent.keyDown(preview, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(s.addNote).toHaveBeenCalledWith('из превью'));
  });
});
