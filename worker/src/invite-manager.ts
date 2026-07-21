/**
 * InviteManager Durable Object — atomic invite registration + allowlist (R6)
 *
 * One GLOBAL instance (idFromName = "global").
 * All registrations go through it → single-threaded → no race conditions.
 * DO = source of truth for allowlist. KV = read-through cache.
 */

interface InviteRecord {
  used: boolean;
  publicKey?: string;
  usedAt?: number;
  /** Set when the key admitted by this invite was revoked (audit trail). A
   *  revoked invite is also `used`, so it can never admit another key. */
  revoked?: boolean;
  revokedAt?: number;
}

/** Allowlist record for a registered key. Legacy entries are the literal
 *  `true` (pre-revoke releases); new entries carry the reverse index to the
 *  admitting invite so revoke can mark it without scanning. */
interface PkRecord {
  invitedBy: string;
  registeredAt: number;
}

interface FailedAttempt {
  count: number;
  windowEnd: number;
  blockedUntil: number;
}

interface RegisterRequest {
  inviteCode: string;
  publicKey: string;
  clientIP: string;
}

interface CheckAllowedRequest {
  publicKey: string;
}

interface RevokeRequest {
  publicKey: string;
}

interface SeedInviteRequest {
  codes: string[];
}

/** Canonical base64 of exactly 32 bytes (Ed25519 public key). */
function isCanonical32ByteB64(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false; // 32 bytes → 44 chars
  try {
    const bin = atob(s);
    if (bin.length !== 32) return false;
    return btoa(bin) === s;
  } catch {
    return false;
  }
}

export class InviteManager implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/register') return this.handleRegister(request);
    if (url.pathname === '/check-allowed') return this.handleCheckAllowed(request);
    if (url.pathname === '/seed-invite') return this.handleSeedInvite(request);
    if (url.pathname === '/revoke') return this.handleRevoke(request);
    return new Response('Not found', { status: 404 });
  }

  private async handleRegister(request: Request): Promise<Response> {
    const { inviteCode, publicKey, clientIP } = await request.json<RegisterRequest>();

    // 1. Brute-force protection per IP
    const ipKey = `ip:${clientIP}`;
    const now = Date.now();
    const attempts: FailedAttempt = (await this.state.storage.get<FailedAttempt>(ipKey))
      ?? { count: 0, windowEnd: 0, blockedUntil: 0 };

    // Hourly block active?
    if (now < attempts.blockedUntil) {
      return Response.json(
        { error: 'Too many attempts. Try again later.' },
        { status: 429 },
      );
    }

    // Window expired → reset
    if (now >= attempts.windowEnd) {
      attempts.count = 0;
      attempts.windowEnd = 0;
      attempts.blockedUntil = 0;
    }

    // 2. Check publicKey not already registered — idempotent
    const existingPK = await this.state.storage.get(`pk:${publicKey}`);
    if (existingPK) {
      return Response.json({ ok: true, alreadyRegistered: true });
    }

    // 3. Check invite code — ATOMIC read + write
    const invite = await this.state.storage.get<InviteRecord>(`invite:${inviteCode}`);
    if (!invite || invite.used) {
      attempts.count++;
      if (!attempts.windowEnd) attempts.windowEnd = now + 600_000; // 10-min window
      if (attempts.count >= 10) {
        attempts.blockedUntil = now + 3_600_000; // ≥10 fails → 1 hour block
        await this.state.storage.put(ipKey, attempts);
        return Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429 },
        );
      }
      await this.state.storage.put(ipKey, attempts);
      return Response.json(
        { error: 'Invalid or used invite code' },
        { status: 401 },
      );
    }

    // 4. Mark invite used + add publicKey to allowlist — atomic single-threaded
    await this.state.storage.put<InviteRecord>(`invite:${inviteCode}`, {
      ...invite,
      used: true,
      publicKey,
      usedAt: Date.now(),
    });
    // Reverse index (invitedBy) lets /revoke mark the admitting invite without
    // a storage scan. Legacy `true` records from older releases still validate
    // (checkAllowed is truthiness-based) and are handled by revoke's fallback.
    await this.state.storage.put<PkRecord>(`pk:${publicKey}`, {
      invitedBy: inviteCode,
      registeredAt: Date.now(),
    });

    return Response.json({ ok: true });
  }

  /**
   * Allowlist check — called by Worker on KV miss during /upload.
   */
  private async handleCheckAllowed(request: Request): Promise<Response> {
    const { publicKey } = await request.json<CheckAllowedRequest>();
    const exists = await this.state.storage.get(`pk:${publicKey}`);
    return Response.json({ allowed: !!exists });
  }

  /**
   * Revoke a registered key (M11). Idempotent: revoking an unknown/already-
   * revoked key succeeds. Removes the key from the allowlist (source of truth)
   * and marks the admitting invite as revoked — via the reverse index for new
   * records, or a prefix scan for legacy `true` records.
   * The caller (Worker /admin/revoke) also writes the KV `denied` entry so a
   * stale cached `allowed` cannot outlive the revoke beyond its TTL.
   */
  private async handleRevoke(request: Request): Promise<Response> {
    const { publicKey } = await request.json<RevokeRequest>();
    // Defense in depth: the Worker validates too, but the DO must never accept
    // a non-canonical value — a typo'd key would get a successful idempotent
    // response while the REAL key stayed allowed.
    if (typeof publicKey !== 'string' || !isCanonical32ByteB64(publicKey)) {
      return Response.json(
        { error: 'publicKey must be canonical base64 of a 32-byte key' },
        { status: 400 },
      );
    }

    const pkKey = `pk:${publicKey}`;
    const existing = await this.state.storage.get<true | PkRecord>(pkKey);

    // Locate the admitting invite: new records carry invitedBy; legacy `true`
    // records fall back to a scan (registrations are invite-bounded → small).
    let inviteCode: string | undefined =
      typeof existing === 'object' && existing !== null ? existing.invitedBy : undefined;
    if (!inviteCode) {
      const invites = await this.state.storage.list<InviteRecord>({ prefix: 'invite:' });
      for (const [key, rec] of invites) {
        if (rec.publicKey === publicKey) {
          inviteCode = key.slice('invite:'.length);
          break;
        }
      }
    }

    let inviteRevoked = false;
    if (inviteCode) {
      const invite = await this.state.storage.get<InviteRecord>(`invite:${inviteCode}`);
      if (invite) {
        if (!invite.revoked) {
          await this.state.storage.put<InviteRecord>(`invite:${inviteCode}`, {
            ...invite,
            used: true, // a revoked invite must never admit another key
            revoked: true,
            revokedAt: Date.now(),
          });
        }
        inviteRevoked = true;
      }
    }

    await this.state.storage.delete(pkKey);
    return Response.json({ ok: true, wasAllowed: !!existing, inviteRevoked });
  }

  /**
   * Admin: seed invite codes (called via wrangler or admin secret).
   */
  private async handleSeedInvite(request: Request): Promise<Response> {
    const { codes } = await request.json<SeedInviteRequest>();
    for (const code of codes) {
      await this.state.storage.put<InviteRecord>(`invite:${code}`, { used: false });
    }
    return Response.json({ seeded: codes.length });
  }
}
