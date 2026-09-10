import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import {
  LEGACY_RELEASE_SHA, DEFAULTS, VOLUME,
  emptyState, checkReleaseGate, planRun, classifyUpload, readConfirmations, readTxHeaderOk,
  estimateCost, summarize, parseArgs, randomUuidV8, v3Tags,
  redropSends, chargeBudget, acquireLedgerLock, saveState, loadState, dayRun,
  newAttempt, paidAttempts, attemptsSpent, attemptsSummary, chargeAttempt,
  seedLegacy, paidOutcomesInWindow,
  needsAttemptsMigration, migrateAttempts, reconcilePendingAttempts,
} from './soak-d2.mjs';

const NEW_SHA = '5881da2ab1ce7ff6bc51d7ebb9794fddae254896';
const VERSION_ID = '11111111-2222-3333-4444-555555555555';
const TX = 'A'.repeat(43);
const TX2 = 'B'.repeat(43);

const oldHealth = (over = {}) => ({
  ok: true, uploads: true, v3Uploads: true, v4Uploads: true,
  releaseSha: LEGACY_RELEASE_SHA, workerVersionId: '222ea2c1-37f5-4eb1-bdcc-457a1db56b5e', ...over,
});
const newHealth = (over = {}) => ({
  ok: true, uploads: true, v3Uploads: true, v4Uploads: true, semanticIdempotency: 1,
  releaseSha: NEW_SHA, workerVersionId: VERSION_ID, ...over,
});

const note = (over) => ({ noteId: randomUuidV8(), c: 'c', iv: 'iv', txId: TX, kind: 'paid', createdAt: 0, dedupes: 0, rechecks: 0, ...over });

describe('checkReleaseGate', () => {
  // A note seeded on the fingerprinting worker is not legacy: the run would
  // pass and prove nothing. The gate is what keeps that money from moving.
  it('seed-legacy accepts only the pre-D2 worker', () => {
    expect(checkReleaseGate(oldHealth(), 'seed-legacy', emptyState()).ok).toBe(true);
    const r = checkReleaseGate(newHealth(), 'seed-legacy', emptyState());
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/pre-D2/);
    expect(r.problems.join(' ')).toMatch(/already fingerprints/);
  });

  it('day requires the release under soak and the marker', () => {
    expect(checkReleaseGate(newHealth(), 'day', emptyState(), NEW_SHA).ok).toBe(true);
    expect(checkReleaseGate(newHealth(), 'day', emptyState(), undefined).problems.join(' ')).toMatch(/SOAK_RELEASE_SHA/);
    expect(checkReleaseGate(oldHealth(), 'day', emptyState(), NEW_SHA).problems.join(' ')).toMatch(/semanticIdempotency/);
    expect(checkReleaseGate(newHealth({ releaseSha: 'f'.repeat(40) }), 'day', emptyState(), NEW_SHA).problems.join(' ')).toMatch(/not the release under soak/);
  });

  // The runbook: 168 continuous hours on ONE worker version id. A redeploy of
  // the same SHA is a new window, and the ledger must not quietly continue.
  it('day refuses a changed workerVersionId', () => {
    const state = { ...emptyState(), release: { sha: NEW_SHA, workerVersionId: 'other' } };
    const r = checkReleaseGate(newHealth(), 'day', state, NEW_SHA);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/window has reset/);
  });

  it('refuses switched-off uploads in every mode', () => {
    expect(checkReleaseGate(newHealth({ uploads: false }), 'day', emptyState(), NEW_SHA).problems.join(' ')).toMatch(/switched off/);
    expect(checkReleaseGate(oldHealth({ v3Uploads: false }), 'seed-legacy', emptyState()).problems.join(' ')).toMatch(/v3 uploads/);
  });
});

