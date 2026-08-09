# Security guidance — Eternal Notes

Threat model: an **E2E-encrypted, invite-gated** notes app. A Cloudflare Worker
proxy pays for Arweave uploads, so the two crown jewels are **user plaintext /
key material** (must never leave the device or reach a log) and the **server's
paid-upload budget** (must never be spent twice or by an unauthorized key).
These rules are additive context for the reviewer — flag any change that
violates one, even if it type-checks and tests pass.

## Client crypto & key material (`src/lib/crypto.ts`)

- **Never log, serialize to the network, or persist in plaintext** a mnemonic /
  seed phrase, derived AES key, Ed25519 private key, or a raw PIN. Only
  `ciphertext`, `iv`, `ownerHash`, and the *public* key may leave the device.
- The AES-GCM auth tag **is** the integrity check. Do not add a separate hash
  field or skip GCM verification — a decrypt that succeeds is proof of integrity.
- Every encryption must use a **fresh random 12-byte IV** (`crypto.getRandomValues`).
  Never reuse an IV, never derive it from the note content, never default it.
- Key derivation is deterministic HKDF over the BIP-39 seed with the pinned
  `salt`/`info` strings. Changing a salt/info constant silently orphans every
  existing note — treat any edit to those constants as a breaking migration.
- v2 envelope hides the timestamp on-chain. Do not reintroduce a plaintext date
  (Timestamp tag / outer `t`) on the v2 path — that leaks metadata the envelope
  exists to protect. The inner `id` must be cross-checked against `noteId`.
- v3 envelope (note versioning) keeps the chain metadata (`rev`, `root`, `prev`,
  `fmt`) **inside the ciphertext** — never move any of it into tags or the outer
  JSON (the version graph is private metadata). `decryptNote` dispatches on an
  **explicit version switch** (absent/1, 2, 3) and rejects anything else — an
  unknown `v` must never fall through to the v1 raw-text path.
- **UUID namespace barrier**: v3 noteIds are UUID**v8** (`randomUuidV8`), v1/v2
  are UUIDv4. The worker enforces the split per App-Version so a stale pre-v3
  client tab re-serializing a shared-IndexedDB v3 record as v1 is rejected
  (400) instead of permanently committing garbage ciphertext under the
  per-noteId idempotency. Never relax either direction of this check.
- Every note **version** gets a FRESH UUID (worker idempotency is permanent per
  noteId — re-using an id can never produce a second transaction). The chain
  identity is `root` inside the envelope, never the noteId.

## PIN unlock — typed errors gate the wipe (`src/lib/crypto.ts`)

- Only `WrongPinError` (a GCM `OperationError` **after** the KDF ran) may count
  against the attempt limit or trigger the 10-strike seed wipe.
- Every other failure — corrupt/malformed blob, unknown `kdf`/version, Argon2
  WASM/OOM, WebCrypto hiccup — must be `PinUnlockUnavailableError` and **never**
  spend an attempt. Miscategorizing an environment failure as a wrong PIN wipes
  a correct user's PIN.
- `assertValidPinBlob` runs **before** the KDF and pins Argon2 params to the v1
  profile. Never let an untrusted blob choose `memorySize`/`iterations` (OOM/hang
  DoS on weak mobiles). New tuning ⇒ new version constant, not looser validation.

## Worker request auth (`worker/src/index.ts`)

- **Verify the Ed25519 signature BEFORE any KV/DO lookup or paid work.** The
  order (freshness → signature → lookup) is load-bearing anti-abuse; do not move
  a storage read or Arweave call ahead of `verifySignature`.
- Public keys are **canonical base64 of exactly 32 bytes** only
  (`isValidPublicKeyB64` — decode, length-check, round-trip). A non-canonical
  spelling decodes to the same key but keys a *different* `pk:` entry that
  `/admin/revoke` can never reach. Never relax this to a plain length/charset check.
- `ownerHash` must equal `SHA-256(publicKey)`; reject on mismatch.
- Timestamps must be a finite number within ±5 min (`isFreshTimestamp`) — this
  is the replay window. Do not widen it or accept `NaN`/strings.
- Admin auth must stay **constant-time** (`verifyAdminSecret`: SHA-256 both
  sides → `crypto.subtle.timingSafeEqual`). Never compare secrets with `===`,
  never early-return on a length mismatch.

