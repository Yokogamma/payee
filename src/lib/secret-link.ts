/**
 * «Секрет по ссылке» (P1): handle, fingerprint, URL grammar, index/coverage/
 * receipt records and the pure helpers the storage CAS-writer relies on.
 *
 * Everything in this module is pure or WebCrypto-only — no IndexedDB access.
 * It must not import `storage.ts` (storage imports it): the `pin-seed`
 * comparator is therefore taken as a parameter where it is needed.
 */

import { mnemonicToSeedSync } from '@scure/bip39';
import { assertValidPinBlob, base64ToBuffer, bufferToBase64, type PinEncryptedSeed } from './crypto';
import { byCurrentness, type ChainVersion } from './chains';
import { SECRET_LINK_ENABLED } from './flags';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  quickUnlockRecordEquals,
  type QuickUnlockRecord,
  type QuickUnlockVerdict,
} from './quick-unlock';

// ─── Key, handle, fingerprint (plan §1.1) ───────────────────────────

/** Fixed forever, like every other HKDF domain of this app: changing it
 *  changes every handle ever published. */
const SECRET_LINK_HKDF_SALT = 'eternal-notes-v1';
const SECRET_LINK_HKDF_INFO = 'secret-link-v1';

/** The root of a chain as `secretLinkHandle` accepts it: a UUID spelled in
 *  canonical lower case, 36 characters. The version nibble is NOT checked —
 *  the handle is a MAC over the exact string, and the §1.1 control vector
 *  depends on that. */
const ROOT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE_REGEX = /^[A-Za-z0-9_-]{22}$/;
const HANDLE_BYTES = 16;
/** ECMAScript Date range ceiling (±8.64e15 ms; we require non-negative). */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/**
 * `K_link` = HKDF-SHA-256(BIP-39 seed[0..32), salt 'eternal-notes-v1',
 * info 'secret-link-v1') → HMAC-SHA-256, exactly 256 bits, `sign` only,
 * non-extractable. Same seed handling as `deriveAesKey` (crypto.ts).
 */
export async function deriveSecretLinkKey(mnemonic: string): Promise<CryptoKey> {
  const seed = mnemonicToSeedSync(mnemonic);
  const ikm = seed.slice(0, 32);
  try {
    const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(SECRET_LINK_HKDF_SALT),
        info: new TextEncoder().encode(SECRET_LINK_HKDF_INFO),
      },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
  } finally {
    // Best effort only — JavaScript cannot promise the bytes are gone.
    seed.fill(0);
    ikm.fill(0);
  }
}

/** handle = base64url(HMAC-SHA-256(K_link, utf8(root))[0..16)), no padding —
 *  exactly 22 characters. Throws on a root that is not a canonical UUID. */
export async function secretLinkHandle(kLink: CryptoKey, root: string): Promise<string> {
  if (!ROOT_REGEX.test(root)) throw new Error('secret link: root is not a canonical UUID');
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', kLink, new TextEncoder().encode(root)));
  return bytesToBase64Url(mac.slice(0, HANDLE_BYTES));
}

function decodeHandle(handle: unknown): Uint8Array | null {
  if (typeof handle !== 'string' || !HANDLE_REGEX.test(handle)) return null;
  // `base64UrlToBytes` is the canonical-only decoder: re-encoding must give
  // back the same string, i.e. the four unused bits of char 22 are zero.
  const bytes = base64UrlToBytes(handle);
  return bytes && bytes.length === HANDLE_BYTES ? bytes : null;
}

/** `base64url-encode(base64url-decode(h)) === h`, 22 chars, 16 bytes. */
export function isCanonicalHandle(handle: unknown): handle is string {
  return decodeHandle(handle) !== null;
}

export interface SecretLinkFingerprint {
  hue1: number;
  hue2: number;
  tail: string;
}

