/**
 * D9 — cryptographic `txId ↔ bytes` verification, WebCrypto only.
 *
 * Without this, a pool of payload gateways makes the integrity position
 * STRICTLY WORSE than a single one: today the client checks the JSON shape,
 * `inner-id === Note-Id` and AES-GCM, but never that the bytes belong to the
 * txId it asked for. Any one of N gateways could return a GENUINE but OLDER
 * version of the same note — same Note-Id, so inner-id matches and AES-GCM
 * passes — and the set of parties able to do that grows from 1 to N.
 *
 * No arweave-js in the bundle: `MAX_BODY_BYTES = 51200` guarantees the data is
 * always smaller than one Arweave chunk (256 KiB), so `data_root` is a couple
 * of SHA-256 calls rather than a merkle library.
 *
 * Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-3a «Верификация D9».
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Hard ceiling on a `/tx/<id>` header. The real one measures ~2 KB (owner and
 *  signature are 683 base64url chars each), so this is generous by 30×. */
export const HEADER_CAP_BYTES = 65536;

/** One Arweave chunk. Data at or below this is a single-leaf merkle tree, which
 *  is what `dataRoot` below assumes — and what MAX_BODY_BYTES guarantees. */
const MAX_CHUNK_BYTES = 262144;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const DIGITS_RE = /^\d{1,20}$/;
/** An Arweave txId is base64url of a 32-byte hash → exactly 43 chars. */
export const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

export function b64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digest(algorithm: string, parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const part of parts) total += part.length;
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { buffer.set(part, offset); offset += part.length; }
  return new Uint8Array(await crypto.subtle.digest(algorithm, buffer as BufferSource));
}
const sha256 = (...parts: Uint8Array[]) => digest('SHA-256', parts);
const sha384 = (...parts: Uint8Array[]) => digest('SHA-384', parts);

type DeepHashChunk = Uint8Array | DeepHashChunk[];

/** Arweave's deepHash (arweave-js `lib/deepHash.ts`), verified byte-for-byte
 *  against `Transaction.getSignatureData()` and against a real project TX. */
async function deepHash(data: DeepHashChunk): Promise<Uint8Array> {
  if (Array.isArray(data)) {
    let acc = await sha384(encoder.encode(`list${data.length}`));
    for (const chunk of data) acc = await sha384(acc, await deepHash(chunk));
    return acc;
  }
  return sha384(await sha384(encoder.encode(`blob${data.length}`)), await sha384(data));
}

/** merkle.ts `intToBuffer`: 32-byte big-endian note. */
function noteBuffer(value: number): Uint8Array {
  const out = new Uint8Array(32);
  let n = value;
  for (let i = 31; i >= 0; i--) { out[i] = n % 256; n = (n - out[i]) / 256; }
  return out;
}

/**
 * `data_root` for data that fits in ONE chunk: the tree is a single leaf, whose
 * id is `SHA256(SHA256(dataHash) || SHA256(note(maxByteRange)))` — the exact
 * leaf formula from arweave-js `merkle.ts`, pinned by a test against a real
 * transaction of this project.
 */
async function dataRoot(bytes: Uint8Array): Promise<Uint8Array> {
  const dataHash = await sha256(bytes);
  return sha256(await sha256(dataHash), await sha256(noteBuffer(bytes.length)));
}

/** `address = base64url(SHA-256(base64url-decode(owner)))` — the modulus hash,
 *  which is what an Arweave wallet address IS. Both sides of the comparison are
 *  normalized base64url without padding. */
export async function ownerToAddress(ownerB64url: string): Promise<string> {
  return bytesToB64url(await sha256(b64urlToBytes(ownerB64url)));
}

export interface TxHeader {
  format: number;
  id: string;
  owner: string;
  target: string;
  quantity: string;
  reward: string;
  last_tx: string;
  tags: { name: string; value: string }[];
  data_size: string;
  data_root: string;
  signature: string;
}

/**
 * Runtime schema + hard size ceiling. A header that is oversized, malformed, or
 * not `format: 2` is a GATEWAY refusal — the project's writer has never created
 * a format-1 transaction, so this is fail-closed, not data loss.
 */
