/**
 * D10 `SpendGuard` — the PURE rules (no Durable Object, no network).
 *
 * Spec: payee-private-docs `arweave-pr3b-d10-spendguard-spec-2026-09-23.md`
 * rev. 10 (accepted as a document 2026-09-23; §11 owner decisions still open)
 * and docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-3b. This module is the part of
 * the guard that can be written and tested BEFORE the DO exists: the cycle
 * ledger arithmetic (§3), the permit barrier and the freeze exception (§4.0,
 * §4.1), the marker automaton transitions (§4.1), deposit crediting (§4.2),
 * `reinit` (§4.4), the `prepare` predicate (§5), the `activate` table (§6)
 * and the `settle` lattice (§7). Every function is a total, synchronous
 * decision over plain data; the future DO wraps each in ONE
 * `storage.transaction` and does the signing / network OUTSIDE (§4.1).
 *
 * Amounts are `bigint` Winston (§2). Heights are block heights.
 *
 * NOT a release: PR-3b code ships only in its own worker window after backup
 * v1; this file exists so the §12 test map has an executable core.
 */

// ─── Constants (PRELIMINARY — §1, §11.8; calibrated per §10) ────────────

export const SPEND_WINDOW_MS = 86_400_000;
export const BALANCE_CACHE_TTL_MS = 60_000;
export const PRICE_QUOTE_TTL_MS = 60_000;
export const PRICE_DEVIATION_MAX = 1.25;
export const PREPARED_LEASE_MS = 600_000;
export const MIN_BALANCE_SOURCES = 2;
export const MIN_DEPOSIT_CONFIRMATIONS = 50;
export const MAX_STATUS_HEIGHT_SKEW = 5;
export const MARKER_MAX_BYTES = 64;
export const ANCHOR_EXPIRY_BLOCKS = 50;
export const HOUR_MS = 3_600_000;

/** Error codes (§11.9) — the ONLY spellings the routes may use. */
export const SPEND_CODES = {
  frozen: 'spend_frozen',
  notInitialized: 'spend_not_initialized',
  initNotFrozen: 'spend_init_not_frozen',
  initLegacyOpen: 'spend_init_legacy_open',
  initLegacyRewardUnknown: 'spend_init_legacy_reward_unknown',
  initKeysUnknown: 'spend_init_keys_unknown',
  initInProgress: 'init_in_progress',
  alreadyInitialized: 'already_initialized',
  staleToken: 'stale_token',
  depositUnverified: 'deposit_unverified',
  depositBeforeMarker: 'deposit_before_marker',
  ledgerInconsistent: 'spend_ledger_inconsistent',
  quoteMismatch: 'spend_quote_mismatch',
  balanceQuorum: 'spend_balance_quorum',
  keyTenantMismatch: 'spend_key_tenant_mismatch',
  remapRefused: 'spend_remap_refused',
  activateConflict: 'activate_conflict',
  guardUnconfigured: 'spend_guard_unconfigured',
  guardUnavailable: 'spend_guard_unavailable',
  adminUnconfigured: 'spend_admin_unconfigured',
  wrongScope: 'wrong_scope',
  /** A durable marker record whose bytes do not parse or do not match its
   *  txId: neither resent nor re-signed (plan «порча signedTx» — fail closed). */
  markerCorrupt: 'spend_marker_corrupt',
  /** The permit names a reservation that is `released` (a dead txId whose
   *  redrop was decided): no executor may send those bytes any more
   *  (review 24.09 #2, high 1 — a stale run is stripped of its right to send). */
  reservationReleased: 'spend_reservation_released',
  /** A send lease is open on the txId: `released` was asked for its
   *  reservation, or a SECOND executor asked `permit-send` for the same bytes
   *  (review 24.09 #3 high 1, #4 high 1) — the money cannot be freed and the
   *  right to send cannot be shared while a POST may still be in progress. */
  sendInFlight: 'spend_send_in_flight',
  /** `/anchor-expired` names an anchor other than the permit's, or the permit
   *  recorded none (a proof must be about the permitted bytes). */
  anchorMismatch: 'spend_anchor_mismatch',
  /** `/anchor-expired` brought heights under which the anchor is still valid. */
  anchorNotExpired: 'spend_anchor_not_expired',
  /** `permit-send` for bytes whose anchor is PROVEN expired: the network
   *  cannot accept them, and a lease on them could only wedge money (review
   *  24.09 #6, medium). The record must go dead → redrop, not resend. */
  anchorExpired: 'spend_anchor_expired',
  windowCap: 'spend_window_cap',
  floor: 'spend_floor',
} as const;
export type SpendCode = (typeof SPEND_CODES)[keyof typeof SPEND_CODES];

