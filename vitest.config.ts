import { defineConfig } from 'vitest/config';

// Test config kept separate from vite.config.ts (build) to avoid coupling.
// Pure crypto/logic runs in Node (Web Crypto is global in Node 20+).
// Suites needing DOM/IndexedDB opt in via a per-file `// @vitest-environment jsdom`
// pragma plus the fake-indexeddb import.
export default defineConfig({
  // Component tests (*.test.tsx) rely on the automatic JSX runtime.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    globals: false,
  },
});
