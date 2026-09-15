// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

// RELEASE 2, and the only file that renders it: import ON, export OFF.
//
// The flag matrix has three states and the other two have homes — both ON in
// `BackupSettings.test.tsx`, both OFF against the real flags in
// `BackupSettings.flags-off.test.tsx`. This middle one is what actually ships
// FIRST, ahead of the export flip, and until now nothing rendered it. A block
// that offers «Скачать резервную копию» in release 2 would hand the user a
// file the same build cannot verify or import back — worse than no file — and
// no test would have noticed.
vi.mock('../lib/flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: false,
  BACKUP_IMPORT_ENABLED: true,
}));

const h = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('../lib/store', () => ({ useNotes: () => h.store }));

import { BackupSettings } from './BackupSettings';
import { backupActions } from '../lib/backup-ui';

beforeEach(() => {
  h.store = {
    readBackupFreshness: vi.fn(async () => ({})),
    // Present, and must stay UNCALLED: sizing describes a file only the export
    // release can produce, and asking for it here would mean the block is
    // reasoning about a button it does not have.
    estimateBackupSize: vi.fn(async () => ({ expectedFileBytes: 1024, overCap: false })),
    exportBackupFile: vi.fn(),
    downloadBackupViewer: vi.fn(),
    verifyBackupFile: vi.fn(),
    prepareBackupImport: vi.fn(),
    applyBackupImport: vi.fn(),
  };
});
afterEach(cleanup);

async function open() {
  render(<BackupSettings />);
  await act(async () => { screen.getByText('Резервная копия').click(); });
}

describe('release 2 — import ON, export OFF', () => {
  it('reads the matrix as «check and import, nothing else»', () => {
    expect(backupActions()).toEqual({ canImport: true, canExport: false, anyVisible: true });
  });

  it('offers the two import actions', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Проверить файл копии' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Импортировать из файла' })).toBeTruthy();
  });

  it('offers NEITHER export button', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Скачать резервную копию' })).toBeNull();
    // The viewer download goes with the export release too: a viewer is for
    // reading a copy, and in release 2 this build cannot make one.
    expect(screen.queryByRole('button', { name: 'Скачать просмотрщик' })).toBeNull();
  });

  it('still shows the viewer instruction — a copy from another device is exactly the case', async () => {
    // The instruction is NOT tied to the export button. Release 2 is where
    // someone imports a file made elsewhere, and «keep a viewer beside the
    // file» is advice about that file, not about this build's ability to
    // produce one.
    await open();
    expect(screen.getByText(/храните рядом с файлом копии/)).toBeTruthy();
  });

  it('does not measure a size it cannot offer', async () => {
    await open();
    expect(h.store.estimateBackupSize).not.toHaveBeenCalled();
    expect(screen.queryByText(/Предполагаемый размер/)).toBeNull();
  });

  it('and it does say where the file lives, because an imported copy is still device-local', async () => {
    await open();
    expect(screen.getByText(/вне устройства/)).toBeTruthy();
  });
});
