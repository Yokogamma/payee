# Metrics runbook (PR-2)

Server-side telemetry ONLY (decision D5) in Workers Analytics Engine.
Spec this implements: `docs/ARWEAVE-RESILIENCE-PLAN.md` §4.PR-2 «Реализация».
This document describes STRICTLY what the worker actually writes after PR-2 —
no reserved rows. Events of later PRs (`payload_hash_mismatch`,
`index_presence_disagreement`, `wallet_burn`, `post_attempt_same_tx`,
`resign_violation`, …) are documented in the plan's roadmap sections and will
be added here when the code that writes them ships.

## Master switch

Telemetry is fail-closed, the request path is fail-open: data points are
written STRICTLY when `METRICS_ENABLED = "true"` AND the `METRICS` binding
exists. Any other value (missing, garbage, no binding) disables writes; a
`writeDataPoint` failure never surfaces to the client. Datasets are explicitly
different per environment: `eternal_notes_metrics` (production block) and
`eternal_notes_metrics_staging`.

## Event schema (stable blob/double order — Cloudflare requires it)

The event name is BOTH the index (`indexes: [event]` — low cardinality,
independent sampling per event type) and `blob1`.

| Event | blobs (in order) | doubles |
|---|---|---|
| `gateway_call` | event, kind (`anchor`/`price`/`post`/`status`), host, statusClass (`2xx`/`404`/`4xx`/`5xx`/`timeout`/`network`/`invalid_response`) | latencyMs; for kind=`price` a second double — quotedWinston |
| `upload_outcome` | event, outcome (`accepted`/`arweave_error`/`arweave_throw`), appVersion | — |
| `status_verdict` | event, verdict (`alive`/`dead`/`unavailable`), host | confirmations (from a 200 body, else −1) |

**PR-3a — the status leg is now a POOL.** The blob schema is unchanged; the
number of rows and the host values are:

- one `gateway_call` and one `status_verdict` per CONFIGURED origin;
- plus ONE aggregated `status_verdict` under the sentinel host **`_quorum`**,
  carrying the verdict the shared formula produced. A leading underscore cannot
  occur in a bare origin, so it can never collide with a real gateway's series.
- `host` stays a BARE hostname (`arweave.net`), NOT the canonical origin
  (`https://arweave.net`) — switching it would split the historical series in
  two for no gain.
- `confirmations` on a per-host row is that host's value or −1; on the
  `_quorum` row it is the conservative aggregate (the LOWEST count among
  valid 200s) or −1.
- a 200 whose body fails the schema is classified `invalid_response` and is
  NOT alive — under the quorum it is an ordinary non-404 outcome, and it blocks
  `dead` rather than causing it. A `400` behaves the same way; it used to be
  classified `dead` outright.
| `post_accepted` | event, host | — |
| `redrop_new_tx` | event, host | — |

`invalid_response` is an HTTP success whose body failed the runtime schema
(non-base64url anchor, `12abc` instead of a price, oversized body) — a
PROTOCOL defect of the gateway. It is deliberately not masked as `network`:
that is exactly the signal D9 introduces verification for.

## Where each event fires

