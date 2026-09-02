/**
 * Eternal Notes — Arweave Transport Module
 *
 * All uploads go through a Cloudflare Worker proxy (server pays AR).
 * Downloads use Arweave GraphQL API directly.
 *
 * No wallet management — auth via Ed25519 signature + server-side allowlist.
 */

import type {
  EncryptedNote,
  NoteVersionMeta,
  EncryptedSafeboxEntry,
  SafeboxEntryData,
} from './crypto';
import {
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  UnsupportedNoteVersionError,
} from './crypto';
import { TRUSTED_OWNERS, assertTrustedOwners } from './config';
import { INDEX_QUERY_URL, PAYLOAD_GATEWAYS, QUORUM_POLICY_ID, STATUS_GATEWAYS } from './gateways';
import { serializeStatusOrigins } from './gateways-parse';
import { statusVerdict, toTxStatusKind, type StatusVote } from './status-quorum';
import {
  HEADER_CAP_BYTES,
  TXID_RE,
  isRejection,
  parseTxHeader,
  readVerifiedTags,
  verifyBytes,
  verifyHeader,
  type Rejection,
  type TxHeader,
} from './tx-verify';

// ─── Config ──────────────────────────────────────────────────────────

// Normalized to the bare origin: paths are concatenated onto this value and the
// CSP pins only the origin, so a trailing slash / path / credentials in the env
// var would produce requests the CSP (or fetch) rejects. The build validates the
// same rule (scripts/proxy-origin.mjs); this is the runtime belt-and-braces.
const PROXY_URL = (() => {
  const raw = import.meta.env.VITE_PROXY_URL || '';
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return ''; // unusable value → behaves as "proxy not configured"
  }
})();
export const APP_NAME = 'EternalNotes';
export const APP_VERSION = '1';

// Supported data format versions for READING (reader-before-writer): v4
// safebox entries are accepted here before SAFEBOX_WRITER_ENABLED flips, so a
// restore on R4 already brings the safebox back.
const SUPPORTED_VERSIONS = new Set(['1', '2', '3', '4']);

/** A note recovered from Arweave: the record to persist, its decrypted text and
 *  the version-chain meta (synthesized for v1/v2) — restore must carry the meta
 *  through to the UI or chains would degrade to per-version cards. */
export interface RestoredNote {
  encrypted: EncryptedNote;
  text: string;
  txId: string;
  meta: NoteVersionMeta;
}

/**
 * Build the proxy upload payload for a note, serializing per its OWN version.
 * A v2/v3 note is ALWAYS sent under its own App-Version (5 tags, no Timestamp,
 * {id,c,iv}); a v1 note as v1 — a restored envelope ciphertext can never be
 * re-published under the wrong version.
 *
 * FAIL CLOSED on an unknown runtime `v` (P0): the legacy behavior "everything
 * that is not v2 goes out as v1" would let a record with v:4 (or a corrupted
 * string) be permanently committed as a paid v1 transaction. Unknown version →
 * typed throw; the queue quarantines the record without any HTTP.
 */
export function buildUploadPayload(
  note: EncryptedNote,
  ownerHash: string,
  now: number,
  recheck = false,
  recovery?: RecoveryHint,
): ProxyUploadPayload {
  const v = note.v;
  if (v !== undefined && v !== 1 && v !== 2 && v !== 3) {
    throw new UnsupportedNoteVersionError(v);
  }
  const hasTimestamp = v === undefined || v === 1;
  const versionTag = hasTimestamp ? APP_VERSION : String(v);

  const data = hasTimestamp
    ? JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv, t: note.createdAt })
    : JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv });

  const tags = [
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: versionTag },
    { name: 'Owner-Hash', value: ownerHash },
    { name: 'Content-Type', value: 'application/json' },
    ...(hasTimestamp ? [{ name: 'Timestamp', value: note.createdAt.toString() }] : []),
    { name: 'Note-Id', value: note.noteId },
  ];

  const payload: ProxyUploadPayload = { data, tags, ownerHash, timestamp: now };
  if (recheck) payload.recheck = true;
  if (recheck && recovery) payload.recovery = recovery;
  return payload;
}

/**
 * Build the proxy upload payload for a SAFEBOX entry (App-Version=4): the same
 * 5 tags as v2/v3 with a SPLIT-ENVELOPE data object `{id,mc,miv,sc,siv}` — both
 * ciphertexts travel in ONE transaction, so a version can never end up on-chain
 * with only half of itself.
 *
 * Fail-closed on an unexpected runtime `v`, exactly like the notes builder: a
 * mis-serialized record would be permanently committed under the per-id
 * idempotency.
 */
export function buildSafeboxUploadPayload(
  entry: EncryptedSafeboxEntry,
  ownerHash: string,
  now: number,
  recheck = false,
  recovery?: RecoveryHint,
): ProxyUploadPayload {
  if (entry.v !== 4) throw new UnsupportedSafeboxVersionError(entry.v);

  const data = JSON.stringify({
    id: entry.entryId,
    mc: entry.metaCiphertext,
    miv: entry.metaIv,
    sc: entry.secretCiphertext,
    siv: entry.secretIv,
  });

  const tags = [
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: SAFEBOX_APP_VERSION },
    { name: 'Owner-Hash', value: ownerHash },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Note-Id', value: entry.entryId },
  ];

  const payload: ProxyUploadPayload = { data, tags, ownerHash, timestamp: now };
  if (recheck) payload.recheck = true;
  if (recheck && recovery) payload.recovery = recovery;
  return payload;
}

export const SAFEBOX_APP_VERSION = '4';

/** A stored safebox record whose `v` this build cannot serialize (written by a
 *  newer client). Quarantined locally — never uploaded. */
