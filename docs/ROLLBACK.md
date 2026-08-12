# Deploy & rollback runbook

Both deploys are **manual** (`workflow_dispatch`) so nothing auto-publishes on
merge. Reader-before-writer ordering is operator-driven.

## FIRST rollout of the recovery protocol — CLIENT BEFORE WORKER

> **Operator override (decided 2026-07-22, executed 2026-07-23): WORKER-FIRST for
> THIS deployment.** The client-before-worker rule below exists solely to protect
> *legacy clients on `yokogamma.github.io`*. The operator confirmed there are **no
> such clients**, so the rule does not apply. Two facts made worker-first the safer
> choice here:
> 1. No legacy client is loaded or cached anywhere, so the recovery-protocol
>    incompatibility that motivates client-first cannot occur.
> 2. The currently-deployed (old) Worker does **not** allow the new production
>    origin `https://notes.matamata.dev` (preflight returns 204 without ACAO), so a
>    client deployed *before* the new Worker would sit CORS-blocked for minutes.
>
> Executed order: **Worker → smoke → floor tag → Pages project → client → attach
> `notes.matamata.dev` → smokes.** The legacy `github.io` deploy is **skipped**.
> This override applies to the FIRST rollout only; the roll-forward order for
> subsequent releases (below) is unchanged.

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

## v3 release (Markdown + note versioning) — R3 / W3

The v3 envelope carries version-chain metadata (`rev`, `root`, `prev`, `fmt`)
inside the ciphertext; on-chain it is wire-identical to v2 except the
`App-Version=3` tag and the **UUIDv8 Note-Id namespace** (v1/v2 ids are UUIDv4;
the worker enforces the split — a stale pre-v3 client tab re-serializing a v3
record as v1 gets 400, never a committed garbage TX).

Deploy order for THIS release is **strictly worker-first** (the only sanctioned
sequence): **Worker v3-acceptor → R3 → W3.**

1. **Worker v3-acceptor** (`deploy-worker.yml`): accepts App-Version 1/2/3,
   `V3_UPLOADS_ENABLED = "true"` in wrangler.toml (see kill switch below),
   `/health` reports `{versions, v3Uploads}`. Smoke, then append the release
   tag to the allowlist below.
2. **R3 client** (tag `client-r3`): READS v1–v3 (chains grouping + fmt-aware
   render always active — R3 must correctly display v3 data after a W3
   rollback), WRITES v1 (`V3_WRITER_ENABLED=false`; edit/history/Markdown
   composer hidden, `editNote` throws in the store).
   **DEPLOYED 2026-08-09** (tag `client-r3` = cd7524e) on notes.matamata.dev;
   smoke-headers + CSP verified. Worker deployed first the same day
   (worker-r2) — order Worker → R3 held.
3. **W3 client** (tag `client-w3`): flips `V3_WRITER_ENABLED` only — no other
   code. **Mandatory preconditions:** production `/health` shows
   `versions:['1','2','3']` and `v3Uploads:true`; a **signed v3 upload smoke
   passed** (`npm --prefix worker run smoke:v3`) — against staging, or against
   PRODUCTION when there are no users yet (it posts one real, tiny paid
   transaction); the real worker floor tag/SHA is recorded below.
   **DEPLOYED 2026-08-09** (tag `client-w3` = 9107811). Preconditions met the
   same day: prod `/health` verified; production smoke passed — upload
   accepted (`8bldiJx5cf…`), repeat returned the SAME txId with no second paid
   POST, and a v1 upload carrying a UUIDv8 Note-Id was rejected 400.
   Shipped bundle verified to contain the writer UI. Users existed: none.
   **From this point the rollback floors below are binding.**

### v3 upload kill switch (`V3_UPLOADS_ENABLED`)

Honest name: an **upload kill switch** — it stops the worker ACCEPTING v3
uploads; an open W3 client keeps creating local v3 versions, which sync once
the gate re-opens (the client pauses its v3 queue on the first
`503 {code:'v3_uploads_disabled'}` and resumes via `/health` polling or manual
retry).

