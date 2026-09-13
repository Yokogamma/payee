import { describe, it, expect } from 'vitest';
import {
  classifyAnswer, classifyThrow, quarantines, joinBooks, resolutionApplies, processingWait,
  validatePolicy, verdict, checkWindow, compareResults, CRITERIA, RED, WAIT_STABLE_MS, WAIT_CAP_MS, UPLOAD_CODES, UPLOAD_OUTCOMES,
} from './soak-reconcile.mjs';

// Plan «soak D2 operation journal» v6.1 — tests 12, 13, 17, 18, 19 and the
// processing wait (§7.1), all on fixtures: the module is pure.

const ID = () => crypto.randomUUID();
const TX = 'A'.repeat(43);
const TX2 = 'B'.repeat(43);
const VER = 'v-window';

const answer = (status, body, echo = null) => ({ status, body, echo });

describe('§6.1 classifyAnswer, in order (test 12)', () => {
  it('header present: all three ids must agree', () => {
    const id = ID();
    expect(classifyAnswer(answer(200, { txId: TX, operationId: id }, id), id)).toMatchObject({ cls: 'admitted' });
    expect(classifyAnswer(answer(409, { code: 'id_payload_conflict', operationId: id }, id), id)).toMatchObject({ cls: 'admitted', code: 'id_payload_conflict' });
    // header only, body silent → mismatch
    expect(classifyAnswer(answer(200, { txId: TX }, id), id)).toMatchObject({ cls: 'echo_mismatch' });
    // header names another id
    expect(classifyAnswer(answer(200, { txId: TX, operationId: id }, ID()), id)).toMatchObject({ cls: 'echo_mismatch' });
    // header and body agree with each other but not with the request
    const other = ID();
    expect(classifyAnswer(answer(200, { txId: TX, operationId: other }, other), id)).toMatchObject({ cls: 'echo_mismatch' });
  });

  it('audit_unconfirmed without a header: delivery_unknown iff the body names the request', () => {
    const id = ID();
    expect(classifyAnswer(answer(503, { error: 'x', code: 'audit_unconfirmed', operationId: id }), id)).toMatchObject({ cls: 'delivery_unknown', code: 'audit_unconfirmed' });
    expect(classifyAnswer(answer(503, { error: 'x', code: 'audit_unconfirmed', operationId: ID() }), id)).toMatchObject({ cls: 'echo_mismatch' });
    // with a header it is an admitted answer (rule 1 wins)
    expect(classifyAnswer(answer(503, { error: 'x', code: 'audit_unconfirmed', operationId: id }, id), id)).toMatchObject({ cls: 'admitted' });
  });

  it('an id in the body without a header is an echo mismatch', () => {
    const id = ID();
    expect(classifyAnswer(answer(400, { error: 'x', code: 'validation_failed', operationId: id }), id)).toMatchObject({ cls: 'echo_mismatch' });
  });

  it('a listed pre-admission pair in the listed shape is refused; the wrong status is not', () => {
    const id = ID();
    for (const { code, status } of UPLOAD_CODES.preAdmission) {
      if (code === 'audit_unconfirmed') continue;
      expect(classifyAnswer(answer(status, { error: 'text', code }), id)).toMatchObject({ cls: 'refused', code });
    }
    expect(classifyAnswer(answer(500, { error: 'text', code: 'validation_failed' }), id)).toMatchObject({ cls: 'delivery_unknown' });
    expect(classifyAnswer(answer(400, { code: 'validation_failed' }), id)).toMatchObject({ cls: 'delivery_unknown' }); // no `error` field: not the listed shape
  });

  it('an admitted-shaped answer without the echo is a contract violation', () => {
    const id = ID();
    expect(classifyAnswer(answer(200, { txId: TX, status: 'accepted' }), id)).toMatchObject({ cls: 'contract_violation' });
    expect(classifyAnswer(answer(409, { code: 'id_payload_conflict', txId: TX }), id)).toMatchObject({ cls: 'contract_violation' });
    expect(classifyAnswer(answer(502, { error: 'x', code: 'arweave_post_unknown', txId: TX }), id)).toMatchObject({ cls: 'contract_violation' });
  });

  it('everything else is an unknown delivery: HTML, empty, non-JSON, unknown code, infra 5xx, a thrown send', () => {
    const id = ID();
    expect(classifyAnswer(answer(502, '<html>bad gateway</html>'), id)).toMatchObject({ cls: 'delivery_unknown' });
    expect(classifyAnswer(answer(200, ''), id)).toMatchObject({ cls: 'delivery_unknown' });
    expect(classifyAnswer(answer(503, { error: 'x', code: 'no_such_code' }), id)).toMatchObject({ cls: 'delivery_unknown' });
    expect(classifyAnswer(answer(200, [1, 2]), id)).toMatchObject({ cls: 'delivery_unknown' });
    expect(classifyThrow(new Error('ECONNRESET'))).toMatchObject({ cls: 'delivery_unknown' });
  });

  it('quarantine: unknown outcome, unknown delivery, or an unknown POST', () => {
    expect(quarantines({ outcome: 'unknown' })).toBe(true);
    expect(quarantines({ outcome: 'answered', cls: 'delivery_unknown' })).toBe(true);
    expect(quarantines({ outcome: 'answered', cls: 'admitted', code: 'arweave_post_unknown' })).toBe(true);
    expect(quarantines({ outcome: 'answered', cls: 'admitted', code: 'arweave_rejected' })).toBe(false);
    expect(quarantines({ outcome: 'answered', cls: 'refused', code: 'validation_failed' })).toBe(false);
  });
});

