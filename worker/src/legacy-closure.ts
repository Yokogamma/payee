/**
 * D10 §4.0 п. 2–5 — closure of the legacy set `L`: every transaction of the
 * worker wallet that may still be mined AFTER the marker and therefore must
 * be HELD in the cycle ledger before `init` may begin.
 *
 *   L₁ — permits without a terminal outcome in the guard's own ledger (every
 *        transaction sent through `permit-send`, all cycles): the reservation
 *        the permit names is neither `spent` nor `released`. Their reward is
 *        the reservation's — the reward the transaction was signed with.
 *   L₂ — transactions sent BEFORE D10 (no permit): the per-key operation
 *        journals of every key that ever held access — historical, revoked
 *        included (review #9 M: `invite:*` keeps `publicKey` after a revoke;
 *        `pk:*` is deleted by it). Members: `posting` records, `finished` with
 *        `paidResult: 'unknown'`, and `finished(accepted)` whose txId no money
 *        quorum confirms. Their reward comes ONLY from the signed header read
 *        at a payload gateway and verified with id equality, the RSA-PSS
 *        signature and the trusted-owner set (`verifyHeader`, D9) — never from
 *        the new ceiling, never from a guess (review #8 H1, #9 H1/H2). Bytes
 *        unavailable at every origin → the closure is OPEN: `init` refuses.
 *
 * Old-format invite records (`true` / `used` without `publicKey`) hide keys
 * the journals cannot be enumerated for: the closure is open
 * (`spend_init_keys_unknown`) until the operator acknowledges them
 * (`/admin/spend/init-legacy-keys`).
 *
 * This is the WORKER's job (network); the DO only remembers the holds
 * (`/init-legacy`) and answers the two questions it can (`/open-permits`,
 * `/legacy-list`).
 */

import { parseOriginList } from '../../src/lib/gateways-parse';
import { parseTrustedOwners } from '../../src/lib/trusted-owners';
import { parseTxHeader, verifyHeader } from '../../src/lib/tx-verify';
import { ARWEAVE_HOST, readCappedText } from './arweave-transport';
import { probeStatusOrigin } from './gateway-reads';
import type { Emit } from './metrics';
import { OP_PRUNE_MIN_AGE_MS, type OpProjection } from './op-journal';
import { SPEND_CODES, moneyQuorum } from './spend-ledger';
import { classifyStatus, classifyThrow } from './gateway-class';

export interface LegacyItem { txId: string; reward: string; source: 'permit' | 'journal' }

export type LegacyClosure =
  | { kind: 'closed'; items: readonly LegacyItem[]; scanned: { keys: number; permits: number; journal: number } }
  | { kind: 'open'; code: typeof SPEND_CODES.initLegacyOpen | typeof SPEND_CODES.initLegacyRewardUnknown | typeof SPEND_CODES.initKeysUnknown; detail?: Record<string, unknown> };

export interface LegacyClosureEnv {
  SPEND_GUARD: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  INVITE_MANAGER: DurableObjectNamespace;
  STATUS_GATEWAYS?: string;
  PAYLOAD_GATEWAYS?: string;
  TRUSTED_OWNERS?: string;
}

export interface CloseLegacySetContext {
  env: LegacyClosureEnv;
  emit: Emit;
  walletAddress: string;
  cycle: number;
}

export interface LegacyClosureDeps {
  operatorOf: (origin: string) => string;
  now: () => number;
}

/** How far back the journals are read: as far as they are kept (unresolved
 *  records are never pruned; resolved ones live OP_PRUNE_MIN_AGE_MS) plus one
 *  page window of slack. */
export const LEGACY_JOURNAL_LOOKBACK_MS = OP_PRUNE_MIN_AGE_MS + 14 * 24 * 3_600_000;
const OPS_PAGE_MS = 14 * 24 * 3_600_000;
const OPS_PAGE_LIMIT = 500;
const HEADER_CAP_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
const TXID_RE = /^[A-Za-z0-9_-]{43}$/;
const WINSTON_RE = /^\d{1,40}$/;

type Body = Record<string, unknown> & { ok?: boolean; error?: string };

/** A DO answer, or a typed failure. NEVER an empty default: a 503, a
 *  non-JSON body or a missing field must keep the closure OPEN (review 24.09
 *  #2, high 2 — an enumeration error is not «nothing to hold»). */
