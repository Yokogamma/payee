/**
 * Shared parser/validator for the Arweave gateway configuration (D8).
 *
 * Pure and env-free so BOTH the Vite build (Node) and the client runtime import
 * the exact same validation — the same reason `trusted-owners.ts` exists. A
 * plain-JS mirror (`scripts/gateways-parse.mjs`) serves the operator/CI scripts
 * that run outside the TS toolchain; a parity test holds the two together.
 *
 * ── Why two different dedup keys (D8, review 2 H5) ──────────────────────────
 *
 * `STATUS`/`PAYLOAD` entries are BARE ORIGINS and dedup by origin: a duplicated
 * origin in the CSV must not manufacture a second "independent" vote for the
 * dead-quorum (§4.PR-3a). Index entries are FULL URLs and dedup by the WHOLE
 * URL: an index endpoint carries a path, and two distinct endpoints can share
 * one origin (the approved Goldsky search is `origin + /graphql`), so an
 * origin-keyed dedup would silently throw one of them away.
 */

/** Groups are separated by `,`; transport-fallbacks INSIDE a group by `|`. */
const GROUP_SEPARATOR = ',';
const FALLBACK_SEPARATOR = '|';

/**
 * A bare https origin, or null when the value cannot be one.
 *
 * REJECTS rather than strips: a path, query or fragment in an origin slot means
 * the operator meant something else, and `new URL(...).origin` would discard it
 * silently — producing requests to a URL nobody configured. Credentials are
 * rejected for the same reason they are in `PROXY_URL` (arweave.ts) — they would
 * leak into every request this list drives.
 */
export function canonicalOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // `new URL('https://a.b')` and `.../` both normalize to pathname '/'.
  if (url.pathname !== '/') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/**
 * A full https index URL, or null.
 *
 * The path IS significant here (that is the whole point of D8), and so is the
 * query — an index endpoint may legitimately carry one. The fragment is dropped:
 * it never reaches the server, so keeping it would only split the dedup key for
 * two URLs that are the same request.
 */
export function canonicalIndexUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  url.hash = '';
  return url.href;
}

/**
 * Parse a comma-separated ORIGIN list, deduplicated by origin, order preserved.
 *
 * Order is normative for `PAYLOAD_GATEWAYS` (§2.1: the fallback order is the
 * approved one) and irrelevant for `STATUS_GATEWAYS` (probed in parallel), so
 * the parser preserves it and lets each caller decide what it means.
 *
 * Unparseable entries are DROPPED, not fatal: an empty result is the caller's
 * signal to fall back to the built-in default, and a hard throw here would take
 * the whole app down for a stray comma in an env var.
 */
export function parseOriginList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? '').split(GROUP_SEPARATOR)) {
    if (part.trim() === '') continue;
    const origin = canonicalOrigin(part);
    if (origin === null || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/**
 * Parse LOGICAL index sources: `a|a-fallback,b` → `[[a, a-fallback], [b]]`.
 *
 * Dedup is GLOBAL across groups (review 2 H5): one URL cannot belong to two
 * logical sources, because completeness in PR-4 is counted per group and the
 * same endpoint answering twice would make one group look independently alive.
 * Two endpoints sharing an origin stay separate — they are different URLs.
 *
 * A group left empty by dedup/validation is dropped entirely rather than kept
 * as `[]`, so callers never have to defend against a source with no transport.
 */
export function parseIndexSources(raw: string): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const group of String(raw ?? '').split(GROUP_SEPARATOR)) {
    if (group.trim() === '') continue;
    const urls: string[] = [];
    for (const part of group.split(FALLBACK_SEPARATOR)) {
      if (part.trim() === '') continue;
      const url = canonicalIndexUrl(part);
      if (url === null || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    if (urls.length > 0) out.push(urls);
  }
  return out;
}

/**
 * Canonical serialization of a status-gateway set, for the `/health` attestation
 * hash (Р28). SORTED, because the status order is NOT normative — the operator
 * reordering `wrangler.toml` must not change the hash the smoke compares.
 *
 * The exact bytes matter: this string is hashed on the Worker and re-hashed by
 * the deploy smoke from `wrangler.toml`, and the two must agree byte for byte.
 */
export function serializeStatusOrigins(origins: readonly string[]): string {
  return JSON.stringify([...origins].sort());
}
