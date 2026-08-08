# Project Review Context

## Communication

- Отвечать пользователю на русском языке, если он явно не попросил другой язык.

## Stack

- Client: React 19, TypeScript 5.9 in strict mode, Vite 8, `vite-plugin-pwa`/Workbox.
- Client runtime target: ES2023 with DOM APIs.
- Client tests: Vitest 3; DOM suites opt into jsdom, IndexedDB suites use `fake-indexeddb`.
- Local persistence: IndexedDB through `idb`; session-scoped seed/draft state uses `sessionStorage` where explicitly designed.
- Cryptography: Web Crypto AES-256-GCM, BIP-39 via `@scure/bip39`, Ed25519 via `@noble/ed25519`, PIN wrapping with Argon2id via `hash-wasm`.
- Remote persistence: Arweave through a Cloudflare Worker proxy.
- Worker: Cloudflare Workers, TypeScript 5.8, Wrangler 4, Vitest 4 with `@cloudflare/vitest-pool-workers`.
- Supported Node.js: 22.13.0 or >=24; `.nvmrc` pins 22.13.0.

## Architecture And Security Review Focus

- Treat decrypted notes, mnemonic, encryption keys, signing keys, plaintext drafts, and session seed as sensitive client state.
- Preserve the sync state-machine and server-authoritative recovery behavior; review upload changes for duplicate paid transactions, stale `uploading`, retry, recovery-token, and txId loss risks.
- Restore must remain fail-closed against the configured trusted Arweave owners and authenticated encrypted envelopes.
- Production builds must keep `VITE_TRUSTED_OWNERS` validation and HTTPS proxy configuration fail-closed.
- PWA updates are user-prompted; do not introduce unconditional `skipWaiting` behavior.
- Worker/API changes require compatibility checks for existing client request and response shapes, invite access, rate limits, and recovery behavior.

## Quality Gates

- Client: `npm run lint`, `npm test`, `npm run build` with the required production environment values.
- Worker: `npm --prefix worker run typecheck`, `npm --prefix worker test`.
- Cloudflare Pages deployment is manual and also runs the post-deploy security-header smoke check.
- Follow `docs/ROLLBACK.md` for deployment and rollback ordering.

## Review Rules

- Prefer findings ordered by severity, with exact file and line references.
- Check current changes against the active implementation plan and existing tests.
- Call out unrelated scope, missing runtime validation, async races, cross-tab behavior, lifecycle/BFCache handling, and rollback risks.
- Do not treat JavaScript reference clearing as guaranteed physical zeroization.
