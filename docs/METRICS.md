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

`blob1` is the event name. The INDEX is `event:discriminator`, where the
discriminator is the first caller blob (the kind/outcome/verdict) when it is a
short enum-like label, and the bare event name otherwise — see `metricIndexKey`
in `worker/src/metrics.ts`.

**Why the discriminator is in the index.** Analytics Engine samples PER INDEX.
While the index was the bare event name, every kind of `gateway_call` shared one
sampling bucket. Two measurements from 2026-09-09, and they say different
things — do not merge them:

- **The narrow window** 2026-09-08 12:00–13:00 UTC, one soak run. `gateway_call`
  kept FIVE rows: three `anchor` and two `price`. Not one surviving row for
  `post` or for either `payload_*` kind, although the branches that emit all
  three were REACHED — `post_accepted` (3 rows, weight 1) and the two
  `legacy_backfilled` rows prove the call sites ran. Reached is not delivered:
  whether those data points were written and then dropped by the sampler, or
  failed silently inside the `catch {}` in `makeEmit`, is NOT established.
  `SUM(_sample_interval)` over those five estimated 13 events, and 13 is exactly
  what the run should have produced (3×(anchor+price+post) plus 2×(header+raw)) —
  the estimate agreed with the expectation. In the same window
  `legacy_backfilled` was reported as 4 against a real 2.
- **168 hours.** `gateway_call` had 36 rows for an estimated 84 events — and
  there `post` (9 rows) and both `payload_*` kinds (1 row each) DID appear. The
  wider the interval, the likelier a kind keeps at least one row; it is the
  narrow read that loses whole categories, and narrow reads are what a soak
  report is made of.

So a rare outcome sharing a bucket with a frequent one CAN disappear from the
sample entirely. WHICH rows the sampler drops was not measured and does not need
to be: for a criterion that must read zero, the possibility is already enough.

Rows written before the split carry the bare event name, so every report reads
**both** schemas: `(index1 = 'x' OR index1 LIKE 'x:%')`. A row has exactly one
`index1`, so the union is a partition and cannot double count.

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
| `semantic_idempotency` | event, outcome (`deduped` / `conflict` / `redrop_conflict` / `legacy_backfilled` / `legacy_backfill_stale` / `legacy_not_ours` / `legacy_unproven` / `legacy_dead_redrop` / `legacy_dead_deferred` / `recovery_reconciled` / `recovery_unproven` / `recovery_conflict`), appVersion | — |

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
| every DECISION of the fingerprint protocol (D2) — the paths `upload_outcome` is silent about | `semantic_idempotency`: `deduped` = an existing txId handed back after a fingerprint match (idempotent hit, resolved posted state, resolved redrop, reconciled recovery); `conflict` = 409 from `/check-and-reserve`; `redrop_conflict` = 409 because the superseding transaction carries other bytes; `legacy_backfilled` = the body-CAS on `/backfill-fp` HELD (a stale CAS is `legacy_backfill_stale`: someone else proved it first — counted apart so the backfill number is not inflated); `legacy_not_ours` / `legacy_unproven`; `legacy_dead_redrop` = a redrop reservation was actually MINTED after a dead verdict (a deferred one is `legacy_dead_deferred`) — never on the verdict alone; `recovery_reconciled` / `recovery_unproven` / `recovery_conflict` = the recovery-token branch, as a COMPLETE family, so the refusal share is a number. This is the SOAK instrument: docs/ROLLBACK.md «D2 … release runbook» defines the exit criteria over it |

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
| `semantic_idempotency` | `{ rows: [{outcome, app_version, n}] }` |

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

## Критерий → источник → проверка покрытия

Замер 2026-09-09 показал, что одного канала недостаточно: Analytics Engine
сэмплирует **по индексу**, и отсутствие строки неотличимо от отсутствия
события. Для критериев «строго ноль» этого мало по построению.

**Чем ledger является и чем НЕ является.** Он фиксирует действия драйвера и
годится, чтобы **обнаружить расхождение** с телеметрией. Взаимозаменяемым
счётчиком он не является, и вот почему:

- `paidAttempts` считает **отправки**, а `upload_outcome` эмитится только на
  платном пути. Запрос, отклонённый раньше (429, 403, 409, выключатель), даёт
  попытку без исхода — знаменатели РАЗНЫЕ, доля успеха по ним не совпадёт;
