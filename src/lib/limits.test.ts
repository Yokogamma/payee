import { describe, it, expect } from 'vitest';
import { MAX_NOTE_JSON_BYTES, noteJsonByteLength, isNoteTooLong, NoteTooLongError } from './limits';

// The metric is the FULL JSON.stringify(text) in UTF-8 bytes — the two
// surrounding quotes count (plan contract, P3 review).

describe('noteJsonByteLength', () => {
  it('counts ASCII as 1 byte per char, plus the two quotes', () => {
    expect(noteJsonByteLength('abc')).toBe(5);
    expect(noteJsonByteLength('')).toBe(2); // just the quotes
  });

  it('counts Cyrillic as 2 bytes per char', () => {
    expect(noteJsonByteLength('привет')).toBe(14);
  });

  it('counts emoji as 4 UTF-8 bytes', () => {
    expect(noteJsonByteLength('🔥')).toBe(6);
  });

  it('counts JSON escapes honestly (newline/quote = 2 bytes each)', () => {
    expect(noteJsonByteLength('\n')).toBe(4);
    expect(noteJsonByteLength('"')).toBe(4);
    expect(noteJsonByteLength('a\nb')).toBe(6);
  });
});

describe('isNoteTooLong boundaries (serialized form exactly at the limit)', () => {
  const TEXT_BUDGET = MAX_NOTE_JSON_BYTES - 2; // limit minus the two quotes

  it('ASCII exactly at the limit passes; one more byte fails', () => {
    const atLimit = 'a'.repeat(TEXT_BUDGET);
    expect(noteJsonByteLength(atLimit)).toBe(MAX_NOTE_JSON_BYTES);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + 'a')).toBe(true); // 30 001 bytes serialized → rejected
  });

  it('Cyrillic hits the limit at half the character budget', () => {
    const atLimit = 'ж'.repeat(TEXT_BUDGET / 2);
    expect(noteJsonByteLength(atLimit)).toBe(MAX_NOTE_JSON_BYTES);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + 'ж')).toBe(true);
  });

  it('emoji hits the limit at a quarter of the character budget', () => {
    const count = Math.floor(TEXT_BUDGET / 4);
    const atLimit = '🔥'.repeat(count);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + '🔥'.repeat(2))).toBe(true);
  });

  it('an all-newline note doubles via escaping (worst case is counted)', () => {
    const atLimit = '\n'.repeat(TEXT_BUDGET / 2);
    expect(noteJsonByteLength(atLimit)).toBe(MAX_NOTE_JSON_BYTES);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + '\n')).toBe(true);
  });
});

describe('NoteTooLongError', () => {
  it('is a typed error carrying the measured byte length', () => {
    const err = new NoteTooLongError(31000);
    expect(err.name).toBe('NoteTooLongError');
    expect(err.byteLength).toBe(31000);
  });
});
