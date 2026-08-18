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
    // Разделитель не оставляет за собой пустой строки: на карточке его нет.
    expect(stripMarkdown('текст\n---\nещё')).toBe('текст\nещё');
  });

  it('ограждённый блок кода теряет забор, но не содержимое', () => {
    expect(stripMarkdown('```js\nconst x = 1;\n```')).toBe('const x = 1;');
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

describe('stripMarkdown — буквальный текст неприкосновенен', () => {
  it('внутри code span разметка НЕ обрабатывается', () => {
    // Заметка, объясняющая markdown, — самый обычный случай.
    expect(stripMarkdown('пиши `*literal*` для курсива')).toBe('пиши *literal* для курсива');
  });

  it('внутри ограждённого блока — тоже', () => {
    expect(stripMarkdown('```\n**literal**\n```')).toBe('**literal**');
  });

  it('закрывающий забор должен совпадать с открывающим', () => {
    // ``` внутри ~~~ не закрывает блок.
    expect(stripMarkdown('~~~\n```\n**x**\n~~~')).toBe('```\n**x**');
  });

  it('забор из четырёх кавычек не закрывается внутренним из трёх', () => {
    // Ровно для этого его и пишут длиннее. Regex-версия закрывала блок на
    // внутреннем заборе, и защищаемый им **x** всё-таки снимался.
    expect(stripMarkdown('````\n```\n**x**\n```\n````')).toBe('```\n**x**\n```');
  });

  it('двойные обратные кавычки — один span, а не два', () => {
    expect(stripMarkdown('``a`b`` конец')).toBe('a`b конец');
  });

  it('экранированная звёздочка остаётся звёздочкой без обратного слэша', () => {
    expect(stripMarkdown('\\*literal\\*')).toBe('*literal*');
  });

  it('экранированное подчёркивание не разваливает слово', () => {
    expect(stripMarkdown('snake\\_case')).toBe('snake_case');
  });

  it('скобки в адресе ссылки не оставляют хвоста', () => {
    expect(stripMarkdown('[видимый](https://ru.wikipedia.org/wiki/Ключ_(значения))'))
      .toBe('видимый');
  });

  it('незакрытый забор всё же убирается', () => {
    expect(stripMarkdown('```js\nconst x = 1;')).toBe('const x = 1;');
  });
});

// Всё в этом блоке regex-версия не умела, и каждый пункт был виден на карточке
// либо, хуже того, попадал в корпус поиска как текст, которого на экране нет.
describe('stripMarkdown — GFM и то, что достаётся только парсером', () => {
  it('reference link: скобки уходят, адрес в корпус не попадает', () => {
    const note = 'см. [документацию][doc] тут\n\n[doc]: https://example.invalid/secret';
    expect(stripMarkdown(note)).toBe('см. документацию тут');
  });

  it('reference image берёт подпись, как и чип на карточке', () => {
    expect(stripMarkdown('![схема][s]\n\n[s]: https://example.invalid/i.png')).toBe('схема');
  });

  it('картинка без подписи называется так же, как чип', () => {
    // NoteMarkdown рисует «изображение», когда alt пуст.
    expect(stripMarkdown('![](https://example.invalid/i.png)')).toBe('изображение');
  });

  it('чек-лист не показывает [x] и [ ]', () => {
    expect(stripMarkdown('- [x] куплено\n- [ ] нет')).toBe('куплено\nнет');
  });

  it('таблица теряет трубы и разделители, но не ячейки', () => {
    const table = '| имя | цена |\n| --- | --- |\n| хлеб | 50 |';
    expect(stripMarkdown(table)).toBe('имя цена\nхлеб 50');
  });

  it('сырой HTML не попадает в корпус — он и не рисуется', () => {
    // NoteMarkdown идёт со skipHtml.
    expect(stripMarkdown('текст <b>жирный</b> дальше')).toBe('текст жирный дальше');
  });

  it('автоссылка GFM оставляет только видимый адрес', () => {
    expect(stripMarkdown('пиши на https://example.invalid/x')).toBe('пиши на https://example.invalid/x');
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
    // Заметка из одних пробелов не рисует ничего — корпус тоже пуст.
    expect(stripMarkdown('   ')).toBe('');
  });
});
