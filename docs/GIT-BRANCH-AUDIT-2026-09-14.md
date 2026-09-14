# Аудит веток — 14 сентября 2026

Проверено после `git fetch origin --prune`. База: `origin/main = 0262575067b8c60f5056df07e4604c7e4988e7f1`. Источники: все локальные и origin refs, история 170 PR GitHub, diff незавершённых веток, CI-логи, состояние девяти worktrees и актуальный runbook из origin/main. Удаления, merge, rebase, деплой и изменение настроек GitHub не выполнялись. Тесты повторно не запускались: это аудит истории, а не проверка готовности к релизу.

## Итог

- 94 локальные ветки; 93 ветки origin (без символической origin/HEAD).
- 77 локальных и 63 удалённых ветки, кроме main, полностью входят в origin/main по ancestry. Ни одна из них не является head или base открытого PR. Это кандидаты на уборку; используемые worktrees требуют отдельной проверки.
- 27 открытых PR: 13 backup, 13 Dependabot, 1 экспорт метрик.
- 9 worktrees, включая основной. Stash пуст.
- Локальный main отстаёт на 5 коммитов. Текущая chore/soak-d2-driver уже слита.

Число ahead — коммиты, недостижимые из main, а не количество ещё нужных изменений. Для цепочки PR оно включает нижележащие ветки; складывать эти числа нельзя. Squash и повторная реализация могут оставлять ahead при уже решённой задаче (пример: pr2).

## Начато и не завершено

### 1. Backup: 13 PR и дополнительная ветка-указатель

