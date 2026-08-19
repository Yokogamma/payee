# Security guidance — Matamata Notes

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

## Safebox (v4) — split envelope & naming (`src/lib/crypto.ts`)

- **Naming is a safety rule, not style.** `vault*` already means the NOTES
  store (`vaultEpochRef`, `prepareVaultSnapshot`, meta `vault-public-key`,
  `VaultMismatchError`). The safebox is **`safebox*` everywhere** (store
  `safebox`, meta `safebox-pin`, types `Safebox*`, flag
  `SAFEBOX_WRITER_ENABLED`, HKDF info `safebox-*-v1`). Mixing the two
  vocabularies is how a wipe bug reaches the wrong PIN contour.
- **Two independent keys, two independent ciphertexts.**
  `deriveSafeboxMetaKey` (`info: "safebox-meta-v1"`) and
  `deriveSafeboxSecretKey` (`info: "safebox-secret-v1"`) are separate HKDF
  outputs over the same BIP-39 seed. The META key may live in a ref for the
  duration of an unlocked section; the SECRET key is derived on demand inside
  reveal/copy/download/edit/restore and dropped immediately — **never cache it,
  never put it in a ref, never hand it to search code**.
- **Both halves carry `id === entryId` and BOTH decryptors cross-check it.**
  That check is load-bearing: it defeats mix-and-match (grafting record A's
  secret blob onto record B's meta). Never relax it to "check one side".
- `fid` contract: canonical UUID, **unique within each array**, and the two
  arrays must correspond one-to-one with equal cardinality; the descriptor's
  `size` must equal the decoded attachment length. Replacing a file mints a NEW
  `fid` — never reuse one across versions.
- Attachment **descriptors** (name/mime/size) live in the META envelope,
  **contents only** in the SECRET envelope. Search indexes the meta fields only
  — the password and attachment contents are never indexed, never in the DOM.
- Chain grouping and "current version" selection use the **authenticated**
  envelope fields (`t`/`rev`/`root`), never the locally-mutable outer
  `createdAt` — otherwise a tampered local record promotes an old password.
- `root`/`prev` are validated as **UUIDv8**, not "any UUID". Notes need the
  looser check (a v3 version may legitimately be rooted at a legacy UUIDv4
  note); the safebox has no legacy predecessor, so anything outside the v8
  namespace is forged or corrupt. Both the decrypt path and
  `encryptSafeboxEntry` enforce it — never make a record the reader refuses.
- `EncryptedNote.v` stays `1|2|3`. The safebox has its **own** type and its own
  `decryptSafeboxMeta`/`decryptSafeboxSecret` — never add a `v:4` branch to
  `decryptNote`/`buildUploadPayload`'s note path (their fail-closed guards must
  keep rejecting unknown note versions).

## Safebox PIN (`src/lib/crypto.ts`, `src/lib/storage.ts`)

- The safebox PIN blob wraps a **random 32-byte verifier**, never the mnemonic
  and never a key. Brute-forcing it yields nothing but "the PIN was right".
- **Disclosed, accepted risk**: the blob's GCM tag is a *second, independent
  offline oracle* for the safebox PIN (6–8 digits ≈ 10⁶–10⁸ × ~1 s Argon2id),
  present even when the main PIN is not configured. It is accepted BECAUSE
  cracking it reveals neither the seed nor any safebox key — unlike `pin-seed`,
  which wraps the mnemonic itself.
- Same typed-error discipline as the main PIN: only a GCM `OperationError` after
  a successful KDF may count against attempts (`SafeboxWrongPinError`);
  everything else is `SafeboxPinUnavailableError` and spends nothing.
- The PIN config is ONE meta record `{blob, configId, attempts, lockedUntil}`,
  runtime-validated on **every** read (`assertValidSafeboxPinConfig`: canonical
  UUID `configId`, attempts 0..9, valid/absent lockout, valid blob, **no extra
  or missing fields**). Malformed ⇒ fail closed to
  `SafeboxPinUnavailableError`: no attempt spent, lockout untouched, seed-reset
  still offered.
