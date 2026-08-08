import { describe, it, expect } from 'vitest';
import { applyFormat } from './markdown-insert';

// The toolbar contract: exact output text AND selection for every format ×
// (no selection / word selection / multiline selection).

describe('bold / italic (wrap)', () => {
  it('bold with no selection: marker pair, caret between', () => {
    const r = applyFormat('привет ', 7, 7, 'bold');
    expect(r.text).toBe('привет ****');
    expect(r.selStart).toBe(9);
    expect(r.selEnd).toBe(9);
  });

  it('bold with a word selected: wraps, selection covers the original word', () => {
    const r = applyFormat('привет мир', 7, 10, 'bold');
    expect(r.text).toBe('привет **мир**');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('мир');
  });

  it('italic wraps with single asterisks', () => {
    const r = applyFormat('слово', 0, 5, 'italic');
    expect(r.text).toBe('*слово*');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('слово');
  });
});

describe('heading / lists (line prefix)', () => {
  it('heading on the caret line only', () => {
    const r = applyFormat('один\nдва\nтри', 6, 6, 'heading'); // caret inside «два»
    expect(r.text).toBe('один\n## два\nтри');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('## два');
  });

  it('heading across a multiline selection prefixes EVERY touched line', () => {
    const r = applyFormat('один\nдва\nтри', 2, 10, 'heading');
    expect(r.text).toBe('## один\n## два\n## три');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('## один\n## два\n## три');
  });

  it('ul prefixes each selected line with a dash', () => {
    const r = applyFormat('яблоко\nгруша', 0, 12, 'ul');
    expect(r.text).toBe('- яблоко\n- груша');
  });

  it('ol numbers lines sequentially', () => {
    const r = applyFormat('первый\nвторой\nтретий', 0, 20, 'ol');
    expect(r.text).toBe('1. первый\n2. второй\n3. третий');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe(r.text);
  });
});

describe('code', () => {
  it('inline for a selection without newlines', () => {
    const r = applyFormat('вызови fn тут', 7, 9, 'code');
    expect(r.text).toBe('вызови `fn` тут');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('fn');
  });

  it('fenced block for a multiline selection, on its own lines', () => {
    const r = applyFormat('до\nconst a = 1;\nconst b = 2;\nпосле', 3, 28, 'code');
    expect(r.text).toBe('до\n```\nconst a = 1;\nconst b = 2;\n```\nпосле');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('const a = 1;\nconst b = 2;');
  });

  it('fenced block for an EMPTY selection: caret lands inside the fence', () => {
    const r = applyFormat('текст\n', 6, 6, 'code');
    expect(r.text).toBe('текст\n```\n\n```');
    expect(r.selStart).toBe(r.selEnd);
    expect(r.text.slice(0, r.selStart)).toBe('текст\n```\n');
  });
});

describe('link', () => {
  it('with a selection: [sel](url), the url placeholder selected', () => {
    const r = applyFormat('см. документацию', 4, 16, 'link');
    expect(r.text).toBe('см. [документацию](url)');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('url');
  });

  it('without a selection: placeholder text selected for typing over', () => {
    const r = applyFormat('', 0, 0, 'link');
    expect(r.text).toBe('[текст](url)');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('текст');
  });
});

describe('edge cases', () => {
  it('operations at the very start and end of the text', () => {
    expect(applyFormat('', 0, 0, 'bold').text).toBe('****');
    expect(applyFormat('край', 0, 4, 'heading').text).toBe('## край');
  });

  it('heading on the first line when selection starts at 0', () => {
    const r = applyFormat('первая\nвторая', 0, 3, 'heading');
    expect(r.text).toBe('## первая\nвторая');
  });
});
