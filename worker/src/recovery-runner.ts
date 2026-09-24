/**
 * PR-3b recovery — the NETWORK half of one scheduler step, run by the per-key
 * `RateLimiter` (its alarm, or the nudge of a recheck). The rules are
 * `recovery.ts`; the transactions and the alarm recompute are the DO's
 * (`RecoveryHost`); this module does what needs the network:
 *
 *   signed          → status quorum → posted | resend the SAME bytes | phase 1
 *   redrop_pending  → phase 2: a NEW signature from the stored data and tags,
 *                     under a NEW generation's D10 reservation, committed by
 *                     CAS BEFORE any send, then activate → permit-send(redrop2)
 *                     → POST → posted.
 *
 * Money goes through the same doors as a fresh upload: `activateSpend` (the
 * §6 CAS table; idempotent for an already active reservation), and
 * `permittedPost` (the one path to the network). Nothing here posts without a
 * permit and nothing signs outside phase 2.
 */

import Arweave from 'arweave';
import { statusVerdict, type StatusVote } from '../../src/lib/status-quorum';
import { parseOriginList } from '../../src/lib/gateways-parse';
import {
  ARWEAVE_HOST, assertStructurallyCompleteJwk, getAnchor, getArweave, getPrice, type TransportDeps,
} from './arweave-transport';
import { probeStatusOrigin } from './gateway-reads';
import { makeEmit, type Emit, type MetricsEnv } from './metrics';
import {
  casOf, nextGenerationSpendKey, parseSignedTx, rescheduled, signedAction, toPosted, toRedropPending, toSignedFromRedrop,
  type PostedRecord, type RecoveryCas, type RecoveryRecord,
} from './recovery';
import { readSpendLimits } from './spend-admin';
import { moneyQuorum } from './spend-ledger';
import { activateSpend, prepareSpend, releaseSpend, settleByTx } from './spend-saga';
import { permittedPost } from './spend-send';

export interface RecoveryEnv extends MetricsEnv {
  SPEND_GUARD: DurableObjectNamespace;
  ARWEAVE_JWK: string;
  STATUS_GATEWAYS?: string;
  WALLET_FLOOR_WINSTON?: string;
  SPEND_WINDOW_CAP_WINSTON?: string;
  MAX_TX_REWARD_WINSTON?: string;
}

/** What the DO gives one step: CAS-guarded transitions, each ONE storage
 *  transaction that also maintains `recoveryCount`, the index and the alarm. */
export interface RecoveryHost {
  /** Apply `next` only if the record still matches `expected`. */
  cas(noteId: string, expected: RecoveryCas, next: RecoveryRecord | PostedRecord): Promise<boolean>;
  /** Is the record still the one this run read? Asked right BEFORE a send:
   *  a run that lost the record to a concurrent phase 1 must not post
   *  (review 24.09 #2, high 1). */
  stillMine(noteId: string, expected: RecoveryCas): Promise<boolean>;
  now(): number;
}

export type StepOutcome =
  | 'posted' | 'resent' | 'rescheduled' | 'redrop_pending' | 'signed'
  /** The record moved under us (a concurrent recheck or run): nothing written. */
  | 'discarded'
  /** The stored bytes are unusable: nothing sent, nothing signed, rescheduled. */
  | 'corrupt';

function origins(env: RecoveryEnv): string[] {
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}

async function quorumOf(env: RecoveryEnv, emit: Emit, txId: string) {
  const o = origins(env);
  const votes: StatusVote[] = await Promise.all(o.map(origin => probeStatusOrigin(origin, txId, emit)));
  return { verdict: statusVerdict(o, votes), money: moneyQuorum(votes, origin => origin) };
}

/** One scheduler step for one recovery record. Never throws for a gateway or
 *  guard failure — those reschedule; a throw here is a defect. */
export async function recoverOne(noteId: string, record: RecoveryRecord, env: RecoveryEnv, host: RecoveryHost): Promise<StepOutcome> {
  const emit = makeEmit(env);
  return record.status === 'signed'
    ? stepSigned(noteId, record, env, host, emit)
    : stepRedropPending(noteId, record, env, host, emit);
}

// ─── signed ─────────────────────────────────────────────────────────────

