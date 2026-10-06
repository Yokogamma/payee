/**
 * `/admin/spend/*` — the operator's side of the D10 spend guard (spec rev. 10
 * §4.1–§4.4, §5 «Маршруты воркера»): `freeze`, `init`, `reinit`,
 * `credit-deposit`, `status`.
 *
 * Division of labour (same as the DO's header): the DO holds STATE and
 * DECISIONS; this module does the NETWORK — signs and sends the marker, reads
 * the status quorum, reads and verifies a deposit — and brings verified facts
 * to the DO, one `storage.transaction` per fact.
 *
 * Authentication: `SPEND_ADMIN_SECRET` only. The metrics reader and the invite
 * admin are different identities on purpose (least privilege): a bearer that
 * verifies against THEIR secret is answered `403 wrong_scope`, not `401`, so a
 * misconfigured operator tool fails with a readable reason. Missing own
 * secret → `503 spend_admin_unconfigured` (config is checked before the
 * bearer, as for the other admin routes).
 *
 * `init` is IDEMPOTENT «continue by state» (§4.1): whatever the marker record
 * says — `none`, `signing` (expired lease), `signed`, `posted`, `done` — one
 * call advances it as far as the network allows and reports where it stopped.
 * Every crash boundary is therefore recovered by calling `init` again, never
 * by a second signature: `signed` resends the SAME bytes, `posted` only asks
 * the quorum.
 *
 * Closure of the legacy set (§4.0 п. 2–5) is a DEPENDENCY here, not an
 * implementation: `closeLegacySet` enumerates the transactions that may still
 * be mined after the marker (permits without a terminal outcome, per-key
 * journals, rewards from verified signed bytes). Until the reader release
 * carries it, the production default answers «open», so `init` refuses with
 * `503 spend_init_legacy_open` — fail-closed by construction, never «closed by
 * assumption».
 */

import Arweave from 'arweave';
import { parseOriginList } from '../../src/lib/gateways-parse';
import { statusVerdict, type StatusVote } from '../../src/lib/status-quorum';
import { verifyBearerSecret } from './admin-auth';
import {
  ARWEAVE_HOST, assertStructurallyCompleteJwk, getAnchor, getArweave, getPrice, type TransportDeps,
} from './arweave-transport';
import { probeStatusOrigin, readTxJson } from './gateway-reads';
import { makeEmit, type Emit, type MetricsEnv } from './metrics';
import { APP_NAME } from './protocol';
import {
  MARKER_MAX_BYTES, MIN_BALANCE_SOURCES, MIN_DEPOSIT_CONFIRMATIONS, SPEND_CODES, moneyQuorum,
  type FreezeState, type InitRecord, type SpendCode, type SpendLimits,
} from './spend-ledger';
import { permittedPost } from './spend-send';
import { operatorOfEnv, type OperatorEnv, type OperatorOf } from './operators';
import {
  closeLegacySet as closeLegacySetReal,
  type CloseLegacySetContext, type LegacyClosure, type LegacyClosureEnv, type LegacyItem,
} from './legacy-closure';

export type { CloseLegacySetContext, LegacyClosure, LegacyItem };

// ─── Env ────────────────────────────────────────────────────────────────

/** The slice of the worker `Env` this module reads (structural — the
 *  worker's `Env` satisfies it). */
export interface SpendAdminEnv extends MetricsEnv, LegacyClosureEnv {
  SPEND_GUARD: DurableObjectNamespace;
  /** The ONLY key to `/admin/spend/*` (spec §1). */
  SPEND_ADMIN_SECRET?: string;
  METRICS_ADMIN_SECRET?: string;
  ADMIN_SECRET?: string;
  ARWEAVE_JWK: string;
  STATUS_GATEWAYS?: string;
  /** The three operator limits, Winston as decimal strings (spec §1, §10).
   *  Read on every request; any missing → `503 spend_guard_unconfigured`. */
  WALLET_FLOOR_WINSTON?: string;
  SPEND_WINDOW_CAP_WINSTON?: string;
  MAX_TX_REWARD_WINSTON?: string;
}

const WINSTON_RE = /^\d{1,40}$/;
const TX_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** Authenticated ≠ exempt from body caps. */
const ADMIN_BODY_CAP_BYTES = 4096;
/** Age guard of the dead verdict for a `posted` marker — the same 30 minutes
 *  the recheck path applies to a committed transaction (`MIN_COMMITTED_AGE_MS`). */
export const MARKER_DEAD_AGE_MS = 30 * 60_000;

