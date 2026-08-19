/**
 * «Быстрый вход» — CORE. WebAuthn PRF + WebCrypto, nothing else.
 *
 * This module knows NOTHING about storage, the store, the record schema or any
 * product policy — those live in `quick-unlock.ts`. The boundary is enforced by
 * ESLint (`no-restricted-imports`), not by convention: both modules import
 * cleanly under Node, so a passing test suite would NOT prove the separation.
 *
 * WHY A SEPARATE MODULE FROM crypto.ts: this envelope has its own version, its
 * own salts and its own error classes. A branch inside `decryptBytesWithPin`
 * would sooner or later drag PRF failures into the ATTEMPT-METERED PIN path,
 * and «a failed quick unlock spends a PIN attempt» is the one outcome this
 * feature may never produce.
 *
 * DOMAIN SEPARATION: every consumer gets its OWN `info` and its own salts. The
 * vault uses `eternal-notes-quick-unlock-v1`; a hypothetical safebox contour
 * would use `eternal-notes-quick-unlock-safebox-v1` plus its own
 * prfSalt/hkdfSalt/blob. The same passkey can back both — PRF with a different
 * salt yields an independent output, HKDF with a different `info` an
 * independent key — so the user never has to create a second «Matamata Notes»
 * key, and the contours are uncorrelated by construction.
 */

import { isOperationError } from './crypto';

// ─── Errors ──────────────────────────────────────────────────────────
//
// NOT ONE of these is ever metered. There is nothing to guess here: the PRF
// output is 256 bits of hardware entropy, not a derivative of a user secret,
// and the rate limit that matters is the authenticator's own UV counter (TPM /
// Secure Enclave). A limiter of ours would be theatre.

/** No API, no platform authenticator, no PRF, the feature flag is off, or a
 *  WebCrypto/environment failure. Never destructive, never metered. */
export class QuickUnlockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickUnlockUnavailableError';
  }
}

/** OUR OWN AbortError — a lock, a reset or an unmount cancelled the ceremony.
 *  The ONLY silent outcome: the caller returns to the PIN screen saying
 *  nothing, because the user did not ask for anything to be reported. */
export class QuickUnlockCancelledError extends Error {
  constructor() {
    super('Быстрый вход отменён.');
    this.name = 'QuickUnlockCancelledError';
  }
}

/**
 * `NotAllowedError` from WebAuthn — a CATCH-ALL BY DESIGN of the spec, which
 * deliberately refuses to distinguish «the user cancelled» from «the timeout
 * expired» from «that credential no longer exists» (a privacy property, not a
 * gap). So this error may NEVER delete a record or claim a passkey is gone:
 * the honest message is neutral.
 */
export class QuickUnlockNotCompletedError extends Error {
  constructor() {
    super('Быстрый вход не выполнен. Войдите по PIN — или удалите быстрый вход в настройках и настройте заново.');
    this.name = 'QuickUnlockNotCompletedError';
  }
}

/** The stored record failed validation (`quick-unlock.ts`). Fail-closed: the
 *  record is dropped, never treated as a wrong secret. */
export class QuickUnlockRecordInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickUnlockRecordInvalidError';
  }
}

/**
 * The PRF output arrived and AES-GCM authentication still failed: the key and
 * the blob have diverged (passkey re-created, platform bug, data corruption).
 * Not a guessing oracle — there is nothing to guess — so it is not metered
 * either; the reaction is to drop that exact record and offer a fresh setup.
 */
export class QuickUnlockKeyMismatchError extends Error {
  constructor() {
    super('Быстрый вход больше не подходит к сохранённому ключу.');
    this.name = 'QuickUnlockKeyMismatchError';
  }
}

// ─── Capability detection ────────────────────────────────────────────

/**
 * `'unknown'` is a FIRST-CLASS answer, not a failure: the support matrix and
 * the detection APIs can both lie, in either direction (§3 of the plan), so
 * the only authority is a real ceremony. The UI therefore still offers the
 * attempt on `'unknown'` — and shows a reason, never silence, on the three
 * negative verdicts.
 */
