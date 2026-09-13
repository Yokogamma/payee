/**
 * Soak driver for the D2 worker release («semantic idempotency», backup plan
 * step 3, PR #136). The dev contour has NO organic paid traffic — the
 * pre-release 7-day baseline of `upload_outcomes` was `{"rows":[]}` on
 * 2026-09-07 — so the volume the soak criteria demand (docs/ROLLBACK.md
 * «Soak criteria») has to be produced deliberately, under a budget, without
 * ever creating the one thing the criteria forbid: a different payload under
 * a reused id.
 *
 * Modes (one per invocation; state lives OUTSIDE the repo, see SOAK_STATE):
 *
 *   register [--invite C]   register the smoke identity on the target (free):
 *                           with ADMIN_SECRET a single-use invite is seeded
 *                           first, otherwise --invite carries a seeded code.
 *   seed-legacy --count N   BEFORE the deploy, against the OLD worker
 *                           (`ff0954d`, no `semanticIdempotency`): publishes N
 *                           notes whose DO records carry no fingerprint. These
 *                           are the only records the new worker will ever see
 *                           as LEGACY — after the deploy none can be created.
 *   day --paid N            AFTER the deploy, once a day, against the NEW
 *                           worker: N new paid publications, a dedupe pass over
 *                           every earlier note (exact same bytes — the ONLY
 *                           thing this script ever re-sends), a `recheck` pass
 *                           over confirmed notes, and a legacy pass that
 *                           re-sends a seeded note only once its transaction is
 *                           CONFIRMED on a payload gateway — an unconfirmed one
 *                           would burn the `legacy_unproven ≤ 1` budget for a
 *                           reason that has nothing to do with the release.
 *                           `--no-recheck` / `--no-legacy` switch off the two
 *                           passes that can reach a PAID redrop — the only way
 *                           to make a run against the soak wallet cost nothing,
 *                           since `--paid 0` bounds new publications alone.
 *   snapshot                the daily 24-hour report of `semantic_idempotency`
 *                           and `upload_outcomes`, kept as a dated file (the
 *                           runbook: «a soak without the daily snapshots is a
 *                           calendar, not a measurement»). Needs
 *                           METRICS_ADMIN_SECRET; `day` runs it automatically
 *                           when the secret is present.
 *   status                  progress against the volume criteria, from the
 *                           script's own ledger (this is the plan, not the
 *                           verdict) — and the unknown sends and quarantined
 *                           notes that make a verdict impossible until
 *                           `reconcile`.
 *   reconcile --from T --to T
 *                           the verdict (plan «soak D2 operation journal»
 *                           v6.1 §6–§7): reads the worker's operation journal
 *                           (POST /admin/ops, METRICS_ADMIN_SECRET) for the
 *                           window, joins it with this ledger on operationId,
 *                           records one observation of the unfinished records,
 *                           and — once the wait has settled and the acceptance
 *                           policy file exists — answers green or red with the
 *                           reasons. Exit 0 green, 1 red, 3 withheld (waiting,
 *                           or `acceptance-policy.json` missing/incomplete).
 *   resolve <operationId> --txid T --evidence "…"
 *                           the operator's decision that the SIGNED transaction
 *                           of one unknown POST exists on the pool. Written to
 *                           this ledger only; the journal is never changed; the
 *                           note stays quarantined. Refused unless the journal
 *                           record (from the last reconcile) carries an intent
 *                           to POST, an unknown paid result and that very txId.
 *
 * Environment:
 *   SMOKE_URL             worker origin (default: the dev worker)
 *   SMOKE_PRIVATE_KEY     base64 32-byte Ed25519 seed of a REGISTERED key
 *   SOAK_RELEASE_SHA      full SHA the `day` mode must see in /health
 *   SOAK_STATE            state file (default ~/.eternal-notes-soak/state.json)
 *   SOAK_MAX_PAID_TOTAL   hard cap on paid POSTs over the whole soak (default 30)
 *   SOAK_REDROP_RECHECK_TOTAL  window cap on recheck SENDS (default 12)
 *   SOAK_REDROP_LEGACY_TOTAL   window cap on legacy SENDS (default 8, a reserve)
 *   SOAK_PROBE_ORIGIN     gateway used to confirm a transaction (arweave.net)
 *   METRICS_ADMIN_SECRET  optional; enables `snapshot`, required by `reconcile`
 *
 * Acceptance policy (plan v6.1 §11): `<state dir>/acceptance-policy.json` —
 *   { "allowances": { "infrastructure": N, "resolvedManually": N },
 *     "approvedAt": "<ISO date>", "approvedBy": "<owner>" }
 * The numbers are the OWNER's decision and have NO defaults in code: without
 * the file, or with any field missing, `reconcile` answers «policy undefined»
 * and issues no verdict at all (exit 3).
 *   ADMIN_SECRET          optional; lets `register` seed its own invite
 *
 * ⚠️ НЕ ДОБАВЛЯТЬ СЮДА SHEBANG. Файл импортируется soak-d2.test.mjs, а vite-node
 * оборачивает модуль в тело функции — `#!` внутри неё даёт V8 «Invalid or
 * unexpected token», и тест перестаёт СОБИРАТЬСЯ (падает молча, до единого
 * ассерта). Запуск всегда явный — `node scripts/soak-d2.mjs` в run.sh и в
 * npm-скрипте soak:d2, — поэтому shebang и не нужен.
 *
 * Every paid POST costs real AR: `--paid` bounds one run, SOAK_MAX_PAID_TOTAL
 * bounds the soak, and the price of one publication is printed before money
 * is spent. A 409 `id_payload_conflict` is a STOP, never a retry — it is the
 * criterion that must read zero, and a retry would only add a second one.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as ed from '@noble/ed25519';
import { classifySmokeTarget, AUTO_ALLOWED_WORKER_ORIGINS } from './smoke-target.mjs';
import {
  classifyAnswer, classifyThrow, quarantines, joinBooks, processingWait, validatePolicy, verdict as decideVerdict,
  isValidOperationId, isValidTxId,
} from './soak-reconcile.mjs';

/** The worker that must be live for `seed-legacy`: PR-3a, before D2. */
export const LEGACY_RELEASE_SHA = 'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1';

export const DEFAULTS = Object.freeze({
  paidPerRun: 3,
  maxPaidTotal: 30,
  dedupePerRun: 8,
  legacyPerRun: 2,
  /** A `recheck` asks the status quorum; a young transaction answers
   *  `pending` and the worker defers without a decision. */
  recheckMinAgeMs: 24 * 3_600_000,
  /**
   * ── The redrop budget ──
   *
   * `--paid N` bounds NEW publications and nothing else. Two other requests
   * can also spend AR, and neither is counted by `paidPosts`:
   *
   *   - a `recheck` whose status quorum answers `dead` past the age guard goes
   *     to `doRedrop` — a paid re-post (worker/src/index.ts);
   *   - a legacy attempt whose D9 is unproven AND whose quorum is unanimously
   *     `dead` takes the same path, with no `recheck` involved at all.
   *
   * Once the request is sent the decision is the SERVER's, so the only lever
   * here is not sending it. Hence a budget on SENDS, deliberately conservative:
   * it counts what COULD cost money, not what did.
   *
   * Per run 3 + 2 = 5; per window 12 + 8 = 20 (owner, 2026-09-08). The legacy
   * half is a RESERVE: `recheck` cannot borrow from it, because `dedupePerRun`
   * is 8 and a busy ledger would otherwise spend the whole budget on rechecks
   * and starve the three backfills the soak criteria actually require.
   */
  recheckPerRun: 3,
  redropRecheckTotal: 12,
  redropLegacyTotal: 8,
  /** Confirmations a legacy transaction must show before it is re-sent. */
  confirmationsRequired: 2,
  /** And it must be at least this old: header/raw availability lags the
   *  status endpoint, and the verifier needs both. */
  legacyMinAgeMs: 60 * 60_000,
  probeOrigin: 'https://arweave.net',
  /** Payload size the price estimate is quoted for (a soak note ≈ 150 B). */
  priceBytes: 200,
});

/** docs/ROLLBACK.md «Soak criteria» — the volume half, as numbers. */
export const VOLUME = Object.freeze({
  decisions: 30,
  distinctDays: 3,
  deduped: 10,
  legacyBackfilled: 3,
  recoveryReconciled: 1,
  paidOutcomes: 20,
});

export const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

// ── Pure helpers (unit-tested) ─────────────────────────────────────────

export function emptyState() {
  return {
    version: 1,
    origin: null,
    ownerHash: null,
    release: null,
    notes: [],
    runs: [],
    paidPosts: 0,
    unprovenSeen: 0,
    /** Requests sent that COULD have cost a redrop — see DEFAULTS. Counted
     *  before the request leaves, so a crash cannot refund the budget. */
    redropSends: { recheck: 0, legacy: 0 },
    /** Paid publications ATTEMPTED — what the budget actually charges.
     *  Written BEFORE the request leaves; paidPosts above counts only the
     *  successes and therefore cannot bound money. See the attempt ledger. */
    paidAttempts: { records: [], priorEra: null },
    /** EVERY request this driver sent, of every pass, written `pending` before
     *  it leaves and closed with the classified answer (soak-reconcile.mjs
     *  §6.1) — the driver's half of the two books the verdict is read from. */
    operations: [],
    /** Notes with an unknown send: excluded from every pass until the window
     *  ends. Nothing lifts a quarantine; a new ledger is a new window. */
    quarantine: [],
    /** The operator's resolutions of unknown POSTs, by operationId. */
    resolutions: {},
    /** Reconcile reports and the per-window observations of unfinished
     *  journal records the processing wait is decided from. */
    reconcile: [],
    reconcileObservations: {},
    /** The canonical public key the journal is addressed by (set by `day`). */
    ownerPk: null,
  };
}