export const SPEND_ADMIN_PREFIX = '/admin/spend/';
export const SPEND_ADMIN_OPS = ['freeze', 'init', 'reinit', 'credit-deposit', 'status', 'init-legacy-keys'] as const;
export type SpendAdminOp = (typeof SPEND_ADMIN_OPS)[number];
export const SPEND_ADMIN_PATHS = SPEND_ADMIN_OPS.map(op => `${SPEND_ADMIN_PREFIX}${op}`);

/** The three limits as `bigint`, or `null` when any is missing or malformed —
 *  the caller answers `503 spend_guard_unconfigured`, never a default. */
export function readSpendLimits(env: Pick<SpendAdminEnv, 'WALLET_FLOOR_WINSTON' | 'SPEND_WINDOW_CAP_WINSTON' | 'MAX_TX_REWARD_WINSTON'>): SpendLimits | null {
  const raw = [env.WALLET_FLOOR_WINSTON, env.SPEND_WINDOW_CAP_WINSTON, env.MAX_TX_REWARD_WINSTON];
  if (raw.some(v => typeof v !== 'string' || !WINSTON_RE.test(v))) return null;
  return { walletFloor: BigInt(raw[0]!), windowCap: BigInt(raw[1]!), maxTxReward: BigInt(raw[2]!) };
}

/** The limits on the wire to the DO (strings — `bigint` does not serialise). */
export function spendLimitsWire(l: SpendLimits): { walletFloor: string; windowCap: string; maxTxReward: string } {
  return { walletFloor: l.walletFloor.toString(), windowCap: l.windowCap.toString(), maxTxReward: l.maxTxReward.toString() };
}

// ─── Dependencies ───────────────────────────────────────────────────────

export interface SpendAdminDeps {
  /** Enumerates and prices the transactions that may still be mined after the
   *  marker. Refuses (`open`) rather than guesses. */
  closeLegacySet: (ctx: CloseLegacySetContext) => Promise<LegacyClosure>;
  /** Operator identity of a status origin (D11): two origins of one operator
   *  are ONE voice, an unknown origin is no voice. Absent → the map of the
   *  request's env (`STATUS_OPERATORS`, operators.ts); a test may pin one. */
  operatorOf?: OperatorOf;
  now: () => number;
}

/** The operator identity a handler runs under: the test's pin, or the env's map. */
export function operatorOfDeps(deps: Pick<SpendAdminDeps, 'operatorOf'>, env: OperatorEnv): OperatorOf {
  return deps.operatorOf ?? operatorOfEnv(env);
}

/** The closure of the legacy set (legacy-closure.ts), under the env's
 *  operator map and the handler's clock. */
export const closeLegacySetDefault: SpendAdminDeps['closeLegacySet'] = ctx => closeLegacySetReal(ctx, { operatorOf: operatorOfEnv(ctx.env), now: () => Date.now() });

export const DEFAULT_SPEND_ADMIN_DEPS: SpendAdminDeps = {
  closeLegacySet: closeLegacySetDefault,
  now: () => Date.now(),
};

/** Held legacy items resolved per `init` call in `done` (§4.0 п. 6) —
 *  bounded by the subrequest budget (each item probes the status pool). */
export const LEGACY_RESOLVE_BATCH = 20;

// ─── Answers ────────────────────────────────────────────────────────────

function answer(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function refuse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return answer(status, { ok: false, code, error: message, ...extra });
}

// ─── DO calls ───────────────────────────────────────────────────────────

type GuardBody = Record<string, unknown> & { ok?: boolean; code?: string };
type GuardAnswer = { status: number; body: GuardBody } | { unavailable: true };

async function guardCall(guard: DurableObjectStub, path: string, body: Record<string, unknown> = {}, method: 'POST' | 'GET' = 'POST'): Promise<GuardAnswer> {
  try {
    const res = await guard.fetch(`http://spend-guard${path}`, method === 'POST'
      ? { method, body: JSON.stringify(body) }
      : { method });
    const text = await res.text();
    let parsed: GuardBody;
    try { parsed = JSON.parse(text) as GuardBody; } catch { parsed = { ok: false, text }; }
    return { status: res.status, body: parsed };
  } catch (e) {
    console.error('SPEND_GUARD_UNAVAILABLE', path, e);
    return { unavailable: true };
  }
}

