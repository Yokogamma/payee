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
  MARKER_MAX_BYTES, MAX_STATUS_HEIGHT_SKEW, MIN_BALANCE_SOURCES, MIN_DEPOSIT_CONFIRMATIONS, SPEND_CODES,
  type FreezeState, type InitRecord, type SpendCode, type SpendLimits,
} from './spend-ledger';
import { permittedPost } from './spend-send';

// ─── Env ────────────────────────────────────────────────────────────────

/** The slice of the worker `Env` this module reads (structural — the
 *  worker's `Env` satisfies it). */
export interface SpendAdminEnv extends MetricsEnv {
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
export const SPEND_ADMIN_OPS = ['freeze', 'init', 'reinit', 'credit-deposit', 'status'] as const;
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

export interface LegacyItem { txId: string; reward: string; source: 'permit' | 'journal' }

/** What the closure of the legacy set (§4.0 п. 2–5) found. */
export type LegacyClosure =
  | { kind: 'closed'; items: readonly LegacyItem[] }
  | { kind: 'open'; code: typeof SPEND_CODES.initLegacyOpen | typeof SPEND_CODES.initLegacyRewardUnknown | typeof SPEND_CODES.initKeysUnknown };

export interface CloseLegacySetContext {
  env: SpendAdminEnv;
  emit: Emit;
  walletAddress: string;
  cycle: number;
}

export interface SpendAdminDeps {
  /** Enumerates and prices the transactions that may still be mined after the
   *  marker. Refuses (`open`) rather than guesses. */
  closeLegacySet: (ctx: CloseLegacySetContext) => Promise<LegacyClosure>;
  /** Operator identity of a status origin (D11): two origins of one operator
   *  are ONE voice. The identity map ships with PR-4 (`STATUS_OPERATORS`);
   *  until it is merged every origin counts as its own operator. */
  operatorOf: (origin: string) => string;
  now: () => number;
}

/** The production default until the reader release carries the closure: the
 *  set is UNKNOWN, so `init` is refused. Not a stub that says «closed». */
export const closeLegacySetNotCarried: SpendAdminDeps['closeLegacySet'] = async () =>
  ({ kind: 'open', code: SPEND_CODES.initLegacyOpen });

export const DEFAULT_SPEND_ADMIN_DEPS: SpendAdminDeps = {
  closeLegacySet: closeLegacySetNotCarried,
  operatorOf: origin => origin,
  now: () => Date.now(),
};

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
    const operator = deps.operatorOf(origin);
    if (byOperator.has(operator)) continue; // one voice per operator
    byOperator.set(operator, { operator, origin, quantity: tx.quantity, height: vote.blockHeight, confirmations: vote.confirmations });
  }
  const witnesses = [...byOperator.values()];
  if (witnesses.length < MIN_BALANCE_SOURCES) return { ok: false, reason: `${witnesses.length} operator(s) verified, need ${MIN_BALANCE_SOURCES}: ${reasons.join('; ') || 'no answers'}` };
  const quantities = new Set(witnesses.map(w => w.quantity));
  if (quantities.size !== 1) return { ok: false, reason: `operators disagree on quantity: ${[...quantities].join(', ')}` };
  const heights = witnesses.map(w => w.height);
  if (Math.max(...heights) - Math.min(...heights) > MAX_STATUS_HEIGHT_SKEW) return { ok: false, reason: `heights disagree beyond the skew: ${heights.join(', ')}` };
  return { ok: true, amount: witnesses[0].quantity, depositHeight: Math.min(...heights), witnesses: witnesses.length };
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
        return answer(200, { ok: true, step: 'done', init: publicInit(record) });
      case 'none':
      case 'signing':
        step = await stepSign(guard, env, emit, deps, view.freeze, record, transport);
        break;
      case 'signed':
        step = await stepPost(guard, env, record, transport);
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
  if (closure.kind === 'open') return { done: refuse(503, closure.code, 'The legacy set is not closed', { step: 'closure' }) };
  if (closure.items.length > 0) {
    const reg = await guardCall(guard, '/init-legacy', { items: closure.items });
    const refused = passRefusal(reg, 'init-legacy');
    if (refused) return { done: refused };
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

/** `signed` → permit (kind `marker`, the one exception under freeze) → POST
 *  the SAME bytes → `posted`. A lost answer leaves `signed`; the next call
 *  resends the same bytes (208 counts as accepted). */
async function stepPost(guard: DurableObjectStub, env: SpendAdminEnv, record: InitRecord, transport: TransportDeps): Promise<InitStep> {
  if (!record.txId || !record.signedTx || !record.token) {
    return { done: refuse(503, SPEND_CODES.markerCorrupt, 'signed marker record is incomplete', { step: 'post' }) };
  }
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
  const posted = await guardCall(guard, '/init-posted', { token: record.token, txId: record.txId, now: Date.now() });
  const refused = passRefusal(posted, 'init-posted');
  if (refused) return { done: refused };
  void env;
  return { next: ((posted as { body: GuardBody }).body.init as InitRecord) };
}

/** `posted` → the status quorum. ≥ MIN_BALANCE_SOURCES operators confirmed
 *  with ≥ MIN_DEPOSIT_CONFIRMATIONS and heights within the skew → `done`
 *  (h_init = max, decided by the DO); unanimous `dead` past the age guard →
 *  `none` (a new marker only from there); anything else → `waiting`. */
async function stepQuorum(guard: DurableObjectStub, env: SpendAdminEnv, emit: Emit, deps: SpendAdminDeps, record: InitRecord): Promise<InitStep> {
  if (!record.txId) return { done: refuse(503, SPEND_CODES.markerCorrupt, 'posted marker record has no txId', { step: 'quorum' }) };
  const origins = statusOrigins(env);
  const votes: StatusVote[] = await Promise.all(origins.map(origin => probeStatusOrigin(origin, record.txId!, emit)));
  const byOperator = new Map<string, Extract<StatusVote, { kind: 'confirmed' }>>();
  for (const v of votes) {
    if (v.kind !== 'confirmed' || v.confirmations < MIN_DEPOSIT_CONFIRMATIONS) continue;
    const op = deps.operatorOf(v.origin);
    if (!byOperator.has(op)) byOperator.set(op, v);
  }
  const agreed = [...byOperator.values()];
  if (agreed.length >= MIN_BALANCE_SOURCES) {
    const heights = agreed.map(v => v.blockHeight);
    if (Math.max(...heights) - Math.min(...heights) <= MAX_STATUS_HEIGHT_SKEW) {
      const done = await guardCall(guard, '/init-done', { txId: record.txId, heights, confirmations: agreed.map(v => v.confirmations), now: deps.now() });
      const refused = passRefusal(done, 'init-done');
      if (refused) return { done: refused };
      emit('init_state', ['done'], []);
      return { next: ((done as { body: GuardBody }).body.init as InitRecord) };
    }
  }
  const verdict = statusVerdict(origins, votes);
  if (verdict.kind === 'dead' && record.postedAt !== undefined && deps.now() - record.postedAt > MARKER_DEAD_AGE_MS) {
    const dead = await guardCall(guard, '/init-dead', { txId: record.txId, now: deps.now() });
    const refused = passRefusal(dead, 'init-dead');
    if (refused) return { done: refused };
    emit('init_state', ['dead'], []);
    return { done: answer(200, { ok: true, step: 'dead', init: publicInit((dead as { body: GuardBody }).body.init as InitRecord), note: 'marker dead past the age guard; call init again to sign a new one' }) };
  }
  return { done: answer(200, {
    ok: true, step: 'waiting', init: publicInit(record),
    quorum: { verdict: verdict.kind, confirmedOperators: agreed.length, need: MIN_BALANCE_SOURCES, minConfirmations: MIN_DEPOSIT_CONFIRMATIONS },
  }) };
}

// The codes this module answers with, beyond SPEND_CODES — pinned for the
// static reviewer and the operator runbook.
export const SPEND_ADMIN_EXTRA_CODES = ['unauthorized', 'invalid_body', 'body_too_large', 'server_misconfigured', 'arweave_gateway_unavailable', 'arweave_internal', 'arweave_post_unknown', 'arweave_rejected'] as const;
export type SpendAdminCode = SpendCode | (typeof SPEND_ADMIN_EXTRA_CODES)[number];
