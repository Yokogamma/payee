/**
 * InviteManager Durable Object — atomic invite registration + allowlist (R6)
 *
 * One GLOBAL instance (idFromName = "global").
 * All registrations go through it → single-threaded → no race conditions.
 * DO = source of truth for allowlist. KV = read-through cache.
 *
 * SERIALIZED CACHE OWNERSHIP: every KV write for `pk:*` access entries happens
 * HERE, inside blockConcurrencyWhile — register (fresh grant), /refresh-allowed
 * (read-through refresh) and /revoke (deny) are totally ordered. A worker-side
 * get→put can interleave with a revoke and resurrect a denied key; a single
 * serialized owner cannot: a refresh that runs after a revoke sees the key
 * already deleted (same critical section as its own KV write) and writes
 * nothing, while a revoke that runs later overwrites `allowed` with `denied`.
 * Deny wins in every interleaving.
 */

import { writeAllowCache } from './allowlist';

/** The only binding the DO needs — the allowlist cache it owns writes for. */
interface InviteManagerEnv {
  ALLOWLIST: KVNamespace;
}

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

/** Bounds for /seed-invite input (defense against oversized/garbage batches). */
const MAX_INVITE_CODE_LENGTH = 128;
const MAX_SEED_BATCH = 1000;

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
  private env: InviteManagerEnv;

  constructor(state: DurableObjectState, env: InviteManagerEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/register') return this.handleRegister(request);
    if (url.pathname === '/check-allowed') return this.handleCheckAllowed(request);
    if (url.pathname === '/refresh-allowed') return this.handleRefreshAllowed(request);
    if (url.pathname === '/seed-invite') return this.handleSeedInvite(request);
    if (url.pathname === '/revoke') return this.handleRevoke(request);
    return new Response('Not found', { status: 404 });
  }

  private async handleRegister(request: Request): Promise<Response> {
    const { inviteCode, publicKey, clientIP } = await request.json<RegisterRequest>();

    // The whole decision + mutation + cache write runs as ONE serialized
    // critical section (see the file header): no revoke can interleave between
    // "invite consumed" and "allowed cached".
    let response!: Response;
    await this.state.blockConcurrencyWhile(async () => {
      // 1. Brute-force protection per IP
      const ipKey = `ip:${clientIP}`;
      const now = Date.now();
      const attempts: FailedAttempt = (await this.state.storage.get<FailedAttempt>(ipKey))
        ?? { count: 0, windowEnd: 0, blockedUntil: 0 };

      // Hourly block active?
      if (now < attempts.blockedUntil) {
        response = Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429 },
        );
        return;
      }

      // Window expired → reset
      if (now >= attempts.windowEnd) {
        attempts.count = 0;
        attempts.windowEnd = 0;
        attempts.blockedUntil = 0;
      }

      // 2. Check publicKey not already registered — idempotent. NO cache write
      // here: this branch validates no invite, so it must never be able to
      // resurrect a racing revoke's `denied` (round-8 finding).
      const existingPK = await this.state.storage.get(`pk:${publicKey}`);
      if (existingPK) {
        response = Response.json({ ok: true, alreadyRegistered: true });
        return;
      }

      // 3. Check invite code — ATOMIC read + write
      const invite = await this.state.storage.get<InviteRecord>(`invite:${inviteCode}`);
      if (!invite || invite.used) {
        attempts.count++;
        if (!attempts.windowEnd) attempts.windowEnd = now + 600_000; // 10-min window
        if (attempts.count >= 10) {
          attempts.blockedUntil = now + 3_600_000; // ≥10 fails → 1 hour block
          await this.state.storage.put(ipKey, attempts);
          response = Response.json(
            { error: 'Too many attempts. Try again later.' },
            { status: 429 },
          );
          return;
        }
        await this.state.storage.put(ipKey, attempts);
        response = Response.json(
          { error: 'Invalid or used invite code' },
          { status: 401 },
        );
        return;
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

      // 5. Fresh grant → cache `allowed`, serialized with any revoke. A cache
      // failure is non-fatal: access is granted in the DO; the next request
      // re-derives on the KV miss.
      try {
        await writeAllowCache(this.env.ALLOWLIST, publicKey, 'allowed');
      } catch (e) {
        console.error('REGISTER_CACHE_WRITE_FAILED', e);
      }

      response = Response.json({ ok: true });
    });
    return response;
  }

  /**
   * Read-through refresh (serialized cache owner): re-derives the verdict from
   * DO storage and writes the `allowed` cache entry INSIDE the same critical
   * section. The returned verdict is FINAL — a worker must honor `allowed:false`
   * even if its own earlier KV read said otherwise (a revoke won the race).
   */
  private async handleRefreshAllowed(request: Request): Promise<Response> {
    const { publicKey } = await request.json<CheckAllowedRequest>();
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      return Response.json({ error: 'publicKey required' }, { status: 400 });
    }
    let allowed = false;
    await this.state.blockConcurrencyWhile(async () => {
      allowed = !!(await this.state.storage.get(`pk:${publicKey}`));
      if (allowed) {
        try {
          await writeAllowCache(this.env.ALLOWLIST, publicKey, 'allowed');
        } catch (e) {
          console.error('REFRESH_CACHE_WRITE_FAILED', e); // verdict still stands
        }
      }
      // Not allowed → write NOTHING: a revoke's `denied` (written in ITS
      // critical section) must not be touched, and negative caching is not
      // this endpoint's job.
    });
    return Response.json({ allowed });
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
   * The SINGLE `denied` KV write happens here (deny-first, serialized) — the
   * Worker never pre-writes it: a duplicate write to the same key could trip
   * KV's ~1-write/sec/key limit and make the authoritative write fail.
   */
  private async handleRevoke(request: Request): Promise<Response> {
    const { publicKey } = await request.json<RevokeRequest>();
    // Defense in depth: the Worker validates too, but the DO must never accept
    // a typo'd value — it would get a successful idempotent response while the
    // REAL key stayed allowed. Canonical form is required, EXCEPT for an exact
    // match on a stored legacy entry: /register only started rejecting
    // non-canonical spellings later, so any key admitted before that must stay
    // revocable under the literal string it was stored as.
    if (typeof publicKey !== 'string') {
      return Response.json({ error: 'publicKey must be a string' }, { status: 400 });
    }
    if (!isCanonical32ByteB64(publicKey)) {
      const legacyEntry = await this.state.storage.get(`pk:${publicKey}`);
      if (!legacyEntry) {
        return Response.json(
          { error: 'publicKey must be canonical base64 of a 32-byte key' },
          { status: 400 },
        );
      }
      console.warn('REVOKE_LEGACY_NONCANONICAL_KEY');
    }

    let response!: Response;
    await this.state.blockConcurrencyWhile(async () => {
      // FAIL-CLOSED inside the critical section too: the serialized `denied`
      // goes FIRST. If it fails, nothing has changed — 503, retry. Being inside
      // the section, no register/refresh can interleave between this write and
      // the storage delete below (the round-9 race).
      try {
        await writeAllowCache(this.env.ALLOWLIST, publicKey, 'denied');
      } catch (e) {
        console.error('REVOKE_CACHE_DENY_FAILED', e);
        response = Response.json({ error: 'Revoke failed (cache write) — retry' }, { status: 503 });
        return;
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
      response = Response.json({ ok: true, wasAllowed: !!existing, inviteRevoked });
    });
    return response;
  }

  /**
   * Admin: seed invite codes (called via wrangler or admin secret).
   *
   * CREATE-ONLY, serialized: an existing code is NEVER overwritten. Re-seeding a
   * code that was already used (or revoked) must not resurrect it — otherwise an
   * operator accidentally re-running the seed makes a one-time invite reusable
   * or un-revokes a key (round-23 access-control finding). Existing codes are
   * reported as `skipped`, not reset.
   */
  private async handleSeedInvite(request: Request): Promise<Response> {
    const { codes } = await request.json<SeedInviteRequest>();
    if (!Array.isArray(codes) || codes.length === 0) {
      return Response.json({ error: 'codes[] required' }, { status: 400 });
    }
    if (codes.length > MAX_SEED_BATCH) {
      return Response.json({ error: `at most ${MAX_SEED_BATCH} codes per call` }, { status: 400 });
    }
    for (const code of codes) {
      if (typeof code !== 'string' || code.length === 0 || code.length > MAX_INVITE_CODE_LENGTH) {
        return Response.json({ error: 'each code must be a 1..128-char string' }, { status: 400 });
      }
    }

    let seeded = 0;
    const skipped: string[] = [];
    await this.state.blockConcurrencyWhile(async () => {
      for (const code of codes) {
        // Read-before-write inside the critical section: no register/revoke can
        // interleave between the existence check and the create.
        const existing = await this.state.storage.get(`invite:${code}`);
        if (existing) {
          skipped.push(code);
          continue;
        }
        await this.state.storage.put<InviteRecord>(`invite:${code}`, { used: false });
        seeded++;
      }
    });
    return Response.json({ seeded, skipped });
  }
}
