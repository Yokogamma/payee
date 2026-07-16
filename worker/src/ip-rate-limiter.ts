/**
 * IpRateLimiter Durable Object — per-IP baseline anti-abuse (D-baseline).
 *
 * SHARDED: one instance per client IP (`idFromName(ip)`), NOT a single global
 * instance. Sharding avoids funneling every request through one DO — the exact
 * bottleneck the global InviteManager would create if reused for IP limiting.
 *
 * Fixed-window counter. Single-threaded per shard → consistent counts.
 * On Cloudflare Free (no WAF rate-limiting) this IS the primary rate limit, so
 * the caller fails CLOSED (503) if this DO is unreachable.
 */

interface IpWindow {
  count: number;
  resetAt: number;
}

interface CheckRequest {
  limit: number;
  windowMs: number;
}

export class IpRateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/check') return this.handleCheck(request);
    return new Response('Not found', { status: 404 });
  }

  private async handleCheck(request: Request): Promise<Response> {
    const { limit, windowMs } = await request.json<CheckRequest>();
    const now = Date.now();

    let win = (await this.state.storage.get<IpWindow>('win'))
      ?? { count: 0, resetAt: 0 };

    if (now > win.resetAt) {
      win = { count: 0, resetAt: now + windowMs };
      // Self-clean when the window ends so idle IP shards don't accumulate
      // persistent storage forever (a distributed attack would otherwise leave
      // one SQLite-backed DO per source IP indefinitely).
      await this.state.storage.setAlarm(win.resetAt + 1000);
    }

    win.count++;
    await this.state.storage.put('win', win);

    const ok = win.count <= limit;
    return Response.json(
      { ok, remaining: Math.max(0, limit - win.count) },
      { status: ok ? 200 : 429 },
    );
  }

  /**
   * Window elapsed with no further traffic → wipe this shard's storage.
   * Alarms are at-least-once and a new window may have opened after this alarm
   * was scheduled, so guard on resetAt: only wipe a genuinely-expired window,
   * otherwise re-arm for the current one (never erase a live counter).
   */
  async alarm(): Promise<void> {
    const win = await this.state.storage.get<IpWindow>('win');
    if (!win) return; // already clean
    if (Date.now() >= win.resetAt) {
      await this.state.storage.deleteAll();
    } else {
      await this.state.storage.setAlarm(win.resetAt + 1000);
    }
  }
}