- All mutations go through the transactional helpers (one readwrite `meta`
  transaction that re-reads inside the transaction) and **verify the captured
  `configId`** — a read-modify-write via `getMeta`/`setMeta` loses cross-tab
  increments and can credit a failure to a replaced config.
- **BroadcastChannel is a fast path, not a guarantee.** Before publishing ANY
  secret (reveal/copy/download/edit/history/seed gate) re-read the config from
  IndexedDB and compare `configId`. Tests must cover an environment with no
  BroadcastChannel.
- The «not the same as the main PIN» check runs raw `decryptWithPin` OUTSIDE the
  metered path and must never read or write `pin-attempts`/`pin-locked-until`.
  `PinUnlockUnavailableError` there means "cannot verify" ⇒ allow (it is
  hygiene, not a security boundary).
- The blob nested in the config goes through the FULL `assertValidPinBlob` — the
  same check the KDF path runs. A shallow "three strings are present" test would
  let a hostile blob pick its own Argon2 parameters.
- **Argon2id takes ~1 s, so the config can move under a running operation.**
  Every write is therefore a precondition + one transaction
  (`commitSafeboxPinWrite`): `'absent'` for first activation, `{configId}` for a
  PIN change, `'seed-authorized'` (unconditional, by design) for the seed reset.
  An unconditional `setMeta` would let a slow change clobber a config another
  tab installed meanwhile.
- **Every safebox write — PIN config included — is `dbGeneration`-guarded**
  (`StorageResetError`). Without it a flow that started before «Сбросить
  приложение» can resurrect `safebox-pin` in the wiped database, or attach it to
  whatever vault is opened next.

## Safebox lock discipline (`src/lib/store.tsx`)

- `unlockSafebox` RESOLVES ONLY on a fully published, still-live session; a lock
  during the KDF throws `SafeboxLockedError`. Callers treat a resolution as
  proof of the PIN — the Settings seed gate literally shows the mnemonic on it —
  so a silent «superseded» return there would hand out the seed phrase.
- That gate is also LIVE, not a one-shot flag: the phrase renders only while
  `safeboxUnlocked` is still true.
- **Opening the section IS a secret publication.** `publishUnlockedSafebox`
  re-reads `safebox-pin` and compares `configId` immediately before writing the
  refs/state — decrypting N entries takes real time, and without
  BroadcastChannel another tab can replace the configuration inside that
  window. Both epochs AND the config are checked; a mismatch locks and throws.
  A returning tab additionally runs `reconcileSafeboxConfig()` on
  `focus`/`pageshow` instead of waiting for the next secret action.
- Activation captures BOTH epochs BEFORE its first await. Re-reading the
  section epoch after the ~1 s KDF would let a cancelled activation set a PIN
  and open the section inside a HIDDEN tab.
- Safebox writer actions re-check BOTH epochs synchronously immediately before
  `commitSafeboxEntry`. Notes deliberately persist across a lock (ciphertext at
  rest is the promise made when the user hit save); the safebox does NOT — its
  form is destroyed by the lock, so a version saved anyway would be invisible to
  its author and would still burn a paid upload.
- **The privacy gate is imperative on purpose.** The gate element is ALWAYS
  mounted and `hidden`/`inert` are flipped as ATTRIBUTES straight on the DOM
  nodes. A React commit is not guaranteed to land before the BFCache snapshot
  taken inside `pagehide` — which is the exact moment the gate exists for.
  Never convert it back to conditional rendering or to a React-driven prop.
  The companion CSS rule `.lock-gate[hidden] { display: none }` is load-bearing:
  the base `.lock-gate { display: flex }` would otherwise out-specify the UA's
  `[hidden]` and leave the gate covering the app forever.
- A lock bumps `safeboxLockGeneration`, and the UI keys the whole safebox
  subtree on it. Clearing state only on `unlocked: true → false` is NOT enough:
  the activation, PIN-pad and seed-reset forms run while the section is LOCKED,
  so their local state — including a fully typed seed phrase — would otherwise
  survive a hidden/pagehide round-trip. `lockSafeboxNow` additionally blanks
  those inputs SYNCHRONOUSLY in the DOM, before any snapshot can be taken.
  Safebox inputs that live OUTSIDE the section (the Settings PIN-change form,
  the seed-gate PIN) must carry `className="safebox-secret-field"` so the same
  scrub reaches them, and the Settings block is keyed on the lock generation.
  Any NEW safebox secret field must be added to one of those two mechanisms.
