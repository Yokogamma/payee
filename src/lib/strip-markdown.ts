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
 * reads as the app breaking rather than as a rendering mode. The decision to
 * highlight plain text was sound; showing the syntax was never part of it.
 *
 * DELIBERATELY SHALLOW. This strips the markers a note actually carries and
 * does not attempt to parse markdown — no nesting rules, no reference links,
 * no HTML. It runs only on notes already stored as `fmt: 'md'`, so a plain
 * note that literally contains asterisks is never touched, and the worst case
 * for an exotic construct is that a stray character survives into a search
 * result. That is a far smaller failure than the one it replaces.
 */

/** Ordered: link/image syntax before emphasis, so `[**x**](url)` loses both. */
const RULES: Array<[RegExp, string]> = [
  // Images first — an image is `![alt](src)` and would otherwise leave a `!`.
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // Fenced blocks: drop the fence lines, keep the code.
  [/^```[^\n]*\n?/gm, ''],
  [/^~~~[^\n]*\n?/gm, ''],
  // Inline code, bold, italic, strikethrough. `**` before `*` so the greedy
  // pair does not eat one half of a bold marker.
  //
  // EVERY emphasis rule demands a non-space next to the marker — `(?=\S)` after
  // the opener, `(?<=\S)` before the closer. Real markdown works that way
  // (left/right-flanking delimiter runs), and without it `2 * 2 * 2 = 8`
  // collapsed into `2  2  2 = 8`: the span between the asterisks matched. A
  // note is far more likely to contain arithmetic than the reverse.
  [/`([^`]+)`/g, '$1'],
  [/\*\*(?=\S)([^*]*?)(?<=\S)\*\*/g, '$1'],
  [/__(?=\S)([^_]*?)(?<=\S)__/g, '$1'],
  [/\*(?=\S)([^*\n]*?)(?<=\S)\*/g, '$1'],
  [/(?<![A-Za-zА-Яа-яЁё0-9])_(?=\S)([^_\n]*?)(?<=\S)_(?![A-Za-zА-Яа-яЁё0-9])/g, '$1'],
  [/~~(?=\S)([^~]*?)(?<=\S)~~/g, '$1'],
  // Line prefixes: heading, quote, bullet, ordered item.
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}[-*+]\s+/gm, ''],
  [/^\s{0,3}\d+\.\s+/gm, ''],
  // A horizontal rule leaves nothing to read.
  [/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, ''],
];

export function stripMarkdown(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
