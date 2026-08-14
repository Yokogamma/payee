/**
 * Section routing over `location.hash`. No dependency, ~40 lines.
 *
 * WHY A HASH, NOT A PATH.
 * - Costs nothing at the server and is inert to the PWA's `navigateFallback`.
 * - Works identically under both `VITE_BASE` values (GitHub Pages `/payee/`
 *   and Cloudflare Pages `/`).
 * - Compatible in BOTH directions across the prompt-gated update tail: an old
 *   build simply ignores a hash it does not know, and a new build must cope
 *   with the empty hash an old build left behind. A pathname router would turn
 *   a rollback into a 404.
 *
 * WHY A RAW-HASH SNAPSHOT.
 * `useSyncExternalStore` compares snapshots by value. If the snapshot were the
 * PARSED section, `#/notes → #/garbage` would produce the same snapshot
 * (`'notes'` both times), React would skip the render, and the canonicalising
 * effect would never run — the junk hash would sit in the address bar forever.
 * The raw hash always changes, so the subscriber always hears about it.
 *
 * WHY `<button>` FOR NAV, NOT `<a href="#/x">`.
 * An anchor lets the browser push the entry itself, creating a second write
 * path (and a double notification). One writer, one emit.
 */

import { useSyncExternalStore } from 'react';

export const SECTIONS = ['notes', 'safebox', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];
export const DEFAULT_SECTION: Section = 'notes';

/** `#/safebox` — the only shape this app ever writes. */
export function canonicalHash(section: Section): string {
  return `#/${section}`;
}

/**
 * Whitelist parse. Anything unknown — a typo, a deep link to a section this
 * build does not have yet, a hash left by a newer build after a rollback —
 * degrades to the default instead of rendering nothing.
 */
export function parseHash(hash: string): Section {
  const name = hash.replace(/^#\/?/, '');
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : DEFAULT_SECTION;
}

/**
 * Marker on history entries THIS APP pushed.
 *
 * Nothing reads it yet; it is written from the start so that entries created
 * before the reader ships are still marked. Updates here are prompt-gated, so
 * a user can be sitting on entries pushed by an older build for days, and a
 * "did we create this entry?" question that answers `undefined` for half of
 * them is worse than useless.
 */
export interface RouteHistoryState {
  enSection: boolean;
}

const listeners = new Set<() => void>();
let attached = 0;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (attached++ === 0) {
    // `hashchange` covers manual edits and anchor navigation; `popstate`
    // covers Back/Forward over entries we pushed. Both are needed — neither
    // fires for every case on its own.
    window.addEventListener('hashchange', emit);
    window.addEventListener('popstate', emit);
  }
  return () => {
    listeners.delete(listener);
    if (--attached === 0) {
      window.removeEventListener('hashchange', emit);
      window.removeEventListener('popstate', emit);
    }
  };
}

const getSnapshot = (): string => window.location.hash;
/** SSR/hydration only; this app never server-renders. */
const getServerSnapshot = (): string => '';

/**
 * Move to a section.
 *
 * `pushState` does NOT fire `hashchange`, so the emit is manual — that is the
 * whole reason this must be the single write path.
 */
export function navigate(section: Section, opts: { replace?: boolean } = {}): void {
  const next = canonicalHash(section);
  // Tapping the active section repeatedly must not build a history stack the
  // user then has to Back through.
  if (window.location.hash === next) return;
  const state: RouteHistoryState = { enSection: !opts.replace };
  if (opts.replace) window.history.replaceState(state, '', next);
  else window.history.pushState(state, '', next);
  emit();
}

/**
 * Leave a section that behaves like an overlay (settings), returning the user
 * where they actually came from.
 *
 * An unconditional `navigate(fallback, {replace:true})` would look right and
 * quietly break Back: after `notes → settings`, replacing leaves the stack as
 * `notes → notes`, so the next system Back appears to do nothing.
 *
 * So: if THIS app pushed the current entry, step back over it — which also
 * returns to the previous SECTION (came from the safebox, land in the safebox)
 * rather than always dumping the user in notes. If the entry is not ours — a
 * deep link or a reload straight onto `#/settings` — there is nothing behind
 * it and `back()` would leave the app entirely, so replace instead.
 *
 * Known edge, accepted: if the user reached settings by pressing system Back
 * (over an entry we pushed earlier), the marker still says "ours" and `back()`
 * moves somewhere other than where they opened it from. Rare enough not to
 * warrant synthetic history entries.
 */
export function leaveSection(fallback: Section = DEFAULT_SECTION): void {
  const state = window.history.state as RouteHistoryState | null;
  if (state?.enSection) window.history.back();
  else navigate(fallback, { replace: true });
}

/**
 * The raw hash and its parsed section together, from one subscription.
 *
 * Callers need both: the section to render, and the raw hash to notice that
 * `#/garbage` needs rewriting. Returning only the section would hide exactly
 * the transition the canonicaliser exists for.
 */
export function useRoute(): { hash: string; section: Section } {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { hash, section: parseHash(hash) };
}
