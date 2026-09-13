import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  applyAbort, applyFinish, applyPosting, newOpRecord, projectOp, isPrunable,
  opIndexKey, opIndexLowerBound, opIndexUpperBound, opKey, OP_PRUNE_MIN_AGE_MS, OP_META_KEY,
  type OpBegin, type OpRecord, type OpProjection, type OpMeta,
} from '../src/op-journal';
import type { RateLimiter } from '../src/rate-limiter';

// The operation journal inside the RateLimiter DO (plan «soak D2 operation
// journal» v6.1 §2, tests 5, 8, 9, 10): the pure transition rules first, then
// the same rules through the DO's own routes on real storage.

const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;
const RUN = crypto.randomUUID().slice(0, 8);
const stubFor = (name: string) => RATE_LIMITER.get(RATE_LIMITER.idFromName(`opj-${name}-${RUN}`));

const FP = 'a'.repeat(64);
const TX = 'A'.repeat(43);
const TX2 = 'B'.repeat(43);

function begin(overrides: Partial<OpBegin> = {}): OpBegin {
  return {
    id: crypto.randomUUID(), mode: 'plain', declaredVersion: '2',
    releaseSha: 'f'.repeat(40), workerVersionId: 'v-test', idOrigin: 'client', ...overrides,
  };
}

async function call<T>(stub: DurableObjectStub, path: string, body: unknown): Promise<T> {
  const r = await stub.fetch(`http://do${path}`, { method: 'POST', body: JSON.stringify(body) });
  return r.json() as Promise<T>;
}
type Check = { status: string; token?: string; txId?: string; opAccepted?: boolean };
const reserve = (s: DurableObjectStub, noteId: string, op?: OpBegin, fp: string | undefined = FP, limit = 20) =>
  call<Check>(s, '/check-and-reserve', { noteId, limit, ...(fp === undefined ? {} : { fp }), ...(op ? { op } : {}) });
const opGet = async (s: DurableObjectStub, id: string) => (await call<{ op: OpProjection | null }>(s, '/op-get', { id })).op;
const commit = (s: DurableObjectStub, noteId: string, txId: string, token: string) =>
  call<{ ok: boolean }>(s, '/commit', { noteId, txId, token });

// ─── Pure transitions ───────────────────────────────────────────────

