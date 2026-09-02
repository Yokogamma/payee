// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// §8 UI matrix for the safebox surface: the PIN pad, the activation copy, the
// card actions (a copied password must NEVER reach the DOM), the reveal
// auto-hide, the anti-autofill attribute set and the writer-OFF surface.

vi.mock('../lib/flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: true, QUICK_UNLOCK_ENABLED: false }));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/store')>();
  return { ...actual, useNotes: () => h.store };
});

import { SafeboxSection } from './SafeboxSection';
import { SafeboxActivation } from './SafeboxActivation';
import { SafeboxEntryForm } from './SafeboxEntryForm';
import { MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES } from '../lib/limits';
import { groupSafeboxChains } from '../lib/chains';
import type { SafeboxEntryData } from '../lib/crypto';


function entry(over: Partial<SafeboxEntryData> & { id: string }): SafeboxEntryData {
  return {
    createdAt: 1000, title: 'GitHub', login: 'yoko', url: 'https://github.com',
    note: '', files: [], rev: 1, root: over.id, ...over,
  };
}

function baseStore(entries: SafeboxEntryData[] = [entry({ id: 'e1' })]) {
  const chains = groupSafeboxChains(entries);
  return {
    safeboxUnlocked: true,
    safeboxPinConfigured: true,
    safeboxDataPresent: true,
    safeboxEntryCount: entries.length,
    safeboxEntries: entries,
    safeboxChains: chains,
    filteredSafeboxChains: chains,
    safeboxSearchQuery: '',
    setSafeboxSearchQuery: vi.fn(),
    lockSafebox: vi.fn(),
    touchSafebox: vi.fn(),
    addSafeboxEntry: vi.fn(async () => {}),
    editSafeboxEntry: vi.fn(async () => {}),
    restoreSafeboxVersion: vi.fn(async () => {}),
    revealSafeboxSecret: vi.fn(async () => 'PLAINTEXT-PASSWORD'),
    copySafeboxPassword: vi.fn(async () => true),
    retrySync: vi.fn(),
    downloadSafeboxAttachment: vi.fn(async () => {}),
    unlockSafebox: vi.fn(async () => {}),
    activateSafebox: vi.fn(async () => {}),
    resetSafeboxPinWithSeed: vi.fn(async () => {}),
    getSafeboxPinLockState: vi.fn(async () => ({ lockedSeconds: 0, attempts: 0, configured: true })),
    syncStatuses: { e1: { status: 'confirmed' as const, txId: 'TX1' } },
    arweave: { enabled: true, registered: true },
    v4Paused: false,
    resumeV4Uploads: vi.fn(async () => {}),
    isEncrypting: false,
  };
}

beforeEach(() => { h.store = baseStore(); });
afterEach(cleanup);

