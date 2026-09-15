/**
 * Eternal Notes — backup container v1.
 *
 * The container is a single AES-256-GCM blob with a small OPEN header, and the
 * header's canonical bytes are the AEAD's additional data. That is the whole
 * design: GCM already provides integrity and authentication, so a separate
 * manifest, body hash or per-record MAC would only add ways to disagree with
 * each other.
 *
 * WHAT IS ENCRYPTED: the notes and safebox records exactly as IndexedDB holds
 * them (already-encrypted envelopes — the export never materializes plaintext),
 * their counts, and the `incompleteRestore` marker. WHAT IS NOT: the sync
 * store, in any form. A file cannot prove «these bytes were published by that
 * transaction», so publication state is never carried and never restored.
 *
 * WHAT LEAKS from the open header: that the app is used, the approximate size
 * of the store and the rhythm of exports. Accepted deliberately — size and
 * date cannot be hidden without padding and repacking — and written down here
 * because phases 3–4 put this same container into R2 and Google Drive, where
 * the provider sees exactly that.
 *
 * Normative spec, including the byte-level test vector:
 * `docs/BACKUP_FORMAT_V1.md`. This file is the implementation of that document,
 * not a second source of truth for it.
 */

import { mnemonicToSeedSync } from '@scure/bip39';
import { bufferToBase64, base64ToBuffer, isCanonicalBase64 } from './crypto';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';

// ─── Constants ───────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'eternal-notes-backup';

/** Container version this build WRITES. */
export const BACKUP_CONTAINER_V = 1;
/** Highest container version this build can READ. */
export const SUPPORTED_CONTAINER_V = 1;
/**
 * The backup-reader protocol version this build implements — NOT the app
 * version and NOT the `App-Version` of a publication. A container declares the
 * minimum reader it needs; anything higher than this is refused with a typed
 * error instead of a partial read.
 */
export const READER_VERSION = 1;

/**
 * Hard size ceiling, measured on BOTH sides as the FINAL file size (D17).
 *
 * Measuring the cap on the plaintext would let an export produce a near-cap
 * file roughly 1.33× larger — base64 plus the JSON wrapper — which its own
 * import would then refuse. Users above this ceiling are not supported until a
 * streaming container v2, and the UI says so in as many words.
 */
export const BACKUP_CAP_BYTES = 32 * 1024 * 1024;

/**
 * How much PLAINTEXT can still fit under the cap, once base64 and the JSON
 * wrapper have taken their share. Deliberately conservative: base64 costs 4/3,
 * and the header, the envelope keys and the GCM tag are charged a flat
 * over-estimate on top. Better to refuse a store that would have just fitted
 * than to hand the user a file its own import rejects.
 *
 * Exported so the snapshot reader can stop early without knowing anything else
 * about the format — the arithmetic stays here, where the format lives.
 */
export const BACKUP_PLAINTEXT_BUDGET_BYTES = Math.floor((BACKUP_CAP_BYTES - 4096) * 3 / 4);

/** GCM contract: a FRESH 96-bit nonce per export, 128-bit tag. The key is
 *  constant for a mnemonic and exports are many, so a repeated nonce would
 *  destroy both confidentiality and authenticity — the IV is never derived
 *  from the date, the contents or the file name. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

// ─── Errors ──────────────────────────────────────────────────────────

export type BackupErrorCode =
  /** Larger than the cap. Checked before reading the text, on `File.size`. */
  | 'too_large'
  /** Not JSON, or not shaped like a container at all. */
  | 'not_a_container'
  /** Written by a newer app: container `v` or `minReaderVersion` too high. */
  | 'too_new'
  /** AEAD authentication failed: a different seed phrase, or damaged bytes.
   *  The two are NOT distinguished — GCM cannot tell them apart, and pretending
   *  otherwise would be a guess dressed as a diagnosis. */
  | 'undecryptable'
  /** Decrypted and authenticated, but internally inconsistent (counts, ids). */
  | 'corrupt'
  /** EXPORT side: a stored value JSON cannot carry losslessly. */
  | 'unsupported_value';

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  /** Where the problem is, for diagnostics — never shown raw to the user. */
  readonly at?: string;
  constructor(code: BackupErrorCode, message: string, at?: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.at = at;
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────

/** The OPEN header. Its canonical bytes are the AEAD additional data, so every
 *  field here is authenticated even though it is readable. */
export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  v: number;
  minReaderVersion: number;
  /**
   * Does the container carry records this WRITER could not read? Checked
   * ASYMMETRICALLY by the reader (D11a): header `false` + unreadable records
   * present → fail closed; header `true` + everything readable → fine, the
   * reader is simply newer and the warning is dropped. Strict equality would
   * reject a valid backup at precisely the build able to restore it.
   */
  containsUnsupportedRecords: boolean;
  createdAt: number;
}