export class UnsupportedSafeboxVersionError extends Error {
  constructor(v: unknown) {
    super(`Unsupported safebox entry version: ${String(v)}`);
    this.name = 'UnsupportedSafeboxVersionError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────

/** Opaque, server-HMAC-signed recovery hint for a lost-anchor upload. */
export interface RecoveryHint {
  txId: string;
  postedAt: number;
  token: string;
}

export interface ProxyUploadPayload {
  data: string;
  tags: { name: string; value: string }[];
  ownerHash: string;
  timestamp: number;
  /** Ask the server to re-verify a committed TX and re-post if it was dropped.
   *  Reconciliation is server-authoritative (the DO records the posted txId), so
   *  the client never supplies a raw txId here. */
  recheck?: boolean;
  /** Server-signed recovery hint from a prior triple-failure upload (echoed back
   *  on recheck so the server can reconcile without a duplicate re-post). */
  recovery?: RecoveryHint;
}

export type UploadResult =
  | { kind: 'accepted'; txId: string; committed: boolean; recovery?: RecoveryHint }
  | { kind: 'rate_limited'; error: string }
  | { kind: 'not_registered'; error: string }
  | { kind: 'in_progress'; error: string }
  | { kind: 'unavailable'; error: string } // 503 — retryable (recheck deferred / gateway)
  /** 503 {code:'v3_uploads_disabled'} — the worker's v3 kill switch is on.
   *  NOT an error state: the client pauses its whole v3 queue (persisted
   *  pause marker) and resumes via /health or manual retry. Registration and
   *  recovery/txId state MUST survive this untouched. */
  | { kind: 'v3_disabled'; error: string }
  /** 503 {code:'v4_uploads_disabled'} — the worker's SAFEBOX kill switch is on.
   *  Same contract as v3_disabled, on its own independent pause marker. */
  | { kind: 'v4_disabled'; error: string }
  /** 503 {code:'uploads_disabled'} — the GLOBAL kill switch (§1.9). Unlike the
   *  per-version switches this stops v1–v4 alike, before the body is read, so
   *  the client pauses EVERY version rather than retrying the backlog against a
   *  worker that refuses all of it. */
  | { kind: 'uploads_disabled'; error: string }
  /** 400 {code:'recovery_invalid'} — the server REJECTED the signed recovery
   *  proof (forged, corrupt, or signed under a rotated key). PERMANENT for
   *  this record: a retry reproduces the same rejection, so the caller
   *  quarantines it (terminalError:'recovery_invalidated') instead of
   *  rechecking a guaranteed failure forever. NO duplicate paid TX happened —
   *  the server released the reservation before answering. */
  | { kind: 'recovery_invalid'; error: string }
  | { kind: 'error'; error: string };

export type RegistrationStatus = 'allowed' | 'denied' | 'unavailable' | 'invalid_request';

/** Registration check verdict + the raw server text for non-ok answers, so the
 *  UI can surface actionable hints (e.g. the L13 clock-skew message) instead of
 *  a silent generic failure. */
export interface RegistrationCheck {
  status: RegistrationStatus;
  message?: string;
}

// ─── Network Status ──────────────────────────────────────────────────

/**
 * Online iff AT LEAST ONE status gateway answers — `Promise.any` over the pool.
 *
 * Each probe THROWS on a non-ok response, which is load-bearing: `fetch` does
 * not reject on HTTP 500, so a naive `Promise.any` would settle on the first
 * fast 500 and report "offline" while a healthy gateway was still answering.
 */
export async function isArweaveOnline(): Promise<boolean> {
  try {
    await Promise.any(
      STATUS_GATEWAYS.map(async (origin) => {
        const response = await fetch(`${origin}/info`, {
          method: 'GET',
          redirect: 'error', // a redirect to another gateway is not this one being up
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`gateway ${origin} answered ${response.status}`);
        return true;
      }),
    );
    return true;
  } catch {
    return false; // AggregateError: every gateway failed
  }
}

// ─── TX Status ──────────────────────────────────────────────────────

interface TxStatusResponse {
  block_height: number;
  number_of_confirmations: number;
}

export type TxStatusResult =
  | { kind: 'confirmed'; confirmations: number; blockHeight: number }
  | { kind: 'pending' }     // accepted, not yet mined
  | { kind: 'dropped' }     // not found — fell out of the mempool
  | { kind: 'invalid' }     // malformed tx id
  | { kind: 'unavailable' };// gateway degraded — status unknown

/**
 * First 16 hex of SHA-256 over the canonical, SORTED status-origin list — the
 * value /health attests. Computing it here from the CLIENT's own configuration
 * is what turns the attestation into an agreement check rather than a report.
 */
async function statusGatewaysHash(): Promise<string> {
  const bytes = new TextEncoder().encode(serializeStatusOrigins(STATUS_GATEWAYS));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Best-effort read of a capped response body. `null` = over the cap. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** A status body is at most a couple of hundred bytes; anything larger is a
 *  gateway defect, not a status. */
const STATUS_BODY_CAP_BYTES = 1024;

/** One origin's answer, mapped onto the shared vote vocabulary.
 *  NOTHING here decides the verdict — that is `statusVerdict`'s job alone. */
async function probeStatus(origin: string, txId: string): Promise<StatusVote> {
  try {
    const response = await fetch(`${origin}/tx/${txId}/status`, {
      method: 'GET',
      // NO REDIRECTS. `fetch` follows them by default, so a gateway answering
      // 302 -> another gateway would have TWO configured origins reporting the
      // opinion of ONE host — and unanimity over the pool is exactly what
      // authorizes a paid redrop. A redirect is not an answer.
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 202) return { origin, kind: 'pending' };
    if (response.status === 404) return { origin, kind: 'dead404' };
    // 400/429/5xx all land here: `other` is never alive, and it makes `dead`
    // unreachable this round — which is the entire point (a 400 must never
    // authorize a paid re-post).
    // Strictly 200, matching the Worker: a 201/206 is not a status answer, and
    // the two halves must classify identically or the shared formula is a lie.
    if (response.status !== 200) return { origin, kind: 'other' };
    const body = await readCapped(response, STATUS_BODY_CAP_BYTES);
    if (body === null) return { origin, kind: 'other' };
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== 'object' || parsed === null) return { origin, kind: 'other' };
    const data = parsed as Partial<TxStatusResponse>;
    // A 200 whose body fails the schema is a PROTOCOL defect: not alive, and a
    // non-404 outcome for the quorum.
    if (!isSafeCount(data.number_of_confirmations) || !isSafeCount(data.block_height)) {
      return { origin, kind: 'other' };
    }
    return {
      origin,
      kind: 'confirmed',
      confirmations: data.number_of_confirmations,
      blockHeight: data.block_height,
    };
  } catch {
    return { origin, kind: 'other' }; // timeout / network / malformed JSON
  }
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Finalization status by QUORUM over every configured status gateway.
 *
 * `invalid` is now a purely LOCAL verdict — a txId that is not 43 base64url
 * characters, decided without touching the network. A gateway's 400 is
 * `unavailable`, never `invalid`: under the old single-gateway contract a 400
 * fed `needsRecheck`, i.e. the paid re-post path, on nothing more than one
 * host's opinion.
 *
 * The verdict itself comes from the shared table (status-quorum.ts), the same
 * code the Worker runs, with one vote per configured origin.
 */
export async function getTxStatus(txId: string): Promise<TxStatusResult> {
  if (!TXID_RE.test(txId)) return { kind: 'invalid' };
  const votes = await Promise.all(STATUS_GATEWAYS.map(origin => probeStatus(origin, txId)));
  const verdict = statusVerdict(STATUS_GATEWAYS, votes);
  if (verdict.kind === 'confirmed') {
    return { kind: 'confirmed', confirmations: verdict.confirmations, blockHeight: verdict.blockHeight };
  }
  return { kind: toTxStatusKind(verdict.kind) } as TxStatusResult;
}

// ─── Registration ────────────────────────────────────────────────────

/**
 * Check if publicKey is in server-side allowlist.
 * Returns 4-state:
 *   - 'allowed': 200 { allowed: true } — publicKey in allowlist
 *   - 'denied': 200 { allowed: false } — not in allowlist
 *   - 'unavailable': 5xx, 429, network error — server issue
 *   - 'invalid_request': 4xx (except 429) — client bug (bad sig, bad JSON)
 */
export async function checkRegistration(
  publicKeyB64: string,
  signature: string,
  bodyText: string,
): Promise<RegistrationCheck> {
  if (!PROXY_URL) return { status: 'unavailable' };

  try {
    const response = await fetch(`${PROXY_URL}/check-registration`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': publicKeyB64,
        'X-Signature': signature,
      },
      body: bodyText,
    });

    if (response.ok) {
      const data = await response.json();
      return { status: data.allowed ? 'allowed' : 'denied' };
    }

    const text = await response.text().catch(() => '');

    // 4xx (except 429) = client-side problem — keep the server text: a
    // "timestamp expired / clock skew" 401 is user-actionable (L13).
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      console.error(`checkRegistration: client error ${response.status}: ${text}`);
      return { status: 'invalid_request', message: text };
    }

    // 429 or 5xx = transient server issue
    return { status: 'unavailable', message: text };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Register publicKey via invite code.
 * Invite is consumed atomically on server.
 */
export async function registerWithProxy(
  bodyText: string,
  publicKeyB64: string,
  signature: string,
): Promise<{ ok: true } | { error: string }> {
  if (!PROXY_URL) return { error: 'Proxy URL not configured' };

  try {
    const response = await fetch(`${PROXY_URL}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': publicKeyB64,
        'X-Signature': signature,
      },
      body: bodyText,
    });

    if (!response.ok) {
      const text = await response.text();
      return { error: `Registration failed: ${text}` };
    }

    return response.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Network error' };
  }
}

// ─── Upload via Proxy ────────────────────────────────────────────────

/**
 * Upload encrypted note data via Cloudflare Worker proxy.
 * Server handles Arweave TX creation and payment.
 */
export async function uploadViaProxy(
  bodyText: string,
  publicKeyB64: string,
  signature: string,
): Promise<UploadResult> {
  if (!PROXY_URL) return { kind: 'error', error: 'Proxy URL not configured' };

  try {
    const response = await fetch(`${PROXY_URL}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Public-Key': publicKeyB64,
        'X-Signature': signature,
      },
      body: bodyText,
    });

    if (response.ok) {
      const data = await response.json();
      // committed:false means the TX posted but the server's idempotency record
      // isn't confirmed yet → caller keeps needsRecheck.
      return {
        kind: 'accepted',
        txId: data.txId,
        committed: data.committed !== false,
        recovery: data.recovery,
      };
    }

    // Structured error classification by HTTP status (not text)
    const text = await response.text();
    if (response.status === 429) return { kind: 'rate_limited', error: text };
    if (response.status === 403) return { kind: 'not_registered', error: text };
    if (response.status === 409) return { kind: 'in_progress', error: text };
    if (response.status === 503) {
      // The kill switches answer 503 with a machine-readable JSON code; a
      // plain-text 503 stays the generic retryable 'unavailable'.
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
          const code = (parsed as { code?: unknown }).code;
          if (code === 'uploads_disabled') return { kind: 'uploads_disabled', error: text };
          if (code === 'v3_uploads_disabled') return { kind: 'v3_disabled', error: text };
          if (code === 'v4_uploads_disabled') return { kind: 'v4_disabled', error: text };
        }
      } catch { /* not JSON → generic 503 */ }
      return { kind: 'unavailable', error: text }; // retryable
    }
    if (response.status === 400) {
      // Both worker branches of «Invalid recovery token» answer 400 with a
      // machine code; any other 400 stays the generic (retryable-by-user) error.
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null
            && (parsed as { code?: unknown }).code === 'recovery_invalid') {
          return { kind: 'recovery_invalid', error: text };
        }
      } catch { /* not JSON → generic 400 */ }
    }
    return { kind: 'error', error: `HTTP ${response.status}: ${text}` };
  } catch (e) {
    // A network exception is transient/retryable — classify as unavailable so the
    // caller preserves an accepted TX rather than downgrading it to a hard error.
    return { kind: 'unavailable', error: e instanceof Error ? e.message : 'Network error' };
  }
}