describe('SafeboxSection — unlocked list', () => {
  it('shows the entry with its login and the sync badge, but NO password anywhere', () => {
    const { container } = render(<SafeboxSection />);
    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.getByText('yoko')).toBeDefined();
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
  });

  it('copying a password NEVER puts the plaintext in the DOM', async () => {
    const { container } = render(<SafeboxSection />);
    await act(async () => {
      fireEvent.click(screen.getByText('Пароль'));
    });
    expect(h.store.copySafeboxPassword).toHaveBeenCalledWith('e1');
    // The store writes to the clipboard straight from the decrypted string.
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
    expect(container.textContent).toContain('Буфер будет очищен');
  });

  it('the copy toast tells the honest clipboard story (best-effort, on return)', async () => {
    render(<SafeboxSection />);
    await act(async () => { fireEvent.click(screen.getByText('Пароль')); });
    expect(screen.getByText(/Пароль скопирован/)).toBeDefined();
    expect(screen.getByText(/~60 с/)).toBeDefined();
  });

  it('«Показать» reveals the password and it auto-hides', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<SafeboxSection />);
      await act(async () => { fireEvent.click(screen.getByText('Показать')); });
      expect(container.textContent).toContain('PLAINTEXT-PASSWORD');

      await act(async () => { vi.advanceTimersByTime(21_000); });
      expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lock clears an already-revealed password immediately', async () => {
    const { container, rerender } = render(<SafeboxSection />);
    await act(async () => { fireEvent.click(screen.getByText('Показать')); });
    expect(container.textContent).toContain('PLAINTEXT-PASSWORD');

    h.store = { ...baseStore(), safeboxUnlocked: false };
    rerender(<SafeboxSection />);
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
  });

  it('offers a download button per attachment', async () => {
    h.store = baseStore([entry({
      id: 'e1',
      files: [{ fid: 'f1', name: 'id_ed25519', mime: 'text/plain', size: 400 }],
    })]);
    render(<SafeboxSection />);
    // Вложения — данные записи, а не действие строки, поэтому они внутри ⋯.
    fireEvent.click(screen.getByRole('button', { name: /Меню записи/ }));
    await act(async () => { fireEvent.click(screen.getByText(/id_ed25519/)); });
    expect(h.store.downloadSafeboxAttachment).toHaveBeenCalledWith('e1', 'f1');
  });

  it('search is scoped to the safebox and reports the filtered count', () => {
    render(<SafeboxSection />);
    const input = screen.getByLabelText('Поиск по сейфу');
    fireEvent.change(input, { target: { value: 'git' } });
    expect(h.store.setSafeboxSearchQuery).toHaveBeenCalledWith('git');
  });

  // The v4-pause banner MOVED to the status line: keeping it here as well
  // showed the same sentence twice inside the safebox, and hid the pause from
  // every other section. Covered by StatusLine.test.tsx («пауза v4 тоже»).
  it('пауза v4 больше НЕ дублируется внутри секции', () => {
    h.store = { ...baseStore(), v4Paused: true };
    render(<SafeboxSection />);
    expect(screen.queryByText(/приостановлена/)).toBeNull();
  });

  it('warns when «Вечное хранилище» is inactive (entries are LOCAL only)', () => {
    h.store = { ...baseStore(), arweave: { enabled: false, registered: false } };
    render(<SafeboxSection />);
    expect(screen.getByText(/только на этом устройстве/)).toBeDefined();
  });
});

describe('SafeboxSection — locked / not configured', () => {
  it('renders the PIN pad when a config exists but the section is locked', async () => {
    h.store = { ...baseStore(), safeboxUnlocked: false };
    render(<SafeboxSection />);
    await waitFor(() => expect(screen.getByText('Сейф заблокирован')).toBeDefined());
    expect(screen.getByText(/PIN сейфа можно сбросить только вводом полной seed-фразы/)).toBeDefined();
  });

  it('the PIN pad input carries the FULL anti-autofill set and a non-heuristic name', async () => {
    h.store = { ...baseStore(), safeboxUnlocked: false };
    const { container } = render(<SafeboxSection />);
    await waitFor(() => expect(screen.getByText('Сейф заблокирован')).toBeDefined());

    const input = container.querySelector('input.pin-input')!;
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    expect(input.getAttribute('data-1p-ignore')).toBe('');
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(input.getAttribute('data-bwignore')).toBe('');
    expect(input.getAttribute('data-form-type')).toBe('other');
    // A manager-friendly name would defeat the whole point.
    expect(input.getAttribute('name')).not.toMatch(/pass|pin|login|user/i);
  });

  it('renders the activation flow when no PIN is configured', () => {
    h.store = { ...baseStore(), safeboxUnlocked: false, safeboxPinConfigured: false };
    render(<SafeboxSection />);
    expect(screen.getByText('Защищённый сейф')).toBeDefined();
  });
});

