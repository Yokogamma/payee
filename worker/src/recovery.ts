/**
 * PR-3b recovery records — the PURE rules (no Durable Object, no network).
 *
 * Plan: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-3b «Storage-контракт signed»,
 * «Single-alarm scheduler», «Вердикты alarm-прогона», «Redrop — явно
 * двухфазный». A recovery record is a per-key note record in one of the two
 * scheduler-visible states:
 *
 *   signed          — a durable, POSTABLE transaction: txId + the signed bytes
 *                     INLINE. Never released, never TTL-expired. The only ways
 *                     forward: resend of the SAME bytes + reconciliation by the
 *                     status quorum (→ `posted`), or — dead + age guard — the
 *                     two-phase redrop.
 *   redrop_pending  — phase 1 done (the old txId is PROVEN dead); phase 2 (a
 *                     new signature from the SAME data and tags, taken from the
 *                     stored bytes) is pending. Stays scheduler-visible and in
 *                     the cap until phase 2 commits a new `signed`.
 *
 * The READER release carries this whole contract — resend, reconciliation,
 * both redrop phases, the scheduler — and differs from the writer in exactly
 * one thing: it never CREATES a `signed` for a new upload (`adoptRecovery` is
 * the writer's primitive; no route of the reader calls it).
 *
 * Everything here is a total, synchronous decision over plain data; the DO
 * wraps each transition in ONE `storage.transaction` with CAS on
 * `{status, token, txId}` (plan: «CAS после КАЖДОГО внешнего await»).
 */

import type { QuorumVerdict } from '../../src/lib/status-quorum';

// ─── Constants (plan §4.PR-3b) ──────────────────────────────────────────

/** Max recovery records one alarm run processes (subrequest budget). */
export const ALARM_BATCH = 5;
/** Age a dead verdict must have before a redrop is allowed — the same 30 min
 *  the recheck path applies to a committed transaction. */
export const RECOVERY_AGE_GUARD_MS = 30 * 60_000;
export const RECOVERY_BACKOFF_BASE_MS = 60_000;
export const RECOVERY_BACKOFF_CAP_MS = 3_600_000;
/** Internal worst case of a serialised signed transaction at
 *  MAX_BODY_BYTES = 51200 (plan: ≤ ~75 KB, 25× under the SQLite 2 MB). */
export const SIGNED_TX_MAX_BYTES = 75 * 1024;
export const RECOVERY_COUNT_KEY = 'recoveryCount';
export const RECOVERY_INDEX_PREFIX = 'recovery:';
/** The MONEY reconciliation index (review 24.09 #2 high 4, #4 high 2): a
 *  txId that was (or may have been) POSTed and whose D10 reservation is not
 *  finally accounted yet — `money:<noteId>:<txId> = { txId, dueAt, attempts,
 *  postedAt, watching? }`. Keyed by txId as well as note: a redrop leaves the
 *  DEAD txId under watch while the new one is being settled. Independent of
 *  the client's rechecks and of the recovery set: entered at `mark-posted`
 *  (the ordinary path), at recovery → posted, and at phase 1 of a redrop (the
 *  dead txId, whose permit was issued). It leaves only when the guard has
 *  booked the money (`spent`), or when the bytes were released AND the
 *  network can no longer accept them (`watching` for LATE_LANDING_BOUND_MS
 *  after the POST — a late landing is then re-booked `released → spent`). */
export const MONEY_INDEX_PREFIX = 'money:';
export const MONEY_BATCH = 5;
/** Hard ceiling on a watch whose status never settles (a pool that answers
 *  `pending`/`unavailable` forever): the entry is dropped with a log line. */
export const MONEY_WATCH_MAX_MS = 7 * 24 * 3_600_000;

export interface MoneyEntry {
  txId: string; dueAt: number; attempts: number; postedAt: number;
  /** The reservation is `released` in the guard; the entry stays only to catch
   *  a late landing (review 24.09 #4, high 2). */
  watching?: boolean;
}

export function recoveryIndexKey(noteId: string): string {
  return `${RECOVERY_INDEX_PREFIX}${noteId}`;
}
export function moneyIndexKey(noteId: string, txId: string): string {
  return `${MONEY_INDEX_PREFIX}${noteId}:${txId}`;
}
/** `money:<noteId>:<txId>` → the pair (a txId carries no `:`, a noteId is a UUID). */
export function parseMoneyIndexKey(key: string): { noteId: string; txId: string } {
  const rest = key.slice(MONEY_INDEX_PREFIX.length);
  const at = rest.lastIndexOf(':');
  return { noteId: rest.slice(0, at), txId: rest.slice(at + 1) };
}

