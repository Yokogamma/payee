import { describe, it, expect } from 'vitest';
import { noteSearchText } from './note-search-text';

const md = (text: string) => ({ text, fmt: 'md' });
const plain = (text: string) => ({ text, fmt: 'plain' });

/** What the store's filter does, expressed once so the tests below can't drift. */
const matches = (note: { text: string; fmt?: string }, query: string) =>
  noteSearchText(note).toLowerCase().includes(query.trim().toLowerCase());

describe('noteSearchText — фильтр и подсветка ищут в одной строке', () => {
  it('находит по тому, что видно, а не по исходнику', () => {
    // Карточка показывает «до важное»; ровно это пользователь и печатает.
    const note = md('до **важное** после');
    expect(matches(note, 'до важное')).toBe(true);
  });

  it('не находит по разметке, которой на экране нет', () => {
    // Совпадение по `**` дало бы карточку без единого видимого совпадения.
    expect(matches(md('до **важное**'), '**')).toBe(false);
  });

  it('не находит по адресу ссылки — он не показан', () => {
    const note = md('см. [документацию](https://example.invalid/secret-path)');
    expect(matches(note, 'secret-path')).toBe(false);
    expect(matches(note, 'документацию')).toBe(true);
  });

  it('обычная заметка ищется по своим буквальным звёздочкам', () => {
    expect(matches(plain('*звёзды* литеральны'), '*звёзды*')).toBe(true);
  });

  it('заметка без fmt считается обычной', () => {
    expect(noteSearchText({ text: '**как есть**' })).toBe('**как есть**');
  });
});

describe('noteSearchText — кэш', () => {
  it('повторный вызов даёт тот же результат', () => {
    const note = md('# Заголовок');
    expect(noteSearchText(note)).toBe('Заголовок');
    expect(noteSearchText(note)).toBe('Заголовок');
  });

  it('изменившийся текст не отдаётся из кэша', () => {
    // Заметки в сторе неизменяемы, но кэш не должен на это полагаться.
    const note = md('**первый**');
    expect(noteSearchText(note)).toBe('первый');
    note.text = '**второй**';
    expect(noteSearchText(note)).toBe('второй');
  });
});
