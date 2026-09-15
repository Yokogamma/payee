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

/**
 * `#/safebox`, or `#/notes/<id>` when a section addresses one of its items —
 * the only two shapes this app ever writes.
 */
export function canonicalHash(section: Section, param?: string | null): string {
  return param ? `#/${section}/${param}` : `#/${section}`;
}

/** The section segment and the rest, split on the FIRST slash. */
function split(hash: string): { name: string; param: string } {
  const rest = hash.replace(/^#\/?/, '');
  const slash = rest.indexOf('/');
  return slash === -1
    ? { name: rest, param: '' }
    : { name: rest.slice(0, slash), param: rest.slice(slash + 1) };
}

/**
 * Whitelist parse. Anything unknown — a typo, a deep link to a section this
 * build does not have yet, a hash left by a newer build after a rollback —
 * degrades to the default instead of rendering nothing.
 *
 * Only the FIRST segment is matched, so `#/notes/<id>` is still the notes
 * section. The old behaviour is unchanged for every shape that mattered
 * before: `#/safeboxes` and `#/note` are still not sections (the segment is
 * compared whole, not by prefix), and a missing slash is still tolerated.
 */
export function parseHash(hash: string): Section {
  const { name } = split(hash);
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : DEFAULT_SECTION;
}

/**
 * The item a section is addressing, or `null`.
 *
 * `null` when the SECTION is unknown, and that is the load-bearing half: were
 * it read off an unrecognised hash, `#/zzz/<id>` would degrade to the notes
 * section AND open a note — a junk address that does something. An empty
 * param (`#/notes/`) is `null` too, so the canonicaliser rewrites it away
 * rather than treating '' as an id.
 */
export function parseParam(hash: string): string | null {
  const { name, param } = split(hash);
  if (!(SECTIONS as readonly string[]).includes(name)) return null;
  return param === '' ? null : param;
}

/** A positive integer JavaScript can hold exactly.
 *
 *  BOTH halves are load-bearing. `'9'.repeat(30)` satisfies any «digits only»
 *  regex and comes back from `Number` as 1e30 — past `MAX_SAFE_INTEGER`, where
 *  arithmetic and comparison stop meaning what they say. A regex alone lets
 *  that through; `isSafeInteger` alone lets `2.0` and `'0x2'` through. */
function isOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The address of one version: `<root>/v/<n>`, or just `<root>` without one.
 *
 * `n` is the version's ORDINAL — 1 is the oldest, N the current — the same
 * numbering the history prints, so the address and the caption agree.
 *
 * WHY AN ORDINAL AND NOT THE VERSION'S ID. The v3 envelope keeps the chain
 * graph (`root`/`rev`/`prev`) INSIDE the ciphertext (see `crypto.ts`), and a
 * transaction carries only `Note-Id` and `Owner-Hash` (`arweave.ts`). The
 * network therefore does NOT reveal that two transactions belong to one note.
 * An address `<root>/v/<versionId>` would put exactly that link into browser
 * history, beside the chain root already disclosed there — a new class of
 * leak, not another instance of the accepted one. An ordinal cannot: it names
 * a POSITION, and a position links nothing on-chain.
 *
 * THE PRICE, stated so nobody «fixes» it back to an id: a position is only as
 * stable as the snapshot it was read from. A version arriving out of order (a
 * second device with a lagging clock) shifts the ordinals of everything newer
 * than itself. So the number means «the position in the snapshot available
 * when this address was RESOLVED», and it is resolved afresh on reload, on a
 * cold start, and on every new entry to the same address. `Main` pins the
 * version it resolved for as long as the page stays open, so the text under
 * the reader never changes; only the caption is recomputed.
 *
 * An out-of-range or malformed ordinal is NOT an error here — it degrades to
 * the chain itself and the canonicaliser rewrites the address, the same way
 * every other unknown shape in this file degrades to a default.
 */
export function noteTarget(root: string, ordinal?: number | null): string {
  return isOrdinal(ordinal) ? `${root}/v/${ordinal}` : root;
}

/** The chain and (optionally) the version an address names. `null` when there
 *  is no chain in it at all — an unknown section, a bare `#/notes`, or a
 *  param that starts with the separator. */
export function parseNoteTarget(hash: string): { root: string; ordinal: number | null } | null {
  const param = parseParam(hash);
  if (param === null) return null;
  const [root, marker, digits, ...extra] = param.split('/');
  if (root === '') return null;
  if (marker === undefined) return { root, ordinal: null };
  // Exactly three segments, and the middle one is exactly `v`. Anything else
  // — a longer path, an unknown marker, a missing number — is the chain.
  if (marker !== 'v' || digits === undefined || extra.length > 0) return { root, ordinal: null };
  // No leading zeros and no sign: `02` and `+2` would give two addresses for
  // one version, and the canonicaliser would have nothing to compare against.
  if (!/^[1-9][0-9]*$/.test(digits)) return { root, ordinal: null };
  const ordinal = Number(digits);
  return { root, ordinal: isOrdinal(ordinal) ? ordinal : null };
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
export function navigate(
  section: Section,
  opts: { replace?: boolean; param?: string | null } = {},
): void {
  const next = canonicalHash(section, opts.param);
  // Tapping the active section repeatedly must not build a history stack the
  // user then has to Back through.
  if (window.location.hash === next) return;
  const state: RouteHistoryState = { enSection: !opts.replace };
  if (opts.replace) window.history.replaceState(state, '', next);
  else window.history.pushState(state, '', next);
  emit();
}


/**
 * The raw hash and its parsed section together, from one subscription.
 *
 * Callers need both: the section to render, and the raw hash to notice that
 * `#/garbage` needs rewriting. Returning only the section would hide exactly
 * the transition the canonicaliser exists for.
 */
export function useRoute(): { hash: string; section: Section; param: string | null } {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { hash, section: parseHash(hash), param: parseParam(hash) };
}
