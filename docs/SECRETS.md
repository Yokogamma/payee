# Secrets & access runbook

**This repository is PUBLIC.** This document records the CONTRACT — names,
consumers, blast radii, procedures. It must never contain a single value.
Values live in the operator's password manager (see «Outside the repo»).

Contour naming: `notes.matamata.dev` is the **working (dev) contour**
(reclassified 2026-08-20, see docs/ROLLBACK.md). The production contour will
be provisioned from scratch on a `.app` domain; nothing — data, wallets,
secrets, floor tags — carries over. Production columns below stay «not
provisioned» until then.

## Records and blast radii

| Record | Kind | Consumer | Blast radius if leaked |
|---|---|---|---|
| `ARWEAVE_JWK` | secret, **top category** | worker | money + the right to write on behalf of the service |
| `RECOVERY_HMAC_SECRET` | secret, **stable by contract** | worker | forged recovery tokens; while missing, `/upload` = 503 |
| `ADMIN_SECRET` | secret | worker: `/admin/seed-invite`, `/admin/revoke` | issuing invites and revoking access |
| `METRICS_ADMIN_SECRET` | secret | worker: `/admin/metrics` (PR-2) | read-only metrics reports. DELIBERATELY separate from `ADMIN_SECRET` (least privilege): leaking the metrics bearer grants no invite/revoke rights, and a future dashboard never needs the admin secret |
| `CF_ANALYTICS_TOKEN` | secret | worker: `/admin/metrics` upstream (Analytics Engine SQL API) | **honestly wider than one dataset:** the `Account → Account Analytics → Read` scope cannot be narrowed — the token reads analytics of the WHOLE account. Still read-only |
| `CLOUDFLARE_API_TOKEN` | secret, **top category (transitively)** | GitHub Actions (Environment `dev`) | **equals the radius of `ARWEAVE_JWK`.** Deploy rights = the right to read every worker secret: an attacker deploys code that returns `env.ARWEAVE_JWK`, `env.RECOVERY_HMAC_SECRET`, `env.ADMIN_SECRET` — and, after PR-2, `env.METRICS_ADMIN_SECRET` and `env.CF_ANALYTICS_TOKEN` — on the first request. Money + forged recovery tokens + invite issuance + admin metrics + account-wide Analytics Read; with a shared Cloudflare account — in BOTH contours |
| `CLOUDFLARE_ACCOUNT_ID` | identifier → Environment variable | GitHub Actions | harmless |
| `WORKER_FLOOR_SHA` | **non-secret config** → Environment variable in `dev`, protected | GitHub Actions: `scripts/check-worker-floor.mjs` in the worker deploy | not a secret at all — it is a public commit SHA. What matters is its INTEGRITY and who may change it: clearing or lowering it re-opens a worker rollback below the version released clients depend on, and that rollback is silent (a historical `txId` handed out for bytes that have since changed). Empty is a legitimate state — see docs/ROLLBACK.md — and the gate says so out loud rather than passing quietly |
| `CF_PAGES_PROJECT` | config → Environment variable | GitHub Actions | deploy to the wrong project |
| `VITE_PROXY_URL` | config → Environment variable | client build | pinned in CSP; also repo-pinned (scripts/check-deploy-config.mjs) |
| `VITE_TRUSTED_OWNERS` | config, **integrity-critical** → Environment variable | client build | trusting a stranger's transactions; repo-pinned inclusion check |
| `SMOKE_PRIVATE_KEY`, `MNEMONIC` | operator secrets | local paid smokes | access to the smoke vault |
| `SMOKE_URL`, `SMOKE_ALLOW_ORIGIN` | **non-secret** operator setting | local paid smokes | not a secret; `SMOKE_ALLOW_ORIGIN` is a deliberate per-origin grant for a paid smoke (worker/scripts/smoke-target.mjs) |
| `ALLOWED_ORIGINS`, `MAX_BODY_BYTES`, `RATE_LIMIT_PER_HOUR`, `UPLOADS_ENABLED`, `V3/V4_UPLOADS_ENABLED`, `METRICS_ENABLED`, `METRICS_DATASET` | config in `wrangler.toml` | worker | source of truth is the repository |
| `CF_ACCOUNT_ID` | identifier → var in `wrangler.toml` (empty until filled) | worker: `/admin/metrics` upstream URL | harmless (same value as `CLOUDFLARE_ACCOUNT_ID`) |