/** The ENCRYPTED payload. */
export interface BackupBody {
  counts: { notes: number; safebox: number };
  /**
   * Authenticated trace of an incomplete restore — deliberately INSIDE the
   * ciphertext, never in the open header: it is one more metadata bit to leak,
   * and a second source of truth for something the body already states.
   *
   * Orthogonal to `containsUnsupportedRecords`: that one describes what the
   * container HOLDS, this one says the container is narrower than the file it
   * was restored from. A reader never clears it on its own.
   */
  incompleteRestore: boolean;
  /** IndexedDB forms as they are — no `{id, v, raw}` wrapper. */
  notes: BackupRecord[];
  safebox: BackupRecord[];
}

/** A record travels verbatim: unknown fields are preserved, not stripped. The
 *  guarantee is semantic preservation and equality of CANONICAL JSON bytes —
 *  byte equality of the original object is not promised, because canonization
 *  reorders keys and IndexedDB stores a structured clone anyway. */
export type BackupRecord = Record<string, unknown>;

export interface BackupContainer {
  header: BackupHeader;
  body: BackupBody;
}

// ─── Which records THIS build cannot read ────────────────────────────
//
// A container-format concern, not a classifier one: `containsUnsupportedRecords`
// is a header field (D11a), and the standalone viewer needs the same predicate
// without dragging the upload path — and its gateway URLs — into an artifact
// whose build refuses any `http(s)://`.

/** `v` absent means v1 (crypto.ts «Absent/1 = v1»), which is legal and must
 *  not read as unknown. */
export const isOpaqueNote = (n: EncryptedNote): boolean =>
  n.v !== undefined && n.v !== 1 && n.v !== 2 && n.v !== 3;

/** Safebox entries have always carried a version, so an absent one is unknown
 *  just like a wrong one. */
export const isOpaqueEntry = (e: EncryptedSafeboxEntry): boolean => e.v !== 4;

// ─── Key derivation ──────────────────────────────────────────────────

/**
 * The container key: HKDF-SHA256 over the BIP-39 seed, salt
 * `'eternal-notes-v1'`, info `'backup-v1'` → AES-256-GCM.
 *
 * Same seed, same normalization and same salt as every other key in this app
 * (`crypto.ts`), separated only by `info` — so a backup key can never decrypt a
 * note envelope and vice versa. Deterministic by design: the file must open on
 * a device that has nothing but the seed phrase.
 */