// ── fixtures for the join ─────────────────────────────────────────────

const t0 = Date.parse('2026-09-20T00:00:00Z');
const t1 = t0 + 7 * 24 * 3_600_000;
let clock = t0 + 1000;
const tick = () => (clock += 60_000);

function server(over = {}) {
  const at = over.beganAt ?? tick();
  return {
    id: over.id ?? ID(), noteId: over.noteId ?? ID(), mode: 'plain', declaredVersion: '3', releaseSha: 'r', workerVersionId: VER,
    idOrigin: 'client', status: 'finished', paidResult: 'none', checkVerdict: 'exists', checkVerdicts: ['exists'],
    beganAt: at, finishedAt: at + 500, outcome: 'deduped', httpStatus: 200, code: undefined, txId: TX, attests: ['deduped'], ...over,
  };
}
function driver(s, over = {}) {
  const dedupe = s.outcome === 'deduped' || s.outcome === 'recovery_reconciled';
  return {
    id: s.id, at: s.beganAt, noteId: s.noteId, pass: 'dedupe', outcome: 'answered', cls: 'admitted',
    http: s.httpStatus, code: s.code, txId: s.txId, ...(s.httpStatus === 200 ? { deduped: dedupe, committed: true } : {}), ...over,
  };
}

describe('§6.2 joinBooks — one row per case (test 13)', () => {
  it('matched, resolved_by_server, refused_before_admission', () => {
    const s1 = server();
    const s2 = server();
    const rows = joinBooks({
      driverOps: [driver(s1), driver(s2, { cls: 'delivery_unknown', outcome: 'unknown', http: undefined }), { id: ID(), at: tick(), noteId: ID(), pass: 'publish', outcome: 'answered', cls: 'refused', code: 'validation_failed', http: 400 }],
      serverOps: [s1, s2], windowVersionId: VER,
    }).rows;
    expect(rows.map(r => r.cls)).toEqual(['matched', 'resolved_by_server', 'refused_before_admission']);
    expect(rows.every(r => !r.red)).toBe(true);
  });

  it('operation_id_reused in the window is red; a refused send WITH a record is a contract violation', () => {
    const s = server();
    const rows = joinBooks({
      driverOps: [
        { id: s.id, at: s.beganAt, noteId: s.noteId, pass: 'dedupe', outcome: 'answered', cls: 'refused', code: 'operation_id_reused', http: 409 },
        { id: ID(), at: tick(), noteId: ID(), pass: 'dedupe', outcome: 'answered', cls: 'refused', code: 'validation_failed', http: 400 },
      ],
      serverOps: [s, server({ id: undefined })].map((x, i) => (i === 1 ? { ...x, id: undefined } : x)).filter(x => x.id),
      windowVersionId: VER,
    }).rows;
    expect(rows[0]).toMatchObject({ cls: 'operation_id_reused', red: true });
  });

  it('answer_without_record, unresolved_no_record, foreign_operation, echo/contract violations', () => {
    const idA = ID();
    const idB = ID();
    const foreign = server();
    const rows = joinBooks({
      driverOps: [
        { id: idA, at: tick(), noteId: ID(), pass: 'dedupe', outcome: 'answered', cls: 'admitted', http: 200 },
        { id: idB, at: tick(), noteId: ID(), pass: 'dedupe', outcome: 'unknown', cls: 'delivery_unknown' },
        { id: ID(), at: tick(), noteId: ID(), pass: 'dedupe', outcome: 'answered', cls: 'echo_mismatch', http: 200 },
        { id: ID(), at: tick(), noteId: ID(), pass: 'dedupe', outcome: 'answered', cls: 'contract_violation', http: 200 },
      ],
      serverOps: [foreign], windowVersionId: VER,
    }).rows;
    expect(rows.map(r => r.cls)).toEqual(['answer_without_record', 'unresolved_no_record', 'echo_mismatch', 'contract_violation', 'foreign_operation']);
    expect(rows.every(r => r.red)).toBe(true);
  });

  it('unfinished begun (critical or not), unfinished posting, unresolved paid, unidentified client', () => {
    const b1 = server({ status: 'begun', checkVerdict: 'ok', checkVerdicts: ['ok'], outcome: undefined, finishedAt: undefined, txId: undefined, attests: undefined });
    const b2 = server({ status: 'begun', checkVerdict: 'id_payload_conflict', checkVerdicts: ['id_payload_conflict'], outcome: undefined, finishedAt: undefined, txId: undefined, attests: undefined });
    const p = server({ status: 'posting', paidResult: 'unknown', postingAt: tick(), decision: 'new', outcome: undefined, finishedAt: undefined });
    const u = server({ status: 'finished', paidResult: 'unknown', postingAt: tick(), decision: 'new', outcome: 'post_unknown', httpStatus: 502, code: 'arweave_post_unknown' });
    const srv = server({ idOrigin: 'server' });
    const rows = joinBooks({
      driverOps: [driver(b1, { cls: 'delivery_unknown', outcome: 'unknown' }), driver(b2, { cls: 'delivery_unknown', outcome: 'unknown' }), driver(p), driver(u), driver(srv)],
      serverOps: [b1, b2, p, u, srv], windowVersionId: VER,
    }).rows;
    expect(rows.map(r => r.cls)).toEqual(['unfinished_begun', 'unfinished_begun_critical', 'unfinished_posting', 'unresolved_paid', 'unidentified_client']);
    expect(rows.every(r => r.red)).toBe(true);
  });

  it('post_unknown on BOTH books is still red (unresolved_paid), even though they agree', () => {
    const u = server({ status: 'finished', paidResult: 'unknown', postingAt: tick(), decision: 'new', outcome: 'post_unknown', httpStatus: 502, code: 'arweave_post_unknown' });
    const rows = joinBooks({ driverOps: [driver(u)], serverOps: [u], windowVersionId: VER }).rows;
    expect(rows[0]).toMatchObject({ cls: 'unresolved_paid', red: true });
  });

  it('mismatch: the two books disagree on status, code or txId', () => {
    const s = server();
    const rows = joinBooks({
      driverOps: [driver(s, { http: 409, code: 'id_payload_conflict' }), driver(server({ id: s.id }), { txId: TX2 })].map((d, i) => (i === 1 ? { ...d, id: 'x' } : d)),
      serverOps: [s], windowVersionId: VER,
    }).rows;
    expect(rows[0]).toMatchObject({ cls: 'mismatch', red: true });
  });

  it('matched requires the SAME note, a txId wherever the answer carries one, and the dedupe flag (P1-3)', () => {
    const s = server(); // deduped, 200, TX
    expect(compareResults(driver(s), s)).toEqual([]);
    expect(compareResults(driver(s, { noteId: 'other-note' }), s)).toEqual([expect.stringMatching(/noteId/)]);
    expect(compareResults(driver(s, { txId: undefined }), s)).toEqual([expect.stringMatching(/no txId/)]);
    expect(compareResults(driver(s, { deduped: false }), s)).toEqual([expect.stringMatching(/deduped:true/)]);
    expect(compareResults(driver(s, { http: undefined }), s)).toEqual([expect.stringMatching(/no HTTP status/)]);
    const acc = server({ outcome: 'accepted', paidResult: 'accepted', decision: 'new', postingAt: tick(), attests: [] });
    expect(compareResults(driver(acc), acc)).toEqual([]);
    expect(compareResults(driver(acc, { deduped: true }), acc)).toEqual([expect.stringMatching(/accepted \(new\)/)]);
    // The reviewer's reproduction: another note, no txId → red, not matched.
    const rows = joinBooks({ driverOps: [driver(acc, { noteId: 'x', txId: undefined })], serverOps: [acc], windowVersionId: VER }).rows;
    expect(rows[0]).toMatchObject({ cls: 'mismatch', red: true });
    // A 503 answer carries no txId on either side: still matched.
    const deferred = server({ outcome: 'deferred', httpStatus: 503, code: 'recheck_deferred', txId: undefined, attests: [] });
    expect(compareResults(driver(deferred, { txId: undefined }), deferred)).toEqual([]);
    // The worker's REAL 502 arweave_rejected (PR-A, op-journal-e2e test 7):
    // {error, code, operationId}, no txId — while the journal keeps the
    // rejected transaction. Matched, not mismatch.
    const rejected = server({ outcome: 'arweave_error', paidResult: 'rejected', httpStatus: 502, code: 'arweave_rejected', postingAt: tick(), decision: 'new', attests: [] });
    expect(compareResults(driver(rejected, { txId: undefined }), rejected)).toEqual([]);
    // …whereas arweave_post_unknown DOES answer the txId, so it is required.
    const unknown = server({ outcome: 'post_unknown', paidResult: 'unknown', httpStatus: 502, code: 'arweave_post_unknown', postingAt: tick(), decision: 'new', attests: [] });
    expect(compareResults(driver(unknown, { txId: undefined }), unknown)).toEqual([expect.stringMatching(/no txId for post_unknown/)]);
    expect(compareResults(driver(unknown), unknown)).toEqual([]);
  });

  it('aborted_before_post is an infrastructure incident, not red', () => {
    const a = server({ outcome: 'audit_aborted', httpStatus: 503, code: 'audit_unconfirmed', postingAt: tick(), decision: 'new' });
    const rows = joinBooks({ driverOps: [driver(a)], serverOps: [a], windowVersionId: VER }).rows;
    expect(rows[0]).toMatchObject({ cls: 'aborted_before_post', red: false });
  });

  it('version_mismatch short-circuits the whole join', () => {
    const s = server({ workerVersionId: 'other' });
    const out = joinBooks({ driverOps: [driver(s)], serverOps: [s], windowVersionId: VER });
    expect(out.rows).toEqual([]);
    expect(out.versionMismatch).toMatchObject({ operationId: s.id, seen: 'other', expected: VER });
  });

  it('a resolution applies only to a posting/unknown record with an intent to POST and the SAME txId', () => {
    const p = server({ status: 'posting', paidResult: 'unknown', postingAt: tick(), decision: 'new', outcome: undefined });
    expect(resolutionApplies({ txId: TX, evidence: 'seen on arweave.net /tx' }, p)).toBe(true);
    expect(resolutionApplies({ txId: TX2, evidence: 'x' }, p)).toBe(false);
    expect(resolutionApplies({ txId: TX, evidence: '' }, p)).toBe(false);
    expect(resolutionApplies({ txId: TX, evidence: 'x' }, { ...p, postingAt: undefined })).toBe(false);
    expect(resolutionApplies({ txId: TX, evidence: 'x' }, { ...p, paidResult: 'accepted' })).toBe(false);
    expect(resolutionApplies({ txId: TX, evidence: 'x' }, server())).toBe(false); // a finished dedupe: nothing to resolve
  });
});

