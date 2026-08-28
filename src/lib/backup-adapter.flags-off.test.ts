import { describe, it, expect, vi } from 'vitest';
import {
  applyPreparedImport,
  prepareImport,
  runExport,
  runVerify,
  BackupDisabledError,
  type BackupStorage,
  type BackupVault,
} from './backup-adapter';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from './flags';
import type { PreparedImport } from './backup-adapter';

/**
 * The build as it actually ships — real flags, not mocked ones.
 *
 * D16 puts the gate in the ACTIONS, not in the UI, and this file is why that
 * distinction is worth a test: a hidden button is a layout decision, and
 * layout decisions are reverted by accident. With the flags off nothing here
 * may run, and «nothing» has to include not touching storage on the way to
 * the refusal — an operation that reads the vault before deciding it is
 * disabled has already done the part that could fail.
 */

const vault: BackupVault = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  dbGeneration: 1,
  assertAlive: () => {},
  now: () => 0,
};

const refuseEverything = (): BackupStorage => ({
  readSnapshot: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  getNote: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  getEntry: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  mergeRecord: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  readMeta: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  writeMeta: vi.fn(async () => { throw new Error('storage must not be touched'); }),
});

const file = { size: 10, text: async () => '{}' };

describe('the shipped flag pair', () => {
  it('is the release-1 pair: both off', () => {
    // If this ever fails it is either the release moving on (update the file)
    // or a flag flipped by accident (do not).
    expect(BACKUP_EXPORT_ENABLED).toBe(false);
    expect(BACKUP_IMPORT_ENABLED).toBe(false);
  });
});

describe('with the flags off, the actions refuse — in the action, not the markup', () => {
  it('export', async () => {
    const storage = refuseEverything();
    await expect(runExport(vault, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(storage.readSnapshot).not.toHaveBeenCalled();
    expect(storage.writeMeta).not.toHaveBeenCalled();
  });

  it('verify', async () => {
    const storage = refuseEverything();
    await expect(runVerify(vault, file, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(storage.writeMeta).not.toHaveBeenCalled();
  });

  it('prepare', async () => {
    const storage = refuseEverything();
    await expect(prepareImport(vault, file, storage)).rejects.toBeInstanceOf(BackupDisabledError);
  });

  it('apply — checked again, because a prepared plan may outlive a rollback', async () => {
    // The second check is not redundant: a plan prepared by an earlier build
    // could in principle be handed to this one. Refusing on the way IN is
    // cheap; discovering it halfway through stage B is not.
    const storage = refuseEverything();
    const prepared = { plan: { ordered: [], notApplied: [] }, fileIsComplete: true } as unknown as PreparedImport;
    await expect(applyPreparedImport(vault, prepared, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(storage.mergeRecord).not.toHaveBeenCalled();
  });
});
