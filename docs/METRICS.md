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
node worker/scripts/metrics-export.mjs metrics --from <D>T00:00:00Z --to <D+1>T00:00:00Z
node worker/scripts/metrics-export.mjs logs    --from <D>T00:00:00Z --to <D+1>T00:00:00Z --worker eternal-notes-proxy
```

Суточные интервалы — **фиксированные календарные сутки UTC**, а не
`--hours 24` от момента запуска: у относительного окна край каждый день
другой, соседние архивы то перекрываются, то оставляют щель, а повторить
выгрузку «тех же суток» нельзя. Запускать не раньше чем через **5 минут
после полуночи**: события доезжают до хранилища с задержкой (см. «Задержка
приёма» в проверке доставки), и `--to` моложе пяти минут скрипт отмечает
предупреждением. Относительный `--hours N` остаётся для быстрых проверок
доступа и сам заканчивается на 5 минут раньше «сейчас» по той же причине.

**Срок хранения — неполнота, которую не поймать перечитыванием.**
Workers Logs хранит события ограниченное число дней (максимум семь, на Free —
три), и запрос дальше этого срока не падает: хранилище отдаёт что осталось, а
архив выглядит полным. Поэтому в режиме `logs` **начало** интервала проверяется
до первого запроса: старше срока — отказ. Тариф аккаунта скрипту не виден, и по
умолчанию он ручается за КОНСЕРВАТИВНЫЕ три дня; `--retention-days N` (не
больше семи) поднимает границу только когда тариф известен. Все штатные
процедуры в трёх днях умещаются — суточный архив наутро, пропущенные сутки
днём позже, проверка доставки, `--hours 1`. А вот `--hours 168` с учётом
пятиминутного отставания начинается раньше даже семидневного максимума и
отказывается всегда: **полное окно соака собирается из суточных архивов, а не
одной выгрузкой.**

`soak-d2.mjs snapshot` архивирует **только Analytics Engine** — логи он не
трогает. Их забирает `metrics-export.mjs`, и ему нужен **отдельный токен**
(`Account → Workers Observability → Read`); в `CF_ANALYTICS_TOKEN` этих прав
нет.

Как `metrics-export.mjs logs` защищает выгрузку:

- диапазон режется на срезы (`--slice-minutes`, по умолчанию 60), запрос идёт
  по каждому срезу отдельно;
- срез читается страницами по 100 (верхнеуровневый `limit` — это и есть
  размер страницы, измерено живьём; размеры страниц пишутся в архив), а срез,
  дошедший до собственного потолка скрипта (2000 событий), **обрывает
  выгрузку ошибкой**: он неотличим от усечённого, а молча короткий архив хуже
  отсутствующего — его прочитают как «ничего не было». Лечение — меньший срез;
- любой не-2xx от API даёт исключение, а не пустой результат;
- **ноль событий на всём диапазоне — находка, а не успех**: ровно так выглядит
  «логи не собирались». Скрипт говорит об этом отдельной строкой;
- ответ с `success: false` при HTTP 200 — ошибка, а не пустой результат;
- ответ, отданный из СЭМПЛИРОВАННОГО слоя (`abr_level > 1`), отвергается: его
  числа — оценки, а ровно этого экспорт и должен избегать;
- после листинга каждый срез **пересчитывается самим хранилищем** (представление
  `calculations`, `count` с тем же фильтром). Листинг обязан вернуть ровно
  столько строк, сколько хранилище насчитало; расхождение означает, что **два
  чтения не согласованы**, и выгрузка обрывается. Виновник при этом не
  назначается: запросы идут один за другим, а не из одного снимка, и между
  ними может доехать задержанное событие или истечь срок хранения — как и
  дефект чтения, всё это подходит, причина расхождением не устанавливается.
  Ответ пересчёта проверяется по форме целиком: ровно одна калькуляция
  `count` с ровно одним агрегатом; пустой срез хранилище отвечает ЯВНО
  (`{ value: 0, interval: 0, count: 0 }`), а всё остальное — отказ, потому что
  ноль, изготовленный парсером из повреждённого ответа, подтвердил бы пустой
  листинг. И только этот путь
  показывает **вес строки**: `interval ≠ 1` означает, что хранилище само
  считает строку представителем нескольких событий, то есть срез — выборка по
  его собственному признанию. Такой срез архивируется, но помечается
  (`slices[].store.sampled`, `counts.storeSampledSlices`), а в выводе есть
  предупреждение: ноль, прочитанный из такого среза, — не ноль;
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
   Проверять надо **успешный авторизованный ответ API**, а не то, что файл с
   токеном читается: «дошло до запроса» одинаково верно и для отозванного
   токена, и для токена без нужных прав. Запустить `metrics-export.mjs logs
   --hours 1` и различить три исхода:

   - **exit 0, ноль событий** — доступ подтверждён и к `/keys`, и к `/query`.
     Ноль здесь ожидаем: сбор ещё не включён;
   - **`HTTP 401` / `HTTP 403`** — в авторизации отказано. Чинить ДО деплоя,
     иначе окно хранения будет тратиться на выяснение прав;
   - **`API reported failure`** — API ответил без `success: true`. Это НЕ
     обязательно токен: так выглядит любой неуспех, включая неверно
     сформированный запрос. Причину читать из текста ошибки — скрипт печатает
     то, что вернул API в `errors`;
   - **`none of the known script-name keys`** — точная трактовка: **доступ к
     `/keys` подтверждён; ключ имени воркера не определён. Причина и
     работоспособность `/query` НЕ установлены.** До `/query` выполнение здесь
     вообще не доходит. Возможных причин несколько — у хранилища ещё нет схемы
     (ничего не собиралось), имя поля отличается от списка кандидатов
     `SCRIPT_KEY_CANDIDATES`, формат ответа не тот. Начинать надо с
     ФАКТИЧЕСКОГО ответа `/keys` — несовпадение формата и лишнее имя поля часто
     видны прямо в нём. Если данных не хватает, повторить после включения
     сбора.

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

   **Где лежит строка в событии** (проверено живьём 2026-09-11, воркер
   `9e0a9a1`): для `console.error(JSON.stringify(x))` хранилище само
   разбирает JSON и кладёт его поля в объект верхнего уровня `source` рядом с
   `level`; поля `$metadata.message` у такого события НЕТ, а
   `$metadata.error` содержит просто строку `"error"`. У запроса
   (`$metadata.type = cf-worker-event`) строка вида `POST https://…` лежит и
   в `$metadata.message`, и в `source.message`. Экспортёр читает `source`
   первым (`structuredOf`) и разбирает текст сам, только если хранилище
   оставило строку неразобранной. Первый живой прогон провалился именно на
   форме: контрольная строка ДОШЛА, а экспортёр искал её в поле, которого у
   структурных строк не бывает. Отсюда правило: **отказ утверждения — ещё не
   результат доставки в любую сторону**; прежде чем делать вывод, выгрузить
   интервал без `--expect-probe` и посмотреть на фактические события.

   Утверждение падает и во втором случае: если хранилище **само взвешивает
   строки** среза (см. «Пересчёт хранилищем» ниже). Увиденная контрольная
   строка доказывает доставку ЭТОЙ строки и ничего об остальных, а проверка
   доставки должна ручаться за канал. Суточная выгрузка такой срез сохраняет с
   пометкой; проверка — отвергает.