/** Pass a DO refusal through with its status and code; `null` when it was ok. */
function passRefusal(r: GuardAnswer, step: string): Response | null {
  if ('unavailable' in r) return refuse(503, SPEND_CODES.guardUnavailable, 'SpendGuard unavailable', { step });
  if (r.status >= 200 && r.status < 300 && r.body.ok === true) return null;
  const code = typeof r.body.code === 'string' ? r.body.code : 'spend_guard_refused';
  return refuse(r.status >= 400 ? r.status : 503, code, `SpendGuard refused ${step}`, { step, ...stripOk(r.body) });
}
function stripOk(b: GuardBody): Record<string, unknown> {
  const { ok: _ok, code: _code, ...rest } = b;
  void _ok; void _code;
  return rest;
}

// ─── Wallet address (keyed on the JWK, as index.ts does) ────────────────

let walletAddressCache: { jwk: string; address: Promise<string> } | null = null;
function walletAddressOf(env: SpendAdminEnv): Promise<string> {
  const jwk = env.ARWEAVE_JWK;
  if (walletAddressCache?.jwk !== jwk) {
    walletAddressCache = {
      jwk,
      address: (async () => {
        const wallet = JSON.parse(jwk);
        return Arweave.init({ host: ARWEAVE_HOST, port: 443, protocol: 'https' }).wallets.jwkToAddress(wallet);
      })(),
    };
  }
  return walletAddressCache.address;
}

function statusOrigins(env: SpendAdminEnv): string[] {
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}

// ─── Handler ────────────────────────────────────────────────────────────

export type SpendAdminHandler = (request: Request, env: SpendAdminEnv) => Promise<Response>;

export function createSpendAdminHandler(deps: SpendAdminDeps = DEFAULT_SPEND_ADMIN_DEPS): SpendAdminHandler {
  return async (request, env) => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(SPEND_ADMIN_PREFIX)) return new Response('Not found', { status: 404 });
    const op = path.slice(SPEND_ADMIN_PREFIX.length) as SpendAdminOp;
    if (!(SPEND_ADMIN_OPS as readonly string[]).includes(op)) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    // ── Auth: own secret configured → own bearer → (foreign scope) → 401 ──
    if (!env.SPEND_ADMIN_SECRET) return refuse(503, SPEND_CODES.adminUnconfigured, 'Spend admin endpoint not configured');
    const auth = request.headers.get('Authorization');
    if (!(await verifyBearerSecret(env.SPEND_ADMIN_SECRET, auth))) {
      if ((await verifyBearerSecret(env.METRICS_ADMIN_SECRET, auth)) || (await verifyBearerSecret(env.ADMIN_SECRET, auth))) {
        return refuse(403, SPEND_CODES.wrongScope, 'This bearer is not the spend admin secret');
      }
      return refuse(401, 'unauthorized', 'Unauthorized');
    }

    // ── Body (JSON object, capped) ──
    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > ADMIN_BODY_CAP_BYTES) return refuse(413, 'body_too_large', 'Body too large');
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > ADMIN_BODY_CAP_BYTES) return refuse(413, 'body_too_large', 'Body too large');
      const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refuse(400, 'invalid_body', 'Body must be a JSON object');
      body = parsed as Record<string, unknown>;
    } catch {
      return refuse(400, 'invalid_body', 'Invalid JSON');
    }

    const guard = env.SPEND_GUARD.get(env.SPEND_GUARD.idFromName('global'));
    const emit = makeEmit(env);
    switch (op) {
      case 'freeze': return handleFreeze(guard, body);
      case 'status': return handleStatus(guard, env);
      case 'reinit': return handleReinit(guard);
      case 'credit-deposit': return handleCreditDeposit(guard, env, body, emit, deps);
      case 'init': return handleInit(guard, env, emit, deps);
      case 'init-legacy-keys': return handleInitLegacyKeys(guard, body);
    }
  };
}

// ─── freeze / status / reinit ───────────────────────────────────────────

async function handleFreeze(guard: DurableObjectStub, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.active !== 'boolean') return refuse(400, 'invalid_body', '`active` must be a boolean');
  const r = await guardCall(guard, '/freeze', { active: body.active });
  return passRefusal(r, 'freeze') ?? answer(200, { ok: true, freeze: stripOk((r as { body: GuardBody }).body) });
}

async function handleStatus(guard: DurableObjectStub, env: SpendAdminEnv): Promise<Response> {
  const r = await guardCall(guard, '/status', {}, 'GET');
  const refused = passRefusal(r, 'status');
  if (refused) return refused;
  const limits = readSpendLimits(env);
  let walletAddress: string | null;
  try { walletAddress = await walletAddressOf(env); } catch { walletAddress = null; }
  return answer(200, {
    ok: true,
    guard: stripOk((r as { body: GuardBody }).body),
    limits: limits === null ? { configured: false } : { configured: true, ...spendLimitsWire(limits) },
    walletAddress,
    statusOrigins: statusOrigins(env),
  });
}

