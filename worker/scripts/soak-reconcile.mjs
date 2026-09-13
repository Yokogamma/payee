/**
 * Reconciliation of the two books (plan «soak D2 operation journal» v6.1,
 * §6–§7, §11): the driver's own ledger of every request it sent, and the
 * worker's operation journal read through POST /admin/ops. PURE — no network,
 * no filesystem — so every rule below is unit-tested on fixtures and the
 * driver (soak-d2.mjs) only wires it to IO.
 *
 * Three facts the verdict never conflates:
 *   - the publication is confirmed  — only by the signed txId on the pool,
 *     recorded by an operator's `resolve` with evidence;
 *   - the handler's decision is confirmed — a `finished` journal record, or
 *     the DO's `checkVerdict` written in the begin transaction;
 *   - nothing was sent — established by NO automatic rule: an unknown delivery
 *     with no record stays red (§8: the admission-closing protocol does not
 *     exist yet).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The closed lists the worker answers with — the SAME file the worker
// compiles in (worker/src/upload-codes.json), so the two halves cannot drift.
const codesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'upload-codes.json');
export const UPLOAD_CODES = JSON.parse(readFileSync(codesPath, 'utf8'));
const PRE = new Map(UPLOAD_CODES.preAdmission.map(c => [c.code, c.status]));
const POST = new Map(UPLOAD_CODES.postAdmission.map(c => [c.code, c.status]));

export const OP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

// ── §6.1 Classification of one answer, in order ───────────────────────

/**
 * `answer` is what the driver's transport returned: `{status, body, echo}`
 * where `echo` is the X-Operation-Id header (or null) and `body` is the parsed
 * JSON (an object) or the raw text (anything else). `requestId` is the id the
 * driver put into the signed body. The first matching rule wins.
 */
export function classifyAnswer(answer, requestId) {
  const H = answer.echo ?? null;
  const obj = answer.body !== null && typeof answer.body === 'object' && !Array.isArray(answer.body) ? answer.body : null;
  const B = obj && typeof obj.operationId === 'string' ? obj.operationId : null;
  const code = obj && typeof obj.code === 'string' ? obj.code : null;

  // 1. A header is the echo of admission: all three ids must agree.
  if (H !== null) {
    return H === B && H === requestId
      ? { cls: 'admitted', code }
      : { cls: 'echo_mismatch', code, detail: `header ${H} body ${B} request ${requestId}` };
  }
  // 2. The one refusal that carries the id WITHOUT admitting: a lost begin.
  if (code === 'audit_unconfirmed' && answer.status === 503) {
    return B === requestId
      ? { cls: 'delivery_unknown', code, detail: 'audit_unconfirmed: the journal may hold a begun record' }
      : { cls: 'echo_mismatch', code, detail: `audit_unconfirmed names ${B}, request was ${requestId}` };
  }
  // 3. An id in the body without a header is not an echo the contract knows.
  if (B !== null) return { cls: 'echo_mismatch', code, detail: `body carries ${B} without a header` };
  // 4. A listed pre-admission refusal, in the listed shape.
  if (obj && code !== null && typeof obj.error === 'string' && PRE.get(code) === answer.status) {
    return { cls: 'refused', code };
  }
  // 5. Something shaped like an ADMITTED decision, without the echo: a contract violation.
  const looksAdmitted = (answer.status === 200 && obj && typeof obj.txId === 'string')
    || (code !== null && POST.has(code) && !PRE.has(code))
    || code === 'id_payload_conflict';
  if (looksAdmitted) return { cls: 'contract_violation', code, detail: 'an admitted-shaped answer without the echo' };
  // 6. Everything else: HTML, empty, non-JSON, unknown code, infra 5xx.
  return { cls: 'delivery_unknown', code, detail: `unclassifiable answer HTTP ${answer.status}` };
}

/** What a thrown send becomes: nothing arrived, so nothing can be classified. */
export function classifyThrow(error) {
  return { cls: 'delivery_unknown', code: null, detail: `send failed: ${error?.message ?? error}` };
}

