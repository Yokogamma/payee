// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Post-deploy smoke: does the LIVE `connect-src` list exactly the approved
 * gateways, and nothing else?
 *
 * The policy is generated from the same lists the client compiles in, so a
 * mismatch here means the artifact that shipped is not the artifact that was
 * built — and the failure mode is silent in the worst way: a missing origin
 * makes that gateway unreachable from the browser while every local check
 * stays green, turning a multi-gateway build back into a single-gateway one.
 * An EXTRA origin is worse: it is an egress destination nobody approved.
 *
 * Deliberately a separate script rather than an extension of smoke-headers.mjs,
 * which is being rewritten on another branch — same coverage, no conflict.
 */

import { cspConnectOrigins } from './gateways-parse.mjs';
import { EXPECTED_PAYLOAD_CSV, EXPECTED_STATUS_CSV, INDEX_SOURCES } from './gateway-pins.mjs';

/**
 * Compare an actual `connect-src` against what the pins require.
 * Pure, so the test does not need a deployment.
 *
 * `'self'` is REQUIRED, not merely tolerated: the app fetches its own origin,
 * and a policy that dropped it would break the PWA in ways no gateway test
 * would notice.
 */
export function checkConnectSrc(headerValue, proxyOrigin) {
  const problems = [];
  if (!headerValue) return { ok: false, problems: ['no Content-Security-Policy header'] };

  const directive = headerValue
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('connect-src'));
  if (!directive) return { ok: false, problems: ['CSP has no connect-src directive'] };

  const actual = directive.split(/\s+/).slice(1);
  const expected = [
    "'self'",
    ...cspConnectOrigins({
      status: EXPECTED_STATUS_CSV,
      payload: EXPECTED_PAYLOAD_CSV,
      indexSources: INDEX_SOURCES,
    }),
    proxyOrigin,
  ];

  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const want of expectedSet) {
    if (!actualSet.has(want)) problems.push(`connect-src is missing ${want}`);
  }
  for (const got of actualSet) {
    if (!expectedSet.has(got)) problems.push(`connect-src allows an unapproved source: ${got}`);
  }
  return { ok: problems.length === 0, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('smoke-csp-origins.mjs')) {
  const url = process.argv[2];
  const proxyRaw = process.env.VITE_PROXY_URL;
  if (!url || !proxyRaw) {
    console.error('usage: VITE_PROXY_URL=<origin> node scripts/smoke-csp-origins.mjs <deployed-url>');
    process.exit(2);
  }
  let proxyOrigin;
  try {
    proxyOrigin = new URL(proxyRaw).origin;
  } catch {
    console.error(`✗ VITE_PROXY_URL is not a valid URL`);
    process.exit(2);
  }

  const response = await fetch(url, { redirect: 'manual' });
  const { ok, problems } = checkConnectSrc(
    response.headers.get('content-security-policy'),
    proxyOrigin,
  );
  if (!ok) {
    console.error(`✗ smoke-csp-origins FAILED for ${url}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ smoke-csp-origins OK for ${url}: connect-src matches the approved gateways`);
}
