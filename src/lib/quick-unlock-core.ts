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
  /**
   * Set when the CEREMONY ITSELF settled a capability question — the only
   * authoritative answer there is (§6: the probes and the support matrix can
   * both lie, in either direction). The store records it so the UI stops
   * offering a setup that would mint another platform credential nobody can
   * use — and, on `residentKey: 'discouraged'`, may not even be able to see.
   */
  readonly verdict?: QuickUnlockCapability;

  constructor(message: string, verdict?: QuickUnlockCapability) {
    super(message);
    this.name = 'QuickUnlockUnavailableError';
    this.verdict = verdict;
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

// ─── WebAuthn ceremonies ─────────────────────────────────────────────
//
// WE DO NOT USE WEBAUTHN AS AUTHENTICATION — only as a key source. Nobody
// verifies the assertion signature or the challenge, and nobody could: there is
// no server in this product. Forging an assertion buys an attacker nothing,
// because the PRF output does not follow from one. The challenge is therefore
// local randomness, and that is a deliberate, documented choice.

/** Goes into the platform credential manager (iCloud / Google) and is visible
 *  to the user there. A CONSTANT: neither the vault public key nor anything
 *  derived from the seed may ever appear in it. */
const RP_NAME = 'Matamata Notes';

const CEREMONY_TIMEOUT_MS = 60_000;

/** Both ceremonies carry `'required'`, forever. On the CTAP level hmac-secret
 *  keeps two independent secrets — one behind UV and one without — and while
 *  WebAuthn L3 ties PRF to the UV-gated key, the spec does NOT guarantee the
 *  output stays stable if the policy changes; that is platform-dependent. The
 *  invariant is a product one either way: unwrapping the seed is ALWAYS behind
 *  a system check. Changing this ⇒ a new record `v`. */
const USER_VERIFICATION = 'required' as const;

interface PrfExtensionResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | Uint8Array };
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

/** OUR abort is the only silent outcome — see QuickUnlockCancelledError. */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QuickUnlockCancelledError();
}

/**
 * Map a ceremony rejection onto our classes. The order is the contract:
 *
 * 1. our own signal fired ⇒ Cancelled (silent);
 * 2. `NotAllowedError` ⇒ NotCompleted — a CATCH-ALL: cancel, timeout and
 *    «no such credential» are indistinguishable BY DESIGN of the spec, so this
 *    outcome may not delete anything or claim to know which happened;
 * 3. anything else ⇒ Unavailable.
 */