/** Sends that put the note into quarantine until the window ends (§5). */
export function quarantines(op) {
  if (op.outcome === 'unknown') return true;
  if (op.cls === 'delivery_unknown') return true;
  if (op.code === 'arweave_post_unknown') return true;
  return false;
}

// ── §6.2 Join ─────────────────────────────────────────────────────────

const CRITICAL = new Set(['conflict', 'redrop_conflict', 'legacy_not_ours', 'recovery_conflict']);
export const RED = new Set([
  'echo_mismatch', 'contract_violation', 'answer_without_record', 'unresolved_no_record', 'foreign_operation',
  'mismatch', 'unfinished_begun', 'unfinished_begun_critical', 'unfinished_posting', 'unresolved_paid',
  'unidentified_client', 'version_mismatch', 'operation_id_reused',
]);

/**
 * A resolution the operator recorded (soak-d2.mjs resolve): it confirms the
 * publication of ONE journaled txId and nothing else. Valid only against a
 * record that carries an intent to POST (`postingAt`) and an unknown paid
 * result, and only when the txId named matches the journaled one.
 */
export function resolutionApplies(resolution, server) {
  return !!resolution && !!server
    && typeof server.postingAt === 'number'
    && server.paidResult === 'unknown'
    && typeof resolution.txId === 'string' && resolution.txId === server.txId
    && typeof resolution.evidence === 'string' && resolution.evidence.trim().length > 0;
}

/**
 * Join both books on operationId. `driverOps` are the driver's records for
 * the window, `serverOps` the journal slice (plus point reads), `resolutions`
 * keyed by operationId. Returns rows with a class per §6.2, a `red` flag, and
 * the `versionMismatch` short-circuit.
 */
export function joinBooks({ driverOps, serverOps, resolutions = {}, windowVersionId, now = Date.now() }) {
  const byId = new Map(serverOps.map(s => [s.id, s]));
  const rows = [];
  const seen = new Set();

  for (const s of serverOps) {
    if (windowVersionId && s.workerVersionId !== windowVersionId) {
      return { rows: [], versionMismatch: { operationId: s.id, seen: s.workerVersionId, expected: windowVersionId } };
    }
  }

  for (const d of driverOps) {
    seen.add(d.id);
    const s = byId.get(d.id) ?? null;
    const res = resolutions[d.id] ?? null;
    rows.push(classifyPair(d, s, res, now));
  }
  for (const s of serverOps) {
    if (seen.has(s.id)) continue;
    rows.push(row('foreign_operation', null, s, `journal holds ${s.id} the driver never sent`));
  }
  return { rows, versionMismatch: null };
}

function row(cls, driver, server, detail) {
  return { operationId: driver?.id ?? server?.id, cls, red: RED.has(cls), driver, server, detail };
}

function classifyPair(d, s, res, now) {
  void now;
  // Refusals before admission: the point read must agree.
  if (d.cls === 'refused') {
    if (d.code === 'operation_id_reused') {
      // In the soak window the driver never reuses an id: red by itself. The
      // record it names must exist and be someone else's send.
      return row('operation_id_reused', d, s, s ? 'the id already had a record' : 'reused answer for an id with no record');
    }
    return s ? row('contract_violation', d, s, `refused (${d.code}) but a record exists`) : row('refused_before_admission', d, null, d.code);
  }
  if (d.cls === 'echo_mismatch') return row('echo_mismatch', d, s, d.detail);
  if (d.cls === 'contract_violation') return row('contract_violation', d, s, d.detail);
  if (d.cls === 'admitted' && !s) return row('answer_without_record', d, null, 'echoed answer, no journal record');
  if (d.cls === 'delivery_unknown' && !s) return row('unresolved_no_record', d, null, d.detail ?? 'no answer, no record');

  // From here a record exists.
  if (s.idOrigin === 'server') return row('unidentified_client', d, s, 'journal minted the id: the driver did not send one');
  if (s.status === 'begun') {
    // The DO's own verdict survived the lost response: a conflict decided
    // inside the begin transaction is a conflict, finished or not.
    const critical = s.checkVerdict === 'id_payload_conflict' || CRITICAL.has(s.checkVerdict);
    return row(critical ? 'unfinished_begun_critical' : 'unfinished_begun', d, s, `begun with verdict ${s.checkVerdict}`);
  }
  if (s.status === 'posting') {
    return resolutionApplies(res, s)
      ? row('resolved_manually', d, s, `posting ${s.txId} confirmed by operator`)
      : row('unfinished_posting', d, s, `posting ${s.txId ?? '?'} never finished`);
  }
  // finished
  if (s.paidResult === 'unknown') {
    return resolutionApplies(res, s)
      ? row('resolved_manually', d, s, `unknown POST ${s.txId} confirmed by operator`)
      : row('unresolved_paid', d, s, `finished ${s.outcome} with an unknown paid result`);
  }
  if (d.cls === 'delivery_unknown') return row('resolved_by_server', d, s, `driver lost the answer; journal says ${s.outcome}`);
  if (s.outcome === 'audit_aborted') return row('aborted_before_post', d, s, s.code ?? 'audit_aborted');
  // admitted on both sides: the RESULTS must agree, field by field
  const disagree = compareResults(d, s);
  if (disagree.length) return row('mismatch', d, s, disagree.join(', '));
  return row('matched', d, s, s.outcome);
}