## Resource registry by contour

Names and pointers only — no values.

| Resource | dev | production |
|---|---|---|
| Worker name | `eternal-notes-proxy` | not provisioned (`[env.production]`, new name — §2.1) |
| Worker API origin | `https://eternal-notes-proxy.sopi-88c.workers.dev` | not provisioned (custom domain, `workers_dev = false` — §2.2.4a) |
| KV namespace | `ALLOWLIST` (id in wrangler.toml) | not provisioned (new) |
| Durable Objects | `RateLimiter`, `InviteManager`, `IpRateLimiter` | same classes, fresh instances |
| Pages project | `eternal-notes` | not provisioned (separate project) |
| Client domain | `notes.matamata.dev` | `.app` domain, name TBD at launch |
| GitHub Environment | `dev` (branch policy: `main`; 4 variables + token secret) | `production` (required reviewers + branch policy — §2.1) |
| Cloudflare token scope | `Workers Scripts: Edit`, `Cloudflare Pages: Edit` (account-level — no per-resource granularity exists) | separate token; **separate account is the provisioning gate** (§2.1) |
| Staging worker | `eternal-notes-proxy-staging` — **not deployed** (KV placeholder in wrangler.toml) | n/a |

**Public hostnames of the dev contour** (enumerable; verify with `curl` at
acceptance — an undocumented extra origin becomes a forgotten one, which is
exactly how the github.io contour almost outlived its retirement):

- `https://notes.matamata.dev` — the client (custom domain);
- `https://eternal-notes.pages.dev` + per-deploy preview subdomains — the same
  client on the Pages default domain (alternative live origin; uploads from it
  die fail-closed via CORS, but the page opens);
- `https://eternal-notes-proxy.sopi-88c.workers.dev` — the worker API;
- retired: `https://yokogamma.github.io/payee/` — unpublished 2026-08-20,
  serves 404. **Residual risk — CLOSED as void (owner statement 2026-08-21):**
  the PWA from that origin was never installed on any device — there were no
  users of that contour — so there is nothing to uninstall. Kept here as the
  record of the question having been asked and answered. (Had installs
  existed, an installed PWA would keep opening offline: service worker
  precache + navigateFallback survive a network 404. Never ship a farewell
  auto-update for such a case — the client is deliberately built with
  `registerType: "prompt"` and no unconditional skipWaiting.)

**Recovery mailbox.** The mailbox behind GitHub, Cloudflare and the domain
registrar accounts is the recovery root ABOVE all of them. Requirements: 2FA
mandatory, SMS fallback disabled. The Cloudflare **Global API Key** (a legacy
full-radius credential every account has) is never used anywhere, never
appears in workflows, and is guarded as account-level access.

**TLD property, not luck:** `.dev` and `.app` are HSTS-preloaded TLDs —
browser plaintext http to them is impossible by construction. This matches
the smoke classifier's refusal of remote http (§1.5) and is worth knowing
before anyone «simplifies» a URL to http.

## Outside the repository (password manager)

- values of every record above, per contour;
- the `ARWEAVE_JWK` file **plus a second offline copy**;
- Cloudflare, GitHub and registrar logins with 2FA recovery codes;
- a register of «who holds what» and last-rotation dates.

## Guarding `CLOUDFLARE_API_TOKEN`

Guard it **like `ARWEAVE_JWK`** — the radius is transitively the same (see
table). Cheap secret, expensive consequence: that asymmetry is the argument
for the separate production account (§2.1) and the platform rulesets (§1.0b).

**Leak response protocol:**
1. revoke the token in Cloudflare;
2. rotate ALL THREE worker secrets:
   - `ARWEAVE_JWK` — with the wallet rule below (never delete old addresses);
   - `ADMIN_SECRET` — freely;
   - `RECOVERY_HMAC_SECRET` — **by the compromise procedure below** (no
     acceptance of the previous key). This is a protocol change, not a
     runbook line.

