/**
 * The proof that permitted bytes can never land (review 24.09 #5, high 1) —
 * read from the chain, never from the clock.
 *
 * A transaction is mineable only while its `last_tx` names one of the last
 * `ANCHOR_EXPIRY_BLOCKS` blocks (spend-ledger.ts `anchorExpired`). So the
 * question «can this send still land?» has a chain answer: the height of the
 * anchor block and the chain's confirmed height. Both are read at every
 * status origin, one voice per operator, and count only when
 * ≥ MIN_BALANCE_SOURCES operators answer: the anchor's height must be AGREED
 * (every answering operator names the same height — a hash has one height),
 * the chain height is the MINIMUM (the chain is at least this far). Anything
 * short of that is `unavailable`, and unavailable means the hold stays.
 *
 * With a proof in hand the worker tells the guard (`/anchor-expired`), which
 * checks that it is about the permit's own anchor and re-applies the rule
 * before it lets the lease go. Time never enters.
 */

import { parseOriginList } from '../../src/lib/gateways-parse';
import { ARWEAVE_HOST } from './arweave-transport';
import { readBlockHeightByHash, readChainHeight } from './gateway-reads';
import type { Emit } from './metrics';
import { operatorOfEnv, type OperatorOf } from './operators';
import { MIN_BALANCE_SOURCES, SPEND_CODES, anchorExpired } from './spend-ledger';
import { guardPost } from './spend-saga';

export type AnchorProof =
  | { kind: 'expired'; anchorHeight: number; chainHeight: number }
  | { kind: 'valid'; anchorHeight: number; chainHeight: number }
  | { kind: 'unavailable'; reason: 'anchor_height' | 'chain_height' | 'anchor_disagreement' };

/** Read the two chain facts and apply the rule. Network only, no guard. */
export async function readAnchorProof(
  env: { STATUS_GATEWAYS?: string; STATUS_OPERATORS?: string },
  anchor: string,
  emit: Emit,
  operatorOf: OperatorOf = operatorOfEnv(env),
): Promise<AnchorProof> {
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  const origins = parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
  const answers = await Promise.all(origins.map(async origin => ({
    origin,
    anchorHeight: await readBlockHeightByHash(origin, anchor, emit),
    chainHeight: await readChainHeight(origin, emit),
  })));
  const anchorByOp = new Map<string, number>();
  const chainByOp = new Map<string, number>();
  for (const a of answers) {
    const op = operatorOf(a.origin);
    if (op === null) continue; // no known operator, no voice (fail-closed)
    if (a.anchorHeight !== null && !anchorByOp.has(op)) anchorByOp.set(op, a.anchorHeight);
    if (a.chainHeight !== null && !chainByOp.has(op)) chainByOp.set(op, a.chainHeight);
  }
  if (anchorByOp.size < MIN_BALANCE_SOURCES) return { kind: 'unavailable', reason: 'anchor_height' };
  if (chainByOp.size < MIN_BALANCE_SOURCES) return { kind: 'unavailable', reason: 'chain_height' };
  const anchorHeights = [...new Set(anchorByOp.values())];
  if (anchorHeights.length !== 1) return { kind: 'unavailable', reason: 'anchor_disagreement' };
  const anchorHeight = anchorHeights[0];
  const chainHeight = Math.min(...chainByOp.values());
  return anchorExpired(anchorHeight, chainHeight)
    ? { kind: 'expired', anchorHeight, chainHeight }
    : { kind: 'valid', anchorHeight, chainHeight };
}

export type ProveResult = 'expired' | 'valid' | 'unavailable' | 'refused' | 'unknown';

/**
 * Read the proof and, when the anchor has expired, record it on the permit
 * (`/anchor-expired`). `expired` — the guard accepted (or already held) the
 * proof: the lease is gone; `valid` — the bytes may still land, the hold
 * stays; `unavailable` — no quorum, the hold stays; `refused` — the guard
 * rejected the proof (not this permit's anchor, or the rule does not hold
 * for it); `unknown` — no permit names the txId.
 */
export async function proveAnchorExpired(
  env: { STATUS_GATEWAYS?: string; STATUS_OPERATORS?: string },
  guard: DurableObjectStub,
  emit: Emit,
  args: { txId: string; anchor: string },
  operatorOf?: OperatorOf,
): Promise<ProveResult> {
  const proof = await readAnchorProof(env, args.anchor, emit, operatorOf);
  emit('anchor_proof', [proof.kind, proof.kind === 'unavailable' ? proof.reason : 'ok'], [proof.kind === 'unavailable' ? -1 : proof.chainHeight - proof.anchorHeight]);
  if (proof.kind !== 'expired') return proof.kind;
  const r = await guardPost(guard, '/anchor-expired', { txId: args.txId, anchor: args.anchor, anchorHeight: proof.anchorHeight, chainHeight: proof.chainHeight });
  if ('unavailable' in r) return 'unavailable';
  if (r.status === 404) return 'unknown';
  if (r.status >= 200 && r.status < 300 && r.body.ok === true) return 'expired';
  console.error('SPEND_ANCHOR_PROOF_REFUSED', args.txId, r.body.code ?? r.status, r.body.code === SPEND_CODES.anchorMismatch ? 'not the permit anchor' : '');
  return 'refused';
}
