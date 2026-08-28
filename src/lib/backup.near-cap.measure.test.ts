import { describe, it, expect } from 'vitest';
import {
  exportBackup,
  inspectBackupFile,
  type BackupActionDeps,
} from './backup-actions';
import {
  BACKUP_CAP_BYTES,
  BACKUP_PLAINTEXT_BUDGET_BYTES,
  deriveBackupKey,
} from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  sha256Hex,
  type EncryptedNote,
} from './crypto';

/**
 * The near-cap measurement (plan §8 «Производительность», step 13).
 *
 * SKIPPED by default, and that is the point: it builds a container within a
 * few megabytes of the 32 MB ceiling, which costs seconds and hundreds of
 * megabytes of peak heap. Running it inside `npm test` would slow every commit
 * to buy a number nobody reads on every commit. It runs from
 * `scripts/measure-backup-near-cap.mjs`, which sets `MEASURE_NEAR_CAP=1`.
 *
 * Two different things happen here and both are deliberate:
 *
 *  - an ASSERTION the plan requires and no other test makes at this size —
 *    «a near-cap export produces a file that passes its own import» (D17). The
 *    cap arithmetic is proven in `backup.test.ts` on constants, and the
 *    round-trip on ~2 MB; neither would notice a per-record overhead that only
 *    matters when there are tens of thousands of records. Getting this wrong
 *    means an export that hands the user a file its own import refuses — at
 *    the one moment the file is all they have;
 *  - a MEASUREMENT, printed rather than thresholded. A threshold on wall-clock
 *    would be a flaky test on a shared runner, and the number's real consumer
 *    is `docs/ROLLBACK.md`, where a human compares it against a device.
 *
 * What it does NOT measure is the browser's main thread. This is Node: the
 * chain under test is synchronous crypto, canonical serialization and JSON, so
 * the time here IS the time the tab would be unresponsive for — but scheduling,
 * GC pauses and the actual heap ceiling on a phone are a different question,
 * and the plan leaves the mobile number to the operator for that reason.
 */

const RUN = process.env.MEASURE_NEAR_CAP === '1';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Fill the budget to within a hair of it, in realistically-shaped records. */
const RECORD_PAYLOAD_BYTES = 24 * 1024;

function fakeNote(index: number, bytes: number): EncryptedNote {
  // Base64 of the right LENGTH — this measures the format and the pipeline, not
  // AES. Real ciphertext would cost minutes of key derivation for records the
  // reader never decrypts on the export path anyway.
  const ciphertext = 'A'.repeat(Math.ceil(bytes / 3) * 4);
  return {
    noteId: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`,
    ciphertext,
    iv: 'AAAAAAAAAAAAAAAA',
    createdAt: 1_756_000_000_000 + index,
  } as EncryptedNote;
}

async function deps(notes: EncryptedNote[]): Promise<BackupActionDeps> {
  return {
    now: () => 1_756_000_000_000,
    keys: {
      note: await deriveKey(MNEMONIC),
      safeboxMeta: await deriveSafeboxMetaKey(MNEMONIC),
      safeboxSecret: await deriveSafeboxSecretKey(MNEMONIC),
      container: await deriveBackupKey(MNEMONIC),
    },
    readSnapshot: async () => ({
      ok: true,
      snapshot: { notes, safebox: [], incompleteRestore: false },
    }),
    sha256Hex,
    assertAlive: () => {},
  };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

describe.skipIf(!RUN)('near-cap export and import (step 13)', () => {
  it('produces a file that passes its own import, and reports what it cost', async () => {
    const count = Math.floor(BACKUP_PLAINTEXT_BUDGET_BYTES / (RECORD_PAYLOAD_BYTES * 1.34));
    const notes = Array.from({ length: count }, (_, i) => fakeNote(i, RECORD_PAYLOAD_BYTES));

    const before = process.memoryUsage();
    const startExport = performance.now();
    const exported = await exportBackup(await deps(notes));
    const exportMs = performance.now() - startExport;

    const fileBytes = new TextEncoder().encode(exported.text).byteLength;

    // The assertion the plan asks for, at a size where it can actually fail:
    // the cap is charged on the FINAL file on both sides, so a near-cap export
    // must not produce something its own import refuses.
    expect(fileBytes).toBeLessThanOrEqual(BACKUP_CAP_BYTES);

    const startImport = performance.now();
    const inspected = await inspectBackupFile(
      await deps([]),
      { size: fileBytes, text: async () => exported.text },
    );
    const importMs = performance.now() - startImport;
    const after = process.memoryUsage();

    // Every record came back, and the reader agrees the file is intact. The
    // records are not decryptable (synthetic ciphertext), so the verdict is
    // «damaged» per record — what is being measured is the pipeline, and what
    // is being asserted is that nothing was LOST or refused wholesale.
    expect(inspected.report.counts.notes).toBe(count);
    expect(inspected.records).toHaveLength(count);

    console.log([
      '',
      '  near-cap measurement (desktop, Node — not a browser main thread)',
      `    records:        ${count} notes × ${(RECORD_PAYLOAD_BYTES / 1024).toFixed(0)} KB ciphertext`,
      `    plaintext:      ${mb(BACKUP_PLAINTEXT_BUDGET_BYTES)} budget`,
      `    file produced:  ${mb(fileBytes)} of ${mb(BACKUP_CAP_BYTES)} cap`,
      `    export:         ${exportMs.toFixed(0)} ms  (snapshot → canonical → GCM → SHA-256)`,
      `    verify/import:  ${importMs.toFixed(0)} ms  (size gate → parse → GCM → per-record classify)`,
      `    heap delta:     ${mb(after.heapUsed - before.heapUsed)} used, ${mb(after.rss - before.rss)} RSS`,
      '',
    ].join('\n'));
  }, 300_000);
});