- **Full v3 pause**: while disabled, ALL v3 traffic — including reconciliation
  of committed/posted/reserved states and recovery hints — gets 503 after the
  IP limiter but **before any per-owner RateLimiter DO call and before any
  Arweave POST**. v1/v2 are unaffected.
- **Fail-closed**: strictly `"true"` enables; a missing/garbage value disables.
- **Source of truth = `worker/wrangler.toml`.** Toggle = edit the var +
  `npm --prefix worker run deploy` from the verified v3-acceptor tag (never a
  bare `npx wrangler`). A dashboard override is EMERGENCY-ONLY and must be
  synced back to the repo immediately — the next deploy silently restores the
  repo value. After EVERY worker deploy verify:
  `curl <worker>/health` → `v3Uploads` matches the intended state.

### v3 rollback rules

- **W3 rollback is gradual by nature**: rolling Pages back to R3 does NOT stop
  already-open/installed W3 PWAs from writing v3 locally and uploading
  (`registerType:'prompt'` — the new SW activates only on user consent; no
  unconditional skipWaiting). Immediate stop = the kill switch above.
- **After W3 has run even once: never roll the client below R3, never roll the
  worker below the v3-acceptor** — older code cannot read v3 notes / accepts
  the wrong Note-Id namespace.
- Release notes must tell users to close/refresh stale pre-R3 tabs and update
  installed PWAs: a stale tab renders a v3 envelope as JSON text and keeps
  retrying an upload the worker rejects (harmless on-chain, wastes IP quota).

## v4 release (Защищённый сейф / safebox) — worker v4-acceptor → R4 → W4

App-Version=4 is the **safebox** record: same 5 tags as v2/v3, but a
**split-envelope** data object `{id, mc, miv, sc, siv}` — two independently-keyed
AES-GCM ciphertexts (meta + secret) in ONE transaction. Ids are UUIDv8 (same
namespace as v3; the worker enforces the split per App-Version).

Deploy order is **strictly worker-first**: **Worker v4-acceptor → R4 → W4.**

1. **Worker v4-acceptor** (`deploy-worker.yml`): accepts App-Version 1/2/3/4,
   `V4_UPLOADS_ENABLED = "true"` in wrangler.toml, `/health` reports
   `{versions:['1','2','3','4'], v3Uploads, v4Uploads}`. Smoke
   (`npm --prefix worker run smoke:v4` — **staging**), then append the release
   tag to the allowlist below and **raise `WORKER_FLOOR_TAG` to it immediately**
   (an older worker rejects App-Version=4 outright, so once safebox entries
   exist they would stop syncing).
   *Tag it on its OWN worker commit* — do not reuse `worker-r2`/`client-r3`
   (both point at `cd7524e`).
2. **R4 client** (tag `client-r4`): the complete safebox code with
   `SAFEBOX_WRITER_ENABLED=false`. Reader + PIN + viewing + activation +
   PIN change/deactivation/seed-reset all work; `addSafeboxEntry` /
   `editSafeboxEntry` / `restoreSafeboxVersion` throw `WriterDisabledError` and
   their UI is hidden.
   **R4 IS AN IRREVERSIBLE CLIENT FLOOR from its FIRST production run**: it
   raises IndexedDB from v1 to v2 on the very first launch, regardless of the
   writer flag, and rolling that device back to W3 (`DB_VERSION=1`) yields a
   `VersionError`. Therefore, **with R4** (not W4): publish the release note
   «закройте старые вкладки Eternal Notes / обновите установленные PWA», and
   verify the non-destructive `VersionError` screen (reload prompt, **no**
   `resetBrokenStorage` button) before deploying.
3. **W4 client** (tag `client-w4`): flips `SAFEBOX_WRITER_ENABLED` only — no
   other code. **Mandatory preconditions:** production `/health` shows
   `versions` containing `'4'` and `v4Uploads:true`; the signed v4 staging smoke
   passed; the v4-acceptor worker tag is recorded below as the floor.

### v4 upload kill switch (`V4_UPLOADS_ENABLED`)

Identical contract to `V3_UPLOADS_ENABLED`, on its own switch (pausing one
version never stops the other):