- платный redrop списывается в `redropSends`, а не в `paidAttempts`. Его
  `upload_outcome` не имеет парной попытки;
- `unprovenSeen` растёт **только в legacy-пассе** и считает `legacy_unproven`.
  Счётчиком `recovery_unproven` он не является;
- пути восстановления драйвер вообще не проходит: `recovery_*` требует
  настоящего сбоя DO, который никакой клиент поставить не может — тем же
  основанием владелец 07.09 отменил `recovery_reconciled`.

| Критерий (docs/ROLLBACK.md «Exit») | Источники | Что даёт покрытие |
|---|---|---|
| `conflict`, `redrop_conflict`, `legacy_not_ours` — **строго 0** | 1. `semantic_idempotency` в AE, свой индекс на исход 2. строка `{"critical":…}` в Workers Logs | два независимых канала: чтобы ноль оказался ложным, событие должно потеряться в ОБОИХ. Драйвер дополнительно ставит `STOP` при конфликте — третий сигнал, независимый от телеметрии |
| `recovery_conflict` — **строго 0** | 1. `semantic_idempotency` в AE 2. строка `{"critical":…}` в логах | каналов ДВА, как у конфликтов выше. Ограничение другое и его надо назвать: путь недостижим для драйвера, поэтому ноль здесь означает «не наблюдалось», а не «проверено сценарием» — то же, по чему владелец отменил `recovery_reconciled` |
| `arweave_throw` — **строго 0** | 1. `upload_outcome` в AE 2. `{"critical":"arweave_throw"}` в логах 3. ledger: попытки против успехов | ledger ловит РАСХОЖДЕНИЕ (попыток больше, чем успехов) даже если обе телеметрии потеряли строку. Он их не заменяет: знаменатель другой |
| `legacy_unproven` — ≤ 1 и **0 в последние 48 ч** | AE + логи + `unprovenSeen` в ledger | ТРИ канала: два телеметрических и независимый счёт драйвера |
| `recovery_unproven` — ≤ 1 и **0 в последние 48 ч** | AE + логи | ledger-аналога нет (`unprovenSeen` считает ТОЛЬКО `legacy_unproven`), поэтому каналов два, и оба телеметрические. Сценарий драйвером не воспроизводится |
| доля успеха ≥ 95 % | `upload_outcome` (`accepted` ÷ все) | ledger — только для сверки ПОРЯДКА величины, не для замены: знаменатели разные |
| объём (30 решений, 3 дня, 10 дедупов, 3 бэкфилла, 20 платных) | ledger (`summarize`) + `semantic_idempotency` | ledger авторитетен по действиям драйвера, AE — по решениям воркера |

**Что из этого следует.** Двухканальны все шесть исходов, по которым судят окно.
Но каналы разной природы: у `arweave_throw` и `legacy_unproven` третий счёт —
ledger, независимый от телеметрии; у `recovery_*` оба канала телеметрические, и
сам сценарий драйвером не воспроизводится. Ноль по `recovery_*` означает «не
наблюдалось», а не «проверено» — это ограничение надо принимать явно при зачёте
окна, а не считать закрытым.

## Ежедневное сохранение свидетельств

Оба канала **истекают**: Workers Logs хранит максимум семь дней, а окно соака —
ровно семь, поэтому начало окна исчезает в тот самый день, когда окно
оценивают. Что не записано на диск — потеряно.

Три команды, все только на чтение, все нужны ежедневно:

```
node worker/scripts/soak-d2.mjs snapshot
node worker/scripts/metrics-export.mjs metrics --hours 24
node worker/scripts/metrics-export.mjs logs --hours 24 --worker eternal-notes-proxy
```

`soak-d2.mjs snapshot` архивирует **только Analytics Engine** — логи он не
трогает. Их забирает `metrics-export.mjs`, и ему нужен **отдельный токен**
(`Account → Workers Observability → Read`); в `CF_ANALYTICS_TOKEN` этих прав
нет.

Как `metrics-export.mjs logs` защищает выгрузку:

- диапазон режется на срезы (`--slice-minutes`, по умолчанию 60), запрос идёт
  по каждому срезу отдельно;