async function stepSigned(noteId: string, record: RecoveryRecord, env: RecoveryEnv, host: RecoveryHost, emit: Emit): Promise<StepOutcome> {
  const expected = casOf(record);
  const guard = env.SPEND_GUARD.get(env.SPEND_GUARD.idFromName('global'));
  const { verdict, money } = await quorumOf(env, emit, record.txId);
  const now = host.now();
  const action = signedAction(verdict, record, now);
  emit('recovery_step', ['signed', action], [record.attempts]);

  if (action === 'advance_posted') {
    // Liveness moves the record; MONEY settles only under the guard's quorum
    // (the same rule as the recheck path — spend-saga / review 24.09).
    if (money.ok) await settleByTx(guard, { txId: record.txId, outcome: 'spent', height: money.height });
    return (await host.cas(noteId, expected, toPosted(record, now))) ? 'posted' : 'discarded';
  }
  if (action === 'redrop') {
    // Phase 1 (plan «Redrop — явно двухфазный»): the CAS transition FIRST,
    // then the second call of the order — the dead transaction's reservation
    // is released (idempotent; repeated at every phase-2 attempt as well).
    const ok = await host.cas(noteId, expected, toRedropPending(record, crypto.randomUUID(), now));
    if (!ok) return 'discarded';
    await releaseSpend(guard, record.spendKey);
    return 'redrop_pending';
  }
  if (action === 'reschedule') {
    return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'rescheduled' : 'discarded';
  }

  // resend: the SAME bytes, under the same reservation and the same permit.
  const parsed = parseSignedTx(record.signedTx, record.txId);
  if (parsed === null) {
    console.error('RECOVERY_SIGNED_TX_CORRUPT', noteId, record.txId);
    emit('recovery_corrupt', ['signed'], []);
    return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'corrupt' : 'discarded';
  }
  const limits = readSpendLimits(env);
  if (limits !== null) {
    const activated = await activateSpend(guard, { spendKey: record.spendKey, reward: parsed.reward, limits });
    if (!activated.ok) {
      emit('recovery_refused', ['activate', activated.refusal.code], []);
      return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'rescheduled' : 'discarded';
    }
    // POST is allowed only after the outcome `active` (plan §6): a terminal
    // no-op means the money of this txId is settled — released by a phase 1
    // that overtook this run, or spent — and nothing may be sent for it.
    if (activated.state !== 'active') {
      emit('recovery_refused', ['activate', `terminal_${activated.state}`], []);
      return 'discarded';
    }
    // The last look before the network: the record must still be ours.
    if (!(await host.stillMine(noteId, expected))) return 'discarded';
    const sent = await permittedPost(guard, getArweave(), parsed.raw as object, { txId: record.txId, kind: 'resend', cycle: activated.cycle, spendKey: record.spendKey }, transport(emit));
    if (sent.sent === true && (sent.status === 200 || sent.status === 202 || sent.status === 208)) {
      emit('post_accepted', [ARWEAVE_HOST], []);
      return (await host.cas(noteId, expected, toPosted(record, host.now()))) ? 'resent' : 'discarded';
    }
    if (sent.sent === false) emit('recovery_refused', ['permit', sent.refusal.code], []);
    else if (sent.sent === 'unknown') console.error('RECOVERY_RESEND_UNKNOWN', noteId, record.txId, sent.error);
  } else {
    emit('recovery_refused', ['limits', 'spend_guard_unconfigured'], []);
  }
  return (await host.cas(noteId, expected, rescheduled(record, host.now()))) ? 'rescheduled' : 'discarded';
}

// ─── redrop_pending → phase 2 ───────────────────────────────────────────