/**
 * Outcomes whose ANSWER carries the transaction id (worker/src/index.ts):
 * a 200 with txId, a 409 id_payload_conflict with the historical txId, and
 * `arweave_post_unknown` with the signed one. NOT `arweave_error`: the
 * worker's 502 `arweave_rejected` answers code and text only — the journal
 * keeps the rejected txId, the client never sees it, so the driver cannot be
 * asked to echo it.
 */
const CARRIES_TX = new Set(['accepted', 'deduped', 'recovery_reconciled', 'conflict', 'redrop_conflict', 'legacy_not_ours', 'recovery_conflict', 'post_unknown']);
const DEDUPE_ANSWERS = new Set(['deduped', 'recovery_reconciled']);

/**
 * `matched` means the driver's normalized result and the journal record
 * describe the SAME operation and the SAME answer: the note, the HTTP status,
 * the code, the transaction (REQUIRED on the driver's side wherever the answer
 * carries one — a missing id is a disagreement, not a pass) and the dedupe
 * flag (a dedupe answered as a new publication, or the reverse, is a
 * disagreement even with the txId equal).
 */
export function compareResults(d, s) {
  const out = [];
  if (d.noteId !== s.noteId) out.push(`noteId ${d.noteId}≠${s.noteId}`);
  if (d.http === undefined) out.push('driver recorded no HTTP status');
  else if (s.httpStatus !== undefined && d.http !== s.httpStatus) out.push(`http ${d.http}≠${s.httpStatus}`);
  if ((d.code ?? null) !== (s.code ?? null)) out.push(`code ${d.code ?? '-'}≠${s.code ?? '-'}`);
  if (CARRIES_TX.has(s.outcome) && s.txId) {
    if (!d.txId) out.push(`driver recorded no txId for ${s.outcome}`);
    else if (d.txId !== s.txId) out.push(`txId ${d.txId}≠${s.txId}`);
  }
  if (DEDUPE_ANSWERS.has(s.outcome) && d.deduped !== true) out.push(`journal says ${s.outcome}, driver did not record deduped:true`);
  if (s.outcome === 'accepted' && d.deduped === true) out.push('journal says accepted (new), driver recorded deduped:true');
  return out;
}

// ── §7.1 Processing wait ──────────────────────────────────────────────

export const WAIT_STABLE_MS = 60 * 60_000;
export const WAIT_CAP_MS = 2 * 3_600_000;

/**
 * The wait is decided from a HISTORY of observations `[{at, unfinished: [ids]}]`
 * made after T1, never from a single read: `settled_empty` when the latest set
 * is empty and every driver record is terminal; `settled_with_unfinished` when
 * the set has been identical for WAIT_STABLE_MS; `capped` when WAIT_CAP_MS
 * after T1 has passed and the set still changed within the stable span;
 * otherwise `waiting` — no verdict yet, read again later. None of the settled
 * outcomes claims the handler finished: they say the records are stable.
 */
