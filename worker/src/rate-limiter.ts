/**
 * RateLimiter Durable Object — per-user quota + idempotency + reservation
 * lifecycle (R4, R7, C1/M6).
 *
 * One instance per publicKey. Single-threaded → strict consistency.
 *
 * Lifecycle: reserved → posted → committed.
 *   - reserved : slot held, no TX yet.
 *   - posted   : Arweave POST succeeded, server-recorded {txId, postedAt}. This is
 *                the AUTHORITATIVE record used to reconcile a lost commit — the
 *                client's txId is never trusted for this.
 *   - committed: quota finalized.
 *
 * Quota accounting (M6): a reserve is admitted only while count + inFlight <
 * limit. reserved/posted both hold an inFlight slot; commit moves it inFlight→
 * count; release frees a reserved slot (no quota spent, no attempt refunded).
 * Records carry a window `gen` for fixed-window isolation, and a `token` for
 * compare-and-swap on mark-posted/commit/release/redrop.
 */

const WINDOW_MS = 3_600_000;        // 1 hour
const RESERVE_TTL_MS = 600_000;     // 10 min — a reservation older than this is stale
const ATTEMPT_FACTOR = 3;           // attempts ceiling = limit × 3

interface NoteRecord {
  status: 'reserved' | 'posted' | 'committed';
  token: string;
  gen: number;
  txId?: string;
  reservedAt?: number;
  postedAt?: number;
  committedAt?: number;
}

interface Window { count: number; inFlight: number; attempts: number; resetAt: number }

interface CheckAndReserveRequest { noteId: string; limit: number }
interface MarkPostedRequest { noteId: string; txId: string; token: string }
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
    if (url.pathname === '/mark-posted') return this.handleMarkPosted(request);
    if (url.pathname === '/commit') return this.handleCommit(request);
    if (url.pathname === '/release') return this.handleRelease(request);
    if (url.pathname === '/redrop') return this.handleRedrop(request);
    return new Response('Not found', { status: 404 });
  }

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
      return Response.json({
        status: 'exists',
        txId: record.txId,
        committedAt: record.committedAt ?? record.reservedAt ?? now,
      });
    }
    if (record?.status === 'posted') {
      // Server-authoritative anchor for reconciling a lost commit.
      return Response.json({
        status: 'posted', txId: record.txId, postedAt: record.postedAt ?? now, token: record.token,
      });
    }
    if (record?.status === 'reserved' && now - (record.reservedAt ?? 0) < RESERVE_TTL_MS) {
      return Response.json({ status: 'reserved' });
    }

    // No record or a STALE reservation we replace — reuse its own inFlight slot.
    const w = await this.window(now);
    const staleOwnSlot = record?.status === 'reserved' && record.gen === w.resetAt ? 1 : 0;
    const effectiveInFlight = Math.max(0, w.inFlight - staleOwnSlot);

    if (w.count + effectiveInFlight >= limit) return Response.json({ status: 'rate_limited' }, { status: 429 });
    if (w.attempts >= limit * ATTEMPT_FACTOR) return Response.json({ status: 'rate_limited' }, { status: 429 });

    const token = crypto.randomUUID();
    await this.state.storage.put('inFlight', effectiveInFlight + 1);
    await this.state.storage.put('attempts', w.attempts + 1);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    });
    return Response.json({ status: 'ok', token });
  }

  /** Record a successful Arweave POST BEFORE commit, so a lost commit stays
   *  reconcilable with the server's own txId. Slot stays inFlight. */
  private async handleMarkPosted(request: Request): Promise<Response> {
    const { noteId, txId, token } = await request.json<MarkPostedRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    // Idempotent: a retried mark-posted (lost response) for the same token+txId
    // that already landed must succeed, not report stale.
    if (record && record.status === 'posted' && record.token === token && record.txId === txId) {
      return Response.json({ ok: true });
    }
    if (!record || record.status !== 'reserved' || record.token !== token) {
      return Response.json({ ok: false, stale: true });
    }
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'posted', token, gen: record.gen, txId, reservedAt: record.reservedAt, postedAt: Date.now(),
    });
    return Response.json({ ok: true });
  }

  private async handleCommit(request: Request): Promise<Response> {
    const { noteId, txId, token } = await request.json<CommitRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || (record.status !== 'reserved' && record.status !== 'posted') || record.token !== token) {
      return Response.json({ ok: false, stale: true });
    }

    const now = Date.now();
    const w = await this.window(now);
    let committedGen = record.gen;
    if (record.gen === w.resetAt) {
      if (w.inFlight > 0) await this.state.storage.put('inFlight', w.inFlight - 1);
      await this.state.storage.put('count', w.count + 1);
      committedGen = w.resetAt;
    }
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'committed', token, gen: committedGen, txId, committedAt: now,
    });
    return Response.json({ ok: true });
  }

  /** Release a RESERVED slot on POST failure. Never releases a posted/committed
   *  record (those represent a real on-chain TX). Idempotent; token-scoped. */
  private async handleRelease(request: Request): Promise<Response> {
    const { noteId, token } = await request.json<ReleaseRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record && record.status === 'reserved' && record.token === token) {
      const w = await this.window(Date.now());
      if (record.gen === w.resetAt && w.inFlight > 0) {
        await this.state.storage.put('inFlight', w.inFlight - 1);
      }
      await this.state.storage.delete(`note:${noteId}`);
    }
    return Response.json({ ok: true });
  }

  /** A posted/committed TX was found dropped → convert back to a fresh
   *  reservation for re-post, respecting quota + attempts. */
  private async handleRedrop(request: Request): Promise<Response> {
    const { noteId, txId, limit } = await request.json<RedropRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);

    if (!record) return Response.json({ ok: false, gone: true });
    if (record.status === 'reserved') return Response.json({ ok: false, inProgress: true });
    if (record.txId !== txId) {
      // Superseded by another request under a new txId.
      return Response.json({
        ok: false,
        committed: record.status === 'committed',
        inProgress: record.status === 'posted',
        txId: record.txId,
      });
    }

    const now = Date.now();
    const w = await this.window(now);
    if (w.attempts >= limit * ATTEMPT_FACTOR) return Response.json({ ok: false, rateLimited: true });

    if (record.status === 'committed') {
      // Free the dead commit's count slot (same window only) and take an inFlight slot.
      const sameGen = record.gen === w.resetAt;
      const baseCount = sameGen ? Math.max(0, w.count - 1) : w.count;
      if (baseCount + w.inFlight >= limit) return Response.json({ ok: false, rateLimited: true });
      if (sameGen) await this.state.storage.put('count', baseCount);
      await this.state.storage.put('inFlight', w.inFlight + 1);
    } else if (record.gen === w.resetAt) {
      // posted, same window → its inFlight slot is still counted; no change.
    } else {
      // posted from a PREVIOUS window → window() already reset inFlight to 0, so
      // the slot no longer exists. Re-acquire it under the current window's quota.
      if (w.count + w.inFlight >= limit) return Response.json({ ok: false, rateLimited: true });
      await this.state.storage.put('inFlight', w.inFlight + 1);
    }
    await this.state.storage.put('attempts', w.attempts + 1);

    const token = crypto.randomUUID();
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    });
    return Response.json({ ok: true, token });
  }
}