describe('SafeboxActivation copy (honest threat model)', () => {
  it('states the PIN is an access gate, not a crypto boundary, and demands writing the seed down NOW', () => {
    const { container } = render(
      <SafeboxActivation dataPresent={false} entryCount={0} syncInactive={false} />,
    );
    expect(container.textContent).toContain('гейт доступа, а не крипто-граница');
    expect(container.textContent).toContain('Запишите seed-фразу сейчас');
    expect(container.textContent).toContain('навсегда остаются в зашифрованной истории');
  });

  it('shows «Найден сейф: N записей» and the seed grid when data already exists', () => {
    const { container } = render(
      <SafeboxActivation dataPresent entryCount={7} syncInactive={false} />,
    );
    expect(container.textContent).toContain('Найден сейф: 7 записей');
    expect(screen.getAllByLabelText(/Слово \d+ из 12/)).toHaveLength(12);
  });

  it('warns that entries are NOT recoverable while sync is inactive', () => {
    const { container } = render(
      <SafeboxActivation dataPresent={false} entryCount={0} syncInactive />,
    );
    expect(container.textContent).toContain('НЕ будут восстановимы по seed-фразе');
  });

  it('every PIN field carries the anti-autofill set', () => {
    const { container } = render(
      <SafeboxActivation dataPresent={false} entryCount={0} syncInactive={false} />,
    );
    const inputs = [...container.querySelectorAll('input.pin-input')];
    expect(inputs.length).toBe(2);
    for (const input of inputs) {
      expect(input.getAttribute('autocomplete')).toBe('new-password');
      expect(input.getAttribute('data-lpignore')).toBe('true');
      expect(input.getAttribute('name')).not.toMatch(/pass|pin|login|user/i);
    }
  });
});

// ─── Attachment intake races (review follow-up) ─────────────────────

describe('SafeboxEntryForm — attachment intake', () => {
  /** A File whose `arrayBuffer()` we control, so a lock/unmount or a second
   *  pick can be injected mid-read. */
  function slowFile(name: string, size: number) {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const file = {
      name,
      type: 'application/octet-stream',
      size,
      async arrayBuffer() {
        await gate;
        return new ArrayBuffer(size);
      },
    } as unknown as File;
    return { file, release };
  }

  function fileList(...files: File[]): FileList {
    return { length: files.length, item: (i: number) => files[i], ...files } as unknown as FileList;
  }

  function renderForm(onCreate = vi.fn(async () => {})) {
    const utils = render(
      <SafeboxEntryForm
        open
        current={null}
        busy={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSave={vi.fn(async () => {})}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    return { ...utils, input };
  }

  it('rejects an over-budget pick BEFORE reading it (no arrayBuffer call)', async () => {
    const { input } = renderForm();
    const huge = {
      name: 'huge.bin', type: 'application/octet-stream',
      size: MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES * 100,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    } as unknown as File;

    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(huge) } });
    });
    expect(screen.getByText(/Суммарный размер вложений/)).toBeDefined();
    // A multi-gigabyte File must never be materialised in memory.
    expect((huge as unknown as { arrayBuffer: ReturnType<typeof vi.fn> }).arrayBuffer)
      .not.toHaveBeenCalled();
  });

  it('two CONCURRENT picks share one budget (they cannot both spend it)', async () => {
    const { input } = renderForm();
    const half = Math.floor(MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES * 0.6);
    const a = slowFile('a.bin', half);
    const b = slowFile('b.bin', half);

    // Start the first intake and leave it parked inside arrayBuffer().
    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(a.file) } });
    });
    // A second pick arrives BEFORE the first finished: with a render-snapshot
    // budget both would validate against 0 bytes used and jointly pass 120%.
    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(b.file) } });
    });
    expect(screen.getByText(/Суммарный размер вложений/)).toBeDefined();

    await act(async () => { a.release(); b.release(); await Promise.resolve(); });
    // Only the first pick was admitted.
    expect(screen.queryByText('b.bin')).toBeNull();
    expect(screen.getByText('a.bin')).toBeDefined();
  });

  it('an unmount mid-read (a section lock) drops what was already read', async () => {
    const { input, unmount } = renderForm();
    const first = slowFile('first.bin', 100);
    const second = slowFile('second.bin', 100);

    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(first.file, second.file) } });
    });
    // The section locks → Main remounts the subtree → this form unmounts while
    // the loop is parked between the two reads.
    unmount();
    await act(async () => { first.release(); second.release(); await Promise.resolve(); });

    // Nothing was published anywhere; the important part is that the loop
    // stopped instead of continuing to ingest into a dead component.
    expect(document.querySelector('.safebox-file-row')).toBeNull();
  });

  it('a file that changed size between the check and the read is refused', async () => {
    const { input } = renderForm();
    const lying = {
      name: 'lying.bin', type: 'application/octet-stream',
      size: 10,
      async arrayBuffer() { return new ArrayBuffer(9999); }, // grew on disk
    } as unknown as File;

    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(lying) } });
    });
    expect(screen.getByText(/Файл изменился во время чтения/)).toBeDefined();
    expect(screen.queryByText('lying.bin')).toBeNull();
  });

  it('removing a file gives its budget back', async () => {
    const { input } = renderForm();
    const big = Math.floor(MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES * 0.9);
    const first = slowFile('first.bin', big);

    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(first.file) } });
      first.release();
    });
    expect(screen.getByText('first.bin')).toBeDefined();

    // Without the release, a same-size replacement would be refused.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Удалить вложение first.bin'));
    });
    const second = slowFile('second.bin', big);
    await act(async () => {
      fireEvent.change(input, { target: { files: fileList(second.file) } });
      second.release();
    });
    expect(screen.getByText('second.bin')).toBeDefined();
    expect(screen.queryByText(/Суммарный размер вложений/)).toBeNull();
  });
});