- A `blocking` upgrade (a newer build in another tab) closes our database, so
  the store locks the vault as well as showing the reload screen: decrypted
  state that can no longer be persisted is pure liability.

## Safebox sync bookkeeping (`src/lib/storage.ts`, `src/lib/store.tsx`)

- `SyncRecord.kind` normalization distinguishes two cases and must keep doing
  so: an **absent** field is a legacy pre-v4 row (→ `note`), while a **present
  but invalid** value is a corrupted row and is **quarantined**
  (`terminalError:'malformed_record'`). Collapsing them into "just call it a
  note" is fail-OPEN — the row would re-enter the upload queue.
  Use `Object.hasOwn(raw, 'kind')`, not `=== undefined`: structured clone
  preserves a key explicitly stored as `undefined`, and such a row was written
  by something that knew about the field and got it wrong — corruption, not
  history.
- The aggregates are tallied by iterating the **stored records** and looking
  their sync state up by id — never by iterating the sync store. This buys two
  invariants at once: a corrupted `kind` cannot move a row between buckets, and
  an ORPHAN sync row (an id in neither store) is ignored. The second is
  safety-critical: an orphan `confirmed` row would otherwise cancel out a real
  unsynced note in `resetRisk` and make the reset dialog claim everything is on
  chain immediately before wiping it. The `kind` field remains the dispatch
  signal for SERIALIZATION, where the queue item carries it explicitly.

## Safebox attachment intake (`src/components/SafeboxEntryForm.tsx`)

- Everything cheap — count, name/MIME length, the raw byte budget from
  `File.size` — is validated BEFORE `arrayBuffer()`, so a multi-gigabyte file is
  never materialised.
- The budget is **reserved synchronously in a ref** before the first await. A
  render snapshot would let two concurrent picks validate against the same
  stale total and jointly exceed the cap. Aborted intakes release it; removing
  a file gives it back.
- The read loop re-checks an intake **generation** after every file and stops
  on an unmount/lock, so a locked safebox never keeps ingesting. A file whose
  real byte length differs from the reserved `File.size` is refused.

## Safebox on-chain metadata (disclosed risk)

App-Version=4 records are publicly distinguishable from notes under the same
`Owner-Hash`. An observer learns that a safebox exists, how many entries and
versions it has, and roughly when rotations happened (block heights) — the
per-entry `t` stays inside the envelope. This is unavoidable in a
single-wallet architecture; it is an accepted, user-disclosed risk (release
notes + in-app text), not a bug to "fix" by moving metadata into tags.

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
  plus the UUIDv8 Note-Id requirement; v4 keeps the same 5 tags but its own
  exact data set `{id,mc,miv,sc,siv}` (UUIDv8 too) with **both** ciphertext/iv
  pairs validated. A new format means a NEW App-Version with its own exact set,
  never a loosened existing one.
- **v3 upload kill switch** (`V3_UPLOADS_ENABLED`): strictly `"true"` enables;
  anything else fails CLOSED — v3 uploads (including reconciliation and
  recovery hints) get `503 {code:'v3_uploads_disabled'}` after the IP limiter
  but **before any per-owner RateLimiter DO call or Arweave POST**. Never move
  the gate check after a DO call (`/check-and-reserve` mutates state even on a
  lookup) and never respond 403 (the client treats 403 as not_registered and
  drops its registration marker).
- **v4 upload kill switch** (`V4_UPLOADS_ENABLED`): the same contract on its own
  switch (`503 {code:'v4_uploads_disabled'}`). The two gates are INDEPENDENT —
  never collapse them into one flag, and never let one version's pause stop the
  other. `/health` publishes both; `versions` describes the acceptor and still
  contains a version while its gate is off, so a client must require
  `ok && <version>Uploads===true && versions∋<version>` before resuming.

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