describe('op-journal transitions (pure)', () => {
  const begun = (): OpRecord => newOpRecord(begin(), 'n1', FP, 'ok', 1000);

  it('newOpRecord: begun, paidResult none, verdict recorded twice (latest + history)', () => {
    const r = begun();
    expect(r).toMatchObject({ status: 'begun', paidResult: 'none', checkVerdict: 'ok', checkVerdicts: ['ok'], beganAt: 1000 });
    expect(r.token).toBeUndefined();
  });

  it('posting: only from begun, only with a matching reservation, valid txId and decision', () => {
    const r = begun();
    expect(applyPosting(undefined, { id: r.id, token: 't', txId: TX, decision: 'new' }, true, 2000)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(applyPosting(r, { id: r.id, token: 't', txId: TX, decision: 'new' }, false, 2000)).toMatchObject({ ok: false, reason: 'reservation_mismatch' });
    expect(applyPosting(r, { id: r.id, token: 't', txId: 'short', decision: 'new' }, true, 2000)).toMatchObject({ ok: false, reason: 'bad_tx_id' });
    expect(applyPosting(r, { id: r.id, token: 't', txId: TX, decision: 'nope' as never }, true, 2000)).toMatchObject({ ok: false, reason: 'bad_decision' });
    const t = applyPosting(r, { id: r.id, token: 't', txId: TX, decision: 'legacy_dead_redrop' }, true, 2000);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.record).toMatchObject({ status: 'posting', paidResult: 'unknown', txId: TX, token: 't', decision: 'legacy_dead_redrop', postingAt: 2000 });
    expect(applyPosting(t.record, { id: r.id, token: 't', txId: TX, decision: 'new' }, true, 2001)).toMatchObject({ ok: false, reason: 'not_begun:posting' });
  });

  it('abort: only from posting, only with the bound token; never token-less; keeps checkVerdict', () => {
    const r = begun();
    // No token-less abort exists: a begun record cannot be aborted at all.
    expect(applyAbort(r, { id: r.id, token: '', reason: 'x' }, 3000)).toMatchObject({ ok: false, reason: 'not_posting:begun' });
    const p = applyPosting(r, { id: r.id, token: 't', txId: TX, decision: 'new' }, true, 2000);
    if (!p.ok) throw new Error('posting failed');
    expect(applyAbort(p.record, { id: r.id, token: 'other', reason: 'x' }, 3000)).toMatchObject({ ok: false, reason: 'token_mismatch' });
    expect(applyAbort(p.record, { id: r.id, token: '', reason: 'x' }, 3000)).toMatchObject({ ok: false, reason: 'token_mismatch' });
    const a = applyAbort(p.record, { id: r.id, token: 't', reason: 'audit_unconfirmed' }, 3000);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.record).toMatchObject({
      status: 'finished', paidResult: 'none', outcome: 'audit_aborted', code: 'audit_unconfirmed', httpStatus: 503, checkVerdict: 'ok', txId: TX,
    });
    // The handler's follow-up finish with the same pair is idempotent.
    expect(applyFinish(a.record, { id: r.id, outcome: 'audit_aborted', httpStatus: 503, code: 'audit_unconfirmed', paidResult: 'none' }, 3001)).toMatchObject({ ok: true });
  });

  it('finish from begun: only paidResult none; records outcome/code/attests', () => {
    const r = begun();
    expect(applyFinish(r, { id: r.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX }, 4000))
      .toMatchObject({ ok: false, reason: 'paid_result_without_posting' });
    const f = applyFinish(r, { id: r.id, outcome: 'deduped', httpStatus: 200, paidResult: 'none', txId: TX, attests: ['legacy_backfilled', 'deduped'] }, 4000);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.record).toMatchObject({ status: 'finished', outcome: 'deduped', httpStatus: 200, paidResult: 'none', txId: TX, attests: ['legacy_backfilled', 'deduped'], finishedAt: 4000 });
  });

  it('finish from posting: accepted only with the journaled txId; never none; unknown allowed', () => {
    const r = begun();
    const p = applyPosting(r, { id: r.id, token: 't', txId: TX, decision: 'new' }, true, 2000);
    if (!p.ok) throw new Error('posting failed');
    expect(applyFinish(p.record, { id: r.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX2 }, 4000))
      .toMatchObject({ ok: false, reason: 'tx_id_mismatch' });
    expect(applyFinish(p.record, { id: r.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted' }, 4000))
      .toMatchObject({ ok: false, reason: 'tx_id_mismatch' });
    expect(applyFinish(p.record, { id: r.id, outcome: 'audit_unconfirmed', httpStatus: 503, paidResult: 'none' }, 4000))
      .toMatchObject({ ok: false, reason: 'none_after_posting' });
    // The journaled (signed, sent) txId can never be replaced — for ANY outcome.
    expect(applyFinish(p.record, { id: r.id, outcome: 'post_unknown', httpStatus: 502, paidResult: 'unknown', txId: TX2 }, 4000))
      .toMatchObject({ ok: false, reason: 'tx_id_mismatch' });
    expect(applyFinish(p.record, { id: r.id, outcome: 'arweave_error', httpStatus: 502, paidResult: 'rejected', txId: TX2 }, 4000))
      .toMatchObject({ ok: false, reason: 'tx_id_mismatch' });
    const rej = applyFinish(p.record, { id: r.id, outcome: 'arweave_error', httpStatus: 502, paidResult: 'rejected' }, 4000);
    expect(rej.ok).toBe(true);
    if (rej.ok) expect(rej.record.txId).toBe(TX);
    const u = applyFinish(p.record, { id: r.id, outcome: 'post_unknown', httpStatus: 502, code: 'arweave_post_unknown', paidResult: 'unknown', txId: TX }, 4000);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.record).toMatchObject({ status: 'finished', paidResult: 'unknown', txId: TX, decision: 'new' });
    const a = applyFinish(p.record, { id: r.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX }, 4000);
    expect(a.ok).toBe(true);
  });

  it('finish is idempotent for the same result and refuses a different one, leaving the record as it was', () => {
    const r = begun();
    const f = applyFinish(r, { id: r.id, outcome: 'deduped', httpStatus: 200, paidResult: 'none', txId: TX }, 4000);
    if (!f.ok) throw new Error('finish failed');
    const again = applyFinish(f.record, { id: r.id, outcome: 'deduped', httpStatus: 200, paidResult: 'none', txId: TX }, 5000);
    expect(again).toMatchObject({ ok: true });
    if (again.ok) expect(again.record).toBe(f.record);
    expect(applyFinish(f.record, { id: r.id, outcome: 'conflict', httpStatus: 409, paidResult: 'none' }, 5000))
      .toMatchObject({ ok: false, reason: 'conflicting_finish' });
    expect(applyFinish(f.record, { id: r.id, outcome: 'deduped', httpStatus: 200, paidResult: 'none', txId: TX2 }, 5000))
      .toMatchObject({ ok: false, reason: 'conflicting_finish' });
  });

  it('finish validates its inputs', () => {
    const r = begun();
    expect(applyFinish(r, { id: r.id, outcome: '', httpStatus: 200, paidResult: 'none' }, 1)).toMatchObject({ ok: false, reason: 'bad_outcome' });
    expect(applyFinish(r, { id: r.id, outcome: 'x', httpStatus: 42, paidResult: 'none' }, 1)).toMatchObject({ ok: false, reason: 'bad_http_status' });
    expect(applyFinish(r, { id: r.id, outcome: 'x', httpStatus: 200, paidResult: 'maybe' as never }, 1)).toMatchObject({ ok: false, reason: 'bad_paid_result' });
    expect(applyFinish(r, { id: r.id, outcome: 'x', httpStatus: 200, paidResult: 'none', txId: 'bad' }, 1)).toMatchObject({ ok: false, reason: 'bad_tx_id' });
    expect(applyFinish(undefined, { id: r.id, outcome: 'x', httpStatus: 200, paidResult: 'none' }, 1)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('projection strips the token and nothing else', () => {
    const r = begun();
    const p = applyPosting(r, { id: r.id, token: 'secret', txId: TX, decision: 'new' }, true, 2000);
    if (!p.ok) throw new Error('posting failed');
    const proj = projectOp(p.record);
    expect('token' in proj).toBe(false);
    expect(proj).toMatchObject({ id: r.id, txId: TX, status: 'posting' });
  });

  it('prunable: only finished, non-unknown, older than the age; index keys sort by time', () => {
    const r = begun();
    const old = OP_PRUNE_MIN_AGE_MS + 10_000;
    expect(isPrunable(r, old)).toBe(false); // begun never
    const f = applyFinish(r, { id: r.id, outcome: 'deduped', httpStatus: 200, paidResult: 'none' }, 1000);
    if (!f.ok) throw new Error();
    expect(isPrunable(f.record, old)).toBe(true);
    expect(isPrunable(f.record, 1000 + OP_PRUNE_MIN_AGE_MS - 1)).toBe(false);
    const p = applyPosting(begun(), { id: 'x', token: 't', txId: TX, decision: 'new' }, true, 1000);
    if (!p.ok) throw new Error();
    const u = applyFinish(p.record, { id: 'x', outcome: 'post_unknown', httpStatus: 502, paidResult: 'unknown', txId: TX }, 1000);
    if (!u.ok) throw new Error();
    expect(isPrunable(u.record, old)).toBe(false); // unknown never
    expect(isPrunable(p.record, old)).toBe(false); // posting never

    expect(opIndexKey(1, 'a') < opIndexKey(2, 'a')).toBe(true);
    expect(opIndexKey(0xffff, 'a') < opIndexKey(0x10000, 'a')).toBe(true);
    expect(opIndexLowerBound(5) <= opIndexKey(5, 'a')).toBe(true);
    expect(opIndexKey(5, 'zzz') < opIndexUpperBound(5)).toBe(true);
    expect(opIndexKey(6, 'a') >= opIndexUpperBound(5)).toBe(true);
  });
});

// ─── Through the DO ─────────────────────────────────────────────────

describe('RateLimiter journal routes', () => {
  it('check-and-reserve with op writes a begun record with the DO verdict; without op, nothing', async () => {
    const s = stubFor('begin');
    const op = begin();
    const r = await reserve(s, 'n1', op);
    expect(r).toMatchObject({ status: 'ok', opAccepted: true });
    const rec = await opGet(s, op.id);
    expect(rec).toMatchObject({
      id: op.id, noteId: 'n1', requestedFp: FP, mode: 'plain', declaredVersion: '2',
      releaseSha: 'f'.repeat(40), workerVersionId: 'v-test', idOrigin: 'client',
      status: 'begun', paidResult: 'none', checkVerdict: 'ok', checkVerdicts: ['ok'],
    });
    expect((rec as Record<string, unknown>).token).toBeUndefined();

    const bare = await reserve(s, 'n2');
    expect(bare.status).toBe('ok');
    expect(bare.opAccepted).toBeUndefined();
  });

  it('a verdict the DO decides terminally is finished in the same transaction (in progress, rate limited)', async () => {
    const s = stubFor('terminal');
    await reserve(s, 'n', begin());
    const op2 = begin();
    expect((await reserve(s, 'n', op2)).status).toBe('reserved');
    expect(await opGet(s, op2.id)).toMatchObject({
      status: 'finished', outcome: 'in_progress', httpStatus: 409, code: 'upload_in_progress', checkVerdict: 'reserved', paidResult: 'none',
    });
    const op3 = begin();
    expect((await reserve(s, 'm', op3, FP, 1)).status).toBe('rate_limited');
    expect(await opGet(s, op3.id)).toMatchObject({ status: 'finished', outcome: 'rate_limited', httpStatus: 429, code: 'rate_limited' });
  });

  it('a repeated operationId answers op_reused and changes NOTHING — not the record, not the note (test 5)', async () => {
    const s = stubFor('reused');
    const op = begin();
    const first = await reserve(s, 'n1', op);
    expect(first.status).toBe('ok');
    const before = JSON.stringify(await opGet(s, op.id));
    // Same params, and different params (another note, another fp): both refused.
    expect(await reserve(s, 'n1', op)).toEqual({ status: 'op_reused' });
    expect(await reserve(s, 'other-note', op, 'b'.repeat(64))).toEqual({ status: 'op_reused' });
    expect(JSON.stringify(await opGet(s, op.id))).toBe(before);
    expect(await opGet(s, op.id)).toMatchObject({ status: 'begun' });
    // The note is still reserved under the first token: no second reservation
    // was made for 'other-note' either.
    expect((await reserve(s, 'n1')).status).toBe('reserved');
    expect((await reserve(s, 'other-note')).status).toBe('ok');
  });

  it('retry continues the SAME operation (legacy second ask) and appends the verdict', async () => {
    const s = stubFor('retry');
    const op = begin();
    const r = await reserve(s, 'n1', op);
    expect((await commit(s, 'n1', TX, r.token!)).ok).toBe(true);
    const again = await reserve(s, 'n1', { ...op, retry: true });
    expect(again).toMatchObject({ status: 'exists', opAccepted: true });
    expect(await opGet(s, op.id)).toMatchObject({ checkVerdict: 'exists', checkVerdicts: ['ok', 'exists'], status: 'begun' });
    // retry without a begun record, or for another note, is refused.
    expect(await reserve(s, 'n1', { ...begin(), retry: true })).toEqual({ status: 'op_invalid' });
    expect(await reserve(s, 'nX', { ...op, retry: true })).toEqual({ status: 'op_invalid' });
  });

  it('op_invalid for a malformed op; the decision is NOT made', async () => {
    const s = stubFor('invalid');
    expect(await reserve(s, 'n1', { ...begin(), id: 'not-a-uuid' })).toEqual({ status: 'op_invalid' });
    expect((await reserve(s, 'n1')).status).toBe('ok'); // nothing was reserved above
  });

  it('op-posting binds to the live reservation token; op-abort needs that token; finish rules hold (tests 3c, 8)', async () => {
    const s = stubFor('posting');
    const op = begin();
    const r = await reserve(s, 'n1', op);
    expect(await call(s, '/op-posting', { id: op.id, token: 'wrong', txId: TX, decision: 'new' })).toMatchObject({ ok: false, reason: 'reservation_mismatch' });
    expect(await call(s, '/op-abort', { id: op.id, token: r.token, reason: 'x' })).toMatchObject({ ok: false, reason: 'not_posting:begun' });
    expect(await call(s, '/op-posting', { id: op.id, token: r.token, txId: TX, decision: 'recheck_dead_redrop' })).toEqual({ ok: true });
    expect(await opGet(s, op.id)).toMatchObject({ status: 'posting', paidResult: 'unknown', txId: TX, decision: 'recheck_dead_redrop' });
    expect(await call(s, '/op-abort', { id: op.id, token: 'other', reason: 'x' })).toMatchObject({ ok: false, reason: 'token_mismatch' });
    expect(await call(s, '/op-abort', { id: op.id, reason: 'x' })).toMatchObject({ ok: false, reason: 'token_mismatch' });
    // unknown → accepted only with the SAME txId
    expect(await call(s, '/op-finish', { id: op.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX2 })).toMatchObject({ ok: false, reason: 'tx_id_mismatch' });
    expect(await call(s, '/op-finish', { id: op.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX })).toEqual({ ok: true });
    // idempotent repeat; a different result is refused and the record untouched
    expect(await call(s, '/op-finish', { id: op.id, outcome: 'accepted', httpStatus: 200, paidResult: 'accepted', txId: TX })).toEqual({ ok: true });
    expect(await call(s, '/op-finish', { id: op.id, outcome: 'post_unknown', httpStatus: 502, paidResult: 'unknown', txId: TX })).toMatchObject({ ok: false, reason: 'conflicting_finish' });
    expect(await opGet(s, op.id)).toMatchObject({ status: 'finished', outcome: 'accepted', paidResult: 'accepted', txId: TX });
    expect((await opGet(s, op.id)) as Record<string, unknown>).not.toHaveProperty('token');
  });

  it('op-abort from posting with the token finishes as audit_aborted and keeps txId + verdict', async () => {
    const s = stubFor('abort');
    const op = begin();
    const r = await reserve(s, 'n1', op);
    expect(await call(s, '/op-posting', { id: op.id, token: r.token, txId: TX, decision: 'new' })).toEqual({ ok: true });
    expect(await call(s, '/op-abort', { id: op.id, token: r.token, reason: 'audit_unconfirmed' })).toEqual({ ok: true });
    expect(await opGet(s, op.id)).toMatchObject({
      status: 'finished', outcome: 'audit_aborted', paidResult: 'none', code: 'audit_unconfirmed', httpStatus: 503, txId: TX, checkVerdict: 'ok',
    });
  });

  it('admission is ONE transaction: a throw after decide / op / index rolls every write back', async () => {
    for (const faultAfter of ['decide', 'op', 'index'] as const) {
      const s = stubFor(`tx-${faultAfter}`);
      // A first, healthy admission so the counters and the journal are non-empty.
      const warm = begin();
      expect((await reserve(s, 'warm', warm)).status).toBe('ok');
      // The FULL storage: every key with its value, so any partial write —
      // a counter, a note, a record, an index entry, the meta — shows up.
      const snapshot = () => runInDurableObject(s, async (_i: RateLimiter, state: DurableObjectState) =>
        Object.fromEntries([...(await state.storage.list()).entries()].sort(([a], [b]) => (a < b ? -1 : 1))));
      const before = await snapshot();

      await runInDurableObject(s, async (instance: RateLimiter) => { instance.faultAfter = faultAfter; });
      const op = begin();
      await expect(reserve(s, 'n-fault', op)).rejects.toThrow();
      await runInDurableObject(s, async (instance: RateLimiter) => { instance.faultAfter = undefined; });

      const after = await snapshot();
      // Nothing landed: every key–value pair is exactly as before the fault.
      expect(after).toEqual(before);
      expect(Object.keys(before).length).toBeGreaterThan(4); // the warm-up did leave state to compare
      expect(await opGet(s, op.id)).toBeNull();
      expect((await reserve(s, 'n-fault')).status).toBe('ok'); // the note was never reserved
    }
  });

  it('pruning walks the index with a cursor: a protected head of unresolved records does not hide old finished ones', async () => {
    const s = stubFor('prune');
    const old = Date.now() - OP_PRUNE_MIN_AGE_MS - 60_000;
    // 100 unresolved records at the FRONT of the index (older beganAt), then
    // 3 finished + aged ones, then a fresh finished one that must stay.
    const front: string[] = [];
    const prunable: string[] = [];
    await runInDurableObject(s, async (instance: RateLimiter, state: DurableObjectState) => {
      instance.pruneMinCount = 10;
      let t = old - 1_000_000;
      const write = async (rec: OpRecord) => {
        await state.storage.put(opKey(rec.id), rec);
        await state.storage.put(opIndexKey(rec.beganAt, rec.id), rec.id);
      };
      for (let i = 0; i < 100; i++) {
        const rec = newOpRecord(begin(), `u${i}`, FP, 'ok', t++);
        front.push(rec.id);
        await write(rec);
      }
      for (let i = 0; i < 3; i++) {
        const rec: OpRecord = {
          ...newOpRecord(begin(), `f${i}`, FP, 'exists', t++), status: 'finished', paidResult: 'none', outcome: 'deduped', httpStatus: 200, finishedAt: old,
        };
        prunable.push(rec.id);
        await write(rec);
      }
      const fresh: OpRecord = {
        ...newOpRecord(begin(), 'fresh', FP, 'exists', t), status: 'finished', paidResult: 'none', outcome: 'deduped', httpStatus: 200, finishedAt: Date.now(),
      };
      await write(fresh);
      await state.storage.put<OpMeta>(OP_META_KEY, { count: 104 });
    });

    // First admission: the pass visits the protected head (100), removes nothing, saves a cursor.
    expect((await reserve(s, 'a1', begin())).status).toBe('ok');
    let meta = await runInDurableObject(s, async (_i: RateLimiter, state: DurableObjectState) => state.storage.get<OpMeta>(OP_META_KEY));
    expect(meta!.count).toBe(105);
    expect(meta!.pruneCursor).toEqual(expect.any(String));
    for (const id of prunable) expect(await opGet(s, id)).not.toBeNull();

    // Second admission: the pass resumes BEHIND the head and removes the three aged ones only.
    expect((await reserve(s, 'a2', begin())).status).toBe('ok');
    meta = await runInDurableObject(s, async (_i: RateLimiter, state: DurableObjectState) => state.storage.get<OpMeta>(OP_META_KEY));
    expect(meta!.count).toBe(103); // 106 − 3
    for (const id of prunable) expect(await opGet(s, id)).toBeNull();
    for (const id of front.slice(0, 5)) expect(await opGet(s, id)).toMatchObject({ status: 'begun' });
    // The index entries of the removed records are gone too, the others intact.
    const keys = await runInDurableObject(s, async (_i: RateLimiter, state: DurableObjectState) =>
      [...(await state.storage.list({ prefix: 'opidx:' })).keys()]);
    expect(keys).toHaveLength(103);
    // End of index reached → the cursor wraps (absent), so the next pass starts over.
    expect(meta!.pruneCursor).toBeUndefined();
  });

  it('/ops lists by time with a cursor and never the token; /op-get answers null for unknown ids', async () => {
    const s = stubFor('list');
    const ids: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const op = begin();
      ids.push(op.id);
      await reserve(s, `n${i}`, op);
    }
    const t1 = Date.now();
    const page1 = await call<{ ops: OpProjection[]; cursor: string | null }>(s, '/ops', { from: t0 - 1000, to: t1 + 1000, limit: 2 });
    expect(page1.ops).toHaveLength(2);
    expect(page1.cursor).not.toBeNull();
    const page2 = await call<{ ops: OpProjection[]; cursor: string | null }>(s, '/ops', { from: t0 - 1000, to: t1 + 1000, limit: 2, cursor: page1.cursor });
    const page3 = await call<{ ops: OpProjection[]; cursor: string | null }>(s, '/ops', { from: t0 - 1000, to: t1 + 1000, limit: 2, cursor: page2.cursor });
    const all = [...page1.ops, ...page2.ops, ...page3.ops];
    expect(all.map(o => o.id).sort()).toEqual([...ids].sort());
    expect(page3.cursor).toBeNull();
    for (const o of all) expect(o).not.toHaveProperty('token');
    // Out of range: empty.
    expect((await call<{ ops: OpProjection[] }>(s, '/ops', { from: t0 - 5000, to: t0 - 2000 })).ops).toEqual([]);
    expect(await call(s, '/ops', { from: 10, to: 5 })).toMatchObject({ ops: [], error: 'bad_range' });
    expect(await opGet(s, crypto.randomUUID())).toBeNull();
  });
});