/** §4.0 п. 2: keys the operator recovered from KV / backups, and the count of
 *  old-format invites acknowledged as covered by them. */
async function handleInitLegacyKeys(guard: DurableObjectStub, body: Record<string, unknown>): Promise<Response> {
  if (body.publicKeys !== undefined && !Array.isArray(body.publicKeys)) return refuse(400, 'invalid_body', '`publicKeys` must be an array');
  if (body.acknowledgeLegacyInvites !== undefined && (typeof body.acknowledgeLegacyInvites !== 'number' || !Number.isInteger(body.acknowledgeLegacyInvites) || body.acknowledgeLegacyInvites < 0)) {
    return refuse(400, 'invalid_body', '`acknowledgeLegacyInvites` must be a non-negative integer');
  }
  const r = await guardCall(guard, '/legacy-keys-set', { keys: body.publicKeys ?? [], acknowledgeLegacyInvites: body.acknowledgeLegacyInvites ?? 0 });
  return passRefusal(r, 'legacy-keys') ?? answer(200, { ok: true, legacyKeys: stripOk((r as { body: GuardBody }).body) });
}

async function handleReinit(guard: DurableObjectStub): Promise<Response> {
  const r = await guardCall(guard, '/reinit', {});
  return passRefusal(r, 'reinit') ?? answer(200, { ok: true, reinit: stripOk((r as { body: GuardBody }).body) });
}

// ─── credit-deposit (§4.2) ──────────────────────────────────────────────

interface DepositWitness { operator: string; origin: string; quantity: string; height: number; confirmations: number }

/**
 * Read `/tx/<txId>` and `/tx/<txId>/status` at every status origin, keep one
 * complete witness per OPERATOR, and accept only when ≥ MIN_BALANCE_SOURCES
 * operators agree: target = our wallet, the same quantity, confirmed with
 * ≥ MIN_DEPOSIT_CONFIRMATIONS, heights within MAX_STATUS_HEIGHT_SKEW. The
 * sender must not be our own wallet (a marker or an outgoing transaction is
 * never a deposit). `depositHeight` is the MINIMUM agreed height (§4.2).
 */
export async function verifyDeposit(
  env: SpendAdminEnv, txId: string, walletAddress: string, emit: Emit, deps: SpendAdminDeps,
): Promise<{ ok: true; amount: string; depositHeight: number; witnesses: number } | { ok: false; reason: string }> {
  const origins = statusOrigins(env);
  const arweave = getArweave();
  const reads = await Promise.all(origins.map(async origin => ({
    origin,
    tx: await readTxJson(origin, txId, emit),
    vote: await probeStatusOrigin(origin, txId, emit),
  })));
  const byOperator = new Map<string, DepositWitness>();
  const reasons: string[] = [];
  for (const { origin, tx, vote } of reads) {
    if (tx === null) { reasons.push(`${origin}: tx unreadable`); continue; }
    if (tx.target !== walletAddress) { reasons.push(`${origin}: target is not the worker wallet`); continue; }
    let sender: string;
    try { sender = await arweave.wallets.ownerToAddress(tx.owner); } catch { reasons.push(`${origin}: owner unreadable`); continue; }
    if (sender === walletAddress) { reasons.push(`${origin}: sent by the worker wallet itself`); continue; }
    if (BigInt(tx.quantity) <= 0n) { reasons.push(`${origin}: quantity is zero`); continue; }
    if (vote.kind !== 'confirmed') { reasons.push(`${origin}: status ${vote.kind}`); continue; }
    if (vote.confirmations < MIN_DEPOSIT_CONFIRMATIONS) { reasons.push(`${origin}: ${vote.confirmations} confirmations < ${MIN_DEPOSIT_CONFIRMATIONS}`); continue; }
    const operator = operatorOfDeps(deps, env)(origin);
    if (operator === null) { reasons.push(`${origin}: no known operator`); continue; } // fail-closed
    if (byOperator.has(operator)) continue; // one voice per operator
    byOperator.set(operator, { operator, origin, quantity: tx.quantity, height: vote.blockHeight, confirmations: vote.confirmations });
  }
  const witnesses = [...byOperator.values()];
  if (witnesses.length < MIN_BALANCE_SOURCES) return { ok: false, reason: `${witnesses.length} operator(s) verified, need ${MIN_BALANCE_SOURCES}: ${reasons.join('; ') || 'no answers'}` };
  const quantities = new Set(witnesses.map(w => w.quantity));
  if (quantities.size !== 1) return { ok: false, reason: `operators disagree on quantity: ${[...quantities].join(', ')}` };
  // The same rule as the marker and the settle (moneyQuorum) over the
  // witnesses that passed the transaction checks above.
  const operatorByOrigin = new Map(witnesses.map(w => [w.origin, w.operator]));
  const q = moneyQuorum(
    witnesses.map(w => ({ origin: w.origin, kind: 'confirmed' as const, confirmations: w.confirmations, blockHeight: w.height })),
    origin => operatorByOrigin.get(origin) ?? origin,
  );
  if (!q.ok) return { ok: false, reason: `heights disagree beyond the skew: ${witnesses.map(w => w.height).join(', ')}` };
  // A deposit is credited at the MINIMUM agreed height (§4.2): the strict side
  // for «above the marker».
  return { ok: true, amount: witnesses[0].quantity, depositHeight: Math.min(...q.heights), witnesses: witnesses.length };
}

