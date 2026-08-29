import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The ONLY markdown rendering surface (cards, previews, history). Security
 * posture per .claude/claude-security-guidance.md:
 *  - React element tree only — never dangerouslySetInnerHTML;
 *  - skipHtml: raw HTML in the note text is dropped, not parsed;
 *  - element allowlist (unwrapDisallowed keeps the TEXT of anything else);
 *  - URLs: EXPLICIT http(s) only — javascript:, data:, vbscript:, control
 *    characters in the scheme, protocol-relative (//host) and relative URLs
 *    are all stripped;
 *  - images are never fetched (CSP img-src stays 'self' data:) — an image
 *    renders as a safe link chip instead.
 *
 * The one rehype plugin below is layout, not policy: it removes the newline
 * text nodes `mdast-util-to-hast` synthesizes between block children. It never
 * adds, rewrites or unwraps an element, so it cannot widen anything above.
 */

const ALLOWED_ELEMENTS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del',
  'ul', 'ol', 'li',
  'code', 'pre',
  'blockquote', 'a', 'hr', 'br', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'input', // GFM task-list checkboxes (rendered disabled below)
];

/** Explicit http(s) only, on top of react-markdown's default sanitizer.
 *  defaultUrlTransform already strips javascript:/data:/vbscript: (incl. case
 *  and control-char tricks) but allows relative and protocol-relative URLs —
 *  meaningless (or origin-confusing) inside a notes app, so they go too. */
function httpOnly(url: string): string {
  const sanitized = defaultUrlTransform(url);
  if (/^https?:\/\//i.test(sanitized)) return sanitized;
  return '';
}

/**
 * Block containers whose children `mdast-util-to-hast` separates with
 * synthesized newline text nodes. `.note-text` renders markdown under
 * `white-space: pre-wrap` (it has to: the plain-text and search paths in the
 * same box carry real newlines), so every one of those separators printed as a
 * REAL blank line. Four constructs were disfigured by it:
 *
 *   - a list written with blank lines between items: three empty lines per item
 *     (one after `<li>`, one before `</li>`, one between items);
 *   - any list: one empty line between items;
 *   - a blockquote: an empty line above and below its paragraph;
 *   - a GFM table: `\n` inside `<tr>`, which a preserving `white-space` wraps
 *     into an anonymous table cell instead of discarding;
 *   - a HARD line break: `to-hast` emits `<br>` FOLLOWED by a `"\n"`, so the
 *     break printed doubled.
 *
 * `p` is in the set for that last one; `td`/`th`/`code`/`pre` deliberately are
 * not — whitespace between phrasing content there is the author's.
 *
 * Inline elements are in the set ONLY because a hard break can sit inside one.
 * That is safe because of condition 3 below: a space the author typed between
 * `**foo**` and `*bar*` carries a source position and is never touched.
 */
const BLOCK_CONTAINERS = new Set([
  'p', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl',
  // A hard break inside emphasis or a link carries the same trailing "\n", and
  // so does one in a setext heading — measured, not assumed.
  'strong', 'em', 'del', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // GFM footnotes. `section` is NOT in ALLOWED_ELEMENTS, so `unwrapDisallowed`
  // lifts its children into the root — AFTER this plugin has run. Its two
  // separators would arrive in the body as real blank lines.
  'section',
]);

/** The shape this plugin needs. Declared locally rather than imported from
 *  `@types/hast`, which is only a transitive dependency here. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  position?: unknown;
  children?: HastNode[];
}

/**
 * A separator is only removable when ALL FOUR hold, and each condition earns
 * its place — measured on the real tree, not assumed:
 *
 *   parent            position   value   verdict
 *   ------            --------   -----   -------
 *   ul (between li)   absent     "\n"    remove
 *   p (after <br>)    absent     "\n"    remove
 *   li in `- **a** *b*`  PRESENT  " "    KEEP — else the words fuse into «ab»
 *   li in a task item    absent   " "    KEEP — else the box abuts its label
 *
 * Dropping on `!position` alone breaks task lists; dropping on «whitespace
 * only» alone fuses inline emphasis. Both failures are silent.
 */
function isStructuralWhitespace(node: HastNode): boolean {
  return node.type === 'text'
    && node.position === undefined
    && typeof node.value === 'string'
    && node.value.includes('\n')
    && /^\s*$/.test(node.value);
}

/** Rehype plugin: drop the separators described above. No new dependency —
 *  the walk is short enough to own, and it keeps `white-space` untouched, so
 *  the plain-text, search and version-history paths are unaffected BY
 *  CONSTRUCTION rather than by argument. */
function stripStructuralWhitespace() {
  return function transform(tree: HastNode): void {
    const isContainer = tree.type === 'root'
      || (tree.type === 'element' && tree.tagName !== undefined && BLOCK_CONTAINERS.has(tree.tagName));
    if (isContainer && tree.children) {
      tree.children = tree.children.filter(child => !isStructuralWhitespace(child));
    }
    for (const child of tree.children ?? []) transform(child);
  };
}

const components: Components = {
  a: ({ href, children }) =>
    href
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>, // stripped URL → plain text, not a dead link
  // Never load the resource: CSP blocks remote images anyway, and even a
  // same-origin probe would leak note content timing. A chip link instead —
  // created OUTSIDE the custom `a` renderer, so it carries its own rel/target
  // and the same URL policy (href already passed through urlTransform).
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? src : '';
    const label = `${alt || 'изображение'}`;
    return href
      ? <a className="md-img-chip" href={href} target="_blank" rel="noopener noreferrer">{label}</a>
      : <span className="md-img-chip">{label}</span>;
  },
  input: ({ checked }) => (
    <input type="checkbox" disabled checked={Boolean(checked)} readOnly />
  ),
};

/**
 * Feed-preview variant: nothing inside is focusable or clickable.
 *
 * The preview sits UNDER the card's stretched open button, so a link there is
 * unreachable by pointer while staying in the tab order and in the
 * accessibility tree — pointer and keyboard would disagree about what the card
 * contains. Rendering links and image chips as plain spans keeps a card at
 * exactly two tab stops: open, and the ⋯ menu. (The GFM checkboxes are already
 * `disabled`, so they are not focusable either way.)
 */
const previewComponents: Components = {
  ...components,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span className="md-img-chip">{alt || 'изображение'}</span>,
};

export const NoteMarkdown = memo(function NoteMarkdown(
  { text, preview = false }: { text: string; preview?: boolean },
) {
  return (
    <div className="note-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[stripStructuralWhitespace]}
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        urlTransform={httpOnly}
        components={preview ? previewComponents : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
