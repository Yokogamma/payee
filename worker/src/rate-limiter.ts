/**
 * RateLimiter Durable Object — per-user rate limit + idempotency (R4, R7)
 *
 * One instance per publicKey (= per user).
 * Persistent storage survives hibernation/eviction.
 * Single-threaded execution → strict consistency.
 */

interface NoteRecord {
  status: 'reserved' | 'committed';
  txId?: string;
  reservedAt: number;
}

interface CheckAndReserveRequest {
  noteId: string;
  limit: number;
}

interface CommitRequest {
  noteId: string;
  txId: string;
}

export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/check-and-reserve') return this.handleCheckAndReserve(request);
    if (url.pathname === '/commit') return this.handleCommit(request);
    return new Response('Not found', { status: 404 });
  }

  /**
   * COMBINED: idempotency check + rate limit + reserve — ONE call (R7).
   * Quota is consumed ONLY on new reserve. Repeated requests (exists/reserved) are free.
   */
  private async handleCheckAndReserve(request: Request): Promise<Response> {
    const { noteId, limit } = await request.json<CheckAndReserveRequest>();

    // 1. Idempotency check FIRST (free — no quota cost)
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record?.status === 'committed') {
      return Response.json({ status: 'exists', txId: record.txId });
    }
    if (record?.status === 'reserved' && Date.now() - record.reservedAt < 600_000) {
      return Response.json({ status: 'reserved' }); // another upload in progress
    }

    // 2. Rate limit check (only for genuinely new uploads)
    const now = Date.now();
    let count: number = (await this.state.storage.get<number>('count')) ?? 0;
    let resetAt: number = (await this.state.storage.get<number>('resetAt')) ?? 0;

    if (now > resetAt) {
      count = 0;
      resetAt = now + 3_600_000; // 1 hour window
    }

    if (count >= limit) {
      return Response.json({ status: 'rate_limited' }, { status: 429 });
    }

    // 3. Reserve + increment (atomic — same single-threaded DO call)
    count++;
    await this.state.storage.put('count', count);
    await this.state.storage.put('resetAt', resetAt);
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'reserved',
      reservedAt: now,
    });

    return Response.json({ status: 'ok', remaining: limit - count });
  }

  /**
   * Commit noteId → txId after successful Arweave upload.
   */
  private async handleCommit(request: Request): Promise<Response> {
    const { noteId, txId } = await request.json<CommitRequest>();
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, {
      status: 'committed',
      txId,
      reservedAt: Date.now(),
    });
    return Response.json({ ok: true });
  }
}
