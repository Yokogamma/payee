/**
 * Explicit Arweave transport adapter (PR-2).
 *
 * The SDK's createTransaction() silently fetches GET /tx_anchor and
 * GET /price/{bytes} whenever last_tx/reward are not supplied
 * (arweave/node/common.js) — making the anchor|price|post legs
 * indistinguishable from inside the worker. Here anchor and price are
 * EXPLICIT fetches with their own timeout, body cap and runtime response
 * schema, and their results are handed to createTransaction pre-loaded, so
 * the SDK makes no hidden network calls. POST stays on the SDK (rewriting it
 * would change uploader semantics for no gain) and is only measured.
 *
 * Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-2 «Реализация».
 */

import Arweave from 'arweave';
import type { JWKInterface } from 'arweave/node/lib/wallet';
import type { Emit } from './metrics';

export const ARWEAVE_HOST = 'arweave.net';

export interface TransportDeps {
  host: string;
  emit: Emit;
}

// Verified against a live gateway (2026-08-21): /tx_anchor returns a
// 64-char base64url block indep-hash (NOT a 43-char txId!) — the 43..64
// range is mandatory, "exactly 43" would break production. /price returns
// plain digits (up to 20 — beyond Number.MAX_SAFE_INTEGER, so the price is
// always carried as a STRING; see getPrice).
const ANCHOR_RE = /^[A-Za-z0-9_-]{43,64}$/;
const PRICE_RE = /^\d{1,20}$/;

// Pre-signature legs only: both run BEFORE signing, no money is at risk yet,
// so an active timeout is safe here (unlike POST — see postSignedTx).
const LEG_TIMEOUT_MS = 10_000;
const LEG_BODY_CAP_BYTES = 1024; // 1 KiB

/** Module-memoized SDK instance (pattern: getWalletAddress in index.ts). */
let arweaveInstance: Arweave | null = null;
export function getArweave(): Arweave {
  if (!arweaveInstance) {
    arweaveInstance = Arweave.init({ host: ARWEAVE_HOST, port: 443, protocol: 'https' });
  }
  return arweaveInstance;
}

const PRIVATE_RSA_FIELDS = ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'] as const;

/**
 * STRUCTURAL completeness only — the name states the honest boundary. Checks
 * kty === 'RSA' and that every private-RSA field (n, e, d, p, q, dp, dq, qi)
 * is a non-empty string; '{}' and truncated keys fail BEFORE any network.
 *
 * Accepted limitation (deliberate): a structurally complete but
 * cryptographically invalid JWK (broken base64url, inconsistent parameters)
 * passes this check, spends the anchor+price requests and fails at signing —
 * the price of NOT importing the key before network (a WebCrypto import would
 * not match arweave-js's RSA driver and would give false confidence).
 */
export function assertStructurallyCompleteJwk(raw: string): JWKInterface {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ARWEAVE_JWK is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARWEAVE_JWK is not a JSON object');
  }
  const jwk = parsed as Record<string, unknown>;
  if (jwk.kty !== 'RSA') throw new Error('ARWEAVE_JWK: kty must be "RSA"');
  for (const field of PRIVATE_RSA_FIELDS) {
    if (typeof jwk[field] !== 'string' || jwk[field] === '') {
      throw new Error(`ARWEAVE_JWK: missing/empty private RSA field "${field}"`);
    }
  }
  return jwk as unknown as JWKInterface;
}

/** Thrown on any gateway-leg failure; the caller's existing catch keeps the 502 path. */
export class GatewayLegError extends Error {}

export function classifyStatus(status: number): '2xx' | '404' | '4xx' | '5xx' | 'network' {
  if (status >= 200 && status < 300) return '2xx';
  if (status === 404) return '404';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'network'; // 1xx/3xx leftovers are not a valid gateway answer here
}

export function classifyThrow(e: unknown): 'timeout' | 'network' {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    ? 'timeout'
    : 'network';
}

/**
 * Read a response body under a hard cap without materialising the excess.
 * Returns null when the cap is exceeded (stream cancelled). Rethrows abort
 * errors from the response's own signal (callers classify them as timeout).
 */
export async function readCappedText(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/**
 * Shared GET leg: fetch → classify → validate the body against the runtime
 * schema. An HTTP success whose body fails the schema is a PROTOCOL defect of
 * the gateway and is classified `invalid_response` — masking it as `network`
 * would hide exactly the signal D9 introduces verification for. Every
 * non-2xx-with-valid-body outcome throws (gateway refusal, existing 502 path).
 */
async function gatewayGet(
  kind: 'anchor' | 'price',
  path: string,
  validate: (body: string) => boolean,
  deps: TransportDeps,
  okDouble?: (body: string) => number,
): Promise<string> {
  const started = performance.now();
  let res: Response;
  let body: string | null = null;
  let cls: string;
  try {
    res = await fetch(`https://${deps.host}/${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
    });
    cls = classifyStatus(res.status);
    if (cls === '2xx') {
      body = await readCappedText(res, LEG_BODY_CAP_BYTES); // null = oversized
      if (body === null || !validate(body)) cls = 'invalid_response';
    }
  } catch (e) {
    deps.emit('gateway_call', [kind, deps.host, classifyThrow(e)], [performance.now() - started]);
    throw new GatewayLegError(`${kind}: ${classifyThrow(e)}`);
  }
  const doubles = [performance.now() - started];
  if (cls === '2xx' && okDouble) doubles.push(okDouble(body!));
  deps.emit('gateway_call', [kind, deps.host, cls], doubles);
  if (cls !== '2xx') throw new GatewayLegError(`${kind}: gateway answered ${cls}`);
  return body!;
}

/** GET /tx_anchor → base64url 43..64 chars, or a gateway refusal (throws). */
export function getAnchor(deps: TransportDeps): Promise<string> {
  return gatewayGet('anchor', 'tx_anchor', (b) => ANCHOR_RE.test(b), deps);
}

/**
 * GET /price/{bytes} → plain digits (1..20), returned AS A STRING — the SDK
 * always receives the reward as a string, and a 20-digit price exceeds
 * Number.MAX_SAFE_INTEGER. The metric double quotedWinston is written only
 * when Number.isSafeInteger holds, otherwise −1 (the shared "not recorded"
 * convention).
 */
export function getPrice(bytes: number, deps: TransportDeps): Promise<string> {
  return gatewayGet('price', `price/${bytes}`, (b) => PRICE_RE.test(b), deps, (b) => {
    const n = Number(b);
    return Number.isSafeInteger(n) ? n : -1;
  });
}

/**
 * A PASSIVE stopwatch around arweave.transactions.post(tx) — nothing else.
 *
 * Deliberately NO AbortSignal/deadline around POST until PR-3b (HIGH r14):
 * the caller's catch releases the reservation, and a response lost to OUR OWN
 * timeout does not prove the gateway rejected the transaction — an active
 * timeout would widen the double-paid-publication window. A slow but accepted
 * POST must run to completion.
 */
export async function postSignedTx(
  arweave: Arweave,
  tx: Parameters<Arweave['transactions']['post']>[0],
  deps: TransportDeps,
): Promise<{ status: number }> {
  const started = performance.now();
  let response: { status: number };
  try {
    response = await arweave.transactions.post(tx);
  } catch (e) {
    deps.emit('gateway_call', ['post', deps.host, classifyThrow(e)], [performance.now() - started]);
    throw e;
  }
  deps.emit('gateway_call', ['post', deps.host, classifyStatus(response.status)], [performance.now() - started]);
  return response;
}
