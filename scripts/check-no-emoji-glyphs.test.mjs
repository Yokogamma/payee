import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * No emoji, and no character pretending to be an icon.
 *
 * A CHECK RATHER THAN A LIST. The plan first carried a hand-written inventory
 * of glyphs to remove, and it was wrong twice: it missed 🔒 📋 ✏️ 🕓 🔗 ⏳ the
 * first time and ⋯ the second, once by omission and once by including a glyph
 * the design had approved. An enumeration of what to delete is only ever as
 * fresh as the last person who read the code; a rule about what may appear
 * stays true on its own.
 *
 * WHY IT MATTERS HERE. Platform emoji arrive in colour, at a size the system
 * font decides, on a baseline nobody controls — beside monochrome strokes
 * drawn at 1.6px. The same glyph is three different pictures on Windows,
 * macOS and Android. In an interface whose whole subject is «this text will
 * outlive the device it was written on», the icons cannot be the one part
 * that renders differently everywhere.
 *
 * THE WHITELIST IS TWO CHARACTERS and both are in the Mathematical Operators
 * block, which is not scanned — they are named anyway, so that a future
 * widening of the ranges cannot quietly swallow them.
 */

/**
 * Allowed.
 *
 * ∞ and ⋯ are approved by the design as text glyphs.
 *
 * The arrows are PUNCTUATION, not pictures. Russian UI prose uses → to mean
 * «then»: «Настройки → Вечное хранилище», «Сброс → Отмена», and the sync
 * state machine writes `queued → uploading` in its logs. Flagging those made
 * the first run report a dozen files that had nothing wrong with them, which
 * is how a check earns the reputation that gets it disabled.
 */
const ALLOWED = new Set(['∞', '⋯', '→', '←', '⇒', '↔']);

/**
 * What counts as «an icon pretending to be a character».
 *
 * Extended_Pictographic covers the emoji proper. The three explicit ranges are
 * the non-emoji symbols this codebase actually reached for when it wanted a
 * picture: ↻ for refresh, ● ○ ▲ for state, ✓ ✕ ✱ for verdicts.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SYMBOL_RANGES = [
  [0x21a9, 0x21bb], // Arrows used AS ICONS — ↩ return, ↻ refresh
  [0x25a0, 0x25ff], // Geometric Shapes — ● ○ ▲
  [0x2713, 0x2718], // Dingbats: check marks and crosses — ✓ ✕
  [0x2731, 0x2731], // Heavy asterisk — ✱
];

function isFlagged(ch) {
  if (ALLOWED.has(ch)) return false;
  if (PICTOGRAPHIC.test(ch)) return true;
  const cp = ch.codePointAt(0);
  return SYMBOL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Comments are excluded: this codebase documents what it removed, and
 *  «was 🔒, now an icon» must not read as a violation.
 *
 *  TRAILING comments count too — `return null; // … → no change` is the shape
 *  that slipped through when only whole-line comments were stripped. Crude
 *  (a `//` inside a string literal is cut as well), which is acceptable for a
 *  glyph scan and would not be for anything that had to parse. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const FILES = execSync('git ls-files src', { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f));

function offendersIn(file) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const found = new Map();
  for (const ch of src) {
    if (!isFlagged(ch)) continue;
    const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    found.set(ch, `${ch} (U+${cp})`);
  }
  return [...found.values()];
}

describe('никаких эмодзи и символов вместо иконок', () => {
  it('нашли файлы для проверки (страховка от сломанного обхода)', () => {
    expect(FILES.length).toBeGreaterThan(15);
  });

  it('в исходниках интерфейса нет глифов-иконок', () => {
    const offenders = FILES
      .map(f => [f, offendersIn(f)])
      .filter(([, list]) => list.length > 0)
      .map(([f, list]) => `  ${f}: ${list.join(', ')}`);

    expect(
      offenders,
      'Иконки рисуются в components/icons.tsx, а не пишутся символами.\n' +
        `Разрешены только ${[...ALLOWED].join(' и ')} — и те в макете названы глифами.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('∞ и ⋯ действительно проходят, а ✓ и 🔒 — нет', () => {
    // Проверка самой проверки: без неё «пусто» может означать сломанный фильтр.
    expect(isFlagged('∞')).toBe(false);
    expect(isFlagged('⋯')).toBe(false);
    expect(isFlagged('✓')).toBe(true);
    expect(isFlagged('🔒')).toBe(true);
    expect(isFlagged('↻')).toBe(true);
    expect(isFlagged('↩')).toBe(true);
    // Стрелка-пунктуация в «Настройки → Вечное хранилище» — не иконка.
    expect(isFlagged('→')).toBe(false);
    expect(isFlagged('←')).toBe(false);
    expect(isFlagged('●')).toBe(true);
    expect(isFlagged('⚠️')).toBe(true);
    // Обычный текст не трогаем.
    expect(isFlagged('З')).toBe(false);
    expect(isFlagged('·')).toBe(false);
    expect(isFlagged('—')).toBe(false);
  });
});
