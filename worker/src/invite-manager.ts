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

interface SeedInviteRequest {
  codes: string[];
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
    await this.state.storage.put(`pk:${publicKey}`, true);

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
