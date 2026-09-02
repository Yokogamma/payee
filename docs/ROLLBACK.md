# Deploy & rollback runbook

Both deploys are **manual** (`workflow_dispatch`) so nothing auto-publishes on
merge. Reader-before-writer ordering is operator-driven.

> **The worker deploy's interface changed (control plane, D2a).** It is no
> longer «pick a branch and run it». Dispatch **Deploy Worker (proxy) — dev**
> **from the default branch** and paste the full 40-character **commit SHA** of
> the build you want into the `candidate` input. The workflow checks that SHA
> against the floor before it checks out a single file of it, then deploys it
> from `candidate/`. See «The floor as a gate» below — including what only the
> operator can do, and why `wrangler rollback` and the dashboard's Rollback
> button are out of bounds.

> **Contour reclassified 2026-08-20 (operator decision).**
> `notes.matamata.dev` is the **working (dev) contour**, not production. The
> real production will be provisioned **from scratch** on a `.app` domain when
> v1 is declared ready; nothing from the current contour — data, wallets,
> secrets, floor tags — is carried over. The deploy workflows are named
> `… — dev` accordingly; future production workflows will be `… — production`.
>
> Historical entries below that say "production"/"PRODUCTION" are left
> untouched on purpose: at the time of writing this contour *was* the
> production, and rewriting the records would destroy the audit trail. Read
> them as history. Active instructions in this runbook operate the dev contour.

