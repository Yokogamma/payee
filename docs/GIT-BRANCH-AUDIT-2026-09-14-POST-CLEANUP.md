# Повторный аудит веток после уборки — 2026-09-14

База проверки: `main = origin/main = 2cdbd437485b46af715277cbd0dcd644ab80d630`, после `git fetch origin --prune`. Этот отчёт описывает текущее состояние; прежний `GIT-BRANCH-AUDIT-2026-09-14.md` сохраняет инвентаризацию до уборки.

Проверены все локальные и удалённые ветки, head/base и проверки 26 открытых PR, diff каждого PR относительно его базы, состояние worktrees, stash, актуальный runbook, архивный тег и статусы #165/#171. Это аудит незавершённой работы, не полное ревью безопасности всех изменений. CI повторно не запускался, живой ledger/облако не проверялись. Ветки и PR не изменялись; создан только этот отчёт.

## Итог

| Объект | Количество / состояние |
|---|---|
| Локальные ветки | 15: main + 14 backup |
| Ветки origin | 28: main + 14 backup + 13 Dependabot; origin/HEAD не считается |
| Открытые PR | 26: 13 backup + 13 Dependabot |
| Дополнительные слитые ветки | 0 локально, 0 на origin |
| Worktrees | основной main + detached op-journal на 11cc3f7 |
| Рабочие деревья до создания отчёта | оба чистые |
| Stash | пуст |

Уборка завершённых веток закончена. Все оставшиеся отличающиеся от main ветки относятся к двум понятным направлениям. Единственная лишняя ссылка — `test/backup-matrix-completeness`, дубликат tip `feat/backup-ui-block`.

### Обновление после аудита (14.09, вечер)

Выполнено после снятия отчёта; таблицы ниже сохраняют состояние на момент аудита, расхождения перечислены здесь.

