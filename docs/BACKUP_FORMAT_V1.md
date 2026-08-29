# Backup format v1

Normative source for the byte formats the backup track shares between halves
that are deployed independently — the PWA client, the Cloudflare Worker and the
standalone `backup-viewer.html`. Spec this implements: the approved «backup v1»
phase-1 plan (operator-held, not in this public repository); the section numbers
quoted below (§4, §5, D-decisions) are that plan's.

A format documented here is FROZEN: containers written today must stay readable
by a viewer saved today, long after the project itself is gone. Anything not
yet shipped is absent from this document rather than sketched in it.

Sections land with the code that implements them. Currently documented:

- §1 — the canonical publication fingerprint (`fp`);
- §2 — the backup container v1 (shape, canonical JSON, keys, nonce, cap, vector);
- §3 — `publicationEquivalent`, the client-side counterpart of §1.

## 1. Publication fingerprint (`fp`)

### 1.1 What it is for

`fp` answers one question on the SERVER: is this upload «the same record, sent
again» or «different bytes under a reused `noteId`»? The per-id idempotency in
the Durable Object is permanent, so without a fingerprint the second case is
indistinguishable from the first and gets answered with a historical `txId` —
the «payload B ↔ txId A» defect the backup track exists to make impossible.

`fp` is a **server concept**. The client ships no production implementation and
has no consumer for one; a test-only mirror
(`src/lib/publication-fp.fixture.ts`) exists solely to check the client half
against the vector in §1.5.

### 1.2 Inputs

Exactly two strings, both taken from the upload payload the client sends to the
proxy (`src/lib/arweave.ts` — `buildUploadPayload` / `buildSafeboxUploadPayload`):

| Input | Source | Why |
|---|---|---|
| `appVersion` | value of the `App-Version` tag (`'1'`, `'2'`, `'3'`, `'4'`) | selects the serialization: v1 carries the outer `t` and a `Timestamp` tag, v2/v3 do not, v4 is a split envelope. Version confusion is exactly what this fingerprint must catch, so it is bound EXPLICITLY — «the tags are derivable from `data`» is not treated as a guarantee. |
| `data` | the outer `data` string, verbatim | the published bytes themselves. |

Deliberately **excluded**: `timestamp`, `recheck` and `recovery`. These are
transport fields — two honest attempts at publishing the very same record differ
in all three, and a fingerprint that moved with them would report a conflict on
every retry. `ownerHash` is excluded for the same reason it is stubbed in
`publicationEquivalent`: it is a per-device value, not part of the publication's
identity.

### 1.3 Algorithm

```
domain    = "eternal-notes/publication-fp/v1\n"      // U+000A, not CRLF
canonical = {"appVersion":<json-string>,"data":<json-string>}
fpInput   = domain || canonical                      // UTF-8
fp        = lowercase-hex( SHA-256( fpInput ) )      // 64 characters
```

`canonical` is a flat string→string record serialized with keys sorted
ascending, no whitespace, and standard JSON string escaping. The two keys are
ASCII, so code-unit order equals code-point order and the result is always
`appVersion` before `data`. Sorting is performed explicitly rather than left to
property insertion order, which is a detail of whichever call site built the
object.

The domain separator is part of the format: changing it invalidates every `fp`
already stored in a Durable Object, so it moves only together with a new
fingerprint version (`/v2`), never in place.

Both implementations fail closed when either input is not a string — a numeric
`appVersion` or an object `data` would otherwise be coerced into something that
hashes cleanly and means nothing.

**The bytes → string boundary is normative.** `fp` is defined over strings, but
a publication fetched from a gateway arrives as bytes, and that conversion is
where the fingerprint can quietly lose its meaning: a lossy UTF-8 decode maps
every invalid sequence onto U+FFFD, so two different byte sequences would
produce one string and therefore one `fp`. The worker MUST decode with
`TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`
(`decodePublicationData`) — invalid UTF-8 is an unprovable publication and ends
as **503**, never as an `observedFp` write, and a leading BOM is kept as a
character rather than normalized away.

### 1.4 Implementations

| Half | Module | Status |
|---|---|---|
| Worker | `worker/src/publication-fp.ts` | production |
| Client | `src/lib/publication-fp.fixture.ts` | **test-only**; a production import is a lint error (`eslint.config.js`) |

The two are written independently on purpose — a shared import would make the
parity test tautological. They are checked against §1.5 from both sides
(`src/lib/publication-fp.test.ts`, `worker/test/publication-fp.test.ts`), and
the worker suite additionally computes both in one process and compares.

