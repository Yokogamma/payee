import { describe, it, expect, vi } from 'vitest';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from './flags';
import { backupActions } from './backup-ui';
import { estimateBackupSize, type BackupStorage } from './backup-adapter';

/**
 * The build as it ships — REAL flags, not mocked ones.
 *
 * One file owns this assertion so that a flip is a deliberate edit HERE and a
 * flag flipped by accident is caught by CI. Release history of the pair:
 * release 1 (`client-b1`) both off → release 2 (`client-b2`) import on, export
 * off → release 3 (`client-b3`) both on — THIS build. If this fails it is either the release moving on
 * (update this file with the release) or an accident (do not).
 *
 * The behavioural matrices live elsewhere and mock the flags: both off in
 * `backup-adapter.flags-off.test.ts` / `BackupSettings.flags-off.test.tsx`,
 * import-only in `BackupSettings.import-only.test.tsx`, both on in
 * `BackupSettings.test.tsx` / `backup-adapter.test.ts`.
 */

describe('the shipped flag pair', () => {
  it('is the release-3 pair: import ON, export ON', () => {
    expect(BACKUP_IMPORT_ENABLED).toBe(true);
    expect(BACKUP_EXPORT_ENABLED).toBe(true);
  });

  it('offers import, verification AND export', () => {
    expect(backupActions()).toEqual({ canImport: true, canExport: true, anyVisible: true });
  });

  it('export is no longer refused by the flag: the size estimate reaches storage', async () => {
    const estimateSize = vi.fn(async () => ({ plaintextBytes: 1024, overCap: false }));
    const storage: BackupStorage = {
      readSnapshot: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
      estimateSize,
      getNote: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
      getEntry: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
      mergeRecord: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
      readMeta: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
      writeMeta: vi.fn(async () => { throw new Error('not needed by the estimate'); }),
    };
    const report = await estimateBackupSize(storage);
    expect(estimateSize).toHaveBeenCalledTimes(1);
    expect(report.overCap).toBe(false);
    expect(report.expectedFileBytes).toBeGreaterThan(1024);
  });
});