## The paid-upload budget & recovery HMAC (`worker/src/index.ts`)

- `RECOVERY_HMAC_SECRET` is **mandatory**: `/upload` returns 503 while it is
  missing or <16 chars. Never add a code path that posts to Arweave without it —
  a triple-failure would become a duplicate *paid* transaction.
- Never trust a client-supplied `txId`. A recovery hint is only honored after
  its **HMAC verifies** (`verifyRecovery`, constant-time) and only inside a
  recheck; a malformed/forged hint must **fail closed** (release reservation +
  400), never fall through to a fresh post.
- Config parsing is **fail-closed**: `parsePositiveInt` → `null` ⇒ 503. Never
  disable a limit (body cap, quota) because a value was `NaN`/garbage.
- Bodies are read under a **streaming hard cap** (`readLimitedBody`) that cancels
  the stream past the limit — never buffer an unbounded body, never trust
  `Content-Length` alone. Auth endpoints cap at `AUTH_BODY_MAX_BYTES` (4 KB).
- Tag/data validation is **strict and exact-key** per `App-Version`. Do not
  accept extra tags/fields — that's how a v2 payload could smuggle a Timestamp
  and leak the date on-chain. v3 is wire-identical to v2 (5 tags, `{id,c,iv}`)
  plus the UUIDv8 Note-Id requirement; a new format means a NEW App-Version
  with its own exact set, never a loosened existing one.
- **v3 upload kill switch** (`V3_UPLOADS_ENABLED`): strictly `"true"` enables;
  anything else fails CLOSED — v3 uploads (including reconciliation and
  recovery hints) get `503 {code:'v3_uploads_disabled'}` after the IP limiter
  but **before any per-owner RateLimiter DO call or Arweave POST**. Never move
  the gate check after a DO call (`/check-and-reserve` mutates state even on a
  lookup) and never respond 403 (the client treats 403 as not_registered and
  drops its registration marker).

## Allowlist / revocation invariants (`worker/src/invite-manager.ts`)

- **Every `pk:*` / allowlist KV write happens ONLY inside `InviteManager`, under
  `blockConcurrencyWhile`.** The Worker must never write the allowlist cache
  (`writeAllowCache`) directly. An unserialized worker-side get→put can
  interleave with a revoke and resurrect a denied key.
- **Revoke is deny-first**: the `denied` KV write is the first mutation in the
  critical section; if it fails, nothing else changes → retryable 503. Never
  pre-write `denied` from the Worker (KV's ~1 write/sec/key limit could make the
  authoritative write the one that fails).
- `refresh-allowed` writes **nothing** on a negative verdict, and `register`'s
  `alreadyRegistered` branch writes nothing — neither may resurrect a racing
  revoke's `denied`. A `refresh-allowed` verdict is **final**; honor
  `allowed:false` even if an earlier KV read said otherwise.
- `seed-invite` is **create-only**: an existing code (used/revoked/unused) is
  reported `skipped`, never overwritten. Re-seeding must never make a one-time
  invite reusable or un-revoke a key.

## Rate limiting, CORS, restore

- Per-IP limiting keys off `CF-Connecting-IP` (edge-set, unspoofable) and is
  **fail-closed** (503 if the limiter DO is unreachable). Keep the `diag` bucket
  separate so a public GET can't starve upload/register budget.
- CORS reflects an origin **only if it is in `ALLOWED_ORIGINS`**. Never emit
  `Access-Control-Allow-Origin: *`, never wildcard `*.pages.dev` preview domains
  into the prod allowlist.
- Restore must keep the **trusted-owners filter** (`parseTrustedOwners`, C2):
  reject notes not signed by a pinned wallet, and fail *loudly* on a malformed
  owner set (an empty/misconfigured set reads as "all notes lost").

## Web / PWA hygiene

- No `eval` / `new Function` / dynamic code from remote data. No `.innerHTML =`
  / `dangerouslySetInnerHTML` with note content — render as text.
- Keep the strict CSP and self-hosted fonts; do not add third-party script,
  style, font, or connect origins. The only backend the client talks to is the
  Worker proxy (`VITE_PROXY_URL`, bare origin).
- Production build must **fail closed** without pinned `VITE_TRUSTED_OWNERS` and
  an HTTPS `VITE_PROXY_URL` — don't add a fallback that lets the build succeed
  unconfigured.
