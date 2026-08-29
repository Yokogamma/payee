// NO SHEBANG here: kept consistent with the other repo scripts (see
// no-shebang-in-imported-mjs.test.mjs for why it matters for imported ones).
/**
 * Near-cap export/import measurement (plan §8 «Производительность», step 13).
 *
 * The suite it runs is SKIPPED inside `npm test` on purpose: it builds a
 * container within a few megabytes of the 32 MB ceiling, which costs seconds
 * and hundreds of megabytes of peak heap. Paying that on every commit to
 * produce a number that is read once per release is the wrong trade — but a
 * measurement nobody can re-run is worse than no measurement, so it lives as a
 * command rather than as a note in a document.
 *
 * Report-only, exactly like `report-precache.mjs`: no threshold, because a
 * wall-clock threshold on a shared runner is a flaky test, and the consumer of
 * these numbers is a human comparing them against a device. The one hard
 * ASSERTION inside — a near-cap export produces a file that passes its own
 * import (D17) — is not a measurement and does fail the run.
 *
 * Usage: node scripts/measure-backup-near-cap.mjs
 */
import { spawnSync } from 'node:child_process';

const SUITE = 'src/lib/backup.near-cap.measure.test.ts';

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', SUITE, '--reporter', 'verbose'],
  { stdio: 'inherit', env: { ...process.env, MEASURE_NEAR_CAP: '1' } },
);

if (result.error) {
  console.error(`measure-backup-near-cap: could not start vitest — ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