async function handleCreditDeposit(
  guard: DurableObjectStub, env: SpendAdminEnv, body: Record<string, unknown>, emit: Emit, deps: SpendAdminDeps,
): Promise<Response> {
  const txId = body.txId;
  if (typeof txId !== 'string' || !TX_ID_RE.test(txId)) return refuse(400, 'invalid_body', '`txId` must be a 43-char base64url id');
  let walletAddress: string;
  try { walletAddress = await walletAddressOf(env); } catch { return refuse(503, 'server_misconfigured', 'ARWEAVE_JWK unreadable'); }
  const v = await verifyDeposit(env, txId, walletAddress, emit, deps);
  if (!v.ok) {
    emit('deposit_refused', ['unverified'], []);
    return refuse(503, SPEND_CODES.depositUnverified, 'Deposit could not be verified', { reason: v.reason });
  }
  const r = await guardCall(guard, '/credit-deposit', { txId, amount: v.amount, depositHeight: v.depositHeight });
  const refused = passRefusal(r, 'credit-deposit');
  if (refused) {
    const why = 'unavailable' in r ? 'unavailable' : typeof r.body.code === 'string' ? r.body.code : 'refused';
    emit('deposit_refused', [why], []);
    return refused;
  }
  const out = stripOk((r as { body: GuardBody }).body);
  if (out.credited === true) emit('deposit_credited', [], [Number.isSafeInteger(Number(v.amount)) ? Number(v.amount) : -1]);
  return answer(200, { ok: true, txId, amount: v.amount, depositHeight: v.depositHeight, witnesses: v.witnesses, ...out });
}

// ─── init — «continue by state» (§4.1) ──────────────────────────────────

interface GuardInitView { init: InitRecord; freeze: FreezeState; ledger: { cycle: number; hInit: number | null } }

async function readInit(guard: DurableObjectStub): Promise<GuardInitView | Response> {
  const r = await guardCall(guard, '/init-read', {});
  const refused = passRefusal(r, 'init-read');
  if (refused) return refused;
  const b = (r as { body: GuardBody }).body as unknown as GuardInitView;
  return { init: b.init, freeze: b.freeze, ledger: b.ledger };
}

/** The marker's data: short, human-readable, ≤ MARKER_MAX_BYTES. */
export function markerData(cycle: number, nowMs: number): string {
  const s = `sg-init c=${cycle} t=${new Date(nowMs).toISOString()}`;
  if (new TextEncoder().encode(s).byteLength > MARKER_MAX_BYTES) throw new Error('marker data exceeds MARKER_MAX_BYTES');
  return s;
}

type InitStep = { next: InitRecord } | { done: Response };

async function handleInit(guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps): Promise<Response> {
  const view = await readInit(guard);
  if (view instanceof Response) return view;
  let record = view.init;
  const transport: TransportDeps = { host: ARWEAVE_HOST, emit };
  // At most one pass per state: none → signed → posted → done|waiting.
  for (let hop = 0; hop < 4; hop++) {
    let step: InitStep;
    switch (record.state) {
      case 'done':
        return answer(200, { ok: true, step: 'done', init: publicInit(record), legacy: await resolveHeldLegacy(guard, env, emit, deps, record) });
      case 'none':
      case 'signing':
        step = await stepSign(guard, env, emit, deps, view.freeze, record, transport);
        break;
      case 'signed':
        step = await stepPost(guard, env, emit, deps, record, transport);
        break;
      case 'posted':
        step = await stepQuorum(guard, env, emit, deps, record);
        break;
    }
    if ('done' in step) return step.done;
    record = step.next;
  }
  return answer(200, { ok: true, step: record.state, init: publicInit(record) });
}