// ─── Worker capabilities (/health) ──────────────────────────────────

export type UploadsCapability = 'enabled' | 'disabled' | 'unknown';

/** One /health probe answers for EVERY gated version. Each verdict is
 *  independent: an old worker that knows v3 but not v4 reports
 *  `{v3:'enabled', v4:'unknown'}` and the v4 pause stays up (fail closed). */
export interface WorkerCapabilities {
  /** The GLOBAL switch on its own. Needed to lift the global pause marker
   *  when `uploads` is back on while BOTH version switches stay off — v1/v2
   *  are allowed again in that state, and deriving «global is fine» from
   *  «some version is enabled» could never say so. */
  uploads: UploadsCapability;
  v3: UploadsCapability;
  v4: UploadsCapability;
}

const UNKNOWN_CAPABILITIES: WorkerCapabilities = { uploads: 'unknown', v3: 'unknown', v4: 'unknown' };

/**
 * Strictly-validated /health probe used to lift a persisted upload pause.
 * A version is 'enabled' ONLY when ok===true AND `versions` includes it AND its
 * own `vNUploads` flag is exactly true — `versions` describes the ACCEPTOR and
 * still lists the version while its kill switch is off, so it can never be the
 * sole resume condition. A network error, an old worker ({ok:true} without the
 * fields) or a malformed body all yield 'unknown' — the pause stays.
 */