### 1.5 Test vector

Three records covering every serialization in use. `data` is what the real
builders produce; `fpInput` is shown as a JSON string literal so the domain
separator's newline and the inner escaping are unambiguous.

**Case A — v1 note** (`v` absent; outer `t` + `Timestamp` tag)

```
record     {"noteId":"11111111-2222-4333-8444-555555555555","ciphertext":"AAAA","iv":"AAAAAAAAAAAAAAAA","createdAt":1756000000000}
appVersion "1"
data       {"id":"11111111-2222-4333-8444-555555555555","c":"AAAA","iv":"AAAAAAAAAAAAAAAA","t":1756000000000}
fpInput    "eternal-notes/publication-fp/v1\n{\"appVersion\":\"1\",\"data\":\"{\\\"id\\\":\\\"11111111-2222-4333-8444-555555555555\\\",\\\"c\\\":\\\"AAAA\\\",\\\"iv\\\":\\\"AAAAAAAAAAAAAAAA\\\",\\\"t\\\":1756000000000}\"}"
fp         4a9a4c67b6935b6f9888d919307172fa0c1772912a4b2e9b99181f7dd3c9d883
```

**Case B — v3 note** (no timestamp on-chain)

```
record     {"noteId":"66666666-7777-8333-9444-555555555555","v":3,"ciphertext":"BBBB","iv":"BBBBBBBBBBBBBBBB","createdAt":1756000000000}
appVersion "3"
data       {"id":"66666666-7777-8333-9444-555555555555","c":"BBBB","iv":"BBBBBBBBBBBBBBBB"}
fpInput    "eternal-notes/publication-fp/v1\n{\"appVersion\":\"3\",\"data\":\"{\\\"id\\\":\\\"66666666-7777-8333-9444-555555555555\\\",\\\"c\\\":\\\"BBBB\\\",\\\"iv\\\":\\\"BBBBBBBBBBBBBBBB\\\"}\"}"
fp         5f258ae47a951919e592998ab9fe95507f390edffef5b30eede5fdd893d78415
```

**Case C — v4 safebox entry** (split envelope)

```
record     {"entryId":"88888888-9999-8aaa-baaa-cccccccccccc","v":4,"metaCiphertext":"CCCC","metaIv":"CCCCCCCCCCCCCCCC","secretCiphertext":"DDDD","secretIv":"DDDDDDDDDDDDDDDD","createdAt":1756000000000}
appVersion "4"
data       {"id":"88888888-9999-8aaa-baaa-cccccccccccc","mc":"CCCC","miv":"CCCCCCCCCCCCCCCC","sc":"DDDD","siv":"DDDDDDDDDDDDDDDD"}
fpInput    "eternal-notes/publication-fp/v1\n{\"appVersion\":\"4\",\"data\":\"{\\\"id\\\":\\\"88888888-9999-8aaa-baaa-cccccccccccc\\\",\\\"mc\\\":\\\"CCCC\\\",\\\"miv\\\":\\\"CCCCCCCCCCCCCCCC\\\",\\\"sc\\\":\\\"DDDD\\\",\\\"siv\\\":\\\"DDDDDDDDDDDDDDDD\\\"}\"}"
fp         acb55eaaf1d99b728ebe3ea523c9cec3918c3acfc21dc2f337f1b6a92e1ae143
```

The `fp` values above are asserted verbatim by both test suites, and the client
suite additionally asserts that this document still contains them — a vector
that drifts out of the documentation is the failure mode a frozen format cannot
afford.

## 2. Container v1

Implemented by `src/lib/backup.ts`. Read by the PWA and by the standalone
`backup-viewer.html`, which may be years older or newer than the file it opens
— everything below is therefore frozen.

### 2.1 Shape

```jsonc
{
  "format": "eternal-notes-backup",
  "v": 1,                              // container version
  "minReaderVersion": 1,               // lowest reader protocol that understands the body
  "containsUnsupportedRecords": false, // required field
  "createdAt": 1756000000000,
  "body": { "iv": "<base64>", "ciphertext": "<base64>" }
}
```

One AES-256-GCM blob, and the **canonical bytes of the five header fields are
the AEAD additional data**. A separate manifest, body hash or per-record MAC
would only add ways for two integrity claims to disagree; GCM already gives
integrity and authentication for both halves at once. Editing any header field
in a text editor therefore fails decryption rather than passing unnoticed.