- while disabled, ALL v4 traffic — including reconciliation and recovery
  hints — gets `503 {code:'v4_uploads_disabled'}` after the IP limiter but
  **before any per-owner RateLimiter DO call and before any Arweave POST**;
- **fail-closed**: strictly `"true"` enables, anything else disables;
- **source of truth = `worker/wrangler.toml`**; a dashboard override is
  emergency-only and must be synced back. Verify after every worker deploy:
  `curl <worker>/health` → `v4Uploads` matches the intended state;
- the client pauses its whole v4 queue on the first 503 (persisted
  `v4-uploads-paused` marker) and resumes only on
  `ok && v4Uploads===true && versions∋'4'`, or via the manual banner button.
  `versions` alone is NOT sufficient — it still lists '4' while the gate is off.

### STAGING IS A HARD PRECONDITION (operator, currently NOT provisioned)

`[env.staging]` in `worker/wrangler.toml` still carries the KV **placeholder id**
(`STAGING_KV_ID_PLACEHOLDER_CREATE_VIA_WRANGLER`), i.e. staging does not exist
yet. W3 was smoked against PRODUCTION only because there were no users. **v4 has
users**, so the operator must provision staging before the v4-acceptor deploy:

1. `wrangler kv namespace create ALLOWLIST --env staging` → paste the id into
   `[[env.staging.kv_namespaces]]`;
2. `wrangler secret put ARWEAVE_JWK --env staging` (dedicated test wallet,
   minimal AR balance — never the production wallet);
3. `wrangler secret put ADMIN_SECRET --env staging`;
4. `wrangler secret put RECOVERY_HMAC_SECRET --env staging`;
5. seed an invite via `/admin/seed-invite` and register the smoke key through
   `/register` (InviteManager is the source of truth — never hand-write `pk:`
   entries into KV);
6. `npm --prefix worker run deploy:staging:check`, then `deploy:staging`.

A production smoke is an **escape hatch that requires a separate, explicit
operator decision** and must be recorded here when used. `smoke-v4.mjs`
enforces this: it refuses any `SMOKE_URL` host that is not localhost or a
recognisable `staging` target unless `ALLOW_PRODUCTION_SMOKE=true` is set —
the script posts real, paid Arweave transactions.

Every staging command (`deploy:staging`, `deploy:staging:check`) is gated by
`npm run check:staging-config`, which fails with the checklist above while the
KV placeholder is still in `wrangler.toml`.

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
  - On the first production deploy, tag it (e.g. `worker-r1`) and record it here.
    **Current floor (raised when W3 shipped, 2026-08-09):**
    `WORKER_FLOOR_TAG = worker-r2 (cd7524e)` — the v3-acceptor. The previous
    value (`worker-r1`, 15b87d4cacbc19a3371a19b9141f1562b63781d8) is now BELOW
    the floor and must never be redeployed: it does not know App-Version=3 or
    the UUIDv8 namespace split.
  - **Allowed rollback targets = tags in this list that are descendants of
    `WORKER_FLOOR_TAG`** (verify with `git merge-base --is-ancestor`). Never
    deploy anything else once the floor Worker has run even once.
  - Use `wrangler rollback` / redeploy of an allowed tag only.
  - Allowed release tags (append on each deploy):
    - worker-r1 — 15b87d4cacbc19a3371a19b9141f1562b63781d8 (2026-07-23, first
      production worker deploy; recovery-protocol writer)
    - worker-r2 — cd7524e (2026-08-09, v3-acceptor: App-Version=3, UUIDv8
      namespace barrier, V3_UPLOADS_ENABLED kill switch, /health capability;
      prod /health verified: {ok, versions:[1,2,3], v3Uploads:true}).
      **Became the worker rollback floor when W3 shipped (2026-08-09).**
    - worker-r3 (v4-acceptor) — `<SHA once deployed>` (App-Version=4 split
      envelope, V4_UPLOADS_ENABLED kill switch, /health `v4Uploads`).
      **Becomes the worker rollback floor the moment it is deployed** (an older
      worker 400s every safebox upload). Record the tag + SHA + the verified
      `/health` output here at deploy time and raise `WORKER_FLOOR_TAG` above.
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