export function processingWait({ t1, observations, driverTerminal, now = Date.now() }) {
  const obs = [...observations].filter(o => o.at >= t1).sort((a, b) => a.at - b.at);
  if (obs.length === 0) return { outcome: 'waiting', reason: 'no observation after T1 yet' };
  const latest = obs[obs.length - 1];
  const setOf = o => [...o.unfinished].sort().join(',');
  if (latest.unfinished.length === 0 && driverTerminal) return { outcome: 'settled_empty', unfinished: [] };
  if (!driverTerminal) return { outcome: 'waiting', reason: 'driver records are not all terminal' };
  // Stable if an observation at least WAIT_STABLE_MS older shows the same set
  // and every observation in between agrees.
  const cutoff = latest.at - WAIT_STABLE_MS;
  const older = obs.filter(o => o.at <= cutoff);
  if (older.length > 0) {
    const span = obs.filter(o => o.at >= older[older.length - 1].at);
    if (span.every(o => setOf(o) === setOf(latest))) {
      return { outcome: 'settled_with_unfinished', unfinished: [...latest.unfinished] };
    }
  }
  if (now - t1 >= WAIT_CAP_MS) return { outcome: 'capped', unfinished: [...latest.unfinished], reason: 'records still changing 2 h after T1' };
  return { outcome: 'waiting', reason: 'unfinished records not yet stable for 60 min', unfinished: [...latest.unfinished] };
}

// ── §11 Acceptance policy ─────────────────────────────────────────────

/**
 * The numeric allowances are the OWNER's decision and have no defaults in
 * code: without a complete policy the verdict is «policy undefined», neither
 * green nor red. Shape: `{ allowances: { infrastructure, resolvedManually },
 * approvedAt, approvedBy }`.
 */
export function validatePolicy(policy) {
  const missing = [];
  const a = policy?.allowances;
  if (!policy || typeof policy !== 'object') return { ok: false, missing: ['policy file'] };
  if (!a || typeof a !== 'object') missing.push('allowances');
  for (const k of ['infrastructure', 'resolvedManually']) {
    if (!a || !Number.isInteger(a[k]) || a[k] < 0) missing.push(`allowances.${k}`);
  }
  if (typeof policy.approvedAt !== 'string' || Number.isNaN(Date.parse(policy.approvedAt))) missing.push('approvedAt');
  if (typeof policy.approvedBy !== 'string' || policy.approvedBy.trim() === '') missing.push('approvedBy');
  return { ok: missing.length === 0, missing };
}

// ── §7.3 Verdict ──────────────────────────────────────────────────────

/** docs/ROLLBACK.md «Soak criteria», the numbers (mirrors soak-d2.mjs VOLUME). */
export const CRITERIA = Object.freeze({
  decisions: 30, distinctDays: 3, deduped: 10, legacyBackfilled: 3,
  paidOutcomes: 20, successRate: 0.95, unprovenMax: 1, finalHoursQuiet: 48,
  /** «168 continuous hours on ONE worker version id» (docs/ROLLBACK.md). */
  windowMs: 168 * 3_600_000,
});

/**
 * The window is the ledger's, not the caller's: T0 is when the driver first
 * saw the version under soak, T1 is at least 168 h later and already in the
 * past. Anything else is a DIAGNOSTIC read — the join and the classes are
 * still useful, the verdict is not issued.
 */
export function checkWindow({ from, to, ledgerStart, now = Date.now() }) {
  const problems = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) problems.push('window bounds are not a range');
  if (typeof ledgerStart !== 'number') problems.push('the ledger holds no window start (release.firstSeenAt) — no `day` run on this version yet');
  else if (from !== ledgerStart) problems.push(`--from ${new Date(from).toISOString()} is not the ledger's window start ${new Date(ledgerStart).toISOString()}`);
  if (Number.isFinite(from) && Number.isFinite(to) && to - from < CRITERIA.windowMs) {
    problems.push(`window is ${((to - from) / 3_600_000).toFixed(1)} h, a soak window is ${CRITERIA.windowMs / 3_600_000} h`);
  }
  if (Number.isFinite(to) && to > now) problems.push('the window has not ended yet');
  return { ok: problems.length === 0, problems };
}

