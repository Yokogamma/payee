#!/usr/bin/env node
/**
 * Pre-flight for the REAL staging deploy (`predeploy:staging`) only.
 *
 * `[env.staging]` ships with a PLACEHOLDER KV id, so an un-provisioned staging
 * fails deep inside wrangler with a message that says nothing about what the
 * operator actually has to do. Fail here instead, with the checklist.
 *
 * Deliberately NOT hooked to `deploy:staging:check` (`wrangler deploy --env
 * staging --dry-run`): that one validates wrangler.toml WITHOUT deploying and
 * without auth, so CI runs it on every Pages build to catch config drift. It
 * must keep working BEFORE staging exists — gating it on provisioning would
 * (and briefly did) break the client deploy for no safety gain.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');

const PLACEHOLDER = 'STAGING_KV_ID_PLACEHOLDER_CREATE_VIA_WRANGLER';

if (toml.includes(PLACEHOLDER)) {
  console.error(`
✗ Staging is NOT provisioned — [env.staging] still carries the placeholder KV id.

  The v4 (safebox) release REQUIRES a real staging smoke: unlike W3, this app
  now has users, so production is not an acceptable smoke target without a
  separate, explicit operator decision (docs/ROLLBACK.md).

  Operator checklist:
    1. wrangler kv namespace create ALLOWLIST --env staging
       → paste the returned id into [[env.staging.kv_namespaces]]
    2. wrangler secret put ARWEAVE_JWK --env staging          (dedicated test wallet)
    3. wrangler secret put ADMIN_SECRET --env staging
    4. wrangler secret put RECOVERY_HMAC_SECRET --env staging
    5. seed an invite via /admin/seed-invite and register the smoke key
       through /register (InviteManager is the source of truth)
    6. npm run deploy:staging:check   →   npm run deploy:staging
`);
  process.exit(1);
}

console.log('✓ staging config: KV id is set');