- срез, вернувшийся ровно на потолке (1000 событий), **обрывает выгрузку
  ошибкой**: он неотличим от усечённого, а молча короткий архив хуже
  отсутствующего — его прочитают как «ничего не было». Лечение — меньший срез;
- любой не-2xx от API даёт исключение, а не пустой результат;
- **ноль событий на всём диапазоне — находка, а не успех**: ровно так выглядит
  «логи не собирались». Скрипт говорит об этом отдельной строкой;
- ответ с `success: false` при HTTP 200 — ошибка, а не пустой результат;
- ответ, отданный из СЭМПЛИРОВАННОГО слоя (`abr_level > 1`), отвергается: его
  числа — оценки, а ровно этого экспорт и должен избегать;
- запрос **обязательно** фильтруется по целевому воркеру, и принадлежность
  проверяется у КАЖДОГО вернувшегося события: без фильтра одно событие чужого
  воркера делало проверку доставки «успешной». Ключ имени скрипта не
  угадывается, а разрешается по списку ключей самого хранилища — неверный ключ
  молча не совпал бы ни с чем, а «событий нет» не должно быть следствием бага;
- имя архива содержит режим, цель и ТОЧНЫЙ интервал, запись атомарна, а
  существующий архив **не перезаписывается**: суточная выгрузка и часовая
  проверка доставки в один день больше не уничтожают друг друга.

`metrics-export.mjs metrics` сохраняет и **сырые строки** с `_sample_interval`:
взвешенную оценку нельзя пересчитать после того, как окно истекло.

## Проверка доставки

`head_sampling_rate = 1` — запрос на полный сбор, **не** гарантия хранения без
потерь. Конфигурация ничего не доказывает; доставка проверяется наблюдением —
в том самом контуре, где пойдёт соак.

### Чем проверять и почему не иначе

Проверить надо ровно одно: **структурная JSON-строка приложения, написанная
через `console.error`, доходит до Workers Logs**. Два очевидных способа не
годятся:

- **`/health` не подходит.** Этот обработчик не пишет ни одной строки
  `console`. Его invocation-запись доказывает, что сборщик работает, но ничего
  не говорит о доставке строки, написанной приложением, — а именно она несёт
  критические исходы.
- **Настоящий `conflict` не годится тем более.** Чтобы его получить, нужна
  ранее опубликованная заметка с другими байтами, то есть **платная
  публикация**; и он поставил бы единицу в критерий, который обязан читаться
  нулём — проверка сломала бы то, что проверяет.

Поэтому есть `POST /admin/telemetry-probe`: контрольное событие, которое идёт
через **тот же** механизм логирования (`logStructured` — общий с
`logCritical`), но имеет собственный тип `telemetry_probe`, собственное поле
`probe` вместо `critical`, не пишет строку в Analytics Engine, не касается
пути публикации и не может стоить AR. Идентификатор генерирует воркер и
возвращает в ответе — из запроса в строку не попадает ничего.

Покрытие настоящих конфликтных ветвей остаётся за интеграционными тестами
(`legacy-backfill-e2e` проверяет строку `{"critical":"conflict"}` шпионом на
`console.error`).

### Порядок

Шаг 0 выполняется ДО деплоя, шаги 1–6 — сразу после него и ДО открытия окна.

0. **Получить доступ к Workers Observability ЗАРАНЕЕ** — токен со scope
   `Account → Workers Observability → Read`, отдельный от
   `CF_ANALYTICS_TOKEN` (в нём этих прав нет). Именно до деплоя: сбор логов
   начинается вместе с ним, а хранение — семь дней, поэтому ждать токена уже
   после включения означает тратить окно хранения на организационную паузу.
   Проверить, что токен читается: `metrics-export.mjs logs --hours 1` должен
   дойти до запроса, а не упасть на отсутствии учётки.

1. **Контрольное событие.** Нужен `METRICS_ADMIN_SECRET`; все POST этого
   воркера требуют `Content-Type: application/json`, тело может быть пустым
   объектом.

   ```
   curl -sS -X POST https://<worker>/admin/telemetry-probe \
     -H "Authorization: Bearer $METRICS_ADMIN_SECRET" \
     -H 'Content-Type: application/json' -d '{}'
   ```

   В ответе — `{"probe":"telemetry_probe","probeId":"<uuid>"}`. Запомнить id.