export async function getWorkerCapabilities(): Promise<WorkerCapabilities> {
  if (!PROXY_URL) return UNKNOWN_CAPABILITIES;

  const expectedHash = await statusGatewaysHash();
  // ONE budget for the whole probe. Three attempts with a 15 s timeout EACH
  // would let a stalled worker hold the caller for 45 s — the deadline is the
  // total, and the per-attempt timeout only bounds a single request within it.
  const deadline = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    if (deadline.aborted) break;
    // A NEW nonce every attempt: reusing one would let a retry reproduce the
    // very cached answer the retry exists to get past.
    const nonce = randomNonce();
    try {
      const response = await fetch(`${PROXY_URL}/health?nonce=${nonce}`, {
        method: 'GET',
        // Belt and braces with the server's own no-store: this answer decides
        // whether a persisted upload pause may be lifted.
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(HEALTH_ATTEMPT_TIMEOUT_MS)]),
      });
      // Strictly 200: a 201/206 carrying a plausible body must not lift a
      // persisted pause. Fail-closed means exactly the expected answer.
      if (response.status !== 200) continue;
      const body = await readCapped(response, HEALTH_CAP_BYTES);
      if (body === null) continue; // over the ceiling — not a health answer
      const verdict = readCapabilities(JSON.parse(new TextDecoder().decode(body)), nonce, expectedHash);
      if (verdict !== null) return verdict;
    } catch {
      // network / timeout / malformed JSON — try again, then give up closed
    }
  }
  return UNKNOWN_CAPABILITIES;
}

/** How many /health attempts before the pause simply stays up. */
const HEALTH_ATTEMPTS = 3;
const HEALTH_TIMEOUT_MS = 15_000;
/** Bound on ONE attempt, inside the shared budget above. */
const HEALTH_ATTEMPT_TIMEOUT_MS = 7_000;
/** A health body is a few hundred bytes; anything larger is not one. */
const HEALTH_CAP_BYTES = 8192;

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The normative capability table. Checks run IN ORDER and the first failure
 * decides; `null` means «this answer proved nothing, try again».
 *
 *   1. exact nonce echo      — proves the answer is FRESH, not merely uncached
 *   2. ok === true
 *   3. statusQuorumPolicy    — the worker implements the semantics we expect
 *   4. gateway hash + count  — client and worker agree on the SAME pool
 *   5. version ∈ versions
 *   6. uploads / vNUploads are strictly boolean
 *   7. both true → enabled; either strictly false → disabled
 *
 * `disabled` is reported ONLY for a fresh, fully validated answer whose flag is
 * strictly `false`. Anything missing, malformed or unverifiable is `unknown`,
 * which leaves the pause up — the global `uploads` switch is exactly what an
 * emergency build sets, so misreading it would resume uploads against a worker
 * that refuses them all.
 */
function readCapabilities(data: unknown, nonce: string, expectedHash: string): WorkerCapabilities | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.nonce !== nonce) return null;                       // stale or unproven
  if (d.ok !== true) return UNKNOWN_CAPABILITIES;
  if (d.statusQuorumPolicy !== QUORUM_POLICY_ID) return UNKNOWN_CAPABILITIES;
  if (d.statusGatewaysHash !== expectedHash) return UNKNOWN_CAPABILITIES;
  if (d.statusGatewaysCount !== STATUS_GATEWAYS.length) return UNKNOWN_CAPABILITIES;

  const versions = d.versions;
  const readOne = (version: string, flag: unknown): UploadsCapability => {
    if (!Array.isArray(versions) || !versions.includes(version)) return 'unknown';
    // Strictly boolean, checked BEFORE the conjunction below: a missing or
    // garbage flag must read as unknown, never as a decision.
    if (typeof d.uploads !== 'boolean' || typeof flag !== 'boolean') return 'unknown';
    return d.uploads && flag ? 'enabled' : 'disabled';
  };
  // The global flag is read on the same fresh, validated answer, and with
  // the same strictness: a missing or non-boolean value is unknown.
  const uploads: UploadsCapability = typeof d.uploads !== 'boolean' ? 'unknown' : (d.uploads ? 'enabled' : 'disabled');
  return { uploads, v3: readOne('3', d.v3Uploads), v4: readOne('4', d.v4Uploads) };
}

// ─── Download (Restore from Arweave) ─────────────────────────────────

interface ArweaveEdge {
  cursor: string;
  node: {
    id: string;
    tags: { name: string; value: string }[];
  };
}

/**
 * Fetch a single page of transactions from Arweave GraphQL.
 */
/** Combine the per-request deadline with the caller's abort signal (lock
 *  aborts the whole restore sweep; the timeout still bounds each request). */
function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchPage(
  ownerHash: string,
  after: string | null,
  signal?: AbortSignal
): Promise<{ edges: ArweaveEdge[]; hasNextPage: boolean }> {
  // `owners` and the tag filters are a WORK REDUCTION, not a trust boundary.
  //
  // This comment used to claim the filter is what stops squatted/replayed
  // Note-Ids — which was misleading (F1): nothing forces a gateway to honour
  // `owners:`, and an index that ignores it would hand us a stranger's edge
  // with no way to tell. Trust now comes from D9 instead: every candidate's
  // header is verified against the requested txId and its wallet address is
  // checked against TRUSTED_OWNERS before a single byte is decrypted, and
  // attribution is read from the SIGNED tags rather than from this edge.
  // Getting the filter wrong can therefore only cost extra work, never
  // acceptance.
  const query = `query($ownerHash: [String!]!, $appName: [String!]!, $owners: [String!]!, $after: String) {
    transactions(
      owners: $owners,
      tags: [
        { name: "App-Name", values: $appName },
        { name: "Owner-Hash", values: $ownerHash }
      ],
      sort: HEIGHT_DESC,
      first: 100,
      after: $after
    ) {
      edges {
        cursor
        node { id, tags { name, value } }
      }
      pageInfo { hasNextPage }
    }
  }`;

  const variables = {
    ownerHash: [ownerHash],
    appName: [APP_NAME],
    owners: TRUSTED_OWNERS,
    after: after,
  };

  // The index endpoint is configuration now (INDEX_SOURCES, D8). PR-3a still
  // queries ONE index — the union across logical sources is PR-4 — so this is
  // the first URL of the first source, which defaults to arweave.net/graphql
  // and keeps the single-index edge order byte-identical.
  const response = await fetch(INDEX_QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    // A hung gateway must not pin the UI in «Восстанавливаем…» forever; the
    // caller treats an aborted page as a partial restore (incomplete=true).
    signal: requestSignal(GRAPHQL_TIMEOUT_MS, signal),
  });

  if (!response.ok) {
    throw new Error(`GraphQL error: ${response.status}`);
  }

  // Streamed under a cap, then shape-checked: `response.json()` is `any`, and
  // a page whose edges are not what the loop expects would either throw in
  // the middle of the walk or be swallowed as «nothing more». Both read as a
  // broken index, which is a fetch failure like any other.
  const body = await readCapped(response, GRAPHQL_BODY_CAP_BYTES);
  if (body === null) throw new Error('GraphQL page exceeds the size cap');
  const page = parseGraphQLPage(new TextDecoder().decode(body));
  if (page === null) throw new Error('GraphQL page failed the schema');
  return page;
}