// ─── Records ────────────────────────────────────────────────────────────

export type RecoveryStatus = 'signed' | 'redrop_pending';

/** The storage contract (plan «Storage-контракт signed», v17 fields). */
export interface RecoveryRecord {
  status: RecoveryStatus;
  /** CAS token of the record's current owner. */
  token: string;
  /** The rate window the record was admitted in (existing note-record field). */
  gen: number;
  /** `signed`: the durable, postable txId. `redrop_pending`: the DEAD txId
   *  (phase 1 keeps it until phase 2 replaces it). */
  txId: string;
  /** The signed transaction, `toJSON()` serialised, INLINE. In
   *  `redrop_pending` it is the OLD one — the only durable source of the
   *  payload and tags for phase 2. */
  signedTx: string;
  anchorHeight?: number;
  signedAt: number;
  /** Scheduler: when the next reconciliation is due, and how many runs. */
  dueAt: number;
  attempts: number;
  /** Lineage after a redrop (audit). */
  deadTxId?: string;
  /** D10 saga binding (plan v17): the reservation this signature was
   *  activated (or is to be activated) under. */
  spendKey: string;
  reward: string;
  spendRevision: number;
  /** The generation (one durable/postable txId per generation). */
  generation: number;
  fp?: string;
  reservedAt?: number;
  /** When the (last) POST of this txId was accepted, if any — the age guard
   *  of the dead verdict counts from the latest of signedAt / postedAt. */
  postedAt?: number;
  /** When phase 1 happened (`redrop_pending`). */
  redropAt?: number;
}

export function isRecoveryStatus(status: unknown): status is RecoveryStatus {
  return status === 'signed' || status === 'redrop_pending';
}

/** The identity a transition is CAS-ed against. */
export interface RecoveryCas { status: RecoveryStatus; token: string; txId: string }

export function casOf(r: RecoveryRecord): RecoveryCas {
  return { status: r.status, token: r.token, txId: r.txId };
}
export function casMatches(current: { status: unknown; token?: unknown; txId?: unknown } | undefined, expected: RecoveryCas): boolean {
  return current !== undefined && current.status === expected.status && current.token === expected.token && current.txId === expected.txId;
}

// ─── Scheduling ─────────────────────────────────────────────────────────

/** Exponential backoff with a ceiling: 1, 2, 4 … minutes, capped at 1 h. */
export function backoffMs(attempts: number): number {
  const n = Math.max(0, Math.min(attempts, 30));
  return Math.min(RECOVERY_BACKOFF_CAP_MS, RECOVERY_BACKOFF_BASE_MS * 2 ** n);
}

/** The record after a run that did not advance it: one more attempt, due
 *  after the backoff. Everything else is untouched — a `signed` keeps its
 *  bytes, a `redrop_pending` keeps the OLD bytes. */
export function rescheduled(r: RecoveryRecord, now: number): RecoveryRecord {
  const attempts = r.attempts + 1;
  return { ...r, attempts, dueAt: now + backoffMs(attempts) };
}

/** The global alarm = min(dueAt) over the recovery set, or null when empty. */
export function minDueAt(dueAts: Iterable<number>): number | null {
  let min: number | null = null;
  for (const d of dueAts) if (min === null || d < min) min = d;
  return min;
}

// ─── The verdict table for `signed` (plan «Вердикты alarm-прогона») ──────

export type SignedAction =
  /** `confirmed` — the network has it: CAS → `posted`, the ordinary path. */
  | 'advance_posted'
  /** `pending` — the network has it, not mined yet: reschedule only. */
  | 'reschedule'
  /** `unavailable`, or `dead` before the age guard: the network does not
   *  (yet) show it — resend the SAME bytes, then reschedule. The plan's table
   *  lists both as «reschedule»; the resend is the «resend того же txId»
   *  half of the `signed` contract, idempotent on the network (same permit,
   *  same bytes), and without it a `signed` whose first POST never left would
   *  never be sent at all. */
  | 'resend'
  /** `dead` past the age guard: the two-phase redrop (phase 1 here). */
  | 'redrop';

