import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Second, separate test process for suites that `import worker from '../src/index'`
// directly (env-override dispatch: config gates, secret gate, e2e re-post,
// binding failure injection). Kept apart from the SELF-based integration run —
// mixing both import styles in one run re-bundles the worker mid-run and
// invalidates Durable Objects under other test files (see vitest.config.ts).
export default defineWorkersConfig({
  test: {
    include: ['test/e2e-repost.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ADMIN_SECRET: 'test-admin-secret',
            ARWEAVE_JWK: '{}',
            RECOVERY_HMAC_SECRET: 'test-recovery-secret',
          },
        },
      },
    },
  },
});
