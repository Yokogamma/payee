import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULTS, emptyState, planRun, dayRun, randomUuidV8,
  newOperation, recordAnswer, recordThrow, quarantineNote, quarantinedNoteIds, applyResolve,
  reconcileWindow, fetchJournalSlice, parseArgs, parseWhen, makeSigner,
} from './soak-d2.mjs';

// The driver's half of the two books (plan v6.1 §5; tests 14, 15, 16 and the
// reconcile wiring): every send is journaled before it leaves, an unknown
// send quarantines the note for the window, an unknown POST is `unknown`
// (never `error`), the transport sends ONCE with redirect:'error', and
// `resolve` is validated against the last reconcile's records only.

const TX = 'A'.repeat(43);
const TX2 = 'B'.repeat(43);
const VER = 'ver-under-test';
const stubPrice = () => vi.stubGlobal('fetch', async () => new Response('3371193814', { status: 200 }));
afterEach(() => { vi.unstubAllGlobals(); });

const note = (over) => ({ noteId: randomUuidV8(), c: 'c', iv: 'iv', txId: TX, kind: 'paid', createdAt: 0, dedupes: 0, rechecks: 0, ...over });

/** A signer whose answers are scripted per call and ECHO the operationId
 *  (the worker's contract for every admitted answer). */
function scriptedSigner(script) {
  const sent = [];
  let i = 0;
  return {
    sent, pkB64: 'pk',
    upload: async (_origin, n, extra = {}) => {
      sent.push({ noteId: n.noteId, extra });
      const step = script[Math.min(i++, script.length - 1)];
      if (step instanceof Error) throw step;
      const echo = step.echo === false ? null : extra.operationId;
      const body = step.body === undefined ? { txId: TX, status: 'accepted', committed: true, deduped: true, semanticIdempotency: 1 } : step.body;
      const withId = body && typeof body === 'object' && echo ? { ...body, operationId: echo } : body;
      return { status: step.status ?? 200, body: withId, echo };
    },
  };
}

describe('14: the quarantine excludes a note from every pass', () => {
  it('planRun drops quarantined notes from dedupe, recheck and legacy lists', () => {
    const state = { ...emptyState(), notes: [
      note({ noteId: 'q-paid', confirmedAt: 1 }), note({ noteId: 'ok-paid', confirmedAt: 1 }),
      note({ noteId: 'q-legacy', kind: 'legacy' }), note({ noteId: 'ok-legacy', kind: 'legacy' }),
    ] };
    quarantineNote(state, { noteId: 'q-paid', id: 'op1' }, 'send threw');
    quarantineNote(state, { noteId: 'q-legacy', id: 'op2' }, 'arweave_post_unknown');
    const plan = planRun(state, { ...DEFAULTS, paidPerRun: 0 }, Date.now());
    expect(plan.dedupe).toEqual(['ok-paid']);
    expect(plan.recheck).toEqual(['ok-paid']);
    expect(plan.legacyCandidates).toEqual(['ok-legacy']);
    expect([...quarantinedNoteIds(state)].sort()).toEqual(['q-legacy', 'q-paid']);
    // Idempotent per note; nothing lifts it.
    expect(quarantineNote(state, { noteId: 'q-paid', id: 'op3' }, 'again')).toBe(false);
  });

  it.each(['dedupe', 'recheck', 'legacy'])('a lost answer in the %s pass quarantines the note and STOPs the run', async (pass) => {
    stubPrice();
    const n = pass === 'legacy'
      ? note({ noteId: 'lost', kind: 'legacy', createdAt: 0, confirmedAt: 1 })
      : note({ noteId: 'lost', confirmedAt: 1, createdAt: 0 });
    const state = { ...emptyState(), notes: [n] };
    const opts = { ...DEFAULTS, paidPerRun: 0, noRecheck: pass !== 'recheck', noLegacy: pass !== 'legacy', legacyMinAgeMs: 0 };
    const signer = scriptedSigner([new Error('ECONNRESET')]);
    if (pass === 'legacy') {
      // The legacy pass probes the gateway first; make it ready.
      vi.stubGlobal('fetch', async (url) => {
        const u = String(url);
        if (u.includes('/price/')) return new Response('3371193814', { status: 200 });
        if (u.endsWith('/status')) return new Response(JSON.stringify({ number_of_confirmations: 5 }), { status: 200 });
        if (u.includes('/raw/')) return new Response('bytes', { status: 200 });
        return new Response(JSON.stringify({ format: 2, id: TX }), { status: 200 });
      });
    }
    const failures = await dayRun({ origin: 'https://worker.test', signer, state, opts, persist: null });
    expect(signer.sent).toHaveLength(1);
    expect(signer.sent[0].extra.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(failures).toBeGreaterThan(0);
    const op = state.operations[0];
    expect(op).toMatchObject({ noteId: 'lost', pass: pass === 'dedupe' ? 'dedupe' : pass, outcome: 'unknown', cls: 'delivery_unknown' });
    expect(state.quarantine).toEqual([expect.objectContaining({ noteId: 'lost', operationId: op.id, reason: 'send threw' })]);
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/UNKNOWN outcome/);
    // The next plan no longer names the note.
    const plan = planRun(state, { ...DEFAULTS, paidPerRun: 0 }, Date.now());
    expect(plan.dedupe).toEqual([]);
    expect(plan.legacyCandidates).toEqual([]);
  });
});

