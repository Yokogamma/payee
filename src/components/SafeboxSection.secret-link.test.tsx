// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// Secret link (P1) in the safebox card: «Скопировать ссылку» in the menu and
// the link fingerprint in the card head — both only with SECRET_LINK_ENABLED.

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown>, secretLink: false }));
vi.mock('../lib/flags', () => ({
  V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: true, QUICK_UNLOCK_ENABLED: false,
  get SECRET_LINK_ENABLED() { return h.secretLink; },
}));
vi.mock('../lib/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/store')>();
  return { ...actual, useNotes: () => h.store };
});

import { SafeboxSection } from './SafeboxSection';
import { groupSafeboxChains } from '../lib/chains';
import { deriveSecretLinkKey, secretLinkHandle } from '../lib/secret-link';
import type { SafeboxEntryData } from '../lib/crypto';

/** Plan §1.1 vector. */
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_ROOT = '00000000-0000-8000-8000-000000000001';

function entry(over: Partial<SafeboxEntryData> & { id: string }): SafeboxEntryData {
  return {
    createdAt: 1000, title: 'GitHub', login: 'yoko', url: 'https://github.com',
    note: '', files: [], rev: 1, root: over.id, ...over,
  };
}

function baseStore(entries: SafeboxEntryData[], unlocked = true) {
  const chains = unlocked ? groupSafeboxChains(entries) : [];
  return {
    safeboxUnlocked: unlocked,
    safeboxPinConfigured: true,
    safeboxDataPresent: true,
    safeboxEntryCount: entries.length,
    safeboxEntries: unlocked ? entries : [],
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
    copySecretLink: vi.fn(async () => true),
    // The REAL derivation: the fingerprint below is checked against the vector.
    getSecretLinkHandles: vi.fn(async (roots: readonly string[]) => {
      const kLink = await deriveSecretLinkKey(MN);
      const out: Record<string, string> = {};
      for (const r of roots) out[r] = await secretLinkHandle(kLink, r);
      return out;
    }),
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

const VECTOR_ENTRY = entry({ id: 'e1', rev: 2, root: VECTOR_ROOT, prev: VECTOR_ROOT });

beforeEach(() => { h.secretLink = false; h.store = baseStore([VECTOR_ENTRY]); });
afterEach(() => { cleanup(); h.secretLink = false; });

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Меню записи/ }));
}

describe('SafeboxSection — secret link ON', () => {
  beforeEach(() => { h.secretLink = true; });

  it('the card head shows the §1.1 fingerprint: hue 110 / 166 and tail «TnYg»', async () => {
    const { container } = render(<SafeboxSection />);
    await waitFor(() => expect(container.querySelector('.secret-link-fingerprint')).not.toBeNull());
    const fills = [...container.querySelectorAll('.secret-link-fingerprint circle')].map(c => c.getAttribute('fill'));
    expect(fills).toEqual(['hsl(110, 65%, 50%)', 'hsl(166, 65%, 50%)']);
    expect(container.querySelector('.secret-link-fingerprint-tail')!.textContent).toBe('TnYg');
    // The colours are presentation attributes, never inline styles (CSP style-src 'self').
    expect(container.querySelector('.secret-link-fingerprint [style]')).toBeNull();
    expect(h.store.getSecretLinkHandles).toHaveBeenCalledWith([VECTOR_ROOT]);
  });

  it('the full handle never reaches the DOM — only its four-character tail', async () => {
    const { container } = render(<SafeboxSection />);
    await waitFor(() => expect(container.querySelector('.secret-link-fingerprint')).not.toBeNull());
    expect(container.innerHTML).not.toContain('TnYgaHGXuUjYvmglbl6DhA');
  });

  it('«Скопировать ссылку» copies the chain ROOT\'s link and reports it', async () => {
    render(<SafeboxSection />);
    openMenu();
    await act(async () => { fireEvent.click(screen.getByText('Скопировать ссылку')); });
    expect(h.store.copySecretLink).toHaveBeenCalledWith(VECTOR_ROOT);
    expect(screen.getByText('Ссылка скопирована')).toBeDefined();
  });

  it('a refused copy says so', async () => {
    h.store = { ...baseStore([VECTOR_ENTRY]), copySecretLink: vi.fn(async () => false) };
    render(<SafeboxSection />);
    openMenu();
    await act(async () => { fireEvent.click(screen.getByText('Скопировать ссылку')); });
    expect(screen.getByText('Не удалось скопировать ссылку.')).toBeDefined();
  });

  it('no fingerprint for a handle that is not canonical', async () => {
    h.store = {
      ...baseStore([VECTOR_ENTRY]),
      getSecretLinkHandles: vi.fn(async () => ({ [VECTOR_ROOT]: 'not-a-handle' })),
    };
    const { container } = render(<SafeboxSection />);
    await waitFor(() => expect(h.store.getSecretLinkHandles).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.secret-link-fingerprint')).toBeNull();
  });

  it('a locked section asks for no handles', () => {
    h.store = baseStore([VECTOR_ENTRY], false);
    render(<SafeboxSection />);
    expect(h.store.getSecretLinkHandles).not.toHaveBeenCalled();
  });
});

describe('SafeboxSection — secret link OFF (shipped default)', () => {
  it('no menu item, no fingerprint, no handle computation', async () => {
    const { container } = render(<SafeboxSection />);
    openMenu();
    expect(screen.queryByText('Скопировать ссылку')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.secret-link-fingerprint')).toBeNull();
    expect(h.store.getSecretLinkHandles).not.toHaveBeenCalled();
    expect(h.store.copySecretLink).not.toHaveBeenCalled();
  });
});
