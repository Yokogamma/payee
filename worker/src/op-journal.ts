/**
 * Operation journal — the per-owner ledger of every admitted `/upload`
 * operation, kept INSIDE the RateLimiter Durable Object next to `note:*`.
 *
 * Why it exists: Analytics Engine samples and Workers Logs are not a receipt
 * for storage (docs/METRICS.md), so neither can establish that a critical
 * outcome NEVER happened over a soak window. The journal is the third book:
 * a durable `begun` record is written in the SAME storage transaction as the
 * /check-and-reserve decision, BEFORE anything can cost money, and a
 * `finished` record is written before the answer leaves. What is not finished
 * stays visible — an unfinished operation is a fact, never an inference.
 *
 * This module is PURE: types, keys and the state-transition rules, with no
 * storage access, so the rules can be tested without a Durable Object and the
 * DO cannot drift from them. `rate-limiter.ts` wires them to storage.
 *
 * Three facts the acceptance never conflates (plan v6.1):
 *   - the publication is confirmed  — only by the signed txId on the pool;
 *   - the handler's decision is confirmed — `finished.outcome`, or the DO's own
 *     `checkVerdict` written in the begin transaction;
 *   - nothing was sent — established by NO automatic rule in this version.
 */

export type OpStatus = 'begun' | 'posting' | 'finished';
export type PaidResult = 'none' | 'accepted' | 'rejected' | 'unknown';
export type OpMode = 'plain' | 'recheck' | 'recovery';
export type IdOrigin = 'client' | 'server';
/** The handler's semantic decision that led to a paid POST — journaled in
 *  /op-posting, BEFORE the send, so a later manual resolution confirms the
 *  publication only and never derives the decision from a found transaction. */
export type PostDecision = 'new' | 'legacy_dead_redrop' | 'recheck_dead_redrop' | 'recovery_dead_repost';

/** What the worker hands the DO alongside /check-and-reserve. */
export interface OpBegin {
  id: string;
  mode: OpMode;
  declaredVersion: string;
  releaseSha: string | null;
  workerVersionId: string | null;
  idOrigin: IdOrigin;
  /** The legacy path asks /check-and-reserve a SECOND time after a backfill.
   *  That is the same operation continuing, not a new one: the record must
   *  already exist and be `begun`, and its verdict history grows. */
  retry?: boolean;
}

export interface OpRecord {
  id: string;
  noteId: string;
  requestedFp?: string;
  mode: OpMode;
  declaredVersion: string;
  releaseSha: string | null;
  workerVersionId: string | null;
  idOrigin: IdOrigin;
  status: OpStatus;
  paidResult: PaidResult;
  /** The status /check-and-reserve answered (latest), written by the DO in the
   *  begin transaction. Survives a lost response to the worker. */
  checkVerdict: string;
  /** Every verdict in order — the legacy path decides twice. */
  checkVerdicts: string[];
  decision?: PostDecision;
  beganAt: number;
  postingAt?: number;
  finishedAt?: number;
  txId?: string;
  /** Reservation token bound at /op-posting — the CAS for /op-abort. NEVER
   *  leaves the DO: `projectOp` strips it. */
  token?: string;
  outcome?: string;
  httpStatus?: number;
  code?: string;
  /** Intermediate `attest` outcomes of the handler (e.g. legacy_backfilled),
   *  delivered with /op-finish. Absent on a record that never finished. */
  attests?: string[];
}

/** What /admin/ops and /op-get hand out: the record minus the token. */
export type OpProjection = Omit<OpRecord, 'token'>;

export function projectOp(record: OpRecord): OpProjection {
  const { token: _token, ...rest } = record;
  void _token;
  return rest;
}

export const OP_KEY_PREFIX = 'op:';
export const OP_INDEX_PREFIX = 'opidx:';
export const OP_META_KEY = 'opmeta';

export function opKey(id: string): string {
  return `${OP_KEY_PREFIX}${id}`;
}

/** Zero-padded 16-hex millis so lexical order equals time order. */
export function opIndexKey(beganAt: number, id: string): string {
  return `${OP_INDEX_PREFIX}${beganAt.toString(16).padStart(16, '0')}:${id}`;
}

/** Lower bound of the index range for `at` (inclusive). */
export function opIndexLowerBound(at: number): string {
  return `${OP_INDEX_PREFIX}${Math.max(0, at).toString(16).padStart(16, '0')}`;
}

/** Upper bound (exclusive): everything begun at or before `at`. */
export function opIndexUpperBound(at: number): string {
  return `${OP_INDEX_PREFIX}${(Math.max(0, at) + 1).toString(16).padStart(16, '0')}`;
}

export interface OpMeta {
  count: number;
  /** Where the last pruning pass stopped (an index key), so a bounded pass
   *  resumes behind the records it already visited instead of re-reading the
   *  same protected head forever. Absent = start from the beginning. */
  pruneCursor?: string;
}

