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
- **Worker — hard floor at the recovery-aware version.** Git SHAs are not
  ordered, so "SHA ≥ floor" is meaningless — the floor is defined by **ancestry**
  (`git merge-base --is-ancestor <floor> <candidate>` must succeed), or better,
  by an **explicit allowlist of release tags** maintained below.
  Two protocol capabilities set the floor:
  1. `posted` DO state: a pre-`posted` Worker only knows `reserved | committed`;
     it would treat a `posted` record as absent/stale, overwrite it with a new
     reservation, and **lose the server txId → duplicate paid TX**.
  2. Recovery tokens: a `posted`-aware but pre-recovery Worker (e.g. `46c3a42`)
     silently ignores the client's `recovery` field, and current clients DEPEND
     on the fail-closed `Invalid recovery token` behaviour. Client and Worker
     must be rolled back **as a compatible pair**, never the Worker alone below
     the recovery protocol.
  - On the first production deploy, tag it (e.g. `worker-r1`) and record it here:
    `WORKER_FLOOR_TAG = <fill on first deploy: tag + full SHA>`.
  - **Allowed rollback targets = tags in this list that are descendants of
    `WORKER_FLOOR_TAG`** (verify with `git merge-base --is-ancestor`). Never
    deploy anything else once the floor Worker has run even once.
  - Use `wrangler rollback` / redeploy of an allowed tag only.
  - Allowed release tags (append on each deploy):
    - _none yet — first deploy pending_
- **Client (Pages):** use the Cloudflare Pages dashboard "Rollback to this
  deployment" on a previous **R-or-newer** deployment. Re-run `smoke-headers`
  afterwards.
- **CORS:** if the Pages origin changes, update `ALLOWED_ORIGINS` in
  `worker/wrangler.toml` and redeploy the worker **before** the client, and verify
  the new origin is allowed while a stranger origin is rejected.

## Required secrets

GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CF_PAGES_PROJECT`, `VITE_PROXY_URL` (https), `VITE_TRUSTED_OWNERS`.

Worker (`wrangler secret put`): `ARWEAVE_JWK`, `ADMIN_SECRET`,
`RECOVERY_HMAC_SECRET` (stable — do NOT rotate together with `ARWEAVE_JWK`;
without it recovery tokens are not issued and presented ones fail closed).