// ─── §3 The cycle ledger ────────────────────────────────────────────────

/** The ledger of ONE cycle. `pending` includes `held` legacy transactions. */
export interface CycleLedger {
  cycle: number;
  /** Height of the cycle's marker; `null` until `init` reaches `done`. */
  hInit: number | null;
  deposits: bigint;
  spent: bigint;
  pending: bigint;
}

/** `available = deposits − spent − pending` — never a gateway balance (§3). */
export function available(ledger: Pick<CycleLedger, 'deposits' | 'spent' | 'pending'>): bigint {
  return ledger.deposits - ledger.spent - ledger.pending;
}

/** Hour buckets of ALL cycles (`spend:<hourEpoch>`), kept across `reinit`. */
export type SpendBuckets = ReadonlyMap<number, bigint>;

export function hourEpoch(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS);
}

/**
 * Sum of the buckets that may hold spending from the last 24 h (§3, §4.4).
 *
 * Hour buckets cannot tell WHEN inside the hour a spend happened, so the
 * bucket that straddles the window's start is counted IN FULL (review 24.09,
 * high): dropping it would forget a spend made 23 h 02 min ago and let the
 * sliding cap be exceeded. The price is conservatism — up to one extra hour
 * of history counts against the cap — which is the safe side for money.
 */
export function spentLast24h(buckets: SpendBuckets, nowMs: number): bigint {
  const first = hourEpoch(nowMs - SPEND_WINDOW_MS);
  let sum = 0n;
  for (const [hour, amount] of buckets) if (hour >= first) sum += amount;
  return sum;
}

export function addToBucket(buckets: SpendBuckets, nowMs: number, amount: bigint): Map<number, bigint> {
  const out = new Map(buckets);
  const h = hourEpoch(nowMs);
  out.set(h, (out.get(h) ?? 0n) + amount);
  return out;
}

// ─── §4.1 Marker automaton ──────────────────────────────────────────────

export type InitState = 'none' | 'signing' | 'signed' | 'posted' | 'done';

export interface InitRecord {
  state: InitState;
  cycle: number;
  /** CAS token of the in-flight attempt (`signing` and after). */
  token?: string;
  txId?: string;
  /** The signed bytes, INLINE: POST only ever resends these (§4.1). */
  signedTx?: string;
  anchor?: string;
  attempts: number;
  /** Lease end for `signing`; recovery due time afterwards. */
  dueAt?: number;
  hInit?: number;
  initAt?: number;
  /** When the signature became durable (`signed`) / when the POST was accepted
   *  (`posted`) — the age guard of the dead verdict (§4.1 «мёртвый маркер») is
   *  measured from the latest of them. */
  signedAt?: number;
  postedAt?: number;
}

export type InitEvent =
  | { kind: 'begin'; token: string; now: number; frozen: boolean; legacyOpen: boolean; rewardUnknown: boolean }
  | { kind: 'signed'; token: string; txId: string; signedTx: string; anchor: string; now: number }
  | { kind: 'posted'; token: string; txId: string; now: number }
  | { kind: 'done'; txId: string; heights: readonly number[]; confirmations: readonly number[]; now: number }
  | { kind: 'dead'; txId: string; now: number };

export type InitTransition =
  | { ok: true; record: InitRecord; opensCycle?: number }
  | { ok: false; code: SpendCode };

