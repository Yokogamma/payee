import { describe, it, expect } from 'vitest';
import {
  LEGACY_RELEASE_SHA, DEFAULTS, VOLUME,
  emptyState, checkReleaseGate, planRun, classifyUpload, readConfirmations,
  estimateCost, summarize, parseArgs, randomUuidV8, v3Tags,
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

  it('bounds paid publications per run AND per soak', () => {
    expect(planRun({ ...emptyState(), paidPosts: 0 }, opts, 0).paid).toBe(3);
    expect(planRun({ ...emptyState(), paidPosts: 4 }, opts, 0)).toMatchObject({ paid: 1, paidLeftAfter: 0 });
    expect(planRun({ ...emptyState(), paidPosts: 5 }, opts, 0).paid).toBe(0);
    expect(planRun({ ...emptyState(), paidPosts: 9 }, opts, 0).paid).toBe(0);
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

describe('estimateCost', () => {
  it('multiplies in winston without losing precision and prints AR', () => {
    const c = estimateCost('3335822128', 25);
    expect(c.totalWinston).toBe('83395553200');
    expect(c.perTxAr).toBe('0.003336');
    expect(c.totalAr).toBe('0.083396');
  });
});

describe('summarize', () => {
  it('reports against the runbook volume and never claims recovery_reconciled', () => {
    const state = {
      ...emptyState(),
      paidPosts: 21,
      notes: [note({ kind: 'legacy', backfilledAt: 1 }), note({ kind: 'legacy', backfilledAt: 1 }), note({ kind: 'legacy' })],
      runs: [
        { at: Date.UTC(2026, 8, 8), mode: 'day', deduped: 6 },
        { at: Date.UTC(2026, 8, 9), mode: 'day', deduped: 7 },
        { at: Date.UTC(2026, 8, 9, 23), mode: 'day', deduped: 1 },
      ],
    };
    const rows = Object.fromEntries(summarize(state).map(r => [r.name, r]));
    expect(rows['paid outcomes']).toMatchObject({ have: 21, need: VOLUME.paidOutcomes, ok: true });
    expect(rows['deduped']).toMatchObject({ have: 14, ok: true });
    expect(rows['distinct days with a day run']).toMatchObject({ have: 2, ok: false });
    expect(rows['legacy_backfilled (distinct records)']).toMatchObject({ have: 2, ok: false });
    expect(rows['recovery_reconciled — NOT reachable by any client']).toMatchObject({ have: 0, ok: false });
  });
});

describe('parseArgs', () => {
  it('reads the mode and the numeric flags', () => {
    expect(parseArgs(['day', '--paid', '2', '--dry-run'])).toEqual({ mode: 'day', opts: { paid: 2, dryRun: true } });
    expect(parseArgs(['seed-legacy', '--count', '5'])).toEqual({ mode: 'seed-legacy', opts: { count: 5 } });
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