describe('§7.1 processingWait', () => {
  const T1 = t1;
  it('settled_empty needs an empty latest set AND terminal driver records', () => {
    expect(processingWait({ t1: T1, observations: [{ at: T1 + 1, unfinished: [] }], driverTerminal: true, now: T1 + 2 })).toMatchObject({ outcome: 'settled_empty' });
    expect(processingWait({ t1: T1, observations: [{ at: T1 + 1, unfinished: [] }], driverTerminal: false, now: T1 + 2 })).toMatchObject({ outcome: 'waiting' });
    expect(processingWait({ t1: T1, observations: [], driverTerminal: true, now: T1 + 2 })).toMatchObject({ outcome: 'waiting' });
    expect(processingWait({ t1: T1, observations: [{ at: T1 - 5, unfinished: [] }], driverTerminal: true, now: T1 + 2 })).toMatchObject({ outcome: 'waiting' });
  });

  it('settled_with_unfinished after the same set held for 60 min; capped after 2 h of change', () => {
    const obs = [{ at: T1 + 1, unfinished: ['a'] }, { at: T1 + 30 * 60_000, unfinished: ['a'] }, { at: T1 + WAIT_STABLE_MS + 1, unfinished: ['a'] }];
    expect(processingWait({ t1: T1, observations: obs, driverTerminal: true, now: T1 + WAIT_STABLE_MS + 2 })).toMatchObject({ outcome: 'settled_with_unfinished', unfinished: ['a'] });
    const changing = [{ at: T1 + 1, unfinished: ['a'] }, { at: T1 + WAIT_STABLE_MS + 1, unfinished: ['a', 'b'] }];
    expect(processingWait({ t1: T1, observations: changing, driverTerminal: true, now: T1 + WAIT_STABLE_MS + 2 })).toMatchObject({ outcome: 'waiting' });
    const late = [...changing, { at: T1 + WAIT_CAP_MS + 1, unfinished: ['a', 'b', 'c'] }];
    expect(processingWait({ t1: T1, observations: late, driverTerminal: true, now: T1 + WAIT_CAP_MS + 2 })).toMatchObject({ outcome: 'capped' });
  });
});

