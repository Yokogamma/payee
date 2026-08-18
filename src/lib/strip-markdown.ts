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
 * THIS IS ALSO THE SEARCH CORPUS. `noteSearchText` filters on the same output
 * it displays, so the two can never disagree — see the note there. That raises
 * the bar on everything below: a marker stripped too eagerly does not merely
 * look odd, it makes real text unfindable.
 *
 * DELIBERATELY SHALLOW. This strips the markers a note actually carries and
 * does not parse markdown — no reference links, no HTML, no nested block
 * structure. What it does guarantee is that it never rewrites text the author
 * marked as LITERAL: code spans, fenced blocks and backslash escapes are
 * lifted out before any rule runs and put back afterwards, verbatim.
 */

/** Ordered: link/image syntax before emphasis, so `[**x**](url)` loses both. */
const RULES: Array<[RegExp, string]> = [
  // Images first — an image is `![alt](src)` and would otherwise leave a `!`.
  // The destination allows ONE level of nested parentheses: `[имя](/a_(b))`
  // used to stop at the inner `)` and leave a stray `)` in the text, which is
  // a shape real URLs (Wikipedia especially) genuinely have.
  [/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1'],
  [/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1'],
  // Bold, italic, strikethrough. `**` before `*` so the greedy pair does not
  // eat one half of a bold marker.
  //
  // EVERY emphasis rule demands a non-space next to the marker — `(?=\S)` after
  // the opener, `(?<=\S)` before the closer. Real markdown works that way
  // (left/right-flanking delimiter runs), and without it `2 * 2 * 2 = 8`
  // collapsed into `2  2  2 = 8`: the span between the asterisks matched. A
  // note is far more likely to contain arithmetic than the reverse.
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

/**
 * A byte no note contains and no rule above can match — not a letter, not a
 * marker, not a digit followed by `. `, so no line-prefix rule sees it either.
 */
const SENTINEL = '\u0000';
const RESTORE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

export function stripMarkdown(text: string): string {
  // Any real SENTINEL in the input would be indistinguishable from a marker
  // we placed, and restoring would then splice the wrong text back in.
  const kept: string[] = [];
  const keep = (literal: string) => `${SENTINEL}${kept.push(literal) - 1}${SENTINEL}`;

  let out = text
    .replace(new RegExp(SENTINEL, 'g'), '')
    // Fenced block: the fence goes, the code stays EXACTLY as written. The
    // closer has to repeat the opener's characters, so ` ``` ` inside a `~~~`
    // block does not end it.
    .replace(
      /^[ \t]{0,3}(```|~~~)[^\n]*\n([\s\S]*?)^[ \t]{0,3}\1[^\n]*(?:\n|$)/gm,
      (_m, _fence, body: string) => keep(body),
    )
    // An UNCLOSED fence runs to the end of the note — CommonMark says so, and
    // it has to be settled HERE, before code spans. Left to the span rule, the
    // three backticks of ` ```js ` were read as an empty ``…`` pair: the fence
    // half-vanished and its code was left unprotected. Nothing after this line
    // can still be an opener, so one pass is enough.
    .replace(/^[ \t]{0,3}(?:```|~~~)[^\n]*\n?([\s\S]*)/m, (_m, body: string) => keep(body))
    // Inline code span, longest-run-aware: ``a`b`` is one span, not two.
    .replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, body: string) => keep(body))
    // Backslash escape. The author wrote `\*` to MEAN an asterisk, so the
    // asterisk survives and the backslash does not — and neither reaches the
    // emphasis rules, which is the whole point.
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => keep(ch));

  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);

  return out.replace(RESTORE, (_m, i: string) => kept[Number(i)]);
}
