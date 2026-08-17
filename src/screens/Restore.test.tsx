// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The restore screen owns exactly two decisions: WHEN the PIN step is shown and
// WHAT reaches the store. It never writes a PIN itself — restoreFromMnemonic
// does that, after the vault-identity check — so there is no rollback to test.

const MNEMONIC = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
const BAD_MNEMONIC = 'zzz bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({
  useNotes: () => h.store,
  VaultMismatchError: class VaultMismatchError extends Error {},
}));
// Real BIP39 validation would need real words; the screen only needs a verdict.
vi.mock('../lib/crypto', () => ({
  isValidMnemonic: (mn: string) => !mn.includes('zzz'),
}));

import { Restore } from './Restore';
import { VaultMismatchError } from '../lib/store';

beforeEach(() => {
  h.store = {
    restoreFromMnemonic: vi.fn(async () => {}),
    goToOnboarding: vi.fn(),
    resetApp: vi.fn(async () => {}),
    vaultError: null,
    hasPin: false,
  };
});
afterEach(cleanup);

const restoreFn = () => h.store.restoreFromMnemonic as ReturnType<typeof vi.fn>;

/** Pasting the whole phrase into word #1 fills the grid (SeedEntryGrid). */
function typePhrase(phrase = MNEMONIC) {
  fireEvent.change(screen.getByLabelText('Слово 1 из 12'), { target: { value: phrase } });
}

function setPin(pin: string) {
  fireEvent.change(screen.getByPlaceholderText('PIN (мин. 6 цифр)'), { target: { value: pin } });
  fireEvent.change(screen.getByPlaceholderText('Повторите PIN'), { target: { value: pin } });
}

describe('Restore — the PIN offer', () => {
  it('the phrase leads to the PIN step when no PIN is configured', async () => {
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));

    expect(await screen.findByText('Быстрый вход по PIN')).toBeTruthy();
    expect(restoreFn()).not.toHaveBeenCalled(); // nothing started yet
  });

  it('passes the PIN to the store in ONE call', async () => {
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и восстановить'));

    await waitFor(() => expect(restoreFn()).toHaveBeenCalledTimes(1));
    expect(restoreFn()).toHaveBeenCalledWith(MNEMONIC, { pin: '123456' });
  });

  it('«Пропустить» restores without a PIN', async () => {
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    fireEvent.click(screen.getByText('Пропустить — войти без PIN'));

    await waitFor(() => expect(restoreFn()).toHaveBeenCalledTimes(1));
    expect(restoreFn()).toHaveBeenCalledWith(MNEMONIC, undefined);
  });

  it('the PIN fields carry the anti-autofill set and neutral name/id', async () => {
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');

    for (const field of [
      screen.getByPlaceholderText('PIN (мин. 6 цифр)'),
      screen.getByPlaceholderText('Повторите PIN'),
    ]) {
      expect(field.getAttribute('autocomplete')).toBe('new-password');
      expect(field.getAttribute('data-1p-ignore')).not.toBeNull();
      expect(field.getAttribute('data-lpignore')).toBe('true');
      expect(field.getAttribute('data-bwignore')).not.toBeNull();
      expect(field.getAttribute('data-form-type')).toBe('other');
      expect(field.getAttribute('name')).not.toMatch(/pass|user|login|pin/i);
      expect(field.getAttribute('id')).not.toMatch(/pass|user|login|pin/i);
    }
  });

  it('mismatched PIN confirmation cannot be submitted', async () => {
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    fireEvent.change(screen.getByPlaceholderText('PIN (мин. 6 цифр)'), { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('Повторите PIN'), { target: { value: '654321' } });

    expect(screen.getByText('Установить PIN и восстановить')).toHaveProperty('disabled', true);
  });

  it('with a PIN already set there is no PIN step at all', async () => {
    h.store.hasPin = true;
    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Восстановить заметки'));

    await waitFor(() => expect(restoreFn()).toHaveBeenCalledWith(MNEMONIC, undefined));
    expect(screen.queryByText('Быстрый вход по PIN')).toBeNull();
  });

  it('an invalid phrase never reaches the PIN step', async () => {
    render(<Restore />);
    typePhrase(BAD_MNEMONIC);
    fireEvent.click(screen.getByText('Далее'));

    expect(await screen.findByText('Неверная seed-фраза. Проверьте слова.')).toBeTruthy();
    expect(screen.queryByText('Быстрый вход по PIN')).toBeNull();
  });

  it('an incomplete phrase is caught before the PIN step', async () => {
    render(<Restore />);
    fireEvent.change(screen.getByLabelText('Слово 1 из 12'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByText('Далее'));

    expect(await screen.findByText('Заполните все 12 слов')).toBeTruthy();
    expect(screen.queryByText('Быстрый вход по PIN')).toBeNull();
  });
});

describe('Restore — nothing races the restore', () => {
  it('a second click cannot start a second restore', async () => {
    let release!: () => void;
    h.store.restoreFromMnemonic = vi.fn(() => new Promise<void>(res => { release = res; }));

    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    setPin('123456');

    const btn = screen.getByText('Установить PIN и восстановить');
    fireEvent.click(btn);
    fireEvent.click(btn); // same React batch — the disabled prop alone is too late

    expect(restoreFn()).toHaveBeenCalledTimes(1);
    release();
  });

  it('everything is locked while the restore runs — including «Назад» and the reset', async () => {
    let release!: () => void;
    h.store.restoreFromMnemonic = vi.fn(() => new Promise<void>(res => { release = res; }));

    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и восстановить'));

    await waitFor(() => {
      expect(screen.getByText('Пропустить — войти без PIN')).toHaveProperty('disabled', true);
      expect(screen.getByText('Назад к seed-фразе')).toHaveProperty('disabled', true);
      expect(screen.getByPlaceholderText('PIN (мин. 6 цифр)')).toHaveProperty('disabled', true);
    });
    release();
  });

  it('the seed grid and navigation are locked on the seed step too', async () => {
    h.store.hasPin = true;
    let release!: () => void;
    h.store.restoreFromMnemonic = vi.fn(() => new Promise<void>(res => { release = res; }));

    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Восстановить заметки'));

    await waitFor(() => {
      expect(screen.getByLabelText('Слово 1 из 12')).toHaveProperty('disabled', true);
      expect(screen.getByText('Создать новое хранилище')).toHaveProperty('disabled', true);
    });
    release();
  });
});

describe('Restore — failures come back to the phrase', () => {
  it('a foreign vault shows its message and offers the reset', async () => {
    h.store.restoreFromMnemonic = vi.fn(async () => {
      throw new VaultMismatchError('На устройстве уже есть данные другого хранилища.');
    });

    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и восстановить'));

    expect(await screen.findByText(/данные другого хранилища/)).toBeTruthy();
    expect(screen.getByText('Сбросить приложение')).toBeTruthy();
    expect(screen.getByText('Далее')).toBeTruthy(); // back on the seed step
  });

  it('any other failure returns to the phrase with the generic message', async () => {
    h.store.restoreFromMnemonic = vi.fn(async () => { throw new Error('nope'); });

    render(<Restore />);
    typePhrase();
    fireEvent.click(screen.getByText('Далее'));
    await screen.findByText('Быстрый вход по PIN');
    setPin('123456');
    fireEvent.click(screen.getByText('Установить PIN и восстановить'));

    expect(await screen.findByText('Неверная seed-фраза. Проверьте слова.')).toBeTruthy();
    expect(screen.getByText('Далее')).toBeTruthy();
  });
});
