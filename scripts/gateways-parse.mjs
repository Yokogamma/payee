/**
 * Plain-JS mirror of src/lib/gateways-parse.ts for operator/CI scripts that run
 * OUTSIDE the Vite/TS toolchain (postbuild CSP, deploy config gate, the
 * client↔Worker gateway check). Kept behavior-identical on purpose; the parity
 * test (gateways-parse.test.mjs) holds the two together — if they ever diverge,
 * a value could pass one gate and fail another.
 */

const GROUP_SEPARATOR = ',';
const FALLBACK_SEPARATOR = '|';

/** Bare https origin, or null. REJECTS a path/query/fragment/credentials
 *  instead of stripping them — see the TS original for why. */
export function canonicalOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/') return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

/** Full https index URL: path and query significant, fragment dropped. */
export function canonicalIndexUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  url.hash = '';
  return url.href;
}

/** Comma-separated origin list, deduplicated by origin, order preserved. */
export function parseOriginList(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw ?? '').split(GROUP_SEPARATOR)) {
    if (part.trim() === '') continue;
    const origin = canonicalOrigin(part);
    if (origin === null || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/** Logical index sources; dedup by full URL GLOBALLY across groups. */
export function parseIndexSources(raw) {
  const out = [];
  const seen = new Set();
  for (const group of String(raw ?? '').split(GROUP_SEPARATOR)) {
    if (group.trim() === '') continue;
    const urls = [];
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

/** Canonical, SORTED serialization for the /health attestation hash. */
export function serializeStatusOrigins(origins) {
  return JSON.stringify([...origins].sort());
}

/**
 * Every origin the CSP must allow, given the three configured lists.
 *
 * Index entries contribute their ORIGIN only — `connect-src` is origin-scoped,
 * and the path that makes an index endpoint distinct is irrelevant to it.
 * The result is deduplicated and sorted so the generated header is stable
 * across builds (a reordered env var must not produce a different artifact).
 */
export function cspConnectOrigins({ status, payload, indexSources }) {
  const origins = new Set();
  for (const origin of parseOriginList(status)) origins.add(origin);
  for (const origin of parseOriginList(payload)) origins.add(origin);
  for (const group of parseIndexSources(indexSources)) {
    for (const url of group) {
      try {
        origins.add(new URL(url).origin);
      } catch {
        // unreachable: parseIndexSources already validated it
      }
    }
  }
  return [...origins].sort();
}