// ── The operations ledger (the driver's book) ─────────────────────────

/**
 * One record per request, of ANY pass, created BEFORE the request leaves —
 * the id goes into the signed body as `operationId`, and is what the
 * worker's journal is joined on. A paid publication's attempt record shares
 * this id.
 */
export function newOperation(state, noteId, pass, at) {
  state.operations ??= [];
  const op = { id: crypto.randomUUID(), at, noteId, pass, outcome: 'pending' };
  state.operations.push(op);
  return op;
}

/** The answer, classified at receipt (§6.1) — never re-derived later. */
export function recordAnswer(op, answer) {
  const c = classifyAnswer(answer, op.id);
  op.outcome = 'answered';
  op.http = answer.status;
  op.cls = c.cls;
  if (c.code) op.code = c.code;
  if (c.detail) op.detail = c.detail;
  const body = answer.body;
  if (body && typeof body === 'object' && typeof body.txId === 'string') op.txId = body.txId;
  return c;
}

/** The send threw: nothing arrived, the outcome is unknown forever. */
export function recordThrow(op, error) {
  const c = classifyThrow(error);
  op.outcome = 'unknown';
  op.cls = c.cls;
  op.detail = c.detail;
  return c;
}

/** Quarantine the note behind an unknown send; idempotent per note. */
export function quarantineNote(state, op, reason) {
  state.quarantine ??= [];
  if (state.quarantine.some(q => q.noteId === op.noteId)) return false;
  state.quarantine.push({ noteId: op.noteId, operationId: op.id, reason, since: Date.now() });
  return true;
}

export function quarantinedNoteIds(state) {
  return new Set((state.quarantine ?? []).map(q => q.noteId));
}

/** Driver records inside a window, by `at`. */
export function operationsIn(state, from, to) {
  return (state.operations ?? []).filter(o => o.at >= from && o.at <= to);
}

/**
 * The operator's resolution of ONE unknown POST — validated against the
 * journal record the last `reconcile` fetched, never against the worker.
 * Confirms the publication of the journaled txId; nothing else.
 */
export function applyResolve(state, operationId, { txId, evidence }, at) {
  if (!isValidOperationId(operationId)) return { ok: false, reason: 'operationId must be a UUIDv4' };
  if (typeof evidence !== 'string' || evidence.trim() === '') return { ok: false, reason: '--evidence is required (what was checked, where, when)' };
  if (!isValidTxId(txId)) return { ok: false, reason: '--txid must be a 43-char transaction id' };
  const report = (state.reconcile ?? []).at(-1);
  if (!report) return { ok: false, reason: 'no reconcile report yet — run `reconcile` first' };
  const record = report.records?.[operationId];
  if (!record) return { ok: false, reason: 'the last reconcile holds no journal record for this operationId' };
  if (typeof record.postingAt !== 'number') return { ok: false, reason: 'the record carries no intent to POST (no postingAt): nothing to confirm' };
  if (record.paidResult !== 'unknown') return { ok: false, reason: `paidResult is ${record.paidResult}, not unknown: nothing to resolve` };
  if (record.txId !== txId) return { ok: false, reason: `--txid ${txId} is not the journaled transaction ${record.txId}` };
  state.resolutions ??= {};
  state.resolutions[operationId] = { txId, evidence: evidence.trim(), at };
  return { ok: true };
}

/**
 * Charge one redrop-capable send and make it DURABLE before the request goes.
 * Throws when the ledger cannot be written: the caller must then not send, or
 * the quota stops bounding anything the moment the process dies.
 */
export async function chargeBudget(state, kind, persist) {
  state.redropSends = redropSends(state);
  state.redropSends[kind] += 1;
  if (persist) await persist();
}

/** The redrop counters, tolerating a ledger written before they existed. */
export function redropSends(state) {
  const sends = state.redropSends ?? {};
  return { recheck: sends.recheck ?? 0, legacy: sends.legacy ?? 0 };
}

// ── The paid-attempt ledger ───────────────────────────────────────────
//
// `paidPosts` counts SUCCESSES: it is incremented after the answer and only
// for `accepted-new`. That makes it unfit to bound money — a publication that
// failed, or one whose answer never arrived, spent the same AR and left the
// counter untouched. The observability review of 2026-09-09 turned that from a
// theoretical gap into the reason a soak window may not be certifiable: 18
// attempts with one failure and 17 successes are indistinguishable from 17
// clean attempts.
//
// So the budget is charged against ATTEMPTS, made durable BEFORE the request
// leaves — the same contract `chargeBudget` already uses for redrop-capable
// sends. An attempt whose outcome was never written stays `unknown` forever:
// it keeps the limit it took and is NEVER re-driven. Re-sending it
// automatically is exactly the double-paid publication D2 exists to prevent.

/** An attempt record, created before the request leaves. */
export function newAttempt(noteId, at, mode, id = crypto.randomUUID()) {
  return { id, at, noteId, mode, outcome: 'pending' };
}

/**
 * The attempt ledger, tolerating a state file written before it existed.
 * `priorEra` is set ONLY by the explicit migration, never inferred here.
 */
export function paidAttempts(state) {
  const a = state.paidAttempts;
  return { records: Array.isArray(a?.records) ? a.records : [], priorEra: a?.priorEra ?? null };
}

/**
 * What the budget charges. The prior era contributes its KNOWN SUCCESSES — a
 * documented LOWER BOUND, not a reconstruction: how many attempts happened
 * before anything recorded them is unknowable, and pretending otherwise would
 * understate money already spent.
 */
export function attemptsSpent(state) {
  const { records, priorEra } = paidAttempts(state);
  return (priorEra?.knownSuccesses ?? 0) + records.length;
}

/** Counts for reporting. `pending` reads as `unknown` WITHOUT mutating. */
export function attemptsSummary(state) {
  const { records, priorEra } = paidAttempts(state);
  const out = { total: attemptsSpent(state), accepted: 0, error: 0, unknown: 0, priorEra };
  for (const r of records) {
    if (r.outcome === 'accepted-new') out.accepted += 1;
    else if (r.outcome === 'error') out.error += 1;
    else out.unknown += 1; // 'unknown', and anything a crash left 'pending'
  }
  return out;
}

/**
 * A ledger from before this counter existed must NOT be migrated silently:
 * the historical attempt count is unknown and may not be invented from
 * `paidPosts`. `day` refuses until the operator runs `migrate-attempts`.
 */
export function needsAttemptsMigration(state) {
  // Detected by SCHEMA, never by results. A ledger whose publications all
  // FAILED has `paidPosts === 0` and is still an old ledger — reading "no
  // attempts" out of "no successes" is the very inference this counter exists
  // to remove. `emptyState()` always carries the field, so a genuinely new
  // ledger never matches.
  return !Array.isArray(state.paidAttempts?.records);
}

/**
 * The explicit transition. `paidPosts`, `notes` and every run record are left
 * untouched — the history stays exactly as it was written.
 */
export function migrateAttempts(state, at) {
  if (!needsAttemptsMigration(state)) {
    state.paidAttempts ??= { records: [], priorEra: null };
    state.paidAttempts.records ??= [];
    return { migrated: false };
  }
  const knownSuccesses = state.paidPosts ?? 0;
  state.paidAttempts = {
    records: [],
    priorEra: {
      migratedAt: at,
      knownSuccesses,
      /** The point of the field: attempts before `migratedAt` were never
       *  recorded, so the true figure is >= knownSuccesses and unknowable. */
      attemptsUnknown: true,
    },
  };
  return { migrated: true, knownSuccesses };
}

/**
 * An attempt left `pending` means a process died between the send and the
 * answer. It becomes `unknown`: the transaction MAY be on chain, and only a
 * human may decide what to do about it. Idempotent — re-running it changes
 * nothing, so an unpersisted reconciliation is safe to repeat.
 */
export function reconcilePendingAttempts(state, at) {
  const stranded = paidAttempts(state).records.filter(r => r.outcome === 'pending');
  for (const r of stranded) {
    r.outcome = 'unknown';
    r.detail = 'interrupted before the outcome was recorded';
    r.reconciledAt = at;
  }
  return stranded;
}

/**
 * Charge one paid attempt and make it DURABLE before the request goes.
 * Throws when the ledger cannot be written: the caller must then NOT send.
 */
export async function chargeAttempt(state, attempt, persist) {
  state.paidAttempts ??= { records: [], priorEra: null };
  state.paidAttempts.records ??= [];
  state.paidAttempts.records.push(attempt);
  if (persist) await persist();
}

/**
 * Gate on /health BEFORE any money moves. `seed-legacy` insists on the OLD
 * worker: a note seeded on the new one is fingerprinted at reservation and is
 * not legacy at all — the run would look green and prove nothing. `day`
 * insists on the release under test AND on one worker version id for the
 * whole window (a redeploy resets the window, and the ledger must say so).
 */
