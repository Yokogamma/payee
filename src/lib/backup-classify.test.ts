import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyBackupRecord, type BackupRecordKeys } from './backup-classify';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptEnvelopeV3,
  encryptSafeboxEntry,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';

/**
 * The classifier is the one place that answers «what is this record?», for
 * both the dry-run and stage A of the import. Its verdicts are tested here
 * directly, not only through `verifyBackupFile`, because the import will
 * consume them without going anywhere near that report — and the ORDER of the
 * verdicts is the part that carries D14b.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A NOTE-space (UUIDv4) identifier: wrong for a v3 note, wrong for any
 *  safebox entry — both live in the v8 space. */
const NOTE_SPACE_ID = '11111111-2222-4333-8444-555555555555';

let keys: BackupRecordKeys;
async function vaultKeys(): Promise<BackupRecordKeys> {
  keys ??= {
    note: await deriveKey(MNEMONIC),
    safeboxMeta: await deriveSafeboxMetaKey(MNEMONIC),
    safeboxSecret: await deriveSafeboxSecretKey(MNEMONIC),
  };
  return keys;
}

const makeNote = async (text = 'text'): Promise<EncryptedNote> =>
  encryptEnvelopeV3(await deriveKey(MNEMONIC), text, { fmt: 'plain', rev: 1 });

const makeEntry = async (): Promise<EncryptedSafeboxEntry> => encryptSafeboxEntry(
  await deriveSafeboxMetaKey(MNEMONIC),
  await deriveSafeboxSecretKey(MNEMONIC),
  { title: 't', login: 'l', url: '', note: '', password: 'p', files: [], rev: 1 },
);

const state = async (kind: 'note' | 'safebox', record: EncryptedNote | EncryptedSafeboxEntry) =>
  (await classifyBackupRecord(await vaultKeys(), kind, record)).state;

describe('the four verdicts', () => {
  it('a healthy record is readable, and only its topology comes out', async () => {
    const note = await makeNote('SENTINEL-TEXT');
    const verdict = await classifyBackupRecord(await vaultKeys(), 'note', note);

    expect(verdict.state).toBe('readable');
    expect(verdict).toEqual({
      kind: 'note',
      id: note.noteId,
      state: 'readable',
      topology: { root: note.noteId, rev: 1, prev: undefined },
    });
    // The plaintext lives and dies inside the classifier (D11).
    expect(JSON.stringify(verdict)).not.toContain('SENTINEL-TEXT');
  });

  it('bytes that do not authenticate are damaged', async () => {
    const note = await makeNote();
    const damaged = { ...note, ciphertext: `${note.ciphertext.slice(0, -4)}AAAA` };
    expect(await state('note', damaged)).toBe('damaged');
  });

  it('a version this build does not know is unsupported', async () => {
    expect(await state('note', { ...(await makeNote()), v: 9 } as EncryptedNote)).toBe('unsupported');
    expect(await state('safebox', { ...(await makeEntry()), v: 9 } as unknown as EncryptedSafeboxEntry))
      .toBe('unsupported');
  });

  it('a shape the upload path would refuse is malformed, decryptable or not', async () => {
    const note = await makeNote();
    // Right bytes, wrong id space for a v3 note.
    expect(await state('note', { ...note, noteId: NOTE_SPACE_ID })).toBe('malformed');
    // Right id, ciphertext below the GCM tag floor.
    expect(await state('note', { ...note, ciphertext: 'QUFBQQ==' })).toBe('malformed');
  });
});

describe('the ORDER of the verdicts (D14b)', () => {
  it('the stable field is judged before the version: unknown v + foreign id is malformed', async () => {
    // Sealing this as `unsupported` would promise never to replace it — and a
    // provably broken record must stay repairable from a backup (D5a).
    const both = {
      ...(await makeEntry()), v: 9, entryId: NOTE_SPACE_ID,
    } as unknown as EncryptedSafeboxEntry;
    expect(await state('safebox', both)).toBe('malformed');
  });

  it('but a NOTE of unknown version keeps its opacity — its id space is version-dependent', async () => {
    // For notes there is nothing to compare a UUID against once `v` is
    // unknown, so only the stable part (a non-empty string) is required. That
    // asymmetry with the safebox is deliberate, not an inconsistency.
    const opaque = { ...(await makeNote()), v: 9, noteId: NOTE_SPACE_ID } as unknown as EncryptedNote;
    expect(await state('note', opaque)).toBe('unsupported');
  });

  it('an unreadable version is never decided by which error a decrypt threw', async () => {
    // Same record, made undecryptable AND unknown: the version wins, because
    // «too new for this build» and «these bytes are gone» lead to opposite
    // advice and only one of them may forbid replacement.
    const note = await makeNote();
    const both = {
      ...note, v: 9, ciphertext: `${note.ciphertext.slice(0, -4)}AAAA`,
    } as unknown as EncryptedNote;
    expect(await state('note', both)).toBe('unsupported');
  });
});

describe('there is ONE definition of a well-formed record', () => {
  it('the classifier consults the upload barrier and defines no second one', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./backup-classify.ts', import.meta.url)),
      'utf8',
    );
    // The whole point of reusing `upload-flow`'s barrier is that a record
    // called restorable here and a record called sendable there can never
    // disagree. A private re-implementation would drift on the first change.
    //
    // Comments are stripped first: this module EXPLAINS the barrier at length,
    // and a scanner that reads prose would either fail on the explanation or
    // be weakened until it stopped catching anything.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).toMatch(/import \{ isUploadableItem \} from '\.\/upload-flow'/);
    // No id-namespace pattern and no size floor of its own — the two halves of
    // a shape check somebody would write here by hand.
    expect(code).not.toMatch(/RegExp|\/\^/);
    expect(code).not.toMatch(/\.length\s*[<>=]|byteLength/);
  });
});