/**
 * One transition of the marker automaton (§4.1). Each is ONE storage
 * transaction in the DO with CAS on `{state, token}`; signing and the POST
 * happen outside and come back as `signed` / `posted` events carrying the
 * token they were started with — a late or superseded attempt is refused with
 * `stale_token` and its ephemeral signature is dropped.
 */
export function initTransition(record: InitRecord, event: InitEvent): InitTransition {
  switch (event.kind) {
    case 'begin': {
      if (!event.frozen) return { ok: false, code: SPEND_CODES.initNotFrozen };
      if (event.legacyOpen) return { ok: false, code: SPEND_CODES.initLegacyOpen };
      if (event.rewardUnknown) return { ok: false, code: SPEND_CODES.initLegacyRewardUnknown };
      if (record.state === 'done') return { ok: false, code: SPEND_CODES.alreadyInitialized };
      if (record.state === 'signing' && (record.dueAt ?? 0) > event.now) return { ok: false, code: SPEND_CODES.initInProgress };
      if (record.state === 'signed' || record.state === 'posted') return { ok: false, code: SPEND_CODES.initInProgress };
      // `none`, or an EXPIRED `signing` lease: a fresh attempt owns the record.
      return {
        ok: true,
        record: { ...record, state: 'signing', token: event.token, attempts: record.attempts + 1, dueAt: event.now + PREPARED_LEASE_MS, txId: undefined, signedTx: undefined, anchor: undefined },
      };
    }
    case 'signed': {
      if (record.state !== 'signing' || record.token !== event.token) return { ok: false, code: SPEND_CODES.staleToken };
      if ((record.dueAt ?? 0) <= event.now) return { ok: false, code: SPEND_CODES.staleToken };
      return { ok: true, record: { ...record, state: 'signed', txId: event.txId, signedTx: event.signedTx, anchor: event.anchor, signedAt: event.now, dueAt: event.now + PREPARED_LEASE_MS } };
    }
    case 'posted': {
      if (record.state === 'posted' && record.txId === event.txId) return { ok: true, record }; // idempotent
      if (record.state !== 'signed' || record.token !== event.token || record.txId !== event.txId) return { ok: false, code: SPEND_CODES.staleToken };
      return { ok: true, record: { ...record, state: 'posted', postedAt: event.now, dueAt: event.now + PREPARED_LEASE_MS } };
    }
    case 'done': {
      if (record.state !== 'posted' || record.txId !== event.txId) return { ok: false, code: SPEND_CODES.staleToken };
      // ≥2 independent operators, each ≥ MIN_DEPOSIT_CONFIRMATIONS, heights
      // within the skew; h_init is the MAXIMUM of the agreed heights (§4.1).
      if (event.heights.length < 2 || event.confirmations.length !== event.heights.length) return { ok: false, code: SPEND_CODES.balanceQuorum };
      if (event.confirmations.some(c => c < MIN_DEPOSIT_CONFIRMATIONS)) return { ok: false, code: SPEND_CODES.balanceQuorum };
      if (Math.max(...event.heights) - Math.min(...event.heights) > MAX_STATUS_HEIGHT_SKEW) return { ok: false, code: SPEND_CODES.balanceQuorum };
      const hInit = Math.max(...event.heights);
      return { ok: true, record: { ...record, state: 'done', hInit, initAt: event.now, dueAt: undefined }, opensCycle: record.cycle };
    }
    case 'dead': {
      if ((record.state !== 'signed' && record.state !== 'posted') || record.txId !== event.txId) return { ok: false, code: SPEND_CODES.staleToken };
      return { ok: true, record: { state: 'none', cycle: record.cycle, attempts: record.attempts } };
    }
  }
}

// ─── §4.0 Permit barrier ───────────────────────────────────────────────

export type PermitKind = 'upload' | 'resend' | 'redrop2' | 'marker';

export interface FreezeState { active: boolean; epoch: number; since?: number }

