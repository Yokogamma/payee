# ∞ Eternal Notes

**Заметки, которые живут вечно.** Зашифрованы. Неудаляемы.

Быстрая запись → E2E-шифрование на клиенте → вечное хранение в Arweave через
собственный Cloudflare Worker-прокси (сервер платит AR, доступ по инвайтам).

## Концепция

- **Zero friction** — открыл → написал → закрыл. Никаких папок, тегов, категорий
- **E2E шифрование** — AES-256-GCM, ключ из seed-фразы (BIP-39, 12 слов); ключ никогда не покидает устройство
- **Восстановление** — ввёл 12 слов на новом устройстве → заметки скачиваются из блокчейна и расшифровываются локально
- **Вечное хранение** — Arweave; загрузка через Worker-прокси с инвайт-доступом и rate-limit
- **PWA** — офлайн-first (Workbox precache), установка на домашний экран, управляемые обновления
- **Быстрый вход** — опциональный PIN (Argon2id) поверх seed-сессии
- **AI поиск / авто-связи** — backlog (фаза 2)

## Запуск

```bash
npm install
npm run dev            # клиент (Vite)

cd worker
npm install
npm run dev            # Cloudflare Worker (wrangler dev)
```

## Тесты

```bash
npm test               # клиент: vitest (crypto, storage, transport, компоненты)
npm run lint

cd worker
npm run typecheck
npm test               # workerd-pool (DO/KV) + отдельный direct-процесс
```

Продакшен-сборка требует пиннинга доверенных кошельков и HTTPS-прокси
(fail-closed, иначе сборка падает):

```bash
VITE_TRUSTED_OWNERS=<arweave-address[,addr2]> \
VITE_PROXY_URL=https://<proxy-origin> \
VITE_STATUS_GATEWAYS=https://a,https://b \
VITE_PAYLOAD_GATEWAYS=https://a,https://b \
VITE_INDEX_SOURCES='https://a/graphql|https://b/graphql,https://c/graphql' \
npm run build
```

**Шлюзы (PR-3a).** Три списка задают, куда уходят запросы чтения, и из них же
генерируется `connect-src` в CSP:

- `VITE_STATUS_GATEWAYS` — bare origins через запятую. Опрашиваются
  параллельно, поэтому порядок не значим. Вердикт `dead` требует единогласия
  ВСЕХ настроенных и минимум двух настроенных — с одним шлюзом он недостижим
  по построению, и деплой такой конфигурации гейт отвергает.
- `VITE_PAYLOAD_GATEWAYS` — bare origins, **порядок значим**: перебор идёт
  последовательно до первого ответа, прошедшего проверку `txId ↔ bytes`.
- `VITE_INDEX_SOURCES` — полные URL. Запятая разделяет ЛОГИЧЕСКИЕ источники,
  вертикальная черта — transport-fallback'и одного и того же индекса
  (`a|a-fallback,b`); группировка фиксирует, что вторая ссылка не является
  независимым мнением.

Пустые значения дают одиночный `arweave.net` — годится для локальной сборки,
но не для деплоя: там требуется утверждённый набор (`scripts/gateway-pins.mjs`).

## Стек

- **Frontend:** React 19 + TypeScript + Vite + vite-plugin-pwa (Workbox)
- **Шифрование:** Web Crypto API (AES-256-GCM), @scure/bip39, Ed25519 (@noble), Argon2id (hash-wasm) для PIN
- **Хранение на устройстве:** IndexedDB (idb) — заметки, sync-состояние, meta
- **Вечное хранение:** Arweave через Cloudflare Worker-прокси (Durable Objects: инвайты/allowlist, квоты, per-IP limiter; KV — read-through кэш доступа)

## Архитектура надёжности (кратко)

- Sync — state machine `queued → uploading → accepted → confirmed` с
  server-authoritative reconciliation: резервирование с CAS-токеном,
  `posted`-якорь, HMAC recovery-token на случай triple-failure — дубликаты
  платных транзакций исключаются
- Restore — параллельный пул с прогрессом; «истина после расшифровки»:
  обязательный фильтр по доверенным кошелькам + отбраковка расхождений envelope
- Деплой — Cloudflare Pages (CSP/`_headers` генерируются в build); порядок
  раскаток и откатов: `docs/ROLLBACK.md`

## Безопасность

- Ключ **никогда** не покидает устройство; на chain уходит только ciphertext
- Seed-фраза — единственный способ восстановить данные; без seed → данные нечитаемы навсегда
- PIN — только быстрый вход на устройстве (10 неверных попыток → PIN стирается, вход по seed)
- Строгий CSP, self-hosted шрифты, инвайт-доступ к прокси, per-IP rate-limit

## Лицензия

MIT