export function checkReleaseGate(health, mode, state, expectedSha) {
  const problems = [];
  if (!health || health.ok !== true) problems.push('health.ok is not true');
  if (health?.uploads !== true) problems.push('uploads are switched off');
  if (health?.v3Uploads !== true) problems.push('v3 uploads are switched off');
  if (mode === 'seed-legacy') {
    if (health?.releaseSha !== LEGACY_RELEASE_SHA) {
      problems.push(`seed-legacy needs the pre-D2 worker ${LEGACY_RELEASE_SHA.slice(0, 7)}, live is ${String(health?.releaseSha).slice(0, 7)}`);
    }
    if (health?.semanticIdempotency !== undefined) {
      problems.push('live worker already fingerprints — nothing seeded now would be legacy');
    }
  } else if (mode === 'day' || mode === 'snapshot') {
    if (!expectedSha) problems.push('SOAK_RELEASE_SHA is required');
    else if (health?.releaseSha !== expectedSha) {
      problems.push(`live releaseSha ${String(health?.releaseSha).slice(0, 7)} is not the release under soak ${expectedSha.slice(0, 7)}`);
    }
    if (health?.semanticIdempotency !== 1) problems.push('health.semanticIdempotency is not 1');
    const seen = state.release?.workerVersionId;
    if (seen && health?.workerVersionId && seen !== health.workerVersionId) {
      problems.push(`workerVersionId changed (${seen} → ${health.workerVersionId}): the 168-hour window has reset — start a NEW state file`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * What one `day` run will do, from the ledger alone. Paid publications are
 * bounded twice (per run, per soak); the dedupe pass prefers the notes that
 * were re-sent least, so coverage spreads instead of hammering one id; legacy
 * candidates are only NAMED here — whether each is confirmed is an IO question
 * the runner asks right before sending.
 */
export function planRun(state, opts, now) {
  // Charged against ATTEMPTS, never successes: a publication that failed,
  // or one whose answer never arrived, spent the same AR. See attemptsSpent.
  const paidLeft = Math.max(0, opts.maxPaidTotal - attemptsSpent(state));
  const paid = Math.max(0, Math.min(opts.paidPerRun, paidLeft));
  // A note behind an unknown send is out of EVERY pass for the rest of the
  // window (§5): any of them can reach a paid POST, and a second send would be
  // the double payment the journal exists to make visible, not to cause.
  const quarantined = quarantinedNoteIds(state);

  const comparable = state.notes.filter(n => n.kind === 'paid' || n.backfilledAt);
  const dedupe = [...comparable].filter(n => !quarantined.has(n.noteId))
    .sort((a, b) => (a.dedupes ?? 0) - (b.dedupes ?? 0) || a.createdAt - b.createdAt)
    .slice(0, opts.dedupePerRun);
  // ── Redrop budget: two quotas, and the legacy half is a RESERVE ──
  const sent = redropSends(state);
  const recheckLeft = Math.max(0, opts.redropRecheckTotal - sent.recheck);
  const legacyLeft = Math.max(0, opts.redropLegacyTotal - sent.legacy);
  const withheld = [];

  const recheckReady = dedupe
    .filter(n => n.confirmedAt && now - n.createdAt >= opts.recheckMinAgeMs)
    .map(n => n.noteId);
  let recheck;
  if (opts.noRecheck) {
    recheck = [];
    if (recheckReady.length) withheld.push(`recheck: ${recheckReady.length} candidate(s) held back by --no-recheck`);
  } else {
    const room = Math.min(opts.recheckPerRun, recheckLeft);
    recheck = recheckReady.slice(0, room);
    if (recheckReady.length > recheck.length) {
      withheld.push(
        `recheck: ${recheckReady.length - recheck.length} of ${recheckReady.length} held back ` +
        `(per-run ${opts.recheckPerRun}, window ${sent.recheck}/${opts.redropRecheckTotal})`,
      );
    }
  }

  const legacyReady = state.notes
    .filter(n => n.kind === 'legacy' && !n.backfilledAt && !quarantined.has(n.noteId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(n => n.noteId);
  let legacyCandidates;
  if (opts.noLegacy) {
    legacyCandidates = [];
    if (legacyReady.length) withheld.push(`legacy: ${legacyReady.length} candidate(s) held back by --no-legacy`);
  } else {
    const room = Math.min(opts.legacyPerRun, legacyLeft);
    legacyCandidates = legacyReady.slice(0, room);
    if (legacyReady.length > legacyCandidates.length) {
      withheld.push(
        `legacy: ${legacyReady.length - legacyCandidates.length} of ${legacyReady.length} held back ` +
        `(per-run ${opts.legacyPerRun}, window ${sent.legacy}/${opts.redropLegacyTotal})`,
      );
    }
  }

  return {
    paid,
    paidLeftAfter: paidLeft - paid,
    dedupe: dedupe.map(n => n.noteId),
    recheck,
    legacyCandidates,
    /** Why a ready candidate is NOT in the lists above — logged, never silent:
     *  a run that quietly checks nothing looks exactly like a green one. */
    withheld,
  };
}

/**
 * One upload answer, named. `expectedTxId` is the transaction the ledger
 * already holds for this id: a dedupe that returns ANY other id is not a
 * dedupe, it is the defect the release exists to remove.
 */
export function classifyUpload(status, body, expectedTxId) {
  if (status === 409) {
    if (body && typeof body === 'object' && body.code === 'id_payload_conflict') {
      return { kind: 'conflict', detail: `id_payload_conflict txId=${body.txId}` };
    }
    return { kind: 'in-progress', detail: 'reservation in flight' };
  }
  if (status === 429) return { kind: 'rate-limited', detail: 'hourly quota' };
  if (status === 403) return { kind: 'not-registered', detail: typeof body === 'string' ? body.slice(0, 120) : JSON.stringify(body).slice(0, 120) };
  if (status === 503) return { kind: 'unavailable', detail: typeof body === 'string' ? body.slice(0, 120) : JSON.stringify(body).slice(0, 120) };
  if (status !== 200) return { kind: 'unexpected', detail: `HTTP ${status} ${JSON.stringify(body).slice(0, 160)}` };
  if (!body || typeof body !== 'object') return { kind: 'unexpected', detail: '200 without a JSON object' };
  if (body.semanticIdempotency !== 1) {
    // The old worker answers without the marker: fine for seeding, wrong for
    // everything else. The caller decides which; here it is only named.
    return body.status === 'accepted' && TXID_RE.test(String(body.txId))
      ? { kind: 'accepted-unattested', detail: `txId=${body.txId} committed=${body.committed}` }
      : { kind: 'unexpected', detail: `200 without semanticIdempotency: ${JSON.stringify(body).slice(0, 160)}` };
  }
  if (body.status !== 'accepted' || !TXID_RE.test(String(body.txId))) {
    return { kind: 'unexpected', detail: `200 with an unusable body: ${JSON.stringify(body).slice(0, 160)}` };
  }
  if (body.deduped === true) {
    if (expectedTxId && body.txId !== expectedTxId) {
      return { kind: 'conflict', detail: `deduped onto a DIFFERENT txId: expected ${expectedTxId}, got ${body.txId}` };
    }
    if (body.committed !== true) return { kind: 'unexpected', detail: 'deduped but not committed' };
    return { kind: 'deduped', detail: `txId=${body.txId}` };
  }
  if (expectedTxId) {
    return { kind: 'conflict', detail: `a NEW paid txId ${body.txId} for an id already published as ${expectedTxId}` };
  }
  return { kind: 'accepted-new', detail: `txId=${body.txId} committed=${body.committed}` };
}

/**
 * Would D9 find this transaction on the payload pool? The verifier reads
 * `/tx/<id>` (a format-2 header naming this id) and `/raw/<id>` (bytes).
 * Confirmations alone are NOT the question: on 2026-09-07 the first legacy
 * pass ran against a record whose `/tx/<id>/status` already showed ≥ 2
 * confirmations while `/raw/<id>` still answered 404 on every gateway — and
 * that spent the window's single `legacy_unproven` twelve minutes in.
 */
export function readTxHeaderOk(status, body, txId) {
  return status === 200 && !!body && typeof body === 'object' && body.format === 2 && body.id === txId;
}

/** `/tx/<id>/status` → confirmed enough to be verifiable by D9? */
export function readConfirmations(status, body) {
  if (status !== 200 || !body || typeof body !== 'object') return null;
  const n = body.number_of_confirmations;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function estimateCost(priceWinstonForBytes, count) {
  const perTx = BigInt(priceWinstonForBytes);
  const total = perTx * BigInt(count);
  const ar = (w) => (Number(w) / 1e12).toFixed(6);
  return { perTxWinston: perTx.toString(), totalWinston: total.toString(), perTxAr: ar(perTx), totalAr: ar(total) };
}

/** Progress against VOLUME from the ledger — a plan, not the verdict. */
/**
 * Confirmed paid publications of one driver mode, counted from the DURABLE
 * attempt records.
 *
 * NOT from `state.runs`, and this is the whole point. A run object is appended
 * to `runs` only by `finish()`, at the very END of the pass, while `settle()`
 * has already persisted the successful attempt, the note and `paidPosts` the
 * moment the answer arrived. A process killed between those two leaves a
 * publication that is durably recorded but belongs to no run — invisible to a
 * `runs`-based count, and, with a subtraction, misfiled as seeding.
 *
 * NOT `state.paidPosts` either: that is the lifetime total and includes
 * `seed-legacy`, whose publications are made by the PRE-D2 worker before the
 * window exists and emit no `upload_outcome` of the release at all.
 * docs/ROLLBACK.md («Volume») requires 20 paid outcomes INSIDE the window on
 * one worker version, so counting the seeded five would report 20 where the
 * release produced 15.
 *
 * The budget is deliberately the other way round (`attemptsSpent` counts every
 * record, seeding included): money spent is money spent, whichever worker
 * spent it.
 *
 * A record written before attempts carried a `mode` matches NEITHER mode and
 * is counted in neither figure — an unlabelled record cannot be attributed,
 * and guessing would reintroduce exactly the misfiling this replaces.
 */
export function confirmedPaidByMode(state, mode) {
  return paidAttempts(state).records
    .filter(r => r.mode === mode && r.outcome === 'accepted-new')
    .length;
}

export function paidOutcomesInWindow(state) {
  return confirmedPaidByMode(state, 'day');
}

/**
 * Seeding publications — counted from THEIR OWN records, never by subtracting
 * the window figure from the lifetime one. Subtraction attributes anything the
 * window failed to count to the seeding, which is exactly the wrong answer in
 * the crash case above.
 */
export function seededPaid(state) {
  return confirmedPaidByMode(state, 'seed-legacy');
}

export function summarize(state) {
  const days = new Set(state.runs.filter(r => r.mode === 'day').map(r => new Date(r.at).toISOString().slice(0, 10)));
  const deduped = state.runs.reduce((n, r) => n + (r.deduped ?? 0), 0);
  const legacyBackfilled = state.notes.filter(n => n.kind === 'legacy' && n.backfilledAt).length;
  const decisions = deduped + legacyBackfilled + state.unprovenSeen;
  const row = (name, have, need) => ({ name, have, need, ok: have >= need });
  return [
    row('semantic_idempotency decisions (script-side)', decisions, VOLUME.decisions),
    row('distinct days with a day run', days.size, VOLUME.distinctDays),
    row('deduped', deduped, VOLUME.deduped),
    row('legacy_backfilled (distinct records)', legacyBackfilled, VOLUME.legacyBackfilled),
    // Waived by the owner on 2026-09-07 (docs/ROLLBACK.md): the event needs a
    // genuine DO fault, which nothing outside the worker can stage.
    { name: 'recovery_reconciled — waived by owner 2026-09-07 (not reachable by any client)', have: 0, need: VOLUME.recoveryReconciled, ok: true },
    // NOT the criterion, and the name must not pretend otherwise: the runbook
    // counts `upload_outcome` TOTAL in Analytics Engine, and that includes
    // `arweave_error` and `arweave_throw` — a FAILED publication RAISES the
    // criterion's number. This row counts the driver's confirmed successes, a
    // LOAD target. It guarantees nothing about what AE will show: a success
    // means the emit branch was REACHED, not that the row was delivered —
    // `makeEmit` swallows write failures and AE samples. Twenty successes here
    // can still be fewer than twenty rows there, and then the criterion is not
    // met whatever this row says. Conversely twenty rows there satisfy the
    // volume criterion by definition while saying nothing about health.
    // The metrics are the verdict; the ledger is the plan.
    row('confirmed paid publications in the window (plan; criterion = upload_outcome in AE)', paidOutcomesInWindow(state), VOLUME.paidOutcomes),
  ];
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--paid' || a === '--count') { opts[a.slice(2)] = Number(rest[++i]); continue; }
    if (a === '--invite') { opts.invite = String(rest[++i] ?? ''); continue; }
    if (a === '--from' || a === '--to') { opts[a.slice(2)] = parseWhen(rest[++i]); continue; }
    if (a === '--txid') { opts.txid = String(rest[++i] ?? ''); continue; }
    if (a === '--evidence') { opts.evidence = String(rest[++i] ?? ''); continue; }
    if (mode === 'resolve' && i === 0 && !a.startsWith('--')) { opts.operationId = a; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    // The two passes that can reach a paid redrop, switchable off explicitly.
    // A verification run against the soak wallet has no other way to promise
    // it spends nothing: `--paid 0` bounds new publications and NOTHING else.
    if (a === '--no-recheck') { opts.noRecheck = true; continue; }
    if (a === '--no-legacy') { opts.noLegacy = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  for (const k of ['paid', 'count']) {
    if (k in opts && !(Number.isInteger(opts[k]) && opts[k] >= 0)) throw new Error(`--${k} must be a non-negative integer`);
  }
  for (const k of ['from', 'to']) {
    if (k in opts && !Number.isFinite(opts[k])) throw new Error(`--${k} must be an ISO date or epoch milliseconds`);
  }
  return { mode, opts };
}

/** `--from`/`--to`: ISO-8601 or epoch milliseconds → ms. */
export function parseWhen(raw) {
  if (raw === undefined) return NaN;
  if (/^\d{10,}$/.test(raw)) return Number(raw);
  return Date.parse(raw);
}

// ── IO ────────────────────────────────────────────────────────────────

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** Random UUIDv8 — the v3 note-id namespace (as smoke-v3.mjs). */
export function randomUuidV8() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function v3Tags(ownerHash, noteId) {
  return [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: '3' },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: ownerHash },
    { name: 'Note-Id', value: noteId },
  ];
}

/** Exported for the transport test: one send, `redirect: 'error'`, the echo. */
export async function makeSigner(privB64) {
  const priv = new Uint8Array(Buffer.from(privB64, 'base64'));
  if (priv.length !== 32) throw new Error('SMOKE_PRIVATE_KEY must be a base64 32-byte seed');
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  async function signedPost(origin, path, payload) {
    const body = JSON.stringify(payload);
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
    // ONE send, no retry, no redirect: a redirect would re-sign nothing and
    // could re-deliver a paid request; an automatic retry would be the double
    // send the ledger exists to prevent. `redirect: 'error'` makes a 3xx a
    // thrown send — an unknown outcome, like any other lost answer.
    const resp = await fetch(new URL(path, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Public-Key': pkB64, 'X-Signature': sig },
      body,
      redirect: 'error',
    });
    const text = await resp.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: resp.status, body: parsed, echo: resp.headers.get('X-Operation-Id') };
  }
  return {
    ownerHash,
    pkB64,
    upload(origin, note, extra = {}) {
      return signedPost(origin, '/upload', {
        data: JSON.stringify({ id: note.noteId, c: note.c, iv: note.iv }),
        tags: v3Tags(ownerHash, note.noteId),
        ownerHash,
        timestamp: Date.now(),
        ...extra,
      });
    },
    /** `/register` exactly as the client does it: signed body naming the key. */
    register(origin, inviteCode) {
      return signedPost(origin, '/register', { inviteCode, publicKey: pkB64, timestamp: Date.now() });
    },
  };
}

/**
 * Register the smoke identity on the target worker. With ADMIN_SECRET in the
 * environment a single-use invite is seeded first (a random code — its only
 * purpose is to be consumed by the very next request); otherwise `--invite`
 * must carry a code the operator already seeded. Nothing here is paid.
 */
async function registerKey({ origin, signer, inviteCode, adminSecret }) {
  let code = inviteCode;
  if (!code) {
    if (!adminSecret) { console.error('✗ register needs --invite <code> or ADMIN_SECRET'); return 2; }
    code = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    const resp = await fetch(new URL('/admin/seed-invite', origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminSecret}` },
      body: JSON.stringify({ codes: [code] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) { console.error(`✗ seed-invite: HTTP ${resp.status} ${(await resp.text()).slice(0, 160)}`); return 1; }
    log('  invite seeded');
  }
  const { status, body } = await signer.register(origin, code);
  if (status === 200 && body && body.ok === true) {
    log(`  PASS registered publicKey=${signer.pkB64} ownerHash=${signer.ownerHash}`);
    return 0;
  }
  console.error(`✗ register: HTTP ${status} ${JSON.stringify(body).slice(0, 160)}`);
  return 1;
}

export async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.version !== 1) throw new Error(`unsupported state version in ${path}`);
    return parsed;
  } catch (e) {
    if (e?.code === 'ENOENT') return emptyState();
    throw e;
  }
}

/**
 * ATOMIC, because this file is now written mid-run.
 *
 * The budget is charged before every request that could cost money, and each
 * charge rewrites the ledger. Writing in place means a process killed during
 * the write leaves a TRUNCATED JSON — and this file is the only record of the
 * five legacy fixtures, which cannot be recreated at all once D2 is live
 * (`seed-legacy` demands the pre-D2 worker). So: write a sibling temp file,
 * then rename over the original. A rename on the same filesystem either
 * happened or did not; an interrupted write leaves the temp file behind and
 * the ledger untouched.
 */
export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, path);
}

/**
 * An exclusive lock on the ledger, held for the WHOLE run.
 *
 * Saving before the send stops a crash from refunding the budget; it does
 * nothing about two processes. Both would read the same counters, plan the
 * same sends independently and write over each other — and the quotas that
 * exist to bound real AR would bound nothing. The daily scheduled task plus one
 * impatient manual run is not a hypothetical arrangement.
 *
 * `wx` fails if the file exists, which is the whole mechanism. A stale lock is
 * NOT broken automatically — that would restore the race it prevents — but the
 * refusal names the file, the pid and the age so the operator can decide.
 */
export async function acquireLedgerLock(statePath, now = Date.now()) {
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: now }) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let held = '(unreadable)';
    try {
      const raw = JSON.parse(await readFile(lockPath, 'utf8'));
      held = `pid ${raw.pid}, ${Math.round((now - raw.at) / 60_000)} min ago`;
    } catch { /* keep the placeholder */ }
    return {
      ok: false,
      reason: `another run holds the ledger (${held}). If no run is alive, delete ${lockPath}`,
      release: async () => {},
    };
  }
  return {
    ok: true,
    release: async () => { try { await rm(lockPath); } catch { /* already gone */ } },
  };
}

async function getJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await resp.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: resp.status, body };
}

async function confirmations(probeOrigin, txId) {
  try {
    const { status, body } = await getJson(new URL(`/tx/${txId}/status`, probeOrigin));
    return readConfirmations(status, body);
  } catch {
    return null;
  }
}

/**
 * Mirror the verifier's reads before spending the unproven budget: header AND
 * bytes from the probe origin, plus the confirmation floor. Returns a reason
 * string when not ready, null when it is.
 */
async function notVerifiableReason(probeOrigin, txId, opts) {
  const conf = await confirmations(probeOrigin, txId);
  if (conf === null) return 'status not yet visible';
  if (conf < opts.confirmationsRequired) return `${conf} confirmation(s), need ${opts.confirmationsRequired}`;
  try {
    const header = await getJson(new URL(`/tx/${txId}`, probeOrigin));
    if (!readTxHeaderOk(header.status, header.body, txId)) return `/tx header not served (HTTP ${header.status})`;
    const raw = await fetch(new URL(`/raw/${txId}`, probeOrigin), { signal: AbortSignal.timeout(10_000) });
    const bytes = raw.status === 200 ? (await raw.arrayBuffer()).byteLength : 0;
    if (bytes === 0) return `/raw bytes not served (HTTP ${raw.status})`;
  } catch (e) {
    return `probe failed: ${e?.message ?? e}`;
  }
  return null;
}

async function metricsReport(origin, secret, report, hours) {
  const resp = await fetch(new URL('/admin/metrics', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body: JSON.stringify({ report, hours }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: resp.status, body };
}

function log(line) { console.log(line); }

// ── Modes ─────────────────────────────────────────────────────────────

/** Exported for the budget tests: its publications cost AR like any other. */
export async function seedLegacy({ origin, signer, state, count, dryRun, opts, persist }) {
  const price = await getJson(`${opts.probeOrigin}/price/${opts.priceBytes}`);
  const cost = estimateCost(String(price.body), count);
  log(`seed-legacy: ${count} paid publication(s) on ${origin}`);
  log(`  price ≈ ${cost.perTxAr} AR each, ≈ ${cost.totalAr} AR total (arweave.net/price/${opts.priceBytes} = ${cost.perTxWinston} winston)`);
  if (dryRun) { log('  dry run — nothing sent'); return 0; }
  // These publications cost the same AR as any other and must sit under the
  // same limit. They used to be charged through `paidPosts`; since the budget
  // moved to ATTEMPTS they have to be charged here or they escape it entirely.
  if (needsAttemptsMigration(state)) {
    log('  STOP ledger predates the paid-attempt counter — run `soak-d2.mjs migrate-attempts` first');
    return 1;
  }

  // …and CHARGED is not the same as BOUNDED: `--count` alone would happily walk
  // past SOAK_MAX_PAID_TOTAL, so the remainder is what actually caps the pass.
  const spent = attemptsSpent(state);
  const planned = Math.max(0, Math.min(count, opts.maxPaidTotal - spent));
  if (planned < count) {
    log(`  ${count - planned} of ${count} held back: ${spent}/${opts.maxPaidTotal} of the paid limit is already spent`);
  }
  if (planned === 0) { log('  STOP the paid limit is spent — nothing sent'); return 1; }

  /** Outcome write, mirroring `dayRun`: an answer known but unrecorded is how
   *  a legacy fixture loses the txId that cannot be recreated afterwards. */
  const settle = async (attempt) => {
    try {
      if (persist) await persist();
      return true;
    } catch (e) {
      log(`  STOP ledger write failed after a legacy seed send (${e?.message ?? e}) — the attempt stays UNKNOWN`);
      return false;
    }
  };

  let failures = 0;
  // CONFIRMED successes only. Deriving this from `count - failures` counted
  // publications that an early `break` never even attempted.
  let seeded = 0;
  for (let i = 0; i < planned; i++) {
    const note = { noteId: randomUuidV8(), c: b64(crypto.getRandomValues(new Uint8Array(64))), iv: b64(crypto.getRandomValues(new Uint8Array(12))) };
    const op = newOperation(state, note.noteId, 'seed-legacy', Date.now());
    const attempt = newAttempt(note.noteId, op.at, 'seed-legacy', op.id);
    try {
      await chargeAttempt(state, attempt, persist);
    } catch (e) {
      log(`  STOP ledger write failed before a legacy seed send (${e?.message ?? e}) — nothing was sent`);
      failures++;
      break;
    }

    let answer;
    try {
      answer = await signer.upload(origin, note, { operationId: op.id });
    } catch (e) {
      recordThrow(op, e);
      quarantineNote(state, op, 'send threw');
      attempt.outcome = 'unknown';
      attempt.detail = String(e?.message ?? e);
      failures++;
      log(`  UNKNOWN legacy ${note.noteId}: ${attempt.detail} — may be published; never retried automatically`);
      await settle(attempt);
      break;
    }
    const { status, body } = answer;
    recordAnswer(op, answer);
    if (quarantines(op)) {
      quarantineNote(state, op, op.code ?? op.cls);
      attempt.outcome = 'unknown';
      attempt.detail = `${op.cls}${op.code ? ` (${op.code})` : ''} — ${op.detail ?? ''}`;
      failures++;
      log(`  UNKNOWN legacy ${note.noteId}: ${attempt.detail} — may be published; never retried automatically`);
      await settle(attempt);
      break;
    }

    const verdict = classifyUpload(status, body);
    if (verdict.kind === 'accepted-unattested') {
      state.notes.push({ ...note, kind: 'legacy', txId: body.txId, createdAt: Date.now(), dedupes: 0, rechecks: 0 });
      state.paidPosts += 1;
      seeded += 1;
      attempt.outcome = 'accepted-new'; attempt.txId = body.txId;
      log(`  PASS legacy ${note.noteId} → ${body.txId}`);
      // The publication happened AND the ledger refused it: `seeded` counts the
      // first, `failures` the second — both are true and neither is derived.
      if (!(await settle(attempt))) { failures++; break; }
    } else {
      failures++;
      attempt.outcome = 'error';
      attempt.detail = `${verdict.kind} — ${verdict.detail}`;
      log(`  FAIL legacy ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      if (!(await settle(attempt))) break;
      if (verdict.kind === 'rate-limited' || verdict.kind === 'not-registered') break;
    }
  }
  state.runs.push({ at: Date.now(), mode: 'seed-legacy', paid: seeded, failures, requested: count, planned });
  return failures;
}

/**
 * Exported for the budget-execution tests: `signer` and `persist` are both
 * injected, so a suite can prove that a failed ledger write stops a send
 * without a wallet, and without any network beyond the price quote.
 */
export async function dayRun({ origin, signer, state, opts, dryRun, persist }) {
  const now = Date.now();
  // A ledger written before the attempt counter existed may not be migrated
  // behind the operator's back: the historical attempt count is unknowable and
  // must not be reconstructed from `paidPosts`.
  if (needsAttemptsMigration(state)) {
    const why = 'ledger predates the paid-attempt counter — run `soak-d2.mjs migrate-attempts` first '
      + '(attempts before it are UNKNOWN and are NOT reconstructed from paidPosts)';
    log(`  STOP ${why}`);
    return finish(state, { at: now, mode: 'day', paid: 0, deduped: 0, rechecked: 0, legacyBackfilled: 0, problems: [`STOP: ${why}`] });
  }
  // An attempt left `pending` means a previous run died between the send and
  // the answer. It becomes `unknown`, keeps the limit it took, and is never
  // re-driven. The end-of-run save persists this; repeating it is harmless.
  for (const s of reconcilePendingAttempts(state, now)) {
    log(`  UNKNOWN paid ${s.noteId} from an earlier run — interrupted before the outcome was recorded; NOT retried`);
  }
  const plan = planRun(state, opts, now);
  const price = await getJson(`${opts.probeOrigin}/price/${opts.priceBytes}`);
  const cost = estimateCost(String(price.body), plan.paid);
  const sent = redropSends(state);
  log(`day: paid=${plan.paid} (≈ ${cost.totalAr} AR; ${plan.paidLeftAfter} left under SOAK_MAX_PAID_TOTAL=${opts.maxPaidTotal}), dedupe=${plan.dedupe.length}, recheck=${plan.recheck.length}, legacy candidates=${plan.legacyCandidates.length}`);
  log(`  redrop budget: recheck ${sent.recheck}/${opts.redropRecheckTotal}, legacy ${sent.legacy}/${opts.redropLegacyTotal} (sends that COULD cost a re-post)`);
  for (const why of plan.withheld) log(`  SKIP ${why}`);
  if (dryRun) { log('  dry run — nothing sent'); return 0; }

  /**
   * Charge the budget BEFORE the request leaves, and write the ledger with it.
   * The run's single save at the end is not enough: a process killed between
   * the send and that save would come back believing the budget untouched,
   * and the same money could be spent twice.
   */
  const charge = async (kind) => {
    try {
      await chargeBudget(state, kind, persist);
      return true;
    } catch (e) {
      // The ledger could not be made durable, so the budget would not bound
      // anything: a send charged only in memory is a send nobody can count
      // after a crash. Refuse to send rather than spend unrecorded money.
      stop(`ledger write failed before a ${kind} send (${e?.message ?? e}) — nothing was sent`);
      return false;
    }
  };

  const run = { at: now, mode: 'day', paid: 0, deduped: 0, rechecked: 0, legacyBackfilled: 0, problems: [] };
  const byId = new Map(state.notes.map(n => [n.noteId, n]));
  const stop = (why) => { run.problems.push(`STOP: ${why}`); log(`  STOP ${why}`); };

  /**
   * Write an attempt's OUTCOME. The attempt is already durable, so a failure
   * here cannot unbound the budget — but a ledger that cannot record what it
   * just did is not a ledger, and the record degrades to `unknown` on the next
   * load anyway. Stop rather than keep spending blind.
   */
  const settle = async (attempt) => {
    try {
      if (persist) await persist();
      return true;
    } catch (e) {
      stop(`ledger write failed after a paid send (${e?.message ?? e}) — the attempt stays UNKNOWN`);
      return false;
    }
  };

  /** Make an operation record durable BEFORE its request leaves — for the
   *  passes that charge no attempt. A record that cannot be written is a
   *  request nobody could join to the journal: refuse to send. */
  const persistOp = async (op) => {
    try {
      if (persist) await persist();
      return true;
    } catch (e) {
      stop(`ledger write failed before a ${op.pass} send (${e?.message ?? e}) — nothing was sent`);
      return false;
    }
  };

  // 1. New paid publications.
  for (let i = 0; i < plan.paid; i++) {
    const note = { noteId: randomUuidV8(), c: b64(crypto.getRandomValues(new Uint8Array(64))), iv: b64(crypto.getRandomValues(new Uint8Array(12))) };
    // Durable BEFORE the request leaves: a ledger that will not take the
    // attempt is a budget that bounds nothing, so refuse to send. The
    // operation record and the attempt share one id — the one the worker's
    // journal will hold.
    const op = newOperation(state, note.noteId, 'publish', Date.now());
    const attempt = newAttempt(note.noteId, op.at, 'day', op.id);
    try {
      await chargeAttempt(state, attempt, persist);
    } catch (e) {
      stop(`ledger write failed before a paid send (${e?.message ?? e}) — nothing was sent`);
      return finish(state, run);
    }

    let answer;
    try {
      answer = await signer.upload(origin, note, { operationId: op.id });
    } catch (e) {
      // The answer never arrived. The POST may or may not have happened, so
      // the money may or may not be spent — and NOTHING may re-send this
      // automatically. The attempt keeps the limit it took.
      //
      // This is a STOP, not a note: a scheduler that sees exit 0 here would
      // record a healthy run over a publication nobody can account for.
      recordThrow(op, e);
      quarantineNote(state, op, 'send threw');
      attempt.outcome = 'unknown';
      attempt.detail = String(e?.message ?? e);
      stop(`paid ${note.noteId}: UNKNOWN outcome (${attempt.detail}) — the publication may exist; it is never retried automatically and needs a human`);
      await settle(attempt);
      // Stop the pass too: the next send would be planned from a ledger that
      // does not know what the last one did.
      return finish(state, run);
    }
    const { status, body } = answer;
    recordAnswer(op, answer);
    if (quarantines(op)) {
      // An answer that leaves the send unknown — `arweave_post_unknown` (the
      // POST threw on the worker), `audit_unconfirmed` (a lost begin), an
      // unclassifiable body — is treated exactly like no answer: unknown,
      // quarantined, STOP. Never `error`: an error is a KNOWN failure.
      quarantineNote(state, op, op.code ?? op.cls);
      attempt.outcome = 'unknown';
      attempt.detail = `${op.cls}${op.code ? ` (${op.code})` : ''} — ${op.detail ?? ''}`;
      stop(`paid ${note.noteId}: UNKNOWN outcome (${attempt.detail}) — the publication may exist; it is never retried automatically and needs a human`);
      await settle(attempt);
      return finish(state, run);
    }

    const verdict = classifyUpload(status, body);
    if (verdict.kind === 'accepted-new') {
      const rec = { ...note, kind: 'paid', txId: body.txId, createdAt: Date.now(), dedupes: 0, rechecks: 0 };
      state.notes.push(rec); byId.set(rec.noteId, rec);
      state.paidPosts += 1; run.paid += 1;
      attempt.outcome = 'accepted-new'; attempt.txId = body.txId;
      log(`  PASS paid ${note.noteId} → ${body.txId}`);
      if (!(await settle(attempt))) return finish(state, run);
    } else {
      attempt.outcome = 'error';
      attempt.detail = `${verdict.kind} — ${verdict.detail}`;
      run.problems.push(`paid ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      log(`  FAIL paid ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      // Recorded BEFORE settle, so a failing ledger cannot swallow the verdict
      // that must read zero.
      if (verdict.kind === 'conflict') stop('id_payload_conflict on a FRESH id — investigate before any further run');
      const saved = await settle(attempt);
      if (verdict.kind === 'conflict' || !saved) return finish(state, run);
      if (verdict.kind === 'rate-limited' || verdict.kind === 'not-registered') break;
    }
  }

  // 2. Dedupe pass — the exact bytes the ledger holds, nothing else.
  for (const noteId of plan.dedupe) {
    const note = byId.get(noteId);
    const wantsRecheck = plan.recheck.includes(noteId);
    // A plain dedupe answers from the DO and cannot reach the redrop path; a
    // recheck asks the quorum and can. Only the latter is charged — but BOTH
    // are journaled before they leave: the verdict joins every send.
    if (wantsRecheck && !(await charge('recheck'))) return finish(state, run);
    const op = newOperation(state, noteId, wantsRecheck ? 'recheck' : 'dedupe', Date.now());
    if (!(await persistOp(op))) return finish(state, run);
    let answer;
    try {
      answer = await signer.upload(origin, note, { ...(wantsRecheck ? { recheck: true } : {}), operationId: op.id });
    } catch (e) {
      recordThrow(op, e);
      quarantineNote(state, op, 'send threw');
      stop(`${op.pass} ${noteId}: UNKNOWN outcome (${op.detail}) — the note is quarantined for the window`);
      return finish(state, run);
    }
    const { status, body } = answer;
    recordAnswer(op, answer);
    if (quarantines(op)) {
      quarantineNote(state, op, op.code ?? op.cls);
      stop(`${op.pass} ${noteId}: UNKNOWN outcome (${op.cls}${op.code ? ` ${op.code}` : ''}) — the note is quarantined for the window`);
      return finish(state, run);
    }
    const verdict = classifyUpload(status, body, note.txId);
    if (verdict.kind === 'deduped') {
      note.dedupes = (note.dedupes ?? 0) + 1; run.deduped += 1;
      if (wantsRecheck) { note.rechecks = (note.rechecks ?? 0) + 1; run.rechecked += 1; }
      log(`  PASS dedupe${wantsRecheck ? '+recheck' : ''} ${noteId} → ${body.txId}`);
    } else if (verdict.kind === 'conflict') {
      run.problems.push(`dedupe ${noteId}: ${verdict.detail}`);
      stop(`conflict on a re-sent identical payload (${noteId}) — this is the defect D2 exists to remove`);
      return finish(state, run);
    } else {
      run.problems.push(`dedupe ${noteId}: ${verdict.kind} — ${verdict.detail}`);
      log(`  SKIP dedupe ${noteId}: ${verdict.kind} — ${verdict.detail}`);
    }
  }

  // 3. Legacy pass — only a CONFIRMED transaction, or the unproven budget burns.
  for (const noteId of plan.legacyCandidates) {
    const note = byId.get(noteId);
    if (Date.now() - note.createdAt < opts.legacyMinAgeMs) {
      log(`  WAIT legacy ${noteId}: younger than ${Math.round(opts.legacyMinAgeMs / 60_000)} min`);
      continue;
    }
    const why = await notVerifiableReason(opts.probeOrigin, note.txId, opts);
    if (why) {
      log(`  WAIT legacy ${noteId}: ${why} on ${opts.probeOrigin}`);
      continue;
    }
    note.confirmedAt ??= Date.now();
    // Charged even though no `recheck` flag is involved: an unproven D9 whose
    // quorum reads `dead` reaches the paid re-post by its own path.
    if (!(await charge('legacy'))) return finish(state, run);
    const op = newOperation(state, noteId, 'legacy', Date.now());
    if (!(await persistOp(op))) return finish(state, run);
    let answer;
    try {
      answer = await signer.upload(origin, note, { operationId: op.id });
    } catch (e) {
      recordThrow(op, e);
      quarantineNote(state, op, 'send threw');
      stop(`legacy ${noteId}: UNKNOWN outcome (${op.detail}) — the note is quarantined for the window`);
      return finish(state, run);
    }
    const { status, body } = answer;
    recordAnswer(op, answer);
    if (quarantines(op)) {
      quarantineNote(state, op, op.code ?? op.cls);
      stop(`legacy ${noteId}: UNKNOWN outcome (${op.cls}${op.code ? ` ${op.code}` : ''}) — the note is quarantined for the window`);
      return finish(state, run);
    }
    const verdict = classifyUpload(status, body, note.txId);
    if (verdict.kind === 'deduped') {
      note.backfilledAt = Date.now(); note.dedupes = (note.dedupes ?? 0) + 1;
      run.legacyBackfilled += 1; run.deduped += 1;
      log(`  PASS legacy backfill ${noteId} → ${body.txId}`);
    } else if (verdict.kind === 'conflict') {
      run.problems.push(`legacy ${noteId}: ${verdict.detail}`);
      stop(`conflict on a legacy record (${noteId}) — legacy_not_ours / redrop_conflict must read zero`);
      return finish(state, run);
    } else if (verdict.kind === 'unavailable' && /authenticated/i.test(String(verdict.detail))) {
      state.unprovenSeen += 1;
      run.problems.push(`legacy ${noteId}: legacy_unproven (${verdict.detail})`);
      log(`  FAIL legacy ${noteId}: legacy_unproven — the window allows ONE; no further legacy attempts this run`);
      break;
    } else {
      run.problems.push(`legacy ${noteId}: ${verdict.kind} — ${verdict.detail}`);
      log(`  SKIP legacy ${noteId}: ${verdict.kind} — ${verdict.detail}`);
    }
  }

  // 4. Confirmations for paid notes, so tomorrow's recheck pass has candidates.
  for (const note of state.notes) {
    if (note.kind === 'paid' && !note.confirmedAt) {
      const conf = await confirmations(opts.probeOrigin, note.txId);
      if (conf !== null && conf >= opts.confirmationsRequired) note.confirmedAt = Date.now();
    }
  }

  return finish(state, run);
}

function finish(state, run) {
  state.runs.push(run);
  const hard = run.problems.filter(p => p.startsWith('STOP')).length;
  log(`  run: paid=${run.paid} deduped=${run.deduped} rechecked=${run.rechecked} legacyBackfilled=${run.legacyBackfilled} problems=${run.problems.length}`);
  return hard;
}

async function snapshot({ origin, secret, stateDir }) {
  const dir = join(stateDir, 'snapshots');
  await mkdir(dir, { recursive: true });
  const at = new Date();
  const out = { at: at.toISOString(), origin, reports: {} };
  // ALL four reports, not two. Workers Logs keeps at most SEVEN DAYS and a
  // soak window is exactly seven, so the beginning of the window can age out
  // on the day the window is judged. These dated files are the only copy that
  // outlives retention — a soak without them is a calendar, not a measurement.
  for (const report of ['semantic_idempotency', 'upload_outcomes', 'gateway_health', 'status_verdicts']) {
    for (const hours of [24, 168]) {
      const { status, body } = await metricsReport(origin, secret, report, hours);
      out.reports[`${report}_${hours}h`] = { status, body };
      const rows = status === 200 && body && Array.isArray(body.rows) ? body.rows : null;
      // Reports have different column names (outcome/kind/verdict), so the
      // line is built from whatever the row actually carries.
      const render = (r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(',');
      log(`  ${report} ${hours}h: ${rows ? (rows.length ? rows.map(render).join(' ') : 'no rows') : `HTTP ${status}`}`);
    }
  }
  const file = join(dir, `${at.toISOString().slice(0, 10)}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + '\n');
  log(`  snapshot kept: ${file}`);
}

function printStatus(state) {
  log(`state: origin=${state.origin ?? '-'} release=${state.release?.sha?.slice(0, 7) ?? '-'} versionId=${state.release?.workerVersionId ?? '-'}`);
  log(`notes: ${state.notes.length} (legacy ${state.notes.filter(n => n.kind === 'legacy').length}, paid ${state.notes.filter(n => n.kind === 'paid').length})`);
  // Three numbers, each counted DIRECTLY from its own source. The window and
  // seeding figures come from the durable attempt records; `paidPosts` is the
  // lifetime counter. Deriving any of them by subtraction would blame the
  // seeding for whatever the others failed to see.
  const inWindow = paidOutcomesInWindow(state);
  const seeded = seededPaid(state);
  log(`paid POSTs: ${inWindow} in the window (day) + ${seeded} seeding = ${inWindow + seeded} attributed; ${state.paidPosts} lifetime`);
  if (inWindow + seeded !== state.paidPosts) {
    log(`  ! ${state.paidPosts - inWindow - seeded} paid POST(s) are unattributed — records without a mode, or a counter written without one`);
  }
  const sent = redropSends(state);
  log(`redrop-capable sends: recheck ${sent.recheck}/${DEFAULTS.redropRecheckTotal}, legacy ${sent.legacy}/${DEFAULTS.redropLegacyTotal}`);
  // An unmigrated ledger must not read as "0 attempts" — that is exactly the
  // false reassurance this counter exists to remove.
  if (needsAttemptsMigration(state)) {
    log('paid attempts: NOT TRACKED — this ledger predates the counter; `day` refuses until `soak-d2.mjs migrate-attempts` is run');
  } else {
    const at = attemptsSummary(state);
    log(`paid attempts: ${at.total}/${DEFAULTS.maxPaidTotal} (accepted ${at.accepted}, error ${at.error}, unknown ${at.unknown}) — the budget charges ATTEMPTS, not successes`);
    if (at.priorEra?.attemptsUnknown) {
      log(`  ! attempts before ${new Date(at.priorEra.migratedAt).toISOString()} were never recorded; the budget counts ${at.priorEra.knownSuccesses} known successes as a LOWER BOUND — the real figure may be higher`);
    }
    if (at.unknown) log(`  ! ${at.unknown} attempt(s) with an UNKNOWN outcome — each may be published; none is retried automatically`);
  }
  for (const row of summarize(state)) log(`  ${row.ok ? 'OK  ' : '    '} ${row.name}: ${row.have}/${row.need}`);
  const stops = state.runs.flatMap(r => (r.problems ?? []).filter(p => p.startsWith('STOP')));
  if (stops.length) { log('STOP markers in the ledger — the soak is NOT green:'); for (const s of stops) log(`  ${s}`); }
  // The driver's book: unknown sends by pass, and the quarantine. Either one
  // makes a verdict impossible until `reconcile` has read the journal.
  const ops = state.operations ?? [];
  const unknownByPass = {};
  for (const o of ops) {
    if (o.outcome === 'unknown' || o.outcome === 'pending' || o.cls === 'delivery_unknown') unknownByPass[o.pass] = (unknownByPass[o.pass] ?? 0) + 1;
  }
  const unknownTotal = Object.values(unknownByPass).reduce((a, b) => a + b, 0);
  log(`operations: ${ops.length} sent; unknown ${unknownTotal}${unknownTotal ? ` (${Object.entries(unknownByPass).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  const q = state.quarantine ?? [];
  if (q.length) { log(`quarantine: ${q.length} note(s) out of every pass for the window:`); for (const e of q) log(`  ${e.noteId} since ${new Date(e.since).toISOString()} — ${e.reason}`); }
  if (unknownTotal || q.length) log('  ! a verdict is IMPOSSIBLE from this ledger alone — run `reconcile` against the journal');
  const last = (state.reconcile ?? []).at(-1);
  if (last) log(`last reconcile: ${new Date(last.at).toISOString()} window ${new Date(last.window.t0).toISOString()}…${new Date(last.window.t1).toISOString()} → ${last.verdict}`);
}

// ── reconcile / resolve ───────────────────────────────────────────────

async function adminOps(origin, secret, payload) {
  const resp = await fetch(new URL('/admin/ops', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (resp.status !== 200 || !body || typeof body !== 'object') {
    throw new Error(`/admin/ops HTTP ${resp.status} ${String(text).slice(0, 160)}`);
  }
  return body;
}

/** The whole slice, page by page, plus the worker identity it was read under. */
export async function fetchJournalSlice(fetchOps, ownerPk, from, to) {
  const ops = [];
  let cursor;
  let identity = null;
  for (;;) {
    const page = await fetchOps({ ownerPk, from, to, limit: 500, ...(cursor ? { cursor } : {}) });
    identity ??= { workerVersionId: page.workerVersionId ?? null, releaseSha: page.releaseSha ?? null };
    if (page.workerVersionId !== identity.workerVersionId) throw new Error('worker version changed while reading the journal — read again');
    ops.push(...(page.ops ?? []));
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return { ops, identity };
}

/**
 * One reconcile pass (§6–§7), IO-free apart from `fetchOps`: reads the slice
 * and the point reads, records the observation, joins, decides the wait and
 * — when the policy is defined and the wait settled — the verdict.
 */
export async function reconcileWindow({ state, fetchOps, ownerPk, from, to, policy, now = Date.now() }) {
  const readUntil = now;
  const { ops: slice, identity } = await fetchJournalSlice(fetchOps, ownerPk, Math.max(0, from - 5 * 60_000), readUntil);
  const byId = new Map(slice.map(s => [s.id, s]));
  const driverOps = operationsIn(state, from, to);
  // Point reads for every driver record the slice does not show: a refused
  // send must be absent, an unknown delivery may have a record.
  for (const d of driverOps) {
    if (byId.has(d.id)) continue;
    if (d.cls !== 'refused' && d.cls !== 'delivery_unknown' && d.outcome !== 'unknown') continue;
    const one = await fetchOps({ ownerPk, operationId: d.id });
    if (one?.op) byId.set(d.id, one.op);
  }
  // Only operations BEGUN inside the window are the window's; the wider read
  // exists so a late finish or a foreign operation is not missed.
  const serverOps = [...byId.values()].filter(s => s.beganAt >= from - 5 * 60_000 && s.beganAt <= readUntil);

  const key = `${from}-${to}`;
  state.reconcileObservations ??= {};
  const observations = state.reconcileObservations[key] ??= [];
  const unfinished = serverOps.filter(s => s.status !== 'finished').map(s => s.id).sort();
  observations.push({ at: now, unfinished });
  const driverTerminal = driverOps.every(o => o.outcome === 'answered' || o.outcome === 'unknown');
  const wait = processingWait({ t1: to, observations, driverTerminal, now });

  const windowVersionId = state.release?.workerVersionId ?? identity.workerVersionId;
  const { rows, versionMismatch } = joinBooks({ driverOps, serverOps, resolutions: state.resolutions ?? {}, windowVersionId, now });

  const policyCheck = validatePolicy(policy);
  let verdictName;
  let failures = [];
  if (versionMismatch) {
    verdictName = 'red';
    failures = [`version_mismatch: journal record ${versionMismatch.operationId} carries ${versionMismatch.seen}, window is ${versionMismatch.expected}`];
  } else if (!policyCheck.ok) {
    verdictName = 'withheld';
    failures = [`acceptance policy undefined — missing: ${policyCheck.missing.join(', ')}`];
  } else if (wait.outcome === 'waiting') {
    verdictName = 'withheld';
    failures = [`processing wait: ${wait.reason}`];
  } else {
    const v = decideVerdict({ rows, wait, policy, window: { t0: from, t1: to }, resolutions: state.resolutions ?? {}, now });
    verdictName = v.green ? 'green' : 'red';
    failures = v.failures;
  }
  const records = Object.fromEntries(serverOps.map(s => [s.id, s]));
  const report = {
    at: now, window: { t0: from, t1: to }, identity, windowVersionId, wait, verdict: verdictName, failures,
    classes: countBy(rows.map(r => r.cls)),
    rows: rows.map(r => ({ operationId: r.operationId, cls: r.cls, red: r.red, detail: r.detail })),
    unfinished,
    records,
  };
  state.reconcile ??= [];
  state.reconcile.push(report);
  return report;
}

function countBy(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

async function loadPolicy(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, 'acceptance-policy.json'), 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function main(argv) {
  const { mode, opts: cli } = parseArgs(argv);
  const opts = {
    ...DEFAULTS,
    paidPerRun: cli.paid ?? DEFAULTS.paidPerRun,
    maxPaidTotal: Number(process.env.SOAK_MAX_PAID_TOTAL ?? DEFAULTS.maxPaidTotal),
    probeOrigin: process.env.SOAK_PROBE_ORIGIN ?? DEFAULTS.probeOrigin,
    redropRecheckTotal: Number(process.env.SOAK_REDROP_RECHECK_TOTAL ?? DEFAULTS.redropRecheckTotal),
    redropLegacyTotal: Number(process.env.SOAK_REDROP_LEGACY_TOTAL ?? DEFAULTS.redropLegacyTotal),
    noRecheck: cli.noRecheck === true,
    noLegacy: cli.noLegacy === true,
  };
  const statePath = process.env.SOAK_STATE ?? join(homedir(), '.eternal-notes-soak', 'state.json');

  // `status` only reads, and refusing it because a run is in flight would be
  // hostile for no gain. Everything else takes the lock BEFORE reading the
  // ledger: planning from a snapshot another process is already spending is
  // exactly how two runs both believe the budget is theirs.
  if (mode === 'status') { printStatus(await loadState(statePath)); return 0; }

  const lock = await acquireLedgerLock(statePath);
  if (!lock.ok) { console.error(`✗ ${lock.reason}`); return 2; }
  try {
    return await run();
  } finally {
    await lock.release();
  }

  async function run() {
  const state = await loadState(statePath);
  if (mode === 'migrate-attempts') {
    const res = migrateAttempts(state, Date.now());
    if (res.migrated) {
      log(`migrated: ${res.knownSuccesses} known successes recorded as the LOWER BOUND for the era before the counter existed`);
      log('attempts before this point are UNKNOWN and were NOT reconstructed from paidPosts; the limit stays in force unchanged');
    } else {
      log('the attempt ledger is already in place — nothing to migrate');
    }
    await saveState(statePath, state);
    printStatus(state);
    return 0;
  }
  if (mode === 'resolve') {
    const res = applyResolve(state, cli.operationId, { txId: cli.txid, evidence: cli.evidence }, Date.now());
    if (!res.ok) { console.error(`✗ resolve: ${res.reason}`); return 2; }
    await saveState(statePath, state);
    log(`resolved ${cli.operationId}: publication ${cli.txid} confirmed by the operator — journal unchanged, note stays quarantined; re-run reconcile`);
    return 0;
  }
  if (!['register', 'seed-legacy', 'day', 'snapshot', 'reconcile'].includes(mode)) {
    console.error('usage: soak-d2.mjs <register [--invite CODE] | seed-legacy --count N | day [--paid N] | snapshot | status | migrate-attempts | reconcile --from T --to T | resolve <operationId> --txid T --evidence "…"> [--dry-run]');
    return 2;
  }

  const target = classifySmokeTarget(process.env.SMOKE_URL ?? AUTO_ALLOWED_WORKER_ORIGINS[0], process.env.SMOKE_ALLOW_ORIGIN);
  if (!target.ok) { console.error(`✗ ${target.reason}`); return 2; }
  if (target.warning) console.warn(`⚠ ${target.warning}`);
  const origin = target.origin;
  if (state.origin && state.origin !== origin) { console.error(`✗ state file belongs to ${state.origin}, target is ${origin}`); return 2; }

  const health = (await getJson(new URL('/health', origin))).body;
  if (mode === 'register') {
    const privB64 = process.env.SMOKE_PRIVATE_KEY;
    if (!privB64) { console.error('✗ SMOKE_PRIVATE_KEY is required'); return 2; }
    const signer = await makeSigner(privB64);
    log(`register: ${signer.pkB64} on ${origin}`);
    return registerKey({ origin, signer, inviteCode: cli.invite, adminSecret: process.env.ADMIN_SECRET });
  }
  // `reconcile` reads; it must work with the kill switches OFF (that is when
  // a window is most likely being judged), so it goes before the gate.
  if (mode === 'reconcile') {
    const secret = process.env.METRICS_ADMIN_SECRET;
    if (!secret) { console.error('✗ METRICS_ADMIN_SECRET is required for reconcile'); return 2; }
    if (!(cli.from >= 0) || !(cli.to >= cli.from)) { console.error('✗ reconcile needs --from and --to (ISO or epoch ms), to >= from'); return 2; }
    const ownerPk = state.ownerPk ?? (process.env.SMOKE_PRIVATE_KEY ? (await makeSigner(process.env.SMOKE_PRIVATE_KEY)).pkB64 : null);
    if (!ownerPk) { console.error('✗ the ledger holds no ownerPk yet and SMOKE_PRIVATE_KEY is unset — nothing to address the journal by'); return 2; }
    const policy = await loadPolicy(dirname(statePath));
    const report = await reconcileWindow({
      state, ownerPk, from: cli.from, to: cli.to, policy,
      fetchOps: (payload) => adminOps(origin, secret, payload),
    });
    await saveState(statePath, state);
    const dir = join(dirname(statePath), 'snapshots');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `reconcile-${new Date(report.at).toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    log(`reconcile: window ${new Date(report.window.t0).toISOString()} … ${new Date(report.window.t1).toISOString()} on ${report.identity.workerVersionId ?? '?'}`);
    log(`  wait: ${report.wait.outcome}${report.wait.reason ? ` (${report.wait.reason})` : ''}; unfinished journal records: ${report.unfinished.length}`);
    log(`  classes: ${Object.entries(report.classes).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
    for (const r of report.rows.filter(r => r.red)) log(`  RED ${r.cls} ${r.operationId} — ${r.detail}`);
    for (const f of report.failures) log(`  ${report.verdict === 'withheld' ? 'WITHHELD' : 'FAIL'} ${f}`);
    log(`  verdict: ${report.verdict.toUpperCase()}; report kept: ${file}`);
    return report.verdict === 'green' ? 0 : report.verdict === 'red' ? 1 : 3;
  }
  const gate = checkReleaseGate(health, mode, state, process.env.SOAK_RELEASE_SHA);
  if (!gate.ok) { console.error('✗ release gate:'); for (const p of gate.problems) console.error(`  - ${p}`); return 2; }

  if (mode === 'snapshot') {
    const secret = process.env.METRICS_ADMIN_SECRET;
    if (!secret) { console.error('✗ METRICS_ADMIN_SECRET is required for snapshot'); return 2; }
    await snapshot({ origin, secret, stateDir: dirname(statePath) });
    return 0;
  }

  const privB64 = process.env.SMOKE_PRIVATE_KEY;
  if (!privB64) { console.error('✗ SMOKE_PRIVATE_KEY is required'); return 2; }
  const signer = await makeSigner(privB64);
  if (state.ownerHash && state.ownerHash !== signer.ownerHash) { console.error('✗ state file belongs to another smoke identity'); return 2; }
  state.origin = origin;
  state.ownerHash = signer.ownerHash;
  state.ownerPk = signer.pkB64;

  let failures;
  if (mode === 'seed-legacy') {
    const count = cli.count ?? 5;
    failures = await seedLegacy({ origin, signer, state, count, dryRun: cli.dryRun, opts, persist: cli.dryRun ? null : () => saveState(statePath, state) });
  } else {
    state.release ??= { sha: health.releaseSha, workerVersionId: health.workerVersionId, firstSeenAt: Date.now() };
    failures = await dayRun({
      origin, signer, state, opts, dryRun: cli.dryRun,
      // Lets the run write the ledger BEFORE a request that could cost money,
      // instead of trusting the single save at the end to survive a crash.
      persist: cli.dryRun ? null : () => saveState(statePath, state),
    });
    if (!cli.dryRun && process.env.METRICS_ADMIN_SECRET) {
      await snapshot({ origin, secret: process.env.METRICS_ADMIN_SECRET, stateDir: dirname(statePath) });
    }
  }
  if (!cli.dryRun) await saveState(statePath, state);
  printStatus(state);
  return failures ? 1 : 0;
  }
}

if (process.argv[1]?.endsWith('soak-d2.mjs')) {
  // Set the code, do not `process.exit`: a live timer at exit trips a libuv
  // assertion on Windows and reports 127 for a run that passed.
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(err); process.exitCode = 1; });
}