**Accepted residual risk (decision, not an accident).** In the deploy job,
`npm ci` (with postinstall scripts of transitive dependencies) runs in the
same job that later holds `apiToken:`. A compromised package could replace
`worker/node_modules/wrangler` or the built `dist/` before the deploy step —
SHA-pinning of the action does not catch that. Full closure (two jobs with an
artifact hand-off, secret only in the second) is too expensive for a solo
project. Probability is lowered by: lockfiles, `allowScripts` (only `esbuild`
and `workerd` may run install scripts), Dependabot alerts, and the repo being
public. Recorded here as an accepted decision.

## Rotation

**Wallet (`ARWEAVE_JWK`)** — the rule from `src/lib/config.ts`:
1. add the NEW address to `VITE_TRUSTED_OWNERS` and ship the client;
2. only then switch `ARWEAVE_JWK` on the worker;
3. **never remove old addresses** — old notes must stay restorable.

**`RECOVERY_HMAC_SECRET` — two scenarios; never confuse them.**

**(a) Planned rotation — does not exist and is not planned.** Recovery tokens
are unlimited-lifetime, live in clients' IndexedDB and verify only against
the current key; any outstanding record would get `400 Invalid recovery
token` after a change. If a planned rotation is ever required, it goes
through a `current + previous` keyring with `kid` — acceptance of the
previous key exists so that legitimate in-flight tokens survive.

**(b) Compromise — the keyring is FORBIDDEN.** Accepting `previous` would
preserve the attacker's forging ability, making the rotation pointless.

Compromise procedure (levers that exist in the code today):
1. **Stop the flow**: set `UPLOADS_ENABLED = "false"` in `wrangler.toml
   [vars]` and deploy. This is the GLOBAL lever — it stops v1–v4 including
   rechecks and recovery reconciliation with `503 {code:'uploads_disabled'}`
   (the V3/V4 switches gate only their own declared version and would leave
   v1/v2 traffic reaching the paid path). Verify: `curl <worker>/health` →
   `"uploads": false`;
2. **rotate the key immediately, without accepting the previous one**
   (`wrangler secret put RECOVERY_HMAC_SECRET`);
3. **in-flight records — the honest statement.** A token signed by the old
   key fails HMAC verification; the worker releases the reservation and
   returns 400 — it does NOT re-post, so the rotation costs the LIVENESS of
   those records, never a duplicate paid transaction. The txId check is
   unreachable for them (HMAC is rejected earlier), `/redrop` is not an
   operator route (internal DO call only), and affected records cannot be
   enumerated centrally (recovery proofs live only in clients' IndexedDB).
   **There is no ready operator recovery path.** Decision for the dev
   contour: **variant (A) accepted** — affected records stay unpublished;
   the user restores by seed, and if the transaction did land on-chain the
   note returns through normal restore. A decision on variant (B) (operator
   reconciliation with its own authorization and audit) is due before §2.2;
   if built, it must independently verify the transaction, its owner and its
   binding to the signed client envelope — never trust a client-supplied
   txId;
4. **client side**: the `{code:'recovery_invalid'}` responses feed the
   terminal quarantine (`terminalError: 'recovery_invalidated'`) — affected
   records stop rechecking, keep their txId + hint as evidence, and only the
   proof-bearing seed-restore path may clear the state;
5. re-enable uploads (`UPLOADS_ENABLED = "true"` + deploy) once the new key
   is live.

**`ADMIN_SECRET`, Cloudflare token** — rotate freely; a test deploy to dev
afterwards.

**`METRICS_ADMIN_SECRET` (PR-2)** — rotate freely:
`wrangler secret put METRICS_ADMIN_SECRET` (and `--env staging` where
provisioned); update the operator's stored value; verify with a
`POST /admin/metrics` → 200. Nothing else depends on it (read-only reports).

**`CF_ANALYTICS_TOKEN` (PR-2)** — rotate by RECREATING the token in the
Cloudflare dashboard (scope: `Account → Account Analytics → Read`, this one
account, nothing else), then `wrangler secret put CF_ANALYTICS_TOKEN` (and
`--env staging` where provisioned) and revoke the old token. While it is
missing `/admin/metrics` answers 503 and metric WRITES are unaffected — the
rotation window costs only report availability.
