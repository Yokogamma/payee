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

export const NoteMarkdown = memo(function NoteMarkdown({ text }: { text: string }) {
  return (
    <div className="note-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        urlTransform={httpOnly}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
