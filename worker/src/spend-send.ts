/**
 * The ONE path from the worker to `POST /tx` (D10 §4.0, normative): a
 * transaction is sent only with a permit from `SpendGuard`, obtained
 * IMMEDIATELY before the send, inside this function. Nothing else in
 * `worker/src` may call `postSignedTx` — the static gate
 * `worker/scripts/permit-send-static.test.mjs` (PR-3b, upload saga) pins it.
 *
 * Why a permit is a durable record and not a flag: a handler that is already
 * past its budget checks still has to come here, AFTER a freeze became durable
 * in the global DO, and is refused. A POST without a permit does not exist by
 * construction, so «the set of transactions that may still be mined» is
 * closed the moment permits stop being issued (§4.0 п. 1).
 *
 * The refusal is TYPED for the caller: it must decide between the two branches
 * of §4.0 («provably never sent» → may abort before sending; «durable
 * recovery» → keep everything and reconcile) — this function only says
 * whether the permit was granted, and never posts without one.
 */

import type Arweave from 'arweave';
import { SPEND_CODES, type PermitKind, type PermitRecord, type SpendCode } from './spend-ledger';
import { postSignedTx, type TransportDeps } from './arweave-transport';

export interface PermitRequest {
  txId: string;
  kind: PermitKind;
  cycle: number;
  /** Storage name of the reservation (`res:` key without the prefix) — absent
   *  for the marker, whose money is not a reservation. */
  spendKey?: string;
}

export type PermitAnswer =
  | { granted: true; permit: PermitRecord; existing: boolean }
  /** The DO refused (frozen / not initialised) — the caller picks the §4.0
   *  branch from `existing === undefined` (no permit was ever issued). */
  | { granted: false; code: SpendCode; status: number }
  /** The DO did not answer at all: by §9 «SpendGuard unavailable → 503 and,
   *  by construction, not a single POST». */
  | { granted: false; code: typeof SPEND_CODES.guardUnavailable; status: 503; unavailable: true };

/** Ask the global guard for the permit — one `storage.transaction` there. */
export async function requestPermit(guard: DurableObjectStub, req: PermitRequest): Promise<PermitAnswer> {
  let res: Response;
  let body: { ok?: boolean; code?: string; permit?: PermitRecord; existing?: boolean };
  try {
    res = await guard.fetch('http://spend-guard/permit-send', {
      method: 'POST',
      body: JSON.stringify({ txId: req.txId, kind: req.kind, cycle: req.cycle, ...(req.spendKey !== undefined ? { spendKey: req.spendKey } : {}) }),
    });
    body = (await res.json()) as typeof body;
  } catch (e) {
    console.error('SPEND_GUARD_UNAVAILABLE', 'permit-send', req.txId, e);
    return { granted: false, code: SPEND_CODES.guardUnavailable, status: 503, unavailable: true };
  }
  if (res.ok && body.ok === true && body.permit) {
    return { granted: true, permit: body.permit, existing: body.existing === true };
  }
  const code = (typeof body.code === 'string' ? body.code : SPEND_CODES.guardUnavailable) as SpendCode;
  return { granted: false, code, status: res.status >= 400 ? res.status : 503 };
}

/** What the SDK's `post` accepts: a `Transaction`, or its `toJSON()` object
 *  (the SDK rebuilds the instance — the durable marker bytes travel this way).
 *  No runtime import of `arweave/node/lib/transaction`: that module pulls the
 *  Node `crypto`/`buffer` built-ins into the wrangler bundle. */
export type PostableTx = Parameters<Arweave['transactions']['post']>[0];

export type PermittedPostResult =
  | { sent: true; status: number }
  /** The SDK threw during the send: the transaction MAY have been accepted
   *  (`post_unknown`) — the permit was issued, so the caller keeps everything. */
  | { sent: 'unknown'; error: unknown }
  | { sent: false; refusal: Extract<PermitAnswer, { granted: false }> };

/**
 * permit-send → POST, with nothing in between. The permit request carries the
 * txId of the SIGNED bytes about to go out; a repeat for the same txId returns
 * the same permit (resend = no double accounting, §4.0).
 */
export async function permittedPost(
  guard: DurableObjectStub,
  arweave: Arweave,
  tx: PostableTx,
  req: PermitRequest,
  deps: TransportDeps,
): Promise<PermittedPostResult> {
  const id = typeof tx === 'object' && tx !== null && 'id' in tx ? (tx as { id?: unknown }).id : undefined;
  if (id !== req.txId) {
    // A programming error, and a money one: the permit names the bytes.
    return { sent: false, refusal: { granted: false, code: SPEND_CODES.remapRefused, status: 503 } };
  }
  const permit = await requestPermit(guard, req);
  if (!permit.granted) return { sent: false, refusal: permit };
  try {
    const r = await postSignedTx(arweave, tx, deps);
    return { sent: true, status: r.status };
  } catch (e) {
    return { sent: 'unknown', error: e };
  }
}