export async function deriveBackupKey(mnemonic: string): Promise<CryptoKey> {
  const seed = mnemonicToSeedSync(mnemonic);
  const keyMaterial = await crypto.subtle.importKey('raw', seed.slice(0, 32), 'HKDF', false, ['deriveKey']);
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('eternal-notes-v1'), info: enc.encode('backup-v1') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Canonical JSON ──────────────────────────────────────────────────

/** Code-POINT order, not the UTF-16 code-unit order `Array.sort` gives by
 *  default. They differ for astral characters, and a frozen format cannot
 *  afford «works until someone uses an emoji as a key». */
function compareCodePoints(a: string, b: string): number {
  const ax = Array.from(a);
  const bx = Array.from(b);
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const d = ax[i].codePointAt(0)! - bx[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ax.length - bx.length;
}

function reject(at: string, why: string): never {
  throw new BackupError('unsupported_value', `${why} at ${at}`, at);
}

/**
 * Deterministic serialization that VALIDATES as it goes: keys in code-point
 * order, arrays in order, no whitespace.
 *
 * Validation and serialization are one pass on purpose. `JSON.stringify`
 * silently mangles a whole class of values — a hole in a sparse array becomes
 * `null`, non-index properties of an array vanish, `-0` becomes `0`,
 * `undefined` and functions disappear from objects, a `Date` turns into a
 * string it can never turn back from. Every one of those would be silent DATA
 * LOSS inside a file whose entire purpose is to still be readable when nothing
 * else is left. So anything JSON cannot carry losslessly makes the export FAIL
 * CLOSED, and the record waits for a container v2 instead of being quietly
 * flattened.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>(), '$');
}

function canonicalize(value: unknown, seen: Set<object>, at: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) reject(at, 'NaN/Infinity');
      // -0 serializes as "0": the value would come back as +0, and a format
      // that quietly changes a number is not a backup format.
      if (Object.is(value, -0)) reject(at, 'negative zero');
      return JSON.stringify(value);
    case 'undefined':
      reject(at, 'undefined');
      break;
    case 'bigint':
      reject(at, 'BigInt');
      break;
    case 'function':
      reject(at, 'function');
      break;
    case 'symbol':
      reject(at, 'symbol');
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) reject(at, 'circular reference');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return canonicalizeArray(obj, seen, at);

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      // Date, Map, Set, Blob, ArrayBuffer, typed arrays, class instances.
      reject(at, `non-plain object (${obj.constructor?.name ?? 'unknown'})`);
    }
    if (Object.getOwnPropertySymbols(obj).length > 0) reject(at, 'symbol key');

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const parts = keys.map(k =>
      `${JSON.stringify(k)}:${canonicalize(record[k], seen, `${at}.${k}`)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

function canonicalizeArray(arr: unknown[], seen: Set<object>, at: string): string {
  // Dense indices 0…length-1 and NOTHING else. A hole would come back as
  // `null` and an extra property would simply be gone.
  const ownKeys = Object.keys(arr);
  if (ownKeys.length !== arr.length) reject(at, 'sparse array or extra array property');
  for (let i = 0; i < arr.length; i++) {
    if (!Object.hasOwn(arr, i)) reject(`${at}[${i}]`, 'array hole');
  }
  if (Object.getOwnPropertySymbols(arr).length > 0) reject(at, 'symbol key');
  return `[${arr.map((v, i) => canonicalize(v, seen, `${at}[${i}]`)).join(',')}]`;
}

/** The exact bytes fed to AES-GCM as additional data. */
export function headerAad(header: BackupHeader): Uint8Array {
  return new TextEncoder().encode(canonicalJson(header satisfies BackupHeader));
}

// ─── Encode ──────────────────────────────────────────────────────────

export interface EncodeBackupInput {
  notes: BackupRecord[];
  safebox: BackupRecord[];
  incompleteRestore: boolean;
  containsUnsupportedRecords: boolean;
  createdAt: number;
}

/**
 * Serialize + encrypt one container. Returns the exact file text.
 *
 * The IV comes from `crypto.getRandomValues` and from nowhere else — there is
 * no parameter to inject one, so no production path can accidentally reuse a
 * nonce. Tests that need the fixed vector stub the CSPRNG, which also makes
 * «is the IV really random?» an observable property rather than a promise.
 */
export async function encodeBackup(input: EncodeBackupInput, key: CryptoKey): Promise<string> {
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    v: BACKUP_CONTAINER_V,
    minReaderVersion: READER_VERSION,
    containsUnsupportedRecords: input.containsUnsupportedRecords,
    createdAt: input.createdAt,
  };

  const body: BackupBody = {
    counts: { notes: input.notes.length, safebox: input.safebox.length },
    incompleteRestore: input.incompleteRestore,
    notes: input.notes,
    safebox: input.safebox,
  };

  // The SAME invariants the decoder enforces, checked here: writing a container
  // whose own import would refuse it is a defect worth catching where the data
  // is still around to explain it — not at restore time on another device.
  assertBodyInvariants(body);

  const plaintext = new TextEncoder().encode(canonicalJson(body));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    // `as BufferSource` follows the existing WebCrypto call sites in crypto.ts:
    // TS 6 types a plain Uint8Array over ArrayBufferLike, which does not narrow
    // to the DOM's ArrayBuffer-backed view.
    { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8, additionalData: headerAad(header) as BufferSource },
    key,
    plaintext,
  );

  const text = canonicalJson({
    ...header,
    body: { iv: bufferToBase64(iv), ciphertext: bufferToBase64(ciphertext) },
  });

  const size = new TextEncoder().encode(text).byteLength;
  if (size > BACKUP_CAP_BYTES) {
    throw new BackupError('too_large', `Container is ${size} bytes, over the ${BACKUP_CAP_BYTES} cap`);
  }
  return text;
}