describe('planRun', () => {
  const opts = { ...DEFAULTS, paidPerRun: 3, maxPaidTotal: 5, dedupePerRun: 2, legacyPerRun: 1 };

  // The budget charges ATTEMPTS. `paidPosts` counts successes and is
  // deliberately NOT the basis: 5 successes after 6 attempts means the sixth
  // spent AR too, and a limit that cannot see it bounds nothing.
  const attempted = (n) => ({
    ...emptyState(),
    paidAttempts: {
      records: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, at: 0, noteId: `n${i}`, outcome: 'accepted-new' })),
      priorEra: null,
    },
  });

  it('bounds paid publications per run AND per soak, counting attempts', () => {
    expect(planRun(attempted(0), opts, 0).paid).toBe(3);
    expect(planRun(attempted(4), opts, 0)).toMatchObject({ paid: 1, paidLeftAfter: 0 });
    expect(planRun(attempted(5), opts, 0).paid).toBe(0);
    expect(planRun(attempted(9), opts, 0).paid).toBe(0);
  });

  // The reason the counter exists at all: a failure and a lost answer cost the
  // same AR as a success and must bound the plan identically.
  it('a failed or unanswered attempt consumes the limit exactly like a success', () => {
    const mixed = {
      ...emptyState(),
      paidPosts: 1,
      paidAttempts: {
        records: [
          { id: 'a', at: 0, noteId: 'n1', outcome: 'accepted-new' },
          { id: 'b', at: 0, noteId: 'n2', outcome: 'error' },
          { id: 'c', at: 0, noteId: 'n3', outcome: 'unknown' },
          { id: 'd', at: 0, noteId: 'n4', outcome: 'pending' },
        ],
        priorEra: null,
      },
    };
    // `paidPosts` says 1. The budget must still see 4 spent.
    expect(planRun(mixed, opts, 0)).toMatchObject({ paid: 1, paidLeftAfter: 0 });
  });

  it('dedupes the least-re-sent comparable notes first and never an unbackfilled legacy', () => {
    const a = note({ noteId: 'a', dedupes: 3 });
    const b = note({ noteId: 'b', dedupes: 0 });
    const c = note({ noteId: 'c', dedupes: 1 });
    const legacy = note({ noteId: 'l', kind: 'legacy' });
    const done = note({ noteId: 'd', kind: 'legacy', backfilledAt: 1, dedupes: 0 });
    const plan = planRun({ ...emptyState(), notes: [a, b, c, legacy, done] }, opts, 0);
    expect(plan.dedupe).toEqual(['b', 'd']);
    expect(plan.dedupe).not.toContain('l');
  });

  // A recheck asks the status quorum; a young transaction is `pending` and the
  // worker defers without a decision — a request that measures nothing.
  it('rechecks only confirmed notes older than the minimum age', () => {
    const now = 100 * 3_600_000;
    const young = note({ noteId: 'y', createdAt: now - 3_600_000, confirmedAt: now });
    const oldUnconfirmed = note({ noteId: 'u', createdAt: 0 });
    const oldConfirmed = note({ noteId: 'o', createdAt: 0, confirmedAt: 1 });
    const plan = planRun({ ...emptyState(), notes: [young, oldUnconfirmed, oldConfirmed] }, { ...opts, dedupePerRun: 10 }, now);
    expect(plan.recheck).toEqual(['o']);
  });

  it('names legacy candidates oldest first, capped', () => {
    const l1 = note({ noteId: 'l1', kind: 'legacy', createdAt: 5 });
    const l2 = note({ noteId: 'l2', kind: 'legacy', createdAt: 1 });
    const l3 = note({ noteId: 'l3', kind: 'legacy', createdAt: 3, backfilledAt: 9 });
    expect(planRun({ ...emptyState(), notes: [l1, l2, l3] }, opts, 0).legacyCandidates).toEqual(['l2']);
  });

  // ── The redrop budget ──
  //
  // `--paid N` bounds new publications and NOTHING else. A recheck whose
  // quorum reads `dead` goes to a PAID re-post, and so does a legacy attempt
  // whose D9 is unproven — neither is counted by `paidPosts`. The lever is
  // not sending the request, so the budget counts SENDS.
  describe('redrop budget', () => {
    const ready = (n) => Array.from({ length: n }, (_, i) =>
      note({ noteId: `r${i}`, createdAt: 0, confirmedAt: 1, dedupes: i }));
    const legacies = (n) => Array.from({ length: n }, (_, i) =>
      note({ noteId: `l${i}`, kind: 'legacy', createdAt: i }));
    const wide = { ...DEFAULTS, dedupePerRun: 8, recheckPerRun: 3, legacyPerRun: 2 };
    const now = 100 * 3_600_000;

    it('caps rechecks per run — dedupePerRun is 8, and 8 would eat the window', () => {
      const plan = planRun({ ...emptyState(), notes: ready(8) }, wide, now);
      expect(plan.recheck).toHaveLength(3);
      expect(plan.dedupe).toHaveLength(8);          // the cheap pass is untouched
      expect(plan.withheld.join(' ')).toMatch(/recheck: 5 of 8 held back/);
    });

    it('stops rechecking once the WINDOW quota is spent', () => {
      const state = { ...emptyState(), notes: ready(8), redropSends: { recheck: 12, legacy: 0 } };
      expect(planRun(state, wide, now).recheck).toEqual([]);
    });

    it('the legacy reserve is NOT borrowable: a spent recheck quota leaves it whole', () => {
      const state = {
        ...emptyState(),
        notes: [...ready(8), ...legacies(3)],
        redropSends: { recheck: 12, legacy: 0 },
      };
      const plan = planRun(state, wide, now);
      expect(plan.recheck).toEqual([]);
      expect(plan.legacyCandidates).toEqual(['l0', 'l1']);   // the three backfills stay reachable
    });

    it('stops legacy attempts once the reserve is spent', () => {
      const state = { ...emptyState(), notes: legacies(3), redropSends: { recheck: 0, legacy: 8 } };
      const plan = planRun(state, wide, now);
      expect(plan.legacyCandidates).toEqual([]);
      expect(plan.withheld.join(' ')).toMatch(/legacy: 3 of 3 held back/);
    });

    it('--no-recheck and --no-legacy hold both passes back, loudly', () => {
      const state = { ...emptyState(), notes: [...ready(8), ...legacies(3)] };
      const plan = planRun(state, { ...wide, noRecheck: true, noLegacy: true }, now);
      expect(plan.recheck).toEqual([]);
      expect(plan.legacyCandidates).toEqual([]);
      expect(plan.dedupe).toHaveLength(8);          // plain dedupe cannot redrop
      expect(plan.withheld).toHaveLength(2);
    });

    it('a ledger written before the counters existed reads as zero, not NaN', () => {
      const legacyLedger = { ...emptyState(), notes: legacies(1) };
      delete legacyLedger.redropSends;
      expect(planRun(legacyLedger, wide, now).legacyCandidates).toEqual(['l0']);
    });
  });
});

