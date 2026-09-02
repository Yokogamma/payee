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
  /**
   * The publication fingerprint this record's payload hashes to (D2).
   *
   * `undefined` means LEGACY — the record predates semantic idempotency and its
   * bytes were never fingerprinted. That is a third state, not «no fingerprint»:
   * a legacy record cannot be compared, so the caller must authenticate the
   * publication and backfill it (`/backfill-fp`) before any verdict is reached.
   * Written at `reserved`, carried UNCHANGED through mark-posted and commit.
   */
  fp?: string;
}

/** What `/backfill-fp` compare-and-swaps against — the whole record identity a
 *  legacy snapshot was taken under, so a concurrent transition loses the race
 *  rather than being overwritten. */
export interface LegacySnapshot {
  status: 'posted' | 'committed';
  txId: string;
  token: string;
  gen: number;
}

interface Window { count: number; inFlight: number; attempts: number; resetAt: number }

/** `fp` is the REQUESTED fingerprint — of the payload this request carries. It
 *  is what a stored `fp` is compared against, and what a fresh reservation
 *  records. Optional so a caller that has not computed one still functions:
 *  the record is then written legacy-shaped, exactly as before D2. */
interface CheckAndReserveRequest { noteId: string; limit: number; fp?: string }
interface MarkPostedRequest { noteId: string; txId: string; token: string }
interface CommitRequest { noteId: string; txId: string; token: string }
interface ReleaseRequest { noteId: string; token: string }
/**
 * `fp` of the payload about to be RE-posted. Absent → the record's own `fp` is
 * carried forward, so a redrop never silently drops it.
 *
 * `snapshot` is REQUIRED on the legacy path (a record whose bytes were never
 * fingerprinted): the redrop then compare-and-swaps against the whole record
 * identity AND requires `fp` to still be absent, exactly like `/backfill-fp`.
 * Without it two requests holding the same legacy snapshot could both
 * «resolve» it — the second landing a fingerprint on top of the first's, or
 * being handed the first's new txId for a different payload.
 */
interface RedropRequest {
  noteId: string;
  txId: string;
  limit: number;
  fp?: string;
  snapshot?: LegacySnapshot;
}
interface BackfillFpRequest {
  noteId: string;
  snapshot: LegacySnapshot;
  /** Computed from the AUTHENTICATED publication (D9). Written on success
   *  regardless of how the comparison then goes. */
  observedFp: string;
}

/** Attach `fp` only when there is one. A helper because the «carry it forward»
 *  rule has to hold at EVERY transition, and a spread typed out by hand at each
 *  of them is exactly how one of them silently drops it. */
function withFp<T extends object>(record: T, fp: string | undefined): T & { fp?: string } {
  return fp === undefined ? record : { ...record, fp };
}

