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
- A record whose ON-CHAIN copy is itself undecryptable (corruption that
  happened BEFORE the upload, so the bad bytes were paid onto Arweave) stays in
  the repair set forever: an id leaves it only through a successful merge, and
  a candidate that fails `buildRestoredNote` is an intentional skip that
  produces no merge. Consequence: one payload fetch per such record per check,
  indefinitely — bounded, no data loss, no false error. Repair is genuinely
  impossible for these; giving up after a failed attempt would change repair
  semantics and belongs in its own review, not in this release.

Acceptance on the live site (DevTools → Network, filter `arweave.net`; there
are no new user-facing strings, so «grep the bundle» does NOT prove this
release — the network profile does):

1. first `↻` press — `/graphql` plus `/raw/…` requests;
2. second press — `/graphql` present, **zero `/raw/…`** (on a clean state:
   a repair candidate or redrop duplicate produces legitimate single `/raw`
   fetches — that is not a failed acceptance);
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
