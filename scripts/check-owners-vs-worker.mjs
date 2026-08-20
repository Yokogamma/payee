// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Semantic deploy check (§1.7): the client about to ship must TRUST the
 * worker it is configured to talk to. Runs as a Pages-workflow step after
 * the build, before the deploy action.
 *
 * The build only validates VITE_TRUSTED_OWNERS by FORMAT (43 base64url
 * chars) — any well-formed stranger's address passes it. This check asks
 * the live worker behind VITE_PROXY_URL for its wallet address and
 * requires it to be INCLUDED in the owners list.
 *
 * Inclusion, not equality: after a wallet rotation the list legitimately
 * carries old + new (src/lib/config.ts rotation rule). Equality is only
 * required for the first clean production build (§2.2).
 *
 * Honest limit: this proves SELF-CONSISTENCY of the (proxy, owners) pair,
 * not authenticity — a swapped pair passes. Authenticity comes from the
 * repo-pinned expectations in check-deploy-config.mjs, which gate the same
 * variables against committed values.
 *
 * Requests are built from the URL's origin (never string-glued).
 */

import { parseTrustedOwners } from './trusted-owners-parse.mjs';

/**
 * Pure core: does the raw owners list include the worker's address?
 * Throws on malformed list; returns the parsed list for reporting.
 */
export function assertOwnersIncludeWorker(rawOwners, workerAddress) {
  const owners = parseTrustedOwners(rawOwners);
  if (owners.length === 0) {
    throw new Error('VITE_TRUSTED_OWNERS is empty — restore would be disabled fail-closed');
  }
  if (!owners.includes(workerAddress)) {
    throw new Error(
      `worker /wallet-address (${workerAddress}) is NOT in VITE_TRUSTED_OWNERS — ` +
        `the client being built would refuse to restore notes uploaded through this worker`,
    );
  }
  return owners;
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('check-owners-vs-worker.mjs')) {
  const proxyRaw = process.env.VITE_PROXY_URL;
  const ownersRaw = process.env.VITE_TRUSTED_OWNERS;
  if (!proxyRaw || !ownersRaw) {
    console.error('✗ VITE_PROXY_URL and VITE_TRUSTED_OWNERS are required');
    process.exit(1);
  }

  let origin;
  try {
    const u = new URL(proxyRaw);
    if (u.protocol !== 'https:') throw new Error('proxy URL must be https');
    origin = u.origin;
  } catch (e) {
    console.error(`✗ VITE_PROXY_URL is not a valid https URL: ${e.message}`);
    process.exit(1);
  }

  const health = await (await fetch(new URL('/health', origin))).json();
  if (health.ok !== true) {
    console.error(`✗ worker /health is not ok: ${JSON.stringify(health)}`);
    process.exit(1);
  }

  const { address } = await (await fetch(new URL('/wallet-address', origin))).json();
  if (typeof address !== 'string' || address.length === 0) {
    console.error('✗ worker /wallet-address returned no address');
    process.exit(1);
  }

  try {
    const owners = assertOwnersIncludeWorker(ownersRaw, address);
    console.log(
      `✓ owners-vs-worker: /health ok; wallet ${address} is one of ${owners.length} trusted owner(s)`,
    );
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
