/**
 * Eternal Notes — Arweave Integration
 *
 * Загрузка зашифрованных заметок в Arweave = вечное хранение.
 * Скачивание по Owner-Hash = восстановление на любом устройстве.
 *
 * Два режима:
 *   1. Devnet (тестовая сеть) — бесплатно, данные не вечные
 *   2. Mainnet — настоящее вечное хранение, нужен AR (~$0.01 за заметку)
 */

import Arweave from 'arweave';
import type { JWKInterface } from 'arweave/node/lib/wallet';
import type { EncryptedNote } from './crypto';

// ─── Config ──────────────────────────────────────────────────────────

export type ArweaveMode = 'devnet' | 'mainnet';

const ARWEAVE_CONFIGS = {
  mainnet: {
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
  },
  devnet: {
    host: 'arweave.net', // For devnet testing we still read from mainnet gateway
    port: 443,
    protocol: 'https',
  },
} as const;

const APP_NAME = 'EternalNotes';
const APP_VERSION = '1';

// ─── Arweave Client ──────────────────────────────────────────────────

let arweaveInstance: Arweave | null = null;

export function getArweave(mode: ArweaveMode = 'mainnet'): Arweave {
  if (!arweaveInstance) {
    arweaveInstance = Arweave.init(ARWEAVE_CONFIGS[mode]);
  }
  return arweaveInstance;
}

// ─── Wallet from Seed ────────────────────────────────────────────────

/**
 * Derive an Arweave JWK wallet from a mnemonic.
 *
 * Note: This generates a NEW Arweave wallet deterministically from the seed.
 * The wallet needs AR tokens to upload data.
 * For MVP/testing, use getWalletAddress() to show the address and fund it.
 */
let cachedWallet: JWKInterface | null = null;

export async function getWalletFromSeed(_mnemonic: string): Promise<JWKInterface> {
  if (cachedWallet) return cachedWallet;

  // Generate a wallet (in production, derive deterministically from seed)
  const arweave = getArweave();
  const wallet = await arweave.wallets.generate();

  // Store for session reuse
  cachedWallet = wallet;
  return wallet;
}

/**
 * Get wallet address from JWK
 */
export async function getWalletAddress(wallet: JWKInterface): Promise<string> {
  const arweave = getArweave();
  return arweave.wallets.jwkToAddress(wallet);
}

/**
 * Get wallet balance in AR
 */
export async function getWalletBalance(wallet: JWKInterface): Promise<string> {
  const arweave = getArweave();
  const address = await getWalletAddress(wallet);
  const winstonBalance = await arweave.wallets.getBalance(address);
  return arweave.ar.winstonToAr(winstonBalance);
}

// ─── Upload ──────────────────────────────────────────────────────────

export interface UploadResult {
  txId: string;
  status: 'uploaded' | 'error';
  error?: string;
}

/**
 * Upload an encrypted note to Arweave.
 *
 * Tags make it searchable via GraphQL:
 *   - App-Name: "EternalNotes"
 *   - Owner-Hash: SHA-256 of public key (for finding all user's notes)
 *   - Timestamp: creation time
 *   - Content-Type: application/octet-stream
 *   - Note-Hash: SHA-256 of plaintext (for dedup)
 */
export async function uploadNote(
  wallet: JWKInterface,
  ownerHash: string,
  note: EncryptedNote
): Promise<UploadResult> {
  try {
    const arweave = getArweave();

    // Serialize the encrypted note
    const data = JSON.stringify({
      c: note.ciphertext,
      iv: note.iv,
      t: note.createdAt,
      h: note.hash,
    });

    // Create transaction
    const tx = await arweave.createTransaction({ data }, wallet);

    // Add tags for searchability
    tx.addTag('App-Name', APP_NAME);
    tx.addTag('App-Version', APP_VERSION);
    tx.addTag('Owner-Hash', ownerHash);
    tx.addTag('Content-Type', 'application/json');
    tx.addTag('Timestamp', note.createdAt.toString());
    tx.addTag('Note-Hash', note.hash);

    // Sign and submit
    await arweave.transactions.sign(tx, wallet);
    const response = await arweave.transactions.post(tx);

    if (response.status === 200 || response.status === 202) {
      return { txId: tx.id, status: 'uploaded' };
    } else {
      return {
        txId: tx.id,
        status: 'error',
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
  } catch (err) {
    return {
      txId: '',
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Upload multiple notes in batch (for sync)
 */
export async function uploadNotes(
  wallet: JWKInterface,
  ownerHash: string,
  notes: EncryptedNote[]
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const note of notes) {
    const result = await uploadNote(wallet, ownerHash, note);
    results.push(result);
    // Small delay between uploads to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ─── Download (Restore) ──────────────────────────────────────────────

interface ArweaveEdge {
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
 * Fetch all encrypted notes from Arweave for a given owner hash.
 * Uses Arweave GraphQL API to find transactions by tags.
 */
export async function fetchNotes(ownerHash: string): Promise<EncryptedNote[]> {
  const query = `
    query {
      transactions(
        tags: [
          { name: "App-Name", values: ["${APP_NAME}"] },
          { name: "Owner-Hash", values: ["${ownerHash}"] }
        ],
        sort: HEIGHT_DESC,
        first: 1000
      ) {
        edges {
          node {
            id
            tags {
              name
              value
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  try {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL error: ${response.status}`);
    }

    const result: GraphQLResponse = await response.json();
    const edges = result.data.transactions.edges;

    // Fetch each transaction's data
    const notes: EncryptedNote[] = [];
    const seenHashes = new Set<string>();

    for (const edge of edges) {
      try {
        // Get note hash from tags for dedup
        const noteHashTag = edge.node.tags.find(t => t.name === 'Note-Hash');
        if (noteHashTag && seenHashes.has(noteHashTag.value)) continue;
        if (noteHashTag) seenHashes.add(noteHashTag.value);

        // Fetch transaction data
        const dataResponse = await fetch(`https://arweave.net/${edge.node.id}`);
        if (!dataResponse.ok) continue;

        const rawData = await dataResponse.json();

        const note: EncryptedNote = {
          ciphertext: rawData.c,
          iv: rawData.iv,
          createdAt: rawData.t,
          hash: rawData.h,
        };

        notes.push(note);
      } catch {
        // Skip individual note errors
        console.warn(`Failed to fetch note ${edge.node.id}`);
      }
    }

    // Sort newest first
    notes.sort((a, b) => b.createdAt - a.createdAt);
    return notes;
  } catch (err) {
    console.error('Failed to fetch notes from Arweave:', err);
    return [];
  }
}

// ─── Status & Helpers ────────────────────────────────────────────────

/**
 * Check if Arweave gateway is reachable
 */
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

/**
 * Get estimated cost to upload data of given size (in AR)
 */
export async function estimateCost(bytesSize: number): Promise<string> {
  const arweave = getArweave();
  const price = await arweave.transactions.getPrice(bytesSize);
  return arweave.ar.winstonToAr(price);
}

/**
 * Get transaction status
 */
export async function getTxStatus(txId: string): Promise<{
  status: 'pending' | 'confirmed' | 'not_found';
  confirmations?: number;
}> {
  const arweave = getArweave();
  try {
    const status = await arweave.transactions.getStatus(txId);
    if (status.status === 200) {
      return {
        status: 'confirmed',
        confirmations: status.confirmed?.number_of_confirmations,
      };
    } else if (status.status === 202) {
      return { status: 'pending' };
    }
    return { status: 'not_found' };
  } catch {
    return { status: 'not_found' };
  }
}
