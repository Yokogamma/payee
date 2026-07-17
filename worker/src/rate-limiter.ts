/**
 * RateLimiter Durable Object — per-user quota + idempotency + reservation
 * lifecycle (R4, R7, C1/M6).
 *
 * One instance per publicKey. Single-threaded → strict consistency.
 *
 * Quota accounting tracks BOTH committed successes and in-flight reservations so
 * concurrent reserves cannot collectively exceed the limit (review: parallel
 * uploads must not bypass the quota):
 *   - `count`    : committed successes in the current window.
 *   - `inFlight` : active quota reservations (reserved-but-not-committed).
 *   - `attempts` : reserve attempts in the window — anti-abuse ceiling; never
 *                  refunded, so churn is bounded.
 * A reserve is admitted only while `count + inFlight < limit`. commit moves a
 * slot from inFlight→count; release frees the inFlight slot (no quota spent, no
 * attempt refunded).
 *
 * Every record is tagged with `gen` = the window's resetAt, so a reservation
 * that straddles a window boundary adjusts only its OWN window's counters.
 * Reservations carry a `token`; commit/release/redrop act only on the current
 * token (CAS).
 */

const WINDOW_MS = 3_600_000;        // 1 hour
const RESERVE_TTL_MS = 600_000;     // 10 min — a reservation older than this is stale
const ATTEMPT_FACTOR = 3;           // attempts ceiling = limit × 3

interface NoteRecord {
  status: 'reserved' | 'committed';
  token: string;
  gen: number;         // window resetAt this record's slot belongs to
  txId?: string;
  reservedAt?: number;
  committedAt?: number;
}

interface Window { count: number; inFlight: number; attempts: number; resetAt: number }

interface CheckAndReserveRequest { noteId: string; limit: number }
interface CommitRequest { noteId: string; txId: string; token: string }
interface ReleaseRequest { noteId: string; token: string }
interface RedropRequest { noteId: string; txId: string; limit: number }

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

  /** Read counters, resetting + persisting them if the window has rolled over. */
  private async window(now: number): Promise<Window> {
    let count = (await this.state.storage.get<number>('count')) ?? 0;
    let inFlight = (await this.state.storage.get<number>('inFlight')) ?? 0;
    let attempts = (await this.state.storage.get<number>('attempts')) ?? 0;
    let resetAt = (await this.state.storage.get<number>('resetAt')) ?? 0;
    if (now > resetAt) {
      count = 0; inFlight = 0; attempts = 0; resetAt = now + WINDOW_MS;
      await this.state.storage.put('count', 0);
      await this.state.storage.put('inFlight', 0);
      await this.state.storage.put('attempts', 0);
      await this.state.storage.put('resetAt', resetAt);
    }
    return { count, inFlight, attempts, resetAt };
  }

  private async handleCheckAndReserve(request: Request): Promise<Response> {
    const { noteId, limit } = await request.json<CheckAndReserveRequest>();
    const now = Date.now();

    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record?.status === 'committed') {
      // Legacy records (pre-committedAt) stored their time in reservedAt.
      return Response.json({
        status: 'exists',
        txId: record.txId,
        committedAt: record.committedAt ?? record.reservedAt ?? now,
      });
    }
    if (record?.status === 'reserved' && now - (record.reservedAt ?? 0) < RESERVE_TTL_MS) {
      return Response.json({ status: 'reserved' });
    }

    const w = await this.window(now);
    if (w.count + w.inFlight >= limit) return Response.json({ status: 'rate_limited' }, { status: 429 });
    if (w.attempts >= limit * ATTEMPT_FACTOR) return Response.json({ status: 'rate_limited' }, { status: 429 });

    const token = crypto.randomUUID();
    await this.state.storage.put('inFlight', w.inFlight + 1);
    await this.state.storage.put('attempts', w.attempts + 1);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    });
    return Response.json({ status: 'ok', token });
  }

  private async handleCommit(request: Request): Promise<Response> {
    const { noteId, txId, token } = await request.json<CommitRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || record.status !== 'reserved' || record.token !== token) {
      return Response.json({ ok: false, stale: true });
    }

    const now = Date.now();
    const w = await this.window(now);
    // Move the slot inFlight→count. Only touch inFlight if the reservation
    // belongs to the CURRENT window (else it was already reset on rollover).
    if (record.gen === w.resetAt && w.inFlight > 0) {
      await this.state.storage.put('inFlight', w.inFlight - 1);
    }
    await this.state.storage.put('count', w.count + 1);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'committed', token, gen: w.resetAt, txId, committedAt: now,
    });
    return Response.json({ ok: true });
  }

  private async handleRelease(request: Request): Promise<Response> {
    const { noteId, token } = await request.json<ReleaseRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record && record.status === 'reserved' && record.token === token) {
      const w = await this.window(Date.now());
      if (record.gen === w.resetAt && w.inFlight > 0) {
        await this.state.storage.put('inFlight', w.inFlight - 1); // free the slot
      }
      await this.state.storage.delete(`note:${noteId}`);
    }
    return Response.json({ ok: true });
  }

  /** Recheck: a committed TX was found dropped. Convert it back to a fresh
   *  reservation (a new posting attempt), respecting quota + attempts. Frees the
   *  dead commit's count slot only if it belongs to the current window. */
  private async handleRedrop(request: Request): Promise<Response> {
    const { noteId, txId, limit } = await request.json<RedropRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || record.status !== 'committed' || record.txId !== txId) {
      return Response.json({ ok: false });
    }

    const now = Date.now();
    const w = await this.window(now);
    const sameGen = record.gen === w.resetAt;
    // Effective committed count excluding this dead commit (only if same window).
    const baseCount = sameGen ? Math.max(0, w.count - 1) : w.count;
    if (baseCount + w.inFlight >= limit) return Response.json({ ok: false, rateLimited: true });
    if (w.attempts >= limit * ATTEMPT_FACTOR) return Response.json({ ok: false, rateLimited: true });

    if (sameGen) await this.state.storage.put('count', baseCount); // give the slot back
    await this.state.storage.put('inFlight', w.inFlight + 1);
    await this.state.storage.put('attempts', w.attempts + 1);

    const token = crypto.randomUUID();
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    });
    return Response.json({ ok: true, token });
  }
}