A top-level key outside these six is a **rejection**, not something ignored:
anything else would sit outside the additional data, which is precisely where
it would be useful to an attacker.

### 2.2 The encrypted body

```jsonc
{
  "counts":   { "notes": 1, "safebox": 1 },
  "incompleteRestore": false,
  "notes":    [ /* IndexedDB records, as they are */ ],
  "safebox":  [ /* IndexedDB records, as they are */ ]
}
```

**No sync section, in any form.** A file cannot prove «these bytes were
published by that transaction», so publication state is never exported and
never restored. Its absence is checked, not assumed: an unexpected body key is
corruption.

Records travel verbatim — no `{id, v, raw}` wrapper — and unknown fields are
preserved. The guarantee is **semantic preservation plus equality of canonical
JSON bytes**; byte equality of the original object is not promised, because
canonization reorders keys and IndexedDB stores a structured clone anyway.

Stable fields, by collection, with the real key names:

| Field | Required | Note |
|---|---|---|
| `notes[*].noteId` | yes | |
| `notes[*].v` | **no** | its absence legitimately means v1 (`crypto.ts`), so requiring it would either reject legacy backups or mutate records that must travel as they are. An OPAQUE note must therefore carry an explicit unsupported `v` — otherwise it is indistinguishable from a legacy v1 record. |
| `safebox[*].entryId` | yes | |
| `safebox[*].v` | yes | |

`counts` must equal the collection lengths. It is a cheap end-to-end check: a
truncated or half-written body fails here instead of restoring silently short.

**Every invariant in this section is enforced identically in BOTH
directions**, by one shared validator. A decoder stricter than its encoder
would let an export write a file that its own import rejects — and the
rejection would surface at restore time, on another device, possibly after
the original data is gone.

**Id uniqueness is fail-closed on all three counts** (D10): unique within
`notes`, unique within `safebox`, and **disjoint between them**. Notes and
safebox entries share one key space downstream — the sync store is keyed by a
single id, and so is restore — so a cross-collection collision would make the
result depend on processing order.

`incompleteRestore` lives **inside the ciphertext**, never in the open header:
it is one more metadata bit to leak and a second source of truth for something
the body already states. It says the container is *narrower than the file it
was restored from*, which is orthogonal to `containsUnsupportedRecords` (what
the container *holds*). A reader never clears it on its own.

`containsUnsupportedRecords` is checked **asymmetrically** after successful
authentication: header `false` while the reader sees unreadable records → fail
closed; header `true` while the reader sees none → normal, the reader is simply
newer and the warning is dropped. Strict equality would reject a valid backup
at exactly the build able to restore it.

### 2.3 Canonical JSON

Keys in **code-point** order (not the UTF-16 code-unit order `Array.prototype.sort`
gives by default — they differ for astral characters), arrays in order, no
whitespace, standard JSON string escaping.

Serialization also **validates**, in the same pass, and fails closed. Values
`JSON.stringify` would silently mangle are refused rather than written:
`undefined`, functions, symbols (as values or keys), `BigInt`, `Date`, `Map`,
`Set`, `ArrayBuffer`, typed arrays, any non-plain prototype, cycles, `NaN`,
`±Infinity`, `-0` (it would return as `+0`), **sparse arrays** (a hole becomes
`null`) and **non-index properties on an array** (they vanish). Each of those is
silent data loss inside a file whose whole purpose is to still be readable when
nothing else is left, so the record waits for a container v2 instead.

### 2.4 Key derivation

```
IKM  = mnemonicToSeedSync(mnemonic).slice(0, 32)   // BIP-39, empty passphrase
salt = "eternal-notes-v1"
info = "backup-v1"
key  = HKDF-SHA256(IKM, salt, info) -> AES-256-GCM
```

The mnemonic is normalized exactly as everywhere else in `crypto.ts`, the salt
is the same fixed one, and only `info` separates the domains — so a backup key
can never open a note envelope, or the reverse. Written out here in words, not
only pinned by the vector, because a viewer saved today may have to be
re-implemented from this document alone.

### 2.5 Nonce and tag

A **fresh** `crypto.getRandomValues(new Uint8Array(12))` per export, and no
other source: the key is constant for a mnemonic while exports are many, so a
repeated 96-bit nonce would destroy both confidentiality and authenticity. The
IV is never derived from the date, the contents or the file name. `tagLength`
is 128 bits. A reader requires **exactly** 12 IV bytes, a ciphertext of at
least 16, and canonical base64 for both.