/** Records this old and this many trigger pruning of FINISHED, non-unknown
 *  records. `begun`, `posting` and `paidResult:'unknown'` are never pruned:
 *  an unresolved operation must stay visible for as long as it is unresolved. */
export const OP_PRUNE_MIN_COUNT = 5000;
export const OP_PRUNE_MIN_AGE_MS = 30 * 24 * 3_600_000;
export const OP_PRUNE_BATCH = 100;

export function isPrunable(record: OpRecord, now: number): boolean {
  return record.status === 'finished'
    && record.paidResult !== 'unknown'
    && (record.finishedAt ?? record.beganAt) <= now - OP_PRUNE_MIN_AGE_MS;
}

// ─── Transitions ────────────────────────────────────────────────────

export interface OpPostingRequest { id: string; token: string; txId: string; decision: PostDecision }
export interface OpAbortRequest { id: string; token: string; reason: string }
export interface OpFinishRequest {
  id: string;
  outcome: string;
  httpStatus: number;
  code?: string;
  txId?: string;
  paidResult: PaidResult;
  attests?: string[];
}

export type Transition<T> =
  | { ok: true; record: T }
  | { ok: false; reason: string };

const POST_DECISIONS: ReadonlySet<string> = new Set<PostDecision>([
  'new', 'legacy_dead_redrop', 'recheck_dead_redrop', 'recovery_dead_repost',
]);
const PAID_RESULTS: ReadonlySet<string> = new Set<PaidResult>(['none', 'accepted', 'rejected', 'unknown']);
const TX_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * begun → posting. The caller has signed a transaction and is about to POST
 * it. `reservationToken` is the note's CURRENT reservation token — the DO
 * passes it in after checking the note record itself is `reserved` under this
 * token, so a stale handler cannot mark a note it no longer holds.
 */
export function applyPosting(
  record: OpRecord | undefined,
  req: OpPostingRequest,
  reservationOk: boolean,
  now: number,
): Transition<OpRecord> {
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.status !== 'begun') return { ok: false, reason: `not_begun:${record.status}` };
  if (!reservationOk) return { ok: false, reason: 'reservation_mismatch' };
  if (typeof req.txId !== 'string' || !TX_ID_RE.test(req.txId)) return { ok: false, reason: 'bad_tx_id' };
  if (!POST_DECISIONS.has(req.decision)) return { ok: false, reason: 'bad_decision' };
  return {
    ok: true,
    record: {
      ...record,
      status: 'posting',
      paidResult: 'unknown',
      postingAt: now,
      txId: req.txId,
      token: req.token,
      decision: req.decision,
    },
  };
}

/**
 * posting → finished(audit_aborted, none). ONLY with the token bound at
 * posting, and ONLY from `posting`: the handler calls this on the path BEFORE
 * the POST when its /op-posting confirmation was lost, so a record that says
 * «unknown» does not outlive a send that never happened. There is
 * deliberately no token-less abort — a repeated request with the same
 * operationId never receives a token and therefore can never abort the
 * operation of the call that is still running it.
 */
export function applyAbort(
  record: OpRecord | undefined,
  req: OpAbortRequest,
  now: number,
): Transition<OpRecord> {
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.status !== 'posting') return { ok: false, reason: `not_posting:${record.status}` };
  if (typeof req.token !== 'string' || req.token.length === 0 || record.token !== req.token) {
    return { ok: false, reason: 'token_mismatch' };
  }
  return {
    ok: true,
    record: {
      ...record,
      status: 'finished',
      paidResult: 'none',
      finishedAt: now,
      outcome: 'audit_aborted',
      // The handler answers 503 with the abort reason as its code; recording
      // the same pair here keeps its follow-up /op-finish idempotent.
      httpStatus: 503,
      code: typeof req.reason === 'string' ? req.reason.slice(0, 64) : undefined,
    },
  };
}

/** Field-wise equality of what a repeated /op-finish may carry. */
function sameFinish(record: OpRecord, req: OpFinishRequest): boolean {
  return record.outcome === req.outcome
    && record.paidResult === req.paidResult
    && record.httpStatus === req.httpStatus
    && (record.code ?? undefined) === (req.code ?? undefined)
    && (req.txId === undefined || record.txId === req.txId);
}

/**
 * begun|posting → finished. Idempotent for the same result; a DIFFERENT result
 * on an already finished record is refused and the record is left as it was.
 *
 * `paidResult` is constrained by where the record is:
 *   - from `begun` nothing was ever posted, so only `none` is accepted;
 *   - from `posting`: the journaled txId — the one that was SIGNED and sent —
 *     can never be replaced, whatever the outcome: a finish that names another
 *     transaction is refused for `accepted`, `rejected` and `unknown` alike,
 *     because a later manual resolution must look for exactly the sent
 *     transaction; `accepted` additionally REQUIRES that txId; `none` NEVER —
 *     the only way back from «unknown» to «nothing was sent» is /op-abort with
 *     the token, from the pre-POST path.
 */