export function parseTxHeader(text: string): TxHeader | null {
  if (text.length > HEADER_CAP_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const h = parsed as Record<string, unknown>;
  if (h.format !== 2) return null;
  for (const field of ['id', 'owner', 'quantity', 'reward', 'data_size', 'data_root', 'signature'] as const) {
    if (typeof h[field] !== 'string' || h[field] === '') return null;
  }
  // `target` and `last_tx` are legitimately EMPTY on our transactions, so they
  // are checked for type only — an empty string decodes to zero bytes, which is
  // exactly what the signature covers.
  if (typeof h.target !== 'string' || typeof h.last_tx !== 'string') return null;
  for (const field of ['id', 'owner', 'data_root', 'signature'] as const) {
    if (!B64URL_RE.test(h[field] as string)) return null;
  }
  if (h.target !== '' && !B64URL_RE.test(h.target)) return null;
  if (h.last_tx !== '' && !B64URL_RE.test(h.last_tx)) return null;
  if (!DIGITS_RE.test(h.data_size as string)) return null;
  if (!DIGITS_RE.test(h.quantity as string) || !DIGITS_RE.test(h.reward as string)) return null;
  if (!Array.isArray(h.tags)) return null;
  const tags: { name: string; value: string }[] = [];
  for (const tag of h.tags) {
    if (typeof tag !== 'object' || tag === null) return null;
    const t = tag as { name?: unknown; value?: unknown };
    if (typeof t.name !== 'string' || typeof t.value !== 'string') return null;
    if (!B64URL_RE.test(t.name) || !B64URL_RE.test(t.value)) return null;
    tags.push({ name: t.name, value: t.value });
  }
  return { ...(h as unknown as TxHeader), tags };
}

/**
 * Why a header can be rejected, and what the caller must do about it.
 *
 * `gateway` — this gateway is wrong or broken; TRY THE NEXT ONE and count a
 * mismatch. `skip` — the transaction is cryptographically sound but is not ours
 * (untrusted wallet, foreign tags); every honest gateway would return the same
 * bytes, so continuing the pool is pure waste and marking the sweep INCOMPLETE
 * would be a lie. That distinction is the difference between "a gateway lied"
 * and "this candidate was never ours".
 */
export type Rejection = { kind: 'gateway'; reason: string } | { kind: 'skip'; reason: string };

const gateway = (reason: string): Rejection => ({ kind: 'gateway', reason });
const skip = (reason: string): Rejection => ({ kind: 'skip', reason });

/**
 * Header-only steps of the D9 protocol. Everything that does NOT need the body
 * lives here so a bad header advances the pool instead of poisoning the whole
 * candidate: a gateway that answers a request for X with a self-consistent
 * header for Y must not stop the search at Y.
 *
 * In order, fail-closed at each step:
 *   1. `expectedTxId` is a canonical 43-char base64url id (no network wasted);
 *   2. `header.id === expectedTxId`     ← binds the header to what we ASKED FOR;
 *   3. `header.id === b64url(SHA-256(signature))`  ← self-consistency;
 *   4. RSA-PSS signature over the format-2 deep hash;
 *   5. `address(owner) ∈ trustedOwners`.
 *
 * Steps 2 and 3 are BOTH required: step 3 alone proves only that the header is
 * internally consistent, so a genuine older version of the same note would sail
 * through — which is precisely the silent downgrade D9 exists to stop.
 */
export async function verifyHeader(
  expectedTxId: string,
  header: TxHeader,
  trustedOwners: readonly string[],
): Promise<Rejection | null> {
  if (!TXID_RE.test(expectedTxId)) return skip('txId is not a canonical 43-char base64url id');
  if (header.id !== expectedTxId) return gateway('header.id does not match the requested txId');
  if (bytesToB64url(await sha256(b64urlToBytes(header.signature))) !== header.id) {
    return gateway('header.id is not the hash of its own signature');
  }

  const signatureData = await deepHash([
    encoder.encode(String(header.format)),
    b64urlToBytes(header.owner),
    b64urlToBytes(header.target),
    encoder.encode(header.quantity),
    encoder.encode(header.reward),
    b64urlToBytes(header.last_tx),
    header.tags.map(t => [b64urlToBytes(t.name), b64urlToBytes(t.value)]),
    encoder.encode(header.data_size),
    b64urlToBytes(header.data_root),
  ]);

  if (!(await verifySignature(header.owner, header.signature, signatureData))) {
    return gateway('RSA-PSS signature does not verify over the format-2 deep hash');
  }

  // THIS is the step that closes F1. Steps 2–4 prove the transaction is
  // self-consistent and authored by the wallet it NAMES; only this one proves
  // that wallet is trusted. Without it, a transaction correctly signed by an
  // attacker's own wallet passes the entire id/signature/data_root chain.
  const address = await ownerToAddress(header.owner);
  if (!trustedOwners.includes(address)) return skip('owner is not in TRUSTED_OWNERS');

  return null;
}

/**
 * RSA-PSS over SHA-256, accepting the salt lengths the Arweave client itself
 * accepts: 0, 32, and the maximum for the key.
 *
 * Measured, not assumed: every transaction of this project verifies at salt 32
 * (the Worker signs through arweave-js's WebCrypto driver, which hardcodes 32),
 * while arweave-js in NODE signs with the MAXIMUM salt. Accepting only 32 would
 * therefore be stricter than the Arweave network — whose verifier ORs the same
 * three lengths — and would make any transaction ever signed from a Node context
 * permanently unrestorable. Salt length is not a trust boundary: the signature
 * is still RSA-PSS over the same deep hash by the same key, and trust comes from
 * the owner check above.
 */
async function verifySignature(
  ownerB64url: string,
  signatureB64url: string,
  signatureData: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: ownerB64url, e: 'AQAB', alg: 'PS256', ext: true },
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return false; // unusable modulus — not our problem to repair
  }
  const signature = b64urlToBytes(signatureB64url);
  const modulusLength = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  // Derived from the KEY, not from the signature length: the formula is the
  // PKCS#1 v2.1 maximum, exactly as arweave-js computes it.
  const maxSalt = Math.ceil((modulusLength - 1) / 8) - 32 - 2;
  for (const saltLength of [32, 0, maxSalt]) {
    if (saltLength < 0) continue;
    try {
      const ok = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength },
        key,
        signature as BufferSource,
        signatureData as BufferSource,
      );
      if (ok) return true;
    } catch {
      // A salt length this key cannot represent throws; try the next one.
    }
  }
  return false;
}

