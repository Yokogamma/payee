import { describe, it, expect, vi } from 'vitest';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from './flags';
import { backupActions } from './backup-ui';
import { estimateBackupSize, runExport, BackupDisabledError, type BackupStorage, type BackupVault } from './backup-adapter';

/**
 * The build as it ships — REAL flags, not mocked ones.
 *
 * One file owns this assertion so that a flip is a deliberate edit HERE and a
 * flag flipped by accident is caught by CI. Release history of the pair:
 * release 1 (`client-b1`) both off → release 2 (`client-b2`) import on, export
 * off → release 3 both on. If this fails it is either the release moving on
 * (update this file with the release) or an accident (do not).
 *
 * The behavioural matrices live elsewhere and mock the flags: both off in
 * `backup-adapter.flags-off.test.ts` / `BackupSettings.flags-off.test.tsx`,
 * import-only in `BackupSettings.import-only.test.tsx`, both on in
 * `BackupSettings.test.tsx` / `backup-adapter.test.ts`.
 */

describe('the shipped flag pair', () => {
  it('is the release-2 pair: import ON, export OFF', () => {
    expect(BACKUP_IMPORT_ENABLED).toBe(true);
    expect(BACKUP_EXPORT_ENABLED).toBe(false);
  });

  it('offers import and verification, and nothing of export', () => {
    expect(backupActions()).toEqual({ canImport: true, canExport: false, anyVisible: true });
  });

  it('export refuses IN THE ACTION with the real flags, without touching storage', async () => {
    const storage: BackupStorage = {
      readSnapshot: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      estimateSize: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      getNote: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      getEntry: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      mergeRecord: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      readMeta: vi.fn(async () => { throw new Error('storage must not be touched'); }),
      writeMeta: vi.fn(async () => { throw new Error('storage must not be touched'); }),
    };
    const factory = vi.fn((): BackupVault => { throw new Error('the vault must not be asked for'); });
    await expect(runExport(factory, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    await expect(estimateBackupSize(storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(factory).not.toHaveBeenCalled();
    expect(storage.readSnapshot).not.toHaveBeenCalled();
    expect(storage.estimateSize).not.toHaveBeenCalled();
  });
});