export interface PermitRecord {
  txId: string; kind: PermitKind; cycle: number; issuedAt: number; spendKey?: string;
  /** The `last_tx` of the permitted bytes (a block hash from `/tx_anchor`),
   *  recorded at the first permit-send: the ONE fact a later proof of expiry
   *  must be about (review 24.09 #5, high 1). */
  anchor?: string;
  /** The send lease (review 24.09 #3 high 1, #4 high 1–2, #5 high 1): ONE
   *  executor at a time holds the right to POST these bytes. Set when the
   *  permit is handed out; cleared by `/send-done` with the token — the
   *  executor's own report that its POST ended — or by `/anchor-expired`, a
   *  proof from the chain that the bytes can no longer be accepted. Never by
   *  the clock. While it is set, `permit-send` for the same txId is refused
   *  to everyone else and `released` is refused for the reservation. */
  sending?: { token: string; since: number };
  /** The chain facts that ended an unreported lease (`/anchor-expired`). */
  anchorExpired?: { anchorHeight: number; chainHeight: number; at: number };
}

/** Is the lease binding: an executor holds it, has not reported, and the
 *  anchor is not proven expired. Time is not an argument (review 24.09 #5,
 *  high 1): a block interval has a target average and no upper bound, so no
 *  wall-clock span proves an anchor stale. A permit whose anchor IS proven
 *  expired binds nothing, whatever `sending` says (review #6, medium): its
 *  bytes cannot land, so no lease on them may hold money. */
export function leaseOpen(permit: Pick<PermitRecord, 'sending' | 'anchorExpired'> | undefined): boolean {
  return permit !== undefined && permit.sending !== undefined && permit.anchorExpired === undefined;
}

/**
 * The anchor rule of the network, as the ONE proof that permitted bytes can
 * never land (review 24.09 #5, high 1): a transaction is mineable only while
 * its `last_tx` names one of the last `ANCHOR_EXPIRY_BLOCKS` blocks. Once the
 * chain's CONFIRMED height is at least `anchorHeight + ANCHOR_EXPIRY_BLOCKS +
 * ANCHOR_EXPIRY_MARGIN_BLOCKS`, no block can include those bytes any more.
 * Both heights are chain facts the worker reads from ≥ MIN_BALANCE_SOURCES
 * operators (`anchor-expiry.ts`): the anchor's height must be AGREED
 * (equal), the chain height is the MINIMUM (the conservative side — the
 * chain is at least this far). The margin absorbs a short reorg and a
 * gateway that runs a block ahead of the canonical tip.
 */
export const ANCHOR_EXPIRY_MARGIN_BLOCKS = 5;
export function anchorExpired(anchorHeight: number, chainHeight: number): boolean {
  if (!Number.isInteger(anchorHeight) || !Number.isInteger(chainHeight) || anchorHeight < 0 || chainHeight < 0) return false;
  return chainHeight - anchorHeight >= ANCHOR_EXPIRY_BLOCKS + ANCHOR_EXPIRY_MARGIN_BLOCKS;
}

/** A block hash from `/tx_anchor` (43..64 base64url — see arweave-transport). */
export const ANCHOR_RE = /^[A-Za-z0-9_-]{43,64}$/;

export type PermitDecision =
  | { granted: true; permit: PermitRecord; existing: boolean }
  | { granted: false; code: SpendCode };

/**
 * The single path to the network (§4.0): decide `permit-send`.
 *
 *  - frozen → refused for every kind except the durable MARKER of the current
 *    cycle (`init.state ∈ {signed, posted}`, `txId === init.txId`) — §4.1.
 *    This holds for a REPEAT request too (review 24.09, high): a txId that
 *    already holds a permit — sent, answer lost — is exactly the durable
 *    recovery §4.0 says must NOT be resent under freeze. The permit record and
 *    the hold stay; only the answer «go» is withheld;
 *  - not frozen → an existing permit for the txId is returned as-is (resend =
 *    same permit, no double accounting); `marker` is allowed only for the
 *    current cycle's own txId (a marker of a foreign cycle is refused), and
 *    everything else requires `init.state === 'done'`.
 */