Цепочка: [#108](https://github.com/Yokogamma/payee/pull/108) → #109 → #110 → #111 → #112 → #113 → #114 → #115 → #116 → #124 → #125 → #129 → [#138](https://github.com/Yokogamma/payee/pull/138). Точные head/base приведены ниже.

Это намеренная пауза, не брошенная работа: D2 должен пройти соак до merge backup. Актуальное основание — `origin/main:docs/ROLLBACK.md`, раздел D2 и критерии v2. Старое описание блокировки PR-3a/D9 в #108 уже не отражает нынешнюю стадию: серверная часть в main и развёрнута, остаётся приёмка.

Минимальное окно: 2026-09-13 19:28:19 UTC → **2026-09-20 19:28:19 UTC (22:28:19 Киев)** на одной версии worker. Календарная дата сама по себе не разрешает продолжение: нужен `reconcile` с вердиктом `green`, выполненными объёмами и критериями, сохранённым отчётом и подписью оператора. Новый деплой/изменение оговорённых настроек начинает новое окно. Runbook запрещает merge backup и деплой Pages в течение соака. Живой ledger и текущее состояние облака этим аудитом не проверялись.

Все ветки цепочки отстают от main на 105 коммитов. У #108 конфликт только add/add в `docs/BACKUP_FORMAT_V1.md` (проверено `git merge-tree`). Версия документа из main содержит дополнительные 7 строк о порядке релизов и сохраняет остальной текст. Пять файлов реализации fp, фикстур, тестов и ESLint уже побайтово совпадают с main. Уникальная функциональная часть основания — `src/lib/publication-equivalent.ts` и его тест, 228 строк. Это упрощает разрешение основания, но не доказывает простоту всей последующей интеграции.

`test/backup-matrix-completeness` не имеет открытого PR и указывает ровно на тот же SHA `03a1edb` что `feat/backup-ui-block`: отдельной потерянной реализации нет. Это дополнительный указатель, который можно убрать после фиксации сохранённой основной ссылки.

Рекомендация: сохранить цепочку до успешной приёмки. Затем обновлять снизу вверх, проверяя каждый итоговый diff и base PR. Для #108 сохранить main-версию документа и два уникальных файла. После обновления запускать необходимые клиентские и worker quality gates с production env и соблюдать порядок релизов из runbook.

### 2. Экспорт метрик — fix/export-store-sampling, PR #165

[PR #165](https://github.com/Yokogamma/payee/pull/165): 2 уникальных коммита, отставание 18, MERGEABLE, CI gates зелёный. Последний коммит `2e12725` исправляет замечания к валидации пересчёта и формулировке расхождений. Описание PR сообщает о проведённом ревью, но GitHub reviews/comments пусты: документально подтвердить назначенного ревьюера или конкретную причину ожидания нельзя.

Это ближайший кандидат на завершение: финальное ревью актуального diff, необходимые проверки и merge. Изменение экспортёра не требует деплоя worker. Worktree `busy-spence-02a12d` чистый, но стоит на **неслитом** `2e12725` — сохранить до завершения PR. Прежний отчёт ошибочно относил этот commit к слитым.

### 3. Ребрендинг — origin/claude/android-app-github-mcse5q

2 уникальных коммита от 19 августа, 47 изменённых файлов, отставание 285, PR отсутствует. Название ветки говорит об Android, фактическое содержимое — план запуска и полный ребрендинг Eternal Notes → Matamata Notes, не готовое Android-приложение.

Причина прекращения работы **не зафиксирована в доступной истории**. Документ внутри ветки содержит старое решение о допустимости потери доступа к тестовым данным. Это не подтверждает допустимость такого изменения сегодня.

Diff меняет HKDF salt и вывод ключа подписи, storage-имена и App-Name. Существующие данные не стираются физически, но новая схема теряет совместимость с их расшифровкой/поиском и локальными сессиями. Мержить эту ветку как косметическое переименование нельзя.

Рекомендация: сохранить tip `d52ec7db100352b179c5728e872cdd2548002895` архивным тегом перед удалением remote-ветки. План `docs/MATAMATA-LAUNCH.md` извлечь отдельно, пересмотреть устаревшие решения и отметки выполнения. При возвращении к ребрендингу сделать новую ветку от main с явно определёнными требованиями совместимости. Само архивирование в этом аудите не выполнялось.

**Выполнено 14.09, после аудита.** Причина остановки реконструирована по датам: назавтра после ветки, 20–22.08, владелец принял решение «`notes.matamata.dev` — dev-контур и не трогается; прод поднимается с нуля на `.app` в `[env.production]` с новым именем воркера, ничего из dev не переносится» (план `happy-toasting-pnueli`, карточка «Часть 2: боевой прод на .app с нуля» в Бэклоге). Посылка ветки — переименовать текущий контур на месте — исчезла, PR не открывался. С тех пор на `main` появились четыре внутренних идентификатора, которых diff не покрывает (`eternal-notes-quick-unlock-v1`, консенсус-критичный `eternal-notes/publication-fp/v1`, `eternal-notes-hidden-at`, `eternal-notes-persist-denied`).

Сделано: аннотированный тег `archive/rebrand-matamata-2026-08-19` (объект `e3621cb0fd150a38ed244a19c4f6be03363cc4bf` → коммит `d52ec7d`) запушен и сверен через `ls-remote` и API; remote-ветка удалена после проверки, что её head совпадает с peeled-коммитом тега и ни один PR на неё не ссылается. План запуска перенесён в Notion — страница «🐢 Ребрендинг: Eternal Notes → Matamata Notes» в корне «Matamata Notes»: ребрендинг разделён на слой бренда (отдельный небольшой PR после соака) и слой идентификаторов (при провижининге прода, до первого реального пользователя); переименование dev-воркера и репозитория до прода исключено.

### 4. pr2 — устаревший локальный checkout

1 уникальный коммит `fc16d07`, отставание 341. Меняет две ссылки wrangler-action 3 → 4. Соответствующий [PR #2](https://github.com/Yokogamma/payee/pull/2) уже MERGED; в main используется тот же SHA v4.0.0. Отдельной незавершённой задачи нет. Можно удалить локальную ссылку после сохранения инвентаризации; ancestry-проверка `branch -d` здесь может отказаться из-за другой истории.

### 5. Dependabot — 13 открытых PR

11 зелёных: #144, #145, #146, #147, #149, #150, #152, #157, #158, #161, #162. Два красных: #148 и #156.

Оба падения — **клиентский `ReferenceError: window is not defined` в Main.test.tsx**, а не доказанный дефект noble/ed25519 или Vitest. Источники: [run #148](https://github.com/Yokogamma/payee/actions/runs/33746889820), [run #156](https://github.com/Yokogamma/payee/actions/runs/34452689163). В актуальном main этот участок уже использует `setTimeout` без `window`; сначала обновить PR на main и повторить CI, затем оценивать оставшиеся ошибки.

#150 обновляет корневой wrangler до 4.127.1, #162 — до 4.131.0; после принятия нового обновления старое станет избыточным. **#158 и #146 не дубли**: первое меняет tooling корневого package.json, второе — worker/package.json. Их нужно оценивать отдельно. Arweave 1 → 2 (#157) требует отдельной проверки API, ошибок и платного пути даже при зелёном CI.

Точная причина отсутствия merge для зелёных PR в истории не указана. Очередь накопилась; worker-обновления разумно интегрировать после приёмки соака и перед контролируемым следующим деплоем. Зелёный старый CI не заменяет проверку на обновлённой базе.

## Закрытые PR и незакоммиченная работа

- #38 и #40 включены в [#41](https://github.com/Yokogamma/payee/pull/41). Его описание прямо объясняет: удаление базовой ветки предыдущего PR нарушило цепочку. Это основание **пока оставить delete_branch_on_merge=false**, а не включать его немедленно. Перед удалением базы незавершённого PR сначала менять base и проверять diff.
- #128 заменён [#129](https://github.com/Yokogamma/payee/pull/129): в прежнюю историю попали 47 посторонних файлов, включая вложение и PDF. Старая ветка отсутствует в текущем списке. Удаление ветки не подтверждает удаление PR refs/объектов GitHub; в описании #129 указан возможный отдельный запрос в Support. Статус такой очистки не установлен. Старую ветку не восстанавливать ради порядка в refs.
- `docs/REFACTORING-PLAN.md`: незакоммиченный план, прямо обозначенный как предложение, реализация не начата. Сохранить в отдельной docs-ветке после проверки содержания.
- `public/backup-viewer.html`: незакоммиченный HTML, 63 978 байт. В backup-ветке путь документирован как генерируемый и игнорируется. Перед удалением текущего экземпляра разумно сохранить копию; его воспроизводимость побайтово здесь не проверялась.

## Worktrees и порядок уборки

| Worktree | Состояние | Рекомендация |
|---|---|---|
| основной payee | слитая chore/soak-d2-driver; два untracked файла | Сохранить файлы; переключиться на main и обновить fast-forward |
| busy-spence-02a12d | чистый, detached 2e12725, открытый #165 | Сохранить до завершения PR |
| op-journal | чистый, detached 11cc3f7 | Сохранить: рабочий checkout текущего соака |
| metrics-upstream-diagnostics | слитый 15efde0; untracked scratch/ | Сначала сохранить REPORT.md, read-only-evidence.json и pr-body.md; затем убрать checkout |
| mystifying-wescoff-7e77b8 | чистый, commit в main | Кандидат на удаление checkout |
| nervous-borg-64592b | чистый, commit в main | Кандидат на удаление checkout |
| priceless-kare-c2047f | чистый, commit в main | Кандидат на удаление checkout |
| sad-moore-8db7b2 | чистый, commit в main | Кандидат на удаление checkout |
| pr-c-docs | чистый, ci/co-deploy-secrets, commit в main | Кандидат на удаление checkout |

Итого: пять дополнительных чистых слитых worktrees можно рассматривать для уборки; шестой — только после сохранения scratch. Чистота относится к tracked/untracked по обычному status, не доказывает отсутствие ценных ignored файлов и не устанавливает, что другой процесс не использует checkout.

*14.09, после аудита:* `scratch/metrics-upstream/` (REPORT.md, read-only-evidence.json, pr-body.md — материалы расследования #169) скопирован в локальный архив вне репозитория `C:\Users\user\.claude\plans\payee-metrics-upstream-2026-09-14\`, SHA-256 каждой копии сверен с оригиналом.

Рекомендуемый порядок:

1. Сохранить локальные планы, scratch и необходимые ignored-данные; зафиксировать SHA кандидатов (полный список ниже).
2. Завершить #165. Параллельно можно убрать неиспользуемые слитые worktrees и ветки, повторяя проверки ancestry, head/base открытых PR и занятости checkout непосредственно перед удалением.
3. Удалить 77 слитых локальных и 63 remote refs после освобождения checkout; main исключить. pr2 и дубликат test/backup-matrix-completeness обработать отдельно. Архивировать ребренд до удаления его ветки — *сделано 14.09, см. раздел 3*.
4. Автоудаление веток пока оставить выключенным; вернуться к настройке после закрытия backup-цепочки либо внедрения порядка переназначения base.
5. После фактического green соака — интеграция backup, зависимости и отдельный план деплоя по актуальному runbook. Слитые #169/#170 ещё не доказывают, что код развёрнут; не объединять все изменения в один непроверенный деплой.

## Полная инвентаризация

Ниже перечислены все 187 refs на момент проверки. «В main» означает достижимость tip из origin/main. Это сохранённый список для анализа, не исполняемый список удаления.

### Локальные ветки

| Ветка | SHA | Ahead / Behind | Статус |
|---|---|---|---|
| chore/allowlist-worker-r4 | b17ed17ce9cd309f00fe4f1d3b392fa013f6d90e | 0 / 87 | В main; кандидат на уборку |
| chore/cf-account-id | 5336249b42eeea002ea763f5e4dbec841861daf5 | 0 / 140 | В main; кандидат на уборку |
| chore/dependabot-grouping | 8ca0cbb36d1451253c2dbbf6c7ff0c5bcb2e8dda | 0 / 246 | В main; кандидат на уборку |
| chore/dependabot-limit-5 | f3c45eb93a362ada57393505539d1021b79f8090 | 0 / 166 | В main; кандидат на уборку |
| chore/dev-contour-reclass | 76128b1b4a426086cb1444bee5982aaf71f8fd2c | 0 / 219 | В main; кандидат на уборку |
| chore/lint-refs-false-positive | 6c9c75e3e6311ac138456330c4e4ddab6c9c04ec | 0 / 219 | В main; кандидат на уборку |
| chore/node-24-contract | 17baecb5dfa160aa426d2329cbf11fecf9517859 | 0 / 195 | В main; кандидат на уборку |
| chore/notes-version-page-tests | cb69d626a4612fee140b37303cc64023c34029a6 | 0 / 93 | В main; кандидат на уборку |
| chore/retire-legacy-pages | ed5aff9b270e7930023ece454372721411c66acc | 0 / 248 | В main; кандидат на уборку |
| chore/smoke-target-classifier | b7a72395acd5ac820e15a75df5d68a059367775a | 0 / 195 | В main; кандидат на уборку |
| chore/soak-d2-driver | 01a02dd5e1943dd1daf35229d3c160d841a239f5 | 0 / 55 | В main; кандидат на уборку |
| chore/soak-restart-budget | 13dd5f8706c95291d654f1dd80bf6385a91bd9e5 | 0 / 26 | В main; кандидат на уборку |
| chore/vite-base-default | ec5162e71231a6ed417f211f6bc1bdbe54562b8f | 0 / 189 | В main; кандидат на уборку |
| ci/co-deploy-secrets | 17fee1fc2434b79799ad671d30caedfcf201d91c | 0 / 1 | В main; кандидат на уборку |
| claude/admiring-dirac-e76a14 | 44a75ee7baae32bfcbc285314b7abd970556ecc6 | 0 / 296 | В main; кандидат на уборку |
| claude/busy-spence-02a12d | 45866b9bb9ae5c8c92d031f4e62e67be50d71949 | 0 / 139 | В main; кандидат на уборку |
| claude/epic-mirzakhani-eabfbc | 7461d3f6378f565883718ff17d40c72e5bb24f2f | 0 / 92 | В main; кандидат на уборку |
| claude/friendly-antonelli-571b92 | 10ddd9b90eee9d1586c281a91fe3081e9a379333 | 0 / 30 | В main; кандидат на уборку |
| claude/kind-davinci-f2e500 | 1b282350ca9e62f13dc37d5c27300bbf0934070d | 0 / 365 | В main; кандидат на уборку |
| claude/matamata-arweave-alignment-pkrg9m | 797e932dbf29482ef41c21dac6e1991365d09378 | 0 / 229 | В main; кандидат на уборку |
| claude/mystifying-wescoff-7e77b8 | 45866b9bb9ae5c8c92d031f4e62e67be50d71949 | 0 / 139 | В main; кандидат на уборку |
| claude/nervous-borg-64592b | 45400548303fd480925822c12e75268a7a96286b | 0 / 285 | В main; кандидат на уборку |
| claude/priceless-kare-c2047f | 45400548303fd480925822c12e75268a7a96286b | 0 / 285 | В main; кандидат на уборку |
| claude/sad-moore-8db7b2 | 44a75ee7baae32bfcbc285314b7abd970556ecc6 | 0 / 296 | В main; кандидат на уборку |
| codex/metrics-upstream-diagnostics | 15efde09af05fb272aa52fa248a57c56ace9badb | 0 / 9 | В main; кандидат на уборку |
| docs/arweave-plan-v15 | 0cc05c178fe990d801007fe62b3e4c9f6985e571 | 0 / 147 | В main; кандидат на уборку |
| docs/backup-release-clean | 8ecfc79e84e448abc9155683d1d53ba43dc45a56 | 119 / 105 | Открытый PR #129 |
| docs/pwa-residual-void | a69023c7a67fec115f86653db49c2886bd49dfc6 | 0 / 156 | В main; кандидат на уборку |
| docs/qu-acceptance-android | aeb1f7808ee5558b0e3a2358fa8acc0acd4e1aec | 0 / 260 | В main; кандидат на уборку |
| docs/qu-acceptance-passed | aac34b2983a1fdc1d34ca46e8e142f0bfedac355 | 0 / 254 | В main; кандидат на уборку |
| docs/qu-accuracy | 8e8f64e49cf7c770ba31e49be0caa7146a3edd54 | 0 / 252 | В main; кандидат на уборку |
| docs/qu-credprops-accuracy | 9ba5d774314642de49d22a6ca86e7136e9facb9b | 0 / 250 | В main; кандидат на уборку |
| docs/qu1-deployed | c06c03043d277df804183f9e66494d7381e9c09b | 0 / 268 | В main; кандидат на уборку |
| docs/qu2-deployed | 8b4deee03e98336985b70d004bf4592c84447722 | 0 / 264 | В main; кандидат на уборку |
| docs/rollback-nav2 | f6e309338a238d8337b3ee367f4a6e143e1ee5fd | 0 / 317 | В main; кандидат на уборку |
| docs/rollback-restore-pin-deployed | 3280cdc4e48337561d7087e4c328de45430c487a | 0 / 347 | В main; кандидат на уборку |
| docs/secrets-runbook | 26f50fc3a9711c4d96a69761a23f406bd52c8127 | 0 / 188 | В main; кандидат на уборку |
| docs/soak-d2-criteria | 2682edff38f52f5689b4dcce5edcd5bba0f413ec | 0 / 8 | В main; кандидат на уборку |
| docs/stage-p-acceptance | 168b895483dbc7d445f7ba83737fcec228ed613b | 0 / 279 | В main; кандидат на уборку |
| docs/stage-p-deployed | c95d6ac18d25a17625527f0168ae3f70fc159520 | 0 / 281 | В main; кандидат на уборку |
| docs/sync1-acceptance | dfebbd54abe1e4370185c06cb80a230071f26a94 | 0 / 286 | В main; кандидат на уборку |
| feat/auto-lock-on-background | 1b354e928fe12d8cb70d044f33bd50e043b57587 | 0 / 395 | В main; кандидат на уборку |
| feat/backup-client-floor | 3bc379400a7050638502c4bd10617cf0a86e7839 | 10 / 105 | Открытый PR #109 |
| feat/backup-container | 649578c79bc2ab0bf278136bb54a62fe21ac7334 | 20 / 105 | Открытый PR #110 |
| feat/backup-d2a-client | ad7a6bfe5f9a0f0813245696cb850b3935109cb6 | 124 / 105 | Открытый PR #138 |
| feat/backup-export-verify | 2acda12e5bf3d5b6158f44b7878aeb519eb6b7ca | 35 / 105 | Открытый PR #112 |
| feat/backup-flags | 4d292efa6e863000661259914f5ef603ea748b76 | 53 / 105 | Открытый PR #114 |
| feat/backup-import | a30448d8c7ce2d7955467a0c48e17763211822c5 | 46 / 105 | Открытый PR #113 |
| feat/backup-merge-rules | e0ef973ae52c82f085b337ae04fdd2af3ee4bc7e | 27 / 105 | Открытый PR #111 |
| feat/backup-publication-fp | 322b330c4def3861277c0397291aee6b69994522 | 2 / 105 | Открытый PR #108 |
| feat/backup-store-actions | 4b35a32adf9c6855c6bc230de8c8d5a90da5352b | 90 / 105 | Открытый PR #124 |
| feat/backup-ui-block | 03a1edb38c6daa52ea217b9655e3e84f9e927ed3 | 108 / 105 | Открытый PR #125 |
| feat/backup-viewer | 4482ba6e67c4c74ca93e233a31c2dbffcdccc496 | 65 / 105 | Открытый PR #115 |
| feat/backup-viewer-route | 05019c44777cc33f489e6826b6a7413e2bcc380b | 80 / 105 | Открытый PR #116 |
| feat/deploy-config-migration | 796eb6a989b41275b56d40858e3fd73d5a0d8e45 | 0 / 191 | В main; кандидат на уборку |
| feat/global-uploads-switch | 648ff29de5525e0e63ebecad681018c3784cead4 | 0 / 189 | В main; кандидат на уборку |
| feat/incremental-sweep | b7dbdcfb284919593bf5feeba18ac6e952b7b53f | 0 / 290 | В main; кандидат на уборку |
| feat/markdown-versioning-v3 | 858d6648c63731d7668b73cca02c8a1e77b8681b | 0 / 386 | В main; кандидат на уборку |
| feat/notes-markdown-rhythm | 01c0938e5cff002b94896c4574f49a2572b9314b | 0 / 138 | В main; кандидат на уборку |
| feat/notes-preview-reading | 07656b2244d78d52485d710c4e4830ba07158cbd | 0 / 133 | В main; кандидат на уборку |
| feat/notes-version-page | 83d40efa3835a6bfb9aa09dab2e07c6e45364271 | 0 / 95 | В main; кандидат на уборку |
| feat/op-journal | 4f24b4db3ae08435b9bcf53da98344274079faa5 | 0 / 15 | В main; кандидат на уборку |
| feat/op-journal-driver | a843143e0db51be2e691a5f06e8f09fe97a7e81e | 0 / 12 | В main; кандидат на уборку |
| feat/pr2-metrics | 51e5e8e25a0421c4d1089c633f096674393c5584 | 0 / 144 | В main; кандидат на уборку |
| feat/quick-unlock | 32839f2ea0c53e74a7e662a455fc6fff64bd959c | 0 / 270 | В main; кандидат на уборку |
| feat/quick-unlock-flag-on | 50682e91cc76bad9718d0458f8acd0f0b72102fd | 0 / 266 | В main; кандидат на уборку |
| feat/read-multigateway | 9b5d377167de854fd165ba28eb8ec20a773797f3 | 0 / 117 | В main; кандидат на уборку |
| feat/recovery-quarantine | 3a0c1e7902fbff95e60917ff150eb069ad5d4fd2 | 0 / 189 | В main; кандидат на уборку |
| feat/restore-pin-and-persistent-storage | 12acaaf361095343984550a846ee0d62b466eeb5 | 0 / 348 | В main; кандидат на уборку |
| feat/safebox-v4 | e0542dcbc467804a631333624870b9d4dcd6a9ed | 0 / 378 | В main; кандидат на уборку |
| feat/stage-p-pin-guards | 4a6958467ad36814b0ab9acc8822bed096d450b7 | 0 / 283 | В main; кандидат на уборку |
| feat/worker-noble-v3 | 923fa52c76a469b788df8cf7c061d600ea9fb473 | 0 / 156 | В main; кандидат на уборку |
| feat/worker-semantic-idempotency | b590c0ea0df3f9c15a000aa8c8cddab7c8bd87b7 | 0 / 66 | В main; кандидат на уборку |
| fix/deploy-worker-root-deps | 5bb13e3726f03bbc3e82647eb8f986f48c172f6b | 0 / 142 | В main; кандидат на уборку |
| fix/duplicate-import-vitest4 | a648b3573b211aace530c6868daacef11b2e2826 | 0 / 170 | В main; кандидат на уборку |
| fix/eslint10-recommended | 9456a8f97169f4b3288af9f21e7eb4e3102cf02e | 0 / 162 | В main; кандидат на уборку |
| fix/export-store-sampling | 2e12725a5c5cd5d8a8b848275c0c49457416f517 | 2 / 18 | Открытый PR #165 |
| fix/export-structured-source | 5d87ee47437d9158ee7e71bcef547d12dc1155c6 | 0 / 19 | В main; кандидат на уборку |
| fix/global-pause-lifecycle | d389139ca7b6240e5dae627f5aa2b783a9d15084 | 0 / 87 | В main; кандидат на уборку |
| fix/historical-candidate-rollback | 2c7302003622824c293654d66c29cb3649f1b374 | 0 / 24 | В main; кандидат на уборку |
| fix/major-bumps-test-compat | 2f931e577d72072c19f93197471f364ee09d200f | 0 / 180 | В main; кандидат на уборку |
| fix/quick-unlock-credprops | 4c8a5defe34a39eb30f9b6fbfa1529e89d1e65ec | 0 / 256 | В main; кандидат на уборку |
| fix/quick-unlock-no-prf-ux | 76c793f0fda6f22c845ec6dc5d44fb367e0d723c | 0 / 262 | В main; кандидат на уборку |
| fix/quick-unlock-resident-key | 78428063eaee4b41247436ff06d36ec952456272 | 0 / 258 | В main; кандидат на уборку |
| fix/restore-index-bounds | 15732a3e26c48997e8c9c52d9d9fb06dc0300042 | 0 / 87 | В main; кандидат на уборку |
| fix/worker-redirect-manual | 97ef84210245894db246867f2c6853efe5b8a16e | 0 / 61 | В main; кандидат на уборку |
| main | 0483ceb7e8a0c18ba0175f54ea251c41ef9984b5 | 0 / 5 | Основная; сохранить |
| pr2 | fc16d07cff8f36af281cf2c4fa46e796536d08c5 | 1 / 341 | Устаревший checkout PR #2 |
| security/phase1-c2-m4-ip-limiter | c479c5291be8d7771bce43595be81f660c394f8b | 0 / 405 | В main; кандидат на уборку |
| test/backup-matrix-completeness | 03a1edb38c6daa52ea217b9655e3e84f9e927ed3 | 108 / 105 | Дубликат tip feat/backup-ui-block |
| test/incident-matrix-completion | c37c18b3e5b66440c9041c869139cf7e3e0601fd | 0 / 158 | В main; кандидат на уборку |
| test/v3-writer-queue-driver | c895dac4262d17697a56cda67776888be8291d28 | 0 / 252 | В main; кандидат на уборку |
| verify | 73c5916a9d2da35fb04b2e83cebd71f36eda42b6 | 0 / 112 | В main; кандидат на уборку |
| worktree-agent-aa1bdae149866cde0 | db9c4d1ee7bc64c67eceb17378c91fba166a7520 | 0 / 157 | В main; кандидат на уборку |

### Ветки origin

| Ветка | SHA | Ahead / Behind | Статус |
|---|---|---|---|
| chore/allowlist-worker-r4 | b17ed17ce9cd309f00fe4f1d3b392fa013f6d90e | 0 / 87 | В main; кандидат на уборку |
| chore/cf-account-id | 5336249b42eeea002ea763f5e4dbec841861daf5 | 0 / 140 | В main; кандидат на уборку |
| chore/dependabot-grouping | 8ca0cbb36d1451253c2dbbf6c7ff0c5bcb2e8dda | 0 / 246 | В main; кандидат на уборку |
| chore/dependabot-limit-5 | f3c45eb93a362ada57393505539d1021b79f8090 | 0 / 166 | В main; кандидат на уборку |
| chore/dev-contour-reclass | 76128b1b4a426086cb1444bee5982aaf71f8fd2c | 0 / 219 | В main; кандидат на уборку |
| chore/lint-refs-false-positive | 6c9c75e3e6311ac138456330c4e4ddab6c9c04ec | 0 / 219 | В main; кандидат на уборку |
| chore/node-24-contract | 17baecb5dfa160aa426d2329cbf11fecf9517859 | 0 / 195 | В main; кандидат на уборку |
| chore/notes-version-page-tests | cb69d626a4612fee140b37303cc64023c34029a6 | 0 / 93 | В main; кандидат на уборку |
| chore/retire-legacy-pages | ed5aff9b270e7930023ece454372721411c66acc | 0 / 248 | В main; кандидат на уборку |
| chore/smoke-target-classifier | b7a72395acd5ac820e15a75df5d68a059367775a | 0 / 195 | В main; кандидат на уборку |
| chore/soak-d2-driver | 01a02dd5e1943dd1daf35229d3c160d841a239f5 | 0 / 55 | В main; кандидат на уборку |
| chore/soak-restart-budget | 13dd5f8706c95291d654f1dd80bf6385a91bd9e5 | 0 / 26 | В main; кандидат на уборку |
| chore/vite-base-default | ec5162e71231a6ed417f211f6bc1bdbe54562b8f | 0 / 189 | В main; кандидат на уборку |
| claude/android-app-github-mcse5q | d52ec7db100352b179c5728e872cdd2548002895 | 2 / 285 | Неслитый ребрендинг; архивировать |
| claude/friendly-antonelli-571b92 | 10ddd9b90eee9d1586c281a91fe3081e9a379333 | 0 / 30 | В main; кандидат на уборку |
| claude/matamata-arweave-alignment-pkrg9m | 797e932dbf29482ef41c21dac6e1991365d09378 | 0 / 229 | В main; кандидат на уборку |
| codex/metrics-upstream-diagnostics | 15efde09af05fb272aa52fa248a57c56ace9badb | 0 / 9 | В main; кандидат на уборку |
| dependabot/npm_and_yarn/baseline-browser-mapping-2.11.22 | b3086855fe7350b04f0e489fc47fa1dcc1e16fca | 1 / 29 | Открытый PR #161 |
| dependabot/npm_and_yarn/browserslist-4.28.8 | 384b4f22f62194c0a586740fab54c1029271338c | 1 / 65 | Открытый PR #144 |
| dependabot/npm_and_yarn/fast-uri-3.1.7 | b99566bd0e6cfd8e785d1c57933dede50643eed0 | 1 / 65 | Открытый PR #145 |
| dependabot/npm_and_yarn/humanfs/node-0.16.8 | dba9bd39f4fc3919326729496881dc11b1d90dba | 1 / 65 | Открытый PR #152 |
| dependabot/npm_and_yarn/js-yaml-5.4.1 | de780b2b2ab82f2f77fdbb6a767c696c49fd83aa | 1 / 65 | Открытый PR #147 |
| dependabot/npm_and_yarn/multi-d0c2d048a7 | 42935296be9c01bc851821e2043dacae4012cc2d | 1 / 51 | Открытый PR #156 |
| dependabot/npm_and_yarn/multi-f99730c1b7 | 45f949c52829d5bdf30b238438a9499ab15490e4 | 1 / 29 | Открытый PR #162 |
| dependabot/npm_and_yarn/noble/hashes-2.4.0 | fd6cf0028fef09334c41e70e9ebce98f250ec945 | 1 / 65 | Открытый PR #149 |
| dependabot/npm_and_yarn/tooling-b0b240819c | 3f41956812204d2c0bf1544bd4f4b596e196f2f6 | 1 / 51 | Открытый PR #158 |
| dependabot/npm_and_yarn/worker/arweave-2.0.1 | d38836fb3e102b086f9c377d8063c1b80e0b4db5 | 1 / 51 | Открытый PR #157 |
| dependabot/npm_and_yarn/worker/noble/ed25519-3.2.0 | cb6973dfad1f6a0b902a7fa40eeb0bccc0a0a04d | 1 / 65 | Открытый PR #148 |
| dependabot/npm_and_yarn/worker/worker-tooling-7464e63ee6 | 63dae1892a6ceca6e468eb352b297a02dd153bba | 1 / 51 | Открытый PR #146 |
| dependabot/npm_and_yarn/wrangler-4.127.1 | 2fd4309cd65ee079b08816d21d461ef11bee62d8 | 1 / 65 | Открытый PR #150 |
| docs/arweave-plan-v15 | 0cc05c178fe990d801007fe62b3e4c9f6985e571 | 0 / 147 | В main; кандидат на уборку |
| docs/backup-release-clean | 8ecfc79e84e448abc9155683d1d53ba43dc45a56 | 119 / 105 | Открытый PR #129 |
| docs/pwa-residual-void | a69023c7a67fec115f86653db49c2886bd49dfc6 | 0 / 156 | В main; кандидат на уборку |
| docs/qu-acceptance-android | aeb1f7808ee5558b0e3a2358fa8acc0acd4e1aec | 0 / 260 | В main; кандидат на уборку |
| docs/qu-acceptance-passed | aac34b2983a1fdc1d34ca46e8e142f0bfedac355 | 0 / 254 | В main; кандидат на уборку |
| docs/qu-accuracy | 8e8f64e49cf7c770ba31e49be0caa7146a3edd54 | 0 / 252 | В main; кандидат на уборку |
| docs/qu-credprops-accuracy | 9ba5d774314642de49d22a6ca86e7136e9facb9b | 0 / 250 | В main; кандидат на уборку |
| docs/qu1-deployed | c06c03043d277df804183f9e66494d7381e9c09b | 0 / 268 | В main; кандидат на уборку |
| docs/qu2-deployed | 8b4deee03e98336985b70d004bf4592c84447722 | 0 / 264 | В main; кандидат на уборку |
| docs/rollback-nav2 | f6e309338a238d8337b3ee367f4a6e143e1ee5fd | 0 / 317 | В main; кандидат на уборку |
| docs/rollback-restore-pin-deployed | 3280cdc4e48337561d7087e4c328de45430c487a | 0 / 347 | В main; кандидат на уборку |
| docs/secrets-runbook | 26f50fc3a9711c4d96a69761a23f406bd52c8127 | 0 / 188 | В main; кандидат на уборку |
| docs/soak-d2-criteria | 2682edff38f52f5689b4dcce5edcd5bba0f413ec | 0 / 8 | В main; кандидат на уборку |
| docs/stage-p-acceptance | 168b895483dbc7d445f7ba83737fcec228ed613b | 0 / 279 | В main; кандидат на уборку |
| docs/stage-p-deployed | c95d6ac18d25a17625527f0168ae3f70fc159520 | 0 / 281 | В main; кандидат на уборку |
| docs/sync1-acceptance | dfebbd54abe1e4370185c06cb80a230071f26a94 | 0 / 286 | В main; кандидат на уборку |
| feat/auto-lock-on-background | 1b354e928fe12d8cb70d044f33bd50e043b57587 | 0 / 395 | В main; кандидат на уборку |
| feat/backup-client-floor | 3bc379400a7050638502c4bd10617cf0a86e7839 | 10 / 105 | Открытый PR #109 |
| feat/backup-container | 649578c79bc2ab0bf278136bb54a62fe21ac7334 | 20 / 105 | Открытый PR #110 |
| feat/backup-d2a-client | ad7a6bfe5f9a0f0813245696cb850b3935109cb6 | 124 / 105 | Открытый PR #138 |
| feat/backup-export-verify | 2acda12e5bf3d5b6158f44b7878aeb519eb6b7ca | 35 / 105 | Открытый PR #112 |
| feat/backup-flags | 4d292efa6e863000661259914f5ef603ea748b76 | 53 / 105 | Открытый PR #114 |
| feat/backup-import | a30448d8c7ce2d7955467a0c48e17763211822c5 | 46 / 105 | Открытый PR #113 |
| feat/backup-merge-rules | e0ef973ae52c82f085b337ae04fdd2af3ee4bc7e | 27 / 105 | Открытый PR #111 |
| feat/backup-publication-fp | 322b330c4def3861277c0397291aee6b69994522 | 2 / 105 | Открытый PR #108 |
| feat/backup-store-actions | 4b35a32adf9c6855c6bc230de8c8d5a90da5352b | 90 / 105 | Открытый PR #124 |
| feat/backup-ui-block | 03a1edb38c6daa52ea217b9655e3e84f9e927ed3 | 108 / 105 | Открытый PR #125 |
| feat/backup-viewer | 4482ba6e67c4c74ca93e233a31c2dbffcdccc496 | 65 / 105 | Открытый PR #115 |
| feat/backup-viewer-route | 05019c44777cc33f489e6826b6a7413e2bcc380b | 80 / 105 | Открытый PR #116 |
| feat/deploy-config-migration | 796eb6a989b41275b56d40858e3fd73d5a0d8e45 | 0 / 191 | В main; кандидат на уборку |
| feat/global-uploads-switch | 648ff29de5525e0e63ebecad681018c3784cead4 | 0 / 189 | В main; кандидат на уборку |
| feat/incremental-sweep | b7dbdcfb284919593bf5feeba18ac6e952b7b53f | 0 / 290 | В main; кандидат на уборку |
| feat/notes-markdown-rhythm | 01c0938e5cff002b94896c4574f49a2572b9314b | 0 / 138 | В main; кандидат на уборку |
| feat/notes-preview-reading | 07656b2244d78d52485d710c4e4830ba07158cbd | 0 / 133 | В main; кандидат на уборку |
| feat/notes-version-page | 83d40efa3835a6bfb9aa09dab2e07c6e45364271 | 0 / 95 | В main; кандидат на уборку |
| feat/pr2-metrics | 51e5e8e25a0421c4d1089c633f096674393c5584 | 0 / 144 | В main; кандидат на уборку |
| feat/quick-unlock | 32839f2ea0c53e74a7e662a455fc6fff64bd959c | 0 / 270 | В main; кандидат на уборку |
| feat/quick-unlock-flag-on | 50682e91cc76bad9718d0458f8acd0f0b72102fd | 0 / 266 | В main; кандидат на уборку |
| feat/read-multigateway | 9b5d377167de854fd165ba28eb8ec20a773797f3 | 0 / 117 | В main; кандидат на уборку |
| feat/recovery-quarantine | 3a0c1e7902fbff95e60917ff150eb069ad5d4fd2 | 0 / 189 | В main; кандидат на уборку |
| feat/restore-pin-and-persistent-storage | 12acaaf361095343984550a846ee0d62b466eeb5 | 0 / 348 | В main; кандидат на уборку |
| feat/safebox-v4 | e0542dcbc467804a631333624870b9d4dcd6a9ed | 0 / 378 | В main; кандидат на уборку |
| feat/stage-p-pin-guards | 4a6958467ad36814b0ab9acc8822bed096d450b7 | 0 / 283 | В main; кандидат на уборку |
| feat/worker-noble-v3 | 923fa52c76a469b788df8cf7c061d600ea9fb473 | 0 / 156 | В main; кандидат на уборку |
| feat/worker-semantic-idempotency | b590c0ea0df3f9c15a000aa8c8cddab7c8bd87b7 | 0 / 66 | В main; кандидат на уборку |
| fix/deploy-worker-root-deps | 5bb13e3726f03bbc3e82647eb8f986f48c172f6b | 0 / 142 | В main; кандидат на уборку |
| fix/duplicate-import-vitest4 | a648b3573b211aace530c6868daacef11b2e2826 | 0 / 170 | В main; кандидат на уборку |
| fix/eslint10-recommended | 9456a8f97169f4b3288af9f21e7eb4e3102cf02e | 0 / 162 | В main; кандидат на уборку |
| fix/export-store-sampling | 2e12725a5c5cd5d8a8b848275c0c49457416f517 | 2 / 18 | Открытый PR #165 |
| fix/export-structured-source | 5d87ee47437d9158ee7e71bcef547d12dc1155c6 | 0 / 19 | В main; кандидат на уборку |
| fix/global-pause-lifecycle | d389139ca7b6240e5dae627f5aa2b783a9d15084 | 0 / 87 | В main; кандидат на уборку |
| fix/historical-candidate-rollback | 2c7302003622824c293654d66c29cb3649f1b374 | 0 / 24 | В main; кандидат на уборку |
| fix/major-bumps-test-compat | 2f931e577d72072c19f93197471f364ee09d200f | 0 / 180 | В main; кандидат на уборку |
| fix/quick-unlock-credprops | 4c8a5defe34a39eb30f9b6fbfa1529e89d1e65ec | 0 / 256 | В main; кандидат на уборку |
| fix/quick-unlock-no-prf-ux | 76c793f0fda6f22c845ec6dc5d44fb367e0d723c | 0 / 262 | В main; кандидат на уборку |
| fix/quick-unlock-resident-key | 78428063eaee4b41247436ff06d36ec952456272 | 0 / 258 | В main; кандидат на уборку |
| fix/restore-index-bounds | 15732a3e26c48997e8c9c52d9d9fb06dc0300042 | 0 / 87 | В main; кандидат на уборку |
| fix/worker-redirect-manual | 97ef84210245894db246867f2c6853efe5b8a16e | 0 / 61 | В main; кандидат на уборку |
| main | 0262575067b8c60f5056df07e4604c7e4988e7f1 | 0 / 0 | Основная; сохранить |
| security/phase1-c2-m4-ip-limiter | c479c5291be8d7771bce43595be81f660c394f8b | 0 / 405 | В main; кандидат на уборку |
| test/backup-matrix-completeness | 03a1edb38c6daa52ea217b9655e3e84f9e927ed3 | 108 / 105 | Дубликат tip feat/backup-ui-block |
| test/incident-matrix-completion | c37c18b3e5b66440c9041c869139cf7e3e0601fd | 0 / 158 | В main; кандидат на уборку |
| test/v3-writer-queue-driver | c895dac4262d17697a56cda67776888be8291d28 | 0 / 252 | В main; кандидат на уборку |

### Базы открытых PR

| PR | Head | Base |
|---|---|---|
| [#108](https://github.com/Yokogamma/payee/pull/108) | feat/backup-publication-fp | main |
| [#109](https://github.com/Yokogamma/payee/pull/109) | feat/backup-client-floor | feat/backup-publication-fp |
| [#110](https://github.com/Yokogamma/payee/pull/110) | feat/backup-container | feat/backup-client-floor |
| [#111](https://github.com/Yokogamma/payee/pull/111) | feat/backup-merge-rules | feat/backup-container |
| [#112](https://github.com/Yokogamma/payee/pull/112) | feat/backup-export-verify | feat/backup-merge-rules |
| [#113](https://github.com/Yokogamma/payee/pull/113) | feat/backup-import | feat/backup-export-verify |
| [#114](https://github.com/Yokogamma/payee/pull/114) | feat/backup-flags | feat/backup-import |
| [#115](https://github.com/Yokogamma/payee/pull/115) | feat/backup-viewer | feat/backup-flags |
| [#116](https://github.com/Yokogamma/payee/pull/116) | feat/backup-viewer-route | feat/backup-viewer |
| [#124](https://github.com/Yokogamma/payee/pull/124) | feat/backup-store-actions | feat/backup-viewer-route |
| [#125](https://github.com/Yokogamma/payee/pull/125) | feat/backup-ui-block | feat/backup-store-actions |
| [#129](https://github.com/Yokogamma/payee/pull/129) | docs/backup-release-clean | feat/backup-ui-block |
| [#138](https://github.com/Yokogamma/payee/pull/138) | feat/backup-d2a-client | docs/backup-release-clean |
| [#144](https://github.com/Yokogamma/payee/pull/144) | dependabot/npm_and_yarn/browserslist-4.28.8 | main |
| [#145](https://github.com/Yokogamma/payee/pull/145) | dependabot/npm_and_yarn/fast-uri-3.1.7 | main |
| [#146](https://github.com/Yokogamma/payee/pull/146) | dependabot/npm_and_yarn/worker/worker-tooling-7464e63ee6 | main |
| [#147](https://github.com/Yokogamma/payee/pull/147) | dependabot/npm_and_yarn/js-yaml-5.4.1 | main |
| [#148](https://github.com/Yokogamma/payee/pull/148) | dependabot/npm_and_yarn/worker/noble/ed25519-3.2.0 | main |
| [#149](https://github.com/Yokogamma/payee/pull/149) | dependabot/npm_and_yarn/noble/hashes-2.4.0 | main |
| [#150](https://github.com/Yokogamma/payee/pull/150) | dependabot/npm_and_yarn/wrangler-4.127.1 | main |
| [#152](https://github.com/Yokogamma/payee/pull/152) | dependabot/npm_and_yarn/humanfs/node-0.16.8 | main |
| [#156](https://github.com/Yokogamma/payee/pull/156) | dependabot/npm_and_yarn/multi-d0c2d048a7 | main |
| [#157](https://github.com/Yokogamma/payee/pull/157) | dependabot/npm_and_yarn/worker/arweave-2.0.1 | main |
| [#158](https://github.com/Yokogamma/payee/pull/158) | dependabot/npm_and_yarn/tooling-b0b240819c | main |
| [#161](https://github.com/Yokogamma/payee/pull/161) | dependabot/npm_and_yarn/baseline-browser-mapping-2.11.22 | main |
| [#162](https://github.com/Yokogamma/payee/pull/162) | dependabot/npm_and_yarn/multi-f99730c1b7 | main |
| [#165](https://github.com/Yokogamma/payee/pull/165) | fix/export-store-sampling | main |