/**
 * The journal outcomes that ARE an `upload_outcome` emission (docs/METRICS.md):
 * one per terminal return of the paid path. `audit_aborted` and
 * `audit_unavailable` are NOT in it — no POST was attempted and the worker
 * emits nothing for them — exactly as before the journal existed. This keeps
 * «accepted ÷ all upload_outcome» the criterion it always was.
 */
export const UPLOAD_OUTCOMES = new Set(['accepted', 'arweave_error', 'arweave_throw', 'gateway_unavailable_pre_post', 'post_unknown']);

const STRICT_ZERO = ['conflict', 'redrop_conflict', 'legacy_not_ours', 'recovery_conflict', 'arweave_throw'];
const INFRA = new Set(['gateway_unavailable_pre_post', 'audit_aborted']);

/** All outcomes a finished record contributed: its attests plus its outcome. */
function outcomesOf(s) {
  const set = new Set(Array.isArray(s.attests) ? s.attests : []);
  if (s.outcome) set.add(s.outcome);
  return set;
}

/**
 * Green only when EVERYTHING holds: the wait is not capped, no red row, every
 * criterion of ROLLBACK.md over the joined set, no allowance exceeded, every
 * resolution carries evidence. Returns the list of failures — an empty list is
 * the verdict «green». `policy` must already be validated.
 */
