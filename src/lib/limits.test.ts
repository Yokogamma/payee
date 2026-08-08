import { describe, it, expect } from 'vitest';
import { MAX_NOTE_JSON_BYTES, noteJsonByteLength, isNoteTooLong, NoteTooLongError } from './limits';

describe('noteJsonByteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    expect(noteJsonByteLength('abc')).toBe(3);
  });

  it('counts Cyrillic as 2 bytes per char', () => {
    expect(noteJsonByteLength('привет')).toBe(12);
  });

  it('counts emoji as 4 UTF-8 bytes', () => {
    expect(noteJsonByteLength('🔥')).toBe(4);
  });

  it('counts JSON escapes honestly (newline/quote = 2 bytes each)', () => {
    expect(noteJsonByteLength('\n')).toBe(2);
    expect(noteJsonByteLength('"')).toBe(2);
    expect(noteJsonByteLength('a\nb')).toBe(4);
  });
});

describe('isNoteTooLong boundaries', () => {
  it('ASCII exactly at the limit passes; one more byte fails', () => {
    const atLimit = 'a'.repeat(MAX_NOTE_JSON_BYTES);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + 'a')).toBe(true);
  });

  it('Cyrillic hits the limit at half the character count', () => {
    const atLimit = 'ж'.repeat(MAX_NOTE_JSON_BYTES / 2);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + 'ж')).toBe(true);
  });

  it('emoji hits the limit at a quarter of the character count', () => {
    const count = Math.floor(MAX_NOTE_JSON_BYTES / 4);
    const atLimit = '🔥'.repeat(count);
    expect(isNoteTooLong(atLimit)).toBe(false);
    expect(isNoteTooLong(atLimit + '🔥')).toBe(true);
  });

  it('an all-newline note doubles via escaping (worst case is counted)', () => {
    const atLimit = '\n'.repeat(MAX_NOTE_JSON_BYTES / 2);
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
