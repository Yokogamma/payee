// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// «Быстрый вход» — UI with the flag ON (§9). The honest copy is asserted
// against the DOM, the same way Safebox.test.tsx pins «гейт доступа, а не
// крипто-граница»: these sentences are a product commitment, not decoration,
// and a refactor that quietly drops them has to fail here.

vi.mock('../lib/flags', () => ({
  V3_WRITER_ENABLED: false,
  SAFEBOX_WRITER_ENABLED: false,
  QUICK_UNLOCK_ENABLED: true,
}));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/store')>();
  return { ...actual, useNotes: () => h.store };
});

import { SettingsSection } from './SettingsSection';
import { PinUnlock } from './PinUnlock';
import { QuickUnlockUnavailableError, QuickUnlockKeyMismatchError } from '../lib/quick-unlock-core';

function baseStore(): Record<string, unknown> {
  return {
    notes: [],
    chains: [],
    arweave: {
      enabled: true, online: true, syncing: false, registered: true,
      acceptedCount: 0, confirmedCount: 0, unsyncedCount: 0, errorCount: 0,
      quarantinedCount: 0, countsReady: true,
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
    hasPin: true,
    setupPin: vi.fn(),
    removePin: vi.fn(),
    showMnemonic: vi.fn(() => 'a b c'),
    autoLockTimeout: 300,
    setAutoLockTimeout: vi.fn(),
    // Quick-unlock slice.
    quickUnlockMeta: null,
    hasQuickUnlock: false,
    quickUnlockCapability: 'ready',
    setupQuickUnlock: vi.fn(async () => {}),
    removeQuickUnlock: vi.fn(async () => {}),
    unlockWithQuickUnlock: vi.fn(async () => {}),
    refreshQuickUnlockCapability: vi.fn(),
    // PinUnlock slice.
    unlockWithPin: vi.fn(async () => {}),
    getPinLockState: vi.fn(async () => ({ lockedSeconds: 0, attempts: 0 })),
    goToRestore: vi.fn(),
    // Safebox slice.
    safeboxPinConfigured: false,
    safeboxDataPresent: false,
    safeboxUnlocked: false,
    safeboxLockGeneration: 0,
    unlockSafebox: vi.fn(async () => {}),
    changeSafeboxPin: vi.fn(async () => {}),
    deactivateSafebox: vi.fn(async () => {}),
    resetApp: vi.fn(),
  };
}

beforeEach(() => { h.store = baseStore(); });
afterEach(cleanup);

function renderSection() {
  return render(<SettingsSection theme="system" onThemeChange={vi.fn()} />);
}

/** The block is collapsed by default — open it before asserting its body. */
function openQuickUnlockBlock() {
  fireEvent.click(screen.getByRole('button', { name: /Быстрый вход/ }));
}

// ─── Settings block: the row order IS the priority ───────────────────

describe('блок «Быстрый вход» в настройках', () => {
  it('стоит между «PIN-код» и «Защищённый сейф»', () => {
    renderSection();
    const titles = Array.from(document.querySelectorAll('.settings-block-title'))
      .map(el => el.textContent);
    expect(titles.indexOf('Быстрый вход')).toBe(titles.indexOf('PIN-код') + 1);
    expect(titles.indexOf('Защищённый сейф')).toBe(titles.indexOf('Быстрый вход') + 1);
  });

  it('честные формулировки §2 реально в DOM, и слова «биометрия» там нет', () => {
    renderSection();
    openQuickUnlockBlock();
    const body = document.querySelector('.settings-block-body')?.parentElement;
    const text = body?.textContent ?? '';
    expect(text).toContain('не замена PIN-коду приложения, а второй ключ к тому же seed');
    expect(text).toContain('Общая стойкость хранилища не растёт');
    expect(text).toContain('про скорость');
    expect(text).toContain('работает только на этом устройстве');
    expect(text).toContain('вход останется');
    // The label may not name a modality — the web cannot tell Windows Hello
    // from Face ID from a device passcode, so «биометрия» would be a lie.
    expect(text).not.toContain('иометри');
  });

  it('чип отражает состояние', () => {
    renderSection();
    expect(document.body.textContent).toContain('не настроен');

    cleanup();
    h.store = { ...baseStore(), hasQuickUnlock: true, quickUnlockMeta: { createdAt: Date.now() } };
    renderSection();
    expect(document.body.textContent).toContain('настроен');

    cleanup();
    h.store = { ...baseStore(), quickUnlockCapability: 'no-prf' };
    renderSection();
    expect(document.body.textContent).toContain('не поддерживается');
  });

  it('настроенная запись ВСЕГДА даёт удаление — даже при пропавшем capability', () => {
    // The first row wins on purpose: a capability that disappeared (provider
    // removed, OS rolled back) must not hide the only control for a record
    // that still exists.
    h.store = {
      ...baseStore(),
      hasQuickUnlock: true,
      quickUnlockMeta: { createdAt: 1_700_000_000_000 },
      quickUnlockCapability: 'no-prf',
      autoLockTimeout: 0,
    };
    renderSection();
    openQuickUnlockBlock();
    expect(screen.getByRole('button', { name: 'Удалить быстрый вход' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Настроить быстрый вход' })).toBeNull();
    expect(document.body.textContent).toContain('Настроен');
  });

  it('кнопки «Настроить заново» нет — перенастройка только через явное удаление', () => {
    h.store = { ...baseStore(), hasQuickUnlock: true, quickUnlockMeta: { createdAt: 1 } };
    renderSection();
    openQuickUnlockBlock();
    expect(screen.queryByRole('button', { name: /заново/i })).toBeNull();
  });

  it('без PIN предлагает сначала установить PIN и не даёт кнопок', () => {
    h.store = { ...baseStore(), hasPin: false };
    renderSection();
    openQuickUnlockBlock();
    expect(document.body.textContent).toContain('Сначала установите PIN-код');
    expect(screen.queryByRole('button', { name: 'Настроить быстрый вход' })).toBeNull();
  });

  it('отрицательный capability объясняет причину и НИЧЕГО не предлагает взамен', () => {
    for (const [capability, phrase] of [
      ['no-api', 'браузер не поддерживает'],
      ['no-platform', 'нет встроенной проверки'],
      ['no-prf', 'не выдаёт нужный криптографический ответ'],
    ] as const) {
      cleanup();
      h.store = { ...baseStore(), quickUnlockCapability: capability };
      renderSection();
      openQuickUnlockBlock();
      expect(document.body.textContent).toContain(phrase);
      expect(screen.queryByRole('button', { name: 'Настроить быстрый вход' })).toBeNull();
    }
  });

  it('порог «Сразу» объясняется текстом, а не ломает настройку молча', () => {
    h.store = { ...baseStore(), autoLockTimeout: 0 };
    renderSection();
    openQuickUnlockBlock();
    expect(document.body.textContent).toContain('Поставьте порог «Через 5 мин»');
    expect(screen.queryByRole('button', { name: 'Настроить быстрый вход' })).toBeNull();
  });

  it("'unknown' НЕ запрещает попытку — истину говорит только церемония", () => {
    h.store = { ...baseStore(), quickUnlockCapability: 'unknown' };
    renderSection();
    openQuickUnlockBlock();
    expect(screen.getByRole('button', { name: 'Настроить быстрый вход' })).toBeTruthy();
  });

  it('ошибка настройки показывается как есть, роль alert', async () => {
    const setupQuickUnlock = vi.fn(async () => {
      throw new QuickUnlockUnavailableError('Быстрый вход уже настроен в другой вкладке.');
    });
    h.store = { ...baseStore(), setupQuickUnlock };
    renderSection();
    openQuickUnlockBlock();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Настроить быстрый вход' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('уже настроен в другой вкладке');
  });

  it('capability-детект запускается лениво, при монтировании блока', () => {
    const refreshQuickUnlockCapability = vi.fn();
    h.store = { ...baseStore(), refreshQuickUnlockCapability };
    renderSection();
    openQuickUnlockBlock();
    expect(refreshQuickUnlockCapability).toHaveBeenCalled();
  });
});

// ─── PinUnlock button ────────────────────────────────────────────────

describe('кнопка «Быстрый вход» на экране входа', () => {
  it('не показывается без записи', () => {
    render(<PinUnlock />);
    expect(screen.queryByRole('button', { name: 'Быстрый вход' })).toBeNull();
  });

  it('показывается при наличии записи, и порядок кнопок — PIN, быстрый вход, seed', () => {
    h.store = { ...baseStore(), hasQuickUnlock: true };
    render(<PinUnlock />);
    const labels = Array.from(document.querySelectorAll('button')).map(b => b.textContent);
    expect(labels.indexOf('Разблокировать')).toBeLessThan(labels.indexOf('Быстрый вход'));
    expect(labels.indexOf('Быстрый вход')).toBeLessThan(labels.indexOf('Ввести seed-фразу вручную'));
  });

  it('НЕ запускается автоматически — только по нажатию', () => {
    const unlockWithQuickUnlock = vi.fn(async () => {});
    h.store = { ...baseStore(), hasQuickUnlock: true, unlockWithQuickUnlock };
    render(<PinUnlock />);
    expect(unlockWithQuickUnlock).not.toHaveBeenCalled();
    // …and the focus stays on the PIN field, not on the button.
    expect(document.activeElement?.classList.contains('pin-input')).toBe(true);
  });

  it('активна во время лок-аута PIN — это другой контур со своим лимитом', async () => {
    h.store = {
      ...baseStore(),
      hasQuickUnlock: true,
      getPinLockState: vi.fn(async () => ({ lockedSeconds: 300, attempts: 8 })),
    };
    render(<PinUnlock />);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Разблокировать' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((screen.getByRole('button', { name: 'Быстрый вход' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('во время попытки быстрого входа кнопка PIN задизейблена, и наоборот', async () => {
    let release!: () => void;
    const unlockWithQuickUnlock = vi.fn(() => new Promise<void>(res => { release = res; }));
    h.store = { ...baseStore(), hasQuickUnlock: true, unlockWithQuickUnlock };
    render(<PinUnlock />);

    fireEvent.change(document.querySelector('.pin-input') as HTMLInputElement, { target: { value: '123456' } });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Быстрый вход' })); });

    expect((screen.getByRole('button', { name: 'Разблокировать' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    expect((screen.getByRole('button', { name: 'Разблокировать' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ошибка быстрого входа показывается как alert и возвращает фокус в поле PIN', async () => {
    const unlockWithQuickUnlock = vi.fn(async () => { throw new QuickUnlockKeyMismatchError(); });
    h.store = { ...baseStore(), hasQuickUnlock: true, unlockWithQuickUnlock };
    render(<PinUnlock />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Быстрый вход' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('не подходит к сохранённому ключу');
    expect(document.activeElement?.classList.contains('pin-input')).toBe(true);
  });

  it('тихий исход (наш abort) не показывает ошибку вовсе', async () => {
    // The store RESOLVES on its own AbortError — the user cancelled nothing
    // they asked to be told about.
    h.store = { ...baseStore(), hasQuickUnlock: true, unlockWithQuickUnlock: vi.fn(async () => {}) };
    render(<PinUnlock />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Быстрый вход' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('счётчик попыток PIN не трогается быстрым входом', async () => {
    const getPinLockState = vi.fn(async () => ({ lockedSeconds: 0, attempts: 4 }));
    const unlockWithQuickUnlock = vi.fn(async () => { throw new QuickUnlockKeyMismatchError(); });
    h.store = { ...baseStore(), hasQuickUnlock: true, getPinLockState, unlockWithQuickUnlock };
    render(<PinUnlock />);
    await waitFor(() => expect(getPinLockState).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Быстрый вход' }));
    });
    // The PIN path re-reads the counter after a failure; the quick path must
    // not — it has nothing to do with that meter.
    expect(getPinLockState).toHaveBeenCalledTimes(1);
  });
});
