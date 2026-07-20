import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Runs tests inside the real workerd runtime (via Miniflare) so Durable Objects,
// KV, and outbound fetch behave as in production. Reads bindings from wrangler.toml.
export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Isolated storage stacking is flaky on Windows (EBUSY on temp dirs);
        // tests isolate themselves via distinct DO names instead.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Test-only stand-ins for secrets (real values come from `wrangler secret`).
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