3. **Многостраничность — отдельно, бесплатными запросами.** Набрать всплеск
   `GET /health?nonce=<16 hex>` (платного пути не касается, критериев не
   двигает; nonce обязан быть 16 строчных hex-символов, иначе воркер отвечает
   400 — это тоже инвокация, но сверять по телу ответа уже нечего) и выгрузить
   тем же способом. Доказательством служит **вторая НЕПУСТАЯ страница с новым
   курсором**; лишний запрос, вернувший пустоту, не доказывает ничего.
   Экспортёр пишет размеры всех страниц среза в архив (`slices[].pages`) и в
   вывод — `pages [100, 31]` и есть доказательство, `pages [131, 0]` — нет.

   **Как API страничит на самом деле** (измерено 2026-09-11 на срезе из 131
   события): размер страницы задаёт **верхнеуровневый** `limit` — с
   `limit: 100` пришло 100, затем по `offset = <$metadata.id последнего>` —
   31 без пересечений, затем 0; с `limit: 20` — 20 и 20. Поле
   `parameters.limit` для `view: 'events'` размером страницы НЕ является:
   с 100 и с 10 ответ был один и тот же — все 131. Первая версия экспортёра
   слала именно его как «страницу», а 2000 — наверху, и потому не страничила
   никогда: суммы сходились, контракт был неверен, а шаг 3 пройти было
   нельзя. Порядок событий в ответе — от новых к старым.

