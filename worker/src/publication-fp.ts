/**
 * Canonical publication fingerprint (`fp`).
 *
 * `fp` is the SERVER-side notion of «these bytes are the same publication»:
 * the per-`noteId` idempotency in the Durable Object must be able to tell
 * «the same record, sent again» from «a different record under a reused id»,
 * and the second case is a typed conflict rather than a silent replay of a
 * historical txId.
 *
 * Normative definition and the shared byte vector: `docs/BACKUP_FORMAT_V1.md`.
 * The client ships NO production implementation — a test-only mirror lives in
 * `src/lib/publication-fp.fixture.ts` and is checked against the same vector,
 * so the two halves cannot drift without a red suite on both sides.
 *
 * What is covered: the IMMUTABLE part of a publication — the `App-Version` tag
 * value and the outer `data` string. What is deliberately excluded: the
 * transport fields (`timestamp`, `recheck`, `recovery`), which legitimately
 * differ between two attempts at publishing the very same record.
 *
 * The relation «the remaining tags are derivable from `data`» is NOT treated as
 * an implicit guarantee: `appVersion` is bound EXPLICITLY, because it is what
 * selects the serialization (v1 carries `t` and a Timestamp tag, v2/v3 do not,
 * v4 is a split envelope) and a version confusion is exactly the failure this
 * fingerprint has to catch.
 */

/** Domain separator. Part of the format — changing it invalidates every stored
 *  `fp`, so it moves only together with a new fingerprint version. */
export const PUBLICATION_FP_DOMAIN = 'eternal-notes/publication-fp/v1\n';

/**
 * Canonical JSON for a flat string→string record: keys sorted, no whitespace,
 * standard JSON string escaping. Written out explicitly instead of relying on
 * `JSON.stringify` insertion order — property order is an implementation
 * detail of the call site, and the fingerprint must not depend on it.
 */
function canonicalStringRecord(record: Record<string, string>): string {
  const keys = Object.keys(record).sort(); // ASCII keys → code-unit order == code-point order
  return `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(',')}}`;
}

/**
 * The exact byte string that gets hashed. Exported so the vector in
 * `docs/BACKUP_FORMAT_V1.md` can be asserted at the byte level, not only
 * through its digest.
 *
 * Fail-closed on non-strings: a `number` App-Version or an object `data` would
 * otherwise be coerced by `JSON.stringify` into something that hashes fine and
 * means nothing.
 */
export function publicationFpInput(appVersion: string, data: string): string {
  if (typeof appVersion !== 'string' || typeof data !== 'string') {
    throw new TypeError('publicationFpInput: appVersion and data must be strings');
  }
  return PUBLICATION_FP_DOMAIN + canonicalStringRecord({ appVersion, data });
}

/**
 * Strict UTF-8 decode for a publication body fetched from a gateway.
 *
 * `fp` is defined over STRINGS, but a fetched publication is BYTES — and the
 * conversion is where a fingerprint can silently lose its meaning. A lossy
 * decode maps every invalid sequence onto U+FFFD, so two different byte
 * sequences would produce one string and therefore one `fp`: exactly the
 * collision the fingerprint exists to prevent. `fatal: true` makes that case an
 * exception instead, and the caller must translate it into «publication not
 * proven» (503) — never into an `observedFp` write.
 *
 * `ignoreBOM: true` keeps a leading U+FEFF as a character instead of stripping
 * it: normalizing bytes away here would let a body that differs from what the
 * client sent still fingerprint as equal.
 */
export function decodePublicationData(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** SHA-256 of `publicationFpInput`, lowercase hex (64 chars). */
export async function computePublicationFp(appVersion: string, data: string): Promise<string> {
  const bytes = new TextEncoder().encode(publicationFpInput(appVersion, data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
