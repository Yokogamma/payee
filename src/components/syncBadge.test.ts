import { describe, it, expect } from 'vitest';
import { badgeFor, SYNC_BADGE, LOCAL_ONLY_BADGE } from './syncBadge';
import type { NoteSyncStatus } from '../lib/store';

/**
 * The whole matrix, not a few interesting rows.
 *
 * `badgeFor` has ten outcomes — five statuses times sync on/off — and until
 * now three of them were covered incidentally through Main's render tests.
 * The one that matters most is the row that looks like an exception:
 * `confirmed` keeps its badge when sync is switched OFF, because the note
 * really is on chain and the switch governs uploads rather than history.
 * Telling that user their permanent note is «на устройстве» would be a lie
 * they might act on — by not backing anything up.
 */

const ALL: NoteSyncStatus[] = ['queued', 'uploading', 'accepted', 'confirmed', 'error'];

/** status × syncActive → the expected visible word. */
const TABLE: Array<[NoteSyncStatus, boolean, string]> = [
  ['queued',    true,  'в очереди'],
  ['uploading', true,  'отправляется…'],
  ['accepted',  true,  'отправляется…'],
  ['confirmed', true,  'навечно'],
  ['error',     true,  'ошибка'],

  ['queued',    false, 'на устройстве'],
  ['uploading', false, 'на устройстве'],
  ['accepted',  false, 'на устройстве'],
  ['confirmed', false, 'навечно'], // ← НЕ «на устройстве»: она правда в блокчейне
  ['error',     false, 'на устройстве'],
];

describe('badgeFor — вся матрица', () => {
  for (const [status, syncActive, word] of TABLE) {
    it(`${status} × sync ${syncActive ? 'вкл' : 'выкл'} → «${word}»`, () => {
      expect(badgeFor({ status }, syncActive).word).toBe(word);
    });
  }

  it('подтверждённая заметка не теряет статус при выключении синхронизации', () => {
    const on = badgeFor({ status: 'confirmed' }, true);
    const off = badgeFor({ status: 'confirmed' }, false);
    expect(off).toEqual(on);
  });
});

describe('badgeFor — знак вечности', () => {
  it('∞ несёт ровно один статус', () => {
    const permanent = ALL.filter(s => SYNC_BADGE[s].permanent);
    expect(permanent).toEqual(['confirmed']);
  });

  it('и при выключенной синхронизации тоже ровно один', () => {
    const permanent = ALL.filter(s => badgeFor({ status: s }, false).permanent);
    expect(permanent).toEqual(['confirmed']);
  });

  it('«на устройстве» никогда не помечается вечным', () => {
    expect(LOCAL_ONLY_BADGE.permanent).toBe(false);
  });
});

describe('badgeFor — границы', () => {
  it('отсутствующая запись о синхронизации читается как «в очереди»', () => {
    // Заметка, только что созданная: строки в syncStatuses ещё нет.
    expect(badgeFor(undefined, true).word).toBe('в очереди');
    expect(badgeFor(undefined, false).word).toBe('на устройстве');
  });

  it('у каждого статуса есть слово, полная фраза и класс', () => {
    for (const s of ALL) {
      const b = SYNC_BADGE[s];
      expect(b.word, s).toBeTruthy();
      expect(b.label, s).toBeTruthy();
      expect(b.className, s).toMatch(/^sync-state--/);
      // Слово — для карточки, фраза — для тултипа и скринридера. Если они
      // совпали, значит одна из двух форм перестала выполнять свою работу.
      expect(b.label, s).not.toBe(b.word);
    }
  });

  it('нажимаемый статус ровно один — ошибка', () => {
    // Капсула с рамкой в этом языке означает «на это можно нажать».
    const pressable = ALL.filter(s => SYNC_BADGE[s].className.endsWith('--error'));
    expect(pressable).toEqual(['error']);
  });
});
