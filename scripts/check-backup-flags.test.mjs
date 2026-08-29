import { describe, it, expect } from 'vitest';
import {
  assertBackupFlagCombination,
  checkBackupFlagsFile,
  readFlag,
} from './check-backup-flags.mjs';

/**
 * The flag matrix, and the one cell that must never ship.
 *
 * This is a build-time check rather than a runtime one because there is
 * nothing to do about it at runtime: the flags are source-controlled
 * constants, so a wrong pair is a release that must not be built.
 */

const source = (exportEnabled, importEnabled) => `
export const BACKUP_EXPORT_ENABLED: boolean = ${exportEnabled};
export const BACKUP_IMPORT_ENABLED: boolean = ${importEnabled};
`;

describe('the legal combinations', () => {
  it.each([
    ['both off — the DB3 client floor (release 1)', false, false],
    ['import on, export off — verify and restore (release 2)', false, true],
    ['both on — export as well (release 3)', true, true],
  ])('%s', (_name, exportEnabled, importEnabled) => {
    expect(assertBackupFlagCombination(source(exportEnabled, importEnabled)))
      .toEqual({ exportEnabled, importEnabled });
  });
});

describe('the forbidden combination', () => {
  it('export ON with import OFF is refused', () => {
    // Such a release hands users files the same build can neither verify nor
    // restore — and a backup nobody can check is worthless in exactly the way
    // nobody discovers until the day they need it.
    expect(() => assertBackupFlagCombination(source(true, false)))
      .toThrow(/BACKUP_EXPORT_ENABLED is on while BACKUP_IMPORT_ENABLED is off/);
  });

  it('the message says which way the flags are allowed to move', () => {
    expect(() => assertBackupFlagCombination(source(true, false)))
      .toThrow(/import on first .release 2., then export .release 3./);
  });
});

describe('the flags must be literals', () => {
  it.each([
    ['an env var', 'export const BACKUP_EXPORT_ENABLED: boolean = import.meta.env.X;'],
    ['a ternary', 'export const BACKUP_EXPORT_ENABLED: boolean = cond ? true : false;'],
    ['a missing declaration', '// nothing here'],
  ])('refuses %s', (_name, line) => {
    // A computed value would make the release artifact behave differently from
    // its own source, which is the property this whole flag file exists for.
    expect(() => readFlag(`${line}\nexport const BACKUP_IMPORT_ENABLED: boolean = false;`, 'BACKUP_EXPORT_ENABLED'))
      .toThrow(/must be declared as a literal/);
  });

  it('reads a real literal of either value', () => {
    expect(readFlag('export const A: boolean = true;', 'A')).toBe(true);
    expect(readFlag('export const A: boolean = false;', 'A')).toBe(false);
  });
});

describe('the real file', () => {
  it('src/lib/flags.ts is a legal pair', () => {
    expect(() => checkBackupFlagsFile()).not.toThrow();
  });
});