// ─── Decode ──────────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every(k => Object.hasOwn(o, k));
}

const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

const HEADER_KEYS = ['format', 'v', 'minReaderVersion', 'containsUnsupportedRecords', 'createdAt'] as const;
const CONTAINER_KEYS = [...HEADER_KEYS, 'body'] as const;
const BODY_KEYS = ['counts', 'incompleteRestore', 'notes', 'safebox'] as const;

/**
 * Parse, authenticate and validate a container.
 *
 * Order matters and is fail-closed throughout: size before parsing, shape
 * before decryption, decryption before believing a single field of the body.
 * An unknown top-level key is a rejection rather than something ignored —
 * anything outside the five header fields would sit OUTSIDE the AEAD's
 * additional data, which is exactly where an attacker would want to put it.
 */
export async function decodeBackup(text: string, key: CryptoKey): Promise<BackupContainer> {
  const size = new TextEncoder().encode(text).byteLength;
  if (size > BACKUP_CAP_BYTES) {
    throw new BackupError('too_large', `File is ${size} bytes, over the ${BACKUP_CAP_BYTES} cap`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('not_a_container', 'Not JSON');
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, CONTAINER_KEYS)) {
    throw new BackupError('not_a_container', 'Unexpected container shape');
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new BackupError('not_a_container', 'Not an Eternal Notes backup');
  }

  // Version gates BEFORE anything else about the content: a container from a
  // newer app deserves «made by a newer version», never «damaged».
  if (!Number.isSafeInteger(parsed.v) || (parsed.v as number) < 1) {
    throw new BackupError('not_a_container', 'Bad container version');
  }
  if (!Number.isSafeInteger(parsed.minReaderVersion) || (parsed.minReaderVersion as number) < 1) {
    throw new BackupError('not_a_container', 'Bad minReaderVersion');
  }
  if ((parsed.v as number) > SUPPORTED_CONTAINER_V) {
    throw new BackupError('too_new', `Container v${parsed.v} needs a newer app`);
  }
  if ((parsed.minReaderVersion as number) > READER_VERSION) {
    throw new BackupError('too_new', `Container needs reader v${parsed.minReaderVersion}`);
  }
  if (typeof parsed.containsUnsupportedRecords !== 'boolean') {
    throw new BackupError('not_a_container', 'Bad containsUnsupportedRecords');
  }
  if (!isCount(parsed.createdAt)) {
    throw new BackupError('not_a_container', 'Bad createdAt');
  }

  const rawBody = parsed.body;
  if (!isPlainObject(rawBody) || !hasExactKeys(rawBody, ['iv', 'ciphertext'])) {
    throw new BackupError('not_a_container', 'Bad body envelope');
  }
  // Canonical base64 only: a non-canonical spelling of the same bytes would
  // pass a lenient decoder while breaking the size cross-check.
  if (!isCanonicalBase64(rawBody.iv) || !isCanonicalBase64(rawBody.ciphertext)) {
    throw new BackupError('not_a_container', 'Body is not canonical base64');
  }
  const iv = base64ToBuffer(rawBody.iv);
  const ciphertext = base64ToBuffer(rawBody.ciphertext);
  if (iv.byteLength !== IV_BYTES) {
    throw new BackupError('not_a_container', `IV must be exactly ${IV_BYTES} bytes`);
  }
  if (ciphertext.byteLength < TAG_BYTES) {
    throw new BackupError('not_a_container', 'Ciphertext shorter than the GCM tag');
  }

  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    v: parsed.v as number,
    minReaderVersion: parsed.minReaderVersion as number,
    containsUnsupportedRecords: parsed.containsUnsupportedRecords,
    createdAt: parsed.createdAt as number,
  };

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        tagLength: TAG_BYTES * 8,
        additionalData: headerAad(header) as BufferSource,
      },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // Wrong seed, damaged bytes, or a TAMPERED HEADER — the header travels as
    // additional data, so editing `createdAt` in a text editor lands here.
    throw new BackupError('undecryptable', 'Damaged file, or made with a different seed phrase');
  }

  return { header, body: parseBody(plaintext) };
}

