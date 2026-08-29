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

- §1 — the canonical publication fingerprint (`fp`).

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

## 2. `publicationEquivalent` (client)

Not a wire format, documented here because it is the client-side counterpart of
§1 and the two are easy to confuse.

> **Ships one release later than §1.** The server fingerprint of §1 is part of
> the worker release that introduces `semanticIdempotency`; the client function
> described here lands with the backup release. The section is specified here
> anyway, and deliberately: the two notions of «the same publication» have to
> be written down together or they drift, and the differences listed at the end
> of this section are the whole reason the second one exists.

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