/** The shape `computePublicationFp` produces: SHA-256 as 64 lowercase hex. */
const FP_RE = /^[0-9a-f]{64}$/;

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
    if (url.pathname === '/backfill-fp') return this.handleBackfillFp(request);
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
    const { noteId, limit, fp: requestedFp } = await request.json<CheckAndReserveRequest>();
    const now = Date.now();

    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);

    // ── The fingerprint comparison, in EVERY state that has a txId ──
    //
    // Not only in `committed`: a `posted` record hands out a historical txId
    // too, so comparing one state and not the other would leave the defect
    // reachable through the recheck path.
    //
    // THREE outcomes, and the third is not a failure of the other two:
    // matching, differing, and UNKNOWABLE — a legacy record whose bytes were
    // never fingerprinted. Collapsing «unknown» into either answer is the one
    // move that cannot be undone: read as a match it hands out a txId for bytes
    // nobody compared, read as a difference it quarantines a healthy record.
    // `txId` is optional on the type; a posted/committed record without one is
    // a shape this code never writes. It is skipped rather than asserted away:
    // there is no transaction to authenticate, so neither a comparison nor a
    // backfill is meaningful, and the legacy behaviour below still applies.
    if ((record?.status === 'committed' || record?.status === 'posted')
        && record.txId !== undefined) {
      if (record.fp === undefined) {
        // Legacy. The DO cannot resolve this alone: proving the publication
        // needs network I/O, and a Durable Object must not hold its input gate
        // across an external GET. So it hands out the snapshot and the
        // top-level worker comes back through /backfill-fp.
        return Response.json({
          status: 'legacy',
          snapshot: {
            status: record.status, txId: record.txId, token: record.token, gen: record.gen,
          } satisfies LegacySnapshot,
          // Reported ALONGSIDE the snapshot, not inside it: the CAS compares
          // record identity, and a timestamp is not part of that. The caller
          // needs it for the age guard on the redrop path — a legacy record
          // whose transaction is provably dead must still be re-postable, or it
          // would answer 503 forever.
          committedAt: record.committedAt ?? record.reservedAt ?? 0,
          postedAt: record.postedAt ?? record.reservedAt ?? 0,
        });
      }
      if (requestedFp !== undefined && record.fp !== requestedFp) {
        // The same id under DIFFERENT bytes. A typed conflict, never a silent
        // replay of the historical txId — that pair is exactly what the two
        // irreversible floors exist to make impossible.
        return Response.json({
          status: 'id_payload_conflict', txId: record.txId, state: record.status,
        });
      }
    }

    if (record?.status === 'committed') {
      // Matching fp (or a caller that computed none): the genuine dedupe.
      return Response.json({
        status: 'exists',
        txId: record.txId,
        committedAt: record.committedAt ?? record.reservedAt ?? now,
        deduped: true,
      });
    }
    if (record?.status === 'posted') {
      // Server-authoritative anchor for reconciling a lost commit.
      //
      // Deliberately NOT `exists`, even with a matching fp: `posted` still
      // holds an inFlight slot and still owes a liveness check followed by a
      // commit / 503 / redrop. Answering `committed: true` here would skip that
      // check, leave the DO unfinalized, and could pin a txId that has since
      // dropped out. `deduped` is reported only once the state is resolved.
      return Response.json({
        status: 'posted', txId: record.txId, postedAt: record.postedAt ?? now, token: record.token,
      });
    }
    if (record?.status === 'reserved' && now - (record.reservedAt ?? 0) < RESERVE_TTL_MS) {
      // A fresh reservation has no txId, so there is nothing to compare and
      // nothing to backfill — and no GET is performed. `in_progress` is the
      // whole answer.
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
    // The requested fp is recorded WITH the token: from here on this record is
    // no longer legacy, and every later state carries the same value forward.
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, withFp({
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    }, requestedFp));
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
    // `fp` is carried UNCHANGED: it describes the payload, and posting does not
    // change the payload.
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, withFp({
      status: 'posted', token, gen: record.gen, txId, reservedAt: record.reservedAt, postedAt: Date.now(),
    }, record.fp));
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
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, withFp({
      status: 'committed', token, gen: committedGen, txId, committedAt: now,
    }, record.fp)); // carried, never re-derived
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

  /**
   * Record the fingerprint of a legacy publication, under a full snapshot CAS.
   *
   * ── Why the DO cannot just do this itself ────────────────────────────
   *
   * Proving the publication needs an external GET, and a Durable Object must
   * NOT hold `blockConcurrencyWhile` across network I/O — that serializes every
   * other request behind a gateway's latency. Without the block, though, the DO
   * interleaves: the record can transition while the worker is off verifying,
   * so «read, go away, come back and write» is a lost update waiting to happen.
   *
   * Hence the split: the DO hands out a snapshot, the top-level worker does the
   * I/O, and the write comes back through here with the snapshot it acted on.
   *
   * ── What is compared, and why `fp === undefined` is part of it ───────
   *
   * The WHOLE snapshot — status, txId, token and gen — because any one of them
   * changing means the record is no longer the thing that was verified. And
   * additionally `current.fp === undefined`: two concurrent backfills can hold
   * snapshots that are identical in all four fields, and without this the
   * second would overwrite the first's result. The loser is told `stale` and
   * writes nothing; it will usually find the fp already filled and never repeat
   * the GET.
   *
   * ── observedFp is written on success, ALWAYS ─────────────────────────
   *
   * Independently of how the comparison then goes. The publication has been
   * proven; not storing that would leave the record legacy and force another
   * full verification cycle on the very next request. The COMPARISON is the
   * caller's business — this command records a fact, it does not adjudicate.
   */
  private async handleBackfillFp(request: Request): Promise<Response> {
    const { noteId, snapshot, observedFp } = await request.json<BackfillFpRequest>();
    // Reachable only through the worker's own stub, and checked anyway: this
    // value is written PERMANENTLY and compared byte-for-byte forever after.
    // A malformed one would never match anything and would need an operator
    // to clean up by hand.
    if (typeof observedFp !== 'string' || !FP_RE.test(observedFp)) {
      return Response.json({ ok: false, malformed: true });
    }
    const current = await this.state.storage.get<NoteRecord>(`note:${noteId}`);

    if (
      !current
      || current.fp !== undefined
      || current.status !== snapshot.status
      || current.txId !== snapshot.txId
      || current.token !== snapshot.token
      || current.gen !== snapshot.gen
    ) {
      return Response.json({ ok: false, stale: true, fp: current?.fp ?? null });
    }

    await this.state.storage.put<NoteRecord>(`note:${noteId}`, { ...current, fp: observedFp });
    return Response.json({ ok: true, fp: observedFp });
  }

  /** A posted/committed TX was found dropped → convert back to a fresh
   *  reservation for re-post, respecting quota + attempts. */
  private async handleRedrop(request: Request): Promise<Response> {
    const { noteId, txId, limit, fp: requestedFp, snapshot } = await request.json<RedropRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);

    if (!record) return Response.json({ ok: false, gone: true });

    // Legacy path: the caller acted on a snapshot, so the record must still BE
    // that snapshot — and still be unfingerprinted. Anything else means a
    // concurrent request got here first (a backfill, or another redrop) and
    // the caller must go back through /check-and-reserve, where the comparison
    // happens against whatever is now recorded.
    if (snapshot !== undefined && (
      record.fp !== undefined
      || record.status !== snapshot.status
      || record.txId !== snapshot.txId
      || record.token !== snapshot.token
      || record.gen !== snapshot.gen
    )) {
      return Response.json({ ok: false, stale: true });
    }

    if (record.status === 'reserved') return Response.json({ ok: false, inProgress: true });
    if (record.txId !== txId) {
      // Superseded by another request under a new txId. Whose bytes? The
      // stored fp answers — and it MUST be consulted: handing back the new
      // txId on the strength of «someone committed something under this id»
      // is the exact binding D2 forbids, payload A under transaction B.
      if (record.fp === undefined) {
        // Never fingerprinted: only /check-and-reserve can resolve it, via the
        // backfill protocol.
        return Response.json({ ok: false, legacy: true });
      }
      if (requestedFp !== undefined && record.fp !== requestedFp) {
        return Response.json({
          ok: false, conflict: true, txId: record.txId, state: record.status,
        });
      }
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
    // A redrop re-posts a payload, so the new reservation describes THAT
    // payload's fingerprint. Falling back to the record's own value means a
    // redrop can never silently downgrade a fingerprinted record to legacy —
    // which would cost a full verification cycle on the next request and, worse,
    // make the record briefly incomparable.
    await this.state.storage.put<NoteRecord>(`note:${noteId}`, withFp({
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    }, requestedFp ?? record.fp));
    return Response.json({ ok: true, token });
  }
}