describe('classifyUpload', () => {
  const ok = (over = {}) => ({ txId: TX, status: 'accepted', committed: true, deduped: false, semanticIdempotency: 1, ...over });

  it('names a fresh paid publication', () => {
    expect(classifyUpload(200, ok()).kind).toBe('accepted-new');
  });

  it('names a dedupe onto the ledger txId', () => {
    expect(classifyUpload(200, ok({ deduped: true }), TX).kind).toBe('deduped');
  });

  // The one outcome the soak must read as zero. Either shape of it — a typed
  // 409, a dedupe onto other bytes, or a NEW paid id for a published one — is
  // the same defect, and none of them is retried.
  it('treats every reused-id divergence as a conflict', () => {
    expect(classifyUpload(409, { code: 'id_payload_conflict', txId: TX }).kind).toBe('conflict');
    expect(classifyUpload(200, ok({ deduped: true, txId: TX2 }), TX).kind).toBe('conflict');
    expect(classifyUpload(200, ok({ txId: TX2 }), TX).kind).toBe('conflict');
  });

  it('separates the old worker (no marker) from a broken answer', () => {
    expect(classifyUpload(200, { txId: TX, status: 'accepted', committed: true }).kind).toBe('accepted-unattested');
    expect(classifyUpload(200, { status: 'accepted' }).kind).toBe('unexpected');
    expect(classifyUpload(200, 'not json').kind).toBe('unexpected');
  });

  // An unregistered key is refused before any reservation: no money moved,
  // and every further attempt in the run would say the same thing.
  it('names an unregistered identity', () => {
    expect(classifyUpload(403, 'Not registered')).toMatchObject({ kind: 'not-registered' });
  });

  it('names the retryable answers without inventing a verdict', () => {
    expect(classifyUpload(409, 'Upload already in progress').kind).toBe('in-progress');
    expect(classifyUpload(429, 'Rate limit exceeded').kind).toBe('rate-limited');
    expect(classifyUpload(503, 'Publication could not be authenticated')).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/authenticated/) });
    expect(classifyUpload(500, 'boom').kind).toBe('unexpected');
  });

  it('rejects a deduped answer that is not committed', () => {
    expect(classifyUpload(200, ok({ deduped: true, committed: false }), TX).kind).toBe('unexpected');
  });
});

describe('readConfirmations', () => {
  it('reads number_of_confirmations from a 200 only', () => {
    expect(readConfirmations(200, { number_of_confirmations: 7 })).toBe(7);
    expect(readConfirmations(202, 'Pending')).toBeNull();
    expect(readConfirmations(404, 'Not Found')).toBeNull();
    expect(readConfirmations(200, { number_of_confirmations: 'many' })).toBeNull();
    expect(readConfirmations(200, { number_of_confirmations: -1 })).toBeNull();
  });
});

