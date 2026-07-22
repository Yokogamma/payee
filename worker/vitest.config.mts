import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Runs tests inside the real workerd runtime (via Miniflare) so Durable Objects,
// KV, and outbound fetch behave as in production. Reads bindings from wrangler.toml.
// (vitest-pool-workers ≥0.18 / vitest 4: the pool is configured via the
// cloudflareTest() plugin instead of defineWorkersConfig/poolOptions.)
//
// e2e-repost.test.ts is EXCLUDED here and runs via vitest.direct.config.ts in a
// separate process (`npm test` runs both): it imports src/index directly for
// env-override dispatch, and mixing that import with SELF-based files in ONE
// run makes the pool re-bundle the worker mid-run — "index.ts changed,
// invalidating this Durable Object" failures in unrelated test files.
export default defineConfig({
  plugins: [
    cloudflareTest({
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
    }),
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/e2e-repost.test.ts'],
    // Share ONE module registry across test files: per-file isolation re-imports
    // src/index.ts, changing the DO class identity — a DO instance that
    // survives a file boundary (the global InviteManager) then throws
    // "index.ts changed, invalidating this Durable Object" under whichever file
    // touches it next. Requires singleWorker + isolatedStorage:false (both set).
    isolate: false,
  },
});