async function stepRedropPending(noteId: string, record: RecoveryRecord, env: RecoveryEnv, host: RecoveryHost, emit: Emit): Promise<StepOutcome> {
  const expected = casOf(record);
  const guard = env.SPEND_GUARD.get(env.SPEND_GUARD.idFromName('global'));
  const deadTxId = record.deadTxId ?? record.txId;
  const now = host.now();
  emit('recovery_step', ['redrop_pending', 'phase2'], [record.attempts]);

  // (а) the stored bytes must parse and BE the dead transaction — otherwise
  // an autonomous phase 2 is impossible: fail closed, the slot stays, a
  // client-carried /upload of this note is the only way out (plan п. 4).
  const parsed = parseSignedTx(record.signedTx, deadTxId);
  if (parsed === null) {
    console.error('RECOVERY_REDROP_SOURCE_CORRUPT', noteId, deadTxId);
    emit('recovery_corrupt', ['redrop_pending'], []);
    return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'corrupt' : 'discarded';
  }
  // The second call of the phase-1 order, repeated idempotently (a crash
  // between the two calls is healed here).
  await releaseSpend(guard, record.spendKey);

  const limits = readSpendLimits(env);
  if (limits === null) {
    emit('recovery_refused', ['limits', 'spend_guard_unconfigured'], []);
    return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'rescheduled' : 'discarded';
  }
  let wallet: ReturnType<typeof assertStructurallyCompleteJwk>;
  try { wallet = assertStructurallyCompleteJwk(env.ARWEAVE_JWK); } catch (e) {
    console.error('RECOVERY_WALLET_UNUSABLE', e);
    return (await host.cas(noteId, expected, rescheduled(record, now))) ? 'rescheduled' : 'discarded';
  }

  // (б) data and tags travel UNCHANGED from the stored bytes; only anchor and
  // reward are new. The new generation gets its own D10 reservation.
  const data = Arweave.utils.b64UrlToBuffer(parsed.data);
  const tags = parsed.tags.map(t => ({ name: Arweave.utils.b64UrlToString(t.name), value: Arweave.utils.b64UrlToString(t.value) }));
  const newSpendKey = nextGenerationSpendKey(record.spendKey, record.generation + 1);
  const deps = transport(emit);
  let last_tx: string; let reward: string;
  try {
    last_tx = await getAnchor(deps);
    reward = await getPrice(data.byteLength, deps);
  } catch (e) {
    console.error('RECOVERY_PHASE2_PRE_SIGN_FAILED', noteId, e);
    return (await host.cas(noteId, expected, rescheduled(record, host.now()))) ? 'rescheduled' : 'discarded';
  }
  const prepared = await prepareSpend(guard, { spendKey: newSpendKey, bytes: data.byteLength, reward, limits });
  if (!prepared.ok) {
    emit('recovery_refused', ['prepare', prepared.refusal.code], []);
    return (await host.cas(noteId, expected, rescheduled(record, host.now()))) ? 'rescheduled' : 'discarded';
  }

  // (в) the signature — ephemeral until the CAS below commits it.
  let tx: Awaited<ReturnType<Arweave['createTransaction']>>;
  try {
    const arweave = getArweave();
    tx = await arweave.createTransaction({ data, last_tx, reward }, wallet);
    for (const t of tags) tx.addTag(t.name, t.value);
    await arweave.transactions.sign(tx, wallet);
  } catch (e) {
    console.error('RECOVERY_PHASE2_SIGN_FAILED', noteId, e);
    return (await host.cas(noteId, expected, rescheduled(record, host.now()))) ? 'rescheduled' : 'discarded';
  }

  // (г) CAS `redrop_pending → signed` with the NEW txId and bytes. A loser's
  // signature is dropped here and never sent (POST needs the durable record).
  const nextSigned = toSignedFromRedrop(record, { txId: tx.id, signedTx: JSON.stringify(tx.toJSON()), spendKey: newSpendKey, reward, token: crypto.randomUUID() }, host.now());
  if (!(await host.cas(noteId, expected, nextSigned))) return 'discarded';
  emit('redrop_new_tx', [ARWEAVE_HOST], []);

  // Only now the network: activate (the reward of the SIGNED transaction) →
  // permit-send(redrop2) → POST → posted. Any failure leaves the new `signed`
  // for the next run (resend of the same bytes).
  const signedCas = casOf(nextSigned);
  const activated = await activateSpend(guard, { spendKey: newSpendKey, reward, limits });
  if (!activated.ok) {
    emit('recovery_refused', ['activate', activated.refusal.code], []);
    await host.cas(noteId, signedCas, rescheduled(nextSigned, host.now()));
    return 'signed';
  }
  if (activated.state !== 'active') {
    emit('recovery_refused', ['activate', `terminal_${activated.state}`], []);
    return 'signed';
  }
  if (!(await host.stillMine(noteId, signedCas))) return 'discarded';
  const sent = await permittedPost(guard, getArweave(), tx, { txId: tx.id, kind: 'redrop2', cycle: activated.cycle, spendKey: newSpendKey }, deps);
  if (sent.sent === true && (sent.status === 200 || sent.status === 202 || sent.status === 208)) {
    emit('post_accepted', [ARWEAVE_HOST], []);
    return (await host.cas(noteId, signedCas, toPosted(nextSigned, host.now()))) ? 'posted' : 'signed';
  }
  if (sent.sent === false) emit('recovery_refused', ['permit', sent.refusal.code], []);
  else if (sent.sent === 'unknown') console.error('RECOVERY_PHASE2_POST_UNKNOWN', noteId, tx.id, sent.error);
  await host.cas(noteId, signedCas, rescheduled(nextSigned, host.now()));
  return 'signed';
}

function transport(emit: Emit): TransportDeps {
  return { host: ARWEAVE_HOST, emit };
}
