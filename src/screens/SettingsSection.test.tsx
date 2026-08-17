// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { SettingsSection } from './SettingsSection';
import { SAFEBOX_SCRUB_SELECTOR } from '../components/secretFieldProps';

beforeEach(() => {
  h.store = {
    notes: [],
    chains: [],
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      acceptedCount: 0, confirmedCount: 0, unsyncedCount: 0, errorCount: 0,
      quarantinedCount: 0, countsReady: true,
      // The reset warning moved into this section with the confirm dialog.
      resetRisk: { notes: 0, safebox: 0 },
      lastSync: null, lastError: null,
    },
    syncStatuses: {},
    updateCheck: { status: 'idle' },
    checkForUpdates: vi.fn(),
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
    resetApp: vi.fn(),
  };
});
afterEach(cleanup);

/** No `open` and no `onClose`: navigating away unmounts the section. */
function renderSection() {
  return render(<SettingsSection theme="system" onThemeChange={vi.fn()} />);
}

describe('SettingsSection a11y (Phase 7)', () => {
  it('это РАЗДЕЛ, а не диалог — никакого aria-modal поверх приложения', () => {
    renderSection();
    expect(screen.getByRole('region', { name: 'Настройки' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape НЕ уводит из раздела', () => {
    // A section-level Escape handler would fight the nested dialogs' own
    // stopPropagation and would yank the user out mid-form. Leaving is the nav
    // or the Back gesture, which now works.
    renderSection();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'Настройки' })).toBeTruthy();
  });

  it('заголовок раздела фокусируем — это то, что заменяет фокус-ловушку', () => {
    // Without focus management a keyboard/AT user lands at the top of the
    // document with no announcement when the section changes. The shell moves
    // focus here; the heading has to be able to receive it.
    renderSection();
    const heading = screen.getByRole('heading', { name: 'Настройки' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    heading.focus();
    expect(document.activeElement).toBe(heading);
  });

  it('theme picker exposes the active option via aria-pressed', () => {
    renderSection();
    // Theme now lives inside a collapsed block — expand it first. "Системная"
    // also appears as the block's status chip, so target the buttons by role.
    fireEvent.click(screen.getByText('Тема'));
    const system = screen.getByRole('button', { name: 'Системная' });
    // «Тёмная» → «Чернильная»: id темы прежний, изменилось только слово.
    const dark = screen.getByRole('button', { name: 'Чернильная' });
    expect(system.getAttribute('aria-pressed')).toBe('true');
    expect(dark.getAttribute('aria-pressed')).toBe('false');
  });

  it('PIN block: "Установить" with no PIN; "Сменить" + "Удалить" once set', () => {
    renderSection();
    fireEvent.click(screen.getByText('PIN-код'));
    expect(screen.getByText('Установить PIN-код')).toBeTruthy();
    expect(screen.queryByText('Сменить PIN-код')).toBeNull();
    cleanup();

    h.store.hasPin = true;
    renderSection();
    fireEvent.click(screen.getByText('PIN-код'));
    expect(screen.getByText('Сменить PIN-код')).toBeTruthy();
    expect(screen.getByText('Удалить PIN-код')).toBeTruthy();
  });
});

describe('SettingsSection — safebox seed gate (§2)', () => {
  it('без сейфа: seed-фраза показывается как раньше', () => {
    renderSection();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    expect(screen.getByText('a')).toBeTruthy(); // the words render
  });

  it('с настроенным сейфом seed прячется ЗА PIN сейфа', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxDataPresent = true;
    renderSection();
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
    renderSection();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    // A 10-strike wipe must NOT become a shortcut to the seed phrase.
    expect(screen.getByText(/Просмотр seed-фразы закрыт/)).toBeTruthy();
    expect(h.store.showMnemonic).not.toHaveBeenCalled();
  });

  it('блок «Защищённый сейф» присутствует ВСЕГДА, состояние — в чипе', () => {
    // The same appear/disappear formula the nav item lost. «Nothing configured
    // yet» is a state to show, not a reason to hide the only route to it.
    renderSection();
    expect(screen.getByText('Защищённый сейф')).toBeTruthy();
    expect(screen.getByText('не настроен')).toBeTruthy();

    cleanup();
    h.store.safeboxPinConfigured = true;
    renderSection();
    expect(screen.getByText('PIN установлен')).toBeTruthy();
  });

  it('смена PIN сейфа требует ТЕКУЩИЙ PIN', async () => {
    h.store.safeboxPinConfigured = true;
    renderSection();
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
    renderSection();
    fireEvent.click(screen.getByText('Защищённый сейф'));
    fireEvent.click(screen.getByText('Деактивировать сейф (записи сохранятся)'));
    expect(screen.getByText(/Записи сейфа НЕ удаляются/)).toBeTruthy();

    const current = document.querySelector('#sbx-cur-code') as HTMLInputElement;
    fireEvent.change(current, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Деактивировать')); });
    expect(h.store.deactivateSafebox).toHaveBeenCalledWith('135790');
  });
});

describe('SettingsSection — the seed gate is LIVE, not a one-time flag', () => {
  it('a safebox lock after the gate was passed hides the phrase again', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxUnlocked = false;
    const { rerender } = renderSection();
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
      <SettingsSection open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );
    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect(screen.getByText('Показать после ввода PIN')).toBeTruthy(); // asks again
  });

  it('a REJECTED unlock (lock during the KDF) never opens the gate', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.unlockSafebox = vi.fn(async () => { throw new Error('Сейф заблокирован.'); });
    renderSection();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    const input = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '135790' } });
    await act(async () => { fireEvent.click(screen.getByText('Показать после ввода PIN')); });

    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect(screen.getByText('Сейф заблокирован.')).toBeTruthy();
  });
});