export type QuickUnlockCapability = 'ready' | 'no-api' | 'no-platform' | 'no-prf' | 'unknown';

interface ClientCapabilitiesCarrier {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
}

/** Cheapest check first; a real ceremony is the only definitive answer. NEVER
 *  throws — every rejection collapses to `'unknown'`, which does not block a
 *  setup attempt (an unhandled rejection here would be a crash on a settings
 *  screen for a feature the user has not even switched on). */
export async function detectQuickUnlockCapability(): Promise<QuickUnlockCapability> {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
    return 'no-api';
  }
  const api = window.PublicKeyCredential as unknown as ClientCapabilitiesCarrier;

  try {
    if (typeof api.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return 'unknown';
    if (!(await api.isUserVerifyingPlatformAuthenticatorAvailable())) return 'no-platform';
  } catch {
    return 'unknown'; // the probe itself failed — we know nothing, not «no»
  }

  try {
    if (typeof api.getClientCapabilities !== 'function') return 'unknown';
    const caps = await api.getClientCapabilities();
    const prf = caps?.['extension:prf'];
    if (prf === true) return 'ready';
    if (prf === false) return 'no-prf';
    return 'unknown'; // method exists but says nothing about PRF
  } catch {
    return 'unknown';
  }
}

// ─── Key derivation ──────────────────────────────────────────────────

/** Versioned and MANDATORY. Raw PRF output used as a key, or HKDF without
 *  `info`, are the two canonical PRF anti-patterns; `info` is also what keeps
 *  future contours cryptographically independent. Changing this string ⇒ a new
 *  record `v`, and old records stop being readable by design. */
export const QUICK_UNLOCK_VAULT_INFO = 'eternal-notes-quick-unlock-v1';

/**
 * HKDF-SHA256(ikm = PRF output, salt = our random hkdfSalt, info) → AES-256-GCM.
 *
 * EVERY failure here is `QuickUnlockUnavailableError`, including an
 * `OperationError`: one raised by `importKey`/`deriveBits` does NOT prove a GCM
 * tag mismatch, it proves the environment misbehaved — and a transient
 * environment failure must never be allowed to delete a working record.
 */
export async function deriveQuickUnlockKek(
  prfOutput: Uint8Array,
  hkdfSalt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  try {
    const material = await crypto.subtle.importKey(
      'raw', prfOutput as BufferSource, 'HKDF', false, ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: hkdfSalt as BufferSource,
        info: new TextEncoder().encode(info),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (e) {
    throw new QuickUnlockUnavailableError(
      `Не удалось вывести ключ быстрого входа: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── Envelope ────────────────────────────────────────────────────────

/** AES-GCM over the mnemonic. Environment failures only — there is no «wrong
 *  key» outcome when writing. */
export async function wrapWithKek(kek: CryptoKey, iv: Uint8Array, plaintext: string): Promise<Uint8Array> {
  try {
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, kek, new TextEncoder().encode(plaintext),
    );
    return new Uint8Array(sealed);
  } catch (e) {
    throw new QuickUnlockUnavailableError(
      `Не удалось зашифровать ключ быстрого входа: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * AES-GCM open. The `try` wraps `subtle.decrypt` AND NOTHING ELSE — the same
 * discipline `decryptBytesWithPinInternal` follows for the PIN: only a tag
 * mismatch raised by THIS call may be read as «key and blob diverged», and
 * only that outcome is allowed to cost the user their record.
 */
export async function unwrapWithKek(kek: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<string> {
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource }, kek, ciphertext as BufferSource,
    );
  } catch (e) {
    if (isOperationError(e)) throw new QuickUnlockKeyMismatchError();
    throw new QuickUnlockUnavailableError(
      `Не удалось расшифровать ключ быстрого входа: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return new TextDecoder().decode(opened);
}