2. **Живая выгрузка с утверждением.** Фиксированный интервал вокруг вызова,
   узкий срез:

   ```
   node worker/scripts/metrics-export.mjs logs \
     --from 2026-09-11T12:00:00Z --to 2026-09-11T12:10:00Z \
     --slice-minutes 5 --expect-probe <uuid>
   ```

   `--expect-probe` превращает проверку в **утверждение**: если строки нет,
   экспорт падает и архив не создаётся. Отсутствие — не «не заметил», а
   провал проверки доставки, и окно на нём открывать нельзя.

3. **Многостраничность — отдельно, бесплатными запросами.** Набрать всплеск
   `GET /health` (платного пути не касается, критериев не двигает) и выгрузить
   тем же способом. Доказательством служит **вторая НЕПУСТАЯ страница с новым
   курсором**; лишний запрос, вернувший пустоту, не доказывает ничего.
   Фактический размер страницы читается из первого ответа, а не
   предполагается: запрошено 100, вернуться может меньше, и всплеск
   подбирается под то, что вернулось.

4. **Сверка по идентификаторам, не по количеству.** Число лог-событий не
   обязано равняться числу запросов: одна инвокация даёт несколько строк
   `console`, плюс идут фоновые события. Сверяются уникальные
   invocation/request ID контрольных `/health`.

5. **Analytics Engine за тот же интервал.** `metrics-export.mjs metrics` с
   теми же `--from/--to` обязан вернуть строки — этот канал уже проверен на
   живых данных 2026-09-09, но сверка интервалов должна сойтись.

6. **Отказ от перезаписи.** Повторить шаг 2 — и повтор должен совпасть по
   ВСЕМ четырём: тот же режим (`logs`), тот же `--worker`, те же `--from` и
   `--to` до секунды. Имя архива складывается ровно из них
   (`archiveName`), поэтому расхождение в любом даст новый файл вместо
   ожидаемого отказа «archive already exists», и проверка окажется пройденной
   впустую. С относительным `--hours` она не работает вовсе — интервал каждый
   раз новый.

Все шаги прошли — окно можно открывать. Любой не прошёл — расследовать до
открытия, а не после.

**Чего эта проверка НЕ даёт.** Она подтверждает, что канал работал **в момент
проверки**, и ничего не говорит о том, что он проработает все 168 часов.
Покрытие ВНУТРИ окна контролируется отдельно — ежедневными выгрузками (см.
«Ежедневное сохранение свидетельств» и шаг 3 контроля покрытия): пустой день
или расхождение с ledger означают, что канал деградировал посреди окна, и это
расследуется до его конца, а не после.

### Staging: изоляция, а не обязательный шаг

Провижининг staging для этой проверки **не требуется** — контрольное событие
даёт ту же уверенность в dev, где соак и пойдёт, без второго кошелька и без
контрольного конфликта. Отдельное окружение остаётся законным средством
изоляции баланса и ключей, если такая изоляция понадобится; тогда см. чек-лист
операторских шагов в `worker/wrangler.toml`.


## Откат ниже разводки индексов

Читатель `/admin/metrics` — часть воркера. Откат ниже коммита с разводкой
вернёт старый шаблон `index1 = 'event'`, и строки новой схемы
(`event:discriminator`) **перестанут показываться в отчётах**, оставаясь в
датасете. Потеря тихая: отчёт ответит меньшим числом, а не ошибкой.

**Флор при этом НЕ поднимается.** `docs/ROLLBACK.md` («The floor is NOT raised
by this release») запрещает это прямо: до появления клиента с
`BACKUP_IMPORT_ENABLED=true` от семантической идемпотентности ничего не
зависит, а поднятый флор убрал бы безопасный откат при дефекте, найденном во
время того самого соака. Потеря видимости строк — не основание закрывать
единственный путь отката; она лечится читателем, а не запретом откатываться.

Порядок отката:

1. Откатываться как обычно — ограничений со стороны метрик нет.
2. После отката **считать отчёты `/admin/metrics` неполными** и читать метрики
   через `worker/scripts/metrics-export.mjs metrics`: он не зависит от
   развёрнутой версии и читает обе схемы.
3. `worker/scripts/metrics-export.test.mjs` сравнивает SQL скрипта с
   `buildMetricsReportSql` символ в символ. Если один изменили без другого,
   тест падает — чинить нужно пару, а не тест.
