/**
 * «Быстрый вход» — the VAULT consumer. Everything that is policy rather than
 * cryptography: the stored record and its version, validation, the
 * «no pin-seed ⇒ the record is void» rule and the vault binding.
 *
 * The crypto itself lives in `quick-unlock-core.ts`; the meta commits live in
 * `storage.ts` next to every other commit. This module sits between them and
 * is what the store and the UI talk to.
 */

import { bufferToBase64, base64ToBuffer } from './crypto';

/** ONE record, not an array. Storage is scoped per origin AND per device, so
 *  «laptop + phone» is two different IndexedDBs with a record each;
 *  `authenticatorAttachment: 'platform'` rules out security keys by
 *  construction. An array would have bought eviction, dedup and a list UI for
 *  a scenario that cannot occur. Re-setup REPLACES the record — and goes
 *  through an explicit «Удалить» first, so orphaning the old platform
 *  credential is always a deliberate act. */
export interface QuickUnlockRecord {
  v: 1;
  /** base64url credential id, exactly as the authenticator returned it. */
  credentialId: string;
  /** 32 random bytes, base64. The PRF salt. */
  prfSalt: string;
  /** 32 random bytes, base64. The HKDF salt — separate from the PRF salt. */
  hkdfSalt: string;
  /** 12 bytes, base64. */
  iv: string;
  /** base64: AES-GCM(KEK, mnemonic). */
  ciphertext: string;
  /** base64 of the vault public key — the same value as `vault-public-key`.
   *  Defense in depth: a foreign record is dropped ON READ instead of
   *  surviving all the way to a VaultMismatchError after a successful
   *  unwrap. */
  pk: string;
  createdAt: number;
}

export const QUICK_UNLOCK_META_KEY = 'quick-unlock-seed';

// There is deliberately no `rpId` field: it would always equal the host of the
// origin whose IndexedDB the record lives in (storage is origin-scoped and we
// set RP ID to the hostname), so a check on it could never fire.

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const SALT_BYTES = 32;
const IV_BYTES = 12;
const MIN_CREDENTIAL_ID_BYTES = 16;
const MAX_CREDENTIAL_ID_BYTES = 1024;
/** AES-GCM tag length — anything shorter is structurally broken, not «wrong». */
const MIN_CIPHERTEXT_BYTES = 16;
/** The envelope holds exactly one 12-word mnemonic. A damaged record must not
 *  be able to push a large buffer through WebCrypto. */
const MAX_CIPHERTEXT_BYTES = 256;
/** The vault public key is 32 bytes; the cap only has to be sane. */
const MAX_PK_CHARS = 128;

/** Upper bounds are checked on the ENCODED string first, before any decoding:
 *  a hostile record must not get to allocate from its own length field. */
const maxEncodedChars = (bytes: number) => Math.ceil((bytes * 4) / 3) + 4;

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidTimestamp(t: unknown): t is number {
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIMESTAMP_MS;
}

/** Standard base64, and CANONICAL: re-encoding the decoded bytes must
 *  reproduce the input exactly. `atob` happily accepts non-canonical padding
 *  and stray trailing bits, which would let the same bytes have several
 *  spellings — and «the same record» is a comparison this feature relies on
 *  (conditional delete, first-writer-wins). */
function decodeCanonicalBase64(s: unknown, expectedBytes: number | { min: number; max: number }): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const max = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes.max;
  if (s.length > maxEncodedChars(max)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBuffer(s);
  } catch {
    return null;
  }
  if (bufferToBase64(bytes) !== s) return null; // non-canonical spelling
  if (typeof expectedBytes === 'number') {
    if (bytes.length !== expectedBytes) return null;
  } else if (bytes.length < expectedBytes.min || bytes.length > expectedBytes.max) {
    return null;
  }
  return bytes;
}

/** base64url WITHOUT padding — the WebAuthn convention for credential ids. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bufferToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bytes = base64ToBuffer(padded);
    return bytesToBase64Url(bytes) === s ? bytes : null; // canonical only
  } catch {
    return null;
  }
}

/**
 * Fail-closed validation of a record read back from IndexedDB — an untrusted
 * runtime boundary, exactly like `assertValidPinBlob`.
 *
 * Returns `null` rather than throwing: an unreadable record is NOT an error
 * condition for the caller, it is «there is no quick unlock», and the reader
 * has to keep working (a throw here would take down bootstrap over an optional
 * accelerator). Dropping a record is NEVER a wrong-secret outcome and NEVER
 * spends a PIN attempt.
 *
 * The vault binding (`pk`) is checked separately, by whoever holds the
 * authoritative `vault-public-key` — see `quickUnlockBelongsToVault`.
 */