/** THE normative fingerprint formula (both sides). Invalid handle → null. */
export function fingerprintOf(handle: string): SecretLinkFingerprint | null {
  const b = decodeHandle(handle);
  if (!b) return null;
  return {
    hue1: Math.round((b[0] * 360) / 256),
    hue2: Math.round((b[1] * 360) / 256),
    tail: handle.slice(0, 4),
  };
}

// ─── Addressing (plan §1.2) ─────────────────────────────────────────

export type SecretLinkRoute =
  | { kind: 'resolve'; handle: string; ordinal: number | null }
  | { kind: 'new'; from: 'drop' | null };

const RESOLVE_PATH_REGEX = /^#\/s\/([A-Za-z0-9_-]{22})(@([1-9][0-9]{0,8}))?$/;
const NEW_PATH = '#/s/new';
/** The ONLY query a hash may carry, and only on `new`. Compared verbatim: a
 *  repeated key, another key, an empty `?`, a trailing `&` or a percent-encoded
 *  spelling of the same pair are all refused. */
const DROP_QUERY = 'from=drop';

/**
 * Parse a FULL URL against the one §1.2 table. Anything that is not exactly
 * one of the four accepted shapes is `null` (the canonicalizer then sends it
 * to `#/notes`). With `SECRET_LINK_ENABLED` off every input is `null`.
 */
export function parseSecretLinkUrl(url: URL): SecretLinkRoute | null {
  if (!SECRET_LINK_ENABLED) return null;
  if (url.search !== '') return null;
  const hash = url.hash;
  const q = hash.indexOf('?');
  if (q !== -1 && hash.indexOf('?', q + 1) !== -1) return null;
  const hashPath = q === -1 ? hash : hash.slice(0, q);
  if (q !== -1) {
    if (hashPath !== NEW_PATH) return null;
    return hash.slice(q + 1) === DROP_QUERY ? { kind: 'new', from: 'drop' } : null;
  }
  if (hashPath === NEW_PATH) return { kind: 'new', from: null };
  const m = RESOLVE_PATH_REGEX.exec(hashPath);
  if (!m || !isCanonicalHandle(m[1])) return null;
  return { kind: 'resolve', handle: m[1], ordinal: m[3] === undefined ? null : Number(m[3]) };
}

/** `origin + base + '#/s/' + handle`. `originAndBase` is the app's own
 *  address (origin plus Vite's BASE_URL); it must not carry a query or a
 *  fragment, or the produced link would not parse. */
export function buildSecretLink(originAndBase: string, handle: string): string {
  if (!isCanonicalHandle(handle)) throw new Error('secret link: non-canonical handle');
  if (originAndBase.includes('#') || originAndBase.includes('?')) {
    throw new Error('secret link: base must not carry a query or fragment');
  }
  return `${originAndBase}#/s/${handle}`;
}

// ─── Stored blobs and their plaintexts (plan §1.3) ──────────────────

export const SECRET_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Stored shape of every encrypted `meta` value this feature owns
 *  (`secret-link:<handle>`, `secret-link-coverage`, `secret-op:…`). */
export interface IndexBlob {
  v: 1;
  iv: string;
  ct: string;
}

export function isIndexBlob(x: unknown): x is IndexBlob {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  return (
    keys.length === 3 &&
    Object.prototype.hasOwnProperty.call(o, 'v') &&
    Object.prototype.hasOwnProperty.call(o, 'iv') &&
    Object.prototype.hasOwnProperty.call(o, 'ct') &&
    o.v === 1 &&
    typeof o.iv === 'string' && o.iv.length > 0 &&
    typeof o.ct === 'string' && o.ct.length > 0
  );
}

/** One coverage row: `[entryId, metaIv]` of a processed safebox row. */
export type CoverageRow = [entryId: string, metaIv: string];

export interface IndexRecord {
  v: 1;
  root: string;
  /** From the AUTHENTICATED meta half (`id`/`rev`/`t`), never the outer row. */
  head: { id: string; rev: number; createdAt: number };
  indexedAt: number;
}

export interface CoverageRecord {
  v: 1;
  /** Sorted by `entryId` (code-unit order), unique. */
  rows: CoverageRow[];
}

