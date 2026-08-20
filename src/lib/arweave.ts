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

/** Check if Arweave gateway is reachable */
export async function isArweaveOnline(): Promise<boolean> {
  try {
    const response = await fetch('https://arweave.net/info', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
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
 * Check finalization status of an Arweave transaction, per the gateway's HTTP
 * contract:
 *   200 + confirmations → confirmed
 *   202 "Pending"       → pending (NOT 404)
 *   404                 → dropped (unknown tx / evicted from mempool)
 *   400                 → invalid tx id
 *   other / network     → unavailable (do not act on it)
 */
export async function getTxStatus(txId: string): Promise<TxStatusResult> {
  try {
    const response = await fetch(`https://arweave.net/tx/${txId}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 202) return { kind: 'pending' };
    if (response.status === 404) return { kind: 'dropped' };
    if (response.status === 400) return { kind: 'invalid' };
    if (!response.ok) return { kind: 'unavailable' };
    const data: TxStatusResponse = await response.json();
    return { kind: 'confirmed', confirmations: data.number_of_confirmations, blockHeight: data.block_height };
  } catch {
    return { kind: 'unavailable' };
  }
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
  v3: UploadsCapability;
  v4: UploadsCapability;
}

const UNKNOWN_CAPABILITIES: WorkerCapabilities = { v3: 'unknown', v4: 'unknown' };

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
  try {
    const response = await fetch(`${PROXY_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return UNKNOWN_CAPABILITIES;
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return UNKNOWN_CAPABILITIES;
    const d = data as { ok?: unknown; versions?: unknown; v3Uploads?: unknown; v4Uploads?: unknown };
    if (d.ok !== true) return UNKNOWN_CAPABILITIES;
    const versions = d.versions;
    const readOne = (version: string, flag: unknown): UploadsCapability => {
      if (!Array.isArray(versions) || !versions.includes(version)) return 'unknown';
      if (flag === true) return 'enabled';
      if (flag === false) return 'disabled';
      return 'unknown';
    };
    return { v3: readOne('3', d.v3Uploads), v4: readOne('4', d.v4Uploads) };
  } catch {
    return UNKNOWN_CAPABILITIES;
  }
}

// ─── Download (Restore from Arweave) ─────────────────────────────────

interface ArweaveEdge {
  cursor: string;
  node: {
    id: string;
    tags: { name: string; value: string }[];
  };
}

interface GraphQLResponse {
  data: {
    transactions: {
      edges: ArweaveEdge[];
      pageInfo: {
        hasNextPage: boolean;
      };
    };
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
  // `owners` restricts results to TX signed by the trusted proxy wallet(s) (C2):
  // an attacker cannot post under these addresses, so squatted/replayed Note-Ids
  // never appear. `Owner-Hash` tag still scopes to this user's notes.
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

  const response = await fetch('https://arweave.net/graphql', {
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

  const result: GraphQLResponse = await response.json();
  return {
    edges: result.data.transactions.edges,
    hasNextPage: result.data.transactions.pageInfo.hasNextPage,
  };
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
}

/** How many note payloads are fetched+decrypted concurrently during restore.
 *  Bounded pool: fast enough to kill the old N+1 sequential latency, small
 *  enough not to hammer the gateway from a mobile connection. */
const RESTORE_CONCURRENCY = 5;

/** Per-request deadlines for the restore sweep — without them a stalled
 *  connection leaves the restore banner spinning indefinitely. */
const GRAPHQL_TIMEOUT_MS = 20_000;
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
  while (true) {
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
    cursor = edges[edges.length - 1].cursor;
  }

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

      let dataResponse: Response | null = null;
      try {
        dataResponse = await fetch(`https://arweave.net/raw/${cand.txId}`, {
          signal: requestSignal(PAYLOAD_TIMEOUT_MS, signal),
        });
      } catch {
        incomplete = true; // network — a legit note may be unreachable right now
      }
      if (dataResponse) {
        if (!dataResponse.ok) {
          incomplete = true;
        } else {
          try {
            const raw = await dataResponse.json();
            results[i] = cand.version === '4'
              ? await buildRestoredSafeboxEntry(keys, cand.noteId, raw, cand.txId)
              : await buildRestoredNote(keys.note, cand.version, cand.noteId, raw, cand.txId);
          } catch {
            // malformed entry — intentional skip, not a partial restore
          }
        }
      }
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
  return { notes: restored, safeboxEntries: restoredSafebox, incomplete };
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
    meta = await decryptSafeboxMeta(keys.safeboxMeta, encrypted);
    // Validate the secret half too, then drop the plaintext immediately.
    await decryptSafeboxSecret(keys.safeboxSecret, encrypted, meta.files);
  } catch {
    return null; // not ours / replay / tampered / malformed envelope
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
    decoded = await decryptNote(key, encrypted);
  } catch {
    return null; // not ours / replay / tampered / malformed envelope
  }

  encrypted.createdAt = decoded.createdAt; // v2/v3: authoritative from envelope
  return { encrypted, text: decoded.text, txId, meta: decoded.meta };
}
