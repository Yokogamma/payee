import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { TEST_ARWEAVE_JWK, TEST_WALLET_ADDRESS } from './test-stubs/test-wallet.mjs';

// Second, separate test process for suites that `import worker from '../src/index'`
// directly (env-override dispatch: config gates, secret gate, e2e re-post,
// binding failure injection). Kept apart from the SELF-based integration run —
// mixing both import styles in one run re-bundles the worker mid-run and
// invalidates Durable Objects under other test files (see vitest.config.mts).
export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: false,
      singleWorker: true,
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          // Two origins: with a single one the dead quorum is unreachable by
          // construction, and the redrop suites are about reaching it.
          STATUS_GATEWAYS: 'https://arweave.net,https://g2.test',
          ADMIN_SECRET: 'test-admin-secret',
          // A JWK whose ADDRESS is knowable: /upload refuses while the signing
          // wallet is outside TRUSTED_OWNERS, so the two must agree. Still not
          // structurally complete — the transport rejects it exactly as before.
          ARWEAVE_JWK: TEST_ARWEAVE_JWK,
          TRUSTED_OWNERS: TEST_WALLET_ADDRESS,
          RECOVERY_HMAC_SECRET: 'test-recovery-secret',
        },
      },
    }),
  ],
  test: {
    include: [
      'test/e2e-repost.test.ts',
      'test/v3-gate-e2e.test.ts',
      'test/v4-gate-e2e.test.ts',
      'test/uploads-gate-e2e.test.ts',
      // PR-2 metrics suites: they import src modules directly and/or stub the
      // isolate's global fetch — same isolation reasoning as above.
      'test/arweave-transport.test.ts',
      'test/metrics-upload-e2e.test.ts',
      'test/admin-metrics.test.ts',
      // Imports src/index directly with per-test env overrides — same reason.
      'test/health-attestation.test.ts',
      // Imports src/index directly and overrides ARWEAVE_JWK/TRUSTED_OWNERS
      // per request — same isolation reasoning as above.
      'test/trusted-owners.test.ts',
    ],
    // Same reasoning as vitest.config.mts: one module registry across files so
    // re-importing src/index.ts can't invalidate Durable Objects mid-run.
    isolate: false,
  },
});