describe('readTxHeaderOk', () => {
  // The verifier needs a format-2 header naming THIS id; a 202 «Pending» or a
  // header for another id is not one.
  it('accepts only a served format-2 header for the id', () => {
    expect(readTxHeaderOk(200, { format: 2, id: TX }, TX)).toBe(true);
    expect(readTxHeaderOk(202, 'Pending', TX)).toBe(false);
    expect(readTxHeaderOk(200, { format: 1, id: TX }, TX)).toBe(false);
    expect(readTxHeaderOk(200, { format: 2, id: TX2 }, TX)).toBe(false);
    expect(readTxHeaderOk(404, 'Not Found', TX)).toBe(false);
  });
});

describe('estimateCost', () => {
  it('multiplies in winston without losing precision and prints AR', () => {
    const c = estimateCost('3335822128', 25);
    expect(c.totalWinston).toBe('83395553200');
    expect(c.perTxAr).toBe('0.003336');
    expect(c.totalAr).toBe('0.083396');
  });
});

describe('summarize', () => {
  it('reports against the runbook volume; recovery_reconciled is waived, never claimed', () => {
    const state = {
      ...emptyState(),
      paidPosts: 21,
      notes: [note({ kind: 'legacy', backfilledAt: 1 }), note({ kind: 'legacy', backfilledAt: 1 }), note({ kind: 'legacy' })],
      // `paid` per run is what the WINDOW counts; `paidPosts` above is the
      // lifetime total and is deliberately NOT what the volume row reads.
      runs: [
        { at: Date.UTC(2026, 8, 8), mode: 'day', deduped: 6, paid: 7 },
        { at: Date.UTC(2026, 8, 9), mode: 'day', deduped: 7, paid: 7 },
        { at: Date.UTC(2026, 8, 9, 23), mode: 'day', deduped: 1, paid: 7 },
      ],
    };
    const rows = Object.fromEntries(summarize(state).map(r => [r.name, r]));
    expect(rows['paid outcomes IN THE WINDOW (day runs only)']).toMatchObject({ have: 21, need: VOLUME.paidOutcomes, ok: true });
    expect(rows['deduped']).toMatchObject({ have: 14, ok: true });
    expect(rows['distinct days with a day run']).toMatchObject({ have: 2, ok: false });
    expect(rows['legacy_backfilled (distinct records)']).toMatchObject({ have: 2, ok: false });
    expect(rows['recovery_reconciled — waived by owner 2026-09-07 (not reachable by any client)']).toMatchObject({ have: 0, ok: true });
  });
});

