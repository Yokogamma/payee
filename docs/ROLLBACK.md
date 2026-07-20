# Deploy & rollback runbook

Both deploys are **manual** (`workflow_dispatch`) so nothing auto-publishes on
merge. Reader-before-writer ordering is operator-driven.

## Roll-forward order (reader release R)

1. Merge to `main` — nothing deploys.
2. **Worker first:** run **Deploy Worker (proxy)** (`deploy-worker.yml`). Smoke it
   (`GET /health`, a signed `/upload` round-trip on staging).
3. **Client:** run **Deploy to Cloudflare Pages** (`deploy-pages-cf.yml`). It runs
   `scripts/smoke-headers.mjs` against the deployment URL and **fails** if the CSP
   / `X-Frame-Options` / `nosniff` / `Referrer-Policy` headers are not applied.

The worker + client at this point READ v1+v2 but the client still WRITES v1.

## Enabling the writer (release W)

Only after R is deployed **everywhere and stable** flip the client to writing v2
(a later change to `addNote`). Do not enable W until R is the live baseline.

## Rollback rules

- **Never roll back below the reader release R** once v2 writes are enabled: an
  older client/worker cannot read v2 notes. R (reads v1+v2, writes v1) is the
  lowest safe rollback target.
- **Worker:** `wrangler rollback` (or redeploy the previous tag). Cloudflare warns
  that rolling back after a Durable Object storage/format change is risky — the DO
  migrations here are additive (new classes / new record fields), so rolling the
  worker back to R is safe; rolling below R is not.
- **Client (Pages):** use the Cloudflare Pages dashboard "Rollback to this
  deployment" on a previous **R-or-newer** deployment. Re-run `smoke-headers`
  afterwards.
- **CORS:** if the Pages origin changes, update `ALLOWED_ORIGINS` in
  `worker/wrangler.toml` and redeploy the worker **before** the client, and verify
  the new origin is allowed while a stranger origin is rejected.

## Required secrets

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_PAGES_PROJECT`,
`VITE_PROXY_URL` (https), `VITE_TRUSTED_OWNERS`.
