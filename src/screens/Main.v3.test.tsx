// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

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

/**
 * Reading a note full screen. The state lives in the ADDRESS — that is what
 * makes the Android Back gesture close it — so these drive `location.hash`
 * and `popstate` rather than a local flag.
 */
describe('Main — чтение заметки', () => {
  const openFirstNote = () => {
    fireEvent.click(screen.getByRole('button', { name: /^Открыть заметку от/ }));
  };

  it('открывает заметку по адресу и снимает всю оболочку', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openFirstNote();

    expect(window.location.hash).toBe('#/notes/root1');
    // Unmounted, not hidden — the same invariant the composer carries.
    expect(document.querySelector('.notes-feed')).toBeNull();
    expect(document.querySelector('.search-bar')).toBeNull();
    expect(document.querySelector('.status-line')).toBeNull();
    expect(document.querySelector('.app-nav')).toBeNull();
    expect(document.querySelectorAll('[hidden]')).toHaveLength(0);
    expect(document.querySelector('.main-screen')?.className).toContain('main-screen--reading');
    expect(document.querySelector('.note-reader-body')).toBeTruthy();
  });

  it('системный Back возвращает ленту и фокус на ту же карточку', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openFirstNote();

    act(() => {
      window.history.back();
      // jsdom's history.back() is async and flaky under fake timers; the event
      // is what the app listens to, so dispatch it directly (same shape as the
      // section-level Back test above).
      window.history.replaceState({ enSection: true }, '', '#/notes');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(document.querySelector('.notes-feed')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Открыть заметку от/ }),
    );
  });

  it('«Назад» над нашей записью идёт назад, а над чужой — заменяет адрес', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openFirstNote();
    expect(window.history.state).toEqual({ enSection: true });

    // A cold start into a note leaves someone else's entry behind us, and
    // history.back() would leave the app entirely.
    act(() => {
      window.history.replaceState(null, '', '#/notes/root1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const before = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(window.location.hash).toBe('#/notes');
    expect(window.history.length).toBe(before);
  });

  it('имя кнопки открытия — абсолютная дата, без «назад» и «только что»', () => {
    // The feed prints «только что» for a fresh note; a control must not be
    // named by a moving target.
    h.store = makeStore([note({ id: 'fresh', text: 'свежая', createdAt: Date.now() })]);
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    const name = screen.getByRole('button', { name: /^Открыть заметку от/ })
      .getAttribute('aria-label') ?? '';
    expect(name).not.toMatch(/назад|только что/);
  });

  it('неизвестный id вычищается из адреса, но НЕ пока идёт восстановление', () => {
    const s = h.store as ReturnType<typeof makeStore>;
    s.restoring = true;
    window.history.replaceState(null, '', '#/notes/no-such-id');
    const { rerender } = render(<Main theme="system" onThemeChange={vi.fn()} />);
    // Held: the id may simply not have arrived yet.
    expect(window.location.hash).toBe('#/notes/no-such-id');
    expect(document.querySelector('.notes-feed')).toBeTruthy();

    s.restoring = false;
    act(() => { rerender(<Main theme="system" onThemeChange={vi.fn()} />); });
    expect(window.location.hash).toBe('#/notes');
  });

  it('чтение выигрывает у композера при заходе с сохранённым черновиком', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    s.readDraft = vi.fn(async () => 'недописанное');
    window.history.replaceState(null, '', '#/notes/root1');
    render(<Main theme="system" onThemeChange={vi.fn()} />);

    // The auto-expand effect fires when the draft lands; without the guard
    // both fullscreen subtrees would render at once.
    await waitFor(() => expect(s.readDraft).toHaveBeenCalled());
    expect(document.querySelector('.note-reader-body')).toBeTruthy();
    expect(document.querySelector('.note-input')).toBeNull();
    expect(document.querySelector('.main-screen')?.className).not.toContain('--composing');
  });

  it('правка доступна из чтения — и кнопкой, и пунктом меню', () => {
    window.history.replaceState(null, '', '#/notes/root1');
    render(<Main theme="system" onThemeChange={vi.fn()} />);

    // Thumb-reach route.
    fireEvent.click(screen.getByRole('button', { name: 'Редактировать заметку' }));
    expect(screen.getByRole('dialog', { name: 'Редактирование заметки' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));

    // Keyboard / screen-reader route: the menu where every other note action
    // already lives. Its ABSENCE is what the writer-off matrix asserts, so
    // this positive case is what keeps that assertion from passing vacuously.
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('Редактировать'));
    expect(screen.getByRole('dialog', { name: 'Редактирование заметки' })).toBeTruthy();
  });

  it('и правка из чтения действительно сохраняется', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    window.history.replaceState(null, '', '#/notes/root1');
    render(<Main theme="system" onThemeChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Редактировать заметку' }));
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'правка из читалки' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить новую версию' }));

    await waitFor(() => expect(s.editNote).toHaveBeenCalledWith('root1', 'правка из читалки'));
  });

  /**
   * ALL THREE dialogs, not just the edit one. They render as unconditional
   * siblings outside the routed section and none of them listens to popstate,
   * so each has to be shown to close on a route change — otherwise a forgotten
   * one stands over the restored feed.
   */
  const openers: Array<[string, () => void]> = [
    ['EditNoteModal', () => {
      fireEvent.click(screen.getByRole('button', { name: 'Редактировать заметку' }));
    }],
    ['VersionHistoryModal', () => {
      fireEvent.click(screen.getByLabelText('Меню заметки'));
      fireEvent.click(screen.getByText(/История версий/));
    }],
    ['RestoreVersionDialog', () => {
      fireEvent.click(screen.getByLabelText('Меню заметки'));
      fireEvent.click(screen.getByText(/История версий/));
      fireEvent.click(screen.getByText(/Версия 1 из 2/));
      fireEvent.click(document.querySelector('.history-restore-btn') as HTMLButtonElement);
    }],
  ];

  for (const [name, open] of openers) {
    it(`переход маршрута закрывает ${name} и не оставляет её над лентой`, () => {
      window.history.replaceState(null, '', '#/notes/root1');
      render(<Main theme="system" onThemeChange={vi.fn()} />);
      open();
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();

      act(() => {
        window.history.replaceState({ enSection: true }, '', '#/notes');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('.notes-feed')).toBeTruthy();
    });
  }

  it('и смена СЕКЦИИ тоже: диалог не остаётся поверх сейфа', () => {
    // Это уже существовавшая дыра — модалка рендерится вне секции и переживала
    // переход. Тот же ключ маршрута закрывает и её.
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText('Редактировать'));
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Сейф/ }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('«Назад» над НАШЕЙ записью уходит назад по истории, а не заменяет адрес', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    openFirstNote();
    expect(window.history.state).toEqual({ enSection: true });

    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const lengthBefore = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(back).toHaveBeenCalledTimes(1);
    // Никакой замены адреса поверх нашей же записи.
    expect(window.history.length).toBe(lengthBefore);
    back.mockRestore();
  });

  it('#/settings/x канонизируется в #/settings', () => {
    window.history.replaceState(null, '', '#/settings/x');
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    expect(window.location.hash).toBe('#/settings');
  });
});

