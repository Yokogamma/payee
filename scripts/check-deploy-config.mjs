// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Early deploy-config gate (§1.7). Runs as a workflow step right after
 * checkout/setup-node, BEFORE npm ci — so it must stay dependency-free
 * (node builtins + repo-local plain-JS imports only).
 *
 * What it proves:
 *   1. every required NON-SECRET variable is present and non-empty — the
 *     build reads only the VITE_* pair, so a missing CF_PAGES_PROJECT or
 *     CLOUDFLARE_ACCOUNT_ID would otherwise ride into the deploy action
 *     empty and surface late, as a confusing Cloudflare error;
 *   2. values match the EXPECTED ones committed in the repo (where pinned):
 *     visibility of variables does not prove correctness — a swapped
 *     proxy/owners PAIR is self-consistent and passes every live check.
 *     Pinning turns "change the proxy or the trust set" into a reviewed PR
 *     instead of a silent Settings edit.
 *
 * The deploy TOKEN is deliberately NOT passed to (or checked by) this
 * script: deploy workflows can be dispatched from arbitrary branches
 * (--ref), so any repo JS that received the secret would hand it to
 * whatever that branch contains. Token presence is verified once, during
 * migration, via the GitHub API (names only) — outside the code path.
 *
 * NEVER prints env values — names and committed expectations only.
 *
 * Usage: node scripts/check-deploy-config.mjs [VAR ...]
 *   (no args = the full four-variable set of the Pages deploy)
 */

import { AUTO_ALLOWED_WORKER_ORIGINS } from '../worker/scripts/smoke-target.mjs';
import { parseTrustedOwners } from './trusted-owners-parse.mjs';
import { parseIndexSources, parseOriginList } from './gateways-parse.mjs';
import {
  EXPECTED_PAYLOAD_CSV,
  EXPECTED_STATUS_CSV,
  INDEX_SOURCES as EXPECTED_INDEX_SOURCES,
} from './gateway-pins.mjs';

export const DEPLOY_VARS = [
  'CF_PAGES_PROJECT',
  'VITE_PROXY_URL',
  'VITE_TRUSTED_OWNERS',
  'CLOUDFLARE_ACCOUNT_ID',
  'VITE_STATUS_GATEWAYS',
  'VITE_PAYLOAD_GATEWAYS',
  'VITE_INDEX_SOURCES',
];

/**
 * Repo-pinned expectations. `null` = presence-only for the dev contour
 * (§2.2 makes pinning ALL FOUR mandatory for production).
 *
 *  - VITE_PROXY_URL must EQUAL the dev worker origin. Single source of
 *    truth: the same constant the smoke classifier allow-lists (§1.5).
 *  - VITE_TRUSTED_OWNERS must INCLUDE the current dev proxy wallet —
 *    inclusion, not equality: after a wallet rotation the list must keep
 *    the old address too (src/lib/config.ts rotation rule), so equality
 *    would either block a correct deploy or push someone to delete the
 *    old owner and strand previously uploaded notes.
 */
export const EXPECTED = {
  CF_PAGES_PROJECT: null,
  VITE_PROXY_URL: { equals: AUTO_ALLOWED_WORKER_ORIGINS[0] },
  VITE_TRUSTED_OWNERS: { mustInclude: 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE' },
  CLOUDFLARE_ACCOUNT_ID: null,
  // ── Gateway sets: pinned EXACTLY, not merely present (D1/D7) ──
  //
  // Presence alone would let a Settings edit point a stable Owner-Hash, a
  // stable IP and every txId this vault asks about at hosts nobody approved —
  // and the CSP would allow it, because the CSP is generated from the same
  // edited value. Comparison is on the NORMALIZED list, so a trailing slash or
  // a repeated entry is not a difference, while a changed SET is.
  VITE_STATUS_GATEWAYS: { equalsOrigins: EXPECTED_STATUS_CSV, ordered: false },
  // ORDER matters here and is part of the pin: the pool is tried in sequence,
  // and §2.1 approved this sequence (arweave.net first, slower mirrors after).
  VITE_PAYLOAD_GATEWAYS: { equalsOrigins: EXPECTED_PAYLOAD_CSV, ordered: true },
  // Groups AND the order within them are pinned: the grouping records which
  // endpoints are transport-fallbacks of ONE logical index rather than
  // independent opinions, which is what PR-4 counts completeness over.
  VITE_INDEX_SOURCES: { equalsIndexSources: EXPECTED_INDEX_SOURCES },
};

/**
 * Pure check. Returns { ok, problems } where problems name variables and
 * committed expectations but NEVER echo actual env values.
 */
export function checkDeployConfig(env, required = DEPLOY_VARS) {
  const problems = [];

  for (const name of required) {
    const value = env[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      problems.push(`${name} is missing or empty`);
      continue;
    }
    const expected = EXPECTED[name];
    if (!expected) continue;

    if (expected.equals !== undefined && value !== expected.equals) {
      problems.push(`${name} does not equal the repo-pinned expected value (${expected.equals})`);
    }
    if (expected.equalsOrigins !== undefined) {
      const actual = parseOriginList(value);
      const wanted = parseOriginList(expected.equalsOrigins);
      const same = expected.ordered
        ? actual.join(',') === wanted.join(',')
        : [...actual].sort().join(',') === [...wanted].sort().join(',');
      if (!same) {
        problems.push(
          `${name} does not match the repo-pinned gateway set` +
            `${expected.ordered ? ' (order is part of the pin)' : ''}: ${expected.equalsOrigins}`,
        );
      }
      continue;
    }

    if (expected.equalsIndexSources !== undefined) {
      const actual = JSON.stringify(parseIndexSources(value));
      const wanted = JSON.stringify(parseIndexSources(expected.equalsIndexSources));
      if (actual !== wanted) {
        problems.push(
          `${name} does not match the repo-pinned index sources (groups and order ` +
            `are part of the pin): ${expected.equalsIndexSources}`,
        );
      }
      continue;
    }

    if (expected.mustInclude !== undefined) {
      let owners;
      try {
        owners = parseTrustedOwners(value);
      } catch {
        problems.push(`${name} failed to parse as a trusted-owners list`);
        continue;
      }
      if (!owners.includes(expected.mustInclude)) {
        problems.push(
          `${name} does not include the repo-pinned current owner (${expected.mustInclude})`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('check-deploy-config.mjs')) {
  const required = process.argv.slice(2);
  const { ok, problems } = checkDeployConfig(
    process.env,
    required.length > 0 ? required : DEPLOY_VARS,
  );
  if (!ok) {
    console.error('✗ deploy config gate failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\n  Values live in the GitHub Environment "dev" (Settings → Environments).' +
        '\n  Expected values are committed in scripts/check-deploy-config.mjs.',
    );
    process.exit(1);
  }
  console.log('✓ deploy config gate: all required variables present and matching pins');
}
