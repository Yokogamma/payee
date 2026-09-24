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
 *
 * Operation journal (plan «soak D2 operation journal» v6.1): NEXT TO the note
 * records, never instead of them. `op:<operationId>` is written in ONE explicit
 * `storage.transaction()` together with the /check-and-reserve decision, the
 * time index and the journal counter: either all of it lands or none of it
 * (a response lost on the way back to the worker leaves a `begun` record with
 * the verdict, never a decision without a record, never a record without its
 * index). `note:*` transitions are UNCHANGED by the journal; it only observes.
 */

import {
  ALARM_BATCH, MONEY_BATCH, MONEY_INDEX_PREFIX, MONEY_STALE_BACKOFF_MS, MONEY_STALE_MS, RECOVERY_AGE_GUARD_MS, RECOVERY_COUNT_KEY, RECOVERY_INDEX_PREFIX,
  anchorOf, backoffMs, casMatches, isRecoveryStatus, minDueAt, moneyIndexKey, parseMoneyIndexKey, recoveryIndexKey, rescheduled,
  type MoneyEntry, type PostedRecord, type RecoveryCas, type RecoveryRecord,
} from './recovery';
import { proveAnchorExpired } from './anchor-expiry';
import { recoverOne, type RecoveryEnv, type RecoveryHost } from './recovery-runner';
import { statusVerdict } from '../../src/lib/status-quorum';
import { parseOriginList } from '../../src/lib/gateways-parse';
import { ARWEAVE_HOST } from './arweave-transport';
import { probeStatusOrigin } from './gateway-reads';
import { makeEmit } from './metrics';
import { moneyQuorum } from './spend-ledger';
import { settleByTx } from './spend-saga';
import {
  type OpBegin, type OpRecord, type OpAbortRequest, type OpFinishRequest, type OpPostingRequest,
  applyAbort, applyFinish, applyPosting, newOpRecord, projectOp, isValidOpBegin, isPrunable,
  opKey, opIndexKey, opIndexLowerBound, opIndexUpperBound, OP_INDEX_PREFIX, OP_META_KEY, type OpMeta,
  OP_PRUNE_MIN_COUNT, OP_PRUNE_BATCH, DO_TERMINAL_VERDICTS,
} from './op-journal';

const WINDOW_MS = 3_600_000;        // 1 hour
const RESERVE_TTL_MS = 600_000;     // 10 min — a reservation older than this is stale
const ATTEMPT_FACTOR = 3;           // attempts ceiling = limit × 3

interface NoteRecord {
  /** `signed` / `redrop_pending` are the PR-3b recovery records (recovery.ts):
   *  read and resumed by the scheduler below, never created by a reader
   *  route. Their extra fields live on `RecoveryRecord`. */
  status: 'reserved' | 'posted' | 'committed' | 'signed' | 'redrop_pending';
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

/** The storage handle a routine works against: the object's storage, or the
 *  transaction it is running inside. Same get/put/delete/list surface. */
type Store = DurableObjectStorage | DurableObjectTransaction;

/** `fp` is the REQUESTED fingerprint — of the payload this request carries. It
 *  is what a stored `fp` is compared against, and what a fresh reservation
 *  records. Optional so a caller that has not computed one still functions:
 *  the record is then written legacy-shaped, exactly as before D2. */
interface CheckAndReserveRequest { noteId: string; limit: number; fp?: string; op?: OpBegin }
/** `anchor` = `last_tx` of the posted bytes, for the money index (the proof
 *  of expiry is about it); optional on the wire, the saga always sends it. */
interface MarkPostedRequest { noteId: string; txId: string; token: string; anchor?: string }
interface CommitRequest { noteId: string; txId: string; token: string; anchor?: string }
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
  /**
   * TEST SEAM — never assigned by production code. A test sets it through
   * `runInDurableObject` to throw INSIDE the admission transaction right after
   * the named write, which is the only way to prove the transaction rolls the
   * earlier writes back (a lost response after a successful call cannot show
   * that window). Read once per admission; `undefined` in every real request.
   */
  faultAfter?: 'decide' | 'op' | 'index';
  /** TEST SEAM for the recovery transactions (`casRecovery`): throw INSIDE
   *  the transaction right after the named write — the rollback proof. */
  recoveryFaultAfter?: 'note' | 'index' | 'count' | 'alarm';
  /** TEST SEAM for the pruning threshold (production: OP_PRUNE_MIN_COUNT). */
  pruneMinCount = OP_PRUNE_MIN_COUNT;
  private env: RecoveryEnv;

  constructor(state: DurableObjectState, env: RecoveryEnv) {
    this.state = state;
    this.env = env;
  }