describe('§11 validatePolicy (test 19)', () => {
  it('no defaults: a missing file or any missing field withholds the verdict', () => {
    expect(validatePolicy(null)).toMatchObject({ ok: false, missing: ['policy file'] });
    expect(validatePolicy({})).toMatchObject({ ok: false });
    expect(validatePolicy({ allowances: { infrastructure: 2 }, approvedAt: '2026-09-13', approvedBy: 'owner' }).missing).toEqual(['allowances.resolvedManually']);
    expect(validatePolicy({ allowances: { infrastructure: 2, resolvedManually: 1 }, approvedBy: 'owner' }).missing).toEqual(['approvedAt']);
    expect(validatePolicy({ allowances: { infrastructure: 2, resolvedManually: 1 }, approvedAt: '2026-09-13T00:00:00Z', approvedBy: 'owner' })).toEqual({ ok: true, missing: [] });
    expect(validatePolicy({ allowances: { infrastructure: -1, resolvedManually: 1 }, approvedAt: '2026-09-13', approvedBy: 'o' }).ok).toBe(false);
  });
});

// ── a green window, then each way it turns red (test 18) ─────────────

function greenFixture() {
  const rows = [];
  const push = (s, dOver = {}) => rows.push({ s, d: driver(s, dOver) });
  // 20 paid publications over 4 days, all accepted.
  for (let i = 0; i < 20; i++) {
    const at = t0 + (i % 4) * 24 * 3_600_000 + i * 60_000 + 1000;
    push(server({ beganAt: at, finishedAt: at + 900, outcome: 'accepted', paidResult: 'accepted', checkVerdict: 'ok', checkVerdicts: ['ok'], attests: [], decision: 'new', postingAt: at + 300 }), { pass: 'publish' });
  }
  // 24 dedupes, 3 legacy backfills (distinct notes, 2 decisions each) → 30
  // semantic_idempotency decisions, spread over the days.
  for (let i = 0; i < 24; i++) {
    const at = t0 + (i % 4) * 24 * 3_600_000 + 5 * 3_600_000 + i * 60_000;
    push(server({ beganAt: at, finishedAt: at + 200 }));
  }
  for (let i = 0; i < 3; i++) {
    const at = t0 + (i + 1) * 24 * 3_600_000 + 6 * 3_600_000;
    push(server({ beganAt: at, finishedAt: at + 900, checkVerdict: 'exists', checkVerdicts: ['legacy', 'exists'], attests: ['legacy_backfilled', 'deduped'] }), { pass: 'legacy' });
  }
  return rows;
}
const policy = { allowances: { infrastructure: 2, resolvedManually: 1 }, approvedAt: '2026-09-13T00:00:00Z', approvedBy: 'owner' };
const judge = (rows, over = {}) => verdict({
  rows: joinBooks({ driverOps: rows.map(r => r.d), serverOps: rows.map(r => r.s), windowVersionId: VER, resolutions: over.resolutions }).rows,
  wait: over.wait ?? { outcome: 'settled_empty', unfinished: [] },
  policy: over.policy ?? policy,
  window: { t0, t1 },
  resolutions: over.resolutions ?? {},
  now: t1 + 1000,
});

