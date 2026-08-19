# План: устойчивость доступа к Arweave (multi-gateway, метрики, restore.html)

Статус: **v4 — третий раунд ревью учтён** (ревью 1: 2 critical + 6 high + 4
medium; ревью 2: 8; ревью 3: 3 — все приняты). Дата: 2026-08-19. Строится
поверх задеплоенного инкрементального sweep (PR #53). Остаточные блокеры полной
реализации — конец §8. Принцип v4: каждое спорное место — ОДНО нормативное
решение без альтернатив.

Документ адресован ревьюеру: фиксирует решения, объём, разбиение на PR,
инварианты, тестовые сценарии и границы. Ключевое изменение v2: **PR-3
разделён на read-path и write-path**, потому что write-path (upload failover)
несёт риск второй платной транзакции и требует более строгого протокола, чем
read-path.

---

## 1. Контекст: проверенные факты

Постоянное хранение (Arweave) и постоянный доступ (gateway) — разные свойства.
Сегодня доступ жёстко завязан на единственный `arweave.net`:

| Место | Файл | Что делает |
|---|---|---|
| Клиент | `src/lib/arweave.ts:207` | проба доступности `/info` |
| Клиент | `src/lib/arweave.ts:242` | статус транзакции `/tx/{id}/status` |
| Клиент | `src/lib/arweave.ts:513` | GraphQL-поиск при restore |
| Клиент | `src/lib/arweave.ts:677` | payload `/raw/{txId}` |
| Worker | `worker/src/index.ts:144, 747` | `Arweave.init` (anchor+price+post) |
| Worker | `worker/src/index.ts:933` | серверная перепроверка статуса |
| CSP | `scripts/postbuild.mjs:39` | `connect-src` пинит только `arweave.net` + proxy |

Дефекты семантики статусов: клиент трактует одиночный `404` → `dropped`
(`arweave.ts:247`); Worker — `404` **и `400`** → `dead` (`index.ts:938`).

Что УЖЕ защищено кодом (проверено, менять не нужно):

- подмена payload между версиями невозможна: внутренний `id` конверта обязан
  совпадать с Note-Id-тегом (`arweave.ts:795–803`), каждая версия — свой uuid;
- «текущая» версия — по аутентифицированному timestamp ИЗНУТРИ AES-GCM-конверта
  (`chains.ts`, `byCurrentness`), не по данным шлюза;
- restore fail-closed по `VITE_TRUSTED_OWNERS` (`config.ts`).

Инкрементальный sweep (PR #53) уже принял модель недоверия одному индексу:
сознательно НЕТ block-height cursor (курсор навсегда терял бы отставшую
транзакцию). Multi-index — прямое продолжение той же логики.

**Граница защиты (уточнение по ревью).** Инварианты выше и multi-index
защищают от подмены и от умалчивания ОДНОГО индекса. Они НЕ доказывают
глобальную полноту: все настроенные индексы могут отставать или согласованно
умалчивать. `incomplete=false` означает строго «все настроенные endpoint
дочитаны до конца», а не «на chain больше ничего нет». Остаточная
Byzantine-модель фиксируется в ADR и, где уместно, в UI.

## 2. Зафиксированные решения

- **D1. Список шлюзов — build-time**, как `VITE_TRUSTED_OWNERS`; смена = релиз.
- **D2. Multi-index restore — всегда параллельно.** Осознанная цена: метаданные
  активности (Owner-Hash, число транзакций, IP) видят все операторы шлюзов.
  Формулировка эффекта — «**снижает** риск single-index omission», НЕ «закрывает
  умалчивание» (см. §1, граница защиты).
- **D3. Strict verification (data_root/Wayfinder) — «защита в глубину»**, не в
  этом плане. Основание — инварианты §1.
- **D4. Доступ к метрикам: `/admin/metrics` (bearer `ADMIN_SECRET`) + прямой
  Cloudflare Analytics Engine SQL API.**
- **D5. Телеметрия — только серверная.**
- **D6. `restore.html` хранится на Arweave и распространяется как СКАЧИВАЕМЫЙ
  ФАЙЛ** с проверкой SHA-256 (реш. 1 §7) — не как исполняемая gateway-страница.
  txId в README и приложении. Это снимает critical-1.
- **D7. Конкретные адреса шлюзов утверждаются ДО production-wiring** (не «в PR
  по ходу»): реальные URL, операторы, CORS, GraphQL schema/pagination, limits,
  status-поведение, sandbox-redirect для HTML. См. §4.PR-3a и открытые вопросы.
- **D8. Типы endpoint РАЗЛИЧАЮТСЯ + дедуп по РАЗНЫМ ключам (ревью 2, H5).**
  Индексы — ПОЛНЫЕ публичные HTTPS URL (`INDEX_ENDPOINTS`), т.к. реальные
  кандидаты (Goldsky) имеют путь `/api/public/.../gn`, а не `origin+/graphql`;
  два разных endpoint на одном `api.goldsky.com` имеют ОДИН origin, поэтому
  `INDEX_ENDPOINTS` канонизируются и дедуплицируются по **полному URL**.
  `STATUS/PAYLOAD/UPLOAD_GATEWAYS` — bare origins, дедуп по **origin**. CSP
  `connect-src` строится ТОЛЬКО по извлечённым origin. Клиентский bearer для
  приватных индексов НЕ используется. (Ошибка v2 «дедуп всех списков по
  origin» отбросила бы один из двух Goldsky-endpoint — исправлено.)

## 3. Объём и границы

Уже реализовано (main, PR #53): инкрементальный sweep, sentinel-модель,
суточная страховочная сверка, прицельный ремонт, решение «нет cursor». Этот
план строится ПОВЕРХ и не меняет его семантику.

Сознательно ВНЕ объёма (отдельные ADR):

- bundles/ANS-104 — закрыто до изменения масштаба на порядки;
- AO/HyperBEAM/Solana/ArNS — не в цепочке восстановления;
- Wayfinder SDK — не в PWA-бандл;
- клиентская телеметрия (D5);
- автотриггеры sweep + `/feed` — разблокированы, но следующий трек ПОСЛЕ
  read-path multi-index.

**Возвращено В объём по ревью (было «отдельный ADR»):** сохранение подписанной
транзакции/txId ДО первого POST. Причина — без него безопасный upload failover
невозможен (critical-2). Это ПРЕДУСЛОВИЕ write-path (§4.PR-3b), не опциональное
улучшение.

## 4. Разбиение на PR (порядок = порядок мержа)

### PR-1 «ADR + план»

- `docs/ARWEAVE-RESILIENCE-PLAN.md` (этот файл).
- `docs/adr/0001-...md`: «Arweave — permanent layer, gateway — заменяемый
  transport», решения D1–D8, privacy trade-off D2 (абзац), **остаточная
  Byzantine-модель полноты (§1)**, список «не делаем» с условиями пересмотра.
- В ADR также: **инвариант same-signed-tx** (write-path не создаёт вторую
  подпись) и **trust-инвариант restore** (байты HTML проверяются в runtime до
  приёма seed).

### PR-2 «Метрики»

**Предусловие (ревью 1+2, M1):** `Arweave.createTransaction()` сам делает
anchor+price запросы внутри SDK — из вызовов только `index.ts` нельзя
раздельно измерить anchor|price|post. Поэтому СНАЧАЛА выделяется явный
**transport adapter** (`worker/src/arweave-transport.ts`): `getAnchor` и
`getPrice` вызываются ЯВНО, их результат **передаётся в `createTransaction`
уже загруженным** (`{last_tx, reward}`), так что SDK больше НЕ делает скрытых
сетевых запросов; `postTx` — отдельная инструментируемая функция. Без этого
метрики транспорта недостоверны.

- `wrangler.toml` (+ **staging vars/bindings**, не только production —
  named staging НЕ наследует production bindings):
  `[[analytics_engine_datasets]] binding = "METRICS"`.
- Схема событий фиксируется ТАБЛИЦЕЙ в `docs/METRICS.md` со стабильным
  порядком blob/double-полей (Cloudflare требует стабильного порядка):
  `gateway_call`(endpoint-тип, хост, класс статуса, latency), `upload_outcome`,
  `status_verdict`.
- **Разделение repost-метрик (ревью 2, M1):** «repost → к нулю» из v2
  двусмысленно — безопасный resend ТОГО ЖЕ txId (PR-3b) и настоящий платный
  redrop (новый txId после dead) — разные события. Метрики:
  `post_attempt_same_tx` (норм. failover, НЕ регрессия), `post_accepted`,
  `redrop_new_tx` (новый txId после подтверждённого dead), `resign_violation`
  (аларм: новая подпись без dead). **Главный security-KPI = число НОВЫХ txId
  на одну версию БЕЗ подтверждённого dead → должно быть 0.**
- Отчёты учитывают **sampling** (`_sample_interval` в агрегатах) — иначе
  доли и счётчики занижены.
- Запрет содержимого: ни plaintext, ни seed, ни ключей, ни note content, ни
  сырых идентификаторов.
- Инструментация не может уронить путь запроса (try/catch, best-effort).
- `/admin/metrics` (по ревью): раздельные ответы — **отсутствует конфиг
  сервера → 503**, **отсутствует/неверный bearer → 401**; `Cache-Control:
  no-store`; upstream timeout к SQL API; ограниченный размер результата;
  только белый список отчётов (никакого free-form SQL через Worker).

### PR-3a «Read-path multi-gateway» (status + validated payload fallback)

Безопасно выпускается отдельно — только чтение, платных транзакций не создаёт.

**Конфигурация (D8):**

- `src/lib/gateways.ts`: `INDEX_ENDPOINTS` (полные HTTPS URL),
  `PAYLOAD_GATEWAYS`, `STATUS_GATEWAYS` (bare origins). Валидация как у
  `PROXY_URL` (`arweave.ts:30–38`).
- **Канонизация и дедуп по РАЗНЫМ ключам (D8, H5):** `INDEX_ENDPOINTS` — по
  полному URL (два Goldsky-endpoint одного origin остаются оба);
  `STATUS/PAYLOAD` — по origin (дублированный origin в CSV не создаёт ложный
  «кворум»).
- `postbuild.mjs:39`: `connect-src` = union origin(ов) ВСЕХ списков (для
  индексов — origin, извлечённый из полного URL) + proxy.
- **Пустой env НЕ эквивалентен текущему поведению** (исправление ложного
  утверждения v1): при пустых списках payload/status дефолт — `arweave.net`,
  НО семантика статусов ниже применяется всегда (одиночный 404 больше не
  `dropped`). Это осознанное изменение поведения, а не no-op; фиксируется
  тестом и в ROLLBACK.

**Статус — кворум с полной таблицей (по ревью):**

- считаются только уникальные canonical origin; локально валидируется
  43-символьный base64url txId (иначе `invalid`, без сети);
- таблица verdict (нормативная, одна для клиента и Worker):

  | Наблюдение | Verdict |
  |---|---|
  | ≥1 источник `200` (валидное тело) | `confirmed` |
  | ≥1 источник `202`, нет `200` | `pending` |
  | `200` с malformed телом | не засчитывается как alive → как `unavailable` от этого источника |
  | `404` от ВСЕХ источников, ответивших ≥ `MIN_DEAD_WITNESSES` уникальных | кандидат в `dead` (+ 30-мин age guard Worker-а) |
  | `404`, но ответивших уникальных источников < `MIN_DEAD_WITNESSES` | `unavailable` |
  | `400`, `429`, `503`, timeout | `unavailable` (НИКОГДА не `dead`) |

- **Политика dead (ревью 2, H4): `MIN_DEAD_WITNESSES = 2`.** `dead` требует
  N-of-N (все настроенные согласованно `404`) **И минимум ДВА уникальных
  ответивших источника**. При ЕДИНСТВЕННОМ настроенном источнике N-of-N
  вырождается в 1-of-1 — это ловушка «одиночный 404 снова dead», поэтому один
  источник + `404` → всегда `unavailable`. **Production build fail-closed
  требует ≥2 status-origin** (иначе dead недостижим — безопасная сторона).
  Ослабление до 2-of-3 при большем числе источников — только явным решением с
  независимостью операторов в ADR. Недоступный источник не голосует «за».
- Worker `getTxStatusWorker`: `400` больше НИКОГДА не `dead`; тот же кворум и
  тот же `MIN_DEAD_WITNESSES`. Бюджет subrequests ≤ (хостов × проверок) в
  лимите Cloudflare.

**Payload fallback (по ревью, high):**

- перебор `PAYLOAD_GATEWAYS` до ПЕРВОГО ответа, прошедшего **JSON shape +
  inner-id = tag + AES-GCM** проверку. `200` с обрезанным/чужим/повреждённым
  телом НЕ останавливает перебор — успешная валидация второго шлюза
  нейтрализует ошибку первого. Существующие проверки не ослабляются.
- `isArweaveOnline` → «жив хотя бы один status-шлюз» (`Promise.any`).

**Тесты PR-3a:**

- `404`+`202` → pending; `404` от всех при неполном ответе → unavailable;
  `400` → unavailable, redrop не запускается;
- `/raw` `200` с повреждённым телом на первом, валидный на втором → нота
  восстановлена, ошибка первого нейтрализована;
- дублированный origin в CSV не даёт кворум;
- невалидный txId → invalid без сети;
- пустой env → снапшот CSP + явный тест на ИЗМЕНЁННУЮ семантику 404;
- lock/reset отменяет запросы ко всем шлюзам.

### PR-3b «Write-path upload failover» (отдельно, строгий протокол)

**Critical-2 (принято): текущий план v1 создавал вторую платную транзакцию.**
`create+sign+post` на втором хосте = новая подпись = новый txId; `5xx`/timeout
не доказывает, что первый шлюз не принял транзакцию → две платные публикации
одной версии. Прямо нарушает P0-инвариант исходного отчёта.

**Протокол (нормативный):**

1. anchor и price можно переключать между шлюзами ДО подписания.
2. Подпись создаётся РОВНО ОДИН раз → ровно один txId.
3. **Предусловие:** подписанная транзакция и её txId сохраняются в DO ДО
   первого POST. Потерянный ответ реконсилируем, а не повод для второй подписи.
4. Failover POST = повторная отправка ТОГО ЖЕ сериализованного transaction с
   ТЕМ ЖЕ txId на другой шлюз. `208 Already Reported` — допустимый ответ POST
   /tx, трактуется как принято.

**Нормативная state machine DO (ревью 2 H2, ревью 3):**

Текущий lifecycle `reserved → posted → committed` (reserved TTL 10 мин)
расширяется до `reserved → signed → posted → committed`. Поля `signed`:
`{noteId, txId, signedTxBytes|ref, anchorHeight, reserveToken, signedAt}`.

**Проблема ревью 3: одно `signed` покрывало ДВА случая (до и после диспатча
POST), и после crash нельзя доказать, какой именно → нельзя доказать,
допустим ли release. Нормативное решение (без альтернатив): `signed`
НИКОГДА не подлежит release и НИКОГДА не TTL-expire.** Как только транзакция
подписана, единственные допустимые действия — resend ТОГО ЖЕ txId и
reconciliation по кворуму статуса. Это снимает необходимость различать
«до/после POST»: оба случая безопасны под одним правилом, а окно дубля
закрыто по построению (release, стирающий запись о возможно-принятом txId,
недостижим).

| Состояние на момент сбоя | Что сделать при recheck |
|---|---|
| `reserved`, подписи ещё нет | обычный TTL-expire → свободный слот, дубля нет |
| `signed` (любой под-случай) | **release/TTL ЗАПРЕЩЕНЫ**; только resend того же txId + reconciliation по кворуму → при alive записать `posted` |
| `posted` | как сегодня: кворум alive→commit, dead→redrop (новая подпись только тут) |
| `committed` | идемпотентный happy-path |

- **Освобождение слота для `signed`:** не по TTL, а ТОЛЬКО через переход
  вперёд (`posted`/`committed`) либо после доказанного окончательного отказа
  (кворум dead + age guard) — это единственный путь, где создаётся новая
  подпись.
- **Истечение anchor:** подписанная tx с протухшим anchor (~50 блоков) на
  chain не попадёт. Пересоздание — только после подтверждения кворумом, что
  старый txId не alive. Это частный случай «доказанного окончательного
  отказа» выше, отдельная ветка с тестом.

5. Если SDK не гарантирует resend той же подписи — **fail closed ДО первого
   POST** (не создавать `signed`), без повторного подписания. После создания
   `signed` release НЕДОСТИЖИМ по определению статуса.

**Rollback floor (ревью 2, H3) — reader-before-writer в ДВА Worker-релиза:**

Старый Worker не знает статус `signed`: `check-and-reserve` примет его как
неизвестный, `release` умеет удалять только `reserved`. Прямой откат writer на
текущий Worker потерял бы `signed` или дал дубль. Поэтому:

1. **Reader-релиз:** Worker умеет безопасно ЧИТАТЬ/резюмировать `signed`
   (реконсиляция, resend), но ещё НЕ создаёт его. Совместим со старыми
   клиентами (новых обязательных полей запроса нет — resume полностью
   server-side).
2. **Writer-релиз:** начинает создавать `signed`. После него — **hard
   rollback floor** (`worker-rN`): откат ниже reader-релиза запрещён.
3. Внешний `/upload`-контракт остаётся совместим со старыми клиентами.

**Тесты PR-3b (интеграционные):**

- вся матрица `reserved/signed/posted/committed` × crash до/после каждого DO
  write и до/после POST-диспатча;
- POST отправлен, ответ потерян → recheck НЕ создаёт новый txId и НЕ делает
  release;
- `5xx` от первого шлюза, тот же tx принят вторым → один txId на chain; `208` → accepted;
- истёкший anchor → пересоздание только после кворума dead;
- откат writer→reader-floor и старый клиент→новый Worker;
- невозможность resend → fail closed ДО POST, ноль вторых транзакций;
- reservation/recovery/quota-инварианты не регрессируют.

### PR-4 «Multi-index restore union»

Строится поверх sentinel-модели (§1). Компоновка union и sentinel — самая
тонкая часть; ниже специфицирована явно.

- `fetchPage` параметризуется endpoint-ом; пагинация ВНУТРИ индекса
  последовательна (курсор `after` opaque, непереносим), индексы — параллельно
  с backoff (ниже).
- **Схема `block` (по ревью, high):** GraphQL `block` сейчас не запрашивается
  и по контракту nullable (`block: {height} | null`). PR-4 добавляет `block`
  в запрос и определяет runtime-схему + политику null-height (немайненные /
  ещё-не-проиндексированные): такие кандидаты упорядочиваются
  детерминированно (напр. после всех height-known, tie-break по txId ASC).
- **Union по txId ДО sentinel-логики.** Две оптимизации sentinel (drop
  «дубликата ниже известного» и claim по позиции) опираются на единый
  HEIGHT_DESC-поток одного индекса. При слиянии индексов такого потока нет.
  Поэтому: собрать union всех кандидатов → пересортировать по подтверждённому
  height (null-политика выше) → и ТОЛЬКО ЗАТЕМ применять sentinel-drop и claim.
  Иначе порядок ответов шлюзов сменит победителя цепочки (нарушение
  инвариантов тестов 9а/9г).
- **Конфликт metadata одного txId (ревью 2 high, ревью 3) — НОРМАТИВНО, без
  альтернатив:** если два индекса вернули для одного txId разные
  height/Note-Id/version/tags — конфликтующий txId **отбрасывается из union и
  помечает sweep `incomplete=true`** (+ лог). Не «первый выиграл», не
  «перепроверяется» — одно правило. (Перепроверка третьим источником могла бы
  стать будущим улучшением, но НЕ в этом PR.)
- `opts.known` (sentinel) работает по txId → компонуется с union без изменений
  в карте: та же `KnownTxRecord`-проверка (Note-Id тег + класс версии).
- `incomplete`-семантика строгая: `incomplete=false` только если ВСЕ индексы
  дочитаны. Держит продвижение `sweep-full-at` (§1) честным.
- `ArweaveIndexUnavailableError` — только когда ПЕРВАЯ страница упала у ВСЕХ
  индексов (не по abort).

**Backoff (по ревью, medium):**

- per-index: число попыток + **общий бюджет времени** (deadline), обработка
  всех `5xx` и `Retry-After`, **abort-aware ожидание** — и fetch, и backoff
  timer отменяются caller-signal (lock/reset не должен ждать мёртвый secondary
  несколько таймаутов).
- Уточнение теста: «первый индекс `503`, второй полный» → при ВРЕМЕННОМ `503`
  (успех в пределах бюджета) restore полный, `incomplete=false`; при
  ПОСТОЯННОМ отказе первого в пределах бюджета — `incomplete=true`. Тест
  разделяет два случая явно.

**Регрессия / порядок кандидатов (ревью 2, M2).** Обещание «бит-в-бит»
уточняется: новая сортировка `height + txId ASC` могла бы изменить порядок
кандидатов одного блока и `block=null` относительно нынешнего GraphQL
HEIGHT_DESC, а для одинакового Note-Id порядок влияет на sentinel-drop и claim.
Решение: **в single-index режиме сохраняется исходный edge-order индекса
(HEIGHT_DESC) без пересортировки** — 16 тестов `arweave.incremental.test.ts`
проходят бит-в-бит. Новая детерминированная сортировка применяется ТОЛЬКО при
union ≥2 индексов, где единого потока и так нет. Новые тесты: equal-height,
mixed null-height, перестановки ответов индексов не меняют победителя.

### PR-5 «restore.html на Arweave»

**Critical-1 (принято): trust-модель v1 недостаточна.** txId и AES-GCM
защищают ДАННЫЕ заметок, но не делают HTML-ответ шлюза доверенным исполняемым
кодом. Нечестный шлюз может отдать изменённую страницу, переписать её CSP и
украсть введённую seed ДО любой проверки envelope. SHA-256-сверка после
публикации проверяет релиз в момент публикации, а не байты, которые браузер
получит позже. Дополнительно: запрет собственных localStorage/IndexedDB/SW НЕ
защищает от ранее установленного ЧУЖОГО Service Worker на общем origin шлюза
(worker в корне получает корневой scope). ar.io для этого вводит
tx-specific sandbox subdomains.

**Trust-модель — ВЫБРАН вариант B (реш. 1 §7): скачиваемый файл.** HTML
распространяется как файл с независимой проверкой SHA-256, НЕ как исполняемая
страница по gateway-URL.

**Механики file-mode (ревью 2 H1, ревью 3) — нормативно, без альтернатив:**

Ключевой вывод ревью 3: MIME, `Content-Disposition` и расширение контролирует
ШЛЮЗ — недоверенный шлюз может исполнить подменённый HTML при прямой
браузерной навигации ДО проверки SHA-256. Значит барьер НЕ должен зависеть от
кооперации шлюза и НЕ может быть «инструкцией пользователю». Нормативно:

- **Доверенный путь = проверка в уже доверенном коде (основной).** Байты
  restore получает и проверяет НЕ переход по gateway-URL, а **доверенный
  агент**: (а) само PWA (это уже доверенный код с запиненным эталонным
  SHA-256) — фонить байты restore с ≥1 шлюза, сверить хеш в приложении и
  отдать пользователю как проверенный Blob для сохранения/открытия; либо
  (б) для холодного восстановления, когда приложения нет, — **отдельная
  неисполняющая проверочная утилита** (downloader/verifier), которая
  скачивает файл, считает SHA-256 и лишь при совпадении отдаёт его.
  Прямой клик по gateway-URL НЕ является поддерживаемым способом запуска.
- **Per-OS потоки verifier специфицируются в PR** для Windows / Android / iOS
  (десктоп: `certutil`/`shasum` как ручной запасной; мобильные: штатного
  средства нет → нужен конкретный проверочный инструмент, не текстовая
  инструкция). Hash mismatch ОБЯЗАН блокировать (тест).
- **Заголовки шлюза — вспомогательны, не барьер.** Публиковать с
  `application/octet-stream` / `Content-Disposition: attachment` полезно, но
  это НЕ считается защитой (шлюз волен игнорировать). Защита — только
  проверка хеша доверенным агентом выше.
- **file:// = opaque origin `null` + CORS.** Открытый локально файл шлёт
  запросы к шлюзам с `Origin: null`. GraphQL и `/raw` каждого D7-шлюза ОБЯЗАНЫ
  отвечать `Access-Control-Allow-Origin: *` (или допускать `null`). Проверяется
  из реального `file:///` контекста на поддерживаемых браузерах (acceptance).
- **Acceptance:** «gateway-код НЕ исполняется до checksum verification»
  (заменяет неприменимый к file-mode критерий про SW/sandbox).

**Прочее (по ревью, medium):**

- рендер только `textContent`/безопасные DOM API (никакого `innerHTML`);
- явный JSON-export по действию пользователя, без автосохранения формы и
  неявного экспорта; поля seed `autocomplete="off"`, `spellcheck="false"`;
- очистка ссылок на `pagehide` (без обещания физической zeroization);
- форматы v1–v4, gateway-пул D1 + ручное добавление, multi-index sweep из
  PR-4 (общий код вынесен без DOM-зависимостей);
- CSP через `<meta>`: `default-src 'none'`, инлайн-хеши, `connect-src` —
  осознанно шире PWA (иначе ручной шлюз невозможен), trade-off в ADR.

**Публикация и ротация (по ревью, high):**

- публикация ОТДЕЛЬНЫМ release-кошельком и подписанным release-manifest —
  НЕ production upload wallet (не расширять границу секрета на локальную
  машину); скрипт скачивает файл с ≥2 шлюзов и сверяет SHA-256 со сборкой.
- **Immutable restore пинит owners/gateway/форматы навсегда** → при wallet
  rotation порядок ОБЯЗАТЕЛЕН: (1) публикация нового restore с old+new
  owners → (2) обновление ссылок/verifier → (3) клиент → (4) переключение
  Worker JWK. Иначе старый restore не увидит новые записи. То же для новой
  App-Version (напр. v5): restore должен знать формат до появления таких
  записей on-chain.
- txId нового restore: README, экран настроек (`ar://<txId>`),
  `docs/ROLLBACK.md`.

**Acceptance:** восстановление при полном отключении Matamata/Cloudflare/Solana;
gateway-код НЕ исполняется до checksum verification (file-mode); hash mismatch
блокирует процедуру; GraphQL и `/raw` работают из `file:///` `Origin: null` на
поддерживаемых браузерах; malicious HTML/script/formula payload безопасно
рендерится (`textContent`); BFCache-lifecycle; форматы v1–v4.

### PR-6 «CI / deploy / rollback wiring» (по ревью, high — пронизывает все PR)

Не отдельная фича, а обязательная часть каждого PR-3a/3b/4:

- новые Vite env и Worker vars/bindings добавлены в: GitHub Actions,
  GitHub Pages, Cloudflare Pages, Worker **production И staging**, staging
  config checker;
- **production build fail-closed**: требует утверждённый multi-gateway набор,
  в т.ч. **≥2 status-origin** (H4), — иначе прод незаметно останется на одном
  `arweave.net` или dead будет недостижим;
- **Worker rollback floor (H3):** PR-3b выкатывается reader-релизом ПЕРЕД
  writer-релизом; после writer фиксируется hard floor `worker-rN` в
  `docs/ROLLBACK.md`. DO-схема `signed` де-факто требует reader-before-writer
  миграции — «каждый PR независимо откатываем» для write-path НЕВЕРНО и
  заменяется явным floor;
- `docs/ROLLBACK.md` дополняется per-PR: required secrets/vars, owner-rotation
  порядок, rollback floor, критерий отката — доказывается, а не постулируется.

## 5. Метрики успеха (по данным PR-2)

- **новые txId на одну версию без подтверждённого dead → 0** (главный
  security-KPI, H4/H2); `post_attempt_same_tx` (норм. failover) и
  `redrop_new_tx` считаются РАЗДЕЛЬНО;
- доля `status_verdict=dead`, опровергнутых кворумом → видима и падает;
- p95 latency и доля `5xx/timeout` по каждому хосту → основание D7;
- restore c `incomplete=true` — недоступна с клиента (D5); прокси-метрику по
  серверным пробам сознательно НЕ вводим.

## 6. Порядок выполнения (по ревью)

1. Исправить ADR/план по двум critical (сделано — v2) и утвердить в PR-1.
2. Утвердить endpoint-типы (D8), D7 и quorum truth table ДО wiring.
3. Transport adapter + метрики со staging/CI (PR-2 + PR-6).
4. Read-only multi-gateway: status + validated payload fallback (PR-3a + PR-6).
5. Upload failover ТОЛЬКО с одним signed txId (PR-3b, предусловие: persist
   signed tx).
6. Multi-index union с conflict/null-height политикой (PR-4).
7. restore.html — file-mode (реш. 1): доверенный агент проверяет SHA-256 до
   исполнения; `Origin:null` CORS-acceptance по D7 (PR-5). Sandbox НЕ требуется
   для этого пути (research §7 реш. 6 — вне критического пути).
8. Обновить rollback/rotation runbooks; fault-injection + staging smoke.

## 7. Решения по семи вопросам ревью (утверждены владельцем 2026-08-19)

1. **restore.html — распространяется как СКАЧИВАЕМЫЙ ФАЙЛ** (вариант B §4.PR-5)
   с независимой проверкой SHA-256, НЕ как исполняемая страница по gateway-URL.
   Это снимает critical-1: браузер исполняет байты только после того, как
   пользователь сверил контрольную сумму. PR-5 разблокирован в этой модели.
2. **Upload failover — только тот же signed tx/txId** (critical-2 закрыт).
   Persist подписанной транзакции до первого POST **возвращён в объём** (§3,
   предусловие PR-3b).
3. **`dead` = N-of-N** (все настроенные status-источники согласованно `404`).
   Недоступный источник не голосует «за».
4. **Индексы — полные публичные GraphQL URL** (D8). Goldsky остаётся
   кандидатом; клиентский bearer не используем (только публичные endpoints).
5. **Конфликт metadata / `block=null` — осторожная политика:** конфликтующий
   txId помечает sweep `incomplete=true` (не разрешается порядком Promise);
   `block=null` упорядочивается детерминированно в конец (tie-break txId ASC).
6. **Sandbox-шлюзы — research-задача (владелец: «исследуй»).** Известно из
   документации ar.io: gateway отдаёт HTML-контент не с корневого origin, а
   редиректит (301/302) на **sandbox-поддомен** вида
   `https://<base32(txId)>.<gateway>/`, изолируя каждую транзакцию в свой
   origin (чужие cookie/localStorage/SW недоступны). Точный список D7-шлюзов
   с таким поведением и формат редиректа ПОДЛЕЖАТ проверке на среде с сетевым
   доступом (здесь egress к ar.io закрыт) и закрепляются acceptance-тестом.
   Полезно и для основного приложения. НЕ на критическом пути restore, раз
   выбран скачиваемый файл (реш. 1).
7. **Wallet rotation — «сначала новый restore», отдельный release-кошелёк.**
   Порядок (runbook в `docs/ROLLBACK.md`): опубликовать новый restore со
   старым+новым owner отдельным release-кошельком → обновить ссылки/verifier
   → выкатить клиент → переключить `ARWEAVE_JWK` Worker-а. То же для новой
   App-Version (restore знает формат до появления таких записей on-chain).
   Боевой upload-кошелёк на локальную машину не выносится.

## 8. Карта соответствия (статус после ревью 2)

| PR | Статус | Главное, что закрыть |
|---|---|---|
| PR-1 ADR | needs clarification | trust-инвариант restore (checksum-before-exec), same-tx, остаточная полнота |
| PR-2 метрики | ready после схемы | transport adapter (no hidden SDK req), split repost-метрик, AE schema+sampling, auth 401/503/no-store |
| PR-3a read | ready после D7/quorum | MIN_DEAD_WITNESSES=2 (H4), dedup по типу (H5), payload-validation fallback |
| PR-3b write | **blocked** | `signed` не подлежит release/TTL (ревью 3), reader-before-writer floor (H3), anchor expiry |
| PR-4 union | risky | single-index edge-order сохранён (M2), metadata-конфликт→incomplete (нормативно), nullable height, abort-backoff |
| PR-5 restore | ready после file-mechanics | доверенный агент сверяет SHA-256 (ревью 3), `Origin:null` CORS, per-OS verifier, safe render |
| PR-6 CI/deploy | обязателен в каждом | ≥2 status-origin, **Worker rollback floor (H3)**, env/bindings везде |

**Остаточные блокеры к полной реализации (ревью 3):** (1) `signed` неудаляем —
только resend+reconcile, плюс reader-before-writer floor (PR-3b); (2)
`MIN_DEAD_WITNESSES=2` и ≥2 status-origin в prod (PR-3a); (3) restore.html
проверяется доверенным агентом до исполнения (не gateway-MIME), включая
`Origin:null` CORS (PR-5); (4) **утверждение D7** — реальные шлюзы/операторы/
CORS — предусловие PR-3a/4/5, тоже блокер, а не «по ходу».

Из ревью 1 закрыты 9 из 12; из ревью 2 приняты все 8; из ревью 3 приняты все
3 (два — снятие противоречий: `signed`-неоднозначность и «sandbox не нужен для
file-mode»).
