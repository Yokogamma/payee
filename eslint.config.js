import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees/` holds session git-worktree COPIES of this repo:
  // linting them double-reports every finding against stale snapshots and
  // breaks a clean local `npm run lint` (CI never has them).
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // The quick-unlock CORE is WebAuthn + WebCrypto and nothing else: no
    // storage, no store, no product policy. Enforced HERE rather than by a
    // test, because both modules import cleanly under Node without executing a
    // single browser branch — a green suite would not prove the boundary.
    // Policy, the record schema and the meta commits live in
    // `quick-unlock.ts` / `storage.ts`, which may import the core freely.
    files: ['src/lib/quick-unlock-core.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['./storage', './store', './storage.js', './store.js'],
          message:
            'quick-unlock-core.ts must not depend on storage or the store — ' +
            'put policy in quick-unlock.ts and meta commits in storage.ts.',
        }],
      }],
    },
  },
  {
    // `fp` is a SERVER concept: the proof that «these bytes are that
    // publication» lives in the worker, and the client has no production
    // consumer for it. `publication-fp.fixture.ts` is the TEST-ONLY mirror that
    // lets the client half be checked against the same documented byte vector
    // (docs/BACKUP_FORMAT_V1.md §1). Enforced HERE rather than by a test,
    // because an accidental production import would leave every suite green
    // while creating a second source of truth for a frozen format.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/lib/publication-fp.fixture.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/publication-fp.fixture', '**/publication-fp.fixture.js'],
          message:
            'publication-fp.fixture.ts is a test-only mirror of the server fingerprint — ' +
            'production code must not compute `fp` on the client (see docs/BACKUP_FORMAT_V1.md §1.4).',
        }],
      }],
    },
  },
])
