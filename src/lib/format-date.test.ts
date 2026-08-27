import { describe, it, expect } from 'vitest';
import { formatNoteDate, formatNoteDateFull } from './format-date';

/** 2026-08-17 14:30:00 local — «now» for every case below. Passed explicitly
 *  rather than faked globally: the function takes `now` as a parameter for
 *  exactly this reason, and a real clock in a test is a flake waiting for a
 *  midnight CI run. */
const NOW = new Date(2026, 7, 17, 14, 30, 0).getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatNoteDate — относительное окно', () => {
  it('только что', () => {
    expect(formatNoteDate(NOW, NOW)).toBe('только что');
    expect(formatNoteDate(NOW - 59_999, NOW)).toBe('только что');
  });

  it('граница минуты', () => {
    expect(formatNoteDate(NOW - MINUTE, NOW)).toBe('1 мин назад');
    expect(formatNoteDate(NOW - 59 * MINUTE, NOW)).toBe('59 мин назад');
  });

  it('граница часа', () => {
    expect(formatNoteDate(NOW - HOUR, NOW)).toBe('1 ч назад');
    expect(formatNoteDate(NOW - 23 * HOUR, NOW)).toBe('23 ч назад');
  });

  it('на 24 часах относительное время заканчивается', () => {
    // 24 ч назад — это 16 августа 14:30.
    expect(formatNoteDate(NOW - DAY, NOW)).toBe('16 августа');
  });
});

describe('formatNoteDate — календарное окно', () => {
  it('этот год — без года', () => {
    expect(formatNoteDate(new Date(2026, 7, 9, 12, 0).getTime(), NOW)).toBe('9 августа');
  });

  it('день не дополняется нулём', () => {
    expect(formatNoteDate(new Date(2026, 0, 5, 12, 0).getTime(), NOW)).toBe('5 января');
  });

  it('месяц в родительном падеже, а не в именительном', () => {
    // toLocaleString('ru', { month: 'long' }) сам по себе даёт «август».
    const may = formatNoteDate(new Date(2026, 4, 1, 12, 0).getTime(), NOW);
    expect(may).toBe('1 мая');
    expect(may).not.toContain('май ');
  });

  it('прошлый год — год сохраняется', () => {
    // Обещание архива — что записи остаются навсегда. Дата, которая молча
    // означает «какой-то август», — единственная двусмысленность, которую он
    // позволить себе не может.
    expect(formatNoteDate(new Date(2025, 7, 9, 12, 0).getTime(), NOW)).toBe('9 августа 2025');
    expect(formatNoteDate(new Date(2019, 11, 31, 23, 59).getTime(), NOW)).toBe('31 декабря 2019');
  });

  it('без « г.» на конце', () => {
    // Intl с year:'numeric' дописал бы «2025 г.» — в моно-верхнем регистре
    // это читается как шум.
    expect(formatNoteDate(new Date(2025, 7, 9, 12, 0).getTime(), NOW)).not.toContain('г.');
  });

  it('31 декабря прошлого года и 1 января этого различимы', () => {
    const nowJan = new Date(2026, 0, 1, 12, 0).getTime();
    expect(formatNoteDate(new Date(2025, 11, 31, 12, 0).getTime(), nowJan)).toBe('31 декабря 2025');
  });
});

describe('formatNoteDate — часы, идущие не туда', () => {
  it('будущая метка клампится в «только что», а не в отрицательное время', () => {
    // Устройство с уехавшими часами пишет заметку, потом часы поправляются.
    expect(formatNoteDate(NOW + HOUR, NOW)).toBe('только что');
    expect(formatNoteDate(NOW + 365 * DAY, NOW)).toBe('только что');
  });

  it('и не превращается в «через 3 часа» — заметка не запланирована', () => {
    expect(formatNoteDate(NOW + 3 * HOUR, NOW)).not.toMatch(/через/);
  });
});

/**
 * The absolute variant, used for the accessible name of the feed's open
 * control: «Открыть заметку от …». A control must not be named by a moving
 * target, and «Открыть заметку от только что» is not a sentence.
 */
describe('formatNoteDateFull — всегда дата, никогда «сколько прошло»', () => {
  it('этот год — без года', () => {
    expect(formatNoteDateFull(new Date(2026, 7, 19, 12, 0).getTime(), NOW)).toBe('19 августа');
  });

  it('прошлый год — с годом', () => {
    expect(formatNoteDateFull(new Date(2025, 7, 19, 12, 0).getTime(), NOW)).toBe('19 августа 2025');
  });

  it('только что созданная заметка всё равно названа датой', () => {
    // Именно здесь относительный форматтер сказал бы «только что».
    expect(formatNoteDate(NOW, NOW)).toBe('только что');
    expect(formatNoteDateFull(NOW, NOW)).toBe('17 августа');
  });

  it('будущая метка печатается датой, а не клампится', () => {
    // У полного форматтера относительной ветки нет вовсе, поэтому и клампа
    // «только что» здесь быть не может.
    expect(formatNoteDateFull(NOW + 3 * HOUR, NOW)).toBe('17 августа');
    expect(formatNoteDateFull(new Date(2027, 0, 5, 12, 0).getTime(), NOW)).toBe('5 января 2027');
  });

  it('ни при каком входе не содержит относительных слов', () => {
    for (const ts of [NOW, NOW - MINUTE, NOW - HOUR, NOW - DAY, NOW + DAY, NOW - 400 * DAY]) {
      expect(formatNoteDateFull(ts, NOW)).not.toMatch(/назад|только что|через/);
    }
  });
});