describe('16: an unknown POST answer is `unknown`, never `error`; sends are journaled before they leave', () => {
  it('502 arweave_post_unknown on a paid publication → attempt unknown, note quarantined, STOP', async () => {
    stubPrice();
    const state = emptyState();
    const signer = scriptedSigner([{ status: 502, body: { error: 'Arweave POST outcome unknown', code: 'arweave_post_unknown', txId: TX } }]);
    const failures = await dayRun({ origin: 'https://worker.test', signer, state, opts: { ...DEFAULTS, paidPerRun: 1, noRecheck: true, noLegacy: true }, persist: null });
    expect(failures).toBeGreaterThan(0);
    const attempt = state.paidAttempts.records[0];
    const op = state.operations[0];
    expect(attempt.id).toBe(op.id); // one id, both books
    expect(attempt.outcome).toBe('unknown');
    expect(op).toMatchObject({ pass: 'publish', outcome: 'answered', cls: 'admitted', code: 'arweave_post_unknown', http: 502, txId: TX });
    expect(state.quarantine[0]).toMatchObject({ noteId: op.noteId, reason: 'arweave_post_unknown' });
    expect(state.notes).toEqual([]); // never recorded as published
  });

  it('a lost begin (503 audit_unconfirmed, no header) on a paid publication is unknown too', async () => {
    stubPrice();
    const state = emptyState();
    const signer = {
      sent: [],
      upload: async (_o, _n, extra) => ({ status: 503, body: { error: 'x', code: 'audit_unconfirmed', operationId: extra.operationId }, echo: null }),
    };
    await dayRun({ origin: 'https://worker.test', signer, state, opts: { ...DEFAULTS, paidPerRun: 1, noRecheck: true, noLegacy: true }, persist: null });
    expect(state.paidAttempts.records[0].outcome).toBe('unknown');
    expect(state.operations[0]).toMatchObject({ cls: 'delivery_unknown', code: 'audit_unconfirmed' });
    expect(state.quarantine).toHaveLength(1);
  });

  it('a KNOWN failure (502 arweave_rejected, echoed) stays `error` and does not quarantine', async () => {
    stubPrice();
    const state = emptyState();
    const signer = scriptedSigner([{ status: 502, body: { error: 'Arweave error: 400', code: 'arweave_rejected' } }]);
    await dayRun({ origin: 'https://worker.test', signer, state, opts: { ...DEFAULTS, paidPerRun: 1, noRecheck: true, noLegacy: true }, persist: null });
    expect(state.paidAttempts.records[0].outcome).toBe('error');
    expect(state.operations[0]).toMatchObject({ cls: 'admitted', code: 'arweave_rejected' });
    expect(state.quarantine ?? []).toEqual([]);
  });

  it('every send of a run has an operation record written BEFORE it left, sharing the id the body carried', async () => {
    stubPrice();
    const state = { ...emptyState(), notes: [note({ noteId: 'd1', confirmedAt: 1 }), note({ noteId: 'd2', confirmedAt: 1 })] };
    const signer = scriptedSigner([{}, {}, {}]);
    const persisted = [];
    await dayRun({
      origin: 'https://worker.test', signer, state, opts: { ...DEFAULTS, paidPerRun: 1, noRecheck: true, noLegacy: true },
      persist: async () => { persisted.push(state.operations.map(o => `${o.id}:${o.outcome}`)); },
    });
    expect(signer.sent).toHaveLength(3);
    expect(state.operations.map(o => o.pass)).toEqual(['publish', 'dedupe', 'dedupe']);
    for (const [i, s] of signer.sent.entries()) {
      expect(s.extra.operationId).toBe(state.operations[i].id);
      // A persist happened while this operation was still pending.
      expect(persisted.some(snap => snap.includes(`${state.operations[i].id}:pending`))).toBe(true);
    }
    expect(state.operations.every(o => o.outcome === 'answered' && o.cls === 'admitted')).toBe(true);
  });

  it('a ledger that cannot persist an operation record STOPs before the dedupe send', async () => {
    stubPrice();
    const state = { ...emptyState(), notes: [note({ noteId: 'd1', confirmedAt: 1 })] };
    const signer = scriptedSigner([{}]);
    const failures = await dayRun({
      origin: 'https://worker.test', signer, state, opts: { ...DEFAULTS, paidPerRun: 0, noRecheck: true, noLegacy: true },
      persist: async () => { throw new Error('disk full'); },
    });
    expect(signer.sent).toEqual([]);
    expect(failures).toBeGreaterThan(0);
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/before a dedupe send/);
  });

  it('the transport sends exactly once, with redirect:error, and returns the echo header', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) throw new Error('socket hang up');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'X-Operation-Id': 'echoed' } });
    });
    const seed = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    const signer = await makeSigner(seed);
    await expect(signer.upload('https://worker.test', { noteId: randomUuidV8(), c: 'c', iv: 'iv' }, { operationId: 'x' })).rejects.toThrow(/hang up/);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(calls[0].init.body).operationId).toBe('x');
    const second = await signer.upload('https://worker.test', { noteId: randomUuidV8(), c: 'c', iv: 'iv' });
    expect(second).toMatchObject({ status: 200, echo: 'echoed' });
    expect(calls).toHaveLength(2);
  });
});