- **Дубликат удалён.** `test/backup-matrix-completeness` снята локально и на origin после повторной проверки: SHA `03a1edb` совпадает с `feat/backup-ui-block`, её PR #127 уже слит в стопку, открытых PR с таким base нет, checkout нет; коммит достижим из трёх веток стопки. Теперь **14 локальных / 27 удалённых веток** (27 = main + 13 backup + 13 Dependabot).
- **Dependabot перебазирован без мержа и деплоя.** По комментарию `@dependabot rebase` 12 PR перенесены на `main = 2cdbd43` (#150 не перебазирован — поглощён #162). **Все 12 зелёные.** Прежние красные #148 и #156 прошли с первого прогона: падение на старой базе было клиентским `window is not defined`, не дефектом обновляемых библиотек. #152 и #158 сначала упали в `worker/test/op-journal-e2e.test.ts` (тесты «2d» и «6»), затем **прошли после повторного запуска на тех же SHA** (`fb5fc60`, `75a6e01`; runs 34850708253 и 34850793862, attempt 2). Оба PR не меняют `worker/`; `main` на `2571786` и `2cdbd43` зелёный тем же набором. **Нестабильность проверок подтверждена, конкретная причина не установлена**: повторный успешный прогон не исключает гонку в рабочем коде, а не только в тестах. Разбор вынесен в отдельную задачу.
- **Результат разбора (14.09, поздний вечер; PR [#173](https://github.com/Yokogamma/payee/pull/173), слит в `main` как `fe8b809`).** Найден **механизм ложных падений этих двух тестов**: оба синхронизировали конкурентные запросы A и B таймерами (`setTimeout` 60/40 мс плюс задержка мока якоря 300/200 мс) — ставка на скорость раннера, которая под нагрузкой проигрывала в обе стороны (A ещё не начал; B пережил задержку и `/op-posting` от A попал в `callsInB`). Второй слой — каскад: упавший 2d оставлял A «в полёте», и тот съедал одноразовые моки следующего теста, отсюда 502 в тесте 6. В 228 трассированных итерациях контракт журнала держался (ответ DO на повтор — `op_reused` 228/228, у B ровно один DO-вызов). Исправление только в `worker/test/`: барьер `hold`/`reached` в `outbound-mock`, A паркуется на якоре до отпускания тестом, без sleep; под той же нагрузкой старая форма 20/60 и 19/60 красных, новая 0/60 и 0/60. **Граница вывода:** установлен механизм ложных падений именно этих тестов; это **не доказательство отсутствия любых гонок в worker** — рабочий код не менялся и не аудировался целиком, воркер `11cc3f7` и `op-journal` не затронуты.
- **#157** (worker Arweave 1.15.7 → 2.0.1) — зелёный CI, но требует отдельного ревью мажорного обновления и платного пути. **#150** закрывать после принятия #162, не мержить.
- **Готовность к мержу.** 11 зелёных PR (#144, #145, #146, #147, #148, #149, #152, #156, #158, #161, #162) — **готовы к финальному ревью**: успешный CI сам по себе не подтверждает совместимость обновлений.
- **Мержа и деплоя не было; соак не затронут**: воркер `11cc3f7`, настройки окна и worktree `op-journal` без изменений. На `pull_request` работает только `ci.yml` (тесты, без секретов и деплоя).

Новые head после ребейза: #144 `7deb96f`, #145 `1b20243`, #146 `0a83470`, #147 `9617255`, #148 `071ff82`, #149 `e363307`, #152 `fb5fc60`, #156 `3af9caa`, #157 `3594e98`, #158 `75a6e01`, #161 `3397880`, #162 `5bcbc48`; #150 остался `2fd4309`.

## Незавершённые направления и причины

### Backup: намеренная пауза и предстоящая интеграция

13 PR образуют одну последовательную цепочку; 14-я ветка — дубликат. У всех 110 коммитов main отсутствуют в истории. Основная работа датирована 29 августа, последние изменения #138 — 2 сентября. Число ahead в таблице включает нижележащие PR и не суммируется.

Причина паузы подтверждена `docs/ROLLBACK.md:1838,1874`: сначала серверная семантическая идемпотентность и её соак, затем merge backup. Минимальное окно заканчивается **2026-09-20 19:28:19 UTC / 22:28:19 Киев** (`:1936`). Разрешение на продолжение — фактический `reconcile green` с выполненными критериями, отчётом и подписью оператора (`:1986`), а не наступление даты. Деплой Pages во время окна запрещён runbook; работающий worker и checkout op-journal сохраняются.

Технические и приёмочные хвосты:

1. **#108 конфликтует с main:** `git merge-tree` показывает единственный add/add в `docs/BACKUP_FORMAT_V1.md`. Main содержит тот же текст плюс 7 строк о порядке релизов. Пять файлов fp/фикстуры/тестов/ESLint уже идентичны main; уникальны `publication-equivalent.ts` и тест. При обновлении основания сохранить main-версию документа и уникальную функциональность.
2. **MERGEABLE остальных PR относится к их старым базовым веткам**, а не к актуальному main. После интеграции основания состояние всей цепочки нужно проверить заново; старые зелёные CI этого не доказывают.
3. **#109 меняет worker**, включая каноничность base64 и минимум 16 байт ciphertext, а также worker-тесты. Переносить этот старый участок целиком поверх современного upload handler нельзя без проверки совместимости с валидацией, кодами ошибок и журналом операций. Поздние PR #110–#138 в собственных diff относительно их bases worker-файлы не меняют.
4. **Остался замер на реальном телефоне.** На вершине `feat/backup-d2a-client:docs/ROLLBACK.md` всё ещё записано `Still owed by the operator` для near-cap измерения. Указан desktop heap 932 МБ; это существенный аргумент проверить мобильную память и отзывчивость. Отдельного подтверждения завершения замера не найдено. До релиза внести результат либо явное актуальное решение по ограничению поддержки.

Рекомендация: сохранить все 13 рабочих веток, после успешной приёмки обновлять и интегрировать снизу вверх, с проверкой base следующего PR перед удалением предыдущей ветки. Выполнить клиентские и worker gates на обновлённом коде, проверить rollback floors, флаги backup и восстановление.

### Dependabot: накопившаяся очередь, а не 13 доказанных неисправностей

13 PR отстают от main на 34–70 коммитов, у каждого один собственный коммит. Все сейчас MERGEABLE. У 11 последний gates успешен; #148 и #156 красные.

Оба красных прогона завершились клиентским `ReferenceError: window is not defined`, Main.test.tsx: [лог #148](https://github.com/Yokogamma/payee/actions/runs/33746889820), [лог #156](https://github.com/Yokogamma/payee/actions/runs/34452689163). Эти логи не доказывают дефект обновляемой криптографии или Vitest. Сначала обновить базу и повторить CI; новые отказы разбирать отдельно.

Почему стоят зелёные PR: явного индивидуального решения о блокировке в доступных данных нет. Подтверждён факт отсутствия интеграции и устаревшей базы. Связывать всю очередь с соаком было бы неточно: обновление веток и локальные/CI проверки можно проводить, не меняя развёрнутую версию и checkout соака. Сам deploy worker сейчас нарушил бы условия окна; обновление зависимостей для следующего релиза требует отдельной приёмки.

Приоритеты:

- #148/#156: обновление базы и диагностика красных checks.
- #144/#145/#147/#152/#161: обычные клиентские/tooling обновления, последовательно через актуальные gates.
- #158: корневой tooling; #146: worker tooling. Это разные package.json, не дубликаты.
- #162: более новый root wrangler 4.131.0 вместе с sharp. #150 предлагает 4.127.1; после принятия #162 старое обновление можно закрыть как заменённое, проверив итоговый lockfile.
- #149 (клиентский @noble/hashes), #148 (worker @noble/ed25519): проверить криптографические тест-векторы и совместимость.
- #157 (worker Arweave 1.15.7 → 2.0.1): отдельное ревью мажорного обновления, API и платного upload/recovery пути. Зелёный CI не заменяет такую проверку.

### План рефакторинга: документация начата, реализация нет

`docs/REFACTORING-PLAN.md:3` прямо обозначает статус «предложение для согласования, реализация не начата». Документ уже в main через #171. Отдельной ветки реализации нет, значит потерянную реализацию искать/удалять здесь не нужно. Следующий шаг — согласование порядка этапов; пересекающийся со store.tsx рефакторинг разумно планировать с учётом интеграции backup. Это рекомендация по снижению конфликтов, не существующий запрет runbook.

## Что уже завершено и не должно оставаться в списке зависших

- #165 MERGED, `257178629caac6eb9dd0014cc20108c211187b8a`, 2026-09-14 13:29:16Z.
- #171 MERGED, `2cdbd437485b46af715277cbd0dcd644ab80d630`, 2026-09-14 13:29:45Z.
- Их локальные/удалённые ветки и busy-spence отсутствуют.
- Ребрендинг: remote-ветка отсутствует, опубликован аннотированный `archive/rebrand-matamata-2026-08-19`, объект e3621cb → commit d52ec7d. Техническая заготовка сохранена, не является активной веткой. По предыдущему сообщению пользователя дальнейший план перенесён в Notion; содержание Notion в этом проходе не проверялось.
- Старые слитые ветки и pr2 отсутствуют. Повторять прежние массовые команды удаления не нужно.

## Остаточная уборка и порядок действий

1. Удалить локальную и удалённую **ссылки** `test/backup-matrix-completeness` после повторной проверки равенства SHA и отсутствия среди head/base открытых PR. Сейчас обе указывают на 03a1edb, как feat/backup-ui-block; отдельного кода нет. Это уменьшит список до 14 локальных и 27 remote веток. В этом аудите удаления не выполнялись. — *Выполнено 14.09 вечером, см. «Обновление после аудита».*
2. Оставить main, op-journal, архивный тег и 13 рабочих веток backup. Auto-delete сейчас выключен; сохранить это до безопасного завершения цепочки с переназначением bases.
3. Разобрать Dependabot без деплоя и изменения среды соака. После принятия #162 убрать заменённый #150. — *Ребейз и CI выполнены 14.09 вечером, 12 зелёных; мерж — следующий этап после финального ревью, см. «Обновление после аудита».*
4. После `green` соака — интеграция backup с #108, проверка #109, актуальные gates и мобильная приёмка; затем релиз по runbook.
5. Исторический аудит до уборки не использовать как актуальный перечень удаления. Этот файл — новый снимок на main 2cdbd43.

## Все оставшиеся ветки

В таблице main и backup существуют локально и на origin; Dependabot — только на origin. Поля «ahead/behind» вычислены относительно текущего origin/main; mergeability относится к base, указанной в строке.

| Ветка | SHA | PR / base | Ahead / behind | Состояние |
|---|---|---|---|---|
| dependabot/npm_and_yarn/baseline-browser-mapping-2.11.22 | b308685 | [#161](https://github.com/Yokogamma/payee/pull/161) / main | 1 / 34 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/browserslist-4.28.8 | 384b4f2 | [#144](https://github.com/Yokogamma/payee/pull/144) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/fast-uri-3.1.7 | b99566b | [#145](https://github.com/Yokogamma/payee/pull/145) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/humanfs/node-0.16.8 | dba9bd3 | [#152](https://github.com/Yokogamma/payee/pull/152) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/js-yaml-5.4.1 | de780b2 | [#147](https://github.com/Yokogamma/payee/pull/147) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/multi-d0c2d048a7 | 4293529 | [#156](https://github.com/Yokogamma/payee/pull/156) / main | 1 / 56 | MERGEABLE; CI FAILURE |
| dependabot/npm_and_yarn/multi-f99730c1b7 | 45f949c | [#162](https://github.com/Yokogamma/payee/pull/162) / main | 1 / 34 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/noble/hashes-2.4.0 | fd6cf00 | [#149](https://github.com/Yokogamma/payee/pull/149) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/tooling-b0b240819c | 3f41956 | [#158](https://github.com/Yokogamma/payee/pull/158) / main | 1 / 56 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/worker/arweave-2.0.1 | d38836f | [#157](https://github.com/Yokogamma/payee/pull/157) / main | 1 / 56 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/worker/noble/ed25519-3.2.0 | cb6973d | [#148](https://github.com/Yokogamma/payee/pull/148) / main | 1 / 70 | MERGEABLE; CI FAILURE |
| dependabot/npm_and_yarn/worker/worker-tooling-7464e63ee6 | 63dae18 | [#146](https://github.com/Yokogamma/payee/pull/146) / main | 1 / 56 | MERGEABLE; CI SUCCESS |
| dependabot/npm_and_yarn/wrangler-4.127.1 | 2fd4309 | [#150](https://github.com/Yokogamma/payee/pull/150) / main | 1 / 70 | MERGEABLE; CI SUCCESS |
| docs/backup-release-clean | 8ecfc79 | [#129](https://github.com/Yokogamma/payee/pull/129) / feat/backup-ui-block | 119 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-client-floor | 3bc3794 | [#109](https://github.com/Yokogamma/payee/pull/109) / feat/backup-publication-fp | 10 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-container | 649578c | [#110](https://github.com/Yokogamma/payee/pull/110) / feat/backup-client-floor | 20 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-d2a-client | ad7a6bf | [#138](https://github.com/Yokogamma/payee/pull/138) / docs/backup-release-clean | 124 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-export-verify | 2acda12 | [#112](https://github.com/Yokogamma/payee/pull/112) / feat/backup-merge-rules | 35 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-flags | 4d292ef | [#114](https://github.com/Yokogamma/payee/pull/114) / feat/backup-import | 53 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-import | a30448d | [#113](https://github.com/Yokogamma/payee/pull/113) / feat/backup-export-verify | 46 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-merge-rules | e0ef973 | [#111](https://github.com/Yokogamma/payee/pull/111) / feat/backup-container | 27 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-publication-fp | 322b330 | [#108](https://github.com/Yokogamma/payee/pull/108) / main | 2 / 110 | CONFLICTING; CI SUCCESS |
| feat/backup-store-actions | 4b35a32 | [#124](https://github.com/Yokogamma/payee/pull/124) / feat/backup-viewer-route | 90 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-ui-block | 03a1edb | [#125](https://github.com/Yokogamma/payee/pull/125) / feat/backup-store-actions | 108 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-viewer | 4482ba6 | [#115](https://github.com/Yokogamma/payee/pull/115) / feat/backup-flags | 65 / 110 | MERGEABLE; CI SUCCESS |
| feat/backup-viewer-route | 05019c4 | [#116](https://github.com/Yokogamma/payee/pull/116) / feat/backup-viewer | 80 / 110 | MERGEABLE; CI SUCCESS |
| main | 2cdbd43 | — | 0 / 0 | Сохранить |
| test/backup-matrix-completeness | 03a1edb | — | 108 / 110 | Дубликат feat/backup-ui-block; **ссылки удалены 14.09 вечером** (локально и на origin) |