export function signedAction(verdict: QuorumVerdict, record: Pick<RecoveryRecord, 'signedAt' | 'postedAt'>, now: number): SignedAction {
  switch (verdict.kind) {
    case 'confirmed': return 'advance_posted';
    case 'pending': return 'reschedule';
    case 'unavailable': return 'resend';
    case 'dead': {
      const since = Math.max(record.signedAt, record.postedAt ?? 0);
      return now - since > RECOVERY_AGE_GUARD_MS ? 'redrop' : 'resend';
    }
  }
}

// ─── Transitions (data only; the DO wraps them in transactions) ─────────

/** Phase 1 of the redrop: `signed → redrop_pending`. The dead txId is kept as
 *  lineage, the OLD bytes stay (the only durable source for phase 2), the
 *  record gets its own attempts/dueAt (due now: phase 2 runs on the next
 *  pass). Capacity is NOT released (`recoveryCount` unchanged). */
export function toRedropPending(r: RecoveryRecord, token: string, now: number): RecoveryRecord {
  return { ...r, status: 'redrop_pending', token, deadTxId: r.txId, attempts: 0, dueAt: now, redropAt: now };
}

/** Phase 2 commit: `redrop_pending → signed` with the NEW txId and bytes under
 *  the next generation; the dead txId stays for audit; the slot is the same. */
export function toSignedFromRedrop(
  r: RecoveryRecord,
  next: { txId: string; signedTx: string; spendKey: string; reward: string; token: string; anchorHeight?: number },
  now: number,
): RecoveryRecord {
  return {
    ...r,
    status: 'signed',
    token: next.token,
    txId: next.txId,
    signedTx: next.signedTx,
    spendKey: next.spendKey,
    reward: next.reward,
    spendRevision: 0,
    generation: r.generation + 1,
    anchorHeight: next.anchorHeight,
    signedAt: now,
    attempts: 0,
    dueAt: now + backoffMs(0),
    postedAt: undefined,
  };
}

/** The note record a recovery record becomes once the network has it: the
 *  ordinary `posted` (the client's recheck commits it, as today). */
export interface PostedRecord {
  status: 'posted'; token: string; gen: number; txId: string; reservedAt?: number; postedAt: number; fp?: string;
}
export function toPosted(r: RecoveryRecord, now: number): PostedRecord {
  return { status: 'posted', token: r.token, gen: r.gen, txId: r.txId, reservedAt: r.reservedAt, postedAt: now, ...(r.fp !== undefined ? { fp: r.fp } : {}) };
}

/** The spendKey of the NEXT generation: same tenant, same note, `g<n>`. */
export function nextGenerationSpendKey(spendKey: string, generation: number): string {
  const at = spendKey.lastIndexOf(':');
  return `${at < 0 ? spendKey : spendKey.slice(0, at)}:g${generation}`;
}

// ─── The stored bytes ───────────────────────────────────────────────────

export interface ParsedSignedTx {
  id: string;
  /** base64url payload, as `toJSON()` stores it. */
  data: string;
  /** base64url name/value pairs, as `toJSON()` stores them. */
  tags: Array<{ name: string; value: string }>;
  reward: string;
  raw: Record<string, unknown>;
}

/**
 * The durable bytes, or `null` when they do not parse or do not carry the
 * expected txId — fail closed (plan «Порча/потеря signedTx»): neither a
 * resend of garbage nor a signature from it; only the quorum can move the
 * record on.
 */
export function parseSignedTx(signedTx: string, expectedTxId: string): ParsedSignedTx | null {
  if (typeof signedTx !== 'string' || signedTx.length > SIGNED_TX_MAX_BYTES * 2) return null;
  let raw: unknown;
  try { raw = JSON.parse(signedTx); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.id !== expectedTxId) return null;
  if (typeof o.data !== 'string' || !Array.isArray(o.tags)) return null;
  const tags: Array<{ name: string; value: string }> = [];
  for (const t of o.tags as unknown[]) {
    if (typeof t !== 'object' || t === null) return null;
    const { name, value } = t as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || typeof value !== 'string') return null;
    tags.push({ name, value });
  }
  if (typeof o.reward !== 'string') return null;
  return { id: o.id, data: o.data, tags, reward: o.reward, raw: o };
}
