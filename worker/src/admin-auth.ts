/**
 * Constant-time bearer authentication for the `/admin/*` family.
 *
 * SHA-256 both sides to a fixed 32 bytes, then `timingSafeEqual` — no early
 * exit on a length mismatch and no crash on it (`timingSafeEqual` itself throws
 * on unequal input lengths; digests never are). Generalised over WHICH secret:
 * `/admin/metrics` authenticates against `METRICS_ADMIN_SECRET`, the invite
 * routes against `ADMIN_SECRET`, and `/admin/spend/*` (D10) against
 * `SPEND_ADMIN_SECRET` — one implementation of the cryptography for all three.
 *
 * Lives in its own module because the spend-admin handler is a separate file
 * and `index.ts` importing it while it imports `index.ts` would be a cycle.
 */
export async function verifyBearerSecret(expectedSecret: string | undefined, authHeader: string | null): Promise<boolean> {
  if (!expectedSecret || !authHeader) return false;
  const enc = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(authHeader)),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${expectedSecret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(given), new Uint8Array(expected));
}
