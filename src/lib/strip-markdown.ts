import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes, Parents } from 'mdast';

/**
 * Markdown source → the text a reader sees.
 *
 * WHY THIS EXISTS. The feed renders a markdown note through `NoteMarkdown`,
 * except while a search query is active: highlighting matches means wrapping
 * them in `<mark>`, and injecting that into react-markdown's element tree is
 * fragile enough that the feed deliberately falls back to plain text with
 * highlights instead.
 *
 * The fallback printed the SOURCE. Typing a query turned
 *
 *     Первая мадаун **заметка** *версия 2*
 *
 * into exactly that, asterisks and all — reported from a real phone, and it
 * reads as the app breaking rather than as a rendering mode.
 *
 * THIS IS ALSO THE SEARCH CORPUS. `noteSearchText` filters on the same string
 * it displays, so the two can never disagree.
 *
 * WHY THE REAL PARSER. This was a list of regexes, and a regex list cannot be
 * made to agree with a parser — it can only be made to agree with the examples
 * someone thought to write down. Reference links kept their `[text][ref]`
 * brackets AND leaked the definition's URL into the corpus (the very bug the
 * corpus was unified to fix); GFM task lists showed `[x]`; GFM tables came
 * through with every pipe and dash; and a four-backtick fence — the form
 * people use precisely because their code contains three — was closed early by
 * the inner fence, so the literal text it was protecting got stripped after
 * all.
 *
 * So the corpus is built from the SAME parse as the display: `remark-parse`
 * plus `remark-gfm`, which is exactly what `NoteMarkdown` hands to
 * react-markdown. Both are already in the bundle for the renderer, so this
 * costs the walker below and nothing else. When the two must agree, sharing
 * the parser is the only way to keep it true.
 */

const processor = unified().use(remarkParse).use(remarkGfm);

/** Block nodes read as separate lines; inline nodes run together. */
const SEPARATOR: Record<string, string> = {
  root: '\n',
  blockquote: '\n',
  list: '\n',
  listItem: '\n',
  footnoteDefinition: '\n',
  table: '\n',
  // A row is one line, its cells separated like words.
  tableRow: ' ',
};

function childrenText(node: Parents): string {
  const sep = SEPARATOR[node.type] ?? '';
  return node.children
    .map(child => nodeText(child))
    .filter(part => part !== '')
    .join(sep);
}

function nodeText(node: Nodes): string {
  switch (node.type) {
    case 'text':
      return node.value;

    // Code keeps its content EXACTLY — this is the guarantee the old regex
    // version could not hold. `inlineCode` and `code` are both rendered
    // verbatim by NoteMarkdown, markers and all.
    case 'inlineCode':
    case 'code':
      return node.value;

    // `skipHtml` on the renderer: raw HTML is dropped, never parsed.
    case 'html':
      return '';

    // A link definition (`[ref]: https://…`) renders NOTHING. It used to
    // survive into the corpus and made the URL searchable — the exact defect
    // that unifying the corpus was meant to remove.
    case 'definition':
      return '';

    case 'break':
      return '\n';

    case 'thematicBreak':
      return '';

    // NoteMarkdown never loads an image; it draws a chip labelled with the alt
    // text, falling back to «изображение». The corpus says what the chip says.
    case 'image':
    case 'imageReference':
      return node.alt || 'изображение';

    // A GFM task checkbox is an <input>. There is no text in it, and `[x]`
    // was never on screen.
    case 'listItem':
      return childrenText(node);

    default:
      return 'children' in node ? childrenText(node) : '';
  }
}

export function stripMarkdown(text: string): string {
  return childrenText(processor.parse(text));
}