export function permitDecision(
  ctx: { freeze: FreezeState; init: InitRecord; existing: PermitRecord | undefined; now: number },
  req: { txId: string; kind: PermitKind; cycle: number; spendKey?: string },
): PermitDecision {
  const isCurrentMarker = req.kind === 'marker'
    && req.cycle === ctx.init.cycle
    && ctx.init.txId === req.txId
    && (ctx.init.state === 'signed' || ctx.init.state === 'posted');
  if (ctx.freeze.active && !isCurrentMarker) return { granted: false, code: SPEND_CODES.frozen };
  if (ctx.existing !== undefined) return { granted: true, permit: ctx.existing, existing: true };
  if (req.kind === 'marker' && !isCurrentMarker) return { granted: false, code: SPEND_CODES.notInitialized };
  if (!isCurrentMarker && ctx.init.state !== 'done') return { granted: false, code: SPEND_CODES.notInitialized };
  return { granted: true, permit: { txId: req.txId, kind: req.kind, cycle: req.cycle, issuedAt: ctx.now, spendKey: req.spendKey }, existing: false };
}

/**
 * Refusal of `permit-send` under freeze — which branch (§4.0, review #9 H3):
 * an operation that PROVABLY never reached the network (no permit record ever
 * issued) may be aborted before sending in the current format; a durable
 * `signed` / `redrop_pending` record (or any txId that already holds a permit)
 * keeps its record, txId, bytes and hold — no release, no abort — and only
 * status reconciliation continues.
 */
export function refusalBranch(args: { hadPermit: boolean; durableRecovery: boolean }): 'abort-before-send' | 'keep-and-reconcile' {
  return !args.hadPermit && !args.durableRecovery ? 'abort-before-send' : 'keep-and-reconcile';
}

// ─── §4.2 Deposits ──────────────────────────────────────────────────────

export type DepositDecision =
  | { ok: true; credited: boolean; ledger: CycleLedger }
  | { ok: false; code: SpendCode };

/** DO-side crediting of a VERIFIED incoming transfer (verification — target,
 *  quantity, ≥2 operators, confirmations — happens in the worker, §4.2). */
export function creditDeposit(
  ledger: CycleLedger,
  alreadyCredited: ReadonlySet<string>,
  deposit: { txId: string; amount: bigint; depositHeight: number },
): DepositDecision {
  if (ledger.hInit === null) return { ok: false, code: SPEND_CODES.notInitialized };
  if (deposit.depositHeight <= ledger.hInit) return { ok: false, code: SPEND_CODES.depositBeforeMarker };
  if (alreadyCredited.has(deposit.txId)) return { ok: true, credited: false, ledger };
  if (deposit.amount <= 0n) return { ok: false, code: SPEND_CODES.depositUnverified };
  return { ok: true, credited: true, ledger: { ...ledger, deposits: ledger.deposits + deposit.amount } };
}

// ─── §4.4 reinit ────────────────────────────────────────────────────────

export interface ReinitResult {
  /** The whole previous cycle, archived as-is (`cycle-archive:<c>`). */
  archived: CycleLedger;
  /** The new cycle: deposits 0, spent 0, pending = Σ held carried over. */
  ledger: CycleLedger;
}

/** `reinit` (§4.4): archive the cycle whole, start a fresh ledger, carry the
 *  `held` legacy sums into the new `pending`. Buckets are NOT touched (the
 *  24 h window is cross-cycle) and nothing of the old `spent` is subtracted
 *  from future deposits (review #8 M1). Only under freeze. */
export function reinit(ledger: CycleLedger, heldTotal: bigint, frozen: boolean): ReinitResult | { ok: false; code: SpendCode } {
  if (!frozen) return { ok: false, code: SPEND_CODES.initNotFrozen };
  return {
    archived: { ...ledger },
    ledger: { cycle: ledger.cycle + 1, hInit: null, deposits: 0n, spent: 0n, pending: heldTotal },
  };
}

// ─── §5 prepare ─────────────────────────────────────────────────────────

export interface SpendLimits { walletFloor: bigint; windowCap: bigint; maxTxReward: bigint }

export type PrepareDecision = { ok: true } | { ok: false; code: SpendCode };