/** Runtime schema for one index page. Anything off-shape is null. */
function parseGraphQLPage(text: string): { edges: ArweaveEdge[]; hasNextPage: boolean } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const tx = (parsed as { data?: { transactions?: unknown } } | null)?.data?.transactions;
  if (typeof tx !== 'object' || tx === null) return null;
  const t = tx as { edges?: unknown; pageInfo?: { hasNextPage?: unknown } };
  if (!Array.isArray(t.edges) || typeof t.pageInfo?.hasNextPage !== 'boolean') return null;
  const edges: ArweaveEdge[] = [];
  for (const e of t.edges) {
    const edge = e as { cursor?: unknown; node?: { id?: unknown; tags?: unknown } };
    if (typeof edge?.cursor !== 'string' || typeof edge.node?.id !== 'string') return null;
    if (!Array.isArray(edge.node.tags)) return null;
    for (const tag of edge.node.tags) {
      const tg = tag as { name?: unknown; value?: unknown };
      if (typeof tg?.name !== 'string' || typeof tg.value !== 'string') return null;
    }
    edges.push({ cursor: edge.cursor, node: { id: edge.node.id, tags: edge.node.tags as { name: string; value: string }[] } });
  }
  return { edges, hasNextPage: t.pageInfo.hasNextPage };
}

/** A safebox entry recovered from Arweave. The record to persist plus its
 *  decrypted META. The SECRET plaintext is deliberately absent: restore
 *  decrypts it only to VALIDATE the candidate and drops it immediately — only
 *  ciphertext is ever carried out of the sweep. */
export interface RestoredSafeboxEntry {
  encrypted: EncryptedSafeboxEntry;
  meta: SafeboxEntryData;
  txId: string;
}

/** Keys the restore sweep needs. Notes and safebox halves are separate HKDF
 *  domains; a missing safebox pair simply means v4 candidates are skipped. */
export interface RestoreKeyring {
  note: CryptoKey;
  safeboxMeta: CryptoKey;
  /** Used ONLY to prove a v4 candidate decrypts in BOTH halves. */
  safeboxSecret: CryptoKey;
}

/**
 * The GraphQL index could not be reached AT ALL: the very FIRST page failed
 * while the caller was still interested. Nothing was retrieved, so reporting a
 * PARTIAL sweep would be a lie — a plain offline device would be told «часть
 * данных недоступна» instead of «не удалось».
 *
 * Deliberately NOT raised on `signal.aborted`: a lock/reset cancels the sweep
 * through the SAME signal a timeout uses (requestSignal composes both with
 * AbortSignal.any), so the two are indistinguishable by error type. An aborted
 * sweep keeps the silent path — its caller already stood down, and turning that
 * into a throw would log a failure for a perfectly normal lock.
 */
export class ArweaveIndexUnavailableError extends Error {
  constructor() {
    super('Arweave GraphQL index unreachable');
    this.name = 'ArweaveIndexUnavailableError';
  }
}

/** Result of a restore sweep. `incomplete` = some pages or payloads could not
 *  be FETCHED (network/gateway) — real records may be missing, tell the user.
 *  Garbage/replay candidates that fail validation or decryption are intentional
 *  skips and do NOT set the flag. A total failure of the FIRST page is NOT
 *  reported here at all — it throws ArweaveIndexUnavailableError. */
export interface FetchAllNotesResult {
  notes: RestoredNote[];
  safeboxEntries: RestoredSafeboxEntry[];
  incomplete: boolean;
  /** Per-gateway count of D9 verification failures during THIS sweep.
   *
   *  LOCAL DIAGNOSTIC ONLY — nothing is transmitted. D5 keeps telemetry
   *  server-side, and this verification runs in the client, so the fleet-wide
   *  `payload_hash_mismatch` KPI of the plan is knowingly NOT obtainable here;
   *  the gap is recorded rather than papered over with a client beacon. Absent
   *  when nothing failed. */
  gatewayMismatches?: Readonly<Record<string, number>>;
}

/** How many note payloads are fetched+decrypted concurrently during restore.
 *  Bounded pool: fast enough to kill the old N+1 sequential latency, small
 *  enough not to hammer the gateway from a mobile connection. */
const RESTORE_CONCURRENCY = 5;

/** Per-request deadlines for the restore sweep — without them a stalled
 *  connection leaves the restore banner spinning indefinitely. */
const GRAPHQL_TIMEOUT_MS = 20_000;
/**
 * Bounds on the index walk (P2 review). An index is one more party that can
 * misbehave, and the loop below used to trust it without limit: a page that
 * never stops claiming `hasNextPage`, a cursor that repeats, or a body of any
 * size would run the sweep forever or exhaust memory. Each bound turns that
 * into an INCOMPLETE sweep — which the UI already knows how to say — never
 * into a hang.
 */
const GRAPHQL_BODY_CAP_BYTES = 512 * 1024; // 100 edges × ~0.5 KB is ~50 KB; ×10 headroom
const INDEX_MAX_PAGES = 200;               // 20 000 candidates at `first: 100`
const INDEX_MAX_CANDIDATES = 20_000;
const INDEX_DEADLINE_MS = 120_000;
const PAYLOAD_TIMEOUT_MS = 20_000;

interface RestoreCandidate {
  txId: string;
  version: string;
  noteId: string;
  /** Sentinel: the payload is already held locally (decrypted once through the
   *  full pipeline), so it is not fetched — but the candidate STAYS in the
   *  ordered list and claims its Note-Id at its position, keeping duplicate
   *  resolution bit-identical to a full sweep. */
  known: boolean;
}

