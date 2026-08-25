import { describe, it, expect } from 'vitest';
import { publicationEquivalent } from './publication-equivalent';
import type { PublicationSubject } from './publication-equivalent';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';

const baseNote: EncryptedNote = {
  noteId: '11111111-2222-4333-8444-555555555555',
  ciphertext: 'AAAA',
  iv: 'AAAAAAAAAAAAAAAA',
  createdAt: 1756000000000,
};

const baseV3: EncryptedNote = {
  noteId: '66666666-7777-8333-9444-555555555555',
  v: 3,
  ciphertext: 'BBBB',
  iv: 'BBBBBBBBBBBBBBBB',
  createdAt: 1756000000000,
};

const baseEntry: EncryptedSafeboxEntry = {
  entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
  v: 4,
  metaCiphertext: 'CCCC',
  metaIv: 'CCCCCCCCCCCCCCCC',
  secretCiphertext: 'DDDD',
  secretIv: 'DDDDDDDDDDDDDDDD',
  createdAt: 1756000000000,
};

const note = (over: Partial<EncryptedNote> = {}): PublicationSubject => ({
  kind: 'note',
  record: { ...baseNote, ...over },
});
const noteV3 = (over: Partial<EncryptedNote> = {}): PublicationSubject => ({
  kind: 'note',
  record: { ...baseV3, ...over },
});
const entry = (over: Partial<EncryptedSafeboxEntry> = {}): PublicationSubject => ({
  kind: 'safebox',
  record: { ...baseEntry, ...over },
});
/** A record this build cannot serialize — the opaque case (D11a). */
const opaqueNote = (over: Record<string, unknown> = {}): PublicationSubject => ({
  kind: 'note',
  record: { ...baseNote, v: 9, ...over } as unknown as EncryptedNote,
});

describe('publicationEquivalent — notes', () => {
  it('two copies of the same record are equivalent', () => {
    expect(publicationEquivalent(note(), note())).toBe(true);
  });

  it('a different ciphertext is not equivalent', () => {
    expect(publicationEquivalent(note(), note({ ciphertext: 'ZZZZ' }))).toBe(false);
  });

  it('a different IV is not equivalent — the same plaintext under a fresh IV is a different publication', () => {
    expect(publicationEquivalent(note(), note({ iv: 'ZZZZZZZZZZZZZZZZ' }))).toBe(false);
  });

  it('a different noteId is not equivalent', () => {
    expect(publicationEquivalent(note(), note({ noteId: 'aaaaaaaa-2222-4333-8444-555555555555' }))).toBe(false);
  });

  it('for v1, createdAt IS published (outer `t` + Timestamp tag) — differing means not equivalent', () => {
    expect(publicationEquivalent(note(), note({ createdAt: 1756000000001 }))).toBe(false);
  });

  it('for v3, createdAt is NOT published — differing outer createdAt stays equivalent', () => {
    // The authenticated date lives inside the v3 envelope; the outer value is
    // local index/ordering only and never reaches the chain. Treating it as a
    // difference would report a conflict on records that are byte-identical
    // on-chain.
    expect(publicationEquivalent(noteV3(), noteV3({ createdAt: 1756000000001 }))).toBe(true);
  });

  it('the same ciphertext under a different version is not equivalent', () => {
    expect(publicationEquivalent(note(), noteV3({ noteId: baseNote.noteId, ciphertext: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' }))).toBe(false);
  });

  it('unknown extra fields do not affect equivalence — they are never published', () => {
    const withExtra = { ...baseNote, futureField: { nested: true } } as unknown as EncryptedNote;
    expect(publicationEquivalent(note(), { kind: 'note', record: withExtra })).toBe(true);
  });

  it('is symmetric', () => {
    expect(publicationEquivalent(note({ ciphertext: 'ZZZZ' }), note())).toBe(false);
    expect(publicationEquivalent(noteV3({ createdAt: 5 }), noteV3())).toBe(true);
  });
});

describe('publicationEquivalent — safebox entries', () => {
  it('two copies of the same entry are equivalent', () => {
    expect(publicationEquivalent(entry(), entry())).toBe(true);
  });

  it('a different secret half is not equivalent', () => {
    expect(publicationEquivalent(entry(), entry({ secretCiphertext: 'ZZZZ' }))).toBe(false);
  });

  it('a different meta half is not equivalent', () => {
    expect(publicationEquivalent(entry(), entry({ metaIv: 'ZZZZZZZZZZZZZZZZ' }))).toBe(false);
  });

  it('a different entryId is not equivalent', () => {
    expect(publicationEquivalent(entry(), entry({ entryId: '99999999-9999-8aaa-baaa-cccccccccccc' }))).toBe(false);
  });

  it('v4 publishes no timestamp — differing outer createdAt stays equivalent', () => {
    expect(publicationEquivalent(entry(), entry({ createdAt: 1756000000001 }))).toBe(true);
  });
});

describe('publicationEquivalent — total, never throws', () => {
  it('a kind mismatch is not equivalent', () => {
    expect(publicationEquivalent(note(), entry())).toBe(false);
    expect(publicationEquivalent(entry(), note())).toBe(false);
  });

  it('an opaque record (version this build cannot serialize) is not equivalent — and does not throw', () => {
    expect(publicationEquivalent(note(), opaqueNote())).toBe(false);
    expect(publicationEquivalent(opaqueNote(), note())).toBe(false);
  });

  it('two IDENTICAL opaque records are still «not equivalent» — the quarantine table decides them, not this predicate', () => {
    expect(publicationEquivalent(opaqueNote(), opaqueNote())).toBe(false);
  });

  it('an unsupported safebox version is not equivalent', () => {
    const bad = { ...baseEntry, v: 5 } as unknown as EncryptedSafeboxEntry;
    expect(publicationEquivalent(entry(), { kind: 'safebox', record: bad })).toBe(false);
  });

  it('malformed rows from an untrusted backup file return false instead of throwing', () => {
    const malformed: unknown[] = [
      { ...baseNote, createdAt: undefined },   // v1 tag build dereferences createdAt
      { ...baseNote, createdAt: null },
      {},
      { noteId: 'x' },
      null,
      undefined,
    ];
    for (const record of malformed) {
      expect(() =>
        publicationEquivalent(note(), { kind: 'note', record: record as EncryptedNote }),
      ).not.toThrow();
      expect(publicationEquivalent(note(), { kind: 'note', record: record as EncryptedNote })).toBe(false);
    }
  });
});
