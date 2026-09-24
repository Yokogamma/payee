/**
 * Read-only gateway legs shared by the upload path and the D10 spend guard:
 * the status probe (moved here from `index.ts` unchanged in behaviour), the
 * wallet balance read (§3.4 detector) and the transaction-JSON read (§4.2
 * deposit verification). None of them spends money; each has its own timeout,
 * body cap and runtime schema, and answers a typed value — a gateway that
 * returns garbage is `invalid_response`, never a verdict.
 *
 * `redirect: 'manual'` everywhere, for the reason the status probe documents:
 * a gateway answering 302 → another gateway would give two configured origins
 * one host's opinion, and quorums over the pool are what authorise money.
 */

import type { StatusVote } from '../../src/lib/status-quorum';
import type { Emit } from './metrics';
import { classifyStatus, classifyThrow } from './gateway-class';
import { readCappedText } from './arweave-transport';

const READ_TIMEOUT_MS = 10_000;
const BALANCE_BODY_CAP = 64;
/** `/tx/<id>` of a transfer or a small data transaction is a few KiB; a data
 *  transaction inlines its bytes only when they are small, so 64 KiB is ample
 *  and anything larger is not a transaction this code needs to read. */
const TX_JSON_BODY_CAP = 64 * 1024;
const WINSTON_RE = /^\d{1,40}$/;
const TX_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET `<origin>/tx/<txId>/status` → one vote (PR-3a). Behaviourally identical
 * to the probe that lived in `index.ts`; relocated so the marker automaton and
 * the deposit verification can ask the same question the recheck asks.
 *
 * 400 is a non-404 outcome like any other, and under the quorum it BLOCKS
 * `dead` instead of causing it.
 */
export async function probeStatusOrigin(origin: string, txId: string, emit: Emit): Promise<StatusVote> {
  const host = new URL(origin).host;
  const started = performance.now();
  let r: Response;
  try {
    r = await fetch(`${origin}/tx/${txId}/status`, {
      method: 'GET',
      // NO REDIRECTS — and this is the half that spends money (see module doc).
      // `'manual'`, NOT `'error'`: workerd rejects the latter with a TypeError
      // before any I/O, which turned every probe into a `network` throw and
      // pinned the quorum at `unavailable`.
      redirect: 'manual',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (e) {
    emit('gateway_call', ['status', host, classifyThrow(e)], [performance.now() - started]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }
  const elapsed = performance.now() - started;

  if (r.status === 202) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['alive', host], [-1]);
    return { origin, kind: 'pending' };
  }
  if (r.status === 404) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['dead', host], [-1]);
    return { origin, kind: 'dead404' };
  }
  if (r.status !== 200) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }

  // A 200 must carry a body that satisfies the schema to count as alive. A
  // malformed one is a PROTOCOL defect (`invalid_response`), never a verdict.
  let confirmations = -1;
  let blockHeight = -1;
  try {
    const text = await readCappedText(r, 1024);
    if (text !== null) {
      const doc: unknown = JSON.parse(text);
      if (typeof doc === 'object' && doc !== null) {
        const d = doc as { number_of_confirmations?: unknown; block_height?: unknown };
        if (safeCount(d.number_of_confirmations) && safeCount(d.block_height)) {
          confirmations = d.number_of_confirmations;
          blockHeight = d.block_height;
        }
      }
    }
  } catch { /* stays −1 → invalid_response below */ }

  if (confirmations < 0) {
    emit('gateway_call', ['status', host, 'invalid_response'], [elapsed]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }
  emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
  emit('status_verdict', ['alive', host], [confirmations]);
  return { origin, kind: 'confirmed', confirmations, blockHeight };
}

export function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * GET `<origin>/wallet/<address>/balance` → Winston as a decimal STRING, or
 * `null` for anything that is not a clean 200 with a digit-only body. The
 * caller takes the MINIMUM over ≥ `MIN_BALANCE_SOURCES` answers (§3.4) — the
 * value is a detector input and an upper bound, never a credit.
 */
