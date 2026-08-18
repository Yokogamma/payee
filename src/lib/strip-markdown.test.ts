import { describe, it, expect } from 'vitest';
import { stripMarkdown } from './strip-markdown';

describe('stripMarkdown — то, что видел пользователь', () => {
  it('снимает жирность и курсив из реальной заметки с прода', () => {
    // Ровно эта строка приехала со скриншота телефона.
    expect(stripMarkdown('Первая мадаун **заметка** *версия 2*'))
      .toBe('Первая мадаун заметка версия 2');
  });

  it('подчёркивания в обеих формах', () => {
    expect(stripMarkdown('__жирный__ и _курсив_')).toBe('жирный и курсив');
  });

  it('код и зачёркивание', () => {
    expect(stripMarkdown('вызов `npm test` и ~~старое~~')).toBe('вызов npm test и старое');
  });
});

describe('stripMarkdown — блочные конструкции', () => {
  it('заголовки', () => {
    expect(stripMarkdown('# Заголовок\n## Второй')).toBe('Заголовок\nВторой');
  });

  it('списки маркированные и нумерованные', () => {
    expect(stripMarkdown('- первый\n- второй')).toBe('первый\nвторой');
    expect(stripMarkdown('1. раз\n2. два')).toBe('раз\nдва');
  });

  it('цитата и горизонтальная линия', () => {
    expect(stripMarkdown('> цитата')).toBe('цитата');
    expect(stripMarkdown('текст\n---\nещё')).toBe('текст\n\nещё');
  });

  it('ограждённый блок кода теряет забор, но не содержимое', () => {
    expect(stripMarkdown('```js\nconst x = 1;\n```')).toBe('const x = 1;\n');
  });
});

describe('stripMarkdown — ссылки', () => {
  it('оставляет текст ссылки, убирает адрес', () => {
    expect(stripMarkdown('см. [документацию](https://example.invalid/a)'))
      .toBe('см. документацию');
  });

  it('картинка не оставляет восклицательный знак', () => {
    expect(stripMarkdown('![схема](img.png)')).toBe('схема');
  });

  it('вложенная жирность внутри ссылки снимается тоже', () => {
    expect(stripMarkdown('[**важное**](/x)')).toBe('важное');
  });
});

describe('stripMarkdown — что трогать НЕЛЬЗЯ', () => {
  it('обычный текст не меняется', () => {
    const text = 'Просто заметка без разметки. Цена 5 * 3 рубля.';
    expect(stripMarkdown(text)).toBe(text);
  });

  it('подчёркивание внутри слова — это имя, а не курсив', () => {
    // snake_case и файлы вроде id_ed25519 не должны разваливаться.
    expect(stripMarkdown('файл id_ed25519 и поле user_name_full'))
      .toBe('файл id_ed25519 и поле user_name_full');
  });

  it('умножение звёздочками с пробелами уцелеет', () => {
    expect(stripMarkdown('2 * 2 * 2 = 8')).toBe('2 * 2 * 2 = 8');
  });

  it('пустая строка и строка из пробелов', () => {
    expect(stripMarkdown('')).toBe('');
    expect(stripMarkdown('   ')).toBe('   ');
  });
});
