import { describe, it, expect } from 'vitest';
import {
  exportBackup,
  inspectBackupFile,
  type BackupActionDeps,
} from './backup-actions';
import { planBackupImport, type PlanInput } from './backup-plan';
import { applyBackupImport } from './backup-import';
import {
  BACKUP_CAP_BYTES,
  BACKUP_PLAINTEXT_BUDGET_BYTES,
  deriveBackupKey,
} from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptEnvelopeV3,
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
 * ── What it PROVES, and what it merely reports ───────────────────────
 *
 * The assertion the plan asks for is «a near-cap export produces a file that
 * passes its own import» (D17), and it only means something if the round trip
 * could have failed. The first version of this file could not: it filled the
 * container with `'A'` — base64 of the right length, decryptable by nobody —
 * so every record came back `damaged`, `report.ok` was never consulted, and
 * stage B never ran. It measured the pipeline and proved nothing.
 *
 * Now: real records under the real key, a GREEN verify (`ok === true`, every
 * record `readable`), and stage B applied in full against an in-memory writer.
 * A database is deliberately not involved — what is under test is the
 * container path at this size, not IndexedDB.
 *
 * The TIMINGS are reported, never thresholded: a wall-clock threshold on a
 * shared runner is a flaky test, and the consumer of these numbers is a human
 * in `docs/ROLLBACK.md` comparing them against a device.
 *
 * ── What it does NOT measure ─────────────────────────────────────────
 *
 * A browser main thread. This is Node, and the chain mixes synchronous work
 * (canonical serialization, `JSON.parse`, base64) with WebCrypto calls that a
 * browser may run off-thread. So these seconds are the COST of the operation,
 * not a proven duration of a frozen interface — and the mobile figure, which
 * is the one that decides whether a phone can do this at all, is the
 * operator's to take on a real device (§13).
 */

const RUN = process.env.MEASURE_NEAR_CAP === '1';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Fill the budget to within a hair of it, in realistically-shaped records. */
const RECORD_PAYLOAD_BYTES = 24 * 1024;

/** The file has to be genuinely near the ceiling for the run to mean anything:
 *  a «near-cap» measurement at half the cap measures something else. */
const MIN_CAP_FRACTION = 0.9;

/** A distinct body per record: identical plaintext would compress in ways a
 *  real store does not, and the cap is charged on the serialized bytes. */
async function realNote(index: number, key: CryptoKey): Promise<EncryptedNote> {
  const text = `${index}:${'note '.repeat(Math.floor(RECORD_PAYLOAD_BYTES / 5))}`;
  return encryptEnvelopeV3(key, text, { fmt: 'plain', rev: 1 });
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
  it('produces a file that passes its own import IN FULL, and reports what it cost', async () => {
    const key = await deriveKey(MNEMONIC);
    const count = Math.floor(BACKUP_PLAINTEXT_BUDGET_BYTES / (RECORD_PAYLOAD_BYTES * 1.4));
    const notes: EncryptedNote[] = [];
    for (let i = 0; i < count; i += 1) notes.push(await realNote(i, key));

    // PEAK, not delta. `memoryUsage()` before and after reports what was still
    // held at the end, which for a pipeline that builds and drops several
    // large intermediates is the least interesting number available — and not
    // the one a phone runs out of.
    const baseRss = process.memoryUsage().rss;
    let peakRss = baseRss;
    let peakHeap = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      const now = process.memoryUsage();
      peakRss = Math.max(peakRss, now.rss);
      peakHeap = Math.max(peakHeap, now.heapUsed);
    }, 25);

    try {
      const startExport = performance.now();
      const exported = await exportBackup(await deps(notes));
      const exportMs = performance.now() - startExport;

      const fileBytes = new TextEncoder().encode(exported.text).byteLength;

      // The assertion the plan asks for, at a size where it can actually fail:
      // the cap is charged on the FINAL file on both sides, so a near-cap
      // export must not produce something its own import refuses.
      expect(fileBytes).toBeLessThanOrEqual(BACKUP_CAP_BYTES);
      // …and genuinely near it, or this is a measurement of something else.
      expect(fileBytes).toBeGreaterThan(BACKUP_CAP_BYTES * MIN_CAP_FRACTION);

      const startVerify = performance.now();
      const inspected = await inspectBackupFile(
        await deps([]),
        { size: fileBytes, text: async () => exported.text },
      );
      const verifyMs = performance.now() - startVerify;

      // GREEN, not merely parseable: every record decrypted, the chain graph
      // agrees and the header is honest.
      expect(inspected.report.ok).toBe(true);
      expect(inspected.report.counts.notes).toBe(count);
      expect(inspected.records.every(r => r.state === 'readable')).toBe(true);

      // Stage B for real, against an in-memory writer.
      const merged: string[] = [];
      const startApply = performance.now();
      const report = await applyBackupImport(
        {
          now: () => 1_756_000_000_000,
          assertAlive: () => {},
          classifyLocal: async () => ({ state: 'absent' }),
          mergeRecord: async (_kind, incoming) => {
            merged.push((incoming as EncryptedNote).noteId);
            return 'added';
          },
          readIncompleteMarker: async () => false,
          writeIncompleteMarker: async () => {},
          withExclusiveLock: run => run(),
        },
        planBackupImport(inspected.records.map(r => ({
          kind: r.kind,
          id: r.id,
          state: 'readable',
          topology: r.topology,
          record: r.record,
        }) as PlanInput)),
        true,
      );
      const applyMs = performance.now() - startApply;
      const stillHeld = process.memoryUsage().heapUsed;

      expect(report.counters.added).toBe(count);
      expect(report.allFileRecordsApplied).toBe(true);
      expect(report.incompleteRestore).toBe(false);
      expect(merged).toHaveLength(count);

      console.log([
        '',
        '  near-cap measurement (desktop, Node — NOT a browser main thread)',
        `    records:         ${count} real encrypted notes × ~${(RECORD_PAYLOAD_BYTES / 1024).toFixed(0)} KB`,
        `    file produced:   ${mb(fileBytes)} of ${mb(BACKUP_CAP_BYTES)} cap`,
        `    export:          ${exportMs.toFixed(0)} ms  (snapshot → canonical → GCM → SHA-256)`,
        `    verify:          ${verifyMs.toFixed(0)} ms  (size gate → parse → GCM → per-record decrypt)`,
        `    apply (stage B): ${applyMs.toFixed(0)} ms  (plan → per-record merge, in memory)`,
        `    peak memory:     ${mb(peakHeap)} heap, ${mb(peakRss)} RSS (+${mb(peakRss - baseRss)} over baseline)`,
        `    still held:      ${mb(stillHeld)} heap`,
        '',
      ].join('\n'));
    } finally {
      clearInterval(sampler);
    }
  }, 600_000);
});
