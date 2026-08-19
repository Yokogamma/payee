# План: устойчивость доступа к Arweave (multi-gateway, метрики, restore.html)

Статус: **v2 — переработан по ревью** (2 critical, 6 high, 4 medium сняты в
структуре ниже). Дата: 2026-08-19. Строится поверх задеплоенного
инкрементального sweep (PR #53).

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
- **D8. Типы endpoint РАЗЛИЧАЮТСЯ (по ревью).** Индексы задаются как ПОЛНЫЕ
  публичные HTTPS URL (`INDEX_ENDPOINTS`), потому что реальные кандидаты
  (напр. Goldsky) имеют путь `/api/public/.../gn`, а не `origin + /graphql`.
  payload/status/upload — bare origins. CSP извлекает origin из полного URL.
  Клиентский bearer-token для приватных индексов НЕ используется.

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

**Предусловие (по ревью, medium):** `Arweave.createTransaction()` сам делает
anchor+price запросы внутри SDK — из вызовов только `index.ts` нельзя
раздельно измерить anchor|price|post. Поэтому СНАЧАЛА выделяется явный
**transport adapter** (`worker/src/arweave-transport.ts`): отдельные функции
`getAnchor`/`getPrice`/`postTx` вокруг SDK, каждая инструментируется. Без
адаптера метрики транспорта недостоверны.

- `wrangler.toml` (+ **staging vars/bindings**, не только production —
  named staging НЕ наследует production bindings):
  `[[analytics_engine_datasets]] binding = "METRICS"`.
- Схема событий фиксируется ТАБЛИЦЕЙ в `docs/METRICS.md` со стабильным
  порядком blob/double-полей (Cloudflare требует стабильного порядка):
  `gateway_call`(endpoint-тип, хост, класс статуса, latency),
  `upload_outcome`, `repost`, `status_verdict`.
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
- **Канонизация и дедуп:** список сводится к УНИКАЛЬНЫМ canonical HTTPS
  origin — дублированный origin в CSV НЕ создаёт ложный «кворум».
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
  | `404` от ВСЕХ настроенных status-источников, ≥N ответивших | кандидат в `dead` (+ 30-мин age guard Worker-а) |
  | одиночный `404`, есть не-ответившие | `unavailable` |
  | `400`, `429`, `503`, timeout | `unavailable` (НИКОГДА не `dead`) |

- **Политика dead:** по умолчанию **N-of-N** (все настроенные status-источники
  согласованно `404`). Ослабление до 2-of-3 — только явным решением с
  независимостью операторов, зафиксированным в ADR. Недоступность третьего
  источника при двух `404` — НЕ `dead` (недоступный источник не голосует «за»).
- Worker `getTxStatusWorker`: `400` больше НИКОГДА не `dead`; тот же кворум.
  Бюджет subrequests ≤ (число хостов × проверок) в лимите Cloudflare.

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
   первого POST (возвращено в объём, §3). Потерянный ответ становится
   реконсилируемым существующей recovery-механикой, а не поводом для второй
   подписи.
4. Failover POST = повторная отправка ТОГО ЖЕ сериализованного transaction с
   ТЕМ ЖЕ txId на другой шлюз. Сетевая идемпотентность: повторный POST того же
   txId безопасен; `208 Already Reported` — допустимый ответ POST /tx,
   трактуется как принято.
5. Если SDK не гарантирует повторную отправку той же подписи — **fail closed**
   после первого POST (как сегодня: release + 502), без повторного подписания.

**Тесты PR-3b (интеграционные):**

- POST принят шлюзом, ответ потерян/timeout → повтор НЕ создаёт новый txId;
- `5xx` от первого шлюза, тот же tx принят вторым → один txId на chain;
- `208` от второго шлюза → accepted;
- невозможность resend той же подписи → fail closed, ноль вторых транзакций;
- существующие reservation/recovery/quota-инварианты не регрессируют.

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
- **Конфликт metadata одного txId (по ревью, high):** если два индекса вернули
  для одного txId разные height/Note-Id/version/tags — НЕ «первый выиграл».
  Детерминированная политика: конфликтующий txId либо отбрасывается и помечает
  sweep `incomplete=true`, либо перепроверяется; НИКОГДА не разрешается
  порядком Promise. Точную политику фиксирует PR (рекомендация: mark
  incomplete + лог).
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

**Регрессия:** все 16 тестов `arweave.incremental.test.ts` проходят при
single-index (union из одного источника == текущее поведение бит-в-бит).

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
страница по gateway-URL. Пользователь скачивает, сверяет контрольную сумму (в
README и приложении публикуется эталонный SHA-256 + txId), затем открывает
локально. Браузер исполняет байты только после сверки — нечестный шлюз не
может подсунуть исполняемый код, крадущий seed. PR-5 разблокирован.

Вариант A (sandbox-origin + runtime-самопроверка) остаётся возможным будущим
UX-улучшением; sandbox-поведение шлюзов исследуется (реш. 6 §7), но НЕ на
критическом пути.

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
злонамеренный pre-existing SW не перехватывает seed (sandbox origin);
malicious HTML/script/formula payload безопасно рендерится; BFCache-lifecycle.

### PR-6 «CI / deploy / rollback wiring» (по ревью, high — пронизывает все PR)

Не отдельная фича, а обязательная часть каждого PR-3a/3b/4:

- новые Vite env и Worker vars/bindings добавлены в: GitHub Actions,
  GitHub Pages, Cloudflare Pages, Worker **production И staging**, staging
  config checker;
- **production build fail-closed**: требует утверждённый multi-gateway набор
  (local/test могут сохранять single-gateway default) — иначе прод незаметно
  останется на одном `arweave.net`;
- `docs/ROLLBACK.md` дополняется per-PR: required secrets/vars, owner-rotation
  порядок, критерий отката. Утверждение «каждый PR независимо откатываем»
  доказывается для immutable restore и новых bindings, а не постулируется.

## 5. Метрики успеха (по данным PR-2)

- `repost` (повторная публикация той же версии) → к нулю;
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
7. restore.html — только ПОСЛЕ выбора runtime-verification и sandbox-delivery
   (PR-5).
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

## 8. Карта соответствия (статус по ревью)

| PR | Статус | Главное, что закрыть |
|---|---|---|
| PR-1 ADR | needs clarification | trust-модель restore, same-tx инвариант, остаточная полнота |
| PR-2 метрики | needs clarification | transport adapter, AE schema+sampling, auth 401/503/no-store |
| PR-3a read | ready после D7/quorum | unique-origin кворум, изменённая empty-env семантика, payload-validation fallback |
| PR-3b write | ready после persist-tx | same signed txId (реш.2), persist-before-POST, 208, ambiguous POST |
| PR-4 union | risky | metadata-конфликт→incomplete (реш.5), nullable height, детерминизм, abort-during-backoff |
| PR-5 restore | unblocked (файл, реш.1) | скачиваемый файл + SHA-256, safe render, rotation runbook (реш.7) |
| PR-6 CI/deploy | обязателен в каждом | env/bindings везде, prod fail-closed, rollback/rotation |