describe('15: resolve is validated against the last reconcile only, never the worker', () => {
  const opId = () => crypto.randomUUID();
  const withReport = (record) => ({ ...emptyState(), reconcile: [{ at: 1, window: { t0: 0, t1: 1 }, records: record ? { [record.id]: record } : {} }] });

  it('refuses without a report, without a record, without postingAt, when paidResult is not unknown, on a txId mismatch, without evidence', () => {
    const id = opId();
    expect(applyResolve(emptyState(), id, { txId: TX, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /no reconcile report/ });
    expect(applyResolve(withReport(null), id, { txId: TX, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /no journal record/ });
    expect(applyResolve(withReport({ id, status: 'begun', paidResult: 'none' }), id, { txId: TX, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /no postingAt/ });
    expect(applyResolve(withReport({ id, status: 'finished', paidResult: 'accepted', postingAt: 5, txId: TX }), id, { txId: TX, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /not unknown/ });
    expect(applyResolve(withReport({ id, status: 'posting', paidResult: 'unknown', postingAt: 5, txId: TX }), id, { txId: TX2, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /not the journaled transaction/ });
    expect(applyResolve(withReport({ id, status: 'posting', paidResult: 'unknown', postingAt: 5, txId: TX }), id, { txId: TX, evidence: '  ' }, 1)).toMatchObject({ ok: false, reason: /evidence/ });
    expect(applyResolve(withReport({ id, status: 'posting', paidResult: 'unknown', postingAt: 5, txId: TX }), 'nope', { txId: TX, evidence: 'e' }, 1)).toMatchObject({ ok: false, reason: /UUIDv4/ });
  });

  it('accepts a matching txId with evidence; writes the ledger only; the record and the quarantine are untouched', () => {
    const id = opId();
    const record = { id, status: 'posting', paidResult: 'unknown', postingAt: 5, txId: TX, decision: 'legacy_dead_redrop', noteId: 'n' };
    const state = withReport(record);
    quarantineNote(state, { noteId: 'n', id }, 'x');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(applyResolve(state, id, { txId: TX, evidence: '/tx/<id> on arweave.net: format 2, 13.09 12:00' }, 99)).toEqual({ ok: true });
    expect(state.resolutions[id]).toEqual({ txId: TX, evidence: '/tx/<id> on arweave.net: format 2, 13.09 12:00', at: 99 });
    expect(state.reconcile[0].records[id]).toEqual(record); // decision and everything else unchanged
    expect(state.quarantine).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('reconcile wiring: slice + point reads + observation + policy', () => {
  const t0 = Date.parse('2026-09-20T00:00:00Z');
  const t1 = t0 + 3_600_000;
  const journal = (records) => async (payload) => {
    if (payload.operationId) return { workerVersionId: VER, releaseSha: 'r', op: records.find(r => r.id === payload.operationId) ?? null };
    const inRange = records.filter(r => r.beganAt >= payload.from && r.beganAt <= payload.to);
    const start = payload.cursor ? Number(payload.cursor) : 0;
    const page = inRange.slice(start, start + 2);
    return { workerVersionId: VER, releaseSha: 'r', ops: page, cursor: start + 2 < inRange.length ? String(start + 2) : null };
  };
  const rec = (over) => ({ id: crypto.randomUUID(), noteId: 'n', workerVersionId: VER, idOrigin: 'client', status: 'finished', paidResult: 'none', checkVerdict: 'exists', checkVerdicts: ['exists'], beganAt: t0 + 1000, finishedAt: t0 + 1500, outcome: 'deduped', httpStatus: 200, txId: TX, attests: ['deduped'], ...over });

  it('pages through the slice, point-reads unknown deliveries, records an observation, withholds without a policy', async () => {
    const seen = rec({}); const seen2 = rec({ beganAt: t0 + 2000 }); const seen3 = rec({ beganAt: t0 + 3000 });
    const lost = rec({ beganAt: t0 + 4000, status: 'begun', checkVerdict: 'ok', outcome: undefined, finishedAt: undefined, txId: undefined, attests: undefined });
    const state = { ...emptyState(), release: { workerVersionId: VER }, operations: [
      { id: seen.id, at: seen.beganAt, noteId: 'n', pass: 'dedupe', outcome: 'answered', cls: 'admitted', http: 200, txId: TX },
      { id: seen2.id, at: seen2.beganAt, noteId: 'n', pass: 'dedupe', outcome: 'answered', cls: 'admitted', http: 200, txId: TX },
      { id: seen3.id, at: seen3.beganAt, noteId: 'n', pass: 'dedupe', outcome: 'answered', cls: 'admitted', http: 200, txId: TX },
      { id: lost.id, at: lost.beganAt, noteId: 'n', pass: 'dedupe', outcome: 'unknown', cls: 'delivery_unknown' },
    ] };
    // The list read hides `lost` (a far-future beganAt would be outside; we
    // simulate by excluding it from the list but serving the point read).
    const fetchOps = async (payload) => (payload.operationId ? journal([seen, seen2, seen3, lost])(payload) : journal([seen, seen2, seen3])(payload));
    const report = await reconcileWindow({ state, fetchOps, ownerPk: 'pk', from: t0, to: t1, policy: null, now: t1 + 10 });
    expect(report.identity).toEqual({ workerVersionId: VER, releaseSha: 'r' });
    expect(Object.keys(report.records).sort()).toEqual([seen.id, seen2.id, seen3.id, lost.id].sort());
    expect(report.classes).toEqual({ matched: 3, unfinished_begun: 1 });
    expect(report.unfinished).toEqual([lost.id]);
    expect(state.reconcileObservations[`${t0}-${t1}`]).toEqual([{ at: t1 + 10, unfinished: [lost.id] }]);
    expect(report.verdict).toBe('withheld');
    expect(report.failures.join(' ')).toMatch(/acceptance policy undefined/);
    expect(state.reconcile).toHaveLength(1);
  });

  it('with a policy but an unsettled wait: withheld; version mismatch: red', async () => {
    const policy = { allowances: { infrastructure: 2, resolvedManually: 1 }, approvedAt: '2026-09-13T00:00:00Z', approvedBy: 'owner' };
    const p = rec({ status: 'posting', paidResult: 'unknown', postingAt: t0 + 1200, decision: 'new', outcome: undefined, finishedAt: undefined });
    const state = { ...emptyState(), release: { workerVersionId: VER }, operations: [
      { id: p.id, at: p.beganAt, noteId: 'n', pass: 'publish', outcome: 'answered', cls: 'admitted', http: 200, txId: TX },
    ] };
    const r1 = await reconcileWindow({ state, fetchOps: journal([p]), ownerPk: 'pk', from: t0, to: t1, policy, now: t1 + 10 });
    expect(r1.verdict).toBe('withheld');
    expect(r1.wait.outcome).toBe('waiting');

    const other = rec({ workerVersionId: 'someone-else' });
    const state2 = { ...emptyState(), release: { workerVersionId: VER }, operations: [
      { id: other.id, at: other.beganAt, noteId: 'n', pass: 'dedupe', outcome: 'answered', cls: 'admitted', http: 200, txId: TX },
    ] };
    const r2 = await reconcileWindow({ state: state2, fetchOps: journal([other]), ownerPk: 'pk', from: t0, to: t1, policy, now: t1 + 10 });
    expect(r2.verdict).toBe('red');
    expect(r2.failures[0]).toMatch(/version_mismatch/);
  });

  it('fetchJournalSlice refuses a version change mid-read', async () => {
    let n = 0;
    const flapping = async () => ({ workerVersionId: n++ === 0 ? 'a' : 'b', ops: [rec({})], cursor: n === 1 ? '2' : null });
    await expect(fetchJournalSlice(flapping, 'pk', 0, 10)).rejects.toThrow(/version changed/);
  });

  it('parseArgs: reconcile window and resolve arguments', () => {
    expect(parseWhen('2026-09-20T00:00:00Z')).toBe(t0);
    expect(parseWhen(String(t0))).toBe(t0);
    expect(parseArgs(['reconcile', '--from', '2026-09-20T00:00:00Z', '--to', String(t1)]).opts).toEqual({ from: t0, to: t1 });
    expect(() => parseArgs(['reconcile', '--from', 'yesterday'])).toThrow(/ISO date/);
    const id = crypto.randomUUID();
    expect(parseArgs(['resolve', id, '--txid', TX, '--evidence', 'seen']).opts).toEqual({ operationId: id, txid: TX, evidence: 'seen' });
  });
});
