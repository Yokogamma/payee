import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tmp/mutcheck/viewer/**/*.test.ts'],
    globals: false,
  },
});
