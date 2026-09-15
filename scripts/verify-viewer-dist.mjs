// NO SHEBANG here: kept consistent with the other repo scripts (see
// no-shebang-in-imported-mjs.test.mjs for why it matters for imported ones).
/**
 * Prove the three invariants that only exist once a build has run:
 *   - the viewer hash the app compiles in equals the artifact in `dist`;
 *   - the viewer is NOT in the service worker's precache manifest;
 *   - the per-path CSP unset actually reached `dist/_headers`.
 *
 * Those assertions live in the two suites below, where they belong. They SKIP
 * when there is no build, which is right for `npm test` on a clean checkout —
 * and which is exactly why they must be run a second time, here, with the skip
 * turned off.
 *
 * One script rather than a copied pair of workflow steps: CI proved these for
 * ITS build, and a manual deploy — dispatchable from an arbitrary ref — builds
 * its own. Whatever is about to be published has to be the thing that was
 * checked, so both call the same command.
 *
 * Usage: node scripts/verify-viewer-dist.mjs   (after `npm run build`)
 */
import { spawnSync } from 'node:child_process';

const SUITES = [
  'scripts/build-backup-viewer.test.mjs',
  'scripts/backup-viewer-route.test.mjs',
];

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', ...SUITES],
  { stdio: 'inherit', env: { ...process.env, REQUIRE_DIST: '1' } },
);

if (result.error) {
  console.error(`verify-viewer-dist: could not start vitest — ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
