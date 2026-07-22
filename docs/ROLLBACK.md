# Deploy & rollback runbook

Both deploys are **manual** (`workflow_dispatch`) so nothing auto-publishes on
merge. Reader-before-writer ordering is operator-driven.

## FIRST rollout of the recovery protocol — CLIENT BEFORE WORKER

The usual "worker first" order is **wrong for the first deploy of this branch**.
The new Worker is a *writer* of the recovery protocol (`committed:false` +
`recovery` token), and clients from current `main` neither persist the token nor
understand `committed:false`. If the new Worker goes live against legacy
clients, a triple-failure in that window ends in a confirmed TX with no quota
commit, then a duplicate paid POST after the reservation TTL. Order:

1. Merge to `main` — nothing deploys.
2. `wrangler secret put RECOVERY_HMAC_SECRET` (mandatory: the new Worker 503s
   uploads without it — see wrangler.toml).
3. **Client first:** deploy the recovery-aware client to the CURRENT legacy
   origin (github.io). It still writes v1 and is fully compatible with the old
   Worker (which simply never sends `committed:false`).
4. **Worker:** run **Deploy Worker (proxy)** (`deploy-worker.yml`). Smoke it
   (`GET /health`, a signed `/upload` round-trip on staging). Tag + record the
   floor (see below).
5. **Cloudflare Pages:** deploy the same client build to Pages
   (`deploy-pages-cf.yml`). The production origin `https://notes.matamata.dev`
   is already in `ALLOWED_ORIGINS` (wrangler.toml); attach it as the Pages
   custom domain. The
   workflow runs `scripts/smoke-headers.mjs` against the deployment URL and
   **fails** if the CSP / `X-Frame-Options` / `nosniff` / `Referrer-Policy`
   headers are not applied.

(Equivalent alternative: a Worker feature flag that suppresses `recovery`
responses until the minimum client version is confirmed — not implemented;
the client-first order above is the supported path.)

## Roll-forward order (subsequent releases: reader release R)

Once both sides speak the recovery protocol, the usual order applies:

1. Merge to `main` — nothing deploys.
2. **Worker first** (`deploy-worker.yml`), smoke, append the release tag below.
3. **Client** (`deploy-pages-cf.yml`), smoke-headers must pass.

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

## Wallet (owner) rotation — TRUSTED_OWNERS runbook

Restore trusts ONLY transactions signed by the wallets pinned in the client's
`VITE_TRUSTED_OWNERS`. Rotating the server wallet in the wrong order makes old
notes unrecoverable for every client built without the old owner. Order:

1. **Add** the NEW wallet's address to `VITE_TRUSTED_OWNERS` (comma-separated,
   old + new) in the deploy secrets.
2. **Deploy the client** with both owners and VERIFY restore returns notes
   posted under the old wallet.
3. **Only then** replace `ARWEAVE_JWK` on the Worker with the new wallet.
4. **Never remove old owners** from `VITE_TRUSTED_OWNERS` — notes posted under
   them stop restoring the moment the address is dropped.
5. **Do NOT rotate `RECOVERY_HMAC_SECRET` together with the JWK** — outstanding
   recovery tokens would stop verifying and fail closed (see Required secrets).

## Revocation SLO (accepted residual risk)

`/admin/revoke` is **not** an instant global kill switch. The DO (source of
truth) drops the key synchronously and writes the short-TTL `denied` entry in
the same critical section, but Workers KV is eventually consistent: an edge
that already cached `{status:'allowed'}` keeps honouring it until its TTL
expires.

- **Worst-case propagation: `ALLOW_CACHE_TTL_SECONDS` (currently 1 hour)** —
  the deliberate ceiling on how long a revoked key can still upload. Lowering
  it shortens the window at the cost of more DO round-trips on cache misses.
- The negative entry is far shorter-lived (`DENY_CACHE_TTL_SECONDS`, 10 min) so
  a later re-grant is not masked.
- Anything needing an immediate stop (compromised wallet, abuse in progress)
  must ALSO take a coarse action: rotate `ADMIN_SECRET`/`ARWEAVE_JWK`, or
  disable the Worker route — do not rely on revoke alone.

## Required secrets

GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CF_PAGES_PROJECT`, `VITE_PROXY_URL` (https), `VITE_TRUSTED_OWNERS`.

Worker (`wrangler secret put`): `ARWEAVE_JWK`, `ADMIN_SECRET`,
`RECOVERY_HMAC_SECRET` — **MANDATORY for uploads**: the Worker refuses every
`/upload` with `503 Server misconfigured` while the secret is missing or
shorter than 16 characters (enforced in code). Generate once with
`openssl rand -base64 32` and keep it STABLE — never rotate it together with
`ARWEAVE_JWK` (outstanding recovery tokens would stop verifying and fail
closed, blocking reconciliation until operator intervention).
