/**
 * The stand-in server wallet the worker test bindings use, and the address it
 * derives to.
 *
 * ── Why this exists at all ───────────────────────────────────────────
 *
 * `/upload` refuses while the wallet about to SIGN is outside `TRUSTED_OWNERS`
 * (D2/D9): a transaction signed by an untrusted address is one that neither
 * half will ever be able to authenticate, so posting it spends money on a
 * permanently unverifiable record. The bindings therefore need a JWK whose
 * address is knowable, and a `TRUSTED_OWNERS` that contains exactly it.
 *
 * The two values are DERIVED here rather than pasted as two literals, because
 * two literals can drift: someone edits the modulus, the address silently stops
 * matching, and every upload test starts answering 503 for a reason that has
 * nothing to do with what it is testing.
 *
 * ── What this JWK is NOT ─────────────────────────────────────────────
 *
 * It carries only `n`, which is all `jwkToAddress` reads. It is deliberately
 * NOT structurally complete: `assertStructurallyCompleteJwk` still rejects it,
 * so the tests that expect to fail at the Arweave transport keep failing there,
 * exactly as before this fixture existed. Nothing here can sign.
 */

import { createHash } from 'node:crypto';

/**
 * A deterministic 512-byte modulus — the real RSA-4096 size, built from a fixed
 * label so the value is reproducible from this file alone and reviewable
 * without a binary blob in the diff.
 */
const modulus = Buffer.concat(
  Array.from({ length: 16 }, (_, i) =>
    createHash('sha256').update(`eternal-notes/test-wallet/${i}`).digest()),
);

/** The JWK string the `ARWEAVE_JWK` binding is set to. */
export const TEST_ARWEAVE_JWK = JSON.stringify({ n: modulus.toString('base64url') });

/**
 * `arweave.wallets.jwkToAddress` is exactly base64url(SHA-256(decode(n))), so
 * the address is computed the same way here instead of importing the SDK into
 * a config file. `check-test-wallet.test.mjs` pins that equivalence against the
 * real SDK, so this shortcut cannot quietly stop being true.
 */
export const TEST_WALLET_ADDRESS = createHash('sha256').update(modulus).digest('base64url');