/** The `prepare` predicate (§5): every clause fail-closed. `observedMin` is
 *  the minimum gateway balance over ≥ MIN_BALANCE_SOURCES answers, or null when
 *  the quorum did not form (then the detector cannot fire, §3.4). */
export function prepareDecision(args: {
  ledger: CycleLedger;
  initDone: boolean;
  frozen: boolean;
  limits: SpendLimits;
  reward: bigint;
  spentLast24h: bigint;
  observedMin: bigint | null;
}): PrepareDecision {
  const { ledger, limits, reward } = args;
  if (!args.initDone) return { ok: false, code: SPEND_CODES.notInitialized };
  if (args.frozen) return { ok: false, code: SPEND_CODES.frozen };
  if (reward > limits.maxTxReward) return { ok: false, code: SPEND_CODES.quoteMismatch };
  const avail = available(ledger);
  if (args.observedMin !== null && args.observedMin < avail) return { ok: false, code: SPEND_CODES.ledgerInconsistent };
  if (avail - reward < limits.walletFloor) return { ok: false, code: SPEND_CODES.floor };
  if (args.spentLast24h + ledger.pending + reward > limits.windowCap) return { ok: false, code: SPEND_CODES.windowCap };
  return { ok: true };
}

// ─── §6 activate ────────────────────────────────────────────────────────

export type ReservationState = 'prepared' | 'active' | 'spent' | 'released';

export interface Reservation {
  state: ReservationState;
  reward: bigint;
  revision: number;
  activatedBy?: string;
}

export type ActivateOutcome = 'activate' | 'remap' | 'noop' | 'terminal-noop' | 'conflict';

/**
 * The `activate` table (§6, plan v18/v19). `remap` = the reservation must be
 * re-prepared under the §5 checks and activated in one step (or refused).
 *
 * A `released` reservation that was NEVER activated — a `prepared` lease that
 * expired before the durable signature came back — is not a terminal outcome
 * of anyone's activation: it is the same case as «record absent», so the
 * activation re-runs the budget checks (review 24.09, medium). Only a
 * reservation someone actually activated is terminal, and only for them.
 */
export function activateOutcome(
  reservation: Reservation | undefined,
  req: { reward: bigint; revision: number; activatedBy: string },
): ActivateOutcome {
  if (reservation === undefined) return 'remap';
  switch (reservation.state) {
    case 'prepared':
      return reservation.reward === req.reward && reservation.revision === req.revision ? 'activate' : 'remap';
    case 'active':
      return reservation.activatedBy === req.activatedBy ? 'noop' : 'conflict';
    case 'spent':
      return reservation.activatedBy === req.activatedBy ? 'terminal-noop' : 'conflict';
    case 'released':
      if (reservation.activatedBy === undefined) return 'remap';
      return reservation.activatedBy === req.activatedBy ? 'terminal-noop' : 'conflict';
  }
}

// ─── §7 settle lattice ──────────────────────────────────────────────────

export type SettleOutcome = 'spent' | 'released';

export type SettleResult =
  | { ok: true; state: ReservationState; spentDelta: bigint; pendingDelta: bigint; conflict: boolean }
  | { ok: false; reason: 'prepared_cannot_settle' | 'spent_is_final' | 'never_activated' };

/**
 * `settle` (§7): `active → spent` (pending −= reward, spent += reward, bucket,
 * audit); `active → released` (pending −= reward); the same outcome twice is a
 * no-op; `prepared → *` and `spent → released` are refused; `released → spent`
 * DOMINATES (money left after all: spent += reward, current-hour bucket,
 * `spend_conflict`).
 */