function publicInit(r: InitRecord): Record<string, unknown> {
  const { signedTx, token, ...rest } = r;
  void token;
  return { ...rest, signedBytes: signedTx === undefined ? null : signedTx.length };
}

/** `none`/expired `signing` → anchor + price (no state yet) → begin (CAS) →
 *  sign → durable `signed`. The signature is ephemeral until the DO accepts
 *  it: a stale token drops it. */
async function stepSign(
  guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps,
  freeze: FreezeState, record: InitRecord, transport: TransportDeps,
): Promise<InitStep> {
  if (!freeze.active) return { done: refuse(503, SPEND_CODES.initNotFrozen, 'init requires an active freeze', { step: 'begin' }) };
  // Another attempt holds the `signing` lease: the DO would refuse `begin`
  // (409 init_in_progress) — say so BEFORE spending anchor/price requests.
  if (record.state === 'signing' && (record.dueAt ?? 0) > deps.now()) {
    return { done: refuse(409, SPEND_CODES.initInProgress, 'a signing attempt holds the lease', { step: 'begin', dueAt: record.dueAt }) };
  }
  const limits = readSpendLimits(env);
  if (limits === null) return { done: refuse(503, SPEND_CODES.guardUnconfigured, 'Spend limits are not configured', { step: 'begin' }) };
  let wallet: ReturnType<typeof assertStructurallyCompleteJwk>;
  let walletAddress: string;
  try {
    wallet = assertStructurallyCompleteJwk(env.ARWEAVE_JWK);
    walletAddress = await walletAddressOf(env);
  } catch {
    return { done: refuse(503, 'server_misconfigured', 'ARWEAVE_JWK unusable', { step: 'begin' }) };
  }

  // §4.0 п. 5: the legacy set must be closed BEFORE a marker is begun.
  const closure = await deps.closeLegacySet({ env, emit, walletAddress, cycle: record.cycle });
  if (closure.kind === 'open') return { done: refuse(503, closure.code, 'The legacy set is not closed', { step: 'closure', ...(closure.detail ?? {}) }) };
  if (closure.items.length > 0) {
    const reg = await guardCall(guard, '/init-legacy', { items: closure.items, now: deps.now() });
    const refused = passRefusal(reg, 'init-legacy');
    if (refused) return { done: refused };
    emit('legacy_held_registered', [], [closure.items.length]);
  }

  // Anchor and price BEFORE `begin`: nothing durable is touched until we know
  // we can sign within the reward ceiling — a refused quote must not leave a
  // `signing` lease behind.
  const data = markerData(record.cycle, deps.now());
  let last_tx: string;
  let reward: string;
  try {
    last_tx = await getAnchor(transport);
    reward = await getPrice(new TextEncoder().encode(data).byteLength, transport);
  } catch (e) {
    console.error('SPEND_MARKER_PRE_SIGN_FAILED', e);
    return { done: refuse(502, 'arweave_gateway_unavailable', 'Arweave gateway unavailable', { step: 'anchor_price' }) };
  }
  if (BigInt(reward) > limits.maxTxReward) {
    emit('spend_prepare_refused', [SPEND_CODES.quoteMismatch], []);
    return { done: refuse(503, SPEND_CODES.quoteMismatch, 'Marker reward exceeds MAX_TX_REWARD_WINSTON', { step: 'price', reward, maxTxReward: limits.maxTxReward.toString() }) };
  }

  const token = crypto.randomUUID();
  const begin = await guardCall(guard, '/init-begin', { token, legacyOpen: false, rewardUnknown: false, now: deps.now() });
  const beginRefused = passRefusal(begin, 'init-begin');
  if (beginRefused) return { done: beginRefused };

  let tx: Awaited<ReturnType<Arweave['createTransaction']>>;
  try {
    const arweave = getArweave();
    tx = await arweave.createTransaction({ data, last_tx, reward, quantity: '0' }, wallet);
    tx.addTag('App-Name', APP_NAME);
    tx.addTag('Spend-Guard-Init', String(record.cycle));
    await arweave.transactions.sign(tx, wallet);
  } catch (e) {
    // The `signing` lease expires on its own; nothing was sent.
    console.error('SPEND_MARKER_SIGN_FAILED', e);
    return { done: refuse(502, 'arweave_internal', 'Marker could not be signed', { step: 'sign' }) };
  }
  const signed = await guardCall(guard, '/init-signed', { token, txId: tx.id, signedTx: JSON.stringify(tx.toJSON()), anchor: last_tx, now: deps.now() });
  const signedRefused = passRefusal(signed, 'init-signed');
  if (signedRefused) return { done: signedRefused }; // stale token: the ephemeral signature is dropped here
  emit('init_state', ['signed'], []);
  return { next: ((signed as { body: GuardBody }).body.init as InitRecord) };
}