describe('SettingsSection — a section lock clears ITS safebox secrets too', () => {
  it('the PIN-change form is remounted on a lock-generation bump', () => {
    h.store.safeboxPinConfigured = true;
    const { rerender } = renderSection();
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
      <SettingsSection open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );

    // Back to the idle state: the typed current PIN is gone with the remount.
    expect(document.querySelector('#sbx-cur-code')).toBeNull();
    fireEvent.click(screen.getByText('Сменить PIN сейфа'));
    expect((document.querySelector('#sbx-cur-code') as HTMLInputElement).value).toBe('');
  });

  it('the seed-gate PIN and its passed state are cleared on a lock', async () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxUnlocked = true;
    const { rerender } = renderSection();
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
      <SettingsSection open onClose={vi.fn()} theme="system" onThemeChange={vi.fn()} onRequestReset={vi.fn()} />,
    );

    expect(h.store.showMnemonic).not.toHaveBeenCalled();
    expect((document.querySelector('#sbx-gate-seed') as HTMLInputElement).value).toBe('');
  });
});

// The «Проверить обновления» button and its result line MOVED to the status
// line, where they are visible from every section instead of only inside an
// open panel. Covered by StatusLine.test.tsx.

// The counters MOVED to the status line's expandable panel, and their logic
// moved to `computeSyncCounters` — these five cases now live as node unit
// tests in src/lib/syncCounters.test.ts, where they do not need a rendered
// panel and a collapsible block to click open.

// ─── Reset: the confirm dialog moved in with the section ────────────

describe('SettingsSection — сброс приложения', () => {
  it('подтверждение — ЕДИНСТВЕННЫЙ модальный слой: настройки больше не диалог', () => {
    renderSection();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByText('Сброс приложения'));
    fireEvent.click(screen.getByText('Сбросить приложение'));

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute('aria-label')).toBe('Сбросить приложение?');
  });

  // ROUND-13, ported. The old modal cleared the revealed phrase whenever it
  // closed, and the reset flow relied on that. In a section the user never
  // leaves, nothing unmounts, and the phrase would sit behind the confirm —
  // so `requestReset()` has to clear it explicitly. This test is the boundary.
  it('раскрытая seed-фраза НЕ переживает «Сброс → Отмена»', () => {
    h.store.showMnemonic = vi.fn(() => 'секретное слово фраза');
    renderSection();

    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));
    expect(screen.getByText('секретное')).toBeTruthy();

    fireEvent.click(screen.getByText('Сброс приложения'));
    fireEvent.click(screen.getByText('Сбросить приложение'));
    fireEvent.click(screen.getByText('Отмена'));

    // Still on the same screen — nothing unmounted — and the phrase is gone.
    expect(screen.queryByText('секретное')).toBeNull();
    expect(screen.getByText('Показать seed-фразу')).toBeTruthy();
  });
});

// ─── I4: the BFCache scrub contract ─────────────────────────────────

describe('SettingsSection — поля сейфа попадают под очистку при блокировке', () => {
  // These fields live OUTSIDE the section the shell remounts on a lock, so the
  // ONLY thing that wipes them before a `pagehide` snapshot is the store's
  // synchronous querySelectorAll over SAFEBOX_SCRUB_SELECTOR. A renamed class
  // or a newly added field would unhook silently — nothing else would fail.
  const inputsUnderScrub = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(SAFEBOX_SCRUB_SELECTOR));

  it('поле seed-гейта ловится селектором', () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxDataPresent = true;
    renderSection();
    fireEvent.click(screen.getByText('Seed-фраза'));
    fireEvent.click(screen.getByText('Показать seed-фразу'));

    const gate = document.querySelector('#sbx-gate-seed') as HTMLInputElement;
    expect(gate).toBeTruthy();
    expect(inputsUnderScrub()).toContain(gate);
  });

  it('ВСЕ поля формы смены PIN сейфа ловятся селектором', () => {
    h.store.safeboxPinConfigured = true;
    h.store.safeboxDataPresent = true;
    renderSection();
    fireEvent.click(screen.getByText('Защищённый сейф'));
    fireEvent.click(screen.getByText('Сменить PIN сейфа'));

    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"], .pin-input'));
    expect(all.length).toBeGreaterThan(1); // current + new + confirm
    const scrubbed = inputsUnderScrub();
    for (const field of all) {
      expect(scrubbed, `поле ${field.id || field.className} вне очистки`).toContain(field);
    }
  });
});

describe('SettingsSection — футер вне скролла', () => {
  it('футер НЕ лежит внутри .settings-scroll', () => {
    // Каскадный тест проверяет правила CSS; это проверяет разметку. Одно без
    // другого проходит при верной сетке и футере, оставленном в колонке.
    const { container } = renderSection();
    const scroll = container.querySelector('.settings-scroll');
    const foot = container.querySelector('.settings-footnote');
    expect(scroll, 'скроллер не найден').not.toBeNull();
    expect(foot, 'футер не найден').not.toBeNull();
    expect(scroll.contains(foot), 'футер уехал обратно в прокручиваемую колонку').toBe(false);
    expect(foot.parentElement).toBe(container.querySelector('.settings-section'));
  });

  it('футер идёт ПОСЛЕ скроллера — вторая строка сетки, а не первая', () => {
    const { container } = renderSection();
    const section = container.querySelector('.settings-section');
    const kids = [...section.children];
    expect(kids.indexOf(container.querySelector('.settings-footnote')))
      .toBeGreaterThan(kids.indexOf(container.querySelector('.settings-scroll')));
  });
});