export interface ReceiptRecord {
  v: 1;
  opOrigin: string;
  opId: string;
  handle: string;
  link: string;
  title: string;
  committedAt: number;
}

function isRecordObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function hasKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(o);
  return actual.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
}

function isTimestamp(t: unknown): t is number {
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIMESTAMP_MS;
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function isIndexRecord(x: unknown): x is IndexRecord {
  if (!isRecordObject(x) || !hasKeys(x, ['v', 'root', 'head', 'indexedAt'])) return false;
  if (x.v !== 1 || typeof x.root !== 'string' || !ROOT_REGEX.test(x.root)) return false;
  if (!isTimestamp(x.indexedAt)) return false;
  const h = x.head;
  if (!isRecordObject(h) || !hasKeys(h, ['id', 'rev', 'createdAt'])) return false;
  return isNonEmptyString(h.id)
    && typeof h.rev === 'number' && Number.isSafeInteger(h.rev) && h.rev >= 1
    && isTimestamp(h.createdAt);
}

function isCoverageRow(r: unknown): r is CoverageRow {
  return Array.isArray(r)
    && Object.getPrototypeOf(r) === Array.prototype
    && r.length === 2
    && Object.keys(r).length === 2 // no holes, no extra props
    && isNonEmptyString(r[0])
    && isNonEmptyString(r[1]);
}

/** Rows strictly ascending by `entryId` — sorted AND unique in one check. */
export function isCoverageRecord(x: unknown): x is CoverageRecord {
  if (!isRecordObject(x) || !hasKeys(x, ['v', 'rows'])) return false;
  if (x.v !== 1 || !Array.isArray(x.rows) || Object.getPrototypeOf(x.rows) !== Array.prototype) return false;
  const rows = x.rows as unknown[];
  if (Object.keys(rows).some(k => !INDEX_KEY_REGEX.test(k))) return false; // extra props
  for (let i = 0; i < rows.length; i++) {
    if (!(i in rows)) return false; // hole
    const r = rows[i];
    if (!isCoverageRow(r)) return false;
    if (i > 0 && !((rows[i - 1] as CoverageRow)[0] < r[0])) return false;
  }
  return true;
}

function isOrigin(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false;
  try {
    return new URL(s).origin === s;
  } catch {
    return false;
  }
}

export function isReceiptRecord(x: unknown): x is ReceiptRecord {
  if (!isRecordObject(x)) return false;
  if (!hasKeys(x, ['v', 'opOrigin', 'opId', 'handle', 'link', 'title', 'committedAt'])) return false;
  return x.v === 1
    && isOrigin(x.opOrigin)
    && typeof x.opId === 'string' && UUID_V4_REGEX.test(x.opId)
    && isCanonicalHandle(x.handle)
    && isNonEmptyString(x.link)
    && typeof x.title === 'string' && codePointLength(x.title) <= DROP_TITLE_MAX
    && isTimestamp(x.committedAt);
}

// ─── `secret-drop v1` (plan §1.4) ───────────────────────────────────

export const DROP_ERROR_CODES = [
  'cancelled', 'disabled', 'locked', 'no-safebox', 'storage',
  'too-large', 'invalid', 'busy', 'unknown', 'expired',
] as const;
export type DropErrorCode = typeof DROP_ERROR_CODES[number];

export type DropMessage =
  | { t: 'matamata.drop.ready'; v: 1 }
  | { t: 'matamata.drop.secret'; v: 1; opId: string; title: string; value: string }
  | { t: 'matamata.drop.lookup'; v: 1; opId: string }
  | { t: 'matamata.drop.result'; v: 1; opId: string; link: string; title: string }
  | { t: 'matamata.drop.error'; v: 1; opId?: string; code: DropErrorCode };

function isOpId(s: unknown): s is string {
  return typeof s === 'string' && UUID_V4_REGEX.test(s);
}

/** Schema + version + exact key set. Origin/source checks and the
 *  `validateDropInput` bounds are the receiver's separate steps. */
export function isDropMessage(x: unknown): x is DropMessage {
  if (!isRecordObject(x) || x.v !== 1) return false;
  switch (x.t) {
    case 'matamata.drop.ready':
      return hasKeys(x, ['t', 'v']);
    case 'matamata.drop.secret':
      return hasKeys(x, ['t', 'v', 'opId', 'title', 'value'])
        && isOpId(x.opId) && typeof x.title === 'string' && typeof x.value === 'string';
    case 'matamata.drop.lookup':
      return hasKeys(x, ['t', 'v', 'opId']) && isOpId(x.opId);
    case 'matamata.drop.result':
      return hasKeys(x, ['t', 'v', 'opId', 'link', 'title'])
        && isOpId(x.opId) && isNonEmptyString(x.link) && typeof x.title === 'string';
    case 'matamata.drop.error': {
      const withOp = Object.prototype.hasOwnProperty.call(x, 'opId');
      if (!hasKeys(x, withOp ? ['t', 'v', 'opId', 'code'] : ['t', 'v', 'code'])) return false;
      if (withOp && !isOpId(x.opId)) return false;
      return typeof x.code === 'string' && (DROP_ERROR_CODES as readonly string[]).includes(x.code);
    }
    default:
      return false;
  }
}

export const DROP_TITLE_MAX = 200;
export const DROP_VALUE_MAX = 64_000;
export const DROP_DEFAULT_TITLE = 'Секрет без названия';

export type DropInputResult =
  | { ok: true; title: string; value: string }
  | { ok: false; reason: 'title' | 'value' };

/**
 * THE one runtime validation for the protocol, the form and the direct
 * action. `title` is trimmed (0…200 code points, empty → the default);
 * `value` is NOT trimmed and is kept byte for byte (1…64 000 code points).
 */
export function validateDropInput(input: { title: unknown; value: unknown }): DropInputResult {
  if (typeof input.title !== 'string') return { ok: false, reason: 'title' };
  if (typeof input.value !== 'string') return { ok: false, reason: 'value' };
  const title = input.title.trim();
  if (codePointLength(title) > DROP_TITLE_MAX) return { ok: false, reason: 'title' };
  const n = codePointLength(input.value);
  if (n < 1 || n > DROP_VALUE_MAX) return { ok: false, reason: 'value' };
  return { ok: true, title: title === '' ? DROP_DEFAULT_TITLE : title, value: input.value };
}

// ─── Blob encryption (AES-GCM under the safebox metaKey) ────────────

/** JSON plaintext → `{v:1, iv, ct}` under `metaKey`, fresh 96-bit IV. */
export async function encryptIndexBlob(
  metaKey: CryptoKey,
  plain: IndexRecord | CoverageRecord | ReceiptRecord,
): Promise<IndexBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    metaKey,
    new TextEncoder().encode(JSON.stringify(plain)),
  );
  return { v: 1, iv: bufferToBase64(iv), ct: bufferToBase64(ct) };
}