function parseBody(plaintext: ArrayBuffer): BackupBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new BackupError('corrupt', 'Body is not JSON');
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, BODY_KEYS)) {
    throw new BackupError('corrupt', 'Unexpected body shape');
  }
  if (typeof parsed.incompleteRestore !== 'boolean') {
    throw new BackupError('corrupt', 'Bad incompleteRestore');
  }
  if (!Array.isArray(parsed.notes) || !Array.isArray(parsed.safebox)) {
    throw new BackupError('corrupt', 'Collections must be arrays');
  }
  const counts = parsed.counts;
  if (!isPlainObject(counts) || !hasExactKeys(counts, ['notes', 'safebox'])
      || !isCount(counts.notes) || !isCount(counts.safebox)) {
    throw new BackupError('corrupt', 'Bad counts');
  }
  // Counts are a cheap end-to-end check on the whole pipeline: a truncated or
  // partially written body fails here rather than restoring silently short.
  if (counts.notes !== parsed.notes.length || counts.safebox !== parsed.safebox.length) {
    throw new BackupError('corrupt', 'Counts do not match the collections');
  }

  const body: BackupBody = {
    counts: { notes: counts.notes, safebox: counts.safebox },
    incompleteRestore: parsed.incompleteRestore,
    notes: parsed.notes.map((r, i) => asRecord(r, `notes[${i}]`)),
    safebox: parsed.safebox.map((r, i) => asRecord(r, `safebox[${i}]`)),
  };
  assertBodyInvariants(body);
  return body;
}

function asRecord(value: unknown, at: string): BackupRecord {
  if (!isPlainObject(value)) throw new BackupError('corrupt', 'Record is not an object', at);
  return value;
}

/** Non-empty string id, checked at the runtime boundary rather than trusted
 *  from a TypeScript cast — one side of this validator reads an untrusted
 *  file, the other reads IndexedDB, and neither is a type system. */
function requireId(record: BackupRecord, field: 'noteId' | 'entryId', at: string): string {
  const id = record[field];
  if (typeof id !== 'string' || id === '') {
    throw new BackupError('corrupt', `Record without a usable ${field}`, at);
  }
  return id;
}

/**
 * Every invariant the body must satisfy, enforced IDENTICALLY on both
 * directions: stable per-collection fields, then global id uniqueness (D10).
 *
 * One function for both sides on purpose. A decoder stricter than its encoder
 * means an export can write a file that its own import rejects — and the
 * rejection would surface at restore time, on another device, when the
 * original data may be gone.
 *
 * Stable fields (docs/BACKUP_FORMAT_V1.md §2.2). `notes[*].v` is deliberately
 * NOT required: its absence legitimately means v1, so demanding it would
 * either reject legacy backups or mutate records that must travel «as they
 * are». `safebox[*].v` IS required — a safebox entry has always carried one.
 *
 * Uniqueness: notes and safebox entries share ONE key space downstream (the
 * sync store is keyed by a single id, and so is restore), so a cross-collection
 * collision would make the result depend on processing order — not a property
 * a restore is allowed to have.
 *
 * Raised on both sides with the same `corrupt` code, which does not mean the
 * same thing to a person: on import the FILE is inconsistent, on export the
 * LOCAL STORE is. Whatever surfaces these must not tell an exporting user that
 * a file is damaged — there is no file yet.
 */
function assertBodyInvariants(body: BackupBody): void {
  const noteIds = new Set<string>();
  for (let i = 0; i < body.notes.length; i++) {
    const id = requireId(body.notes[i], 'noteId', `notes[${i}]`);
    if (noteIds.has(id)) throw new BackupError('corrupt', `Duplicate note id ${id}`, `notes[${i}]`);
    noteIds.add(id);
  }

  const entryIds = new Set<string>();
  for (let i = 0; i < body.safebox.length; i++) {
    const at = `safebox[${i}]`;
    const entry = body.safebox[i];
    const id = requireId(entry, 'entryId', at);
    if (entry.v === undefined) {
      throw new BackupError('corrupt', 'Safebox entry without a version', at);
    }
    if (entryIds.has(id)) throw new BackupError('corrupt', `Duplicate safebox id ${id}`, at);
    if (noteIds.has(id)) throw new BackupError('corrupt', `Id ${id} is used by both collections`, at);
    entryIds.add(id);
  }
}

// ─── File name ───────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** `eternal-notes-backup-YYYY-MM-DD-HHmm.json`, in the user's LOCAL time —
 *  several exports on one day stay distinguishable, and the name matches the
 *  clock the user just looked at. */
export function backupFileName(when: Date): string {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + `-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `eternal-notes-backup-${stamp}.json`;
}
