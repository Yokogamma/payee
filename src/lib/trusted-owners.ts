/**
 * Shared parser/validator for the trusted Arweave wallet set (C2).
 *
 * Pure and env-free so BOTH the Vite build (Node) and the client runtime import
 * the exact same validation — a typo can't pass one gate and fail the other.
 *
 * An Arweave address is the base64url encoding of a 32-byte SHA-256 hash → 43
 * chars from [A-Za-z0-9_-]. A placeholder like "foo" or "WALLET_A" is rejected,
 * so a misconfigured owner set fails loudly instead of silently returning an
 * empty restore (which reads as "all notes lost").
 */

const ARWEAVE_ADDRESS = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parse a comma-separated owner list. Throws on any malformed address.
 * Returns a de-duplicated list (may be empty — callers decide if empty is fatal).
 */
export function parseTrustedOwners(raw: string): string[] {
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const invalid = list.filter((a) => !ARWEAVE_ADDRESS.test(a));
  if (invalid.length > 0) {
    throw new Error(
      `TRUSTED_OWNERS contains malformed Arweave address(es): ${invalid.join(', ')}. ` +
        `Each must be 43 base64url chars.`,
    );
  }

  return [...new Set(list)];
}