/** Decrypt + JSON-parse. Throws on a wrong key, tampering or bad JSON; the
 *  result is UNVALIDATED — run it through the role's validator
 *  (`classifyKey` does). */
export async function decryptIndexBlob(metaKey: CryptoKey, blob: IndexBlob): Promise<unknown> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(blob.iv) as BufferSource },
    metaKey,
    base64ToBuffer(blob.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Decryption result handed to `classifyKey`, so the classifier stays pure. */
export type DecryptOutcome = { ok: true; plain: unknown } | { ok: false };

/** Never throws: anything that is not a decryptable `IndexBlob` → `{ok:false}`. */
export async function tryDecryptIndexBlob(metaKey: CryptoKey, raw: unknown): Promise<DecryptOutcome> {
  if (!isIndexBlob(raw)) return { ok: false };
  try {
    return { ok: true, plain: await decryptIndexBlob(metaKey, raw) };
  } catch {
    return { ok: false };
  }
}

// ─── Key classification (plan §1.3 table) ───────────────────────────

export type KeyRole = 'index' | 'coverage' | 'receipt';
export type KeyClass = 'absent' | 'live' | 'expired' | 'malformed';

/** A key as read from the raw snapshot. Presence is separate from the value:
 *  a key stored with the value `undefined` is PRESENT (and malformed). */
export type KeySlot = { present: false } | { present: true; raw: unknown };

type RecordFor<R extends KeyRole> =
  R extends 'index' ? IndexRecord : R extends 'coverage' ? CoverageRecord : ReceiptRecord;

export type KeyClassification<R extends KeyRole> =
  | { kind: 'absent' }
  | { kind: 'live'; ct: string; record: RecordFor<R> }
  | { kind: 'expired'; ct: string; record: ReceiptRecord }
  | { kind: 'malformed' };

/**
 * Pure classification of one snapshot key. `decrypted` is the result of
 * decrypting `slot.raw` (see `tryDecryptIndexBlob`); a present key without it
 * is `malformed`. `expired` exists only for receipts
 * (`committedAt + 24 h <= now`). WHAT the writer does with `malformed` depends
 * on the role and the writer (plan §1.3) — that is the caller's decision.
 *
 * Handle ↔ root binding (`handle === HMAC(K_link, rec.root)`) needs a key and
 * is NOT checked here.
 */
export function classifyKey<R extends KeyRole>(
  slot: KeySlot,
  role: R,
  now: number,
  decrypted?: DecryptOutcome,
): KeyClassification<R> {
  if (!slot.present) return { kind: 'absent' };
  if (!isIndexBlob(slot.raw) || !decrypted || !decrypted.ok) return { kind: 'malformed' };
  const ct = slot.raw.ct;
  const plain = decrypted.plain;
  if (role === 'index') {
    return isIndexRecord(plain) ? { kind: 'live', ct, record: plain as RecordFor<R> } : { kind: 'malformed' };
  }
  if (role === 'coverage') {
    return isCoverageRecord(plain) ? { kind: 'live', ct, record: plain as RecordFor<R> } : { kind: 'malformed' };
  }
  if (!isReceiptRecord(plain)) return { kind: 'malformed' };
  return plain.committedAt + SECRET_RECEIPT_TTL_MS > now
    ? { kind: 'live', ct, record: plain as RecordFor<R> }
    : { kind: 'expired', ct, record: plain };
}

// ─── Head, coverage delta ───────────────────────────────────────────

/** The current version by `byCurrentness` (chains.ts) — the same rule the
 *  feed uses, so the index can never disagree with the UI. Empty → null. */
export function chooseHead<T extends ChainVersion>(versions: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (best === null || byCurrentness(v, best) < 0) best = v;
  }
  return best;
}

