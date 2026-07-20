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
  lowest safe rollback target for the DATA format.
- **Worker — hard floor at the `posted`-aware version.** This Worker adds a new
  RateLimiter state-machine state `posted` (not just fields). A pre-`posted`
  Worker only knows `reserved | committed`; it would treat a `posted` record as
  absent/stale, overwrite it with a new reservation, and **lose the server txId →
  duplicate paid TX**. Therefore:
  - Record the exact **minimum Worker SHA/tag that understands `posted`** here on
    first deploy of this Worker:  `MIN_WORKER_SHA = <fill on first deploy>`.
  - **Never roll the Worker below `MIN_WORKER_SHA`** once it has been deployed
    even once — independent of whether the v2 writer is enabled. Rolling back to
    any SHA ≥ `MIN_WORKER_SHA` (and ≥ R) is safe.
  - Use `wrangler rollback` / redeploy of an allowed tag only.
- **Client (Pages):** use the Cloudflare Pages dashboard "Rollback to this
  deployment" on a previous **R-or-newer** deployment. Re-run `smoke-headers`
  afterwards.
- **CORS:** if the Pages origin changes, update `ALLOWED_ORIGINS` in
  `worker/wrangler.toml` and redeploy the worker **before** the client, and verify
  the new origin is allowed while a stranger origin is rejected.

## Required secrets

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_PAGES_PROJECT`,
`VITE_PROXY_URL` (https), `VITE_TRUSTED_OWNERS`.
