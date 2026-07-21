/**
 * Validate VITE_PROXY_URL and return the origin to pin in the CSP connect-src.
 *
 * Rules (fail the build, never degrade):
 *  - the URL must parse; empty/garbage throws;
 *  - non-localhost MUST be https;
 *  - http://localhost is a DEV-ONLY convenience: in CI/production builds it
 *    throws too (a mistyped production secret like http://localhost:8787 would
 *    otherwise pass the build and ship a client that cannot reach its proxy),
 *    unless explicitly opted in via allowHttp (ALLOW_HTTP_PROXY=1).
 */
export function resolveProxyOrigin(rawProxy, { ci = false, allowHttp = false } = {}) {
  const u = new URL(rawProxy); // throws on empty/invalid
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:') {
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
