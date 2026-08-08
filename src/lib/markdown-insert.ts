/**
 * Toolbar formatting for the plain-textarea markdown composer. Pure functions:
 * (text, selection, format) → (text, selection) — fully unit-testable, the
 * component only applies the result and restores the selection.
 *
 * Contract (wrap-only; un-toggling a format is out of scope for this stage):
 *  - bold/italic: wrap the selection in ** / *; with no selection insert the
 *    marker pair and put the caret between them; the selection afterwards
 *    covers the original text (between the markers).
 *  - heading/ul/ol: line-prefix operations applied to EVERY line touched by
 *    the selection (or the caret's line); ol numbers sequentially; the
 *    selection afterwards covers the modified lines in full.
 *  - code: inline backticks for a selection without newlines; a fenced block
 *    on its own lines for a multiline (or empty) selection.
 *  - link: [sel](url) with the url placeholder selected; with no selection
 *    [текст](url) with the text placeholder selected.
 */

export type MarkdownFormat = 'bold' | 'italic' | 'heading' | 'ul' | 'ol' | 'code' | 'link';

export interface ApplyFormatResult {
  text: string;
  selStart: number;
  selEnd: number;
}

function wrap(text: string, selStart: number, selEnd: number, marker: string): ApplyFormatResult {
  const selected = text.slice(selStart, selEnd);
  const next = text.slice(0, selStart) + marker + selected + marker + text.slice(selEnd);
  return {
    text: next,
    selStart: selStart + marker.length,
    selEnd: selStart + marker.length + selected.length,
  };
}

function linePrefix(
  text: string,
  selStart: number,
  selEnd: number,
  prefixFor: (lineIndex: number) => string,
): ApplyFormatResult {
  const blockStart = text.lastIndexOf('\n', selStart - 1) + 1;
  const lineEndIdx = text.indexOf('\n', Math.max(selEnd, selStart));
  const blockEnd = lineEndIdx === -1 ? text.length : lineEndIdx;

  const block = text.slice(blockStart, blockEnd);
  const prefixed = block
    .split('\n')
    .map((line, i) => prefixFor(i) + line)
    .join('\n');

  const next = text.slice(0, blockStart) + prefixed + text.slice(blockEnd);
  return { text: next, selStart: blockStart, selEnd: blockStart + prefixed.length };
}

export function applyFormat(
  text: string,
  selStart: number,
  selEnd: number,
  format: MarkdownFormat,
): ApplyFormatResult {
  const selected = text.slice(selStart, selEnd);

  switch (format) {
    case 'bold':
      return wrap(text, selStart, selEnd, '**');
    case 'italic':
      return wrap(text, selStart, selEnd, '*');
    case 'heading':
      return linePrefix(text, selStart, selEnd, () => '## ');
    case 'ul':
      return linePrefix(text, selStart, selEnd, () => '- ');
    case 'ol':
      return linePrefix(text, selStart, selEnd, i => `${i + 1}. `);
    case 'code': {
      if (selected.length > 0 && !selected.includes('\n')) {
        return wrap(text, selStart, selEnd, '`');
      }
      // Fenced block on its own lines around the (possibly empty) selection.
      const needsLeadingNl = selStart > 0 && text[selStart - 1] !== '\n';
      const open = (needsLeadingNl ? '\n' : '') + '```\n';
      const needsTrailingNl = selEnd < text.length && text[selEnd] !== '\n';
      const close = '\n```' + (needsTrailingNl ? '\n' : '');
      const next = text.slice(0, selStart) + open + selected + close + text.slice(selEnd);
      const contentStart = selStart + open.length;
      return { text: next, selStart: contentStart, selEnd: contentStart + selected.length };
    }
    case 'link': {
      if (selected.length > 0) {
        const next = `${text.slice(0, selStart)}[${selected}](url)${text.slice(selEnd)}`;
        const urlStart = selStart + 1 + selected.length + 2; // "[sel](" → url
        return { text: next, selStart: urlStart, selEnd: urlStart + 3 };
      }
      const placeholder = 'текст';
      const next = `${text.slice(0, selStart)}[${placeholder}](url)${text.slice(selEnd)}`;
      return { text: next, selStart: selStart + 1, selEnd: selStart + 1 + placeholder.length };
    }
  }
}
