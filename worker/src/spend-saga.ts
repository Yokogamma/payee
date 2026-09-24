/**
 * The worker's side of the D10 upload saga (spec rev. 10 §8, plan §4.PR-3b
 * «Сага вместо cross-DO транзакции»): the calls `handleUpload` makes to the
 * global `SpendGuard` around one paid publication, in the order
 *
 *   refresh-balance (detector) → refresh-price → prepare → [sign] →
 *   [op-posting] → activate → permit-send → POST → settle
 *
 * Nothing here decides money: every decision is the DO's, in one
 * `storage.transaction` per call. This module only carries verified inputs
 * (the quote for the SIZE, the minimum gateway balance) and reads the answers
 * back as typed refusals the handler can journal and answer.
 *
 * `spendKey = {publicKeyB64, noteId, gen}` (§2, tenant mandatory): the tenant
 * travels as SHA-256(publicKeyB64) hex — never the raw key (the §4.PR-2 ban on
 * raw keys in anything observable). In the current format `gen` is the
 * OPERATION id: one admitted operation is one generation, stable within the
 * request and unique across attempts, so an idempotent `activate` retry lands
 * on its own reservation and a redrop (a new operation) opens a new one.
 */

import { parseOriginList } from '../../src/lib/gateways-parse';
import { ARWEAVE_HOST } from './arweave-transport';
import { readWalletBalance } from './gateway-reads';
import type { Emit } from './metrics';
import { spendLimitsWire } from './spend-admin';
import { BALANCE_CACHE_TTL_MS, MIN_BALANCE_SOURCES, SPEND_CODES, type SpendLimits } from './spend-ledger';

/** Reservation revision (plan v17). The current format has no durable
 *  `signed` record to carry a re-reservation counter, so every reservation is
 *  revision 0; the writer release introduces the counter. */
export const SPEND_REVISION = 0;

export async function spendKeyFor(publicKeyB64: string, noteId: string, gen: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKeyB64)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return `${hex}:${noteId}:${gen}`;
}

// ─── DO transport ───────────────────────────────────────────────────────

type GuardBody = Record<string, unknown> & { ok?: boolean; code?: string };
export type GuardResult = { status: number; body: GuardBody } | { unavailable: true };