export function parseQuickUnlockRecord(raw: unknown): QuickUnlockRecord | null {
  if (!isRecordObject(raw)) return null;
  if (raw.v !== 1) return null;

  if (typeof raw.credentialId !== 'string') return null;
  if (raw.credentialId.length > maxEncodedChars(MAX_CREDENTIAL_ID_BYTES)) return null;
  const credentialId = base64UrlToBytes(raw.credentialId);
  if (!credentialId) return null;
  if (credentialId.length < MIN_CREDENTIAL_ID_BYTES || credentialId.length > MAX_CREDENTIAL_ID_BYTES) return null;

  if (!decodeCanonicalBase64(raw.prfSalt, SALT_BYTES)) return null;
  if (!decodeCanonicalBase64(raw.hkdfSalt, SALT_BYTES)) return null;
  if (!decodeCanonicalBase64(raw.iv, IV_BYTES)) return null;
  if (!decodeCanonicalBase64(raw.ciphertext, { min: MIN_CIPHERTEXT_BYTES, max: MAX_CIPHERTEXT_BYTES })) return null;

  if (typeof raw.pk !== 'string' || raw.pk.length === 0 || raw.pk.length > MAX_PK_CHARS) return null;
  if (!decodeCanonicalBase64(raw.pk, { min: 1, max: MAX_PK_CHARS })) return null;

  if (!isValidTimestamp(raw.createdAt)) return null;

  // Unknown extra fields are tolerated (forward compatibility), but they are
  // NOT carried: the record is rebuilt from the fields this version knows, so
  // nothing unvalidated can survive a read → write cycle.
  return {
    v: 1,
    credentialId: raw.credentialId,
    prfSalt: raw.prfSalt as string,
    hkdfSalt: raw.hkdfSalt as string,
    iv: raw.iv as string,
    ciphertext: raw.ciphertext as string,
    pk: raw.pk,
    createdAt: raw.createdAt,
  };
}

/** The record belongs to the vault currently bound to this database. */
export function quickUnlockBelongsToVault(rec: QuickUnlockRecord, vaultPublicKey: unknown): boolean {
  return typeof vaultPublicKey === 'string' && vaultPublicKey.length > 0 && rec.pk === vaultPublicKey;
}

/** Field-by-field equality — the ownership check for the CONDITIONAL delete.
 *  Object identity is meaningless (the record is re-read from IndexedDB) and
 *  `JSON.stringify` would silently make key order part of the contract. */
export function quickUnlockRecordEquals(a: QuickUnlockRecord | null, b: QuickUnlockRecord | null): boolean {
  if (!a || !b) return false;
  return a.v === b.v
    && a.credentialId === b.credentialId
    && a.prfSalt === b.prfSalt
    && a.hkdfSalt === b.hkdfSalt
    && a.iv === b.iv
    && a.ciphertext === b.ciphertext
    && a.pk === b.pk
    && a.createdAt === b.createdAt;
}

/**
 * The verdict of reading `quick-unlock-seed` alongside the rest of the client
 * configuration. THREE outcomes, not two — «there is no quick unlock» and
 * «there is one and it is void» must drive different actions: the second one
 * has a stale record to clean up.
 */
export type QuickUnlockVerdict =
  | { kind: 'none' }
  | { kind: 'valid'; record: QuickUnlockRecord }
  | { kind: 'stale'; reason: 'invalid' | 'no-pin' | 'foreign-vault' };

/**
 * The one place the compatibility rule lives:
 *
 *   **no `pin-seed` ⇒ the quick-unlock record is void.**
 *
 * A client older than this feature removes the PIN (or wipes it on the 10th
 * strike) through `clearPinConfigMeta`, which — in THAT build — knows nothing
 * about `quick-unlock-seed` and would leave a working quick entry to a vault
 * whose PIN is gone. Applied on EVERY read, not just at startup, so a rollback
 * of the client cannot open a window either. It also happens to be the product
 * rule («quick unlock only on top of a PIN»), so this is one invariant working
 * in both directions rather than a compatibility patch.
 */
export function judgeQuickUnlock(
  raw: unknown,
  pinSeed: unknown,
  vaultPublicKey: unknown,
): QuickUnlockVerdict {
  if (raw === undefined) return { kind: 'none' };
  const record = parseQuickUnlockRecord(raw);
  if (!record) return { kind: 'stale', reason: 'invalid' };
  if (pinSeed === undefined) return { kind: 'stale', reason: 'no-pin' };
  if (!quickUnlockBelongsToVault(record, vaultPublicKey)) return { kind: 'stale', reason: 'foreign-vault' };
  return { kind: 'valid', record };
}