/**
 * Body-dependent steps: `data_size` and `data_root`. A failure here is always a
 * GATEWAY failure — the header was already proven to belong to this txId and to
 * a trusted wallet, so bytes that do not match it came from the transport.
 */
export async function verifyBytes(header: TxHeader, bytes: Uint8Array): Promise<Rejection | null> {
  if (header.data_size !== String(bytes.length)) return gateway('data_size does not match the body length');
  if (bytes.length > MAX_CHUNK_BYTES) return gateway('body exceeds one Arweave chunk (multi-chunk unsupported)');
  if (bytesToB64url(await dataRoot(bytes)) !== header.data_root) {
    return gateway('recomputed data_root does not match the header');
  }
  return null;
}

/** The attribution carried by the VERIFIED tags of a verified header. */
export interface VerifiedTags {
  noteId: string;
  version: string;
  /** Present only for App-Version=1, where the writer emits it. */
  timestamp?: string;
}

export interface TagExpectations {
  appName: string;
  supportedVersions: ReadonlySet<string>;
  /** The Owner-Hash the caller asked the index for. */
  ownerHash: string;
}

/**
 * Read attribution from the SIGNED tags, mirroring the writer's canon exactly
 * (`worker/src/index.ts` upload validation): App-Name, App-Version,
 * Content-Type, Owner-Hash, Note-Id — plus Timestamp for v1 ONLY. The arity is
 * checked, extra tags are forbidden, and duplicates are rejected rather than
 * resolved to the first match.
 *
 * After D9 the GraphQL edge is demoted to DISCOVERY: it may narrow the work
 * (prefilter, sentinels) but never decide attribution, because the signature
 * covers these tags and nothing covers the edge.
 *
 * Every rejection here is a `skip`: a transaction that is cryptographically
 * sound but carries someone else's tags is not ours, and no other gateway will
 * say otherwise.
 */
export function readVerifiedTags(
  header: TxHeader,
  expected: TagExpectations,
): VerifiedTags | Rejection {
  const tags = new Map<string, string>();
  for (const tag of header.tags) {
    let name: string;
    let value: string;
    try {
      name = decoder.decode(b64urlToBytes(tag.name));
      value = decoder.decode(b64urlToBytes(tag.value));
    } catch {
      return skip('tag is not decodable');
    }
    if (tags.has(name)) return skip(`duplicate tag: ${name}`);
    tags.set(name, value);
  }

  const version = tags.get('App-Version');
  if (version === undefined || !expected.supportedVersions.has(version)) {
    return skip('missing or unsupported App-Version');
  }
  // v1 is the only version whose writer emits Timestamp; every other version
  // carrying it is rejected, exactly as the upload path rejects it.
  const expectedNames = version === '1'
    ? ['App-Name', 'App-Version', 'Content-Type', 'Owner-Hash', 'Note-Id', 'Timestamp']
    : ['App-Name', 'App-Version', 'Content-Type', 'Owner-Hash', 'Note-Id'];
  if (tags.size !== expectedNames.length) return skip('unexpected tag count');
  for (const name of expectedNames) {
    if (!tags.has(name)) return skip(`missing tag: ${name}`);
  }
  if (tags.get('App-Name') !== expected.appName) return skip('foreign App-Name');
  if (tags.get('Content-Type') !== 'application/json') return skip('unexpected Content-Type');
  if (tags.get('Owner-Hash') !== expected.ownerHash) return skip('Owner-Hash belongs to another vault');

  const noteId = tags.get('Note-Id');
  if (noteId === undefined || noteId === '') return skip('missing Note-Id');

  const result: VerifiedTags = { noteId, version };
  if (version === '1') result.timestamp = tags.get('Timestamp');
  return result;
}

/** Narrowing helper — a `Rejection` is never a valid `VerifiedTags`. */
export function isRejection(value: VerifiedTags | Rejection): value is Rejection {
  return 'kind' in value;
}