describe('§7.3 verdict (tests 17, 18)', () => {
  it('a window that meets every criterion is green', () => {
    const v = judge(greenFixture());
    expect(v.failures).toEqual([]);
    expect(v.green).toBe(true);
    expect(v.figures).toMatchObject({ paid: 20, accepted: 20, deduped: 27, legacyBackfilled: 3, decisions: 30 });
  });

  it('a strictly-zero outcome anywhere in the journal turns it red', () => {
    const rows = greenFixture();
    const at = t0 + 3 * 24 * 3_600_000;
    rows.push({ s: server({ beganAt: at, finishedAt: at + 1, outcome: 'conflict', httpStatus: 409, code: 'id_payload_conflict', checkVerdict: 'id_payload_conflict', attests: ['conflict'] }), d: null });
    rows[rows.length - 1].d = driver(rows[rows.length - 1].s);
    const v = judge(rows);
    expect(v.green).toBe(false);
    expect(v.failures.join('\n')).toMatch(/strictly zero violated: conflict = 1/);
  });

  it('allowances: two resolved_manually against an allowance of one → red; three infra incidents against two → red', () => {
    const rows = greenFixture();
    const resolutions = {};
    for (let i = 0; i < 2; i++) {
      const at = t0 + 24 * 3_600_000 + i * 1000;
      const s = server({ beganAt: at, finishedAt: at + 5, status: 'finished', paidResult: 'unknown', postingAt: at + 2, decision: 'new', outcome: 'post_unknown', httpStatus: 502, code: 'arweave_post_unknown', txId: i ? TX2 : TX });
      rows.push({ s, d: driver(s) });
      resolutions[s.id] = { txId: s.txId, evidence: 'found on the pool', at };
    }
    const v = judge(rows, { resolutions });
    expect(v.green).toBe(false);
    expect(v.failures.join('\n')).toMatch(/resolved_manually 2 > allowance 1/);
    expect(v.failures.join('\n')).not.toMatch(/unresolved_paid/);

    const rows2 = greenFixture();
    for (let i = 0; i < 3; i++) {
      const at = t0 + 24 * 3_600_000 + i * 1000;
      const s = server({ beganAt: at, finishedAt: at + 5, outcome: 'gateway_unavailable_pre_post', httpStatus: 502, code: 'arweave_gateway_unavailable', attests: [] });
      rows2.push({ s, d: driver(s) });
    }
    const v2 = judge(rows2);
    expect(v2.failures.join('\n')).toMatch(/infrastructure incidents 3 > allowance 2/);
  });

  it('success rate below 95 % and missing volume are red, each named', () => {
    const rows = greenFixture();
    for (let i = 0; i < 2; i++) {
      const at = t0 + 2 * 24 * 3_600_000 + i * 1000;
      const s = server({ beganAt: at, finishedAt: at + 5, outcome: 'arweave_error', paidResult: 'rejected', httpStatus: 502, code: 'arweave_rejected', decision: 'new', postingAt: at + 2, attests: [] });
      rows.push({ s, d: driver(s) });
    }
    const v = judge(rows);
    expect(v.failures.join('\n')).toMatch(/paid success rate 90\.9 % < 95 %/);

    const thin = greenFixture().slice(0, 10);
    const v2 = judge(thin);
    expect(v2.failures.join('\n')).toMatch(/paid outcomes 10 < 20/);
    expect(v2.failures.join('\n')).toMatch(/deduped 0 < 10/);
    expect(v2.failures.join('\n')).toMatch(/legacy_backfilled \(distinct\) 0 < 3/);
  });

  it('17: posting → red; resolve → resolved_manually and green; capped wait stays red despite the resolve', () => {
    const rows = greenFixture();
    const at = t0 + 24 * 3_600_000;
    const p = server({ beganAt: at, status: 'posting', paidResult: 'unknown', postingAt: at + 2, decision: 'new', outcome: undefined, finishedAt: undefined, txId: TX });
    rows.push({ s: p, d: driver(p, { http: 200 }) });
    const wait = { outcome: 'settled_with_unfinished', unfinished: [p.id] };
    const before = judge(rows, { wait });
    expect(before.green).toBe(false);
    expect(before.failures.join('\n')).toMatch(/unfinished_posting/);

    const resolutions = { [p.id]: { txId: TX, evidence: 'GET /tx/<id> on arweave.net answered format 2 at 12:00', at: t1 } };
    const after = judge(rows, { wait, resolutions });
    expect(after.failures).toEqual([]);
    expect(after.green).toBe(true);
    // The unfinished list the wait reports is unchanged: the journal was not touched.
    expect(wait.unfinished).toEqual([p.id]);

    const capped = judge(rows, { wait: { outcome: 'capped', unfinished: [p.id] }, resolutions });
    expect(capped.green).toBe(false);
    expect(capped.failures.join('\n')).toMatch(/capped/);
  });

  it('P1-2: a 72-hour interval that meets every VOLUME criterion is not a verdict', () => {
    const rows = greenFixture(); // its records lie within the first 4 days
    const short = verdict({
      rows: joinBooks({ driverOps: rows.map(r => r.d), serverOps: rows.map(r => r.s), windowVersionId: VER }).rows,
      wait: { outcome: 'settled_empty', unfinished: [] }, policy, window: { t0, t1: t0 + 72 * 3_600_000 }, now: t1 + 1000,
    });
    expect(short.green).toBe(false);
    expect(short.failures.join('\n')).toMatch(/window 72\.0 h is shorter than 168 h/);
    const notOver = verdict({
      rows: joinBooks({ driverOps: rows.map(r => r.d), serverOps: rows.map(r => r.s), windowVersionId: VER }).rows,
      wait: { outcome: 'settled_empty', unfinished: [] }, policy, window: { t0, t1 }, now: t1 - 1,
    });
    expect(notOver.failures.join('\n')).toMatch(/has not ended/);

    expect(checkWindow({ from: t0, to: t1, ledgerStart: t0, now: t1 + 1 })).toEqual({ ok: true, problems: [] });
    expect(checkWindow({ from: t0, to: t0 + 72 * 3_600_000, ledgerStart: t0, now: t1 }).problems).toEqual([expect.stringMatching(/72\.0 h/)]); // ended (to < now), only too short
    expect(checkWindow({ from: t0 + 1, to: t1 + 1, ledgerStart: t0, now: t1 + 2 }).problems).toEqual([expect.stringMatching(/not the ledger's window start/)]);
    expect(checkWindow({ from: t0, to: t1, ledgerStart: undefined, now: t1 + 1 }).problems).toEqual([expect.stringMatching(/no window start/)]);
    expect(checkWindow({ from: t0, to: t1, ledgerStart: t0, now: t1 - 1 }).problems).toEqual([expect.stringMatching(/not ended/)]);
  });

  it('P1-5: the paid denominator is the upload_outcome total — anchor/price failures count, aborts do not', () => {
    expect([...UPLOAD_OUTCOMES].sort()).toEqual(['accepted', 'arweave_error', 'arweave_throw', 'gateway_unavailable_pre_post', 'post_unknown']);
    const rows = greenFixture();
    for (let i = 0; i < 2; i++) {
      const at = t0 + 2 * 24 * 3_600_000 + i * 1000;
      const s = server({ beganAt: at, finishedAt: at + 5, outcome: 'gateway_unavailable_pre_post', httpStatus: 502, code: 'arweave_gateway_unavailable', txId: undefined, attests: [] });
      rows.push({ s, d: driver(s) });
    }
    const v = judge(rows, { policy: { ...policy, allowances: { infrastructure: 5, resolvedManually: 1 } } });
    expect(v.figures).toMatchObject({ paid: 22, accepted: 20, infra: 2 });
    expect(v.failures.join('\n')).toMatch(/paid success rate 90\.9 % < 95 %/);
    // An abort is not an upload_outcome: neither in the denominator nor in the numerator.
    const rows2 = greenFixture();
    const at = t0 + 2 * 24 * 3_600_000;
    const a = server({ beganAt: at, finishedAt: at + 5, outcome: 'audit_aborted', httpStatus: 503, code: 'audit_unconfirmed', postingAt: at + 2, decision: 'new', attests: [] });
    rows2.push({ s: a, d: driver(a) });
    const v2 = judge(rows2);
    expect(v2.figures).toMatchObject({ paid: 20, accepted: 20, infra: 1 }); // P2: one abort = ONE incident
    expect(v2.failures).toEqual([]);
  });

  it('a resolved `posting` is ONE publication in both numerator and denominator: 19 finished + 1 resolved = 20', () => {
    const rows = greenFixture();
    // Drop one accepted publication, add a posting the operator confirmed.
    const idx = rows.findIndex(r => r.s.outcome === 'accepted');
    const dropped = rows.splice(idx, 1)[0];
    const p = server({ beganAt: dropped.s.beganAt, status: 'posting', paidResult: 'unknown', postingAt: dropped.s.beganAt + 2, decision: 'new', outcome: undefined, finishedAt: undefined, txId: TX2 });
    rows.push({ s: p, d: driver(p, { http: 200 }) });
    const resolutions = { [p.id]: { txId: TX2, evidence: '/tx on the pool, format 2', at: t1 } };
    const v = judge(rows, { wait: { outcome: 'settled_with_unfinished', unfinished: [p.id] }, resolutions });
    expect(v.figures).toMatchObject({ paid: 20, accepted: 20, resolved: 1 });
    expect(v.failures).toEqual([]);
    // A resolved FINISHED post_unknown is not counted twice either.
    const rows2 = greenFixture();
    const u = server({ beganAt: t0 + 24 * 3_600_000, finishedAt: t0 + 24 * 3_600_000 + 5, status: 'finished', paidResult: 'unknown', postingAt: t0 + 24 * 3_600_000 + 2, decision: 'new', outcome: 'post_unknown', httpStatus: 502, code: 'arweave_post_unknown', txId: TX2, attests: [] });
    rows2.push({ s: u, d: driver(u) });
    const v2 = judge(rows2, { resolutions: { [u.id]: { txId: TX2, evidence: 'seen', at: t1 } } });
    expect(v2.figures).toMatchObject({ paid: 21, accepted: 21, resolved: 1 });
  });

  it('a resolution without evidence is itself a failure; RED lists what a red class is', () => {
    const rows = greenFixture();
    const v = judge(rows, { resolutions: { [ID()]: { txId: TX, evidence: '' } } });
    expect(v.failures.join('\n')).toMatch(/without evidence/);
    expect(RED.has('matched')).toBe(false);
    expect(CRITERIA.paidOutcomes).toBe(20);
  });
});
