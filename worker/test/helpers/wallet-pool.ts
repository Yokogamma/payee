import { afterAll, beforeAll } from 'vitest';
import { addressOfJwk } from '../../test-stubs/wallet-address';

/**
 * Pre-generated RSA wallets for the worker suites: EVERY key a test signs or
 * pays with is generated HERE, in a beforeAll hook, never in a test body.
 *
 * Keygen time is a lottery — the prime search is random — and CPU contention
 * (a parallel client suite, a loaded runner) stretches it further. A key
 * generated inside a test is paid from that test's default 5 s budget: the
 * spend-guard.ledger «≥2 independent operators» test generated seven RSA-2048
 * keys in its body and took 4.7 s on a quiet machine, 10–15 s under load. The
 * same class #240 fixed for the RSA-4096 harness wallets.
 *
 * A file declares how many wallets its tests take — `pregenerateWallets(n)`
 * at the top level — and each `freshWallet()` hands out the next one: real,
 * signable, and NEVER handed out before. The pool is take-once and is emptied
 * at both ends of the file, so no wallet crosses a test or a file boundary and
 * the «a fresh, never used wallet» meaning of the old in-body keygen holds.
 * A count that is too small fails loudly in the test that ran dry; a silent
 * fallback to generating would quietly bring the timeout back.
 */

export interface Wallet { jwk: string; address: string; n: string }

/** One key per hook, each with its own budget (hooks run one after another). */
const KEYGEN_BUDGET_MS = 60_000;

let pool: Wallet[] = [];
let declared = 0;

/** A real signable RSA wallet (as the e2e suites generate) and its address. */
async function generateWallet(): Promise<Wallet> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;
  const jwk = JSON.stringify(exported);
  return { jwk, address: await addressOfJwk(jwk), n: exported.n! };
}

/** Call ONCE at the top level of a file: `count` wallets are generated before
 *  its first test — the number of `freshWallet()` calls its tests make. */
export function pregenerateWallets(count: number): void {
  beforeAll(() => { pool = []; declared = count; });
  for (let i = 0; i < count; i++) {
    beforeAll(async () => { pool.push(await generateWallet()); }, KEYGEN_BUDGET_MS);
  }
  afterAll(() => { pool = []; declared = 0; });
}

/** The next never-used wallet of this file's pool. */
export async function freshWallet(): Promise<Wallet> {
  const wallet = pool.shift();
  if (!wallet) {
    throw new Error(
      `freshWallet(): the wallet pool is empty — this file declared pregenerateWallets(${declared}); `
      + 'raise the count instead of generating a key in a test body',
    );
  }
  return wallet;
}
