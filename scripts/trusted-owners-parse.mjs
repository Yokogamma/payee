/**
 * Plain-JS mirror of src/lib/trusted-owners.ts for operator/CI scripts that
 * run OUTSIDE the Vite/TS toolchain (deploy config gate, owners-vs-worker
 * check). Kept behavior-identical on purpose; the parity test
 * (trusted-owners-parse.test.mjs) holds the two together — if they ever
 * diverge, a value could pass one gate and fail the other.
 */

const ARWEAVE_ADDRESS = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parse a comma-separated owner list. Throws on any malformed address.
 * Returns a de-duplicated list (may be empty — callers decide if empty is fatal).
 */
export function parseTrustedOwners(raw) {
  const list = String(raw ?? '')
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