export function settle(reservation: Reservation, outcome: SettleOutcome): SettleResult {
  const r = reservation.reward;
  switch (reservation.state) {
    case 'prepared':
      return { ok: false, reason: 'prepared_cannot_settle' };
    case 'active':
      return outcome === 'spent'
        ? { ok: true, state: 'spent', spentDelta: r, pendingDelta: -r, conflict: false }
        : { ok: true, state: 'released', spentDelta: 0n, pendingDelta: -r, conflict: false };
    case 'spent':
      return outcome === 'spent'
        ? { ok: true, state: 'spent', spentDelta: 0n, pendingDelta: 0n, conflict: false }
        : { ok: false, reason: 'spent_is_final' };
    case 'released':
      if (outcome === 'released') return { ok: true, state: 'released', spentDelta: 0n, pendingDelta: 0n, conflict: false };
      // «Money left after all» presumes the transaction was ACTIVATED (and so
      // could have been POSTed). A released reservation nobody activated — an
      // expired lease, or one released with its cycle at reinit — never
      // reached the network; it cannot turn into spending (review 24.09).
      if (reservation.activatedBy === undefined) return { ok: false, reason: 'never_activated' };
      return { ok: true, state: 'spent', spentDelta: r, pendingDelta: 0n, conflict: true };
  }
}

// ─── The money quorum (§4.1 `done`, §4.2 deposits, §7 settle by the quorum) ─

/** One status origin's answer, as the shared quorum module shapes it. */
export interface ConfirmedVote { origin: string; kind: 'confirmed'; confirmations: number; blockHeight: number }
export type QuorumVoteLike = ConfirmedVote | { origin: string; kind: string };

export type MoneyQuorum =
  | { ok: true; height: number; heights: number[]; confirmations: number[]; operators: number }
  | { ok: false; operators: number };

/**
 * The ONE rule under which the guard treats a transaction as CONFIRMED for
 * money (review 24.09, high): at least `MIN_BALANCE_SOURCES` independent
 * OPERATORS (two origins of one operator are one voice), each answering
 * `confirmed` with ≥ `MIN_DEPOSIT_CONFIRMATIONS`, their heights within
 * `MAX_STATUS_HEIGHT_SKEW`. Liveness (the PR-3a `statusVerdict`, satisfied by
 * a single 200 with zero confirmations) is a different question and never
 * settles a spend, credits a deposit or fixes a marker.
 *
 * `height` is the MAXIMUM of the agreed heights — the conservative side for
 * money: a spend is reclassified out of the ledger only when it is provably
 * at or below the marker (`spend-guard.ts` initStep), and the marker's own
 * `h_init` is the maximum too (§4.1).
 */
export function moneyQuorum(votes: readonly QuorumVoteLike[], operatorOf: (origin: string) => string): MoneyQuorum {
  const byOperator = new Map<string, ConfirmedVote>();
  for (const v of votes) {
    if (v.kind !== 'confirmed') continue;
    const c = v as ConfirmedVote;
    if (c.confirmations < MIN_DEPOSIT_CONFIRMATIONS) continue;
    const op = operatorOf(c.origin);
    if (!byOperator.has(op)) byOperator.set(op, c);
  }
  const agreed = [...byOperator.values()];
  if (agreed.length < MIN_BALANCE_SOURCES) return { ok: false, operators: agreed.length };
  const heights = agreed.map(v => v.blockHeight);
  if (Math.max(...heights) - Math.min(...heights) > MAX_STATUS_HEIGHT_SKEW) return { ok: false, operators: agreed.length };
  return { ok: true, height: Math.max(...heights), heights, confirmations: agreed.map(v => v.confirmations), operators: agreed.length };
}

// ─── §4.0 п. 6 Legacy resolution after `done` ───────────────────────────

export type LegacyResolution = 'spent' | 'dropped' | 'held';

/** What becomes of a `held` legacy transaction once the cycle is `done`:
 *  confirmed above the marker → spent in this cycle; confirmed at or below →
 *  dropped (it belongs to the reserve before the marker); dead + age guard →
 *  dropped; anything else stays held (no TTL). */
export function resolveLegacy(args: {
  hInit: number;
  verdict: { kind: 'confirmed'; height: number } | { kind: 'dead'; ageGuardPassed: boolean } | { kind: 'pending' } | { kind: 'unavailable' };
}): LegacyResolution {
  const v = args.verdict;
  if (v.kind === 'confirmed') return v.height > args.hInit ? 'spent' : 'dropped';
  if (v.kind === 'dead') return v.ageGuardPassed ? 'dropped' : 'held';
  return 'held';
}