  /** TEST SEAM — never called by production code. The DO sees the BINDING
   *  env (the unsignable test wallet, the shared guard); a suite that drives
   *  the scheduler hands it the env its worker requests run under. */
  useEnvForTests(env: RecoveryEnv): void {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/check-and-reserve') return this.handleCheckAndReserve(request);
    if (url.pathname === '/recover-now') return this.handleRecoverNow(request);
    if (url.pathname === '/recovery-status') return this.handleRecoveryStatus();
    if (url.pathname === '/mark-posted') return this.handleMarkPosted(request);
    if (url.pathname === '/commit') return this.handleCommit(request);
    if (url.pathname === '/release') return this.handleRelease(request);
    if (url.pathname === '/redrop') return this.handleRedrop(request);
    if (url.pathname === '/backfill-fp') return this.handleBackfillFp(request);
    if (url.pathname === '/op-posting') return this.handleOpPosting(request);
    if (url.pathname === '/op-abort') return this.handleOpAbort(request);
    if (url.pathname === '/op-finish') return this.handleOpFinish(request);
    if (url.pathname === '/op-get') return this.handleOpGet(request);
    if (url.pathname === '/ops') return this.handleOps(request);
    return new Response('Not found', { status: 404 });
  }

  private async window(store: Store, now: number): Promise<Window> {
    let count = (await store.get<number>('count')) ?? 0;
    let inFlight = (await store.get<number>('inFlight')) ?? 0;
    let attempts = (await store.get<number>('attempts')) ?? 0;
    let resetAt = (await store.get<number>('resetAt')) ?? 0;
    if (now > resetAt) {
      count = 0; inFlight = 0; attempts = 0; resetAt = now + WINDOW_MS;
      await store.put('count', 0);
      await store.put('inFlight', 0);
      await store.put('attempts', 0);
      await store.put('resetAt', resetAt);
    }
    return { count, inFlight, attempts, resetAt };
  }

  /**
   * /check-and-reserve = the unchanged decision (`decide`) plus the journal.
   *
   * Order matters and is the whole contract:
   *   1. an `op.id` that already exists answers `op_reused` and touches NOTHING
   *      — not the note record, not the journal (a repeated request can never
   *      alter the operation of the call still running it);
   *   2. the decision runs exactly as before the journal existed;
   *   3. the `begun` record (or, for verdicts the DO decides terminally, the
   *      `finished` one) is written with the verdict, in the same implicit
   *      transaction as the reservation the decision may have made;
   *   4. `opAccepted: true` rides on the answer — the worker treats an answer
   *      without it as «the journal did not take this operation».
   * A caller without `op` (older worker code, the DO tests of the note
   * lifecycle) gets the bare decision, journal untouched.
   */
  private async handleCheckAndReserve(request: Request): Promise<Response> {
    const { noteId, limit, fp: requestedFp, op } = await request.json<CheckAndReserveRequest>();
    const now = Date.now();
    // Self-healing invariant (plan «Отказоустойчивость обработчика»): a
    // recovery backlog without an alarm gets its alarm back on ANY entry.
    await this.healRecoveryAlarm();

    if (op === undefined) {
      const bare = await this.decide(this.state.storage, noteId, limit, requestedFp, now);
      return Response.json(bare.body, { status: bare.http });
    }
    if (!isValidOpBegin(op)) return Response.json({ status: 'op_invalid' });

    // Reuse is answered OUTSIDE the transaction and before any write: nothing
    // about a repeated id may change state.
    const existing = await this.state.storage.get<OpRecord>(opKey(op.id));
    if (op.retry !== true && existing) return Response.json({ status: 'op_reused' });
    if (op.retry === true && (!existing || existing.status !== 'begun' || existing.noteId !== noteId)) {
      return Response.json({ status: 'op_invalid' });
    }

    // ONE transaction: the decision (which may reserve and count), the record,
    // its index entry and the counter. A throw anywhere inside — the test seam
    // included — rolls every write back; the worker then sees an exception
    // and answers `audit_unconfirmed`, and the journal is exactly as it was.
    const faultAfter = this.faultAfter;
    const decided = await this.state.storage.transaction(async (txn) => {
      const d = await this.decide(txn, noteId, limit, requestedFp, now);
      if (faultAfter === 'decide') throw new Error('fault injected after decide');
      const verdict = String(d.body.status);
      if (op.retry === true) {
        // The legacy path's second ask: same operation, continued.
        await txn.put<OpRecord>(opKey(op.id), {
          ...existing!, checkVerdict: verdict, checkVerdicts: [...existing!.checkVerdicts, verdict],
        });
        if (faultAfter === 'op') throw new Error('fault injected after op');
        return d;
      }
      let record = newOpRecord(op, noteId, requestedFp, verdict, now);
      const terminal = DO_TERMINAL_VERDICTS[verdict];
      if (terminal) {
        record = {
          ...record, status: 'finished', finishedAt: now,
          outcome: terminal.outcome, httpStatus: terminal.httpStatus, code: terminal.code,
        };
      }
      await txn.put<OpRecord>(opKey(op.id), record);
      if (faultAfter === 'op') throw new Error('fault injected after op');
      await txn.put(opIndexKey(now, op.id), op.id);
      if (faultAfter === 'index') throw new Error('fault injected after index');
      const meta = (await txn.get<OpMeta>(OP_META_KEY)) ?? { count: 0 };
      await txn.put<OpMeta>(OP_META_KEY, { ...meta, count: meta.count + 1 });
      return d;
    });
    // Pruning is bounded housekeeping OUTSIDE the admission transaction: its
    // deletes must never be able to roll a fresh admission back.
    if (op.retry !== true) {
      const meta = (await this.state.storage.get<OpMeta>(OP_META_KEY)) ?? { count: 0 };
      if (meta.count > this.pruneMinCount) await this.pruneOps(now);
    }
    return Response.json({ ...decided.body, opAccepted: true }, { status: decided.http });
  }