export function verdict({ rows, wait, policy, window, resolutions = {}, now = Date.now() }) {
  const failures = [];
  const { t0, t1 } = window;
  // Defence in depth: reconcileWindow refuses a non-soak window before calling
  // this, and this refuses it again — a verdict over 72 h is not a verdict.
  if (!(t1 - t0 >= CRITERIA.windowMs)) failures.push(`window ${((t1 - t0) / 3_600_000).toFixed(1)} h is shorter than ${CRITERIA.windowMs / 3_600_000} h`);
  if (t1 > now) failures.push('the window has not ended yet');
  if (wait.outcome === 'capped') failures.push('processing wait capped: records still changing 2 h after T1');
  if (wait.outcome === 'waiting') failures.push(`processing wait not settled: ${wait.reason}`);

  for (const r of rows) if (r.red) failures.push(`red: ${r.cls} ${r.operationId} — ${r.detail}`);

  const finished = rows.map(r => r.server).filter(s => s && s.status === 'finished');
  const count = (name) => finished.filter(s => outcomesOf(s).has(name)).length;
  const inFinal48h = (name) => finished.filter(s => outcomesOf(s).has(name) && (s.finishedAt ?? s.beganAt) >= t1 - CRITERIA.finalHoursQuiet * 3_600_000).length;

  for (const name of STRICT_ZERO) {
    const n = count(name);
    if (n > 0) failures.push(`strictly zero violated: ${name} = ${n}`);
  }
  for (const name of ['legacy_unproven', 'recovery_unproven']) {
    const n = count(name);
    if (n > CRITERIA.unprovenMax) failures.push(`${name} = ${n} > ${CRITERIA.unprovenMax}`);
    if (inFinal48h(name) > 0) failures.push(`${name} inside the final 48 h`);
  }

  // Volume, from the journal — never from the driver's plan.
  const decisions = finished.reduce((n, s) => n + [...outcomesOf(s)].filter(o => DECISION_OUTCOMES.has(o)).length, 0);
  const days = new Set(finished.filter(s => s.beganAt >= t0 && s.beganAt <= t1).map(s => new Date(s.beganAt).toISOString().slice(0, 10)));
  const deduped = count('deduped');
  const legacyBackfilled = new Set(finished.filter(s => outcomesOf(s).has('legacy_backfilled')).map(s => s.noteId)).size;
  if (decisions < CRITERIA.decisions) failures.push(`semantic_idempotency decisions ${decisions} < ${CRITERIA.decisions}`);
  if (days.size < CRITERIA.distinctDays) failures.push(`distinct days ${days.size} < ${CRITERIA.distinctDays}`);
  if (deduped < CRITERIA.deduped) failures.push(`deduped ${deduped} < ${CRITERIA.deduped}`);
  if (legacyBackfilled < CRITERIA.legacyBackfilled) failures.push(`legacy_backfilled (distinct) ${legacyBackfilled} < ${CRITERIA.legacyBackfilled}`);

  // Paid outcomes = the `upload_outcome` total, read from the journal: every
  // finished record whose outcome is one the paid path emits (UPLOAD_OUTCOMES).
  // Success = `accepted`, plus an unknown POST the operator confirmed on the
  // pool (an unconfirmed one is red on its own row). Same criterion as
  // docs/ROLLBACK.md «accepted ÷ all upload_outcome», same denominator.
  // …plus the manually resolved publications: a `posting` record the operator
  // confirmed on the pool never becomes `finished` (the journal is not
  // rewritten), yet it IS a publication — counted once, in both the numerator
  // and the denominator, whatever its stored status.
  const paidIds = new Set();
  for (const r of rows) {
    if (!r.server) continue;
    if ((r.server.status === 'finished' && UPLOAD_OUTCOMES.has(r.server.outcome)) || r.cls === 'resolved_manually') paidIds.add(r.operationId);
  }
  const paidRows = rows.filter(r => paidIds.has(r.operationId));
  const paid = paidRows.length;
  const accepted = paidRows.filter(r => r.server.outcome === 'accepted' || r.cls === 'resolved_manually').length;
  if (paid < CRITERIA.paidOutcomes) failures.push(`paid outcomes ${paid} < ${CRITERIA.paidOutcomes}`);
  if (paid > 0 && accepted / paid < CRITERIA.successRate) {
    failures.push(`paid success rate ${(100 * accepted / paid).toFixed(1)} % < ${100 * CRITERIA.successRate} %`);
  }

  // Allowances — the owner's numbers, never defaults. Incidents are counted
  // ONCE per operation (an aborted record is both `audit_aborted` and the
  // row class `aborted_before_post`; it is one incident).
  const infra = new Set(rows.filter(r => r.server && (INFRA.has(r.server.outcome) || r.cls === 'aborted_before_post')).map(r => r.operationId)).size;
  const resolved = rows.filter(r => r.cls === 'resolved_manually').length;
  if (infra > policy.allowances.infrastructure) failures.push(`infrastructure incidents ${infra} > allowance ${policy.allowances.infrastructure}`);
  if (resolved > policy.allowances.resolvedManually) failures.push(`resolved_manually ${resolved} > allowance ${policy.allowances.resolvedManually}`);
  const infraFinal = finished.filter(s => INFRA.has(s.outcome) && (s.finishedAt ?? s.beganAt) >= t1 - CRITERIA.finalHoursQuiet * 3_600_000).length;
  if (infraFinal > 0) failures.push(`infrastructure incident inside the final 48 h`);
  for (const [id, res] of Object.entries(resolutions)) {
    if (typeof res.evidence !== 'string' || res.evidence.trim() === '') failures.push(`resolution ${id} without evidence`);
  }
  void now;
  return { green: failures.length === 0, failures, figures: { decisions, days: days.size, deduped, legacyBackfilled, paid, accepted, infra, resolved } };
}

/** The `semantic_idempotency` outcomes that count as decisions (docs/METRICS.md). */
const DECISION_OUTCOMES = new Set([
  'deduped', 'conflict', 'redrop_conflict', 'legacy_backfilled', 'legacy_backfill_stale', 'legacy_not_ours', 'legacy_unproven',
  'legacy_dead_redrop', 'legacy_dead_deferred', 'recovery_reconciled', 'recovery_unproven', 'recovery_conflict',
]);

export function isValidOperationId(id) {
  return typeof id === 'string' && OP_ID_RE.test(id);
}
export function isValidTxId(id) {
  return typeof id === 'string' && TXID_RE.test(id);
}