export function applyFinish(
  record: OpRecord | undefined,
  req: OpFinishRequest,
  now: number,
): Transition<OpRecord> {
  if (!record) return { ok: false, reason: 'not_found' };
  if (typeof req.outcome !== 'string' || req.outcome.length === 0 || req.outcome.length > 64) {
    return { ok: false, reason: 'bad_outcome' };
  }
  if (!PAID_RESULTS.has(req.paidResult)) return { ok: false, reason: 'bad_paid_result' };
  if (!Number.isInteger(req.httpStatus) || req.httpStatus < 100 || req.httpStatus > 599) {
    return { ok: false, reason: 'bad_http_status' };
  }
  if (req.txId !== undefined && (typeof req.txId !== 'string' || !TX_ID_RE.test(req.txId))) {
    return { ok: false, reason: 'bad_tx_id' };
  }
  if (record.status === 'finished') {
    return sameFinish(record, req) ? { ok: true, record } : { ok: false, reason: 'conflicting_finish' };
  }
  if (record.status === 'begun' && req.paidResult !== 'none') {
    return { ok: false, reason: 'paid_result_without_posting' };
  }
  if (record.status === 'posting') {
    if (req.paidResult === 'none') return { ok: false, reason: 'none_after_posting' };
    if (req.txId !== undefined && req.txId !== record.txId) return { ok: false, reason: 'tx_id_mismatch' };
    if (req.paidResult === 'accepted' && req.txId !== record.txId) return { ok: false, reason: 'tx_id_mismatch' };
  }
  const attests = Array.isArray(req.attests)
    ? req.attests.filter((a): a is string => typeof a === 'string' && a.length <= 64).slice(0, 32)
    : undefined;
  return {
    ok: true,
    record: {
      ...record,
      status: 'finished',
      paidResult: req.paidResult,
      finishedAt: now,
      outcome: req.outcome,
      httpStatus: req.httpStatus,
      ...(req.code !== undefined ? { code: String(req.code).slice(0, 64) } : {}),
      ...(req.txId !== undefined ? { txId: req.txId } : {}),
      ...(attests !== undefined ? { attests } : {}),
    },
  };
}

/** The begin record as written in the /check-and-reserve transaction. */
export function newOpRecord(
  begin: OpBegin,
  noteId: string,
  requestedFp: string | undefined,
  checkVerdict: string,
  now: number,
): OpRecord {
  return {
    id: begin.id,
    noteId,
    ...(requestedFp !== undefined ? { requestedFp } : {}),
    mode: begin.mode,
    declaredVersion: begin.declaredVersion,
    releaseSha: begin.releaseSha,
    workerVersionId: begin.workerVersionId,
    idOrigin: begin.idOrigin,
    status: 'begun',
    paidResult: 'none',
    checkVerdict,
    checkVerdicts: [checkVerdict],
    beganAt: now,
  };
}

/** Statuses /check-and-reserve decides TERMINALLY by itself: the handler
 *  answers without any further step, so the record can close in the same
 *  transaction — a lost response then leaves a finished record, not a begun
 *  one, and the reconciliation reads the DO's own verdict. */
export const DO_TERMINAL_VERDICTS: Readonly<Record<string, { outcome: string; httpStatus: number; code: string }>> = {
  rate_limited: { outcome: 'rate_limited', httpStatus: 429, code: 'rate_limited' },
  reserved: { outcome: 'in_progress', httpStatus: 409, code: 'upload_in_progress' },
  // PR-3b: a note the scheduler owns, and the recovery cap (plan «Bounded
  // backlog») — both retryable 503s decided by the DO itself.
  recovering: { outcome: 'recovery_in_progress', httpStatus: 503, code: 'recovery_in_progress' },
  recovery_capacity: { outcome: 'recovery_capacity', httpStatus: 503, code: 'recovery_capacity' },
};

const OP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The client-supplied operation id must be a UUIDv4 — the shape the driver's
 *  attempt ids already have. A server-generated one is the same shape. */
export function isValidOperationId(id: unknown): id is string {
  return typeof id === 'string' && OP_ID_RE.test(id);
}

export function isValidOpBegin(op: unknown): op is OpBegin {
  if (typeof op !== 'object' || op === null) return false;
  const o = op as Record<string, unknown>;
  return isValidOperationId(o.id)
    && (o.mode === 'plain' || o.mode === 'recheck' || o.mode === 'recovery')
    && typeof o.declaredVersion === 'string'
    && (o.releaseSha === null || typeof o.releaseSha === 'string')
    && (o.workerVersionId === null || typeof o.workerVersionId === 'string')
    && (o.idOrigin === 'client' || o.idOrigin === 'server')
    && (o.retry === undefined || typeof o.retry === 'boolean');
}