describe('SafeboxSection — действия, уехавшие в меню', () => {
  const openMenu = () =>
    fireEvent.click(screen.getByRole('button', { name: /Меню записи/ }));

  it('логин копируется через меню', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    h.store = baseStore([entry({ id: 'e1', login: 'yoko' })]);
    render(<SafeboxSection />);
    openMenu();
    await act(async () => { fireEvent.click(screen.getByText('Копировать логин')); });
    expect(writeText).toHaveBeenCalledWith('yoko');
  });

  it('у записи без логина пункта копирования логина нет', () => {
    h.store = baseStore([entry({ id: 'e1', login: '' })]);
    render(<SafeboxSection />);
    openMenu();
    expect(screen.queryByText('Копировать логин')).toBeNull();
  });

  it('история версий открывается через меню и раскрывает строку', () => {
    const chainEntries = [
      entry({ id: 'e1', rev: 1, root: 'e1' }),
      entry({ id: 'e2', rev: 2, root: 'e1', title: 'GitHub v2' }),
    ];
    h.store = baseStore(chainEntries);
    render(<SafeboxSection />);
    openMenu();
    fireEvent.click(screen.getByText(/История версий \(2\)/));
    expect(screen.getByRole('dialog')).toBeDefined();

    // Раскрытие ВНУТРИ строки остаётся только у сейфа: там короткие поля, а не
    // длинная заметка. Это и есть тот, ради кого `.history-row { flex: none }`
    // продолжает быть нужным после того, как история заметок стала указателем.
    expect(document.querySelector('.history-row-body')).toBeNull();
    fireEvent.click(screen.getByText(/Версия 1 из 2/));
    expect(document.querySelector('.history-row-body')).toBeTruthy();
    expect(document.querySelector('.history-restore-btn')).toBeTruthy();

    // Текущую версию называет слово, а не класс: правило `history-row--current`
    // удалено вместе с коробкой строки, и класс за ним не остался.
    expect(screen.getByText(/· текущая/)).toBeTruthy();
    expect(document.querySelector('.history-row--current')).toBeNull();
  });

  it('пункт «Изменить» открывает форму записи', () => {
    h.store = baseStore();
    render(<SafeboxSection />);
    openMenu();
    fireEvent.click(screen.getByText('Изменить'));
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('НАСТОЯЩАЯ блокировка раздела закрывает открытое меню', () => {
    // Не имитация: перерисовываем секцию с safeboxUnlocked=false, как это
    // делает замок по таймеру или из другой вкладки. Меню, пережившее замок,
    // осталось бы висеть над PIN-падом.
    h.store = baseStore();
    const { rerender } = render(<SafeboxSection />);
    openMenu();
    expect(screen.getByRole('menu')).toBeDefined();

    (h.store as ReturnType<typeof baseStore>).safeboxUnlocked = false;
    rerender(<SafeboxSection />);
    expect(screen.queryByRole('menu')).toBeNull();

    // И при обратном отпирании меню не воскресает.
    (h.store as ReturnType<typeof baseStore>).safeboxUnlocked = true;
    rerender(<SafeboxSection />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('подтверждённая запись показывает ∞ рядом со словом', () => {
    h.store = baseStore();
    (h.store as ReturnType<typeof baseStore>).syncStatuses = { e1: { status: 'confirmed' } };
    render(<SafeboxSection />);
    const state = document.querySelector('.sync-state--permanent')!;
    expect(state.textContent).toContain('навечно');
    expect(state.querySelector('svg'), 'знак вечности рисуется, а не пишется глифом').not.toBeNull();
  });

  it('неподтверждённая запись знака не получает', () => {
    h.store = baseStore();
    (h.store as ReturnType<typeof baseStore>).syncStatuses = { e1: { status: 'queued' } };
    render(<SafeboxSection />);
    expect(document.querySelector('.sync-state')!.querySelector('svg')).toBeNull();
  });
});

describe('CardMenu в сейфе — клавиатура по образцу WAI-ARIA', () => {
  const trigger = () => screen.getByRole('button', { name: /Меню записи/ });

  beforeEach(() => { h.store = baseStore(); });

  it('триггер объявляет наличие попапа', () => {
    render(<SafeboxSection />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('true');
  });

  it('стрелка вниз открывает меню И входит в него', () => {
    render(<SafeboxSection />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
  });

  it('стрелка вверх открывает меню на последнем пункте', () => {
    render(<SafeboxSection />);
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('стрелки ходят по кругу, Home и End прыгают к краям', () => {
    render(<SafeboxSection />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement, 'вверх с первого — на последний').toBe(items[items.length - 1]);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement, 'вниз с последнего — на первый').toBe(items[0]);

    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Tab уводит из меню, а не бродит по его пунктам', () => {
    // Меню — одна остановка в порядке обхода, а не контейнер остановок.
    render(<SafeboxSection />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('SafeboxSection — откат по SAFEBOX_WRITER_ENABLED', () => {
  // Флаг существует ради отката; при выключенном писателе запись без логина,
  // без вложений и в одной версии не даёт меню ни одного пункта.
  it('у записи, которой нечего показать в меню, триггера нет', async () => {
    vi.resetModules();
    vi.doMock('../lib/flags', () => ({ V3_WRITER_ENABLED: false, SAFEBOX_WRITER_ENABLED: false, QUICK_UNLOCK_ENABLED: false }));
    const { SafeboxSection: Section } = await import('./SafeboxSection');

    h.store = baseStore([entry({ id: 'e1', login: '', files: [] })]);
    render(<Section />);
    expect(screen.queryByRole('button', { name: /Меню записи/ })).toBeNull();
    // Две основные кнопки на месте — пропала только пустая ⋯.
    expect(screen.getByText('Пароль')).toBeTruthy();
    expect(screen.getByText('Показать')).toBeTruthy();

    vi.doUnmock('../lib/flags');
    vi.resetModules();
  });
});

describe('SafeboxSection — ошибка синхронизации предлагает повтор', () => {
  it('состояние error рендерится КНОПКОЙ, как в ленте', () => {
    // Один и тот же syncBadge на двух списках должен давать одинаковые
    // возможности, а не только одинаковые слова: в ленте ошибка — кнопка
    // «повторить», а в сейфе была строкой, оставлявшей без действия.
    h.store = baseStore();
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = true;
    s.arweave.registered = true;
    s.syncStatuses = { e1: { status: 'error' } };
    render(<SafeboxSection />);

    const btn = screen.getByRole('button', { name: /Ошибка загрузки/ });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toMatch(/повторить/);
    fireEvent.click(btn);
    expect(s.retrySync).toHaveBeenCalled();
  });

  it('при выключенной синхронизации кнопки нет — повторять нечего', () => {
    h.store = baseStore();
    const s = h.store as ReturnType<typeof baseStore>;
    s.arweave.enabled = false;
    s.syncStatuses = { e1: { status: 'error' } };
    render(<SafeboxSection />);
    expect(screen.queryByRole('button', { name: /Ошибка загрузки/ })).toBeNull();
    expect(document.querySelector('.sync-state')!.textContent).toMatch(/на устройстве/);
  });
});