export async function readWalletBalance(origin: string, address: string, emit: Emit): Promise<string | null> {
  const host = new URL(origin).host;
  const started = performance.now();
  try {
    const r = await fetch(`${origin}/wallet/${address}/balance`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const elapsed = performance.now() - started;
    if (r.status !== 200) {
      emit('gateway_call', ['balance', host, classifyStatus(r.status)], [elapsed]);
      return null;
    }
    const body = await readCappedText(r, BALANCE_BODY_CAP);
    const ok = body !== null && WINSTON_RE.test(body.trim());
    emit('gateway_call', ['balance', host, ok ? '2xx' : 'invalid_response'], [elapsed]);
    return ok ? body!.trim() : null;
  } catch (e) {
    emit('gateway_call', ['balance', host, classifyThrow(e)], [performance.now() - started]);
    return null;
  }
}

/** The fields of `/tx/<id>` the deposit verification reads (§4.2). `owner` is
 *  the RSA modulus of the sender (base64url), NOT an address. */
export interface TxJson { id: string; owner: string; target: string; quantity: string; reward: string }

/**
 * GET `<origin>/tx/<txId>` → the transaction's JSON, or `null` unless the body
 * is a 200 whose `id` EQUALS the requested txId (spec §4.0 п. 3, review #9 H2:
 * a gateway may answer with a correctly formed DIFFERENT transaction; the id
 * equality is what binds the answer to the question) and whose money fields
 * are digit strings.
 */
export async function readTxJson(origin: string, txId: string, emit: Emit): Promise<TxJson | null> {
  if (!TX_ID_RE.test(txId)) return null;
  const host = new URL(origin).host;
  const started = performance.now();
  try {
    const r = await fetch(`${origin}/tx/${txId}`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const elapsed = performance.now() - started;
    if (r.status !== 200) {
      emit('gateway_call', ['tx', host, classifyStatus(r.status)], [elapsed]);
      return null;
    }
    const text = await readCappedText(r, TX_JSON_BODY_CAP);
    let parsed: TxJson | null = null;
    if (text !== null) {
      try {
        const doc = JSON.parse(text) as Partial<TxJson>;
        if (
          typeof doc === 'object' && doc !== null
          && doc.id === txId
          && typeof doc.owner === 'string' && doc.owner !== ''
          && typeof doc.target === 'string'
          && typeof doc.quantity === 'string' && WINSTON_RE.test(doc.quantity)
          && typeof doc.reward === 'string' && WINSTON_RE.test(doc.reward)
        ) {
          parsed = { id: doc.id, owner: doc.owner, target: doc.target, quantity: doc.quantity, reward: doc.reward };
        }
      } catch { /* invalid_response */ }
    }
    emit('gateway_call', ['tx', host, parsed ? '2xx' : 'invalid_response'], [elapsed]);
    return parsed;
  } catch (e) {
    emit('gateway_call', ['tx', host, classifyThrow(e)], [performance.now() - started]);
    return null;
  }
}

const INFO_BODY_CAP = 8 * 1024;
const BLOCK_BODY_CAP = 256 * 1024;
const BLOCK_HASH_RE = /^[A-Za-z0-9_-]{43,64}$/;

/**
 * GET `<origin>/info` → the gateway's chain height, or `null`. A chain fact
 * for the proof of anchor expiry (`anchor-expiry.ts`): the caller takes the
 * MINIMUM over ≥ MIN_BALANCE_SOURCES operators — the chain is at least this
 * far, whatever one gateway runs ahead of.
 */
export async function readChainHeight(origin: string, emit: Emit): Promise<number | null> {
  const host = new URL(origin).host;
  const started = performance.now();
  try {
    const r = await fetch(`${origin}/info`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const elapsed = performance.now() - started;
    if (r.status !== 200) {
      emit('gateway_call', ['info', host, classifyStatus(r.status)], [elapsed]);
      return null;
    }
    const body = await readCappedText(r, INFO_BODY_CAP);
    let height: unknown;
    try { height = body === null ? undefined : (JSON.parse(body) as { height?: unknown }).height; } catch { height = undefined; }
    const ok = safeCount(height);
    emit('gateway_call', ['info', host, ok ? '2xx' : 'invalid_response'], [elapsed]);
    return ok ? (height as number) : null;
  } catch (e) {
    emit('gateway_call', ['info', host, classifyThrow(e)], [performance.now() - started]);
    return null;
  }
}

/**
 * GET `<origin>/block/hash/<indep_hash>` → the block's height, or `null`
 * unless the body is a 200 whose `indep_hash` EQUALS the requested hash (the
 * same binding rule as `readTxJson`: the answer must be about the question).
 * The anchor of a transaction is such a hash (`/tx_anchor`); its height is
 * the other half of the expiry rule. A 404 is `null` too — an anchor a
 * gateway does not know is not proof of anything.
 */
export async function readBlockHeightByHash(origin: string, indepHash: string, emit: Emit): Promise<number | null> {
  if (!BLOCK_HASH_RE.test(indepHash)) return null;
  const host = new URL(origin).host;
  const started = performance.now();
  try {
    const r = await fetch(`${origin}/block/hash/${indepHash}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const elapsed = performance.now() - started;
    if (r.status !== 200) {
      emit('gateway_call', ['block', host, classifyStatus(r.status)], [elapsed]);
      return null;
    }
    const body = await readCappedText(r, BLOCK_BODY_CAP);
    let parsed: { indep_hash?: unknown; height?: unknown } | null = null;
    try { parsed = body === null ? null : (JSON.parse(body) as { indep_hash?: unknown; height?: unknown }); } catch { parsed = null; }
    const ok = parsed !== null && parsed.indep_hash === indepHash && safeCount(parsed.height);
    emit('gateway_call', ['block', host, ok ? '2xx' : 'invalid_response'], [elapsed]);
    return ok ? (parsed!.height as number) : null;
  } catch (e) {
    emit('gateway_call', ['block', host, classifyThrow(e)], [performance.now() - started]);
    return null;
  }
}