| Execution point | Events |
|---|---|
| `getAnchor` / `getPrice` returned or failed (transport adapter) | `gateway_call` kind=`anchor`/`price` with a class; a failure then leads to `upload_outcome=arweave_error`/`arweave_throw` via the existing 502 branches |
| `postSignedTx` finished (the single paid block) | `gateway_call` kind=`post`; on 200/202 also `post_accepted` (= the gateway ACCEPTED the POST, before `mark-posted`/`commit`) |
| the same successful POST when the new txId follows a PROVEN dead — the `doRedrop` branches AND the recovery-hint branch (valid token + dead verdict + age guard) | additionally `redrop_new_tx` (the event's definition is «a new paid txId after a confirmed dead», not «went through /redrop»; clarified in the PR #105 review — missing the recovery path would hide the riskiest triple-failure scenario from the security metric) |
| terminal `return` from `handleUpload` — ONLY from paid-path branches | `upload_outcome`: `accepted` = a final 200 AFTER a POST actually performed by THIS request; `arweave_error` = non-2xx from the gateway; `arweave_throw` = the catch branch. Early returns (validation 4xx, kill switches 503, rate limit 429, idempotent hits, reconciliation without a new POST) emit NOTHING — the metric answers "how do paid publications end" |
| `getTxStatusWorker` returned a verdict | `gateway_call` kind=`status` + `status_verdict` |

## Numeric conventions

`−1` means "not recorded", never a measured value:

- `quotedWinston`: an Arweave price is up to 20 digits and a double loses
  precision above `Number.MAX_SAFE_INTEGER`. The SDK ALWAYS receives the
  reward as the original string; the metric records the number only when
  `Number.isSafeInteger` holds, otherwise −1.
- `confirmations`: `number_of_confirmations` (the exact Arweave field name)
  is read best-effort from the 200 body only, capped at 1 KiB, under the
  status fetch's own 10 s signal. The verdict is fixed by the HTTP code
  BEFORE the body is parsed; any parse failure (malformed, oversized,
  truncated, slow) yields −1 and never changes the verdict.

**POST has NO timeout — by design.** Anchor/price run before signing (no
money at risk) and use a 10 s `AbortSignal`. The paid POST is only measured:
a response lost to our own timeout would not prove the gateway rejected the
transaction, and the catch releases the reservation — an active timeout would
widen the double-paid-publication window. Closed properly by PR-3b.

## Sampling

Analytics Engine SAMPLES. Every counter in every report must be
`SUM(_sample_interval)`, never `COUNT()`; percentiles only in the weighted
exact form `quantileExactWeighted(0.95)(double1, _sample_interval)`. The
whitelisted templates in `worker/src/metrics.ts` already comply and are
pinned by snapshot tests.

## Privacy boundary and accepted residual risk

The guarantee «no identifiers, no content» covers **Analytics Engine only**:
data points carry no `noteId`, no `txId`, no keys, no IPs — only enum-like
labels and the safe numbers above (tested).

**Accepted residual risk (owner decision, r18):** existing `console.error`
calls keep writing `noteId` (a random UUID) and the public `txId` into Worker
logs (`ARWEAVE_POST_FAILED`, `COMMIT_FAILED`, …). PR-2 deliberately changes
the paid path minimally; the log cleanup is a separate small PR.

## Access: POST /admin/metrics (operator-only, server-to-server)

Auth: `Authorization: Bearer <METRICS_ADMIN_SECRET>` — a DEDICATED secret
(least privilege: the metrics reader gets no seed-invite/revoke rights, and
`ADMIN_SECRET` does not open this endpoint). CORS deliberately does NOT allow
the `Authorization` header, so the long-lived secret can never live in a
browser dashboard — a future UI gets its own backend or Cloudflare Access.

Request: `{ "report": "<name>", "hours"?: 1..168 }` (default 24; body cap
1 KiB). Reports (whitelist — no free-form SQL through the worker):

| report | Response shape |
|---|---|
| `gateway_health` | `{ rows: [{kind, host, class, calls, p95_ms}] }` |
| `upload_outcomes` | `{ rows: [{outcome, app_version, n}] }` |
| `status_verdicts` | `{ rows: [{verdict, host, n}] }` |

Responses: 503 no `METRICS_ADMIN_SECRET` → 401 bad bearer → 503 upstream not
configured (`CF_ACCOUNT_ID`/`CF_ANALYTICS_TOKEN`/valid `METRICS_DATASET`) →
400 unknown report / bad hours → 503 upstream timeout/network → 502 upstream
non-2xx / oversized (256 KiB cap) / malformed JSON. The upstream document is
NEVER proxied — the worker validates `data` is an array and returns
`{ rows: data }`. `Cache-Control: no-store` is attached to EVERY response of
the path, including 415/404. Until `CF_ANALYTICS_TOKEN` exists the endpoint
answers 503 while metric WRITES keep working.

Operator query example:

```bash
curl -sS -X POST https://<worker>/admin/metrics -H 'Content-Type: application/json' -H 'Authorization: Bearer <METRICS_ADMIN_SECRET>' -d '{"report":"gateway_health","hours":24}'
```

## What PR-2 does NOT close (release-notes honesty, P0 r18)

1. **The ambiguous POST exception.** A transaction ACCEPTED by the gateway
   whose response was lost still leads to `safeRelease` and a possible second
   paid POST on a client retry. Only the durable same-signed-tx protocol of
   PR-3b closes this. The metrics make the window visible
   (`post_accepted` vs `upload_outcome`), they do not close it.
2. **Single-gateway `404/400 → dead`.** The verdict still comes from the one
   `arweave.net`. Only the PR-3a quorum closes this; `status_verdict` merely
   measures today's behaviour.

## Calibration caveat

`quotedWinston` and `confirmations` are the material for calibrating
`MAX_TX_REWARD` / `PRICE_DEVIATION` and `MIN_PRESENCE_CONFIRMATIONS` — but a
confirmations distribution observed from ONE host does not replace the
quorum shadow metrics of PR-3a/PR-4. Final D10/D11 defaults are approved on
those, not on PR-2 data alone.

## Capacity

**Recount after PR-3a.** One recheck used to emit 1 `gateway_call` + 1
`status_verdict`. With the approved five status origins it emits **5
`gateway_call` + 6 `status_verdict`** (five per-host rows plus `_quorum`) —
about 5.5× the status-leg volume. The paid-path legs (anchor/price/post) are
unchanged. Analytics Engine on Workers Free allows 100k datapoints/day, so the
headroom stays large at this contour's traffic; revisit the sampling note above
if the pool ever grows substantially.

Workers Free: 100k writes/day, 10k SQL reads/day — a large margin for this
schema (≤ ~6 points per upload, 2 per status check).


## What PR-3a deliberately does NOT measure

D9 verification runs in the CLIENT, and D5 keeps telemetry server-side. So the
plan's fleet-wide `payload_hash_mismatch` KPI is **not obtainable** here, and
pretending otherwise with a client beacon would trade a real privacy boundary
for a number.

What exists instead is a LOCAL diagnostic: `fetchAllNotes` returns per-gateway
failure counts and logs one aggregated line naming hosts and counts only —
never a txId, never an Owner-Hash. Nothing is transmitted.

This is the same line the plan already drew for `incomplete=true` (§5: «restore
c `incomplete=true` — недоступна с клиента (D5); прокси-метрику по серверным
пробам сознательно НЕ вводим»). Revisit conditions: a confirmed mismatch
reported by a user, or an extension of `PAYLOAD_GATEWAYS` beyond the approved
four — either would justify an ADR for server-side probes.
