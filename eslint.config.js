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
])
