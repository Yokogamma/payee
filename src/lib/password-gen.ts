/**
 * Password generation — pure functions, no React.
 *
 * `crypto.getRandomValues` with REJECTION SAMPLING. Modulo bias is not
 * theoretical here: with a 70-character alphabet, `byte % 70` makes the first
 * 46 characters ~1.4× more likely than the rest. We discard every byte at or
 * above the largest multiple of the alphabet size instead.
 */

import { wordlist } from '@scure/bip39/wordlists/english.js';

export const RANDOM_MIN_LENGTH = 8;
export const RANDOM_MAX_LENGTH = 64;
export const RANDOM_DEFAULT_LENGTH = 20;

/** Passphrase policy (fixed): 6 words out of 2048 ≈ 66 bits; 5 words ≈ 55 bits
 *  is the floor; '-' as the separator. */
export const PASSPHRASE_DEFAULT_WORDS = 6;
export const PASSPHRASE_MIN_WORDS = 5;
export const PASSPHRASE_MAX_WORDS = 10;
export const PASSPHRASE_SEPARATOR = '-';

export const CHARSET_LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const CHARSET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const CHARSET_DIGITS = '0123456789';
export const CHARSET_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';

/** Bytes source — injectable so the test can pin the rejection threshold
 *  deterministically instead of eyeballing a histogram. */
export type RandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = n => crypto.getRandomValues(new Uint8Array(n));

/**
 * Uniform index in [0, size) WITHOUT modulo bias: bytes ≥
 * `256 − (256 % size)` are rejected and re-drawn.
 */
export function uniformIndex(size: number, randomBytes: RandomBytes = defaultRandomBytes): number {
  if (!Number.isInteger(size) || size <= 0 || size > 256) {
    throw new Error(`unsupported alphabet size: ${size}`);
  }
  const limit = 256 - (256 % size); // largest multiple of `size` that fits a byte
  for (;;) {
    const [b] = randomBytes(1);
    if (b < limit) return b % size;
    // else: rejected — draw again (this is the whole point)
  }
}

export function generateRandomPassword(
  length: number,
  alphabet: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  if (alphabet.length === 0) throw new Error('empty alphabet');
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[uniformIndex(alphabet.length, randomBytes)];
  return out;
}

export function generatePassphrase(
  words: number,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const picked: string[] = [];
  for (let i = 0; i < words; i++) {
    // 2048 > 256, so build the index from two uniform draws (8 × 256 = 2048).
    const hi = uniformIndex(8, randomBytes);
    const lo = uniformIndex(256, randomBytes);
    picked.push(wordlist[hi * 256 + lo]);
  }
  return picked.join(PASSPHRASE_SEPARATOR);
}
