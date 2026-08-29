// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * The one forbidden combination of the two backup flags (D16).
 *
 * `BACKUP_EXPORT_ENABLED` may not be on while `BACKUP_IMPORT_ENABLED` is off.
 * That state hands users files they can neither verify nor restore — and a
 * backup nobody can check is worthless in precisely the way nobody discovers
 * until the day it is needed. The three-release order only ever moves the
 * other way: both off (the DB3 client floor), then import + verification, then
 * export.
 *
 * A build-time check rather than a runtime one because there is nothing to do
 * about it at runtime: the flags are source-controlled constants, so a wrong
 * pair is a release that must not be built at all.
 *
 * Runs inside the root vitest suite on every PR (the sibling test asserts the
 * REAL src/lib/flags.ts is a legal pair) and as a CLI on the build and deploy
 * paths.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FLAGS_PATH = fileURLToPath(new URL('../src/lib/flags.ts', import.meta.url));

/**
 * Read one boolean flag out of the source.
 *
 * Deliberately strict: the value must be a literal `true` or `false` on the
 * declaration itself. The whole point of these flags is that a release
 * artifact's behavior is fully determined by its commit (see the file header),
 * so anything computed — an env var, a ternary, an import — is a violation of
 * that contract and is refused here rather than guessed at.
 */
export function readFlag(source, name) {
  const match = new RegExp(`export const ${name}\\s*:\\s*boolean\\s*=\\s*(true|false)\\s*;`).exec(source);
  if (!match) {
    throw new Error(
      `check-backup-flags: ${name} must be declared as a literal ` +
      '`export const NAME: boolean = true|false;` — a computed value would ' +
      'make the release artifact behave differently from its source.',
    );
  }
  return match[1] === 'true';
}

/** Throws on the forbidden pair. Returns the pair when it is legal. */
export function assertBackupFlagCombination(source) {
  const exportEnabled = readFlag(source, 'BACKUP_EXPORT_ENABLED');
  const importEnabled = readFlag(source, 'BACKUP_IMPORT_ENABLED');

  if (exportEnabled && !importEnabled) {
    throw new Error(
      'check-backup-flags: BACKUP_EXPORT_ENABLED is on while ' +
      'BACKUP_IMPORT_ENABLED is off. That release would produce backup files ' +
      'the same build can neither verify nor restore. Turn import on first ' +
      '(release 2), then export (release 3).',
    );
  }
  return { exportEnabled, importEnabled };
}

export function checkBackupFlagsFile(path = FLAGS_PATH) {
  return assertBackupFlagCombination(readFileSync(path, 'utf8'));
}

// CLI: `node scripts/check-backup-flags.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { exportEnabled, importEnabled } = checkBackupFlagsFile();
    console.log(`Backup flags OK: export=${exportEnabled} import=${importEnabled}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