> **Legacy GitHub Pages target retired 2026-08-20 (operator decision).**
> `.github/workflows/deploy.yml` («Deploy to GitHub Pages (legacy)») is deleted.
> The cutover to Cloudflare Pages is complete, and GitHub Pages could never
> carry the security headers anyway: it ignores `_headers`, so the generated CSP
> was **not** applied there. The only client deploy is now
> `deploy-pages-cf.yml`; the only worker deploy is `deploy-worker.yml`.
>
> Historical entries below that mention `yokogamma.github.io` are left untouched
> on purpose — they record what was true during those rollouts, and rewriting
> them would destroy the audit trail. Read them as history, not as instructions.
>
> ~~Open follow-up: `VITE_BASE` still defaults to `/payee/`…~~ **Resolved
> 2026-08-21 (§1.8, PR #93):** the default in `vite.config.ts` and
> `scripts/postbuild.mjs` is now `/` — a build without the variable produces
> Cloudflare-Pages-shaped artefacts. Both deploy paths still pass
> `VITE_BASE=/` explicitly.

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
   `SAFEBOX_WRITER_ENABLED=false`.
   **DEPLOYED 2026-08-12** (tag `client-r4` = f43e503) on notes.matamata.dev,
   run 31584259549, smoke-headers passed. Verified against the live site:
   CSP `connect-src` pins the worker origin; IndexedDB migrated to **version 2**
   with stores `meta/notes/safebox/sync`; the privacy gate is mounted and
   `hidden` (`display:none` — the `.lock-gate[hidden]` specificity rule holds in
   production); «+ Запись» is absent from the bundle (tree-shaken, so the flag
   really is `false`); and a brand-new user sees **no** safebox entry point in
   the header — the R4 visibility formula end to end.
   Release note published with this tag: *«закройте старые вкладки Eternal Notes
   и обновите установленные PWA»* — the v1→v2 migration runs on first launch and
   is irreversible. Reader + PIN + viewing + activation +
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
   **DEPLOYED 2026-08-12** (tag `client-w4` = c1346e4) on notes.matamata.dev,
   run 31594140875 — all gates green, smoke-headers passed. All three
   preconditions were met first: prod `/health` `v4Uploads:true`, the signed v4
   smoke passed 8/8 against PRODUCTION (see `worker-r3` below), `worker-r3` was
   already the recorded floor. The diff is literally one line in
   `src/lib/flags.ts`.

   Verified against the live site, as a brand-new user on a clean profile:
   - the deployed bundle (`index-CMXYxCUh.js`) CONTAINS «+ Запись», «Вернуть
     эту версию» and the password-generator strings — at R4 tree-shaking
     removed them, so their presence is direct evidence the flag is `true` in
     the artifact, not merely in the source;
   - the header shows the **«Защищённый сейф» 🔐** button for a user with no
     safebox data and no PIN — the `SAFEBOX_WRITER_ENABLED || … ` visibility
     formula end to end (at R4 the same check found it absent);
   - IndexedDB is at **version 2** with stores `meta/notes/safebox/sync`;
   - CSP / `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy` intact.

   ⚠️ **The update is prompt-gated, so W4 does NOT reach open clients on its
   own.** Observed live: an already-loaded tab kept running R4 (no safebox
   button) and only switched after «Обновить» in the update toast —
   `registerType:'prompt'`, no unconditional `skipWaiting`. Expect a long tail
   of R4 clients; that is by design, not a failed deploy.

   NOT verified (deliberately, cost/side-effects): creating a real safebox
   entry end-to-end from the UI. That path needs a registered account (an
   invite) and posts a real paid v4 transaction. The v4 wire format itself is
   covered by the signed smoke; what remains unexercised in production is the
   client-side publish path (`publishUnlockedSafebox` → upload).

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

### OPERATOR DECISION 2026-08-12: v4 ships WITHOUT staging

> The operator confirmed that **there are still no real users — every account is
> a test account**. On that basis the staging precondition below is waived for
> the v4 rollout and the smoke runs against PRODUCTION, exactly as it did for
> W3 and for the same reason.
>
> This is the escape hatch, invoked explicitly and recorded here as required.
> What it costs: the first real exercise of the v4 acceptor happens on the
> production worker and posts one real, tiny paid transaction. What it does NOT
> waive: the smoke itself is still mandatory before the acceptor is tagged as
> the floor, and `smoke-v4.mjs` still demands `ALLOW_PRODUCTION_SMOKE=true` so
> the choice can never be made by accident.
>
> **The moment real users exist, this waiver expires** — provision staging
> before the next version bump (checklist below).

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

A smoke against anything beyond the allow-listed worker origins is an
**escape hatch that requires a separate, explicit operator decision** and must
be recorded here when used. Both `smoke-v3.mjs` and `smoke-v4.mjs` enforce this
through the shared fail-closed classifier (`worker/scripts/smoke-target.mjs`):
the FULL `SMOKE_URL` is classified, http is allowed only for local loopback,
https only for the explicit worker-origin allowlist in that module, and any
other target needs `SMOKE_ALLOW_ORIGIN=<exact https origin>` — the grant is
per-origin (never a boolean, never a hostname) and remote http is refused even
with a grant. The scripts post real, paid Arweave transactions.
(The former `ALLOW_PRODUCTION_SMOKE=true` boolean and the `*staging*` hostname
heuristic are retired: the boolean, once exported, silently authorized the
next, different target, and the heuristic was fail-open —
`staging.evil.example` matched it.)

Every staging command (`deploy:staging`, `deploy:staging:check`) is gated by
`npm run check:staging-config`, which fails with the checklist above while the
KV placeholder is still in `wrangler.toml`.

### The floor as a gate, not a discipline (D2a)

Everything above was a rule people had to remember. Since the control-plane PR
it is checked on the way out: `scripts/check-worker-floor.mjs` runs inside the
worker deploy and refuses a candidate that is not a descendant of the floor.

**How it is wired, and why exactly this way:**

- the deploy takes the commit as an **input SHA**, not as the ref it runs from,
  and is dispatched **from the default branch**. A `workflow_dispatch` takes
  its workflow from the ref it is dispatched with, so a gate living in the
  deployed code could be edited by the very commit it is meant to judge;
- the checker and the floor therefore both come from outside the candidate: the
  script from the default branch, the value from the protected Environment
  variable `WORKER_FLOOR_SHA`;
- **the candidate must be reachable from the commit the run itself is on** —
  i.e. it must be something `main` actually contains. Without that the branch
  policy is satisfied by the DISPATCH ref while the deployed code comes from
  anywhere: this job installs and tests the candidate in a runner that holds
  the Cloudflare token, so «deploy an arbitrary SHA» means «run arbitrary code
  with the deploy credentials in scope». Ancestry, not equality, so every
  commit `main` ever contained stays deployable and rollbacks keep working;
- the candidate is therefore materialized with `git worktree` out of the
  history already fetched — no second checkout, no network, no credential left
  behind for it to find — and only AFTER the gate has answered;
- the checkout uses `fetch-depth: 0`, because ancestry cannot be computed from
  a shallow clone.

**`WORKER_FLOOR_SHA` is the source of truth; the tag is a label for humans.**
Tags move. A moved tag would silently lower the floor, so the checker refuses a
tag name outright rather than resolving it — the variable holds the full
40-character SHA or nothing.

**An unset variable is a REFUSAL, not «no floor yet».** It is tempting to read
it the other way, because the SEMANTIC floor (D2a) is raised only just before
the import flip. But a floor already exists and is recorded above: `worker-r3`
is ABSOLUTE — every build below it answers 400 to App-Version=4 uploads and
safebox data exists. A gate that passed with no configured floor would be a
no-op standing in front of a constraint that already binds.

So the variable is **initialized now**, with the data floor, and the future
flip is a **raise** rather than a first filling:

| When | `WORKER_FLOOR_SHA` | Why |
|---|---|---|
| ~~2026-08-28 → 2026-08-29~~ | ~~`931949150f6145b6c79d36dbadc66b482c1cb6d1` (`worker-r3`)~~ | superseded by the row below |
| **in effect since 2026-08-29** | **`ff0954d1799c2dc0534a4ab73c6d11d3e01645f1`** (PR-3a) | below it a lone gateway 404 authorizes a PAID re-post, and `/health` carries no attestation. `MINIMUM_FLOOR` was raised to the same SHA, so the variable can no longer be edited back down |
| before the import flip (D2a) | the semantic-idempotency worker's SHA | the client stops accepting a `txId` without the capability marker |

**What only the operator can do** (no PR can, and none should pretend to):

1. ~~**set `WORKER_FLOOR_SHA`** in the `dev` Environment to
   `931949150f6145b6c79d36dbadc66b482c1cb6d1` (`worker-r3`)~~ — **reported set
   by the operator 2026-08-28** (not independently verified here: the variable
   is protected and no repository check can read it; the first deploy dispatch
   proves it either way, since without the value the run refuses outright).
   Until it is set the worker deploy refuses to run at all — deliberately: the
   floor exists whether or not the variable does;
2. ~~restrict the Environment's **deployment branches** to the default
   branch~~ — **done** (verified 2026-08-28: policy is branch-only, `main`).
   That policy, not the guard step inside the workflow, is the real boundary:
   a branch that wanted to remove the guard would simply remove it;
3. **forbid administrative bypass** on the Environment — **still open**
   (verified 2026-08-28: `can_admins_bypass = true`). By default admins may
   bypass protection rules, and a «hard floor» an admin can wave through is a
   soft one;
4. keep to the operational ban above: no dashboard rollback, no bare
   `wrangler rollback`;
5. **do not dispatch the next worker deploy until the previous run has
   finished.** `concurrency` in the workflow prevents overlap and protects a
   running deploy from being cancelled, but GitHub keeps only one pending run
   per group and promises nothing about the order queued runs start in. The
   ordering rule is yours, not the workflow's.

**Rehearsal — on the real workflow, not as a unit test.** The obvious version
of it («deploy something with no floor, then set the floor and watch the same
deploy be refused») cannot be run: with the variable unset nothing deploys at
all, and there is no SHA that both passes without a floor and is blocked by
`worker-r3` — anything below `worker-r3` is already forbidden. So the rehearsal
is done in the direction that deploys nothing dangerous:

1. set `WORKER_FLOOR_SHA` to the `worker-r3` SHA above;
2. dispatch the deploy for **the SHA that is currently live** — see «What is
   actually deployed» below; as of 2026-08-28 that is
   `45866b9bb9ae5c8c92d031f4e62e67be50d71949`. It passes the gate (a commit is
   its own descendant) and genuinely redeploys what is already running, so the
   rehearsal changes nothing.

   > **Corrected 2026-08-28.** This step used to say «dispatch `worker-r3`
   > itself — it redeploys what is already live», on the strength of a claim
   > that `main` carried 17 undeployed worker commits. **Both halves were
   > wrong, and the instruction was dangerous.** Those 17 commits are exactly
   > what the 2026-08-22 deploy SHIPPED, so `worker-r3` is not what is live —
   > it is 17 commits BEHIND it. Dispatching it would have been a silent
   > production DOWNGRADE that passes the gate (`worker-r3` is an ancestor of
   > the live SHA, and the gate checks ancestry from the floor, not distance
   > from HEAD): the metrics transport of PR-2, the `@noble/ed25519` 2.x→3.1
   > migration on the signature path and the global `UPLOADS_ENABLED` switch
   > would all have been removed from the running worker by a step labelled
   > «rehearsal».
   >
   > The error came from counting commits since the last release TAG instead
   > of since the last DEPLOY. The two had drifted by four deploys — which is
   > the second defect this correction fixes, below. **Read the deploy history,
   > not the tag list, when you need to know what is running.**

   **NOT the head of `main`** either — but for a smaller reason than the old
   text gave: the head differs from the live worker by one devDependency bump
   (`a9a2346`), so dispatching it is a (tiny) release with a registry entry,
   not a rehearsal step;
3. dispatch it for `cd7524e`'s full SHA (`worker-r2`, below the floor) — the
   run must stop at the gate, **before** the candidate is materialized, and
   nothing may reach Cloudflare;
4. dispatch it for a commit that exists only on an unmerged branch — the run
   must stop at the same gate, with the «not reachable from the trusted head»
   message;
5. dispatch it for an intermediate commit of a merged PR — refused too: only
   the head of `main` and allowlisted SHAs are deployable, because every
   mid-review state is also an ancestor of `main` and none of them was ever
   judged as deployable;
6. record all five run ids here.

**When the floor is later raised** (before the import flip), the order matters:
deploy the semantic worker first and verify `/health` reports
`semanticIdempotency: 1`, and only then raise the variable to that SHA. Raising
it first would leave nothing deployable — the live worker would already be
below the new floor.

**Two floors, and they are enforced by different things.** The worker floor is
this gate. The CLIENT floor is `DB_VERSION`: today `client-r4` (IndexedDB v2);
when the backup track's first release ships as `client-b1` it raises
`DB_VERSION` to 3, and rolling the client below that tag stops being possible
rather than merely forbidden — an older build meets a newer database and shows
the non-destructive «update the app» screen. Until `client-b1` exists, the
client floor in force is still `client-r4`.

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
    **Current floor (raised when the v4-acceptor shipped, 2026-08-12):**
    `WORKER_FLOOR_TAG = worker-r3 (9319491)` — the v4-acceptor. Everything below
    it (`worker-r2` cd7524e, `worker-r1` 15b87d4c) must never be redeployed once
    safebox data exists: those builds 400 every App-Version=4 upload.
    ~~**Bounded exception, valid ONLY right now:** … rollback to `worker-r2` is
    still DATA-safe while no v4 record exists.~~
    **THE EXCEPTION IS VOID as of 2026-08-12**, the same day it was written.
    Its stated precondition — "not a single v4 record on chain" — was retired
    by the signed production smoke, which posted a real v4 record
    (`Ry0Nhrrz…`) under the smoke account's Owner-Hash. That record is operator
    test data, so no *user* data is at stake in it; the exception is
    nonetheless closed rather than reinterpreted, because W4 follows
    immediately and a floor that depends on a shifting precondition is not a
    floor. **The floor is now absolute:** `worker-r2` and below 400 every
    App-Version=4 upload and would silently stop safebox sync.
  - **SUPERSEDED BY PR-3a: a tag no longer makes a commit deployable.** Tags
    are not branch protection — unless a tag ruleset is configured and proven,
    anyone able to push one can make an arbitrary mid-review commit deployable,
    and every such commit is an ancestor of the default branch. Allowed
    rollback targets are now the SHAs listed in `scripts/release-allowlist.mjs`
    (empty by default: the normal path deploys the trusted head), and they must
    still be descendants of the floor. The list below stays as the RELEASE
    HISTORY it always was.
  - **The deploy workflow now checks this itself — see «The floor as a gate»
    below.** Two consequences, and both are operational rather than technical:
    a rollback goes through that workflow with the target's SHA, and
    `wrangler rollback` / the Cloudflare dashboard's «Rollback» button are
    **not to be used**. No repository script can intercept those two paths;
    they bypass the gate entirely, and they are exactly what a person reaches
    for at 2 a.m.
  - **What is actually deployed (added 2026-08-28).** The tag list below is a
    list of TAGS, and it stopped tracking deploys after `worker-r3`: four
    successful worker deploys followed it and none of them was tagged or
    recorded. The registry therefore said `worker-r3` while something 17
    commits newer was running, and a correction elsewhere in this runbook had
    already been built on that false reading (see the rehearsal above). The
    deploys, reconstructed from the workflow's own run history:

    | Date | SHA | Run | What it carried into the worker |
    |---|---|---|---|
    | 2026-08-20 | `b18762b` (#92) | 32409290370 | Node 24 contract, paid-smoke target classifier, dev-contour reclassification |
    | 2026-08-20 | `d54dc78` (#96) | 32418386038 | §1.9 global `UPLOADS_ENABLED` switch + machine-readable `recovery_invalid` |
    | 2026-08-22 | `158fa9e` (#106) | 32604302375 | PR-2 metrics transport + AE events + `/admin/metrics`; `@noble/ed25519` 2.x→3.1 on the signature path; `redrop_new_tx` fix for the recovery-hint branch |
    | 2026-08-22 | `45866b9` (#107) | 32604479982 | `CF_ACCOUNT_ID` for `/admin/metrics` (PR-2 provisioning). **CURRENTLY LIVE.** |

    Live `/health` (verified 2026-08-28):
    `{"ok":true,"versions":["1","2","3","4"],"uploads":true,"v3Uploads":true,"v4Uploads":true}`.

    Consequence worth stating for the Arweave track: **PR-2 «Метрики» is not
    merely merged, it is deployed** — step 2 of that plan's execution order is
    complete on the dev contour, and PR-3a is not waiting on it.

    Why they went unrecorded is worth naming, because the fix is procedural:
    the release tag is optional by design (D2a says the gate reads
    `WORKER_FLOOR_SHA`, and a tag is «зеркало, не источник истины»), and an
    optional artifact stops being written the moment nobody's build depends on
    it. The floor gate is unaffected — it never consulted this list. What IS
    affected is every human decision made by reading it, including the one
    above. **Rule from here: a deploy without a tag still gets a row in the
    table above, with its run id, on the day it happens.**

  - Allowed release tags (append on each deploy):
    - worker-r1 — 15b87d4cacbc19a3371a19b9141f1562b63781d8 (2026-07-23, first
      production worker deploy; recovery-protocol writer)
    - worker-r2 — cd7524e (2026-08-09, v3-acceptor: App-Version=3, UUIDv8
      namespace barrier, V3_UPLOADS_ENABLED kill switch, /health capability;
      prod /health verified: {ok, versions:[1,2,3], v3Uploads:true}).
      **Became the worker rollback floor when W3 shipped (2026-08-09).**
    - worker-r3 — 9319491 (2026-08-12, v4-acceptor: App-Version=4 split
      envelope `{id,mc,miv,sc,siv}`, V4_UPLOADS_ENABLED kill switch, /health
      `v4Uploads`). **DEPLOYED 2026-08-12**, Cloudflare version
      `5fcbe329-60d8-4676-9715-96c49e81453b`, prod /health verified:
      `{ok:true, versions:['1','2','3','4'], v3Uploads:true, v4Uploads:true}`.
      **Is the worker rollback floor** (absolute — see above).
      **Signed v4 smoke: PASSED against PRODUCTION on 2026-08-12**, before W4,
      discharging the waiver under which this worker shipped. All 8 checks
      green (`npm --prefix worker run smoke:v4`, `ALLOW_PRODUCTION_SMOKE=true`):
      `/health` ok + `versions∋'4'` + `v4Uploads:true`; a signed v4 upload
      accepted (`txId Ry0NhrrzhQM7EBrJ5yMc7w0LCmB_z_O2bI4NRvlTOxs`,
      `committed:true`); the repeat returned the SAME txId (idempotency holds on
      the real DO, not just in miniflare); a UUIDv4 `Note-Id` rejected 400; the
      v2/v3 data-key set rejected 400; and v3 still accepted (`txId
      ku07BASgrlY3tCo0EgxL1vdoebVpFmbnESWndHLNWNM`) — no regression for the
      format users were already writing. This closes the three gaps the waiver
      left open: signed end-to-end upload, real Arweave acceptance, and the
      live per-owner rate-limiter path.
      ⚠️ Both txIds are **permanent, paid** records under the smoke account's
      Owner-Hash. They are operator test data — never garbage-collect logic
      around them, and expect them in that account's chain listing.
- **Client (Pages):** use the Cloudflare Pages dashboard "Rollback to this
  deployment" on a previous **R-or-newer** deployment. Re-run `smoke-headers`
  afterwards.
  **Client floor since 2026-08-12: `client-r4`** (f43e503) — never below it.
  R4 raises IndexedDB to version 2 on first launch regardless of the writer
  flag, and any device that has run R4 gets a `VersionError` on a client with
  `DB_VERSION=1`. Rolling W4 → R4 is allowed and is the writer kill switch for
  the safebox; rolling below R4 is not.
  **A W4 → R4 rollback is gradual, exactly like W3 → R3**: already-loaded tabs
  and installed PWAs keep running W4 until the user accepts the update prompt,
  so they keep writing v4 locally and uploading. Observed live on the W4
  deploy: an open tab stayed on R4 until «Обновить» was clicked. The immediate
  server-side stop is `V4_UPLOADS_ENABLED=false`, not a Pages rollback.
- **CORS:** if the Pages origin changes, update `ALLOWED_ORIGINS` in
  `worker/wrangler.toml` and redeploy the worker **before** the client, and verify
  the new origin is allowed while a stranger origin is rejected.

## Multi-device sync — Phase 0 (manual «Проверить обновления»)

Client-only release: the Worker is untouched, so the roll-forward «worker first»
step does not apply. No new on-chain format, no new endpoint, no feature flag —
the client simply calls the EXISTING restore sweep on demand instead of only on
seed entry. Rollback is a plain redeploy of the previous client tag; nothing
about it is a floor.

**DEPLOYED 2026-08-13** (tag `client-sync0` = 2edec7e) on notes.matamata.dev,
run 31687866818 — all gates green (lint, 640 client tests, worker
typecheck + tests, staging config check, bundle budget 181.7 KB gz of 186 KB),
smoke-headers passed against the deployment URL.

Verified against the live site: `https://notes.matamata.dev/` returns 200 with
the CSP intact, and the deployed bundle (`index-IAnsTq5S.js`) CONTAINS
«Проверить обновления», «Получено с других устройств», «Заметки в блокчейне» and
«Передано, ждёт подтверждения» — direct evidence the new code is in the artifact,
not merely in the source.

What shipped:

- `checkForUpdates()` runs the SAME sweep restore runs (`runArweaveSweep(mode)`),
  reporting into its own `updateCheck` state so the restore banners stay
  untouched. Both modes share one `restoringRef` — two concurrent sweeps would
  double-fetch and race their merges.
- Reading Arweave needs neither the sync toggle nor a registered key (those gate
  UPLOADS), so the button works on a read-only device.
- `fetchAllNotes` throws `ArweaveIndexUnavailableError` when the FIRST GraphQL
  page fails **and the caller did not abort**. An offline device used to be told
  «часть данных недоступна» instead of «не удалось». The abort carve-out is
  load-bearing: `requestSignal` composes the caller's signal with the timeout via
  `AbortSignal.any`, so a lock and a timeout are indistinguishable by error type.
- Settings counters moved from versions to notes. «В блокчейне» counts only
  `confirmed` — the reset warning treats exactly that status as recoverable, and
  the counter must not promise more than the dialog that is about to wipe it.
  `accepted` gets its own line; the version denominator comes from the
  storage-backed aggregates, which include versions this build cannot decrypt.
- **P1 fixed in `storage.ts`**: `mergeRestoredNote` / `mergeRestoredSafeboxEntry`
  awaited `getSyncRecord()` between the caller's generation check and the write
  transaction. A reset landing in that window created its clear transaction
  FIRST, so the record reappeared in a just-wiped database. Both now re-assert
  the generation immediately before the write, exactly like `commitSafeboxEntry`.
  Reproduced before the fix and covered by a test in each store.

⚠️ **The update is prompt-gated** (same as W4): already-loaded tabs keep running
the previous build until «Обновить» in the update toast. Expect a tail of old
clients — by design, not a failed deploy.

**Two-device acceptance PASSED** (operator, 2026-08-13): notes created on one
device are pulled onto another with the `↻` button. That is the whole point of
the release and it works in production.

Still unexercised, deliberately: the repeat-check idempotency counters
(«новых заметок нет» / «в сейфе: 0» on a second press) and the safebox half of
the pull. Both are covered by tests — including a mutation check proving the
safebox counter would otherwise re-announce the entire history on every run —
but no production run has confirmed them.

### Hotfix on top of Phase 0 — the stuck privacy gate

**DEPLOYED 2026-08-13** (tag `client-sync0-hotfix1` = 66b35c0) on
notes.matamata.dev, run 31690638225 — all gates green (lint, `tsc -b`,
**643 client tests / 34 files**, worker typecheck + tests, staging config check,
bundle budget), smoke-headers passed. Client-only; the Worker is untouched.

**Reported from production on `client-sync0`:** after a long idle the app opens
as a blank page with a lone padlock, no PIN prompt, and ONLY a full close +
relaunch clears it. The padlock is `.lock-gate` — the opaque full-screen privacy
overlay at `z-index: 100`. The PIN screen is rendered underneath it, unreachable.

Two defects, both of the invariant *a locked app holds no plaintext, so no gate
may cover it*:

1. **The bootstrap lock branch never lowered the gate.** A page that wakes up
   HIDDEN (Android reloads a backgrounded PWA) raises the gate on mount, because
   the session seed still makes `vaultPresentInTab()` true. The bootstrap lock
   decision then drops that seed, sets screen `'pin'` and returns — leaving the
   gate up with nothing left that could lower it.
2. **`lockApp()` silently broke its own contract.** It returns on its first line
   when `vaultPresentInTab()` is false, while THREE call sites in
   `evaluateReturn` delegate the gate to it on the strength of its comment
   («the locked UI is non-sensitive, so no gate may be left covering it»). Once
   defect 1 removed the seed, that promise no longer held.

Both now lower the gate explicitly; `lockApp` also force-closes the safebox
first, defensively.

Tests (`privacy gate never outlives the screen it covers` in `store.test.tsx`):
the production scenario (hidden bootstrap + lock), the foreground return, and a
contract test pinning `lockApp`. The first and third FAILED before their
respective fix — each was verified in reverse.

Verified on the live site: new bundle `index-CqiIswKu.js`, CSP and
`X-Frame-Options: DENY` intact.
**NOT verified in production:** the lifecycle itself. Reproducing it needs a real
device that backgrounds the PWA long enough for the OS to reload it — that is the
operator's manual check. Everything asserted above is proven by tests, not by a
production run.

⚠️ Prompt-gated as always: an already-loaded tab keeps the buggy build until
«Обновить». A user currently stuck behind the gate must relaunch the app — which
is exactly the workaround they already found.

### PIN on restore + persistent storage (client-only)

**DEPLOYED 2026-08-14** (main `7fcc595`, PR #31) on notes.matamata.dev,
run 31790744299 — all gates green (lint, **704 client tests / 36 files**, baseline
was 643/34; worker typecheck + tests, staging config check, bundle budget
182.7/186 KB gz), smoke-headers passed. Live bundle `index-B5AX2wGH.js`; CSP and
`X-Frame-Options: DENY` verified on the origin. Client-only; **the Worker is
untouched**.

**Reported from production (desktop Chrome):** the app asks for the seed phrase
every day instead of a PIN. Two independent causes, both fixed here:

1. **The restore screen never offered a PIN.** A PIN could only be set during
   onboarding or in settings, so everyone who entered a device «by seed phrase»
   (second device, reinstall, local data loss) stayed with no `pin-seed` at all
   — and the session lives in `sessionStorage`, which dies when the last Chrome
   window closes. `Restore.tsx` is now two steps (phrase → PIN offer, skippable,
   hidden when a PIN already exists).
2. **The app never requested persistent storage.** `navigator.storage.persist()`
   was called nowhere, so IndexedDB stayed best-effort and could be evicted —
   taking `meta.init` with it, which is what makes the app look like it never
   had a vault (`src/lib/persistence.ts`).

Storage-side invariants added on the way (both в одной readwrite-транзакции
`meta`, both first-writer-wins):

- `bindVaultIdentity(pk, { initialize }, gen)` replaces the unconditional
  `setMeta('vault-public-key', …)` and writes `meta.init` in the SAME commit.
  Two tabs opening DIFFERENT seeds against an EMPTY database can no longer end
  up with one tab's key next to the other tab's PIN, and `init` can never be
  written into a database that was cleared in between.
- `commitPinSeedIfAbsent(blob, gen)` writes the restore-flow PIN only when none
  exists (and clears stale `pin-attempts`/`pin-locked-until` in the same
  commit). A PIN configured elsewhere is never replaced behind the user's back;
  the main screen says so instead (`pinSetupNotice`).

`openVault` now runs the identity transaction BEFORE `commitVaultSnapshot()` and
the session write, so a rejected open cannot leave a decrypted vault or the seed
in the tab.

**Both PIN-setting flows follow the same rule**: the PIN is an argument of the
identity-checked operation (`confirmMnemonic(mn, { pin })` /
`restoreFromMnemonic(mn, { pin })`), never a `setupPin()` before it with a
`removePin()` to undo. The old onboarding shape left a mixed race with restore:
a tab that lost the identity race could leave `vault-public-key(B)` next to
`pin-seed(A)`, or delete the PIN — and the auto-lock setting — of the vault that
won. Unconditional `setupPin`/`removePin` now live only where replacing a PIN is
the user's explicit intent: the settings screen.

Three facts were verified in reverse (each test fails against the old code):
publishing the snapshot before the identity verdict, broadcasting `config`
without the post-commit guard, and the PIN-first/undo onboarding shape.

**Accepted, unchanged residual risk:** cross-tab reset exclusivity still rests on
the `'reset'` broadcast plus each tab's own `dbGeneration` — a database cleared
by a tab whose broadcast has not arrived is indistinguishable from a
never-initialized one. This release neither widens nor narrows that window; a
persistent reset token would be a separate, project-wide change.

**Firefox compromise:** `persist()` is called (skipped only on an already-denied
permission) because gating it on a `'granted'` permission state risked never
requesting persistence in Chromium at all — the browser this fix exists for.
Firefox may therefore show its permission doorhanger once, always after a button
the user pressed; a refusal is remembered per tab (`sessionStorage`) so reloads
do not re-ask.

**Operator checks — STILL PENDING after the rollout (NOT covered by tests):**
- on a clean Chrome profile, BEFORE the first `persist()`, record
  `await navigator.permissions.query({name:'persistent-storage'})` → `state`,
  then after an unlock record `await navigator.storage.persisted()`. Write both
  values here — they are the only real evidence that cause №2 is fixed on a
  fresh origin;
- remove the PIN, close all Chrome windows, reopen: the restore screen must
  offer the PIN step, and the next launch must show the PIN screen;
- Firefox: at most one permission prompt per tab, never after a refusal.

⚠️ Prompt-gated as always: an already-loaded tab keeps the previous build until
«Обновить». No IndexedDB schema change (existing `meta` keys only) → no client
floor; rollback = redeploy the previous client build.

## Multi-device sync — Phase 1 (incremental sweep)

Client-only release: the Worker is untouched, no new on-chain format, no new
endpoint, no feature flag — the «worker first» step does not apply. Plan:
`eternal-notes-incremental-sweep-phase1.md` (4 review rounds, no blockers;
the 24-hour full-sweep threshold was confirmed by the owner 2026-08-19).

What ships:

- **Sentinel model** (`fetchAllNotes`, `opts.known`): a manual «Проверить
  обновления» no longer downloads payloads whose txId is already held locally.
  A known candidate STAYS in the ordered list and claims its Note-Id in block
  order, so duplicate resolution is bit-identical to a full sweep. A txId
  counts as known only when the edge's Note-Id tag and version class match the
  sync record too. There is deliberately NO block-height cursor — a cursor is
  the only mechanism in this design that can silently lose straggler
  transactions forever (gateway replica divergence has no published upper
  bound), and a regression test pins that no height cutoff exists.
- **Restore is ALWAYS full.** Seed entry and «Повторить восстановление» keep
  overwriting local ciphertext with known-good on-chain copies — the blind
  repair the product has relied on since R.
- **Daily full safety sweep**: a check runs full when `sweep-full-at` (new
  optional `meta` key) is older than 24 h. The mark advances only on a SUCCESS
  that was full (including restore), never on `incomplete`, generation-checked
  right before the write. The value is runtime-validated on read: corrupted
  meta (string/NaN/fraction/future) reads as «no mark» and causes an EXTRA
  full sweep, never a skipped one.
- **Targeted repair**: ids of SUPPORTED-version records that fail decryption
  (vault unlock, safebox section open, secret reveal) drop out of the known
  set, so the next incremental check re-downloads and repairs them without
  waiting for the daily sweep. In-memory per tab, cleared only by an app lock;
  a safebox-section lock does not touch note repair ids. Records from a NEWER
  app version are not «repairable» and stay skipped (double-gated: local `v`
  and the App-Version index filter).

**Accepted residual trade-offs** (documented, test-pinned):

- A redrop pair where BOTH transactions survived on-chain re-downloads the
  newer one on every check: `mergeRestoredNote` deliberately preserves a
  confirmed record's txId (recovery semantics — out of scope). One payload per
  check, rare by construction.
- Undetectable damage (a safebox row corrupted while the section stays locked)
  waits for the daily full sweep — detection requires decryption, which never
  ran.
- **Any on-chain candidate that never decrypts is permanently unknown** and is
  re-fetched on EVERY check. `known` is built from LOCAL sync records, and a
  candidate that fails `buildRestoredNote` is an intentional skip that produces
  no merge — so no sync record is ever written and the txId can never enter
  `known`. This covers both a record whose on-chain copy is corrupt (bad bytes
  paid onto Arweave before the upload) and, more commonly, **a transaction that
  simply is not decryptable by this vault** even though it carries this
  Owner-Hash. No data loss, no false error, cost bounded by the count of such
  transactions.

  **MEASURED IN PRODUCTION 2026-08-19** on the operator's own vault: 9
  transactions carry this Owner-Hash, 6 are held locally, and the remaining
  **3 are re-fetched on every check** — `Ry0Nhrrzh…`, `ku07BASgrlY3…`,
  `8bldiJx5cfEo…`. Two of those are the permanent paid SMOKE-TEST records this
  runbook documents above; they are not, and never will be, decryptable by a
  user vault. Steady state on this account is therefore 3 payload fetches per
  check (a few hundred bytes each), not zero.

  This is the evidence the plan asked for before building the deferred
  `sync-seen-tx` meta set (a persisted «fetched and rejected» txId set, which
  would take the residual to zero). It is a NEW persisted schema and needs its
  own plan + review round — deliberately not hot-patched onto this release.

Acceptance on the live site (DevTools → Network, filter `arweave.net`; there
are no new user-facing strings, so «grep the bundle» does NOT prove this
release — the network profile does):

1. first `↻` press — `/graphql` plus one `/raw/…` per transaction (the first
   check after the update is FULL: there is no `sweep-full-at` mark yet);
2. second press — every LOCALLY-HELD txId is gone from the log. What may remain
   is one `/raw` per never-decryptable candidate (see the third trade-off
   above), a repair candidate, or a redrop duplicate — none of those is a
   failed acceptance. The pass condition is «no locally-held transaction is
   re-fetched», not a literal zero;
3. create a note on the second device, press `↻` — exactly one
   `/raw/<new txId>`, and the status line reads «Проверено в HH:MM · …» with
   the note counted (the «Получено с других устройств» TOAST was removed by
   the navigation redesign — the always-visible status line replaced it, so do
   not look for a toast here);
4. offline — «Не удалось проверить обновления», the app stays alive.

**DEPLOYED 2026-08-19** (main `20b0946`, PR #53) on notes.matamata.dev,
run 32238403630 — all gates green in a clean `npm ci` checkout (lint, `tsc -b`,
**1052 client tests / 58 files**, worker typecheck + 130 tests, staging config
check, bundle budget 186.5/195 KB gz), `smoke-headers` passed against the
deployment URL. Live bundle `index-D0_-tE-x.js`; CSP and
`X-Frame-Options: DENY` verified on the origin. The bundle CONTAINS
`sweep-full-at` — direct evidence the incremental code is in the artifact, not
merely in the source (this release adds no user-facing string, so the usual
«grep the bundle for new copy» check does not apply).

**ACCEPTANCE PASSED 2026-08-19** (operator's desktop Chrome, live site, driven
through the browser extension with the vault unlocked by the operator):

- running bundle confirmed `index-D0_-tE-x.js`, service worker `activated`
  with nothing `waiting`/`installing` — the update really is applied, not
  merely published;
- **1st press: 9 `/raw` fetches** (full — no mark yet); the sweep then wrote
  `sweep-full-at = 2026-08-19T11:02:02Z`;
- **2nd press: 3 `/raw` fetches**; **3rd press: the same 3** — steady state.
  IndexedDB shows exactly 6 sync records with a txId (3 notes + 3 safebox) and
  all 6 rows present, and those 6 txIds are precisely the ones that stopped
  being fetched. **Every locally-held transaction is skipped; the 3 repeats are
  the never-decryptable ones** described in the third trade-off above;
- status line reads «Проверено в 14:03 · новых записей нет»; no console errors.

Tag `client-sync1` after acceptance. **Floors do not move**: client `client-r4`,
worker `worker-r3`. This release is NOT a floor — no IndexedDB version change,
one backward-compatible optional meta key; an older client ignores it and
simply does a full sweep every time (traffic degradation, not data loss —
compatible in both directions).

Rollback: Pages «Rollback to this deployment» to any build not below
`client-r4`, then re-run `smoke-headers`. Consequence: every check downloads
everything again, nothing else.

## Navigation redesign — stages 0–6 (client-only)

Six client-only releases; the Worker is untouched, so the «worker first» step
does not apply. Nothing here changes the on-chain format, adds an endpoint, or
introduces a feature flag.

**DEPLOYED 2026-08-15 as `client-nav1`** (`main` = `85c543d`, run
[31887203740](https://github.com/Yokogamma/payee/actions/runs/31887203740)).
All six stages went out in ONE Pages deploy, not one at a time — see «How the
stack actually merged» below for why that was not the original intent.

| Stage | What ships |
|---|---|
| 0 | Guards only: CSS-variable check, theme-palette parity, font-inlining check. Plus one fix — `var(--font-mono)` never existed, so revealed safebox passwords rendered in the UA default monospace |
| 1 | The section moves into `location.hash`. No visible change |
| 2 | Three-item nav; the safebox lock stops taking the exit with it (the reported production bug) |
| 3 | Composer collapses behind «+»; per-section search; `Ctrl+K` removed |
| 4 | One status line replaces five header icons and the banner stack; settings becomes a section |
| 5 | Warm theme; `useTheme` moves under `ErrorBoundary` |
| 6 | Outfit → Manrope (the UI face finally covers Cyrillic) |

### How the stack actually merged — a warning worth keeping

The six stages were a PR stack, each based on the one before it. Merging them
in a loop with `gh pr merge --merge --delete-branch` **closed half of them
without merging**: deleting a branch destroys the base of the next PR in the
stack, and GitHub closes a PR whose base is gone rather than retargeting it.
The result was #37 and #39 merged, #38 and #40 closed `DIRTY`, and #39's merge
landing in its own base branch instead of `main`.

Nothing was lost — the tip branch already contained every commit — and the
recovery was one PR ([#41](https://github.com/Yokogamma/payee/pull/41)) from the
tip onto `main`. But the failure mode is silent enough to be worth naming:
**merge a stack one PR at a time, letting GitHub retarget the next one, or
retarget with `--base main` before each merge. Never `--delete-branch` in a
loop over a stack.**

### Post-deploy verification (what was actually checked)

Against the live origin, not the local build:

- CSS: 16 unique `manrope-*` `@font-face` entries, zero `outfit`, zero
  `url(data:` (CSP `font-src 'self'` would have silently killed inlined fonts),
  `data-theme=warm` present, `font-mono` gone;
- JS: «Тёплая», «Сейф», «Настройки», «не настроен» all present;
- one woff2 fetched end-to-end: `200`, `font/woff2`, 7840 bytes.

Guards on the merged `main` before the deploy: lint 0 errors, `tsc -b` clean,
44 test files green, worker typecheck + tests green, bundle 183.4 KB gz against
the 186 KB ceiling, font guard 34/34.

**Device-only checks are still OUTSTANDING** and none of them can be done from
CI: standalone-PWA back gesture, BFCache, iOS keyboard versus the bottom nav,
Android `theme_color` on the warm theme, DevTools «Rendered Fonts» on a Cyrillic
paragraph, and the auto-lock lifecycle. If a report arrives that looks like any
of these, check them before suspecting the redesign.

### Hash routing is a ROLLBACK ADVANTAGE — record this before it is forgotten

The section lives in `location.hash`, and both directions across the
prompt-gated update tail are safe **by construction**:

- an OLD build loaded at `#/settings` ignores a hash it does not know and its
  whitelist parse degrades to `#/notes` — no blank screen, no 404;
- a NEW build must survive the EMPTY hash an old build left behind, which the
  canonicaliser rewrites on mount.

A pathname router would have turned any rollback into a 404 on a path the old
build never had. This is the single reason a hash was chosen over a path, and
it is worth keeping in mind before anyone «modernises» it.

### Theme rollback is safe for the same reason

`loadThemePref` parses against a whitelist, so a user who picked «Тёплая» and
then loads a build without it gets `system` — not a `data-theme` attribute
nobody styles. Keep that degradation in place when adding a theme.

### What the client floor becomes

Unchanged: **`client-r4`** stays the floor (IndexedDB v2 on first launch). None
of these stages touches storage, the sync protocol, or the crypto, so a rollback
to any tag at or above `client-r4` remains data-safe. Rolling back is a plain
Pages redeploy.

⚠️ As always, prompt-gated: an already-loaded tab keeps the previous build until
«Обновить». Expect a tail of clients on the old navigation — by design.

### Precache grew, and the bundle budget cannot see it

`scripts/check-bundle-budget.mjs` measures gzipped JS only. Stage 6 moved the
font set from 28 files to 34 while the JS number barely moved, so
`scripts/report-precache.mjs` was added to print what users actually download:

```
js                     4 files    183.4 KB gz
fonts/jetbrains-mono  18 files    128.9 KB gz
fonts/manrope         16 files    124.8 KB gz
assets                 6 files     25.5 KB gz
css                    1 file       7.1 KB gz
html                   1 file       0.6 KB gz
TOTAL                 46 files    470.3 KB gz
```

Report only, no threshold — a baseline has to exist before a gate can be honest.
Worth noting from the first run: **JetBrains Mono costs MORE than the entire UI
face**, because it ships six subsets (greek and vietnamese included) for what
draws code spans and PIN fields. Narrowing it is a separate decision with its
own measurement; it was deliberately left out of the font swap so that any
visual regression there could only have one cause.

## Section density — `client-nav2` (client-only)

**DEPLOYED 2026-08-15** (`main` = `d3469b4`, run
[31890192625](https://github.com/Yokogamma/payee/actions/runs/31890192625)).
Follows `client-nav1` the same day, after phone screenshots showed the shipped
UI did not match the approved mockup.

### What the screenshots actually showed

Measured, not eyeballed: **the shell matched** the mockup to within a couple of
pixels (status line 12.5 vs 11.5px, top bar `13px 16px 9px` vs `13px 14px 9px`,
nav 11px/20px vs 10.5px/19px, section title 16px in both). Everything INSIDE
the sections did not. Stages 3 and 4b said «move», and the content moved without
being redrawn — so a phone showed chrome where it should have shown content.

| | Before | After | Mockup at 360px |
|---|---|---|---|
| Status-line buttons | `min-width/min-height: 44px` — 88px of width, row 62px tall, text truncated at «блокч…» | 28px box, 44px target in `::after` | 43px row |
| Details panel | opened with `Заметки в блокчейне: N из M`, directly under a row already saying it | starts at the breakdown | — |
| Settings row | `.settings-block`, own card, 54px + 10px gap = **64px pitch** | one card per group, hairlines, **44px** | 44px |
| Row icons | 20px accent glyph = 31px of width | none | none |
| Create | «+ Заметка», a 44px `.btn` in the header | round «+» at the bottom | same |

### The 44px touch floor is not a 44px BOX

The single largest defect was `min-width: 44px; min-height: 44px` on
`.status-btn`. The a11y floor is real and stays, but putting it on the element
itself spent 88px of a 360px row on two icons and pushed the row 16px taller
than the design — which is why the one place the sync number appeared read
«2 из 2 заметок в блокч…». The floor now lives in an `::after` overlay that
takes no space in the flex row. **The same pattern is used by `.btn-tiny`.
Do not "simplify" either back into a plain min-height.**

### The FAB is sticky ON PURPOSE

`position: fixed` would need a `z-index`, and any `z-index ≥ 100` paints over
the privacy lock gate — invariant **I2**, which holds on source order alone.
A sticky, in-flow element with no `z-index` cannot reach that layer. It also
keeps `env(safe-area-inset-bottom)` working and stays out of the iOS keyboard's
way. See the header comment in `src/components/Fab.tsx`.

### Verified on the live origin

CSS carries `settings-rows`, `btn-tiny`, `section-chip`, `fab-slot`, `fab-mark`,
`green-line`; `notes-add` and `url(data:` are gone. JS carries «Новая заметка»,
«Запереть», «Копировать пароль», «Открыт»; «заметок в блокчейне», «Заметки в
блокчейне», «🔐 Сохранить», «📋 Пароль» are gone.

⚠️ **A plain `curl` of the origin right after the deploy returned the PREVIOUS
asset hashes** — an edge-cached HTML response, `cf-cache-status: DYNAMIC`, even
though the document is `max-age=0, must-revalidate`. A cache-busting query
string returned the new build immediately. When verifying a Pages deploy, always
bust the query string before concluding the deploy did not land.

### Still emoji, deliberately out of scope

`SafeboxHistoryModal` («👁 Показать пароль этой версии») and the note card menu
(«📋 Копировать текст»). Both live inside modals the mockup does not cover.

### Floor

Unchanged: **`client-r4`**. This release touches presentation only — no storage,
no sync protocol, no crypto. Rolling back to `client-nav1` or any tag at or
above `client-r4` is a plain Pages redeploy.

## Hotfix on top of `client-nav2` — the stuck privacy gate, round 2

**DEPLOYED 2026-08-15** (tag `client-nav2-hotfix1` = c7c9c65) on
notes.matamata.dev, run 31891951041 — all gates green (lint, **795 client
tests / 45 files**, baseline was 791/45; worker typecheck + tests, staging
config check, build, bundle budget 183.4/186 KB gz, font guard),
`smoke-headers` passed on the deployment URL. Client-only; the Worker is
untouched.

**Reported from production again:** the same padlock as `client-sync0-hotfix1`
— app locked, no way to enter the PIN, cleared only by a relaunch.

That hotfix closed two paths, and both answered the question *who lowers the
gate*. Both assumed the return-verdict ARRIVES. It does not have to.

The verdict waits on ONE IndexedDB config read. A read that **rejects** already
fails closed (lock → PIN screen). A read that **never settles** held the gate
open forever: nothing to catch, and no deadline. IndexedDB stalls precisely in
this lifecycle — a connection suspended on BFCache entry, a transaction opened
around freeze/discard, an upgrade blocked by another tab. Every later
hide/return raised the gate again, so only a relaunch cleared it.

Two changes, both in `store.tsx`:

1. **`VERDICT_DEADLINE_MS` = 5 s for the WHOLE verdict** (one deadline across
   all five attempts, not per attempt). Expiry joins the unreadable-config
   branch — fail **CLOSED**: a stall is not evidence that the vault is safe to
   show. The console line to look for is
   `auto-lock config re-read failed or timed out`.
2. **A dead-man's handle on the gate itself.** While it covers a tab the user
   is actually looking at: at 1.5 s it explains itself («Проверяем
   авто-блокировку…»), at 6.5 s — past the verdict's own deadline — it offers
   «Ввести PIN», which is just `lockApp()` (locking is never a privacy
   downgrade and always lands on a screen with an input). The timer re-arms
   while the tab is hidden rather than being armed by the return event: the one
   thing a wedged tab cannot be relied on to deliver is an event.

The `.lock-gate-note` / `.lock-gate-exit` CSS shipped ahead of its markup in
`client-nav2` (dead rules); this release activates it. Their `[hidden]` rules
are load-bearing exactly like `.lock-gate[hidden]` — `.btn` sets
`display:inline-flex` at equal specificity, which would leave the button on
screen from the start and turn the padlock into a permanent «lock the app»
prompt. Verified in a real browser, not jsdom: gate raised alone keeps both at
`display:none`.

Tests (four, in `privacy gate never outlives the screen it covers`), each
verified IN REVERSE — every one fails without its own half of the fix: the
deadline (fails without `withDeadline`), the notice, the escape hatch with **no
return event at all**, and the guard that both stay mute over a background tab
(fails if the reveal ignores visibility).

### Verified on the live origin

`index-ezJWfOkk.js` — identical hash to the run's build; the fetched bundle
carries «Проверяем авто-блокировку», «Ввести PIN» and `config read exceeded`.
CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` present on the
custom domain.

**NOT verified in production:** the lifecycle itself, again. Reproducing a
wedged IndexedDB needs a real device that backgrounds the PWA long enough — the
operator's manual check. Everything above is proven by tests and by the shipped
asset, not by a production run. If the padlock returns, the shape of the report
now discriminates: a visible «Ввести PIN» button means the gate stuck on a path
still unknown (and the user is no longer locked out), while an app that drops to
the PIN screen by itself after ~5 s means the deadline did its job.

⚠️ Prompt-gated as always: an already-loaded tab keeps the old build until
«Обновить». A user currently stuck behind the gate must relaunch the app.

### Floor

Unchanged: **`client-r4`**. Lifecycle and presentation only — no storage, no
sync protocol, no crypto. Rolling back to `client-nav2` or any tag at or above
`client-r4` is a plain Pages redeploy (and reinstates the stuck gate).

## PIN-path and vault-open races — `client-pin1` (client-only)

Stage P of the quick-unlock plan, shipped on its own **before** any of that
feature: four pre-existing production races, all on paths the feature would
later reuse. Nothing user-visible changes, no flag was flipped, and no line of
the quick-unlock feature is in this release.

What it closes:

1. **A reset during Argon2id (~1 s).** `unlockWithPinAction` metered, wrote the
   lockout and re-wrapped the legacy blob with no reset guard at all, so
   «Удалить всё» landing inside that second could leave `pin-attempts`,
   `pin-locked-until` or `pin-seed` behind in a database that had just been
   cleared — the `resetAll` invariant, broken by the unlock flow finishing
   afterwards.
2. **A cross-tab PIN change.** `dbGeneration` does not move for it (same
   database), so a verdict produced against blob A metered configuration B —
   and on the 10th strike WIPED it. Each commit now re-reads `pin-seed` inside
   its own transaction and refuses unless it is still byte-for-byte the blob
   that was checked (`pinSeedEquals`, every normative field including `v` and
   the whole Argon2 profile).
3. **A lock inside the `bindVaultIdentity` window.** `openVault` cleared
   `vaultOpAbortRef` right after `prepareVaultSnapshot`, so during the identity
   transaction the tab held nothing lockable: `lockApp()` took its
   `!vaultPresentInTab()` early exit WITHOUT bumping the epoch, the post-bind
   epoch check passed, and the vault was published against the lock verdict.
   Reachable from the ordinary «Сразу» auto-lock on a return to foreground.
   The controller now lives for the whole run and is cleared only when the ref
   still holds THIS operation's — the discipline `runArweaveSweep` already
   followed.
4. **A reset between the PIN commits and `openVault`.** The commits refuse to
   write, but `openVault` then captured a FRESH generation, re-bound the old
   seed into the wiped database and published mnemonic, keys and session. It
   now accepts an optional `expectedDbGeneration` and stands down
   synchronously — before touching the shared abort ref, so a departing call
   cannot cancel somebody else's in-flight operation.

Also recorded as behaviour, not left to chance: **the bind transaction is the
point of no return for IDENTITY.** A bind that started before a lock or a
preemption RUNS TO COMPLETION, so with `initialize` both `vault-public-key`
and `meta.init` land. That is deliberate first-writer-wins — the vault is not
published, a retry with the SAME seed binds `'same'` and succeeds, a DIFFERENT
seed gets `'foreign'` → `VaultMismatchError` with its explicit reset.
Preemption governs PUBLICATION only, never identity.

**DEPLOYED 2026-08-19** (main `5c60857`, PR #56, tag `client-pin1`) on
notes.matamata.dev, run 32262237375 — all gates green in a clean `npm ci`
checkout (lint, `tsc -b`, **1086 client tests / 58 files**, worker typecheck +
130 tests, staging config check, bundle budget and font guards),
`smoke-headers` passed against the deployment URL. **The Worker was NOT
deployed** — this release does not touch it.

### Verified on the live origin

Live bundle `index-BTbSf7zD.js`. It contains the string `config-changed`, which
did not exist anywhere in the source before stage P — direct evidence that the
artifact carries the new code rather than a cached older build. This release
adds no user-facing copy, so the usual «grep the bundle for new text» check does
not apply, exactly as with `client-sync1`. `smoke-headers.mjs` run against
`https://notes.matamata.dev` reports CSP, `X-Frame-Options`, `nosniff` and
`Referrer-Policy` present on the custom domain.

**ACCEPTED 2026-08-19** — the operator ran the manual check on the live origin
and reported the PIN path working. That is what this release needed to
establish: it changes no user-facing behaviour, so acceptance is the absence of
a regression on the ordinary path (a correct PIN opens the vault, a wrong one
is refused and counted, the app unlocks again after an auto-lock), not a new
capability to demonstrate.

**NOT established by that acceptance — read before trusting this section:**

- **The four races themselves.** All are timing windows: a reset landing inside
  a ~1 s KDF, two tabs changing a PIN at the same moment, a lock arriving
  during an IndexedDB transaction, a reset between the last guarded commit and
  `openVault`. None is reachable by hand on purpose. They are proven by
  deterministic tests — and each new guard test was additionally confirmed to
  FAIL with its own fix reverted, so the tests are known to discriminate rather
  than merely pass. A production run neither confirms nor refutes them.
- **The 10-strike wipe.** It destroys a working PIN configuration, so it is not
  something an operator re-runs on a live vault, and it should NOT be assumed
  covered by the acceptance above. Its guarantee stays where it has always
  been: `commitPinUnlockFailure` wipes inside the SAME transaction that meters
  the 10th attempt (storage tests), and the store publishes the cleared state
  and the cross-tab notice afterwards (store tests). If it is ever exercised
  deliberately on a throwaway vault, record the result here.

If a PIN-path complaint arrives later, this ordering is the useful one: an
attempt counted twice or not at all points at the metering commit; a lockout
that outlives its window points at `pin-locked-until`; a vault that opens right
after «Удалить всё» points at the generation handover into `openVault`.

⚠️ Prompt-gated as always: an already-loaded tab keeps the old build until
«Обновить».

### Floor

Unchanged: **`client-r4`** / **`worker-r3`**. `DB_VERSION` stays 2, no schema
change, no new meta key, no sync-protocol or crypto change — the PIN blob
format is untouched (the ownership check compares the existing fields; no
`configId` was added). Rolling back is a plain Pages redeploy of
`client-sync1`, and it simply reinstates the four races.

## «Быстрый вход» (WebAuthn PRF) — `client-qu1` / `client-qu2`

A second key to the SAME seed, opened by the device's own verification
(Windows Hello, Touch ID / Face ID, or a device passcode). It is an
ACCELERATOR, not a replacement: the PIN stays, which means the attacker still
picks the weakest wrapper and the vault's strength does not increase. That is
stated in the settings copy, in those words, and a test asserts the sentences
are in the DOM.

The feature is never called «биометрия» anywhere the user can see. WebAuthn
user verification is satisfied by a Windows Hello PIN or a device passcode just
as well as by a fingerprint, and the platform gives the web no way to tell —
so naming a modality on the button would be a lie.

### Two releases, deliberately

1. **`client-qu1`** — the whole feature merged with **`QUICK_UNLOCK_ENABLED =
   false`**. Users see nothing new; the code bakes in production. The flag
   contract is PER OPERATION: setup and unlock are gated, while READING the
   record and REMOVING it never are. That asymmetry is what makes a rollback
   safe — a user who configured quick unlock on a build with the flag on must
   still find the block, and a «Удалить быстрый вход» button in it, after the
   flag goes back off.
2. **`client-qu2`** — one commit flipping the flag, after the manual device
   acceptance below. Nothing else changes.

### What the format is, and why floors do not move

`quick-unlock-seed` is an ordinary string in the `meta` store: **`DB_VERSION`
stays 2**, and the floors stay **`client-r4`** / **`worker-r3`**. An older
client does not know the key and ignores it; a newer one accepts everything an
older one wrote. The Worker and the on-chain protocol are not involved at all —
WebAuthn is not a network call, so the **CSP is unchanged** too
(`publickey-credentials-get`/`-create` are not listed in `Permissions-Policy`;
their default allowlist is `self`, which is what we need, and the app cannot be
framed — `frame-ancestors 'none'`).

Crypto, for the record: `HKDF-SHA256(ikm = PRF output, salt = a random 32-byte
hkdfSalt, info = "eternal-notes-quick-unlock-v1")` → AES-256-GCM over the
mnemonic. The `info` is mandatory and versioned — using a raw PRF output as a
key, or skipping `info`, are the two canonical PRF anti-patterns — and it is
also what would keep a future contour (a safebox one, say) cryptographically
independent on the SAME passkey. `deriveKey`, the `eternal-notes-v1` salt and
the Argon2id profile are untouched.

### The compatibility hole, and the rule that closes it

A client from `client-r4` up to `client-pin1` clears the PIN — manually or
through the 10-strike wipe — with a `clearPinConfigMeta` that knows nothing
about `quick-unlock-seed`. It would leave a working quick entry to a vault
whose PIN is gone.

Closed by a rule applied on **every read**, not just at startup: **no
`pin-seed` ⇒ the record is void** — ignored, and cleaned up. It doubles as the
product rule («quick unlock only on top of a PIN»), so it is one invariant
working in both directions rather than a compatibility patch. From this release
on, the wipe itself is atomic: the record is deleted in the SAME transaction as
`pin-seed`.

### Invariants worth not rediscovering

- **The PIN meter is untouchable.** No quick-unlock outcome — cancel, timeout,
  no PRF, corrupt record, GCM mismatch, foreign vault — reads or writes
  `pin-attempts` / `pin-locked-until`. An active PIN lockout does NOT block
  quick unlock (different contour, hardware rate limit), and a successful quick
  unlock does NOT clear the PIN counters.
- **`userVerification: 'required'` in both ceremonies, forever.** Unwrapping the
  seed is always behind a system check. Changing the policy ⇒ a new record `v`:
  the spec does not guarantee the PRF output survives such a change.
- **Never store a blob we have not opened.** `prf.enabled === true` is a
  promise, not a fact, and known WebKit bugs (311099, 314934) returned garbage
  and null on create. So setup always runs a control `get()` and wraps the seed
  with THAT output — the path every later unlock takes. The price is two system
  prompts during setup; a blob that cannot be opened is worse than no feature.
- **`NotAllowedError` is a catch-all BY DESIGN of the spec** — cancel, timeout
  and «that credential is gone» are indistinguishable for privacy reasons. It
  therefore deletes nothing and claims nothing. The only silent outcome is our
  OWN AbortError (a lock, a reset, an unmount).
- **A record is deleted only on an `OperationError` from `subtle.decrypt`
  itself**, and even then CONDITIONALLY: another tab may have re-configured
  meanwhile, and `dbGeneration` does not move for that.
- **Setup is first-writer-wins.** Two tabs configuring at once: one writes, the
  other is told so and clobbers nothing.

### Manual acceptance — MANDATORY before `client-qu2`

Automated tests prove nothing about whether PRF works: only hardware knows.
Re-check the minimum browser/OS versions against live sources immediately
before running this — support moves fast (Firefox Android gained PRF between
two revisions of the plan).

- **iPhone (iOS 18.4+)**: Safari AND the installed PWA separately. Setup, entry,
  cancelling the sheet; delete the key in the Passwords app → a neutral «не
  выполнен», the record NOT auto-deleted, PIN entry still works. The PWA has
  its own IndexedDB — configuring again there is expected, not a bug.
- **Android**: Chrome and the installed PWA. Same, plus entry from the lock
  screen and behaviour with the fingerprint disabled in the system.
- **Windows Hello laptop**: Chrome AND Edge, 147+, 25H2 with KB5077181; and
  separately a machine WITHOUT that update, where the honest «не
  поддерживается» must appear instead of a silent failure. Test the Hello PIN,
  not only the fingerprint.
- **End to end everywhere**: setup at «Сразу» shows the explanation and no
  button; setup at «5 минут» succeeds and then «Сразу» still unlocks; two tabs
  reconcile; removing the PIN removes quick unlock; 10 wrong PINs remove both;
  reset removes the record; the sheet stays local (`transports: ['internal']`)
  and refusing a «another device» offer leaves the record intact; airplane mode
  works (no network involved).

### `client-qu1` — DEPLOYED 2026-08-19

main `2ed5b98` (PR #59), tag `client-qu1`, run 32292249783 on
notes.matamata.dev. All gates green in a clean `npm ci` checkout (lint,
`tsc -b`, **1257 client tests / 64 files**, worker typecheck + 130 tests,
staging config check, bundle budget **189.3 / 195 KB gz**, font guard),
`smoke-headers` passed against the deployment URL and re-run against the custom
domain. **The Worker was NOT deployed** — untouched by this release.

**What actually reached the artifact — read this before assuming «the code is
baking in production».** Live bundle `index-DpOYaNfh.js` contains
`quick-unlock-seed` and the «Быстрый вход» strings, and does NOT contain
`eternal-notes-quick-unlock-v1` or `already-configured`. That is correct and
expected: the bundler resolves `QUICK_UNLOCK_ENABLED` to `false` and eliminates
everything behind the two `if (!QUICK_UNLOCK_ENABLED) throw` gates, i.e. the
bodies of `setupQuickUnlock` and `unlockWithQuickUnlock`. The UNGATED half —
the record schema, the four-key reader, the commits, the «no pin-seed ⇒ void»
cleanup, the settings block and its removal button — IS shipped, which is
exactly the flag contract.

Consequence, and it is the point of the two-release split: this deploy proves
the ungated half and the absence of a regression; it does NOT exercise the
ceremonies. Those ship with `client-qu2`. The manual acceptance below therefore
has to run against a temporary flag-ON build (local or a separate preview), not
against production — as the release order already states.

**NOT verified by this deploy:** everything the flag gates, plus the four races
closed in `client-pin1` (timing windows, proven by tests). What IS verified is
that the app still boots, the PIN path is unchanged, and no quick-unlock UI
appears for a user who has no record.

### `client-qu2` — DEPLOYED 2026-08-19, THE FEATURE IS LIVE

main `4a2c798` (PR #61), tag `client-qu2`, run 32294225175. One line:
`QUICK_UNLOCK_ENABLED = false → true`. Nothing else in production code changed.
All gates green; bundle **191.9 / 195 KB gz**; `smoke-headers` passed against
the deployment URL and re-run against the custom domain.

Verified on the live origin: bundle `index-Ul18PfRV.js` contains
`eternal-notes-quick-unlock-v1`, `already-configured`, «Настроить быстрый вход»
and the WebAuthn `publicKey` options — i.e. the ceremony bodies the flag-off
build had eliminated are now genuinely shipped.

**THE RELEASE ORDER WAS INVERTED, deliberately, by the operator.** §14 puts the
§13 hardware acceptance BEFORE the flag; here the flag went first and the
acceptance runs on production. The reasoning, recorded so a future reader does
not mistake it for an oversight: the feature is fail-safe by construction — no
PRF, a GCM mismatch, a cancelled sheet, a deleted passkey all end in an honest
refusal with PIN entry intact, and NO outcome touches `pin-attempts` /
`pin-locked-until`. The worst case is «the accelerator does not work here»,
which is the same case the support matrix predicts anyway.

What that costs: if PRF turns out broken on a given platform, a real user meets
the failure instead of the operator meeting it on a preview build. Rollback is
a redeploy of `client-qu1` — the feature disappears from the UI, and any record
already written stays readable (an older client ignores the key).

### Acceptance — Android, the workaround, and what it cost

**UNBLOCKED 2026-08-20 (tag `client-qu2-hotfix1`): quick unlock works on the
OnePlus 12 (installed PWA) and on one Windows PC with a fingerprint reader.**
The change that unblocked it was `residentKey` — a confirmed workaround, not a
proven cause; see below for why the distinction is kept. Read the rest of this
section before touching that setting again.

**How it started. OnePlus 12 / Android 16 / installed PWA, 2026-08-19 — SETUP
FAILED: the credential was created, the platform then returned no PRF.** The
capability probes had said «go ahead» — which is exactly the case §3 predicts
and the reason the design treats a real ceremony, not a probe, as the only
authority.

Two defects surfaced with it, and the second was the serious one:

1. The message was jargon («это устройство не выдаёт PRF») and its instruction
   was wrong twice over: with `residentKey: 'discouraged'` the leftover
   credential may not be VISIBLE in the manager at all, and leaving it is
   harmless — it opens nothing. Nothing told the reader the one thing that
   mattered: nothing is broken, the PIN still works.
2. The block stayed in «не настроен» WITH the setup button. So the only obvious
   next action — press it again — minted another unusable platform credential,
   every time. A dead end that punishes the user for trying to fix it.

Fixed in `b9d3722` (PR #63): `QuickUnlockUnavailableError` now carries the
verdict a ceremony PROVED, the store publishes it and makes it sticky for the
session, so a later probe cannot put the button back with an optimistic
`'unknown'`. A transient environment failure carries no verdict and leaves the
capability alone — it proves nothing about the device. All refusal copy was
rewritten without jargon, each line ending in what the reader can DO.

**KNOWN LIMIT of that fix:** the verdict does not survive a reload. After a
restart the button returns and one more orphaned credential can be created.
Persisting it needs a new meta key and was not added silently.

**A CONFIRMED WORKAROUND — not a proven cause.** `residentKey: 'discouraged'`
→ `'preferred'` (`1a90c13`, PR #65), and the retry on the same device
succeeded. That is a working hypothesis confirmed on THIS combination, and the
wording matters, because two things stop it short of a diagnosis:

1. **One success, on one unrecorded configuration.** A single retry on a single
   device, and neither the browser build nor the selected credential provider
   was written down — the two things that actually decide whether PRF is
   available on Android. Repeatable ≠ explained.

   (An earlier version of this list also called `credProps: true` a second
   variable that might have influenced provider routing. That was wrong:
   `credProps` is a CLIENT registration extension — it has no authenticator
   extension input and no authenticator processing at all, so it cannot reach
   the authenticator, let alone steer which provider takes the request. It
   only reports `rk` back from the client. See WebAuthn L3 §10.4.)
2. **The mechanism was never observed.** An earlier version of this section
   claimed a missing PRF is «the signature» of a non-discoverable credential.
   It is not: CTAP requires `hmac-secret` support for discoverable and
   non-discoverable credentials alike, and `'preferred'` may still yield a
   plain server-side credential. The plausible story is ROUTING — on Android
   the request goes to different credential providers, and what you ask for
   influences which one takes it — but `credProps.rk` was NOT read on the
   successful run, so even «the credential is now discoverable» is an
   assumption. It is requested and logged on both no-PRF paths now, so the
   next failure anywhere will say more.

**The price, accepted knowingly:** the key MAY now become visible in the system
password manager and, on a syncing provider, synced — `'preferred'` asks, it
does not guarantee, and again `rk` was not observed. If it does, it can also be
deleted by hand, which §2 already covers: losing it costs only the accelerator,
never the data.

**Do not «tidy» this back to `'discouraged'`.** The original rationale («do not
clutter the passkey list, lower the chance of an accidental deletion») reads
perfectly sensible and was written on the assumption that the choice was free.
It is not. That assumption cost one failed acceptance, two UI defects and three
releases to unwind.

### §13 — PARTIAL hardware smoke, not a completed acceptance (2026-08-20)

Two devices were smoke-tested. That is not the §13 matrix; calling it one would
turn «the platform that was broken now works» into «the feature is accepted».

| Platform | Result |
|---|---|
| Android — OnePlus 12 / Android 16 / **installed PWA** | **PASS**, after `residentKey: 'preferred'` |
| Android — **Chrome tab** (not the PWA) on the same device | not run |
| Windows PC — **fingerprint** | **PASS** |
| Windows — **Hello PIN** rather than the fingerprint | not run |
| Windows — which browser, and Chrome vs **Edge** | not recorded / not run |
| iPhone — Safari | not run |
| iPhone — installed PWA (its own IndexedDB; configure again there) | not run |
| A machine WITHOUT KB5077181 — must say «не поддерживается», not fail silently | not run |
| macOS Safari (optional second Keychain) | not run |

The two passes are real and they cover the platform that was broken. What they
do NOT cover is the whole point of the remaining rows: an installed PWA and a
plain Chrome tab are not the same client on Android, Hello PIN and a
fingerprint are different verification methods, Edge is a different WebAuthn
client from Chrome on the same OS, iOS is a different WebKit/Keychain path
entirely, and the no-KB5077181 machine is the only way to see whether the
HONEST refusal appears rather than a silent failure — the one behaviour the
support matrix cannot predict and the tests cannot exercise.

Scenario coverage on the two passing devices is also partial: the end-to-end
list (setup at «Сразу» shows the explanation and no button; two tabs reconcile;
removing the PIN removes quick unlock; 10 wrong PINs remove both; reset removes
the record; refusing an «another device» offer leaves the record intact;
airplane mode) has not been walked through and reported.

### Bundle budget — worth watching now

With the flag on, the client sits at **191.9 KB gz against a 195 KB ceiling**:
**3.1 KB of headroom**, down from 5.7 with the flag off. The next feature of any
size will hit it. Raising the ceiling is a decision, not a formality — the
number exists because this is a PWA people install on phones.

### Rollback

Redeploy **`client-pin1`** to undo the whole feature, or **`client-qu1`** to
keep the code and only hide it (the flag). Data is unaffected either way:
`quick-unlock-seed` is an unknown meta key to `client-pin1`, which ignores it.
The one trace is that removing the PIN there leaves the record orphaned — and
the next newer client deletes it on its first read, by the rule above.

## Wallet (owner) rotation — TRUSTED_OWNERS runbook

Restore trusts ONLY transactions signed by the wallets pinned in the client's
`VITE_TRUSTED_OWNERS`. Rotating the server wallet in the wrong order makes old
notes unrecoverable for every client built without the old owner.

> **Updated for D2 (semantic idempotency).** There are now THREE places that
> hold this list, not one, and the worker has a hard runtime dependency on it:
> `/upload` answers 503 while its own signing wallet is outside `TRUSTED_OWNERS`.
> Switching `ARWEAVE_JWK` first therefore takes uploads DOWN rather than merely
> degrading restore. The order below is unchanged in spirit and now has one more
> step before the switch.
>
>  - `scripts/owner-pins.mjs` — the repo-pinned HISTORICAL registry. Append-only;
>    `scripts/check-trusted-owners.mjs` refuses a deploy whose configured sets do
>    not contain all of it, and refuses a client/worker divergence.
>  - `worker/wrangler.toml` — `TRUSTED_OWNERS` in **both** tables (`[vars]` and
>    `[env.staging.vars]`; a named environment inherits nothing).
>  - `VITE_TRUSTED_OWNERS` — the client build.

Order:

1. **Add** the NEW wallet's address to `scripts/owner-pins.mjs` (both
   `HISTORICAL_OWNERS` and `NEVER_REMOVE`) **and** to both `TRUSTED_OWNERS`
   tables in `worker/wrangler.toml`, in one reviewed pull request.
2. **Add** it to `VITE_TRUSTED_OWNERS` (comma-separated, old + new) in the
   deploy variables.
3. **Deploy the WORKER** with both owners. Until this lands, the worker cannot
   authenticate publications signed by the new wallet.
4. **Deploy the client** with both owners and VERIFY restore returns notes
   posted under the old wallet.
5. **Only then** replace `ARWEAVE_JWK` on the Worker with the new wallet.
6. **Never remove old owners** — from any of the three places. Transactions
   signed by a dropped address stay on chain forever and become permanently
   unverifiable: restore loses them, and `/upload` starts answering
   `id_payload_conflict` for records that point at them.
7. **Do NOT rotate `RECOVERY_HMAC_SECRET` together with the JWK** — outstanding
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

## PR-2 «Метрики» — transport adapter + Analytics Engine (worker-only)

What ships: an explicit Arweave transport adapter
(`worker/src/arweave-transport.ts` — anchor/price are explicit `fetch`es
handed to the SDK pre-loaded, so `createTransaction` makes no hidden network
calls), Analytics Engine events (schema and semantics: `docs/METRICS.md`),
and `POST /admin/metrics` behind the DEDICATED `METRICS_ADMIN_SECRET`. The
client is untouched.

**Rollback = redeploy the previous worker.** Metrics simply stop being
written. The external `/upload` request/response contract and the durable DO
schema are UNCHANGED — the previous worker just returns the prior SDK
transport (PR-2 does change the transport of the paid path; what stays
invariant is the contract). No floor moves.

**Release-notes honesty (P0 r18) — two known paid-path risks PR-2 does NOT
close, stated plainly:**

1. the ambiguous POST exception: a gateway-ACCEPTED transaction with a lost
   response still ends in `safeRelease` and a possible second paid POST on a
   client retry — closed only by durable same-signed-tx in PR-3b;
2. the single-gateway `404/400 → dead` verdict from `arweave.net` alone —
   closed only by the PR-3a status quorum.

Pace (owner): after PR-2 merges, run one–two weeks of metrics, then PR-3a.

### Operator provisioning (endpoint is 503 until then; writes work anyway)

1. `wrangler secret put METRICS_ADMIN_SECRET` (dev; `--env staging` when
   staging is provisioned). Generate: `openssl rand -base64 32`.
2. Create the Analytics token in the Cloudflare dashboard — scope
   **`Account → Account Analytics → Read`, this ONE account, nothing else**
   (the scope honestly reads analytics of the whole account — see
   `docs/SECRETS.md`). Then `wrangler secret put CF_ANALYTICS_TOKEN`.
3. Fill `CF_ACCOUNT_ID` in `worker/wrangler.toml` `[vars]` (both blocks; the
   same value as the Actions `CLOUDFLARE_ACCOUNT_ID` variable) and deploy.
4. Verify:

   ```bash
   curl -sS -X POST https://<worker>/admin/metrics -H 'Content-Type: application/json' -H 'Authorization: Bearer <METRICS_ADMIN_SECRET>' -d '{"report":"gateway_health","hours":24}'
   ```

### Dev-smoke acceptance checklist (P2 r18 — mandatory after deploy)

(a) a fresh paid upload passes (`smoke-v3.mjs` / `smoke-v4.mjs` +
`smoke-target.mjs`); (b) an immediate REPEAT of the same request creates no
second POST (check-and-reserve idempotency survived the refactor); (c) a
separate signed request with `recheck: true` — the existing smokes never call
`getTxStatusWorker`, so the status leg needs this extra step; the criterion
is THE FACT of a status call, not its response code (an immediate recheck may
legitimately answer 503 «Recheck deferred» — the status metric is already
written); (d) `/admin/metrics` shows ALL FOUR legs (anchor/price/post from
the smoke, status from the recheck). The SQL API is not strictly
read-after-write: poll with backoff, ceiling ~2 min, then the smoke is RED —
never an endless loop; (e) **SUPERSEDED BY PR-3a.** This step used to rehearse
a rollback by redeploying the previous worker. That is now forbidden: the floor
is absolute, an empty release allowlist admits nothing but the trusted head, and
a local `npm run deploy` refuses outright. Rehearse the SANCTIONED path
instead — a descendant of the floor deployed through the trusted workflow — or
skip the rehearsal and say so, rather than leaving an instruction that the gates
will refuse.

### Launch gate for the REAL production contour (M r19 — carry into part 2)

The `.app` production does NOT open to users until PR-3a (status quorum
instead of the single-gateway dead) AND the writer part of PR-3b (durable
same-signed-tx) have closed both acknowledged paid-path risks above.
«Well-worn on dev» is necessary but NOT sufficient. This gate must be copied
into the `.app` provisioning runbook when part 2 of happy-toasting begins.

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
Since PR-2 additionally: `METRICS_ADMIN_SECRET` and `CF_ANALYTICS_TOKEN`
(both OPTIONAL for uploads — only `/admin/metrics` 503s while they are
missing; see the PR-2 section above and `docs/SECRETS.md`).

## PR-3a «Read-path multi-gateway» — release runbook

The read path stops being pinned to one host: status verdicts come from a
quorum over every configured gateway, and note payloads are fetched from a pool
and verified cryptographically against the txId that was asked for (D9).

This release **creates no paid transactions**. Its risk is the opposite one: a
verdict that is wrong in the other direction. So the runbook below is mostly
about not letting the two halves disagree about what `dead` means.

### What changed that an operator can observe

- **A lone 404 is no longer `dropped`.** `dead` now requires EVERY configured
  origin to answer 404, and at least two to be configured. One flapping gateway
  defers `dead` — deliberately: `dead` is the only verdict that authorizes
  spending money, while a stuck `unavailable` merely means «try later».
- **A gateway `400` is `unavailable`, never `invalid`.** It used to feed
  `needsRecheck`, i.e. the paid re-post path, on one host's opinion.
- **`invalid` is now a LOCAL verdict only** — a txId that is not 43 base64url
  characters, decided without a request.
- **Restore rejects payloads that do not match the requested txId**, and reads
  attribution from the SIGNED tags rather than from the GraphQL edge.
- **`/health` gained an attestation**: `statusQuorumPolicy`, the gateway hash
  and count, `releaseSha`, `workerVersionId`, and a `nonce` echo. It answers
  `no-store`. A client that cannot verify all of it keeps its upload pause up.

### Required configuration before the release

| Where | Variable |
|---|---|
| GitHub Environment `dev` + Cloudflare Pages | `VITE_STATUS_GATEWAYS`, `VITE_PAYLOAD_GATEWAYS`, `VITE_INDEX_SOURCES` |
| `worker/wrangler.toml` (repo, both blocks) | `STATUS_GATEWAYS` |

All three client variables are pinned EXACTLY in `scripts/gateway-pins.mjs`;
the deploy gate refuses anything else, and `check-gateways-vs-worker.mjs`
refuses a worker list that differs from the client's.

### Release order — and the two-stage floor raise

The floor is raised in TWO steps, and skipping the second leaves it lowerable:

1. Dispatch **Deploy Worker (proxy) — dev** with `candidate = <SHA>` and
   `profile = normal`. The gate refuses a candidate that is not the trusted
   head or an allowlisted release, and refuses anything below the floor.
2. The post-deploy smoke checks the LIVE worker: policy id, gateway hash and
   count, `releaseSha`, the activated `workerVersionId`, and the nonce echo.
   It **waits out Cloudflare's propagation** rather than judging the first
   answer: for a few seconds after an upload some edges still reply from the
   PREVIOUS version, which is indistinguishable from a failed release. The
   smoke therefore re-asks — with a new nonce each time — until the release
   appears or the budget (`SMOKE_DEADLINE_MS`, 60 s in the workflow) runs out,
   and reports the last real mismatch, not just «deadline exhausted».
   This is why a red smoke is worth reading closely: the first attempt of this
   release failed on exactly that race while the deployed worker was correct.
3. **Raise `WORKER_FLOOR_SHA` to that SHA** in the Environment. Nothing does
   this automatically — the control plane keeps applying the OLD floor until
   the variable changes.
4. **Land a separate protected commit raising `MINIMUM_FLOOR`** in
   `scripts/check-worker-floor.mjs` to the same SHA. Without it the Environment
   value can be edited back down to the previous repo pin, and the «absolute»
   floor is only as absolute as its lower bound.
5. Dispatch **Deploy client to Cloudflare Pages — dev** with
   `worker_candidate` and `worker_version_id` from step 2. It re-checks the
   live `/health` immediately before publishing and refuses unless BOTH floors
   already equal that release.

Both workflows share the `release-dev` concurrency group, so a worker deploy
cannot land between the client's live check and its publish. Serialization is
not ordering: still do not dispatch the next deploy until the previous run has
finished.

### Release record — dev contour

| | |
|---|---|
| Release SHA | `ff0954d1799c2dc0534a4ab73c6d11d3e01645f1` |
| Active `workerVersionId` | `222ea2c1-37f5-4eb1-bdcc-457a1db56b5e` |
| Trusted run | 33243712840 (all steps green, `release-identity` artifact published) |
| Worker origin | `eternal-notes-proxy.sopi-88c.workers.dev` |

**`MINIMUM_FLOOR` is raised to this SHA in `scripts/check-worker-floor.mjs`.**
Raise `WORKER_FLOOR_SHA` to it FIRST: once the repo pin lands, every deploy is
refused until the Environment variable matches, which is safe but stops the
release mid-way.

| Client release | Pages run 33245668734, green end to end |
| Floor raise | `WORKER_FLOOR_SHA` → `ff0954d` at 2026-08-29T09:27:16Z; `MINIMUM_FLOOR` → same SHA in `83a19aa` |

Verified on the live client after publishing: `connect-src` carries `'self'`,
all six approved gateway origins and the proxy, and `smoke-csp-origins.mjs`
passes against `https://notes.matamata.dev/`. The Pages run additionally
re-checked the live worker's identity and BOTH floors immediately before
publishing, so client and worker cannot disagree about what `dead` means.

An earlier attempt on `73c5916` deployed correctly and failed its own smoke on
Cloudflare's propagation race — the worker was right, the detector was early.
The fix is in the smoke, not in the worker; see the propagation note above.

**Still open after this release** (neither is blocking, both are honest gaps):

- **Manual acceptance on the dev contour** — restoring a real note, watching
  `/tx/<id>` and `/raw/<id>` go to pool gateways in DevTools, and confirming
  CSP blocks nothing. Automated gates cover the shapes, not the lived path;
  this needs a vault and a human.
- **A release tag** is NOT authoritative any more: since PR-3a a tag no longer
  makes a commit deployable (the gate takes the trusted head or
  `scripts/release-allowlist.mjs`). Tag `ff0954d` for readability if you like,
  but nothing depends on it.

### Local deploys

`npm run deploy` in `worker/` **refuses**. A local wrangler deploy bypasses the
floor gate, the Environment and the release lock — the three things that make
the attestation worth anything. Staging keeps `npm run deploy:staging`.

### Rollback

- **Client**: rolls back freely and independently. A client below this release
  loses D9 and the strict capability check, so the integrity position regresses
  even though no duplicate payment becomes possible (recovery stays
  server-authoritative). Treat this release as the client floor: below it, roll
  back only with uploads disabled.
- **Worker**: `ff0954d1799c2dc0534a4ab73c6d11d3e01645f1` — the SHA recorded in
  BOTH `WORKER_FLOOR_SHA` and `MINIMUM_FLOOR` — is an **absolute floor**. It is
  named by SHA and not by a tag on purpose: since this release a tag no longer
  makes a commit deployable, so naming a floor after one would point at the
  wrong kind of thing. `wrangler rollback` and a
  redeploy of anything below it are forbidden unconditionally, not «while
  uploads are on»: a Cloudflare version carries its own bindings and vars, so
  rolling back restores the old `UPLOADS_ENABLED` along with the old code.
- **The only break-glass path** is a commit that is already on `main`, is a
  descendant of the floor, declares `statusQuorumPolicy = legacy-single-v0`,
  and has ALL THREE upload switches `"false"` in its own `[vars]`. Deploy it
  with `profile = emergency`; the preflight verifies those flags from the
  candidate's own config BEFORE the Cloudflare action, and the emergency
  profile never opens a client release. Such a SHA goes in the list below, not
  in the normal allowlist.
- **Preferred emergency path is roll-FORWARD**: turn uploads off and ship the
  fix forward.

### Emergency releases — uploads permanently off

_(none yet)_

### The global kill switch now actually stops the queue

`UPLOADS_ENABLED = "false"` makes the worker answer
`503 {code:'uploads_disabled'}` to v1–v4 alike, before the body is read. Until
PR-3a the client only understood the PER-VERSION codes, so it recorded a plain
retryable failure and the queue kept marching through the backlog — burning the
per-IP budget against a worker refusing all of it, and making the incident lever
look like it had done nothing.

The client now writes a DEDICATED global marker and consults it before every
dispatch — for every version, not only the gated ones. Writing the v3 and v4
markers instead would have looked right and still let v1/v2 keep uploading: the
queue reads a version marker only for v3/safebox items.

Resume needs no new lever. The marker lifts once `/health` reports any version
`enabled`, and the capability table already requires the global `uploads` flag
to be true before it says that — so «enabled anywhere» proves «switch back on».

Operator consequence: after flipping the switch back, uploads resume on the next
`/health` probe — no manual un-pause, and no per-version bookkeeping.

### The post-deploy smoke is a DETECTOR

Cloudflare activates a version before any smoke can answer. A red smoke
therefore does not undo anything — recovery is roll-forward under the rules
above. That is stated here rather than implied, because a check that cannot
revert must not be mistaken for one that can.

## D2 «Семантическая идемпотентность» — release runbook (worker-only)

The worker release that makes `/upload` compare a publication FINGERPRINT before
handing back a historical `txId`. It is the precondition the backup track's D18
names: this must ship and soak BEFORE the backup stack merges, because the
client floor `client-b1` depends on the capability existing.

### What changes on the wire

- Every successful `/upload` answer carries `semanticIdempotency: 1` and
  `Cache-Control: no-store`. Additive — an older client ignores both.
- A repeat under the SAME bytes answers `deduped: true`.
- A repeat under DIFFERENT bytes answers **409 `{code:'id_payload_conflict'}`**
  instead of a 200 with the old `txId`. This is the point of the release.
- `/health` gains `semanticIdempotency: 1`, and the deploy smoke now REQUIRES it
  under the `normal` profile (and requires its ABSENCE under `emergency`).

### New non-secret configuration — already in the repo, nothing to set

Both live in `worker/wrangler.toml`, in BOTH tables, and are gated on every
deploy. Neither is an Environment variable, so there is nothing to click:

- `TRUSTED_OWNERS` — the historical wallet list D9 authenticates against.
  Contents pinned in `scripts/owner-pins.mjs`; `check-trusted-owners.mjs`
  refuses a deploy that drops any of it or that disagrees with the client.
- `PAYLOAD_GATEWAYS` — the pool `/tx/<id>` and `/raw/<id>` are read from,
  compared against the pin **in order** by `check-gateways-vs-worker.mjs`.

### Order

1. Merge the PR to `main` (branch protection; the gate runs on the candidate).
2. Dispatch **Deploy Worker (proxy) — dev** with the merged SHA as `candidate`.
   `WORKER_FLOOR_SHA` is NOT raised yet — see below.
3. Watch the post-deploy smoke: it now fails a build that does not advertise
   `semanticIdempotency`, so a green smoke is the proof the capability shipped.
4. **Soak.** The backup stack stays unmerged and Pages undeployed throughout.
5. Record the release row below with the real SHA, run id and version id.

### The floor is NOT raised by this release

Deliberately, and it is the one instruction here that is easy to get backwards.
`WORKER_FLOOR_SHA` rises **immediately before the import flip**, not now
(D2a): until a client with `BACKUP_IMPORT_ENABLED=true` exists, nothing depends
on semantic idempotency, and raising the floor early would remove the safe
rollback window for a defect found during the very soak this release is having.

Raising it is also a REVIEWED change to `MINIMUM_FLOOR` in
`scripts/check-worker-floor.mjs`, not only an Environment edit — the pin is what
stops the variable being edited back down.

### Rollback

Below this release the worker answers `exists` for a changed payload again. That
is tolerable ONLY while no released client has import enabled — which is exactly
the window this release is deployed into, and exactly what the floor closes
later. After the import flip, rollback below it is forbidden and the gate
enforces it.

A rollback target must be the trusted head or a SHA listed in
`scripts/release-allowlist.mjs` (empty by default): a tag grants nothing since
PR-3a, so a no-op redeploy of the currently-live worker costs one reviewed pull
request.

### Release row

| tag | SHA | run id | worker version id | smoked |
|---|---|---|---|---|
| _(fill on deploy)_ | | | | |
