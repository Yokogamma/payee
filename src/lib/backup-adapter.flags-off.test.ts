import { describe, it, expect, vi } from 'vitest';
import {
  estimateBackupSize,
  prepareImport,
  readBackupFreshness,
  runExport,
  runVerify,
  PreparedImport,
  BackupDisabledError,
  type BackupStorage,
  type BackupVault,
} from './backup-adapter';
import { BACKUP_EXPORT_ENABLED, BACKUP_IMPORT_ENABLED } from './flags';
import type { ImportPlan } from './backup-plan';
import type { VerifyReport } from './backup-actions';

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

/** The factory is what the operations are handed, and with the flags off it
 *  must never be CALLED: asking for the vault is how «disabled» turns into the
 *  wrong error — «unlock first» — for a feature that does not exist yet. */
const makeVault = () => vi.fn((): BackupVault => vault);

const refuseEverything = (): BackupStorage => ({
  readSnapshot: vi.fn(async () => { throw new Error('storage must not be touched'); }),
  estimateSize: vi.fn(async () => { throw new Error('storage must not be touched'); }),
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
    const factory = makeVault();
    await expect(runExport(factory, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(factory).not.toHaveBeenCalled();
    expect(storage.readSnapshot).not.toHaveBeenCalled();
    expect(storage.writeMeta).not.toHaveBeenCalled();
  });

  it('verify', async () => {
    const storage = refuseEverything();
    const factory = makeVault();
    await expect(runVerify(factory, file, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(factory).not.toHaveBeenCalled();
    expect(storage.writeMeta).not.toHaveBeenCalled();
  });

  it('prepare', async () => {
    const storage = refuseEverything();
    const factory = makeVault();
    await expect(prepareImport(factory, file, storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('apply — checked again, because a prepared session may outlive a rollback', async () => {
    // The second check is not redundant: a session prepared while the flag was
    // on could still be in a variable when the flag goes off under it — a
    // rollback is a new build, but a long-lived tab is not. Refusing on the
    // way IN is cheap; discovering it halfway through stage B is not.
    const storage = refuseEverything();
    const prepared = new PreparedImport({
      report: { ok: true, incompleteRestore: false } as unknown as VerifyReport,
      vault,
      plan: { ordered: [], notApplied: {} } as unknown as ImportPlan,
      storage,
    });

    await expect(prepared.apply()).rejects.toBeInstanceOf(BackupDisabledError);
    expect(storage.mergeRecord).not.toHaveBeenCalled();
    expect(storage.writeMeta).not.toHaveBeenCalled();
  });
});

describe('the two read-only questions are gated differently, and on purpose', () => {
  it('the size estimate refuses with the export release', async () => {
    // It describes a file only that release can produce.
    const storage = refuseEverything();
    await expect(estimateBackupSize(storage)).rejects.toBeInstanceOf(BackupDisabledError);
    expect(storage.estimateSize).not.toHaveBeenCalled();
  });

  it('the freshness markers are NOT gated — they are two meta keys and a fact', async () => {
    // Deliberately ungated: what the keys MEAN is a decision the UI makes, and
    // an unreadable chip is not a safer chip. The component decides whether to
    // show anything; this call decides nothing.
    const meta = new Map<string, unknown>();
    const storage = { ...refuseEverything(), readMeta: async (k: string) => meta.get(k) as never };

    await expect(readBackupFreshness(storage)).resolves.toEqual({
      lastExport: undefined,
      lastVerified: undefined,
    });
  });
});