/** The status pool's answer for the marker, under the ONE money quorum rule
 *  (`moneyQuorum`), plus the liveness verdict for the dead branch. */
async function markerQuorum(env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps, txId: string) {
  const origins = statusOrigins(env);
  const votes: StatusVote[] = await Promise.all(origins.map(origin => probeStatusOrigin(origin, txId, emit)));
  return { quorum: moneyQuorum(votes, operatorOfDeps(deps, env)), verdict: statusVerdict(origins, votes) };
}

/** `posted` (idempotent) → `done` with the agreed heights. */
async function markDone(guard: DurableObjectStub, emit: Emit, deps: SpendAdminDeps, record: InitRecord, q: Extract<ReturnType<typeof moneyQuorum>, { ok: true }>): Promise<InitStep> {
  if (record.state === 'signed') {
    // The network has the bytes (a lost POST answer): record the fact first.
    const posted = await guardCall(guard, '/init-posted', { token: record.token, txId: record.txId, now: deps.now() });
    const refused = passRefusal(posted, 'init-posted');
    if (refused) return { done: refused };
  }
  const done = await guardCall(guard, '/init-done', { txId: record.txId, heights: q.heights, confirmations: q.confirmations, now: deps.now() });
  const refused = passRefusal(done, 'init-done');
  if (refused) return { done: refused };
  emit('init_state', ['done'], []);
  return { next: ((done as { body: GuardBody }).body.init as InitRecord) };
}

/** Unanimous `dead` past the age guard → `none` (a new signature only from
 *  there); the guard is measured from the latest durable event. */
async function markDead(guard: DurableObjectStub, emit: Emit, deps: SpendAdminDeps, record: InitRecord): Promise<InitStep> {
  const dead = await guardCall(guard, '/init-dead', { txId: record.txId, now: deps.now() });
  const refused = passRefusal(dead, 'init-dead');
  if (refused) return { done: refused };
  emit('init_state', ['dead'], []);
  return { done: answer(200, { ok: true, step: 'dead', init: publicInit((dead as { body: GuardBody }).body.init as InitRecord), note: 'marker dead past the age guard; call init again to sign a new one' }) };
}

/**
 * §4.0 п. 6 — what becomes of the held legacy transactions once the cycle is
 * `done`: a money quorum above `h_init` → `spent` in this cycle; at or below
 * → `dropped` (the pre-marker reserve); unanimous `dead` past the age guard
 * (from the registration) → `dropped`; anything else stays held, no TTL.
 * Run on every `init` in `done` (the operator's lever), bounded per call.
 */
async function resolveHeldLegacy(guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps, record: InitRecord): Promise<Record<string, unknown>> {
  const list = await guardCall(guard, '/legacy-list', {});
  if ('unavailable' in list) return { error: 'unavailable' };
  const held = ((list.body.items as Array<{ txId: string; state: string; registeredAt?: number }> | undefined) ?? []).filter(i => i.state === 'held');
  const out = { held: held.length, spent: 0, dropped: 0, kept: 0, batch: LEGACY_RESOLVE_BATCH };
  if (record.hInit === undefined) return out;
  for (const item of held.slice(0, LEGACY_RESOLVE_BATCH)) {
    const { quorum, verdict } = await markerQuorum(env, emit, deps, item.txId);
    let outcome: 'spent' | 'dropped' | null = null;
    if (quorum.ok) outcome = quorum.height > record.hInit ? 'spent' : 'dropped';
    else if (verdict.kind === 'dead' && typeof item.registeredAt === 'number' && deps.now() - item.registeredAt > MARKER_DEAD_AGE_MS) outcome = 'dropped';
    if (outcome === null) { out.kept++; continue; }
    const r = await guardCall(guard, '/legacy-resolve', { txId: item.txId, outcome, now: deps.now() });
    if (passRefusal(r, 'legacy-resolve') === null) { out[outcome]++; emit('legacy_resolved', [outcome], []); } else out.kept++;
  }
  return out;
}

function pastAgeGuard(record: InitRecord, now: number): boolean {
  const since = Math.max(record.postedAt ?? 0, record.signedAt ?? 0);
  return since > 0 && now - since > MARKER_DEAD_AGE_MS;
}