/** What the caller knows about an already-held transaction. The sweep treats a
 *  txId as known ONLY when the edge's Note-Id tag and version class match this
 *  record too — a corrupted sync record must not be able to declare someone
 *  else's TX known. */
export interface KnownTxRecord {
  noteId: string;
  kind: 'note' | 'safebox';
}


/** Hard ceiling on a `/raw` body. The writer cannot publish more than
 *  MAX_BODY_BYTES (51200), so 64 KiB is generous — and without a cap D9 would
 *  have to hold whatever a hostile gateway decided to send. */
const RAW_CAP_BYTES = 65536;

/** Whole-candidate budget across BOTH pool passes (header + raw).
 *  Per-request timeouts alone would allow 4 gateways x 20 s x 2 phases on a
 *  single candidate; the observed worst cold path is 12–16 s for one gateway,
 *  so this leaves room for two and then gives up. */
const PAYLOAD_DEADLINE_MS = 45_000;

type PayloadOutcome =
  | { kind: 'verified'; header: TxHeader; bytes: Uint8Array }
  /** Authenticated, but not ours (untrusted wallet / foreign tags). Every honest
   *  gateway returns the same thing, so the pool stops — and the sweep is NOT
   *  incomplete, because nothing was lost. */
  | { kind: 'skip' }
  /** Every gateway failed or lied. A real note may be unreachable → incomplete. */
  | { kind: 'unavailable' };

/**
 * The payload pool for ONE sweep: gateway iteration, D9, and an in-flight cache.
 *
 * The cache holds PROMISES, not results, so five restore workers meeting the
 * same repeated txId run one pipeline rather than five. Terminal outcomes
 * (verified / skip) stay cached; a transient `unavailable` is EVICTED so a
 * later duplicate may try again instead of inheriting a network blip.
 *
 * Scope is one `fetchAllNotes` call by construction — it is created there and
 * dies with it, so it can never span a vault change or outlive a reset.
 */
function createPayloadPool(ownerAddresses: readonly string[]) {
  const inFlight = new Map<string, Promise<PayloadOutcome>>();
  const mismatches = new Map<string, number>();

  const countMismatch = (origin: string) =>
    mismatches.set(origin, (mismatches.get(origin) ?? 0) + 1);

  async function fetchBody(
    origin: string,
    path: string,
    cap: number,
    signal: AbortSignal | undefined,
    deadline: AbortSignal,
  ): Promise<Uint8Array | null> {
    try {
      const composed = signal
        ? AbortSignal.any([signal, deadline, AbortSignal.timeout(PAYLOAD_TIMEOUT_MS)])
        : AbortSignal.any([deadline, AbortSignal.timeout(PAYLOAD_TIMEOUT_MS)]);
      const response = await fetch(`${origin}${path}`, { signal: composed, redirect: 'error' });
      if (response.status !== 200) return null;
      return await readCapped(response, cap);
    } catch {
      return null;
    }
  }

  async function resolve(txId: string, signal: AbortSignal | undefined): Promise<PayloadOutcome> {
    // Decided WITHOUT a request: a txId that is not 43 base64url characters
    // cannot name an Arweave transaction, so asking any gateway about it is
    // pure waste — and it is a skip, not a fetch failure.
    if (!TXID_RE.test(txId)) return { kind: 'skip' };
    const deadline = AbortSignal.timeout(PAYLOAD_DEADLINE_MS);

    // Pass 1 — a header that survives every body-independent step of D9.
    // A gateway answering with a self-consistent header for a DIFFERENT txId
    // must not end the search: the loop continues to the next gateway.
    let header: TxHeader | null = null;
    for (const origin of PAYLOAD_GATEWAYS) {
      if (signal?.aborted || deadline.aborted) break;
      const body = await fetchBody(origin, `/tx/${txId}`, HEADER_CAP_BYTES, signal, deadline);
      if (body === null) continue;
      const parsed = parseTxHeader(new TextDecoder().decode(body));
      if (parsed === null) { countMismatch(origin); continue; }
      const rejection: Rejection | null = await verifyHeader(txId, parsed, ownerAddresses);
      if (rejection === null) { header = parsed; break; }
      if (rejection.kind === 'skip') return { kind: 'skip' };
      countMismatch(origin);
    }
    if (header === null) return { kind: 'unavailable' };

    // Pass 2 — bytes that hash to this header. The two may come from DIFFERENT
    // gateways: the protocol binds them cryptographically, so mixing sources is
    // safe by construction.
    for (const origin of PAYLOAD_GATEWAYS) {
      if (signal?.aborted || deadline.aborted) break;
      const bytes = await fetchBody(origin, `/raw/${txId}`, RAW_CAP_BYTES, signal, deadline);
      if (bytes === null) continue;
      if ((await verifyBytes(header, bytes)) === null) return { kind: 'verified', header, bytes };
      // A 200 with a corrupted, truncated or foreign body does NOT stop the
      // search — a later gateway's valid answer neutralizes this one.
      countMismatch(origin);
    }
    return { kind: 'unavailable' };
  }

  return {
    fetchVerified(txId: string, signal: AbortSignal | undefined): Promise<PayloadOutcome> {
      const cached = inFlight.get(txId);
      if (cached) return cached;
      const pending = resolve(txId, signal).catch((): PayloadOutcome => (
        // TOTAL: a raised candidate is unavailable. Letting it escape would
        // reject the cached promise and take every other candidate down with it.
        { kind: 'unavailable' }
      )).then((outcome) => {
        // Transient failures must not poison a later retry of the same txId.
        if (outcome.kind === 'unavailable') inFlight.delete(txId);
        return outcome;
      });
      inFlight.set(txId, pending);
      return pending;
    },
    /** Host → count, empty when nothing failed. Local diagnostic only (D5). */
    snapshot(): Record<string, number> | undefined {
      return mismatches.size > 0 ? Object.fromEntries(mismatches) : undefined;
    },
  };
}

/**
 * Fetch all encrypted notes from Arweave for a given owner hash.
 * Pagination is sequential (cursors), payload download + decryption runs in a
 * bounded-parallel pool. Deduplicated by Note-Id, version-gated.
 * `onProgress(done, total)` fires as each candidate settles — the UI shows
 * «Восстановлено N/M». With `opts.known` the sweep is incremental: known txIds
 * become sentinels (not fetched, but still claiming their Note-Id in block
 * order), the progress denominator counts only real downloads, and a fully
 * known selection produces NO progress events at all.
 */
