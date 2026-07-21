/**
 * Validate VITE_PROXY_URL and return the origin to pin in the CSP connect-src.
 *
 * The value must be a BARE ORIGIN — the client concatenates paths onto it and
 * the CSP pins only the origin, so credentials/path/query/hash would pass the
 * build yet break at runtime (`https://p.example/x` → `/x/upload` ≠ CSP origin).
 *
 * Rules (fail the build, never degrade):
 *  - the URL must parse; empty/garbage throws;
 *  - protocol allowlist: https:, or http: for localhost only (ftp:// etc. throw);
 *  - no embedded credentials, no path (beyond '/'), no query, no hash;
 *  - http://localhost is a DEV-ONLY convenience: in CI/production builds it
 *    throws too (a mistyped production secret like http://localhost:8787 must
 *    not ship a client that cannot reach its proxy), unless explicitly opted
 *    in via allowHttp (ALLOW_HTTP_PROXY=1).
 */
export function resolveProxyOrigin(rawProxy, { ci = false, allowHttp = false } = {}) {
  const u = new URL(rawProxy); // throws on empty/invalid

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`proxy protocol must be https (got ${u.protocol})`);
  }
  if (u.username || u.password) {
    throw new Error('proxy URL must not contain credentials');
  }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error('proxy URL must be a bare origin (no path/query/hash)');
  }

  if (u.protocol === 'http:') {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!local) throw new Error('a non-localhost proxy origin must use https');
    if (ci && !allowHttp) {
      throw new Error(
        'an http://localhost proxy is not allowed in CI/production builds ' +
        '(set ALLOW_HTTP_PROXY=1 only for a deliberate non-production build)',
      );
    }
  }
  return u.origin;
}