/** An index record's head as a `ChainVersion`, for `chooseHead`. */
export function indexHeadVersion(rec: IndexRecord): ChainVersion {
  return { id: rec.head.id, rev: rec.head.rev, createdAt: rec.head.createdAt, root: rec.root };
}

/** `delta = rows ∖ covRows`, `missing = covRows ∖ rows`, comparing the
 *  `[entryId, metaIv]` PAIR as strings: the same id with another payload is
 *  in both. Order of the input preserved. */
export function coverageDelta(
  rows: readonly CoverageRow[],
  covRows: readonly CoverageRow[],
): { delta: CoverageRow[]; missing: CoverageRow[] } {
  const pairKey = (r: CoverageRow) => JSON.stringify([r[0], r[1]]);
  const inRows = new Set(rows.map(pairKey));
  const inCov = new Set(covRows.map(pairKey));
  return {
    delta: rows.filter(r => !inCov.has(pairKey(r))),
    missing: covRows.filter(r => !inRows.has(pairKey(r))),
  };
}

// ─── Authorization snapshot and issue confirmation (§1.3, §1.5) ─────

export type AuthSnapshot =
  | {
      factor: 'pin';
      pinSeed: PinEncryptedSeed;
      enabled: true;
      origins: string[];
      configId: string;
      lockGeneration: number;
    }
  | {
      factor: 'prf';
      prfRecord: QuickUnlockRecord;
      pinPresent: true;
      enabled: true;
      origins: string[];
      configId: string;
      lockGeneration: number;
    };

