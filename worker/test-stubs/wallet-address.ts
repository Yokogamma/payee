/**
 * The address an `ARWEAVE_JWK` derives to, for tests that generate their own
 * wallet.
 *
 * `/upload` refuses while the signing wallet is outside `TRUSTED_OWNERS`
 * (D2/D9), so a test that overrides `ARWEAVE_JWK` has to override
 * `TRUSTED_OWNERS` with it — otherwise every request answers 503 for a reason
 * unrelated to what the test is about.
 *
 * `arweave.wallets.jwkToAddress` is exactly base64url(SHA-256(decode(n))).
 * Recomputed here with WebCrypto rather than importing the SDK, so the helper
 * works unchanged inside workerd; `test/trusted-owners.test.ts` pins the
 * equivalence against the real SDK.
 */

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The Arweave address for a JWK JSON string. Throws if it carries no `n`. */
export async function addressOfJwk(jwkJson: string): Promise<string> {
  const { n } = JSON.parse(jwkJson) as { n?: string };
  if (typeof n !== 'string' || n === '') throw new Error('JWK has no modulus `n`');
  const digest = await crypto.subtle.digest('SHA-256', b64urlDecode(n));
  return b64urlEncode(new Uint8Array(digest));
}

/**
 * Env overrides that make `jwkJson` the signing wallet AND declare it trusted.
 *
 * Spread this instead of setting `ARWEAVE_JWK` alone: the two values are one
 * decision, and separating them is what produces a mystery 503.
 */
export async function withTrustedWallet(jwkJson: string): Promise<{
  ARWEAVE_JWK: string;
  TRUSTED_OWNERS: string;
}> {
  return { ARWEAVE_JWK: jwkJson, TRUSTED_OWNERS: await addressOfJwk(jwkJson) };
}