describe('parseArgs', () => {
  it('reads the mode and the numeric flags', () => {
    expect(parseArgs(['day', '--paid', '2', '--dry-run'])).toEqual({ mode: 'day', opts: { paid: 2, dryRun: true } });
    expect(parseArgs(['seed-legacy', '--count', '5'])).toEqual({ mode: 'seed-legacy', opts: { count: 5 } });
    expect(parseArgs(['register', '--invite', 'abc'])).toEqual({ mode: 'register', opts: { invite: 'abc' } });
  });
  // `--paid 0` is NOT a promise of a free run: the dedupe pass still carries
  // rechecks, and the legacy pass sends too. These two are the actual lever.
  it('reads the switches that hold back the redrop-capable passes', () => {
    expect(parseArgs(['day', '--paid', '0', '--no-recheck', '--no-legacy'])).toEqual({
      mode: 'day', opts: { paid: 0, noRecheck: true, noLegacy: true },
    });
  });
  it('refuses junk', () => {
    expect(() => parseArgs(['day', '--paid', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['day', '--wat'])).toThrow(/unknown argument/);
  });
});

describe('upload framing', () => {
  it('mirrors the v3 writer canon: five tags, UUIDv8 ids', () => {
    const id = randomUuidV8();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(v3Tags('owner', id).map(t => t.name)).toEqual(['App-Name', 'App-Version', 'Content-Type', 'Owner-Hash', 'Note-Id']);
  });
});

/**
 * The budget as it EXECUTES, not merely as it plans.
 *
 * Planning tests prove the quotas are computed; these prove the money cannot
 * escape them: a ledger that will not persist must stop the send, a charge
 * must survive the process, and two runs must not both believe the budget is
 * theirs.
 */
describe('budget execution', () => {
  const tmpDir = () => join(tmpdir(), `soak-d2-${randomUUID()}`);

  const fakeSigner = () => {
    const sent = [];
    return {
      sent,
      upload: async (_origin, note, opts = {}) => {
        sent.push({ noteId: note.noteId, recheck: opts.recheck === true });
        return { status: 200, body: { txId: TX, status: 'accepted', committed: true, deduped: true, semanticIdempotency: 1 } };
      },
    };
  };

  // dayRun quotes the price before doing anything; nothing else touches the net
  // once the legacy pass is switched off.
  const stubPrice = () => vi.stubGlobal('fetch', async () => new Response('3371193814', { status: 200 }));
  afterEach(() => { vi.unstubAllGlobals(); });

  const readyNote = () => note({
    noteId: 'ready', txId: TX, createdAt: 0, confirmedAt: 1, dedupes: 0,
  });
  const runOpts = { ...DEFAULTS, paidPerRun: 0, noLegacy: true };

  it('a ledger that will not persist STOPS the send', async () => {
    stubPrice();
    const state = { ...emptyState(), notes: [readyNote()] };
    const signer = fakeSigner();

    const failures = await dayRun({
      origin: 'https://worker.test', signer, state, opts: runOpts,
      persist: async () => { throw new Error('disk full'); },
    });

    // Nothing was sent — not the recheck, not anything after it.
    expect(signer.sent).toEqual([]);
    expect(failures).toBeGreaterThan(0);
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/STOP: ledger write failed before a recheck send/);
  });

  it('the charge is durable: a second process reads the spent limit', async () => {
    const dir = tmpDir();
    const path = join(dir, 'state.json');
    const state = { ...emptyState(), notes: [readyNote()] };

    await chargeBudget(state, 'recheck', () => saveState(path, state));

    // A FRESH read — what the next process actually sees.
    const reloaded = await loadState(path);
    expect(redropSends(reloaded)).toEqual({ recheck: 1, legacy: 0 });
    await rm(dir, { recursive: true, force: true });
  });

  it('the ledger is replaced atomically, never truncated in place', async () => {
    const dir = tmpDir();
    const path = join(dir, 'state.json');
    await saveState(path, { ...emptyState(), paidPosts: 7 });
    await saveState(path, { ...emptyState(), paidPosts: 8 });

    expect((await loadState(path)).paidPosts).toBe(8);
    // No temp file survives a completed write — a leftover would mean the
    // rename never happened and the next reader could pick up a half-file.
    expect((await readdir(dir)).filter(f => f.includes('.tmp'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('a second concurrent run is refused the ledger and sends nothing', async () => {
    const dir = tmpDir();
    const path = join(dir, 'state.json');

    const first = await acquireLedgerLock(path);
    expect(first.ok).toBe(true);

    const second = await acquireLedgerLock(path, Date.now() + 5 * 60_000);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/another run holds the ledger \(pid \d+, 5 min ago\)/);

    // …and the lock is not a one-way door: releasing lets the next run in.
    await first.release();
    const third = await acquireLedgerLock(path);
    expect(third.ok).toBe(true);
    await third.release();
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * The paid-attempt ledger.
 *
 * `paidPosts` counts SUCCESSES, so it can never bound money: 18 attempts with
 * one failure and 17 successes are indistinguishable from 17 clean ones — the
 * hole the 2026-09-09 observability review opened. These prove the attempt is
 * durable before the send, that an unanswered send keeps its limit forever and
 * is never re-driven, and that a ledger predating the counter is migrated
 * EXPLICITLY instead of reconstructed from successes.
 */
describe('paid-attempt ledger', () => {
  const tmpDir = () => join(tmpdir(), `soak-d2-${randomUUID()}`);
  const stubPrice = () => vi.stubGlobal('fetch', async () => new Response('3371193814', { status: 200 }));
  afterEach(() => { vi.unstubAllGlobals(); });
  const paidOpts = { ...DEFAULTS, paidPerRun: 1, noRecheck: true, noLegacy: true };
  const unreachable = { upload: async () => { throw new Error('must not be reached'); } };

  it('records the attempt BEFORE the send and settles the outcome after', async () => {
    stubPrice();
    const state = emptyState();
    const inFlight = [];
    const signer = {
      upload: async () => {
        inFlight.push(structuredClone(paidAttempts(state).records));
        return { status: 200, body: { txId: TX, status: 'accepted', committed: true, semanticIdempotency: 1 } };
      },
    };

    await dayRun({ origin: 'https://worker.test', signer, state, opts: paidOpts, persist: async () => {} });

    expect(inFlight[0]).toHaveLength(1);
    expect(inFlight[0][0].outcome).toBe('pending');
    expect(attemptsSummary(state)).toMatchObject({ total: 1, accepted: 1, error: 0, unknown: 0 });
    expect(paidAttempts(state).records[0].txId).toBe(TX);
  });

  it('a ledger that will not persist STOPS the paid send', async () => {
    stubPrice();
    const state = emptyState();

    const failures = await dayRun({
      origin: 'https://worker.test', signer: unreachable, state, opts: paidOpts,
      persist: async () => { throw new Error('disk full'); },
    });

    expect(failures).toBeGreaterThan(0);
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/STOP: ledger write failed before a paid send/);
    expect(attemptsSummary(state)).toMatchObject({ total: 1, unknown: 1 });
  });

  it('an unanswered send is a STOP: unknown outcome, NON-ZERO exit, limit kept', async () => {
    stubPrice();
    const state = emptyState();
    const sent = [];
    const signer = { upload: async (_o, note) => { sent.push(note.noteId); throw new Error('socket hang up'); } };

    const failures = await dayRun({ origin: 'https://worker.test', signer, state, opts: { ...paidOpts, paidPerRun: 3 }, persist: async () => {} });

    // The whole point: a scheduler must NOT read this as a healthy run.
    expect(failures).toBeGreaterThan(0);
    expect(sent).toHaveLength(1); // the pass stops instead of sending into an unknown wallet state
    expect(state.paidPosts).toBe(0);
    expect(attemptsSummary(state)).toMatchObject({ total: 1, accepted: 0, unknown: 1 });
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/STOP: paid .* UNKNOWN outcome .* needs a human/);
  });

  // Not "the next run sends nothing" — that proves little. The next run must be
  // ABLE to publish and still leave the unknown attempt alone.
  it('the unknown attempt is never re-sent: a later run publishes a NEW note instead', async () => {
    stubPrice();
    const state = emptyState();
    const sent = [];
    const dead = { upload: async (_o, note) => { sent.push(note.noteId); throw new Error('socket hang up'); } };
    await dayRun({ origin: 'https://worker.test', signer: dead, state, opts: paidOpts, persist: async () => {} });

    const stranded = paidAttempts(state).records[0];
    expect(stranded.outcome).toBe('unknown');

    const alive = {
      upload: async (_o, note) => {
        sent.push(note.noteId);
        return { status: 200, body: { txId: TX2, status: 'accepted', committed: true, semanticIdempotency: 1 } };
      },
    };
    await dayRun({ origin: 'https://worker.test', signer: alive, state, opts: paidOpts, persist: async () => {} });

    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(stranded.noteId);            // a fresh id, not a retry of the unknown one
    expect(paidAttempts(state).records).toHaveLength(2);  // and it took a second slot
    expect(paidAttempts(state).records[0]).toMatchObject({ noteId: stranded.noteId, outcome: 'unknown' });
    expect(attemptsSpent(state)).toBe(2);
  });

  it('a ledger that will not persist AFTER the send stops the run, and the attempt stays unknown on disk', async () => {
    stubPrice();
    const state = emptyState();
    let writes = 0;
    // The charge lands; the outcome write does not — exactly the window where
    // the answer is known but unrecordable.
    const persist = async () => { writes += 1; if (writes > 1) throw new Error('disk full'); };
    const signer = { upload: async () => ({ status: 200, body: { txId: TX, status: 'accepted', committed: true, semanticIdempotency: 1 } }) };

    const failures = await dayRun({ origin: 'https://worker.test', signer, state, opts: paidOpts, persist });

    expect(failures).toBeGreaterThan(0);
    expect(state.runs.at(-1).problems.join(' ')).toMatch(/STOP: ledger write failed after a paid send/);
    expect(attemptsSpent(state)).toBe(1); // the slot is spent either way
  });

  // seed-legacy publications cost the same AR. They used to be bounded through
  // `paidPosts`; moving the budget to attempts must not let them escape it.
  it('seed-legacy publications are charged to the same limit', async () => {
    stubPrice();
    const state = emptyState();
    const signer = { upload: async () => ({ status: 200, body: { txId: TX, status: 'accepted', committed: true } }) };

    await seedLegacy({ origin: 'https://worker.test', signer, state, count: 5, opts: DEFAULTS, persist: async () => {} });

    expect(state.paidPosts).toBe(5);
    expect(attemptsSpent(state)).toBe(5); // NOT zero
    // …and `day` sees the reduced remainder, exactly as it did before.
    expect(planRun(state, { ...DEFAULTS, paidPerRun: 3, maxPaidTotal: 6 }, 0).paid).toBe(1);
  });

  it('seed-legacy refuses an unmigrated ledger rather than silently creating one', async () => {
    stubPrice();
    const state = emptyState();
    delete state.paidAttempts;
    const signer = { upload: async () => { throw new Error('must not be reached'); } };

    const failures = await seedLegacy({ origin: 'https://worker.test', signer, state, count: 5, opts: DEFAULTS, persist: async () => {} });

    expect(failures).toBeGreaterThan(0);
    expect(state.paidAttempts).toBeUndefined();
  });

  // Charged is not the same as bounded: `--count` alone would walk past the
  // window limit that every other paid send respects.
  it('seed-legacy is BOUNDED by the remaining limit, not just by --count', async () => {
    stubPrice();
    const state = emptyState();
    // The single slot of a one-slot budget, already taken by an unknown attempt.
    await chargeAttempt(state, { ...newAttempt('earlier', 0), outcome: 'unknown' }, null);
    const sent = [];
    const signer = {
      upload: async (_o, n) => { sent.push(n.noteId); return { status: 200, body: { txId: TX, status: 'accepted', committed: true } }; },
    };

    const failures = await seedLegacy({
      origin: 'https://worker.test', signer, state, count: 1,
      opts: { ...DEFAULTS, maxPaidTotal: 1 }, persist: async () => {},
    });

    expect(sent).toEqual([]);
    expect(failures).toBeGreaterThan(0);
    expect(attemptsSpent(state)).toBe(1); // the pass added nothing
  });

  it('seed-legacy writes the OUTCOME to disk, not merely the charge', async () => {
    const dir = tmpDir();
    const path = join(dir, 'state.json');
    stubPrice();
    const state = emptyState();
    const signer = { upload: async () => ({ status: 200, body: { txId: TX, status: 'accepted', committed: true } }) };

    await seedLegacy({
      origin: 'https://worker.test', signer, state, count: 1,
      opts: DEFAULTS, persist: () => saveState(path, state),
    });

    // What a process killed right here would find on its next start. A legacy
    // fixture's txId cannot be recreated once D2 is live, so losing it is final.
    const reloaded = await loadState(path);
    expect(paidAttempts(reloaded).records[0]).toMatchObject({ outcome: 'accepted-new', txId: TX });
    expect(reloaded.notes[0].txId).toBe(TX);
    await rm(dir, { recursive: true, force: true });
  });

  it('an early stop does not invent successes in the seed run record', async () => {
    stubPrice();
    const state = emptyState();
    const signer = { upload: async () => { throw new Error('socket hang up'); } };

    await seedLegacy({ origin: 'https://worker.test', signer, state, count: 5, opts: DEFAULTS, persist: async () => {} });

    const run = state.runs.at(-1);
    expect(run.paid).toBe(0);        // `count - failures` would have claimed 4
    expect(run.requested).toBe(5);
    expect(state.paidPosts).toBe(0);
    expect(attemptsSummary(state)).toMatchObject({ total: 1, accepted: 0, unknown: 1 });
  });

  it('an interruption between the send and the answer reconciles to unknown, keeping the limit', async () => {
    const dir = tmpDir();
    const path = join(dir, 'state.json');
    const state = emptyState();

    await chargeAttempt(state, newAttempt('n1', 0), () => saveState(path, state));

    const reloaded = await loadState(path);
    expect(paidAttempts(reloaded).records[0].outcome).toBe('pending');
    expect(attemptsSpent(reloaded)).toBe(1);

    const stranded = reconcilePendingAttempts(reloaded, 123);
    expect(stranded).toHaveLength(1);
    expect(paidAttempts(reloaded).records[0]).toMatchObject({ outcome: 'unknown', reconciledAt: 123 });
    expect(attemptsSpent(reloaded)).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  describe('a ledger written before the counter existed', () => {
    const legacyLedger = () => { const s = emptyState(); delete s.paidAttempts; s.paidPosts = 11; return s; };

    it('day REFUSES until the operator migrates explicitly', async () => {
      const state = legacyLedger();

      const failures = await dayRun({
        origin: 'https://worker.test', signer: unreachable, state, opts: paidOpts, persist: async () => {},
      });

      expect(failures).toBeGreaterThan(0);
      expect(state.runs.at(-1).problems.join(' ')).toMatch(/STOP: ledger predates the paid-attempt counter/);
    });

    it('does NOT reconstruct attempts from successes, and keeps the limit in force', () => {
      const state = legacyLedger();

      expect(needsAttemptsMigration(state)).toBe(true);
      expect(migrateAttempts(state, 999)).toMatchObject({ migrated: true, knownSuccesses: 11 });

      expect(paidAttempts(state).records).toEqual([]);
      expect(paidAttempts(state).priorEra).toMatchObject({ migratedAt: 999, knownSuccesses: 11, attemptsUnknown: true });
      expect(state.paidPosts).toBe(11);
      expect(attemptsSpent(state)).toBe(11);
      expect(planRun(state, { ...DEFAULTS, paidPerRun: 3, maxPaidTotal: 12 }, 0).paid).toBe(1);
    });

    // The reviewer's case: results may not stand in for schema. A ledger whose
    // publications ALL failed has paidPosts === 0 and is still an old ledger.
    it('an old ledger with only FAILURES still needs migration', () => {
      const s = emptyState();
      delete s.paidAttempts;
      s.paidPosts = 0;
      s.runs = [{ at: 0, mode: 'day', paid: 0, problems: ['paid n1: unexpected — HTTP 502'] }];

      expect(needsAttemptsMigration(s)).toBe(true);
      expect(migrateAttempts(s, 5)).toMatchObject({ migrated: true, knownSuccesses: 0 });
      expect(paidAttempts(s).priorEra).toMatchObject({ migratedAt: 5, knownSuccesses: 0, attemptsUnknown: true });
    });

    it('is idempotent, and a fresh ledger needs nothing', () => {
      const migrated = legacyLedger();
      migrateAttempts(migrated, 999);
      expect(migrateAttempts(migrated, 1000)).toMatchObject({ migrated: false });
      expect(paidAttempts(migrated).priorEra.migratedAt).toBe(999);

      expect(needsAttemptsMigration(emptyState())).toBe(false);
      expect(migrateAttempts(emptyState(), 1).migrated).toBe(false);
    });
  });
});
/**
 * Budget and window volume are DIFFERENT numbers.
 *
 * `seed-legacy` publishes from the PRE-D2 worker, before the window exists, so
 * those publications emit no `upload_outcome` of the release. Counting them
 * toward the 20 required by docs/ROLLBACK.md would clear the volume bar on
 * evidence the criterion does not accept — 20 reported while the release
 * itself had produced 15. The budget goes the other way: money spent is money
 * spent, whichever worker spent it.
 */
describe('seeding counts against the budget, never toward the window volume', () => {
  const seededState = (seedPaid, dayPaids) => ({
    ...emptyState(),
    paidPosts: seedPaid + dayPaids.reduce((a, b) => a + b, 0),
    runs: [
      { at: Date.UTC(2026, 8, 1), mode: 'seed-legacy', paid: seedPaid, failures: 0 },
      ...dayPaids.map((p, i) => ({
        at: Date.UTC(2026, 8, 2 + i), mode: 'day', paid: p, deduped: 0, rechecked: 0, legacyBackfilled: 0, problems: [],
      })),
    ],
    paidAttempts: {
      records: Array.from({ length: seedPaid + dayPaids.reduce((a, b) => a + b, 0) },
        (_, i) => ({ id: `a${i}`, at: 0, noteId: `n${i}`, outcome: 'accepted-new' })),
      priorEra: null,
    },
  });

  it('counts ONLY day runs toward the window', () => {
    const s = seededState(5, [3, 3, 3]);
    expect(s.paidPosts).toBe(14);              // lifetime, seeding included
    expect(paidOutcomesInWindow(s)).toBe(9);   // the window saw nine
  });

  it('the volume row reports the WINDOW figure, not the lifetime one', () => {
    const s = seededState(5, [3, 3, 3]);
    const row = summarize(s).find(r => /paid outcomes/i.test(r.name));
    expect(row.have).toBe(9);
    expect(row.have).not.toBe(s.paidPosts);
    expect(row.need).toBe(VOLUME.paidOutcomes);
    expect(row.ok).toBe(false); // 9 of 20 — seeding must not clear this bar
  });

  it('a window that reaches 20 by day runs alone passes; one padded by seeding does not', () => {
    const real = seededState(0, [4, 4, 4, 4, 4]);          // 20 in the window
    const padded = seededState(5, [3, 3, 3, 3, 3]);        // 20 lifetime, 15 in the window
    expect(summarize(real).find(r => /paid outcomes/i.test(r.name)).ok).toBe(true);
    expect(padded.paidPosts).toBe(20);
    expect(summarize(padded).find(r => /paid outcomes/i.test(r.name)).ok).toBe(false);
  });

  it('the BUDGET still counts the seeding — money spent is money spent', () => {
    const s = seededState(5, [3]);
    expect(attemptsSpent(s)).toBe(8);
    expect(planRun(s, { ...DEFAULTS, paidPerRun: 3, maxPaidTotal: 10 }, 0).paid).toBe(2);
  });

  // The seed run IS in `runs`; it simply is not a `day` run.
  it('the seed run does not add a distinct day', () => {
    const s = seededState(5, [3]);
    expect(s.runs).toHaveLength(2);
    expect(summarize(s).find(r => /distinct days/i.test(r.name)).have).toBe(1);
  });
});
