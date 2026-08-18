import { stripMarkdown } from './strip-markdown';

/**
 * The text a note IS, for searching and for showing search results.
 *
 * ONE function on purpose. The filter used to read `note.text` — the raw
 * markdown — while the card printed `stripMarkdown(note.text)`, and the two
 * corpora disagreed in both directions:
 *
 *   • a note rendering as «до важное» could not be found by typing «до
 *     важное», because the stored text says «до **важное**»;
 *   • a query matching only a link's URL, or a `**` marker, matched the note
 *     and then produced a card with nothing highlighted in it — a result the
 *     user cannot see the reason for.
 *
 * Filtering and highlighting must run over the same string, so they do.
 *
 * `fmt !== 'md'` is returned untouched: a plain note that literally contains
 * asterisks is not markdown and must stay findable by its own characters.
 */

/**
 * Stripping runs on every keystroke across every note. Notes are immutable in
 * the store — a new version is a new object — but the cache is validated
 * against the source text anyway, so a mutated note can never serve a stale
 * corpus.
 */
const cache = new WeakMap<object, { src: string; out: string }>();

export function noteSearchText(note: { text: string; fmt?: string }): string {
  if (note.fmt !== 'md') return note.text;

  const hit = cache.get(note);
  if (hit && hit.src === note.text) return hit.out;

  const out = stripMarkdown(note.text);
  cache.set(note, { src: note.text, out });
  return out;
}
