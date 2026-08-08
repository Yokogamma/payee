/**
 * Eternal Notes — Arweave Transport Module
 *
 * All uploads go through a Cloudflare Worker proxy (server pays AR).
 * Downloads use Arweave GraphQL API directly.
 *
 * No wallet management — auth via Ed25519 signature + server-side allowlist.
 */

import type { EncryptedNote } from './crypto';
import { decryptNote } from './crypto';
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

// Supported data format versions for READING. Client still writes v1 in this
// release (reader-before-writer); v2 is accepted so the writer flip is seamless.
const SUPPORTED_VERSIONS = new Set(['1', '2']);

/** A note recovered from Arweave: the record to persist + its decrypted text. */
export interface RestoredNote {
  encrypted: EncryptedNote;
  text: string;
  txId: string;
}

/**
 * Build the proxy upload payload for a note, serializing per its OWN version.
 * A v2 note is ALWAYS sent as v2 (5 tags, no Timestamp, {id,c,iv}); a v1 note as
 * v1. This guarantees a restored v2 ciphertext can never be re-published as v1.
 */
export function buildUploadPayload(
  note: EncryptedNote,
  ownerHash: string,
  now: number,
  recheck = false,
  recovery?: RecoveryHint,
): ProxyUploadPayload {
  const isV2 = note.v === 2;
  const data = isV2
    ? JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv })
    : JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv, t: note.createdAt });

  const tags = [
    { name: 'App-Name', value: APP_NAME },
    { name: 'App-Version', value: isV2 ? '2' : APP_VERSION },
    { name: 'Owner-Hash', value: ownerHash },
    { name: 'Content-Type', value: 'application/json' },
    ...(isV2 ? [] : [{ name: 'Timestamp', value: note.createdAt.toString() }]),
    { name: 'Note-Id', value: note.noteId },
  ];

  const payload: ProxyUploadPayload = { data, tags, ownerHash, timestamp: now };
  if (recheck) payload.recheck = true;
  if (recheck && recovery) payload.recovery = recovery;
  return payload;
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
    if (response.status === 503) return { kind: 'unavailable', error: text }; // retryable
    return { kind: 'error', error: `HTTP ${response.status}: ${text}` };
  } catch (e) {
    // A network exception is transient/retryable — classify as unavailable so the
    // caller preserves an accepted TX rather than downgrading it to a hard error.
    return { kind: 'unavailable', error: e instanceof Error ? e.message : 'Network error' };
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

/** Result of a restore sweep. `incomplete` = some pages or note payloads could
 *  not be FETCHED (network/gateway) — real notes may be missing, tell the user.
 *  Garbage/replay candidates that fail validation or decryption are intentional
 *  skips and do NOT set the flag. */
export interface FetchAllNotesResult {
  notes: RestoredNote[];
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
}

/**
 * Fetch all encrypted notes from Arweave for a given owner hash.
 * Pagination is sequential (cursors), payload download + decryption runs in a
 * bounded-parallel pool. Deduplicated by Note-Id, version-gated.
 * `onProgress(done, total)` fires as each candidate settles — the UI shows
 * «Восстановлено N/M».
 */
export async function fetchAllNotes(
  ownerHash: string,
  key: CryptoKey,
  onProgress?: (done: number, total: number) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<FetchAllNotesResult> {
  assertTrustedOwners(); // fail-closed: never trust arbitrary on-chain TX
  const { signal } = opts;

  let incomplete = false;

  // Phase 1: sequential cursor pagination — collect candidate TXs.
  const candidates: RestoreCandidate[] = [];
  let cursor: string | null = null;
  while (true) {
    let edges: ArweaveEdge[];
    let hasNextPage: boolean;

    try {
      const page = await fetchPage(ownerHash, cursor, signal);
      edges = page.edges;
      hasNextPage = page.hasNextPage;
    } catch {
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
      // replay/garbage candidate can't shadow the real note.
      candidates.push({ txId: edge.node.id, version: versionTag.value, noteId: noteIdTag.value });
    }

    if (!hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  // Phase 2: bounded-parallel payload fetch + decrypt. Results keep the
  // original slot so claiming stays deterministic (HEIGHT_DESC order).
  const results: (RestoredNote | null)[] = new Array(candidates.length).fill(null);
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
            results[i] = await buildRestoredNote(key, cand.version, cand.noteId, raw, cand.txId);
          } catch {
            // malformed entry — intentional skip, not a partial restore
          }
        }
      }
      done++;
      onProgress?.(done, candidates.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESTORE_CONCURRENCY, candidates.length) }, runWorker),
  );

  // Phase 3: claim Note-Ids in the original chain order (newest block first) —
  // parallel completion order must not decide which duplicate wins.
  const restored: RestoredNote[] = [];
  const seenNoteIds = new Set<string>();
  for (const built of results) {
    if (!built) continue;
    if (seenNoteIds.has(built.encrypted.noteId)) continue;
    seenNoteIds.add(built.encrypted.noteId);
    restored.push(built);
  }

  restored.sort((a, b) => b.encrypted.createdAt - a.encrypted.createdAt);
  return { notes: restored, incomplete };
}

/**
 * Assemble + decrypt a candidate TX by version. Returns null (skip) on any
 * shape mismatch or decryption failure. For v2 the createdAt comes from the
 * authenticated envelope, not from any on-chain field.
 */
async function buildRestoredNote(
  key: CryptoKey,
  version: string,
  noteIdTag: string,
  raw: { id?: unknown; c?: unknown; iv?: unknown; t?: unknown },
  txId: string,
): Promise<RestoredNote | null> {
  let encrypted: EncryptedNote;

  if (version === '2') {
    if (typeof raw.c !== 'string' || typeof raw.iv !== 'string' || typeof raw.id !== 'string') return null;
    if (raw.id !== noteIdTag) return null; // outer id must match the tag
    encrypted = { noteId: raw.id, ciphertext: raw.c, iv: raw.iv, createdAt: 0, v: 2 };
  } else {
    if (
      typeof raw.c !== 'string' || typeof raw.iv !== 'string' ||
      typeof raw.t !== 'number' || typeof raw.id !== 'string'
    ) return null;
    if (raw.id !== noteIdTag) return null;
    encrypted = { noteId: raw.id, ciphertext: raw.c, iv: raw.iv, createdAt: raw.t };
  }

  let decoded: { text: string; createdAt: number };
  try {
    decoded = await decryptNote(key, encrypted);
  } catch {
    return null; // not ours / replay / tampered
  }

  encrypted.createdAt = decoded.createdAt; // v2: authoritative from envelope
  return { encrypted, text: decoded.text, txId };
}
