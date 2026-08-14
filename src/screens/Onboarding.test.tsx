// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Seed-copy honesty (round-11 MEDIUM): «✓ Скопировано» must appear ONLY after
// the clipboard write actually resolved — a rejected write shows an error and
// never fakes a backup.

const MNEMONIC = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  VaultMismatchError: class VaultMismatchError extends Error {},
}));

import { Onboarding } from './Onboarding';
import { VaultMismatchError } from '../lib/store';

beforeEach(() => {
  h.store = {
    createNewWallet: vi.fn(async () => MNEMONIC),
    confirmMnemonic: vi.fn(async () => {}),
    // Present so a regression back to the old «write PIN → check vault → undo»
    // shape is visible: these must stay UNUSED by this screen.
    setupPin: vi.fn(async () => {}),
    removePin: vi.fn(async () => {}),
    goToRestore: vi.fn(),
    goToLanding: vi.fn(),
    resetApp: vi.fn(),
  };
});
afterEach(cleanup);

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

async function revealSeed() {
  render(<Onboarding />);
  fireEvent.click(screen.getByText('Создать хранилище'));
  // seed step → tap-to-reveal cover
  fireEvent.click(await screen.findByText('Нажмите, чтобы показать фразу'));
  await screen.findByText('alpha'); // grid rendered
}

describe('Onboarding — seed copy honesty', () => {
  it('warns about clipboard history/cloud sync BEFORE any copy happens', async () => {
    stubClipboard(vi.fn(async () => {}));
    await revealSeed();
    // The risk disclosure must not be post-factum (round-12 LOW).
    expect(screen.getByText(/истории буфера/)).toBeTruthy();
    expect(screen.getByText(/мастер-ключ/)).toBeTruthy();
  });

  it('rejected clipboard write → error message, NO «Скопировано»', async () => {
    stubClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    await revealSeed();

    fireEvent.click(screen.getByText('Копировать'));

    expect(await screen.findByText(/Не удалось скопировать/)).toBeTruthy();
    expect(screen.queryByText('✓ Скопировано')).toBeNull();
  });

  it('resolved clipboard write → «Скопировано» (warning already shown pre-copy)', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    await revealSeed();

    fireEvent.click(screen.getByText('Копировать'));

    expect(await screen.findByText('✓ Скопировано')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(MNEMONIC);
    expect(screen.getByText(/мастер-ключ/)).toBeTruthy();
  });
});

// The PIN must travel WITH the vault creation, never as a separate write around
// it: a tab that loses the identity race would otherwise leave a PIN for a
// vault this device does not have — or delete the PIN of the vault that won.

const confirmFn = () => h.store.confirmMnemonic as ReturnType<typeof vi.fn>;

/** Walk seed → verify → PIN step (the verify step asks back 3 random words). */
async function reachPinStep() {
  stubClipboard(vi.fn(async () => {}));
  await revealSeed();
  fireEvent.click(screen.getByLabelText('Я записал(а) seed-фразу в надёжное место'));
  fireEvent.click(screen.getByText('Продолжить →'));

  const words = MNEMONIC.split(' ');
  await screen.findByText('Проверка записи');
  for (const label of screen.getAllByText(/^Слово №\d+$/)) {
    const index = Number(label.textContent!.replace(/\D/g, '')) - 1;
    const input = label.parentElement!.querySelector('input')!;
    fireEvent.change(input, { target: { value: words[index] } });
  }
  fireEvent.click(screen.getByText('Проверить →'));
  await screen.findByText('Быстрый вход по PIN');
}

function setPin(pin: string) {
  fireEvent.change(screen.getByPlaceholderText('PIN (мин. 6 цифр)'), { target: { value: pin } });
  fireEvent.change(screen.getByPlaceholderText('Повторите PIN'), { target: { value: pin } });
}

describe('Onboarding — the PIN travels with the vault creation', () => {
  it('passes the PIN to confirmMnemonic and never writes it separately', async () => {
    await reachPinStep();
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и начать →'));

    await waitFor(() => expect(confirmFn()).toHaveBeenCalledWith(MNEMONIC, { pin: '123456' }));
    expect(h.store.setupPin).not.toHaveBeenCalled();
    expect(h.store.removePin).not.toHaveBeenCalled();
  });

  it('«Пропустить» creates the vault without a PIN', async () => {
    await reachPinStep();
    fireEvent.click(screen.getByText('Пропустить — войти без PIN'));

    await waitFor(() => expect(confirmFn()).toHaveBeenCalledWith(MNEMONIC, undefined));
    expect(h.store.setupPin).not.toHaveBeenCalled();
  });

  it('a rejected creation does NOT delete any PIN — there is nothing of ours to undo', async () => {
    h.store.confirmMnemonic = vi.fn(async () => {
      throw new VaultMismatchError('На устройстве уже есть данные другого хранилища.');
    });
    await reachPinStep();
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и начать →'));

    expect(await screen.findByText(/данные другого хранилища/)).toBeTruthy();
    expect(h.store.removePin).not.toHaveBeenCalled();
    expect(screen.getByText('Сбросить приложение')).toBeTruthy();
  });

  it('the PIN fields carry the anti-autofill set and neutral name/id', async () => {
    await reachPinStep();
    for (const field of [
      screen.getByPlaceholderText('PIN (мин. 6 цифр)'),
      screen.getByPlaceholderText('Повторите PIN'),
    ]) {
      // A manager that saves the master PIN would export it to a third party.
      expect(field.getAttribute('autocomplete')).toBe('new-password');
      expect(field.getAttribute('data-1p-ignore')).not.toBeNull();
      expect(field.getAttribute('data-lpignore')).toBe('true');
      expect(field.getAttribute('data-bwignore')).not.toBeNull();
      expect(field.getAttribute('data-form-type')).toBe('other');
      // …and nothing that matches a manager's login/password heuristics.
      expect(field.getAttribute('name')).not.toMatch(/pass|user|login|pin/i);
      expect(field.getAttribute('id')).not.toMatch(/pass|user|login|pin/i);
    }
  });

  it('the PIN fields lock while the vault is being created', async () => {
    let release!: () => void;
    h.store.confirmMnemonic = vi.fn(() => new Promise<void>(res => { release = res; }));
    await reachPinStep();
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и начать →'));

    // The KDF already has the value on screen — an editable field would suggest
    // a PIN the vault was never given.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('PIN (мин. 6 цифр)')).toHaveProperty('disabled', true);
      expect(screen.getByPlaceholderText('Повторите PIN')).toHaveProperty('disabled', true);
    });
    release();
  });

  it('a double click cannot start two vault opens', async () => {
    let release!: () => void;
    h.store.confirmMnemonic = vi.fn(() => new Promise<void>(res => { release = res; }));
    await reachPinStep();
    setPin('123456');

    const btn = screen.getByText('Установить PIN и начать →');
    fireEvent.click(btn);
    fireEvent.click(btn); // same React batch — `finishing` has not flushed yet

    expect(confirmFn()).toHaveBeenCalledTimes(1);
    release();
  });
});