/**
 * The authorization-relevant state as stored right now — what ONE readonly
 * (`readIssueSnapshot`) or readwrite (the light commit) transaction reads
 * back, raw where the comparison is raw, validated where a validator exists.
 * Nothing is reconstructed from the expected side. This is the ONE shape both
 * sides of §1.5 compare (storage.ts re-exports it as `CurrentAuthState`).
 */
export interface CurrentAuth {
  pinSeed: unknown;
  /** `judgeQuickUnlock(raw, pinSeed, vaultPublicKey)` of the stored record. */
  quickUnlock: QuickUnlockVerdict;
  enabled: unknown;
  origins: unknown;
  /** `null` = the safebox PIN config is absent OR malformed (fail-closed). */
  configId: string | null;
  /** Raw `vault-lock-generation` (undefined = never bumped). */
  lockGeneration: unknown;
}

export type PinSeedEquals = (a: unknown, b: unknown) => boolean;

/** §1.5 rule for the counter, the same on every side: an ABSENT counter is 0;
 *  anything else is compared raw, so a damaged one never matches. */
export function lockGenerationMatches(raw: unknown, expected: number): boolean {
  return (raw === undefined ? 0 : raw) === expected;
}

function originsEqual(current: unknown, expected: unknown): boolean {
  if (!Array.isArray(current) || !Array.isArray(expected) || current.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (!(i in current) || typeof current[i] !== 'string' || current[i] !== expected[i]) return false;
  }
  return true;
}

/** «pin-seed present» for the PRF branch: a stored blob the PIN path itself
 *  would accept — a damaged one counts as absent. Synchronous, no crypto. */
function pinSeedUsable(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  try {
    assertValidPinBlob(v as PinEncryptedSeed);
    return true;
  } catch {
    return false;
  }
}

/**
 * §1.5 comparison, pure and synchronous (safe inside a transaction) — the ONE
 * rule for the readonly check (phase 3) and the light commit alike. Pass
 * `pinSeedEquals` from storage.ts — it cannot be imported here without a
 * cycle. A missing or damaged current field never matches.
 */
export function authSnapshotEquals(current: CurrentAuth, auth: AuthSnapshot, pinSeedEq: PinSeedEquals): boolean {
  if (current.enabled !== true || auth.enabled !== true) return false;
  if (!originsEqual(current.origins, auth.origins)) return false;
  if (current.configId === null || current.configId !== auth.configId) return false;
  if (!lockGenerationMatches(current.lockGeneration, auth.lockGeneration)) return false;
  if (auth.factor === 'pin') return pinSeedEq(current.pinSeed, auth.pinSeed);
  if (auth.factor === 'prf') {
    return auth.pinPresent === true
      && pinSeedUsable(current.pinSeed)
      && current.quickUnlock.kind === 'valid'
      && quickUnlockRecordEquals(current.quickUnlock.record, auth.prfRecord);
  }
  return false;
}

/** Stored by the resolver operation after phase 2. */
export interface IssueSnapshot {
  recCt: string;
  covCt: string;
  headMetaIv: string;
  rows: CoverageRow[];
  auth: AuthSnapshot;
}

/** What `readIssueSnapshot()` (storage.ts) returns for phase 3, all from ONE
 *  transaction — passed to `issueSnapshotEquals` as is. */
export interface IssueSnapshotRead {
  /** `ct` of the stored record / coverage; `null` = absent or not an IndexBlob. */
  recCt: string | null;
  covCt: string | null;
  /** `null` = the head row is gone or damaged. */
  headMetaIv: string | null;
  rows: CoverageRow[];
  currentAuth: CurrentAuth;
}