/**
 * The late UI tail of a restore.
 *
 * `confirmRestore` awaits `editNote` and then closes the stack and moves
 * focus. If the user left in the meantime, the feed is mounted again by the
 * time that resolves — so the tail would yank focus off the card and onto its
 * ⋯ button. The WRITE must still land; only the tail is invalidated.
 */
describe('Main — поздний хвост восстановления версии', () => {
  it('запись доходит, но фокус после Back не перехватывается', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    let release!: () => void;
    s.editNote = vi.fn(() => new Promise<void>(res => { release = res; }));

    window.history.replaceState(null, '', '#/notes/root1');
    render(<Main theme="system" onThemeChange={vi.fn()} />);

    // Open history from the reader, pick the older version, confirm.
    fireEvent.click(screen.getByLabelText('Меню заметки'));
    fireEvent.click(screen.getByText(/История версий/));
    // The restore control only exists inside an EXPANDED row.
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    // Its label is split across an icon and text, so query by class.
    const restoreBtn = document.querySelector('.history-restore-btn') as HTMLButtonElement;
    expect(restoreBtn).toBeTruthy();
    fireEvent.click(restoreBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }));
    expect(s.editNote).toHaveBeenCalled();

    // Leave while the write is still in flight.
    act(() => {
      window.history.replaceState({ enSection: true }, '', '#/notes');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const card = screen.getByRole('button', { name: /^Открыть заметку от/ });
    card.focus();

    await act(async () => { release(); });

    // The write happened; the tail did not.
    expect(s.editNote).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});

/**
 * The feed's scroll position across a trip into a note.
 *
 * The feed unmounts for the COMPOSER as well, so a restore keyed only on
 * «the feed is mounted again» replays the position on every composer close —
 * dropping the user mid-list right after they save, with the note they wrote
 * off-screen at the top.
 */
describe('Main — прокрутка ленты', () => {
  const feed = () => document.querySelector('.notes-feed') as HTMLDivElement | null;
  const openFirstNote = () => {
    fireEvent.click(screen.getByRole('button', { name: /^Открыть заметку от/ }));
  };
  const back = () => act(() => {
    window.history.replaceState({ enSection: true }, '', '#/notes');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  it('возвращается на прежнее место после чтения', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    feed()!.scrollTop = 800;
    openFirstNote();
    back();
    expect(feed()?.scrollTop).toBe(800);
  });

  it('но НЕ отбрасывает ленту после сохранения заметки', async () => {
    const s = h.store as ReturnType<typeof makeStore>;
    render(<Main theme="system" onThemeChange={vi.fn()} />);

    // Один поход в заметку — именно он раньше «отравлял» все последующие
    // закрытия композера.
    feed()!.scrollTop = 800;
    openFirstNote();
    back();
    expect(feed()?.scrollTop).toBe(800);

    // Пользователь возвращается наверх и пишет новую заметку.
    feed()!.scrollTop = 0;
    openComposer();
    const input = document.querySelector('.note-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'новая заметка' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.addNote).toHaveBeenCalled());

    // Лента должна остаться там, где её оставил пользователь.
    expect(feed()?.scrollTop).toBe(0);
  });

  it('и не отбрасывает после простого «Свернуть»', () => {
    render(<Main theme="system" onThemeChange={vi.fn()} />);
    feed()!.scrollTop = 800;
    openFirstNote();
    back();

    feed()!.scrollTop = 0;
    openComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть' }));
    expect(feed()?.scrollTop).toBe(0);
  });
});
