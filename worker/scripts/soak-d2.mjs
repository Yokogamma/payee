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
 *                           script's own ledger (the metrics are the truth —
 *                           this is the plan, not the verdict).
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
 *   METRICS_ADMIN_SECRET  optional; enables `snapshot`
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
  };
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
  const paidLeft = Math.max(0, opts.maxPaidTotal - state.paidPosts);
  const paid = Math.max(0, Math.min(opts.paidPerRun, paidLeft));

  const comparable = state.notes.filter(n => n.kind === 'paid' || n.backfilledAt);
  const dedupe = [...comparable]
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
    .filter(n => n.kind === 'legacy' && !n.backfilledAt)
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
    row('paid outcomes', state.paidPosts, VOLUME.paidOutcomes),
  ];
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--paid' || a === '--count') { opts[a.slice(2)] = Number(rest[++i]); continue; }
    if (a === '--invite') { opts.invite = String(rest[++i] ?? ''); continue; }
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
  return { mode, opts };
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

async function makeSigner(privB64) {
  const priv = new Uint8Array(Buffer.from(privB64, 'base64'));
  if (priv.length !== 32) throw new Error('SMOKE_PRIVATE_KEY must be a base64 32-byte seed');
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  async function signedPost(origin, path, payload) {
    const body = JSON.stringify(payload);
    const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), priv));
    const resp = await fetch(new URL(path, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Public-Key': pkB64, 'X-Signature': sig },
      body,
    });
    const text = await resp.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: resp.status, body: parsed };
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

async function seedLegacy({ origin, signer, state, count, dryRun, opts }) {
  const price = await getJson(`${opts.probeOrigin}/price/${opts.priceBytes}`);
  const cost = estimateCost(String(price.body), count);
  log(`seed-legacy: ${count} paid publication(s) on ${origin}`);
  log(`  price ≈ ${cost.perTxAr} AR each, ≈ ${cost.totalAr} AR total (arweave.net/price/${opts.priceBytes} = ${cost.perTxWinston} winston)`);
  if (dryRun) { log('  dry run — nothing sent'); return 0; }

  let failures = 0;
  for (let i = 0; i < count; i++) {
    const note = { noteId: randomUuidV8(), c: b64(crypto.getRandomValues(new Uint8Array(64))), iv: b64(crypto.getRandomValues(new Uint8Array(12))) };
    const { status, body } = await signer.upload(origin, note);
    const verdict = classifyUpload(status, body);
    if (verdict.kind === 'accepted-unattested') {
      state.notes.push({ ...note, kind: 'legacy', txId: body.txId, createdAt: Date.now(), dedupes: 0, rechecks: 0 });
      state.paidPosts += 1;
      log(`  PASS legacy ${note.noteId} → ${body.txId}`);
    } else {
      failures++;
      log(`  FAIL legacy ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      if (verdict.kind === 'rate-limited' || verdict.kind === 'not-registered') break;
    }
  }
  state.runs.push({ at: Date.now(), mode: 'seed-legacy', paid: count - failures, failures });
  return failures;
}

/**
 * Exported for the budget-execution tests: `signer` and `persist` are both
 * injected, so a suite can prove that a failed ledger write stops a send
 * without a wallet, and without any network beyond the price quote.
 */
export async function dayRun({ origin, signer, state, opts, dryRun, persist }) {
  const now = Date.now();
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

  // 1. New paid publications.
  for (let i = 0; i < plan.paid; i++) {
    const note = { noteId: randomUuidV8(), c: b64(crypto.getRandomValues(new Uint8Array(64))), iv: b64(crypto.getRandomValues(new Uint8Array(12))) };
    const { status, body } = await signer.upload(origin, note);
    const verdict = classifyUpload(status, body);
    if (verdict.kind === 'accepted-new') {
      const rec = { ...note, kind: 'paid', txId: body.txId, createdAt: Date.now(), dedupes: 0, rechecks: 0 };
      state.notes.push(rec); byId.set(rec.noteId, rec);
      state.paidPosts += 1; run.paid += 1;
      log(`  PASS paid ${note.noteId} → ${body.txId}`);
    } else {
      run.problems.push(`paid ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      log(`  FAIL paid ${note.noteId}: ${verdict.kind} — ${verdict.detail}`);
      if (verdict.kind === 'conflict') { stop('id_payload_conflict on a FRESH id — investigate before any further run'); return finish(state, run); }
      if (verdict.kind === 'rate-limited' || verdict.kind === 'not-registered') break;
    }
  }

  // 2. Dedupe pass — the exact bytes the ledger holds, nothing else.
  for (const noteId of plan.dedupe) {
    const note = byId.get(noteId);
    const wantsRecheck = plan.recheck.includes(noteId);
    // A plain dedupe answers from the DO and cannot reach the redrop path; a
    // recheck asks the quorum and can. Only the latter is charged.
    if (wantsRecheck && !(await charge('recheck'))) return finish(state, run);
    const { status, body } = await signer.upload(origin, note, wantsRecheck ? { recheck: true } : {});
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
    const { status, body } = await signer.upload(origin, note);
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
  for (const report of ['semantic_idempotency', 'upload_outcomes']) {
    for (const hours of [24, 168]) {
      const { status, body } = await metricsReport(origin, secret, report, hours);
      out.reports[`${report}_${hours}h`] = { status, body };
      const rows = status === 200 && body && Array.isArray(body.rows) ? body.rows : null;
      log(`  ${report} ${hours}h: ${rows ? (rows.length ? rows.map(r => `${r.outcome}=${r.n}`).join(' ') : 'no rows') : `HTTP ${status}`}`);
    }
  }
  const file = join(dir, `${at.toISOString().slice(0, 10)}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + '\n');
  log(`  snapshot kept: ${file}`);
}

function printStatus(state) {
  log(`state: origin=${state.origin ?? '-'} release=${state.release?.sha?.slice(0, 7) ?? '-'} versionId=${state.release?.workerVersionId ?? '-'}`);
  log(`notes: ${state.notes.length} (legacy ${state.notes.filter(n => n.kind === 'legacy').length}, paid ${state.notes.filter(n => n.kind === 'paid').length}); paid POSTs total: ${state.paidPosts}`);
  const sent = redropSends(state);
  log(`redrop-capable sends: recheck ${sent.recheck}/${DEFAULTS.redropRecheckTotal}, legacy ${sent.legacy}/${DEFAULTS.redropLegacyTotal}`);
  for (const row of summarize(state)) log(`  ${row.ok ? 'OK  ' : '    '} ${row.name}: ${row.have}/${row.need}`);
  const stops = state.runs.flatMap(r => (r.problems ?? []).filter(p => p.startsWith('STOP')));
  if (stops.length) { log('STOP markers in the ledger — the soak is NOT green:'); for (const s of stops) log(`  ${s}`); }
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
  if (!['register', 'seed-legacy', 'day', 'snapshot'].includes(mode)) {
    console.error('usage: soak-d2.mjs <register [--invite CODE] | seed-legacy --count N | day [--paid N] | snapshot | status> [--dry-run]');
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

  let failures;
  if (mode === 'seed-legacy') {
    const count = cli.count ?? 5;
    failures = await seedLegacy({ origin, signer, state, count, dryRun: cli.dryRun, opts });
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
