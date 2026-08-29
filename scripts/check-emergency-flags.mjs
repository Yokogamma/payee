// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Emergency-profile preflight, run from the TRUSTED checkout over the
 * CANDIDATE's own wrangler.toml, BEFORE the Cloudflare action.
 *
 * An emergency release is defined by every upload switch being off. Learning
 * otherwise from a post-deploy smoke would mean the unsafe build was already
 * live — the whole point of a preflight is that the check happens while
 * refusing is still free.
 *
 * Block-scoped, not a grep: `[env.staging.vars]` legitimately carries the same
 * key names, so a file-wide match would let a production "true" pass because
 * staging happened to say "false".
 */

import { readFileSync } from 'node:fs';
import { checkUploadSwitchesOff } from './check-gateways-vs-worker.mjs';

if (process.argv[1]?.endsWith('check-emergency-flags.mjs')) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/check-emergency-flags.mjs <path-to-wrangler.toml>');
    process.exit(2);
  }
  let toml;
  try {
    toml = readFileSync(path, 'utf8');
  } catch {
    console.error(`✗ cannot read ${path}`);
    process.exit(1);
  }
  // The PRODUCTION table is what a production deploy ships.
  const { ok, problems } = checkUploadSwitchesOff(toml, '');
  if (!ok) {
    console.error('✗ emergency preflight failed — this build would be activated with uploads on:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('✓ emergency preflight: all three upload switches are "false" in [vars]');
}
