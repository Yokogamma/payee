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

/**
 * Wallet cache — deliberately on `globalThis`, not in module scope.
 *
 * These suites call `vi.resetModules()` in `afterEach` (config.ts reads its env
 * at module load, so each test re-imports the module under test). A module-level
 * cache is discarded with it, which would mean a fresh RSA-4096 keygen — ~0.6 s —
 * for EVERY test rather than every file. Under a parallel run that is enough to
 * trip the default timeout, and it did: two suites failed only in the full run
 * and passed in isolation. The cache therefore lives where module resets cannot
 * reach it.
 */
interface WalletCache { default?: Promise<TestWallet>; other?: Promise<TestWallet> }
const CACHE_KEY = '__eternalNotesTestWallets__';
function cache(): WalletCache {
  const g = globalThis as Record<string, unknown>;
  g[CACHE_KEY] ??= {};
  return g[CACHE_KEY] as WalletCache;
}

/** The default wallet, generated once per test PROCESS. */
export function testWallet(): Promise<TestWallet> {
  const c = cache();
  c.default ??= newWallet();
  return c.default;
}

/**
 * A SECOND, independent wallet — for the «correctly signed by an attacker»
 * case, where every step but the trusted-owner check must pass. The tests need
 * it to be a DIFFERENT wallet, not a fresh one on every call.
 */
export function otherWallet(): Promise<TestWallet> {
  const c = cache();
  c.other ??= newWallet();
  return c.other;
}

/** A brand-new wallet on every call. Prefer `otherWallet()` in tests. */
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
  // `Uint8Array.from` re-wraps with the CURRENT global constructor. Under jsdom
  // TextEncoder comes from a different realm, so its output fails arweave-js's
  // `data instanceof Uint8Array` check ("Expected data to be a string,
  // Uint8Array or ArrayBuffer") — and passing the string instead does not help,
  // because the SDK encodes it with the same foreign TextEncoder. Same bytes,
  // right prototype.
  const bytes = Uint8Array.from(
    typeof data === 'string' ? new TextEncoder().encode(data) : data,
  );
  const tx = await arweave.createTransaction(
    { data: bytes, last_tx: 'a'.repeat(64), reward: '12345' },
    w.jwk,
  );
  for (const tag of tags) tx.addTag(tag.name, tag.value);
  await arweave.transactions.sign(tx, w.jwk);
  return { txId: tx.id, header: JSON.parse(JSON.stringify(tx)), bytes };
}

/** A GraphQL edge as the index returns it — DISCOVERY data, deliberately
 *  separate from the signed header so a test can make them disagree. */
export interface EdgeSpec {
  txId: string;
  cursor?: string;
  tags: { name: string; value: string }[];
}

export interface GatewayMockOptions {
  /** Signed transactions the pool can serve, keyed by txId. */
  txs: readonly SignedTx[];
  /** GraphQL pages, in order. Defaults to one page listing `txs` in order. */
  pages?: readonly (readonly EdgeSpec[])[];
  /** Intercept `GET <origin>/tx/<id>`; return a Response to override, or
   *  `undefined` to serve the genuine header. */
  onHeader?: (origin: string, txId: string) => Response | undefined;
  /** Intercept `GET <origin>/raw/<id>` the same way. */
  onRaw?: (origin: string, txId: string) => Response | undefined;
  /** Intercept the GraphQL POST; `undefined` serves the pages above. */
  onGraphql?: (call: number) => Response | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Derive the default edge for a signed tx: its real txId plus its real tags,
 *  decoded back to plaintext (the index reports tags decoded). */
export function edgeFor(tx: SignedTx, overrides: Partial<EdgeSpec> = {}): EdgeSpec {
  const raw = (tx.header.tags as { name: string; value: string }[]) ?? [];
  const decode = (v: string) =>
    new TextDecoder().decode(
      Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (v.length % 4)) % 4)),
        c => c.charCodeAt(0)),
    );
  return {
    txId: tx.txId,
    cursor: tx.txId,
    tags: raw.map(t => ({ name: decode(t.name), value: decode(t.value) })),
    ...overrides,
  };
}

/**
 * A fetch mock that behaves like the real gateway pool: one GraphQL index plus
 * `/tx/<id>` and `/raw/<id>` on every payload origin.
 *
 * Serving the SIGNED header and the REAL bytes is the point — under D9 a
 * restore test can no longer hand the client a bare JSON blob. The hooks exist
 * so a test can make one gateway lie without disturbing the others.
 */
export function gatewayFetchMock(options: GatewayMockOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const byId = new Map(options.txs.map(tx => [tx.txId, tx]));
  const pages = options.pages ?? [options.txs.map(tx => edgeFor(tx))];
  let graphqlCalls = 0;

  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.endsWith('/graphql')) {
      const call = graphqlCalls++;
      const override = options.onGraphql?.(call);
      if (override) return override;
      const edges = pages[call] ?? [];
      return json({
        data: {
          transactions: {
            edges: edges.map(e => ({ cursor: e.cursor ?? e.txId, node: { id: e.txId, tags: e.tags } })),
            pageInfo: { hasNextPage: call + 1 < pages.length },
          },
        },
      });
    }

    const header = /^(https:\/\/[^/]+)\/tx\/([^/]+)$/.exec(url);
    if (header) {
      const [, origin, txId] = header;
      const override = options.onHeader?.(origin, txId);
      if (override) return override;
      const tx = byId.get(txId);
      if (!tx) return new Response('not found', { status: 404 });
      return json(tx.header);
    }

    const raw = /^(https:\/\/[^/]+)\/raw\/([^/]+)$/.exec(url);
    if (raw) {
      const [, origin, txId] = raw;
      const override = options.onRaw?.(origin, txId);
      if (override) return override;
      const tx = byId.get(txId);
      if (!tx) return new Response('not found', { status: 404 });
      return new Response(tx.bytes as unknown as BodyInit, { status: 200 });
    }

    return new Response('unexpected request: ' + url, { status: 500 });
  };
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