export async function fetchAllNotes(
  ownerHash: string,
  keys: RestoreKeyring,
  onProgress?: (done: number, total: number) => void,
  opts: { signal?: AbortSignal; known?: ReadonlyMap<string, KnownTxRecord> } = {},
): Promise<FetchAllNotesResult> {
  assertTrustedOwners(); // fail-closed: never trust arbitrary on-chain TX
  const { signal, known } = opts;

  let incomplete = false;

  // Phase 1: sequential cursor pagination — collect candidate TXs.
  const candidates: RestoreCandidate[] = [];
  // Note-Ids already claimed by a collected sentinel. Anything with the same id
  // BELOW a sentinel (pages arrive HEIGHT_DESC) would lose the phase-3 claim to
  // it with certainty — the sentinel is known-good — so it is dropped here and
  // never fetched. Ids above a sentinel are unaffected: they are collected
  // before the sentinel is seen.
  const sentinelIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  const indexDeadline = Date.now() + INDEX_DEADLINE_MS;
  while (true) {
    // Every bound below ends the walk as INCOMPLETE rather than looping: a
    // partial sweep is a state the UI already explains; a hung one is not.
    if (pages >= INDEX_MAX_PAGES || candidates.length >= INDEX_MAX_CANDIDATES || Date.now() > indexDeadline) {
      incomplete = true;
      break;
    }
    let edges: ArweaveEdge[];
    let hasNextPage: boolean;

    try {
      const page = await fetchPage(ownerHash, cursor, signal);
      edges = page.edges;
      hasNextPage = page.hasNextPage;
    } catch {
      // FIRST page + the caller still wants the answer → the index is simply
      // unreachable and NOTHING was collected. Hard failure, not «partial».
      // `cursor === null` identifies the first iteration; the abort check keeps
      // a lock/reset on the old silent path (see ArweaveIndexUnavailableError).
      if (cursor === null && !signal?.aborted) throw new ArweaveIndexUnavailableError();
      incomplete = true; // pagination failed — remaining pages unreachable
      break;
    }

    if (edges.length === 0) break;

    for (const edge of edges) {
      const noteIdTag = edge.node.tags.find(t => t.name === 'Note-Id');
      const appNameTag = edge.node.tags.find(t => t.name === 'App-Name');
      const versionTag = edge.node.tags.find(t => t.name === 'App-Version');

      // Skip: wrong app, missing noteId, incompatible version
      if (!appNameTag || appNameTag.value !== APP_NAME) continue;
      if (!versionTag || !SUPPORTED_VERSIONS.has(versionTag.value)) continue;
      if (!noteIdTag) continue;
      // NOTE: duplicates by Note-Id are NOT dropped here — the id is CLAIMED
      // only after a successful decrypt (truth after decryption), so a
      // replay/garbage candidate can't shadow the real note. The ONE exception
      // is a candidate below a sentinel (see sentinelIds above): the sentinel
      // already decrypted once through the full pipeline, so the claim outcome
      // is certain and the fetch would be pure waste.
      if (sentinelIds.has(noteIdTag.value)) continue;
      // A txId counts as known only when the whole identity lines up: the tag
      // must repeat the sync record's noteId and the version class must match
      // its kind. Anything else is treated as unknown and goes through the
      // full fetch+decrypt pipeline (fail open towards MORE work, never less).
      const knownRec = known?.get(edge.node.id);
      const candidateKind: KnownTxRecord['kind'] = versionTag.value === '4' ? 'safebox' : 'note';
      const isKnown = knownRec !== undefined
        && knownRec.noteId === noteIdTag.value
        && knownRec.kind === candidateKind;
      if (isKnown) sentinelIds.add(noteIdTag.value);
      candidates.push({ txId: edge.node.id, version: versionTag.value, noteId: noteIdTag.value, known: isKnown });
    }

    if (!hasNextPage) break;
    pages++;
    const next = edges[edges.length - 1].cursor;
    // An index that hands back the cursor it was given would page forever.
    if (next === cursor) { incomplete = true; break; }
    cursor = next;
  }

  const pool = createPayloadPool(TRUSTED_OWNERS);

  // Phase 2: bounded-parallel payload fetch + decrypt. Results keep the
  // original slot so claiming stays deterministic (HEIGHT_DESC order).
  // Sentinels are not fetched; the progress denominator counts only the
  // candidates that actually cost a download.
  const results: (RestoredNote | RestoredSafeboxEntry | null)[] = new Array(candidates.length).fill(null);
  const fetchTotal = candidates.reduce((n, c) => n + (c.known ? 0 : 1), 0);
  let nextIndex = 0;
  let done = 0;
  const runWorker = async () => {
    while (true) {
      // Aborted sweep (lock): stop taking new candidates — every remaining
      // fetch would fail instantly anyway; the sweep reports incomplete.
      if (signal?.aborted) {
        incomplete = true;
        return;
      }
      const i = nextIndex++;
      if (i >= candidates.length) return;
      const cand = candidates[i];
      if (cand.known) continue; // sentinel: no fetch, no decrypt, no progress event

      const fetched = await pool.fetchVerified(cand.txId, signal);

      if (fetched.kind === 'unavailable') {
        // Every gateway refused or lied: a legitimate note may be unreachable
        // right now. This is the ONLY payload outcome that means «partial».
        incomplete = true;
      } else if (fetched.kind === 'verified') {
        // Attribution comes from the VERIFIED tags, never from the GraphQL
        // edge: the signature covers the tags and nothing covers the edge.
        const tags = readVerifiedTags(fetched.header, {
          appName: APP_NAME,
          supportedVersions: SUPPORTED_VERSIONS,
          ownerHash,
        });
        if (!isRejection(tags) && !signal?.aborted) {
          try {
            const raw: unknown = JSON.parse(new TextDecoder().decode(fetched.bytes));
            // For v1 the writer emits Timestamp; now that it is SIGNED, it must
            // agree with the envelope's own `t` — a header and a body that
            // disagree about the creation time are not one record.
            const timestampAgrees = tags.version !== '1'
              || (typeof raw === 'object' && raw !== null
                && String((raw as { t?: unknown }).t) === tags.timestamp);
            if (timestampAgrees) {
              results[i] = tags.version === '4'
                ? await buildRestoredSafeboxEntry(keys, tags.noteId, raw as never, cand.txId, signal)
                : await buildRestoredNote(keys.note, tags.version, tags.noteId, raw as never, cand.txId, signal);
            }
          } catch {
            // malformed entry — intentional skip, not a partial restore
          }
        }
      }
      // 'skip' (authenticated but not ours) falls through deliberately: it is an
      // intentional skip, exactly like a candidate that fails to decrypt, and it
      // must NOT mark the sweep incomplete.
      done++;
      onProgress?.(done, fetchTotal);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESTORE_CONCURRENCY, candidates.length) }, runWorker),
  );

  // Phase 3: claim ids in the original chain order (newest block first) —
  // parallel completion order must not decide which duplicate wins. The claim
  // happens AFTER a successful decrypt of EVERY half, so a corrupted candidate
  // can never shadow an intact older duplicate with the same id.
  const restored: RestoredNote[] = [];
  const restoredSafebox: RestoredSafeboxEntry[] = [];
  // ONE id space: v3 notes and v4 entries share the UUIDv8 namespace, so an id
  // claimed by one kind must not be re-claimed by the other.
  const seenIds = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].known) {
      // Sentinel claims its Note-Id at its position — no merge, no counters.
      // A newer unknown duplicate above has already claimed by now and wins,
      // exactly as in a full sweep; an older one below was dropped at
      // collection. The add is idempotent either way.
      seenIds.add(candidates[i].noteId);
      continue;
    }
    const built = results[i];
    if (!built) continue;
    if (isSafeboxResult(built)) {
      if (seenIds.has(built.encrypted.entryId)) continue;
      seenIds.add(built.encrypted.entryId);
      restoredSafebox.push(built);
    } else {
      if (seenIds.has(built.encrypted.noteId)) continue;
      seenIds.add(built.encrypted.noteId);
      restored.push(built);
    }
  }

  restored.sort((a, b) => b.encrypted.createdAt - a.encrypted.createdAt);
  restoredSafebox.sort((a, b) => b.encrypted.createdAt - a.encrypted.createdAt);

  // ONE aggregated line, hosts and counts only — never a txId or an Owner-Hash.
  // Nothing leaves the device (D5): this is the honest local substitute for the
  // fleet-wide payload_hash_mismatch metric the plan cannot have client-side.
  const gatewayMismatches = pool.snapshot();
  if (gatewayMismatches) {
    console.warn('arweave: payload verification failures by gateway', gatewayMismatches);
  }
  return { notes: restored, safeboxEntries: restoredSafebox, incomplete, gatewayMismatches };
}

