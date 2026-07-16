/**
 * RateLimiter Durable Object — per-user rate limit + idempotency + reservation
 * lifecycle (R4, R7, C1/M6).
 *
 * One instance per publicKey (= per user). Single-threaded → strict consistency.
 *
 * Two SEPARATE per-window counters (M6 / review #7):
 *   - `count`   : SUCCESSFUL commits — the real quota. Incremented ONLY on commit.
 *   - `attempts`: reserve attempts — anti-abuse ceiling (limit × ATTEMPT_FACTOR).
 *                 NEVER refunded, so a failing client can't retry forever.
 * A failed upload calls `/release`, which frees the reservation (so the same
 * noteId can be retried) WITHOUT spending quota and WITHOUT refunding attempts.
 *
 * Every reservation carries a unique `token`; `/commit` and `/release` only act
 * on the CURRENT token (compare-and-swap), so a stale/duplicate call can't
 * commit or release a reservation that was superseded.
 */

const WINDOW_MS = 3_600_000;        // 1 hour
const RESERVE_TTL_MS = 600_000;     // 10 min — a reservation older than this is stale
const ATTEMPT_FACTOR = 3;           // attempts ceiling = limit × 3

interface NoteRecord {
  status: 'reserved' | 'committed';
  token: string;
  txId?: string;
  reservedAt?: number;
  committedAt?: number;
}

interface CheckAndReserveRequest { noteId: string; limit: number }
interface CommitRequest { noteId: string; txId: string; token: string }
interface ReleaseRequest { noteId: string; token: string }
interface RedropRequest { noteId: string; txId: string }

export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/check-and-reserve') return this.handleCheckAndReserve(request);
    if (url.pathname === '/commit') return this.handleCommit(request);
    if (url.pathname === '/release') return this.handleRelease(request);
    if (url.pathname === '/redrop') return this.handleRedrop(request);
    return new Response('Not found', { status: 404 });
  }

  /** Read the window counters, resetting them if the window has rolled over. */
  private async window(now: number): Promise<{ count: number; attempts: number; resetAt: number }> {
    let count = (await this.state.storage.get<number>('count')) ?? 0;
    let attempts = (await this.state.storage.get<number>('attempts')) ?? 0;
    let resetAt = (await this.state.storage.get<number>('resetAt')) ?? 0;
    if (now > resetAt) {
      count = 0;
      attempts = 0;
      resetAt = now + WINDOW_MS;
    }
    return { count, attempts, resetAt };
  }

  /** Idempotency + rate limit + reserve. Quota is spent only on commit. */
  private async handleCheckAndReserve(request: Request): Promise<Response> {
    const { noteId, limit } = await request.json<CheckAndReserveRequest>();
    const now = Date.now();

    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record?.status === 'committed') {
      return Response.json({ status: 'exists', txId: record.txId, committedAt: record.committedAt });
    }
    if (record?.status === 'reserved' && now - (record.reservedAt ?? 0) < RESERVE_TTL_MS) {
      return Response.json({ status: 'reserved' });
    }

    const { count, attempts, resetAt } = await this.window(now);
    if (count >= limit) return Response.json({ status: 'rate_limited' }, { status: 429 });
    if (attempts >= limit * ATTEMPT_FACTOR) return Response.json({ status: 'rate_limited' }, { status: 429 });

    const token = crypto.randomUUID();
    await this.state.storage.put('attempts', attempts + 1);
    await this.state.storage.put('resetAt', resetAt);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, { status: 'reserved', token, reservedAt: now });

    return Response.json({ status: 'ok', token });
  }

  /** Commit noteId → txId. Only the active reservation token may commit. */
  private async handleCommit(request: Request): Promise<Response> {
    const { noteId, txId, token } = await request.json<CommitRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || record.status !== 'reserved' || record.token !== token) {
      return Response.json({ ok: false, stale: true });
    }

    const now = Date.now();
    const { count, resetAt } = await this.window(now);
    await this.state.storage.put('count', count + 1); // spend quota only here
    await this.state.storage.put('resetAt', resetAt);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'committed', token, txId, committedAt: now,
    });
    return Response.json({ ok: true });
  }

  /** Release a reservation on upload failure. Idempotent; token-scoped. Does not
   *  refund attempts or touch quota. */
  private async handleRelease(request: Request): Promise<Response> {
    const { noteId, token } = await request.json<ReleaseRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record && record.status === 'reserved' && record.token === token) {
      await this.state.storage.delete(`note:${noteId}`);
    }
    return Response.json({ ok: true });
  }

  /** Recheck path: a committed TX was found dropped. Convert it back to a fresh
   *  reservation and free the quota slot the dead commit consumed, so the note
   *  can be re-posted under a NEW txId. No-op if the record changed meanwhile. */
  private async handleRedrop(request: Request): Promise<Response> {
    const { noteId, txId } = await request.json<RedropRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || record.status !== 'committed' || record.txId !== txId) {
      return Response.json({ ok: false });
    }

    const now = Date.now();
    const { count, resetAt } = await this.window(now);
    if (count > 0) await this.state.storage.put('count', count - 1); // give the slot back
    await this.state.storage.put('resetAt', resetAt);

    const token = crypto.randomUUID();
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, { status: 'reserved', token, reservedAt: now });
    return Response.json({ ok: true, token });
  }
}
