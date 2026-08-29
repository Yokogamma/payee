import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Test config kept separate from vite.config.ts (build) to avoid coupling.
// Pure crypto/logic runs in Node (Web Crypto is global in Node 20+).
// Suites needing DOM/IndexedDB opt in via a per-file `// @vitest-environment jsdom`
// pragma plus the fake-indexeddb import.
export default defineConfig({
  // Component tests (*.test.tsx) rely on the automatic JSX runtime.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // Vite-only virtual module (vite-plugin-pwa) — stubbed under vitest.
      'virtual:pwa-register': fileURLToPath(new URL('./src/test-stubs/pwa-register.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // `viewer/` is included deliberately: the standalone artifact used to be
    // covered only by checks on its BUILT TEXT, which cannot see what the page
    // does when someone opens it — and its riskiest behaviour (what stays in
    // the DOM after the tab is left) is runtime behaviour.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'viewer/**/*.test.ts',
      'scripts/**/*.test.mjs',
      // The worker's own SCRIPTS are plain Node, not workerd: both worker
      // vitest configs run in the workers pool, where `node:fs` does not
      // exist, so their tests belong to this run.
      'worker/scripts/**/*.test.mjs',
    ],
    globals: false,
  },
});