export async function guardPost(guard: DurableObjectStub, path: string, body: Record<string, unknown>): Promise<GuardResult> {
  try {
    const res = await guard.fetch(`http://spend-guard${path}`, { method: 'POST', body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: GuardBody;
    try { parsed = JSON.parse(text) as GuardBody; } catch { parsed = { ok: false, text }; }
    return { status: res.status, body: parsed };
  } catch (e) {
    console.error('SPEND_GUARD_UNAVAILABLE', path, e);
    return { unavailable: true };
  }
}

/** The codes an /upload answer may carry from the guard (upload-codes.json);
 *  anything else the DO might say collapses to `spend_guard_unavailable` so
 *  the driver's closed list stays closed. */
export const SPEND_UPLOAD_CODES: ReadonlySet<string> = new Set([
  SPEND_CODES.guardUnavailable, SPEND_CODES.guardUnconfigured, SPEND_CODES.frozen, SPEND_CODES.notInitialized,
  SPEND_CODES.floor, SPEND_CODES.windowCap, SPEND_CODES.quoteMismatch, SPEND_CODES.ledgerInconsistent,
  SPEND_CODES.activateConflict, SPEND_CODES.remapRefused, SPEND_CODES.reservationReleased,
]);

export interface SpendRefusal { code: string; status: number; unavailable: boolean; detail: Record<string, unknown> }

function refusalOf(r: GuardResult): SpendRefusal {
  if ('unavailable' in r) return { code: SPEND_CODES.guardUnavailable, status: 503, unavailable: true, detail: {} };
  const raw = typeof r.body.code === 'string' ? r.body.code : SPEND_CODES.guardUnavailable;
  const { ok: _ok, code: _code, ...detail } = r.body;
  void _ok; void _code;
  return { code: SPEND_UPLOAD_CODES.has(raw) ? raw : SPEND_CODES.guardUnavailable, status: 503, unavailable: false, detail: { rawCode: raw, ...detail } };
}
/** A 2xx `{ ok: true }` answer. Deliberately NOT a type predicate: the false
 *  branch still holds an answered refusal whose body the caller reads. */
const isOk = (r: GuardResult): boolean => !('unavailable' in r) && r.status >= 200 && r.status < 300 && r.body.ok === true;
const bodyOf = (r: GuardResult): GuardBody => ('unavailable' in r ? {} : r.body);
const why = (r: GuardResult): unknown => ('unavailable' in r ? 'unavailable' : r.body.code ?? r.body.reason ?? r.status);

// ─── prepare / activate / settle ────────────────────────────────────────

export type PrepareResult =
  | { ok: true; cycle: number; quoteId: string; available: string | null }
  | { ok: false; refusal: SpendRefusal };

/** refresh-price (the quote is bound to the SIZE) → prepare (§5). */
export async function prepareSpend(
  guard: DurableObjectStub,
  args: { spendKey: string; bytes: number; reward: string; limits: SpendLimits },
): Promise<PrepareResult> {
  const quote = await guardPost(guard, '/refresh-price', { bytes: args.bytes, reward: args.reward });
  const quoteId = bodyOf(quote).quoteId;
  if (!isOk(quote) || typeof quoteId !== 'string') return { ok: false, refusal: refusalOf(quote) };
  const prepared = await guardPost(guard, '/prepare', {
    spendKey: args.spendKey, reward: args.reward, revision: SPEND_REVISION, quoteId, bytes: args.bytes,
    limits: spendLimitsWire(args.limits),
  });
  if (!isOk(prepared)) return { ok: false, refusal: refusalOf(prepared) };
  const pb = bodyOf(prepared);
  return {
    ok: true,
    cycle: Number(pb.cycle),
    quoteId,
    available: typeof pb.available === 'string' ? pb.available : null,
  };
}

export type ActivateResult =
  | { ok: true; state: string; outcome: string; cycle: number }
  | { ok: false; refusal: SpendRefusal };

/** activate(spendKey, reward, revision) — the CAS table §6; `activatedBy` is
 *  the `{reward, revision}` tuple of the SIGNED transaction. */
export async function activateSpend(
  guard: DurableObjectStub,
  args: { spendKey: string; reward: string; limits: SpendLimits },
): Promise<ActivateResult> {
  const r = await guardPost(guard, '/activate', {
    spendKey: args.spendKey, reward: args.reward, revision: SPEND_REVISION,
    activatedBy: `${args.reward}:${SPEND_REVISION}`, limits: spendLimitsWire(args.limits),
  });
  if (!isOk(r)) return { ok: false, refusal: refusalOf(r) };
  const b = bodyOf(r);
  return { ok: true, state: String(b.state), outcome: String(b.outcome), cycle: Number(b.cycle) };
}

/** Release a reservation that PROVABLY never reached the network (the §4.0
 *  «abort before send» branch). Best effort: a `prepared` one cannot be
 *  settled (its lease expires), an `active` one goes `released`; a refusal is
 *  logged and never changes the answer. */
export type ReleaseResult = 'released' | 'in_flight' | 'terminal' | 'unavailable';

export async function releaseSpend(guard: DurableObjectStub, spendKey: string): Promise<ReleaseResult> {
  const r = await guardPost(guard, '/settle', { spendKey, outcome: 'released' });
  if (isOk(r)) return 'released';
  if ('unavailable' in r) return 'unavailable';
  if (r.body.code === SPEND_CODES.sendInFlight) return 'in_flight';
  if (r.status === 404 || r.status === 409) return 'terminal';
  console.error('SPEND_RELEASE_NOT_APPLIED', spendKey.slice(-36), why(r));
  return 'unavailable';
}

/**
 * `settled` / `noop` — the guard applied or already held this outcome;
 * `unknown` — no permit names this txId (a pre-D10 publication);
 * `terminal_refusal` — the lattice refused for good (409: `spent_is_final`,
 * `never_activated`, …; 400: a marker permit);
 * `retry` — the guard did not answer, or refused for now (503: unavailable,
 * `spend_send_in_flight`). Only the first three kinds and `terminal_refusal`
 * end a money-reconciliation entry (review 24.09 #3, high 2).
 */
export type SettleByTxResult = 'settled' | 'noop' | 'unknown' | 'terminal_refusal' | 'retry';

/** Reconcile a reservation by the txId its permit named (§7 via `permit:<txId>`):
 *  the recheck path knows the txId, not the spendKey. Best effort — the
 *  scheduler is the authoritative reconciler. `unknown` = no permit for this
 *  txId (a pre-D10 publication), which is not an error. */
export async function settleByTx(
  guard: DurableObjectStub,
  args: { txId: string; outcome: 'spent' | 'released'; height?: number },
): Promise<SettleByTxResult> {
  const r = await guardPost(guard, '/settle-by-tx', { txId: args.txId, outcome: args.outcome, ...(args.height !== undefined ? { height: args.height } : {}) });
  if ('unavailable' in r) return 'retry';
  if (r.status === 404) return 'unknown';
  if (isOk(r)) return bodyOf(r).noop === true ? 'noop' : 'settled';
  if (r.status === 409 || r.status === 400) { console.error('SPEND_SETTLE_BY_TX_REFUSED', args.txId, args.outcome, why(r)); return 'terminal_refusal'; }
  console.error('SPEND_SETTLE_BY_TX_RETRY', args.txId, args.outcome, why(r));
  return 'retry';
}

// ─── §3.4 balance detector ──────────────────────────────────────────────

/** Per-wallet «last read» — isolate-level, `BALANCE_CACHE_TTL_MS`. */
const balanceReadAt = new Map<string, number>();

/** Test hook: pretend the balance was just read for this wallet, so a suite
 *  that counts outbound calls sees none from the detector. */
export function primeSpendBalanceCache(address: string, now = Date.now()): void {
  balanceReadAt.set(address, now);
}
/** Test hook: force the next upload to read the pool again. */
export function resetSpendBalanceCache(): void {
  balanceReadAt.clear();
}

export type BalanceRefresh = 'cached' | 'refreshed' | 'inert' | 'unavailable';

/**
 * Read `/wallet/<addr>/balance` at every status origin (one voice per
 * operator), hand the MINIMUM over ≥ MIN_BALANCE_SOURCES answers to the DO as
 * the detector input, or `null` when the quorum did not form (the detector is
 * then inert and the ledger decides alone — §3.4, §12 ledger row 6). A gateway
 * balance NEVER raises `available`; it can only stop `prepare`.
 */
export async function refreshBalanceIfStale(
  env: { STATUS_GATEWAYS?: string },
  guard: DurableObjectStub,
  address: string,
  emit: Emit,
  opts: { now?: number; operatorOf?: (origin: string) => string } = {},
): Promise<BalanceRefresh> {
  const now = opts.now ?? Date.now();
  const last = balanceReadAt.get(address);
  if (last !== undefined && now - last < BALANCE_CACHE_TTL_MS) return 'cached';
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  const origins = parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
  const operatorOf = opts.operatorOf ?? ((o: string) => o);
  const answers = await Promise.all(origins.map(async origin => ({ origin, value: await readWalletBalance(origin, address, emit) })));
  const byOperator = new Map<string, bigint>();
  for (const { origin, value } of answers) {
    if (value === null) continue;
    const op = operatorOf(origin);
    if (!byOperator.has(op)) byOperator.set(op, BigInt(value));
  }
  let observedMin: bigint | null = null;
  if (byOperator.size >= MIN_BALANCE_SOURCES) {
    for (const v of byOperator.values()) observedMin = observedMin === null || v < observedMin ? v : observedMin;
  }
  const r = await guardPost(guard, '/refresh-balance', { observedMin: observedMin === null ? null : observedMin.toString(), now });
  if ('unavailable' in r) return 'unavailable';
  balanceReadAt.set(address, now);
  if (observedMin !== null) emit('observed_min_winston', [], [Number.isSafeInteger(Number(observedMin)) ? Number(observedMin) : -1]);
  return observedMin === null ? 'inert' : 'refreshed';
}