There is no parameter to inject an IV — tests that need the vector stub the
CSPRNG instead, which also makes the single 12-byte draw observable.

### 2.6 Size cap

**32 MiB (33 554 432 bytes), measured on both sides as the FINAL file size.**
Measuring the cap on the plaintext would let an export produce a near-cap file
roughly 1.33x larger — base64 plus the JSON wrapper — which its own import
would then refuse. Readers check `File.size` before reading the text. Stores
above the ceiling are not supported until a streaming container v2, and the UI
says so plainly.

### 2.7 File name

`eternal-notes-backup-YYYY-MM-DD-HHmm.json`, in the user's **local** time —
several exports on one day stay distinguishable, and the name matches the clock
the user just looked at.

### 2.8 Test vector

Mnemonic (BIP-39, the standard all-`abandon` vector):

```
abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
```

IV: bytes `01 02 03 04 05 06 07 08 09 0a 0b 0c` (base64 `AQIDBAUGBwgJCgsM`).
`createdAt`: `1756000000000`.

Canonical body, before encryption:

```
{"counts":{"notes":1,"safebox":1},"incompleteRestore":false,"notes":[{"ciphertext":"QUFBQQ==","createdAt":1756000000000,"iv":"AAAAAAAAAAAAAAAA","noteId":"11111111-2222-4333-8444-555555555555"}],"safebox":[{"createdAt":1756000000000,"entryId":"88888888-9999-8aaa-baaa-cccccccccccc","metaCiphertext":"QkJCQg==","metaIv":"AAAAAAAAAAAAAAAA","secretCiphertext":"Q0NDQw==","secretIv":"AAAAAAAAAAAAAAAA","v":4}]}
```

Additional data (the canonical header):

```
{"containsUnsupportedRecords":false,"createdAt":1756000000000,"format":"eternal-notes-backup","minReaderVersion":1,"v":1}
```

The complete file:

```
{"body":{"ciphertext":"JNsiCBJ4BSIexY24Y4b/iJ4yvPHrP5OAleKyB9Whav/jI8SzB9/2x90D50DyEekqxM3o5SUmoePUt7vR46k0JiU7HjKi2fIfyN+J7rCzPskPpDCrjOstJ/lnHmTGPiQmedRV4Ix/vUG28lHQQRNJv6LE5Dt7pQDtQHEEUbQVspOmXY6LfGkq8OS9gz3I0E4EynQXfWY5Jf6D2c12F5BYd0xff8ZpvSjHzK4jrsflb5dA2hX9zWIU6YvYApd1tzFkWD171pw9VpIU8kEa4fAUpb/Hwef6MHBCcM4UVk02aatA3NHW6rrsQzYmz6CraNKbmGJvtFKwiWIR6PG2IOtJJTuGZUGM5KjChHuRa9qNukazZPNI9QXcF6pGacAYzIl5HnOdv24mEZrx2fsUXpmJJXNjSugOylmbYQMq+pXbIrAspkIheW1gVn/vhbbvADksaswOB3aNULjB3MTH4c9eSq755V2TMYoBHEpKtC292bW6WpG2VZqa4GcT4SG21/RuCEvUgDggGI+y6e6q/V/4oWBnVEJa/KtB9Fr1ID4i5OrihZUq+A==","iv":"AQIDBAUGBwgJCgsM"},"containsUnsupportedRecords":false,"createdAt":1756000000000,"format":"eternal-notes-backup","minReaderVersion":1,"v":1}
```

Both halves of `src/lib/backup.test.ts` assert this artefact: that the encoder
reproduces the file byte for byte, that the decoder reads it back, and that
this document still carries the same strings.

## 3. `publicationEquivalent` (client)

Not a wire format, documented here because it is the client-side counterpart of
§1 and the two are easy to confuse.

`publicationEquivalent(a, b)` (`src/lib/publication-equivalent.ts`) answers
«would these two LOCAL records go on-chain as the same publication?» by
comparing the `(data, tags)` pair from the real upload builders with fixed
stubs for `ownerHash` and `now`. Backup import rule 2 uses it to tell a
redundant incoming record from a conflicting one; neither outcome writes
anything.

Differences from `fp`, both intentional:

- it compares **tags too**, not just `appVersion` and `data` — it runs on two
  locally-held records, where the full pair is available and free;
- it is **total**: an unsupported version or a malformed row is «not
  equivalent», never an exception. `fp` fails closed by throwing, because on
  the server a malformed input must stop the request, not be summarized.
