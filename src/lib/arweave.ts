/**
 * Eternal Notes — Arweave Transport Module
 *
 * All uploads go through a Cloudflare Worker proxy (server pays AR).
 * Downloads use Arweave GraphQL API directly.
 *
 * No wallet management — auth via Ed25519 signature + server-side allowlist.
 */

import type { EncryptedNote } from './crypto';

// ─── Config ──────────────────────────────────────────────────────────

const PROXY_URL = import.meta.env.VITE_PROXY_URL || '';
export const APP_NAME = 'EternalNotes';
export const APP_VERSION = '1';

// Supported data format versions. When payload structure changes, add new version.
const SUPPORTED_VERSIONS = new Set(['1']);

// ─── Types ───────────────────────────────────────────────────────────

export interface ProxyUploadPayload {
  data: string;
  tags: { name: string; value: string }[];
  ownerHash: string;
  timestamp: number;
}

export type UploadResult =
  | { kind: 'accepted'; txId: string }
  | { kind: 'rate_limited'; error: string }
  | { kind: 'not_registered'; error: string }
  | { kind: 'in_progress'; error: string }
  | { kind: 'error'; error: string };

export type RegistrationStatus = 'allowed' | 'denied' | 'unavailable' | 'invalid_request';

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
): Promise<RegistrationStatus> {
  if (!PROXY_URL) return 'unavailable';

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
      return data.allowed ? 'allowed' : 'denied';
    }

    // 4xx (except 429) = client bug
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      console.error(`checkRegistration: client error ${response.status}`);
      return 'invalid_request';
    }

    // 429 or 5xx = transient server issue
    return 'unavailable';
  } catch {
    return 'unavailable';
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
      return { kind: 'accepted', txId: data.txId };
    }

    // Structured error classification by HTTP status (not text)
    const text = await response.text();
    if (response.status === 429) return { kind: 'rate_limited', error: text };
    if (response.status === 403) return { kind: 'not_registered', error: text };
    if (response.status === 409) return { kind: 'in_progress', error: text };
    return { kind: 'error', error: `HTTP ${response.status}: ${text}` };
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e.message : 'Network error' };
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
async function fetchPage(
  ownerHash: string,
  after: string | null
): Promise<{ edges: ArweaveEdge[]; hasNextPage: boolean }> {
  const query = `query($ownerHash: [String!]!, $appName: [String!]!, $after: String) {
    transactions(
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
    after: after,
  };

  const response = await fetch('https://arweave.net/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
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

/**
 * Fetch all encrypted notes from Arweave for a given owner hash.
 * Paginated, deduplicated by Note-Id, version-gated.
 */
export async function fetchAllNotes(ownerHash: string): Promise<EncryptedNote[]> {
  const allNotes: EncryptedNote[] = [];
  const seenNoteIds = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    let edges: ArweaveEdge[];
    let hasNextPage: boolean;

    try {
      const page = await fetchPage(ownerHash, cursor);
      edges = page.edges;
      hasNextPage = page.hasNextPage;
    } catch {
      break; // Stop pagination on error
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
      if (seenNoteIds.has(noteIdTag.value)) continue;
      seenNoteIds.add(noteIdTag.value);

      try {
        const dataResponse = await fetch(`https://arweave.net/${edge.node.id}`);
        if (!dataResponse.ok) continue;
        const raw = await dataResponse.json();

        // Validate structure
        if (!raw.c || !raw.iv || !raw.t || !raw.id) continue;

        allNotes.push({
          noteId: raw.id,
          ciphertext: raw.c,
          iv: raw.iv,
          createdAt: raw.t,
        });
      } catch {
        continue; // Skip malformed entries
      }
    }

    if (!hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  allNotes.sort((a, b) => b.createdAt - a.createdAt);
  return allNotes;
}
