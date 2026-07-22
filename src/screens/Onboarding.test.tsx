// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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

beforeEach(() => {
  h.store = {
    createNewWallet: vi.fn(async () => MNEMONIC),
    confirmMnemonic: vi.fn(async () => {}),
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
  it('rejected clipboard write → error message, NO «Скопировано», no master-key note', async () => {
    stubClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    await revealSeed();

    fireEvent.click(screen.getByText('Копировать'));

    expect(await screen.findByText(/Не удалось скопировать/)).toBeTruthy();
    expect(screen.queryByText('✓ Скопировано')).toBeNull();
    expect(screen.queryByText(/мастер-ключ/)).toBeNull();
  });

  it('resolved clipboard write → «Скопировано» + clipboard-holds-master-key warning', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    await revealSeed();

    fireEvent.click(screen.getByText('Копировать'));

    expect(await screen.findByText('✓ Скопировано')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(MNEMONIC);
    expect(screen.getByText(/мастер-ключ/)).toBeTruthy();
  });
});