4. **Сверка по идентификаторам, не по количеству.** Число лог-событий не
   обязано равняться числу запросов: одна инвокация даёт несколько строк
   `console` (у контрольного события их две — запрос `cf-worker-event` и
   структурная строка `cf-worker` с общим `$metadata.requestId`), плюс идут
   фоновые события. Сверяются уникальные идентификаторы контрольных
   `/health`, и ключ надо брать правильный: заголовок ответа `cf-ray`
   (`a396f0cf7db35b33-VIE`, до дефиса) лежит в событии как
   **`$metadata.rayId`** (и в `$workers.event.request.headers.cf-ray`);
   `$metadata.requestId` — это ДРУГОЙ, внутренний 32-hex идентификатор, и
   сверка по нему даёт ноль совпадений при полной доставке. Второй,
   независимый ключ — сам nonce: он виден в `$workers.event.search.nonce`.
   Оба ключа должны сойтись на одном и том же множестве.

   **Задержка приёма.** События появляются в хранилище не мгновенно: при
   выгрузке через 11 секунд после конца всплеска не хватало 10 из 130, через
   72 секунды — 9 из них уже были. Выгружать интервал раньше чем через
   несколько минут после его конца — значит архивировать неполноту и потом
   читать её как потерю; ежедневная выгрузка должна отставать от края
   интервала не меньше чем на 5 минут.

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
Больше того, сверка покрытия в самой проверке дала **неполный результат**:
из 260 контрольных инвокаций `/health` 2026-09-11 (два всплеска по 130; у
второго все 130 ответов — HTTP 200 с эхом nonce в теле, то есть воркер
отработал каждую) в полученных выгрузках не найдены 2 — по одной в каждом
всплеске (`cf-ray` `a396f056cdbd3251` и `a396fa5fcff9325f`), ни через
минуту, ни через три с половиной часа. Это **наблюдаемая недостача 0,77 % в
данной проверке**, и ровно столько она устанавливает. Частота потерь канала
из двух всплесков не выводится. Теряются ли структурные строки внутри
доставленной инвокации независимо от неё — не измерено (двух контрольных
событий для этого мало).

**Что установило расследование 2026-09-12 (только чтением):**

- **не найдены ни одним из перечисленных способов на момент повторной
  проверки (+33 ч).** Обе инвокации отсутствуют в листинге событий с фильтром
  по воркеру и без фильтра, по точечному фильтру `$metadata.rayId = <ray>`
  (соседняя инвокация тем же фильтром находится), по фильтру на nonce, в
  собственном пересчёте хранилища (`calculations`: 263 уникальных `rayId` за
  час — ровно столько же, сколько в листинге) и в представлении
  `invocations`. Гипотеза дефекта пагинации экспортёра этим существенно
  ослаблена: пересчёт и `invocations` — не листинг. «Не задержка» отсюда не
  следует: 33 часа — это срок повторной проверки, а не граница возможной
  задержки;
