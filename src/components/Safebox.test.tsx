// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// §8 UI matrix for the safebox surface: the PIN pad, the activation copy, the
// card actions (a copied password must NEVER reach the DOM), the reveal
// auto-hide, the anti-autofill attribute set and the writer-OFF surface.

vi.mock('../lib/flags', () => ({ V3_WRITER_ENABLED: true, SAFEBOX_WRITER_ENABLED: true }));

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

const formatDate = (ts: number) => String(ts);

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
    const { container } = render(<SafeboxSection formatDate={formatDate} />);
    expect(screen.getByText('GitHub')).toBeDefined();
    expect(screen.getByText('yoko')).toBeDefined();
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
  });

  it('copying a password NEVER puts the plaintext in the DOM', async () => {
    const { container } = render(<SafeboxSection formatDate={formatDate} />);
    await act(async () => {
      fireEvent.click(screen.getByText('📋 Пароль'));
    });
    expect(h.store.copySafeboxPassword).toHaveBeenCalledWith('e1');
    // The store writes to the clipboard straight from the decrypted string.
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
    expect(container.textContent).toContain('Буфер будет очищен');
  });

  it('the copy toast tells the honest clipboard story (best-effort, on return)', async () => {
    render(<SafeboxSection formatDate={formatDate} />);
    await act(async () => { fireEvent.click(screen.getByText('📋 Пароль')); });
    expect(screen.getByText(/Пароль скопирован/)).toBeDefined();
    expect(screen.getByText(/~60 с/)).toBeDefined();
  });

  it('«Показать» reveals the password and it auto-hides', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<SafeboxSection formatDate={formatDate} />);
      await act(async () => { fireEvent.click(screen.getByText('👁 Показать')); });
      expect(container.textContent).toContain('PLAINTEXT-PASSWORD');

      await act(async () => { vi.advanceTimersByTime(21_000); });
      expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lock clears an already-revealed password immediately', async () => {
    const { container, rerender } = render(<SafeboxSection formatDate={formatDate} />);
    await act(async () => { fireEvent.click(screen.getByText('👁 Показать')); });
    expect(container.textContent).toContain('PLAINTEXT-PASSWORD');

    h.store = { ...baseStore(), safeboxUnlocked: false };
    rerender(<SafeboxSection formatDate={formatDate} />);
    expect(container.textContent).not.toContain('PLAINTEXT-PASSWORD');
  });

  it('offers a download button per attachment', async () => {
    h.store = baseStore([entry({
      id: 'e1',
      files: [{ fid: 'f1', name: 'id_ed25519', mime: 'text/plain', size: 400 }],
    })]);
    render(<SafeboxSection formatDate={formatDate} />);
    await act(async () => { fireEvent.click(screen.getByText(/id_ed25519/)); });
    expect(h.store.downloadSafeboxAttachment).toHaveBeenCalledWith('e1', 'f1');
  });

  it('search is scoped to the safebox and reports the filtered count', () => {
    render(<SafeboxSection formatDate={formatDate} />);
    const input = screen.getByLabelText('Поиск по сейфу');
    fireEvent.change(input, { target: { value: 'git' } });
    expect(h.store.setSafeboxSearchQuery).toHaveBeenCalledWith('git');
  });

  it('shows the standing v4-pause banner with a working resume button', async () => {
    h.store = { ...baseStore(), v4Paused: true };
    render(<SafeboxSection formatDate={formatDate} />);
    expect(screen.getByText(/приостановлена/)).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByText('Возобновить')); });
    expect(h.store.resumeV4Uploads).toHaveBeenCalled();
  });

  it('warns when «Вечное хранилище» is inactive (entries are LOCAL only)', () => {
    h.store = { ...baseStore(), arweave: { enabled: false, registered: false } };
    render(<SafeboxSection formatDate={formatDate} />);
    expect(screen.getByText(/только на этом устройстве/)).toBeDefined();
  });
});

describe('SafeboxSection — locked / not configured', () => {
  it('renders the PIN pad when a config exists but the section is locked', async () => {
    h.store = { ...baseStore(), safeboxUnlocked: false };
    render(<SafeboxSection formatDate={formatDate} />);
    await waitFor(() => expect(screen.getByText('Сейф заблокирован')).toBeDefined());
    expect(screen.getByText(/PIN сейфа можно сбросить только вводом полной seed-фразы/)).toBeDefined();
  });

  it('the PIN pad input carries the FULL anti-autofill set and a non-heuristic name', async () => {
    h.store = { ...baseStore(), safeboxUnlocked: false };
    const { container } = render(<SafeboxSection formatDate={formatDate} />);
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
    render(<SafeboxSection formatDate={formatDate} />);
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