function rowsEqual(a: readonly CoverageRow[], b: readonly CoverageRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

/**
 * Phase-3 freshness check (plan §1.3). `currentAuth` must equal BOTH the
 * authorization captured in the issue snapshot and the operation's `auth`
 * (they are the same object in a correct caller; two copies that disagree are
 * a refusal, not a choice). `op.stillValid()` is the caller's next step.
 */
export function issueSnapshotEquals(
  read: IssueSnapshotRead,
  expected: IssueSnapshot,
  auth: AuthSnapshot,
  pinSeedEq: PinSeedEquals,
): boolean {
  return read.recCt !== null && read.recCt === expected.recCt
    && read.covCt !== null && read.covCt === expected.covCt
    && read.headMetaIv !== null && read.headMetaIv === expected.headMetaIv
    && rowsEqual(read.rows, expected.rows)
    && authSnapshotEquals(read.currentAuth, expected.auth, pinSeedEq)
    && authSnapshotEquals(read.currentAuth, auth, pinSeedEq);
}

// ─── rawEquals (plan §1.3, 5-M3) ────────────────────────────────────

/** The value domain `rawEquals` understands (plan §1.3, 5-M3). */
export type RawComparable =
  | null
  | undefined
  | boolean
  | number
  | string
  | RawComparable[]
  | { [k: string]: RawComparable };

function isPlainObject(x: object): boolean {
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const INDEX_KEY_REGEX = /^(0|[1-9][0-9]*)$/;

/**
 * Exact typed structural equality, FAIL-CLOSED outside `RawComparable`:
 * Date, Map, Set, ArrayBuffer, typed arrays, boxed primitives, array
 * subclasses, BigInt, symbols, functions, symbol-keyed props and cycles all
 * make the comparison false. A key holding `undefined` differs from an absent
 * key; an array hole differs from an explicit `undefined`; `NaN` equals `NaN`
 * and `0` differs from `-0` (`Object.is`). Synchronous, no WebCrypto — safe
 * inside an IndexedDB transaction.
 */
export function rawEquals(a: unknown, b: unknown): boolean {
  const stackA: object[] = [];
  const stackB: object[] = [];
  const eq = (x: unknown, y: unknown): boolean => {
    if (x === null || x === undefined || typeof x === 'boolean' || typeof x === 'string') {
      return x === y;
    }
    if (typeof x === 'number') return typeof y === 'number' && Object.is(x, y);
    if (typeof x !== 'object' || typeof y !== 'object' || y === null) return false;
    if (stackA.includes(x) || stackB.includes(y)) return false; // cycle → fail-closed
    if (Object.getOwnPropertySymbols(x).length > 0 || Object.getOwnPropertySymbols(y).length > 0) {
      return false;
    }
    const xArr = Array.isArray(x);
    if (xArr !== Array.isArray(y)) return false;
    if (xArr) {
      if (Object.getPrototypeOf(x) !== Array.prototype || Object.getPrototypeOf(y) !== Array.prototype) {
        return false;
      }
    } else if (!isPlainObject(x) || !isPlainObject(y)) {
      return false;
    }
    stackA.push(x);
    stackB.push(y);
    try {
      if (xArr) {
        const xa = x as unknown[];
        const ya = y as unknown[];
        if (xa.length !== ya.length) return false;
        // Non-index own props are outside the domain.
        if (Object.keys(xa).some(k => !INDEX_KEY_REGEX.test(k))) return false;
        if (Object.keys(ya).some(k => !INDEX_KEY_REGEX.test(k))) return false;
        for (let i = 0; i < xa.length; i++) {
          const hx = i in xa;
          if (hx !== i in ya) return false;
          if (hx && !eq(xa[i], ya[i])) return false;
        }
        return true;
      }
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      const xk = Object.keys(xo);
      if (xk.length !== Object.keys(yo).length) return false;
      for (const k of xk) {
        if (!Object.prototype.hasOwnProperty.call(yo, k)) return false;
        if (!eq(xo[k], yo[k])) return false;
      }
      return true;
    } finally {
      stackA.pop();
      stackB.pop();
    }
  };
  return eq(a, b);
}