- **хранилище само взвешивает строки.** В окне первого всплеска на 131 строку
  листинга пересчёт даёт `count = 140, interval = 1,0687`: одна строка
  (`cf-ray` `a396f02b3ce68f2b`, инвокация pg067) несёт `sampleInterval = 10`
  при `uniq($metadata.id) = 1` — ОДНА сохранённая строка, которую хранилище
  считает представителем десяти. Так выглядит след сэмплирования на приёме,
  при `head_sampling_rate = 1` и объёмах на порядки ниже документированного
  порога в 5 млрд событий в сутки. Представление событий этого поля не
  показывает вовсе; `abr_level` — про сэмплирование при чтении и всё время
  был равен 1. За весь период с деплоя такая строка одна из 265;
- **связи между взвешенной строкой и недостачей нет.** Взвешена pg067,
  отсутствует pg081 (пятью секундами позже); соседи pg066 и pg068 на месте с
  весом 1. Во втором всплеске взвешенных строк нет ни одной, а инвокация
  отсутствует. Значит: сэмплирование в канале **присутствует по признанию
  самого хранилища**, но две конкретные недостачи ему построчно не
  приписываются, и их причина по-прежнему не установлена.

Практическое следствие для критериев от причины не зависит: **ноль
`critical`-строк в логах — не доказательство нуля исходов**, а второй канал
остаётся тем, чем объявлен, — способом увидеть исход, который Analytics Engine
мог отсэмплировать, без гарантии увидеть каждый. С 2026-09-12 экспортёр читает
вес строк сам («Пересчёт хранилищем»), и проверка доставки на взвешенном срезе
отказывает — именно так она и завершилась бы на интервале первого всплеска.
Покрытие ВНУТРИ окна контролируется отдельно — ежедневными выгрузками (см.
«Ежедневное сохранение свидетельств»).

Читать эти выгрузки надо в обе стороны, и ни одна из них не даёт вывода сама
по себе:

- **пустой день или расхождение с ledger — это ПОВОД РАССЛЕДОВАТЬ, а не
  установленная деградация.** Невинных объяснений хватает: в этот день просто
  не было запросов; интервал выгрузки не совпал с временем активности; либо
  сработала уже описанная разница знаменателей (у ledger и телеметрии они
  разные по построению). Расследовать надо до конца окна, а не после — но
  начинать с вопроса «почему», а не с вывода «канал сломался»;
- **непустая выгрузка полноту НЕ подтверждает.** Она говорит лишь, что
  что-то доехало. Сколько НЕ доехало, из неё не видно, и никакое количество
  непустых дней этого не меняет.

### Пересчёт хранилищем

Представление `calculations` (`count` с тем же фильтром и тем же интервалом)
отвечает `{ value, interval, count }`: `value` — оценка хранилища
(строки × вес), `interval` — средний вес, число строк = `value / interval`.
Пример живого ответа: `value 140, interval 1,0687` на 131 строку — одна строка
весом 10. Экспортёр делает этот запрос после листинга каждого среза и:

- **обрывает выгрузку**, если листинг вернул не столько строк, сколько
  хранилище насчитало: два чтения не согласованы. Причина этим не
  установлена — запросы последовательны, между ними может доехать
  задержанное событие, истечь срок хранения или проявиться дефект чтения, —
  но молча короткий архив хуже отсутствующего, и повторить выгрузку позже
  дешевле, чем разбирать архив неизвестной полноты;
- **отказывает на любом ответе, кроме двух увиденных живьём**: ровно одна
  калькуляция `count` с ровно одним агрегатом, где пустой срез — явный
  `{ value: 0, interval: 0, count: 0 }`. Первая версия читала отсутствующие
  `aggregates` как «ноль строк» и подтвердила бы пустой листинг повреждённым
  ответом (`calculations: [{}]`);
- **помечает срез** (`store.sampled = true`), если `interval ≠ 1`, — это
  признание хранилища, что срез — выборка. Суточный архив пишется с пометкой;
  проверка доставки (`--expect-probe`) на таком срезе падает.

Чего пересчёт не даёт: строки, которых нет ни в одном представлении, он не
видит так же, как листинг. Он ловит расхождение между двумя путями чтения и
вес того, что сохранено, — не полноту.

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