function errorName(e: unknown): string {
  // Structurally, not `instanceof Error` — a WebAuthn/WebCrypto rejection from
  // another realm (Node's webcrypto under jsdom, an iframe) is not an instance
  // of THIS realm's Error, and the whole point of matching on the name is to
  // survive that. Same reasoning as isOperationError in crypto.ts.
  const name = (e as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : '';
}

function classifyCeremonyError(e: unknown, signal: AbortSignal | undefined): Error {
  // «Cancelled» means OUR abort, and nothing else. An AbortError raised while
  // our signal is NOT aborted came from somewhere we do not control (a
  // platform-internal cancel, a competing controller) — calling that a silent
  // user cancel would hide a real failure behind a screen that says nothing.
  if (signal?.aborted) return new QuickUnlockCancelledError();
  // A catch-all BY DESIGN of the spec: cancel, timeout and «no such
  // credential» are indistinguishable, so this may not delete or claim
  // anything.
  if (errorName(e) === 'NotAllowedError') return new QuickUnlockNotCompletedError();
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return new QuickUnlockUnavailableError(
    `Быстрый вход недоступен: ${errorName(e) || String(e)}${typeof message === 'string' ? `: ${message}` : ''}`,
  );
}

function readPrfOutput(credential: PublicKeyCredential): Uint8Array | null {
  const prf = (credential.getClientExtensionResults() as { prf?: PrfExtensionResults }).prf;
  const first = prf?.results?.first;
  return first ? toBytes(first) : null;
}

export interface CreatedPrfCredential {
  /** Raw credential id bytes — encoding is the consumer's policy, not ours. */
  credentialId: Uint8Array;
  /** The output of the CONTROL `get()`, already proven usable. */
  prfOutput: Uint8Array;
}

/**
 * Create a platform credential and return a PRF output that is KNOWN to work.
 *
 * «We never store a blob we have not opened» is the whole point of the second
 * ceremony: `prf.enabled === true` is a promise, not a fact; not every platform
 * returns `results` on create at all; and known WebKit bugs (311099, 314934)
 * have returned garbage and null there. So the seed is wrapped with the output
 * of the CONTROL `get()` — the very path every future unlock will take — which
 * also removes any need to compare two outputs.
 *
 * The price is TWO system prompts during setup (one at unlock). That is a
 * deliberate trade: a blob that cannot be opened is worse than no feature.
 */
export async function createPrfCredential(opts: {
  prfSalt: Uint8Array;
  signal?: AbortSignal;
}): Promise<CreatedPrfCredential> {
  const { prfSalt, signal } = opts;
  assertNotAborted(signal);
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new QuickUnlockUnavailableError('WebAuthn недоступен в этом браузере.');
  }

  let created: PublicKeyCredential | null;
  try {
    created = await navigator.credentials.create({
      signal,
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { id: location.hostname, name: RP_NAME },
        // 32 random bytes, used nowhere else. name/displayName are CONSTANTS:
        // they sync to the credential manager and are visible to the user.
        user: { id: randomBytes(32) as BufferSource, name: RP_NAME, displayName: RP_NAME },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: USER_VERIFICATION,
          // Do not clutter the passkey list, and lower the chance of an
          // accidental deletion. Apple creates a discoverable one anyway —
          // expected, not an error.
          residentKey: 'discouraged',
        },
        attestation: 'none',
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
      } as PublicKeyCredentialCreationOptions,
    } as CredentialCreationOptions) as PublicKeyCredential | null;
  } catch (e) {
    throw classifyCeremonyError(e, signal);
  }
  assertNotAborted(signal);
  if (!created) throw new QuickUnlockUnavailableError('Аутентификатор не создал ключ.');

  // Early diagnosis ONLY — cheap enough to spare the user a second prompt on a
  // platform that has already said no.
  const prf = (created.getClientExtensionResults() as { prf?: PrfExtensionResults }).prf;
  if (prf?.enabled !== true && !prf?.results?.first) {
    throw new QuickUnlockUnavailableError(
      // NO JARGON, and no instruction the reader cannot act on. «PRF» means
      // nothing to a person, and «удалите ключ» is wrong twice over: with
      // residentKey 'discouraged' the credential may be invisible, and a
      // leftover one is harmless — it opens nothing.
      'Не удалось настроить быстрый вход: устройство не выдало нужный ключ. '
      + 'Ничего не сломалось — вход по PIN-коду и seed-фразе работает как обычно. '
      + 'Если в менеджере паролей появился ключ «Matamata Notes», его можно удалить: он ничего не открывает.',
      'no-prf',
    );
  }

  const credentialId = toBytes(created.rawId);
  const prfOutput = await evalPrf({ credentialId, prfSalt, signal });
  return { credentialId, prfOutput };
}

/**
 * The unlock ceremony: one credential id, one salt, one PRF output.
 *
 * `allowCredentials` is always non-empty and `transports: ['internal']` is
 * HARD-CODED rather than remembered from the record — part of the local-only
 * contract. A synced passkey may also be reachable over `hybrid` (the QR /
 * phone flow), and this hint steers the sheet away from it. It is a UX hint,
 * not a security boundary: a client may ignore it, and nothing rests on it —
 * the PRF output requires UV regardless, and the BLOB is local.
 */
export async function evalPrf(opts: {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const { credentialId, prfSalt, signal } = opts;
  assertNotAborted(signal);
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new QuickUnlockUnavailableError('WebAuthn недоступен в этом браузере.');
  }

  let assertion: PublicKeyCredential | null;
  try {
    assertion = await navigator.credentials.get({
      signal,
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource, transports: ['internal'] }],
        userVerification: USER_VERIFICATION,
        timeout: CEREMONY_TIMEOUT_MS,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
      } as PublicKeyCredentialRequestOptions,
    } as CredentialRequestOptions) as PublicKeyCredential | null;
  } catch (e) {
    throw classifyCeremonyError(e, signal);
  }
  assertNotAborted(signal);
  if (!assertion) throw new QuickUnlockUnavailableError('Аутентификатор не вернул ответ.');

  const prfOutput = readPrfOutput(assertion);
  // No output ⇒ UNAVAILABLE, never a key mismatch: nothing was decrypted, so
  // there is nothing to conclude about the stored record — and a record must
  // never be dropped over a platform that simply did not answer.
  if (!prfOutput) {
    throw new QuickUnlockUnavailableError(
      'Устройство не выдало нужный ключ. Войдите по PIN-коду — он работает как обычно.',
      'no-prf',
    );
  }
  return prfOutput;
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
