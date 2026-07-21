/**
 * Allowlist KV cache — single typed model (D3).
 *
 * One key `pk:<publicKey>` holds JSON `{ status: 'allowed' | 'denied' }`.
 * Access is granted ONLY when status === 'allowed'. Any other shape —
 * a legacy `'true'` string, unparseable value, or unknown status — is treated
 * as a cache MISS so the caller re-derives truth from the InviteManager DO and
 * rewrites the entry in the new format. This prevents the old `!!get()` bug
 * where a future `'denied'` string would have read as truthy → access bypass,
 * and keeps legitimate legacy users from losing access after release.
 *
 * DO (InviteManager) remains the source of truth; KV is a read-through cache.
 */

export type CachedAccess = 'allowed' | 'denied' | 'miss';

/**
 * Short TTL on positive cache entries (M3) — bounds staleness of revocations.
 * SECURITY SLO: even in the worst case (the revoke's KV `denied` write is lost
 * AFTER the DO already dropped the key), a revoked key can keep uploading for
 * AT MOST this long before the cached `allowed` expires and the DO (source of
 * truth) is consulted again. Keep it at 1 hour or lower.
 */
export const ALLOW_CACHE_TTL_SECONDS = 60 * 60; // 1h

/**
 * Even shorter TTL on negative (denied) entries. A deny is a soft, revocable
 * decision (e.g. after a revoke); it must not linger indefinitely, otherwise a
 * later re-grant could be masked by a stale cached deny.
 */
export const DENY_CACHE_TTL_SECONDS = 10 * 60; // 10 min

function keyFor(publicKeyB64: string): string {
  return `pk:${publicKeyB64}`;
}

/** Read the cached access decision. Legacy/invalid values collapse to 'miss'. */
export async function readAllowCache(
  kv: KVNamespace,
  publicKeyB64: string,
): Promise<CachedAccess> {
  const raw = await kv.get(keyFor(publicKeyB64));
  if (raw === null) return 'miss';
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    if (parsed?.status === 'allowed' || parsed?.status === 'denied') {
      return parsed.status;
    }
  } catch {
    // legacy `'true'` or garbage → miss (re-derive from DO)
  }
  return 'miss';
}

/** Write a typed access decision. Both allowed and denied entries get a TTL. */
export async function writeAllowCache(
  kv: KVNamespace,
  publicKeyB64: string,
  status: 'allowed' | 'denied',
): Promise<void> {
  const ttl = status === 'allowed' ? ALLOW_CACHE_TTL_SECONDS : DENY_CACHE_TTL_SECONDS;
  await kv.put(keyFor(publicKeyB64), JSON.stringify({ status }), { expirationTtl: ttl });
}