  /**
   * The decision as it was before the journal: every `return Response.json`
   * became `return { http, body }` and nothing else moved. Reviewed CAS
   * semantics (fp comparison, legacy snapshot, stale reservation) unchanged.
   */
  private async decide(
    store: Store, noteId: string, limit: number, requestedFp: string | undefined, now: number,
  ): Promise<{ http: number; body: Record<string, unknown> }> {
    const record = await store.get<NoteRecord>(`note:${noteId}`);

    // ── PR-3b recovery records: the scheduler owns them ──
    // A `signed` / `redrop_pending` note is neither a dedupe nor a free slot:
    // release and TTL are forbidden, only the reconciliation moves it. The
    // worker nudges one step (`/recover-now`) and answers a retryable 503.
    if (record !== undefined && isRecoveryStatus(record.status)) {
      return { http: 200, body: { status: 'recovering', txId: record.txId, recoveryStatus: record.status } };
    }

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
        return { http: 200, body: {
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
        } };
      }
      if (requestedFp !== undefined && record.fp !== requestedFp) {
        // The same id under DIFFERENT bytes. A typed conflict, never a silent
        // replay of the historical txId — that pair is exactly what the two
        // irreversible floors exist to make impossible.
        return { http: 200, body: {
          status: 'id_payload_conflict', txId: record.txId, state: record.status,
        } };
      }
    }

    if (record?.status === 'committed') {
      // Matching fp (or a caller that computed none): the genuine dedupe.
      return { http: 200, body: {
        status: 'exists',
        txId: record.txId,
        committedAt: record.committedAt ?? record.reservedAt ?? now,
        deduped: true,
      } };
    }
    if (record?.status === 'posted') {
      // Server-authoritative anchor for reconciling a lost commit.
      //
      // Deliberately NOT `exists`, even with a matching fp: `posted` still
      // holds an inFlight slot and still owes a liveness check followed by a
      // commit / 503 / redrop. Answering `committed: true` here would skip that
      // check, leave the DO unfinalized, and could pin a txId that has since
      // dropped out. `deduped` is reported only once the state is resolved.
      return { http: 200, body: {
        status: 'posted', txId: record.txId, postedAt: record.postedAt ?? now, token: record.token,
      } };
    }
    if (record?.status === 'reserved' && now - (record.reservedAt ?? 0) < RESERVE_TTL_MS) {
      // A fresh reservation has no txId, so there is nothing to compare and
      // nothing to backfill — and no GET is performed. `in_progress` is the
      // whole answer.
      return { http: 200, body: { status: 'reserved' } };
    }

    // Bounded backlog (plan «Bounded backlog»): MAX_RECOVERY_INFLIGHT =
    // quotaLimit recovery records per key; at the cap a new upload is refused
    // BEFORE anything is signed, so no durable/postable txId exists beyond it.
    const recoveryCount = (await store.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    if (recoveryCount >= limit) return { http: 503, body: { status: 'recovery_capacity', recoveryCount } };

    // No record or a STALE reservation we replace — reuse its own inFlight slot.
    const w = await this.window(store, now);
    const staleOwnSlot = record?.status === 'reserved' && record.gen === w.resetAt ? 1 : 0;
    const effectiveInFlight = Math.max(0, w.inFlight - staleOwnSlot);

    if (w.count + effectiveInFlight >= limit) return { http: 429, body: { status: 'rate_limited' } };
    if (w.attempts >= limit * ATTEMPT_FACTOR) return { http: 429, body: { status: 'rate_limited' } };

    const token = crypto.randomUUID();
    await store.put('inFlight', effectiveInFlight + 1);
    await store.put('attempts', w.attempts + 1);
    // The requested fp is recorded WITH the token: from here on this record is
    // no longer legacy, and every later state carries the same value forward.
    await store.put<NoteRecord>(`note:${noteId}`, withFp({
      status: 'reserved', token, gen: w.resetAt, reservedAt: now,
    }, requestedFp));
    return { http: 200, body: { status: 'ok', token } };
  }

  // ─── Operation journal ────────────────────────────────────────────

  /** begun → posting: the signed txId and the decision, BEFORE the POST. The
   *  note record must still be `reserved` under the caller's token — the
   *  journal binds itself to a reservation the caller provably holds. */
  private async handleOpPosting(request: Request): Promise<Response> {
    const req = await request.json<OpPostingRequest>();
    const record = await this.state.storage.get<OpRecord>(opKey(req.id));
    let reservationOk = false;
    if (record) {
      const note = await this.state.storage.get<NoteRecord>(`note:${record.noteId}`);
      reservationOk = !!note && note.status === 'reserved' && note.token === req.token;
    }
    const t = applyPosting(record, req, reservationOk, Date.now());
    if (!t.ok) return Response.json({ ok: false, reason: t.reason });
    await this.state.storage.put<OpRecord>(opKey(req.id), t.record);
    return Response.json({ ok: true });
  }

  /** posting → finished(audit_aborted). Token-CAS only; see applyAbort. */
  private async handleOpAbort(request: Request): Promise<Response> {
    const req = await request.json<OpAbortRequest>();
    const record = await this.state.storage.get<OpRecord>(opKey(req.id));
    const t = applyAbort(record, req, Date.now());
    if (!t.ok) return Response.json({ ok: false, reason: t.reason });
    await this.state.storage.put<OpRecord>(opKey(req.id), t.record);
    return Response.json({ ok: true });
  }

  /** begun|posting → finished. Idempotent; a different result is refused. */
  private async handleOpFinish(request: Request): Promise<Response> {
    const req = await request.json<OpFinishRequest>();
    const record = await this.state.storage.get<OpRecord>(opKey(req.id));
    const t = applyFinish(record, req, Date.now());
    if (!t.ok) return Response.json({ ok: false, reason: t.reason });
    if (t.record !== record) await this.state.storage.put<OpRecord>(opKey(req.id), t.record);
    return Response.json({ ok: true });
  }

  private async handleOpGet(request: Request): Promise<Response> {
    const { id } = await request.json<{ id: string }>();
    if (typeof id !== 'string') return Response.json({ op: null });
    const record = await this.state.storage.get<OpRecord>(opKey(id));
    return Response.json({ op: record ? projectOp(record) : null });
  }

  /**
   * Time-ordered slice of the journal, `from..to` by `beganAt` (ms, inclusive
   * both ends), paged by `cursor` (the last index key of the previous page).
   * Never the token. `limit` is capped here as well as in the worker.
   */
  private async handleOps(request: Request): Promise<Response> {
    const { from, to, cursor, limit } = await request.json<{
      from: number; to: number; cursor?: string; limit?: number;
    }>();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      return Response.json({ ops: [], cursor: null, error: 'bad_range' });
    }
    const pageSize = Math.min(500, Math.max(1, Number.isInteger(limit) ? (limit as number) : 100));
    const lower = opIndexLowerBound(from);
    const upper = opIndexUpperBound(to);
    const start = typeof cursor === 'string' && cursor > lower && cursor.startsWith(OP_INDEX_PREFIX)
      ? cursor : lower;
    // A cursor is the last key of the previous page: resume strictly AFTER it.
    const page = await this.state.storage.list<string>({
      ...(start !== lower ? { startAfter: start } : { start }), end: upper, limit: pageSize + 1,
    });
    const entries = [...page.entries()];
    const hasMore = entries.length > pageSize;
    const slice = hasMore ? entries.slice(0, pageSize) : entries;
    const ops = [];
    for (const [, id] of slice) {
      const record = await this.state.storage.get<OpRecord>(opKey(id));
      if (record) ops.push(projectOp(record));
    }
    const nextCursor = hasMore && slice.length > 0 ? slice[slice.length - 1][0] : null;
    return Response.json({ ops, cursor: nextCursor });
  }

  /**
   * Bounded housekeeping: one batch of the time index per call, resuming
   * behind the previous batch through `opmeta.pruneCursor`, wrapping to the
   * start when the end is reached. Only FINISHED records with a known
   * paidResult and older than OP_PRUNE_MIN_AGE_MS are removed; `begun`,
   * `posting` and `paidResult:'unknown'` are skipped and STAY — an unresolved
   * operation is visible for as long as it is unresolved. The cursor is what
   * keeps a protected head (100 unresolved records at the front) from hiding
   * everything behind it forever.
   */
  private async pruneOps(now: number): Promise<void> {
    const meta = (await this.state.storage.get<OpMeta>(OP_META_KEY)) ?? { count: 0 };
    const page = await this.state.storage.list<string>({
      prefix: OP_INDEX_PREFIX, limit: OP_PRUNE_BATCH,
      ...(meta.pruneCursor !== undefined ? { startAfter: meta.pruneCursor } : {}),
    });
    let removed = 0;
    let last: string | undefined;
    for (const [indexKey, id] of page.entries()) {
      last = indexKey;
      const record = await this.state.storage.get<OpRecord>(opKey(id));
      if (!record) { await this.state.storage.delete(indexKey); continue; }
      if (!isPrunable(record, now)) continue;
      await this.state.storage.delete(opKey(id));
      await this.state.storage.delete(indexKey);
      removed += 1;
    }
    const exhausted = page.size < OP_PRUNE_BATCH;
    const next: OpMeta = {
      count: Math.max(0, meta.count - removed),
      ...(exhausted || last === undefined ? {} : { pruneCursor: last }),
    };
    await this.state.storage.put<OpMeta>(OP_META_KEY, next);
  }

  /** Record a successful Arweave POST BEFORE commit, so a lost commit stays
   *  reconcilable with the server's own txId. Slot stays inFlight. */
  private async handleMarkPosted(request: Request): Promise<Response> {
    const { noteId, txId, token, anchor } = await request.json<MarkPostedRequest>();
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
    const now = Date.now();
    await this.state.storage.transaction(async (txn) => {
      await txn.put<NoteRecord>(`note:${noteId}`, withFp({
        status: 'posted', token, gen: record.gen, txId, reservedAt: record.reservedAt, postedAt: now,
      }, record.fp));
      // The money of this txId is `active` in the guard until a quorum
      // settles it — schedule that reconciliation here, durably, so it does
      // not depend on the client ever rechecking (review 24.09 #2, high 4).
      await this.scheduleMoneyInTxn(txn, noteId, txId, now, now, typeof anchor === 'string' ? anchor : undefined);
    });
    return Response.json({ ok: true });
  }

  private async handleCommit(request: Request): Promise<Response> {
    const { noteId, txId, token, anchor } = await request.json<CommitRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (!record || (record.status !== 'reserved' && record.status !== 'posted') || record.token !== token) {
      return Response.json({ ok: false, stale: true });
    }

    const now = Date.now();
    await this.state.storage.transaction(async (txn) => {
      const w = await this.window(txn, now);
      let committedGen = record.gen;
      if (record.gen === w.resetAt) {
        if (w.inFlight > 0) await txn.put('inFlight', w.inFlight - 1);
        await txn.put('count', w.count + 1);
        committedGen = w.resetAt;
      }
      await txn.put<NoteRecord>(`note:${noteId}`, withFp({
        status: 'committed', token, gen: committedGen, txId, committedAt: now,
      }, record.fp)); // carried, never re-derived
      // `reserved → committed` (mark-posted lost three times) is a POSTed txId
      // too: its reservation is reconciled by the money index like any other
      // (review 24.09 #3, high 3). Idempotent for `posted → committed`.
      await this.scheduleMoneyInTxn(txn, noteId, txId, record.postedAt ?? now, record.postedAt ?? now, typeof anchor === 'string' ? anchor : undefined);
    });
    return Response.json({ ok: true });
  }

  /** Release a RESERVED slot on POST failure. Never releases a posted/committed
   *  record (those represent a real on-chain TX). Idempotent; token-scoped. */
  private async handleRelease(request: Request): Promise<Response> {
    const { noteId, token } = await request.json<ReleaseRequest>();
    const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
    if (record && record.status === 'reserved' && record.token === token) {
      const w = await this.window(this.state.storage, Date.now());
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
    const w = await this.window(this.state.storage, now);
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

  // ─── PR-3b recovery: the single-alarm scheduler ─────────────────────────
  //
  // Recovery records (`signed`, `redrop_pending` — recovery.ts) are indexed
  // by `recovery:<noteId> = dueAt`; `recoveryCount` is the persistent size of
  // that set (the cap). Every mutation of the set is ONE storage transaction
  // that writes the note, the index, the counter and the alarm
  // (= min(dueAt), or none) together — the only crash-atomicity mechanism.
  // The network half of a step is recovery-runner.ts; this DO owns the CAS.

  /**
   * The WRITER's primitive (and the tests' seed): admit a recovery record.
   * No route of the READER calls it — the reader resumes, it does not
   * create. Kept here because the transaction is the same one the writer
   * will need, and the reader must already understand what it writes.
   */
  async adoptRecovery(noteId: string, record: RecoveryRecord): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      const existing = await txn.get<NoteRecord>(`note:${noteId}`);
      const wasRecovery = existing !== undefined && isRecoveryStatus(existing.status);
      await txn.put<NoteRecord>(`note:${noteId}`, record as unknown as NoteRecord);
      await txn.put(recoveryIndexKey(noteId), record.dueAt);
      if (!wasRecovery) await txn.put(RECOVERY_COUNT_KEY, ((await txn.get<number>(RECOVERY_COUNT_KEY)) ?? 0) + 1);
      await this.rearmInTxn(txn);
    });
  }

  /** CAS-guarded transition of a recovery record — one transaction for the
   *  note, the index, the counter and the alarm (plan «Атомарность»). */
  async casRecovery(noteId: string, expected: RecoveryCas, next: RecoveryRecord | PostedRecord): Promise<boolean> {
    const fault = this.recoveryFaultAfter;
    return this.state.storage.transaction(async (txn) => {
      const current = await txn.get<NoteRecord>(`note:${noteId}`);
      if (!casMatches(current, expected)) return false;
      await txn.put<NoteRecord>(`note:${noteId}`, next as unknown as NoteRecord);
      if (fault === 'note') throw new Error('fault injected after note');
      if (isRecoveryStatus(next.status)) {
        const rec = next as RecoveryRecord;
        await txn.put(recoveryIndexKey(noteId), rec.dueAt);
        // Phase 1 of a redrop: the DEAD txId had a permit, so its bytes may
        // still land after the release — it goes under WATCH in the money
        // index, atomically with the transition (review 24.09 #4, high 2).
        if (rec.status === 'redrop_pending' && rec.deadTxId !== undefined && expected.status === 'signed') {
          await this.scheduleMoneyInTxn(txn, noteId, rec.deadTxId, rec.postedAt ?? rec.signedAt, rec.redropAt, anchorOf(rec.signedTx));
        }
      } else {
        await txn.delete(recoveryIndexKey(noteId));
        if (fault === 'index') throw new Error('fault injected after index');
        await txn.put(RECOVERY_COUNT_KEY, Math.max(0, ((await txn.get<number>(RECOVERY_COUNT_KEY)) ?? 0) - 1));
        // Leaving the recovery set as `posted` hands the money over to the
        // money index — the reservation is still `active` in the guard.
        await this.scheduleMoneyInTxn(txn, noteId, (next as PostedRecord).txId, (next as PostedRecord).postedAt, (next as PostedRecord).postedAt, (next as PostedRecord).anchor);
      }
      if (fault === 'count') throw new Error('fault injected after count');
      await this.rearmInTxn(txn);
      if (fault === 'alarm') throw new Error('fault injected after alarm');
      return true;
    });
  }

  /** alarm := min(dueAt) over BOTH indexes (recovery and money), or none. */
  private async rearmInTxn(txn: DurableObjectTransaction | DurableObjectStorage): Promise<number | null> {
    const idx = await txn.list<number>({ prefix: RECOVERY_INDEX_PREFIX });
    const money = await txn.list<MoneyEntry>({ prefix: MONEY_INDEX_PREFIX });
    const min = minDueAt([...idx.values(), ...[...money.values()].map(m => m.dueAt)]);
    if (min === null) await txn.deleteAlarm();
    else await txn.setAlarm(min);
    return min;
  }

  /** Enter (or keep) the money index for a POSTed txId; due one backoff
   *  after `dueFrom` (the POST by default; the phase-1 transition for a dead
   *  txId whose POST lies further back — `postedAt` still dates the POST, for
   *  the age guard and the landing bound). */
  private async scheduleMoneyInTxn(txn: DurableObjectTransaction, noteId: string, txId: string, postedAt: number, dueFrom: number = postedAt, anchor?: string): Promise<void> {
    if (await txn.get<MoneyEntry>(moneyIndexKey(noteId, txId))) return;
    await txn.put<MoneyEntry>(moneyIndexKey(noteId, txId), { txId, dueAt: dueFrom + backoffMs(0), attempts: 0, postedAt, ...(anchor !== undefined ? { anchor } : {}) });
    await this.rearmInTxn(txn);
  }

  private async healRecoveryAlarm(): Promise<void> {
    const count = (await this.state.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0;
    if (count <= 0) {
      const money = await this.state.storage.list<MoneyEntry>({ prefix: MONEY_INDEX_PREFIX, limit: 1 });
      if (money.size === 0) return;
    }
    if ((await this.state.storage.getAlarm()) !== null) return;
    try { await this.rearmInTxn(this.state.storage); } catch (e) { console.error('RECOVERY_ALARM_HEAL_FAILED', e); }
  }

  private recoveryHost(now: number): RecoveryHost {
    return {
      cas: (noteId, expected, next) => this.casRecovery(noteId, expected, next),
      stillMine: async (noteId, expected) => casMatches(await this.state.storage.get<NoteRecord>(`note:${noteId}`), expected),
      now: () => now,
    };
  }

  /**
   * One money-reconciliation step (review 24.09 #2 high 4, #4 high 2, #5
   * high 1–2): the status quorum for the POSTed txId.
   *
   *  - a money quorum → `settle-by-tx spent`; the entry ends once the guard
   *    has BOOKED the money (`settled`, `noop`), or says no permit names the
   *    txId (`unknown`, a pre-D10 publication), or refuses for good
   *    (`terminal_refusal`: `spent_is_final` — booked already — or a
   *    reservation that never could have been sent);
   *  - unanimous `dead` past the age guard → `released`. A release does NOT
   *    end the entry: the bytes had a permit and a dead verdict is a
   *    snapshot — the entry turns into a WATCH, so a late landing is
   *    re-booked by the lattice (`released → spent`, `spend_conflict`) by
   *    THIS step and not by nobody;
   *  - `released` refused under an open send lease (`in_flight`): the step
   *    fetches the chain's proof that the anchor expired (`anchor-expiry.ts`)
   *    and, with it accepted by the guard, asks again in the same pass;
   *    without it the hold stays;
   *  - a WATCH ends only with the same proof from the chain, taken while the
   *    pool still says dead — never with the clock;
   *  - a guard that did not answer keeps the entry for the next pass with
   *    backoff (review 24.09 #3, high 2);
   *  - an entry older than MONEY_STALE_MS is never dropped (review #5 high
   *    2): it escalates (`stale` result, a log line) and slows down to
   *    MONEY_STALE_BACKOFF_MS. An unresolved money obligation ends with a
   *    fact from the chain or the guard, not with age — 49 confirmations
   *    today are 60 tomorrow.
   */
  private async reconcileMoney(noteId: string, entry: MoneyEntry, now: number): Promise<string> {
    const env = this.env;
    const emit = makeEmit(env);
    const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
    const origins = parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
    const votes = await Promise.all(origins.map(o => probeStatusOrigin(o, entry.txId, emit)));
    const money = moneyQuorum(votes, o => o);
    const dead = statusVerdict(origins, votes).kind === 'dead';
    const guard = env.SPEND_GUARD.get(env.SPEND_GUARD.idFromName('global'));
    let outcome: 'spent' | 'released' | null = null;
    if (money.ok) outcome = 'spent';
    else if (!entry.watching && dead && now - entry.postedAt > RECOVERY_AGE_GUARD_MS) outcome = 'released';
    let result = 'rescheduled';
    let terminal = false;
    let watching = entry.watching === true;
    const proveExpiry = async (): Promise<'expired' | 'held'> => {
      if (entry.anchor === undefined) { emit('anchor_proof', ['unavailable', 'no_anchor'], [-1]); return 'held'; }
      const p = await proveAnchorExpired(env, guard, emit, { txId: entry.txId, anchor: entry.anchor });
      return p === 'expired' || p === 'unknown' ? 'expired' : 'held';
    };
    if (outcome !== null) {
      let r = await settleByTx(guard, { txId: entry.txId, outcome, ...(money.ok ? { height: money.height } : {}) });
      if (outcome === 'released' && r === 'in_flight' && (await proveExpiry()) === 'expired') {
        r = await settleByTx(guard, { txId: entry.txId, outcome });
      }
      emit('money_reconcile', [outcome, r], [entry.attempts]);
      if (outcome === 'spent') {
        terminal = r === 'settled' || r === 'noop' || r === 'unknown' || r === 'terminal_refusal';
      } else if (r === 'settled' || r === 'noop') {
        watching = true; // released — now watch for a late landing
      } else if (r === 'unknown' || r === 'terminal_refusal') {
        terminal = true; // nothing of ours was ever sendable, or it is booked already
      }
      result = terminal ? `${outcome}:${r}` : watching && !entry.watching ? `${outcome}:watch` : 'retry';
    } else if (watching && dead) {
      // The watch ends only with BOTH facts from the chain: the pool still
      // shows nothing AND the anchor has provably expired.
      const p = await proveExpiry();
      emit('money_reconcile', ['watch', p === 'expired' ? 'expired' : 'held'], [entry.attempts]);
      if (p === 'expired') { terminal = true; result = 'watch:expired'; }
    } else {
      emit('money_reconcile', [watching ? 'watch' : 'wait', 'pending'], [entry.attempts]);
    }
    const stale = !terminal && now - entry.postedAt >= MONEY_STALE_MS;
    if (stale) {
      console.error('MONEY_RECONCILE_STALE', noteId, entry.txId, watching ? 'watch' : 'settle', 'attempts', entry.attempts);
      emit('money_reconcile', [watching ? 'watch' : 'wait', 'stale'], [entry.attempts]);
    }
    await this.state.storage.transaction(async (txn) => {
      const key = moneyIndexKey(noteId, entry.txId);
      const current = await txn.get<MoneyEntry>(key);
      if (!current) return; // removed under us
      if (terminal) await txn.delete(key);
      else {
        const wait = stale ? Math.max(backoffMs(current.attempts + 1), MONEY_STALE_BACKOFF_MS) : backoffMs(current.attempts + 1);
        await txn.put<MoneyEntry>(key, { ...current, ...(watching ? { watching: true } : {}), attempts: current.attempts + 1, dueAt: now + wait });
      }
      await this.rearmInTxn(txn);
    });
    return result;
  }

  /** The alarm handler: due records, sequentially, at most ALARM_BATCH;
   *  each in its own try/catch; the alarm is ALWAYS re-armed in `finally`
   *  (with a bounded retry), and an unprocessed remainder gets it now. */
  async alarm(): Promise<void> {
    await this.runRecovery(Date.now());
  }

  async runRecovery(now: number): Promise<{ processed: number; remaining: number; money: number }> {
    let processed = 0; let remaining = 0; let money = 0;
    try {
      const idx = await this.state.storage.list<number>({ prefix: RECOVERY_INDEX_PREFIX });
      const due = [...idx.entries()].filter(([, d]) => d <= now).sort((a, b) => a[1] - b[1]);
      remaining = Math.max(0, due.length - ALARM_BATCH);
      // Money reconciliation: its own bounded batch, each in its own try/catch.
      const moneyIdx = await this.state.storage.list<MoneyEntry>({ prefix: MONEY_INDEX_PREFIX });
      const moneyDue = [...moneyIdx.entries()].filter(([, m]) => m.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt);
      remaining += Math.max(0, moneyDue.length - MONEY_BATCH);
      for (const [key, entry] of moneyDue.slice(0, MONEY_BATCH)) {
        const { noteId } = parseMoneyIndexKey(key);
        try { await this.reconcileMoney(noteId, entry, now); } catch (e) { console.error('MONEY_RECONCILE_FAILED', noteId, e); }
        money++;
      }
      for (const [key] of due.slice(0, ALARM_BATCH)) {
        const noteId = key.slice(RECOVERY_INDEX_PREFIX.length);
        try {
          await this.recoverNote(noteId, now);
        } catch (e) {
          console.error('RECOVERY_STEP_FAILED', noteId, e);
          // Reschedule with backoff so one broken record cannot spin; if even
          // that write fails the finally below still re-arms the alarm.
          try {
            const record = await this.state.storage.get<RecoveryRecord>(`note:${noteId}`);
            if (record && isRecoveryStatus(record.status)) {
              await this.casRecovery(noteId, { status: record.status, token: record.token, txId: record.txId }, rescheduled(record, Date.now()));
            }
          } catch (e2) {
            console.error('RECOVERY_RESCHEDULE_FAILED', noteId, e2);
          }
        }
        processed++;
      }
    } finally {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (remaining > 0) await this.state.storage.setAlarm(Date.now());
          else await this.rearmInTxn(this.state.storage);
          break;
        } catch (e) {
          console.error('RECOVERY_REARM_FAILED', attempt, e);
        }
      }
    }
    return { processed, remaining, money };
  }

  /** One step for one note (the alarm's unit, and the recheck's nudge). */
  private async recoverNote(noteId: string, now: number): Promise<string> {
    const record = await this.state.storage.get<RecoveryRecord>(`note:${noteId}`);
    if (!record || !isRecoveryStatus(record.status)) {
      // A stale index entry (the record moved on): drop it and keep the
      // counter honest.
      await this.state.storage.transaction(async (txn) => {
        if (await txn.get(recoveryIndexKey(noteId)) === undefined) return;
        await txn.delete(recoveryIndexKey(noteId));
        await txn.put(RECOVERY_COUNT_KEY, Math.max(0, ((await txn.get<number>(RECOVERY_COUNT_KEY)) ?? 0) - 1));
        await this.rearmInTxn(txn);
      });
      return 'not_recovery';
    }
    return recoverOne(noteId, record, this.env, this.recoveryHost(now));
  }

  /** Trigger (а) of the reconciliation: a recheck of this note runs one step
   *  now instead of waiting for the alarm. */
  private async handleRecoverNow(request: Request): Promise<Response> {
    const { noteId } = await request.json<{ noteId: string }>();
    if (typeof noteId !== 'string') return Response.json({ ok: false, reason: 'bad_note' });
    try {
      const outcome = await this.recoverNote(noteId, Date.now());
      const record = await this.state.storage.get<NoteRecord>(`note:${noteId}`);
      return Response.json({ ok: true, outcome, status: record?.status ?? null, txId: record?.txId ?? null });
    } catch (e) {
      console.error('RECOVER_NOW_FAILED', noteId, e);
      return Response.json({ ok: false, reason: 'step_failed' });
    } finally {
      await this.healRecoveryAlarm();
    }
  }

  private async handleRecoveryStatus(): Promise<Response> {
    const idx = await this.state.storage.list<number>({ prefix: RECOVERY_INDEX_PREFIX });
    const money = await this.state.storage.list<MoneyEntry>({ prefix: MONEY_INDEX_PREFIX });
    return Response.json({
      recoveryCount: (await this.state.storage.get<number>(RECOVERY_COUNT_KEY)) ?? 0,
      alarm: await this.state.storage.getAlarm(),
      due: Object.fromEntries([...idx.entries()].map(([k, d]) => [k.slice(RECOVERY_INDEX_PREFIX.length), d])),
      money: Object.fromEntries([...money.entries()].map(([k, m]) => [k.slice(MONEY_INDEX_PREFIX.length), m])),
    });
  }
}
