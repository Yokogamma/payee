/**
 * Test harness: real, signed, format-2 Arweave transactions.
 *
 * D9 means a restore test can no longer hand the fetch mock a bare JSON blob —
 * the payload must come with a header whose signature, `id` and `data_root`
 * actually check out. This builds those.
 *
 * ── Two deliberate choices ─────────────────────────────────────────────────
 *
 * 1. The transaction is built and signed by **arweave-js**, not by the module
 *    under test. A harness that reused `tx-verify.ts`'s own deep-hash and
 *    merkle code would only prove that code agrees with itself. Going through
 *    the real library makes every restore test an interop test too — and,
 *    because arweave-js's NODE driver signs with the MAXIMUM PSS salt while the
 *    Worker's WebCrypto driver uses 32, it exercises the other end of the salt
 *    policy for free.
 *
 * 2. The wallet is GENERATED AT RUNTIME and memoized per module instance. RSA
 *    4096 keygen costs ~0.6 s once per test file (signing is ~5 ms), which is
 *    the price of not committing a private key to the repository — even a
 *    worthless one, which secret scanners cannot tell from a valuable one.
 */

import Arweave from 'arweave';
import type { JWKInterface } from 'arweave/node/lib/wallet';

export interface TestWallet {
  jwk: JWKInterface;
  /** base64url SHA-256 of the modulus — i.e. what TRUSTED_OWNERS holds. */
  address: string;
}

export interface SignedTx {
  txId: string;
  /** Shaped exactly like a gateway's `GET /tx/<id>` response body. */
  header: Record<string, unknown>;
  /** Exactly what `GET /raw/<id>` must return for this txId. */
  bytes: Uint8Array;
}

const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

let cached: Promise<TestWallet> | null = null;

/** The default wallet, memoized for the lifetime of the module instance. */
export function testWallet(): Promise<TestWallet> {
  cached ??= newWallet();
  return cached;
}

/** A SECOND, independent wallet — for the «correctly signed by an attacker»
 *  case, where every step but the trusted-owner check must pass. */
export async function newWallet(): Promise<TestWallet> {
  const jwk = await arweave.wallets.generate();
  return { jwk, address: await arweave.wallets.jwkToAddress(jwk) };
}

/**
 * Build and sign a transaction carrying `data` and `tags`.
 *
 * `last_tx` and `reward` are supplied explicitly so the SDK makes no network
 * calls (it would otherwise fetch an anchor and a price); their values are
 * irrelevant to verification because the signature covers whatever they are.
 */
export async function buildSignedTx(
  data: string | Uint8Array,
  tags: { name: string; value: string }[],
  wallet?: TestWallet,
): Promise<SignedTx> {
  const w = wallet ?? (await testWallet());
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const tx = await arweave.createTransaction(
    { data: bytes, last_tx: 'a'.repeat(64), reward: '12345' },
    w.jwk,
  );
  for (const tag of tags) tx.addTag(tag.name, tag.value);
  await arweave.transactions.sign(tx, w.jwk);
  return { txId: tx.id, header: JSON.parse(JSON.stringify(tx)), bytes };
}

/** The tag set the writer emits for v2/v3 notes and v4 safebox entries. */
export function notesTags(opts: {
  version: string;
  ownerHash: string;
  noteId: string;
  appName?: string;
}): { name: string; value: string }[] {
  return [
    { name: 'App-Name', value: opts.appName ?? 'EternalNotes' },
    { name: 'App-Version', value: opts.version },
    { name: 'Owner-Hash', value: opts.ownerHash },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Note-Id', value: opts.noteId },
  ];
}