class ClosureFailure extends Error {
  constructor(public readonly where: string, message: string) { super(`${where}: ${message}`); }
}
async function doPost(ns: DurableObjectNamespace, name: string, path: string, body: Record<string, unknown> = {}): Promise<Body> {
  let res: Response;
  try {
    res = await ns.get(ns.idFromName(name)).fetch(`http://internal${path}`, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    throw new ClosureFailure(path, `unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status < 200 || res.status >= 300) throw new ClosureFailure(path, `HTTP ${res.status}`);
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ClosureFailure(path, 'not JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ClosureFailure(path, 'not an object');
  return parsed as Body;
}
function requireArray(b: Body, field: string, where: string): unknown[] {
  if (!Array.isArray(b[field])) throw new ClosureFailure(where, `missing ${field}[]`);
  return b[field] as unknown[];
}
function requireOk(b: Body, where: string): void {
  if (b.ok !== true) throw new ClosureFailure(where, `ok !== true (${typeof b.code === 'string' ? b.code : 'no code'})`);
}

function payloadOrigins(env: LegacyClosureEnv): string[] {
  const parsed = parseOriginList(env.PAYLOAD_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}
function statusOrigins(env: LegacyClosureEnv): string[] {
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}

/** The reward of a pre-D10 transaction, from its VERIFIED header at any one
 *  payload origin (id equality + signature + trusted owner), or `null`. */
export async function readVerifiedReward(env: LegacyClosureEnv, txId: string, trustedOwners: readonly string[], emit: Emit): Promise<string | null> {
  for (const origin of payloadOrigins(env)) {
    const host = new URL(origin).host;
    const started = performance.now();
    try {
      const r = await fetch(`${origin}/tx/${txId}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (r.status !== 200) { emit('gateway_call', ['legacy_header', host, classifyStatus(r.status)], [performance.now() - started]); continue; }
      const text = await readCappedText(r, HEADER_CAP_BYTES);
      const header = text === null ? null : parseTxHeader(text);
      if (header === null) { emit('gateway_call', ['legacy_header', host, 'invalid_response'], [performance.now() - started]); continue; }
      const rejection = await verifyHeader(txId, header, trustedOwners);
      if (rejection !== null) {
        // A self-consistent header for ANOTHER transaction (id ≠), a bad
        // signature, or a foreign owner: not ours to price — next origin.
        emit('gateway_call', ['legacy_header', host, 'invalid_response'], [performance.now() - started]);
        continue;
      }
      emit('gateway_call', ['legacy_header', host, '2xx'], [performance.now() - started]);
      return header.reward;
    } catch (e) {
      emit('gateway_call', ['legacy_header', host, classifyThrow(e)], [performance.now() - started]);
    }
  }
  return null;
}

/** Every key that ever held access, and how many old-format invites hide one.
 *  Throws `ClosureFailure` on any incomplete answer. */
export async function listHistoricalKeys(env: LegacyClosureEnv): Promise<{ keys: string[]; unknownLegacyInvites: number }> {
  const b = await doPost(env.INVITE_MANAGER, 'global', '/list-keys');
  const raw = requireArray(b, 'keys', '/list-keys');
  if (!raw.every(k => typeof k === 'string')) throw new ClosureFailure('/list-keys', 'keys[] holds a non-string');
  if (typeof b.unknownLegacyInvites !== 'number' || !Number.isInteger(b.unknownLegacyInvites) || b.unknownLegacyInvites < 0) throw new ClosureFailure('/list-keys', 'unknownLegacyInvites missing');
  return { keys: raw as string[], unknownLegacyInvites: b.unknownLegacyInvites };
}

/** The journal candidates of ONE key: `posting`, `unknown`, and `accepted`
 *  (the latter still to be checked against the money quorum). */
export async function journalCandidates(env: LegacyClosureEnv, key: string, now: number): Promise<{ certain: string[]; accepted: string[] }> {
  const certain = new Set<string>(); const accepted = new Set<string>();
  const from0 = now - LEGACY_JOURNAL_LOOKBACK_MS;
  for (let from = from0; from <= now; from += OPS_PAGE_MS) {
    const to = Math.min(now, from + OPS_PAGE_MS);
    let cursor: string | undefined;
    for (;;) {
      const page = await doPost(env.RATE_LIMITER, key, '/ops', { from, to, limit: OPS_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      if (typeof page.error === 'string') throw new ClosureFailure('/ops', page.error);
      const ops = requireArray(page, 'ops', '/ops') as OpProjection[];
      if (page.cursor !== null && typeof page.cursor !== 'string') throw new ClosureFailure('/ops', 'cursor is neither string nor null');
      for (const op of ops) {
        if (typeof op.txId !== 'string') continue;
        if (op.status === 'posting') certain.add(op.txId);
        else if (op.status === 'finished' && op.paidResult === 'unknown') certain.add(op.txId);
        else if (op.status === 'finished' && op.paidResult === 'accepted') accepted.add(op.txId);
      }
      if (typeof page.cursor !== 'string' || page.cursor === '') break;
      cursor = page.cursor;
    }
  }
  return { certain: [...certain], accepted: [...accepted] };
}

/**
 * The closure (§4.0 п. 2–5). Refuses rather than guesses: unknown keys, a
 * single reward that cannot be read from verified bytes, or ANY failed or
 * incomplete enumeration leave the set OPEN. Idempotent: items already
 * registered in the guard are not returned.
 *
 * Permits (L₁) are REPORTED, never registered (review 24.09 #2, high 3): the
 * money of a permitted txId is already held in the guard as its `active`
 * reservation (carried across `reinit` into the new pending), and it is
 * settled through that reservation — a second hold under `legacy:<txId>`
 * would count the same reward twice. The set is closed by construction for
 * them; only the journals' pre-D10 transactions need a hold.
 */
export async function closeLegacySet(ctx: CloseLegacySetContext, deps: LegacyClosureDeps = { operatorOf: o => o, now: () => Date.now() }): Promise<LegacyClosure> {
  try {
    return await closeLegacySetStrict(ctx, deps);
  } catch (e) {
    if (e instanceof ClosureFailure) {
      ctx.emit('legacy_closure_failed', [e.where], []);
      return { kind: 'open', code: SPEND_CODES.initLegacyOpen, detail: { reason: e.message } };
    }
    throw e;
  }
}

async function closeLegacySetStrict(ctx: CloseLegacySetContext, deps: LegacyClosureDeps): Promise<LegacyClosure> {
  const { env, emit } = ctx;
  const now = deps.now();
  let trustedOwners: string[];
  try { trustedOwners = parseTrustedOwners(env.TRUSTED_OWNERS ?? ''); } catch { trustedOwners = []; }
  if (trustedOwners.length === 0) return { kind: 'open', code: SPEND_CODES.initLegacyRewardUnknown, detail: { reason: 'TRUSTED_OWNERS unusable' } };

  // ── keys ──
  const historical = await listHistoricalKeys(env);
  const stored = await doPost(env.SPEND_GUARD, 'global', '/legacy-keys');
  requireOk(stored, '/legacy-keys');
  if (typeof stored.acknowledgedInvites !== 'number') throw new ClosureFailure('/legacy-keys', 'acknowledgedInvites missing');
  const acknowledged = stored.acknowledgedInvites;
  const extraKeys = requireArray(stored, 'keys', '/legacy-keys').filter((k): k is string => typeof k === 'string');
  if (historical.unknownLegacyInvites > acknowledged) {
    return { kind: 'open', code: SPEND_CODES.initKeysUnknown, detail: { unknownLegacyInvites: historical.unknownLegacyInvites, acknowledged } };
  }
  const keys = [...new Set([...historical.keys, ...extraKeys])];

  // ── already registered + L₁ (accounted by their reservations) ──
  const registered = new Set<string>();
  const list = await doPost(env.SPEND_GUARD, 'global', '/legacy-list');
  requireOk(list, '/legacy-list');
  for (const it of requireArray(list, 'items', '/legacy-list') as Array<{ txId?: unknown }>) {
    if (typeof it.txId !== 'string') throw new ClosureFailure('/legacy-list', 'item without txId');
    registered.add(it.txId);
  }
  const items: LegacyItem[] = [];
  const seen = new Set<string>(registered);
  const permits = await doPost(env.SPEND_GUARD, 'global', '/open-permits');
  requireOk(permits, '/open-permits');
  let permitCount = 0;
  for (const p of requireArray(permits, 'items', '/open-permits') as Array<{ txId?: unknown; reward?: unknown; state?: unknown; spendKey?: unknown }>) {
    // Every field, its type and its value are checked (review 24.09 #3,
    // medium): an item that lacks a field is not «verified», it is unknown.
    if (typeof p.txId !== 'string' || !TXID_RE.test(p.txId)) throw new ClosureFailure('/open-permits', 'item without a canonical txId');
    if (typeof p.spendKey !== 'string' || p.spendKey === '') throw new ClosureFailure('/open-permits', `item ${p.txId} without spendKey`);
    // A permit whose reservation is gone (null) has money nobody holds — that
    // is not a closed set; any other shape is an incomplete answer.
    if (p.reward === null || p.state === null) return { kind: 'open', code: SPEND_CODES.initLegacyRewardUnknown, detail: { txId: p.txId, source: 'permit' } };
    if (typeof p.reward !== 'string' || !WINSTON_RE.test(p.reward)) throw new ClosureFailure('/open-permits', `item ${p.txId} without a Winston reward`);
    if (p.state !== 'prepared' && p.state !== 'active') throw new ClosureFailure('/open-permits', `item ${p.txId} in state ${String(p.state)} is not an open reservation`);
    seen.add(p.txId);
    permitCount++;
  }

  // ── L₂ ──
  const certain = new Set<string>(); const toCheck = new Set<string>();
  for (const key of keys) {
    const c = await journalCandidates(env, key, now);
    for (const t of c.certain) if (!seen.has(t)) certain.add(t);
    for (const t of c.accepted) if (!seen.has(t) && !certain.has(t)) toCheck.add(t);
  }
  const origins = statusOrigins(env);
  for (const txId of toCheck) {
    const votes = await Promise.all(origins.map(o => probeStatusOrigin(o, txId, emit)));
    if (!moneyQuorum(votes, deps.operatorOf).ok) certain.add(txId);
  }
  for (const txId of certain) {
    const reward = await readVerifiedReward(env, txId, trustedOwners, emit);
    if (reward === null) {
      emit('legacy_reward_unknown', [], []);
      return { kind: 'open', code: SPEND_CODES.initLegacyRewardUnknown, detail: { txId, source: 'journal' } };
    }
    items.push({ txId, reward, source: 'journal' });
  }
  return { kind: 'closed', items, scanned: { keys: keys.length, permits: permitCount, journal: items.length } };
}