/** `signed` → FIRST the quorum (review 24.09, high: a POST whose answer was
 *  lost may already be mined — resending forever while other gateways
 *  confirm it would strand the marker in `signed`): a money quorum → `posted`
 *  → `done` without another send; unanimous `dead` past the age guard →
 *  `none`; otherwise permit (kind `marker`, the one exception under freeze)
 *  → POST the SAME bytes → `posted`. Never a second signature. */
async function stepPost(guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps, record: InitRecord, transport: TransportDeps): Promise<InitStep> {
  if (!record.txId || !record.signedTx || !record.token) {
    return { done: refuse(503, SPEND_CODES.markerCorrupt, 'signed marker record is incomplete', { step: 'post' }) };
  }
  const { quorum, verdict } = await markerQuorum(env, emit, deps, record.txId);
  if (quorum.ok) return markDone(guard, emit, deps, record, quorum);
  if (verdict.kind === 'dead' && pastAgeGuard(record, deps.now())) return markDead(guard, emit, deps, record);
  // The durable bytes as the SDK's `toJSON()` object; `post` rebuilds the
  // Transaction from it (data included) and prepares the chunks itself.
  let tx: { id?: unknown };
  try {
    const parsed: unknown = JSON.parse(record.signedTx);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    tx = parsed as { id?: unknown };
  } catch {
    return { done: refuse(503, SPEND_CODES.markerCorrupt, 'signed marker bytes do not parse', { step: 'post' }) };
  }
  if (tx.id !== record.txId) {
    // Fail closed: neither resend garbage nor sign anew (plan «порча signedTx»).
    return { done: refuse(503, SPEND_CODES.markerCorrupt, 'signed marker bytes do not match the recorded txId', { step: 'post' }) };
  }
  const r = await permittedPost(guard, getArweave(), tx as object, { txId: record.txId, kind: 'marker', cycle: record.cycle }, transport);
  if (r.sent === false) {
    return { done: refuse(r.refusal.status, r.refusal.code, 'permit-send refused the marker', { step: 'permit' }) };
  }
  if (r.sent === 'unknown') {
    console.error('SPEND_MARKER_POST_UNKNOWN', record.txId, r.error);
    return { done: refuse(502, 'arweave_post_unknown', 'Marker POST outcome unknown — call init again to resend the same bytes', { step: 'post', init: publicInit(record) }) };
  }
  if (r.status !== 200 && r.status !== 202 && r.status !== 208) {
    return { done: refuse(502, 'arweave_rejected', `Arweave error: ${r.status}`, { step: 'post', init: publicInit(record) }) };
  }
  const posted = await guardCall(guard, '/init-posted', { token: record.token, txId: record.txId, now: deps.now() });
  const refused = passRefusal(posted, 'init-posted');
  if (refused) return { done: refused };
  return { next: ((posted as { body: GuardBody }).body.init as InitRecord) };
}

/** `posted` → the status quorum. ≥ MIN_BALANCE_SOURCES operators confirmed
 *  with ≥ MIN_DEPOSIT_CONFIRMATIONS and heights within the skew → `done`
 *  (h_init = max, decided by the DO); unanimous `dead` past the age guard →
 *  `none` (a new marker only from there); anything else → `waiting`. */
async function stepQuorum(guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps, record: InitRecord): Promise<InitStep> {
  if (!record.txId) return { done: refuse(503, SPEND_CODES.markerCorrupt, 'posted marker record has no txId', { step: 'quorum' }) };
  const { quorum, verdict } = await markerQuorum(env, emit, deps, record.txId);
  if (quorum.ok) return markDone(guard, emit, deps, record, quorum);
  if (verdict.kind === 'dead' && pastAgeGuard(record, deps.now())) return markDead(guard, emit, deps, record);
  return { done: answer(200, {
    ok: true, step: 'waiting', init: publicInit(record),
    quorum: { verdict: verdict.kind, confirmedOperators: quorum.operators, need: MIN_BALANCE_SOURCES, minConfirmations: MIN_DEPOSIT_CONFIRMATIONS },
  }) };
}

// The codes this module answers with, beyond SPEND_CODES — pinned for the
// static reviewer and the operator runbook.
export const SPEND_ADMIN_EXTRA_CODES = ['unauthorized', 'invalid_body', 'body_too_large', 'server_misconfigured', 'arweave_gateway_unavailable', 'arweave_internal', 'arweave_post_unknown', 'arweave_rejected'] as const;
export type SpendAdminCode = SpendCode | (typeof SPEND_ADMIN_EXTRA_CODES)[number];