function isSafeboxResult(r: RestoredNote | RestoredSafeboxEntry): r is RestoredSafeboxEntry {
  return 'entryId' in r.encrypted;
}

/**
 * Assemble + decrypt a v4 SAFEBOX candidate. Returns null (skip) on any shape
 * mismatch or decryption failure of EITHER half.
 *
 * Both halves must decrypt AND validate — a candidate with an intact meta blob
 * and a corrupted/substituted secret blob is rejected WHOLESALE (fail closed):
 * accepting it would claim the id and permanently shadow an intact older
 * duplicate, leaving the user with a readable title and an unreadable password.
 * The decrypted secret is discarded here and never leaves this function.
 */
async function buildRestoredSafeboxEntry(
  keys: RestoreKeyring,
  entryIdTag: string,
  raw: { id?: unknown; mc?: unknown; miv?: unknown; sc?: unknown; siv?: unknown },
  txId: string,
  signal?: AbortSignal,
): Promise<RestoredSafeboxEntry | null> {
  if (typeof raw.id !== 'string' || raw.id !== entryIdTag) return null; // outer id must match the tag
  if (typeof raw.mc !== 'string' || typeof raw.miv !== 'string') return null;
  if (typeof raw.sc !== 'string' || typeof raw.siv !== 'string') return null;

  const encrypted: EncryptedSafeboxEntry = {
    entryId: raw.id,
    metaCiphertext: raw.mc,
    metaIv: raw.miv,
    secretCiphertext: raw.sc,
    secretIv: raw.siv,
    createdAt: 0, // replaced by the AUTHENTICATED `t` below
    v: 4,
  };

  let meta: SafeboxEntryData;
  try {
    // The signal is threaded through BOTH halves: a lock landing between them
    // must not let the secret plaintext materialize either.
    meta = await decryptSafeboxMeta(keys.safeboxMeta, encrypted, signal);
    // Validate the secret half too, then drop the plaintext immediately.
    await decryptSafeboxSecret(keys.safeboxSecret, encrypted, meta.files, signal);
  } catch {
    return null; // not ours / replay / tampered / malformed envelope / aborted
  }

  encrypted.createdAt = meta.createdAt; // authoritative, from the envelope
  return { encrypted, meta, txId };
}

/**
 * Assemble + decrypt a candidate TX by version. Returns null (skip) on any
 * shape mismatch or decryption failure. For v2/v3 the createdAt comes from the
 * authenticated envelope, not from any on-chain field; v3 envelope validation
 * (chain meta, UUIDv8 namespace, linkage invariants) happens in decryptNote.
 */
async function buildRestoredNote(
  key: CryptoKey,
  version: string,
  noteIdTag: string,
  raw: { id?: unknown; c?: unknown; iv?: unknown; t?: unknown },
  txId: string,
  signal?: AbortSignal,
): Promise<RestoredNote | null> {
  let encrypted: EncryptedNote;

  if (version === '2' || version === '3') {
    if (typeof raw.c !== 'string' || typeof raw.iv !== 'string' || typeof raw.id !== 'string') return null;
    if (raw.id !== noteIdTag) return null; // outer id must match the tag
    encrypted = { noteId: raw.id, ciphertext: raw.c, iv: raw.iv, createdAt: 0, v: version === '3' ? 3 : 2 };
  } else {
    if (
      typeof raw.c !== 'string' || typeof raw.iv !== 'string' ||
      typeof raw.t !== 'number' || typeof raw.id !== 'string'
    ) return null;
    if (raw.id !== noteIdTag) return null;
    encrypted = { noteId: raw.id, ciphertext: raw.c, iv: raw.iv, createdAt: raw.t };
  }

  let decoded: { text: string; createdAt: number; meta: NoteVersionMeta };
  try {
    decoded = await decryptNote(key, encrypted, signal);
  } catch {
    return null; // not ours / replay / tampered / malformed envelope / aborted
  }

  encrypted.createdAt = decoded.createdAt; // v2/v3: authoritative from envelope
  return { encrypted, text: decoded.text, txId, meta: decoded.meta };
}
