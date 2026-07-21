import { describe, it, expect } from 'vitest';
import { toUploading, toAccepted, afterInProgress, afterFailure, afterPoll, claimRestoredForUi } from './sync-transitions';
import type { SyncRecord } from './storage';

// Regression tests for the client half of the recovery protocol — the exact
// transitions where the signed recovery token was repeatedly lost in review.

const CONFIRM_THRESHOLD = 25;
const TX_TIMEOUT_MS = 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

const RECOVERY = { txId: 'TX1', postedAt: NOW - 60_000, token: 'signed-token' };

const acceptedUncommitted: SyncRecord = {
  noteId: 'n1',
  txId: 'TX1',
  status: 'accepted',
  transport: 'proxy',
  updatedAt: NOW - 10_000,
  needsRecheck: true,
  recovery: RECOVERY,
};

describe('toUploading', () => {
  it('carries txId, recheck intent AND the recovery token into uploading', () => {
    const rec = toUploading('n1', acceptedUncommitted, NOW);
    expect(rec.status).toBe('uploading');
    expect(rec.txId).toBe('TX1');
    expect(rec.needsRecheck).toBe(true);
    expect(rec.recovery).toEqual(RECOVERY); // the token must survive this hop
  });

  it('starts clean for a note without prior record', () => {
    const rec = toUploading('n2', undefined, NOW);
    expect(rec).toMatchObject({ noteId: 'n2', status: 'uploading', needsRecheck: false });
    expect(rec.txId).toBeUndefined();
    expect(rec.recovery).toBeUndefined();
  });
});

describe('toAccepted', () => {
  it('committed:true clears needsRecheck and drops the recovery hint', () => {
    const rec = toAccepted('n1', acceptedUncommitted, { txId: 'TX2', committed: true }, NOW);
    expect(rec).toMatchObject({ status: 'accepted', txId: 'TX2', needsRecheck: false });
    expect(rec.recovery).toBeUndefined();
  });

  it('committed:false keeps needsRecheck and prefers the FRESH server hint', () => {
    const fresh = { txId: 'TX2', postedAt: NOW, token: 'fresh-token' };
    const rec = toAccepted('n1', acceptedUncommitted, { txId: 'TX2', committed: false, recovery: fresh }, NOW);
    expect(rec.needsRecheck).toBe(true);
    expect(rec.recovery).toEqual(fresh);
  });

  it('committed:false without a fresh hint carries the previous one forward', () => {
    const rec = toAccepted('n1', acceptedUncommitted, { txId: 'TX1', committed: false }, NOW);
    expect(rec.recovery).toEqual(RECOVERY);
  });
});

describe('afterInProgress (409)', () => {
  it('restores accepted + needsRecheck + txId + recovery instead of leaving uploading', () => {
    // Realistic post-triple-failure 409: the pre-failure reserved slot is still
    // within its TTL. The recovery proof must NOT be stranded in 'uploading'.
    const rec = afterInProgress('n1', acceptedUncommitted, NOW);
    expect(rec).toMatchObject({ status: 'accepted', txId: 'TX1', needsRecheck: true });
    expect(rec?.recovery).toEqual(RECOVERY);
  });

  it('returns null when the note was never accepted (nothing to restore)', () => {
    expect(afterInProgress('n2', undefined, NOW)).toBeNull();
    expect(afterInProgress('n2', { noteId: 'n2', status: 'error', transport: 'proxy', updatedAt: NOW }, NOW)).toBeNull();
  });
});

describe('afterFailure (503/429/network)', () => {
  it('keeps accepted + txId + recovery across a transient failure', () => {
    const rec = afterFailure('n1', acceptedUncommitted, true, 'HTTP 503', NOW);
    expect(rec).toMatchObject({ status: 'accepted', txId: 'TX1', needsRecheck: true, lastError: 'HTTP 503' });
    expect(rec.recovery).toEqual(RECOVERY);
  });

  it('a never-accepted note becomes error but keeps the recheck intent', () => {
    const rec = afterFailure('n2', undefined, true, 'HTTP 429', NOW);
    expect(rec).toMatchObject({ status: 'error', needsRecheck: true, lastError: 'HTTP 429' });
  });
});

describe('afterPoll', () => {
  it('does NOT confirm a needsRecheck record even at 25+ confirmations', () => {
    const next = afterPoll(acceptedUncommitted, { kind: 'confirmed', confirmations: 40, blockHeight: 1 }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS);
    expect(next).toBeNull(); // server reconciliation must finish first
  });

  it('confirms a reconciled record at the threshold', () => {
    const reconciled: SyncRecord = { ...acceptedUncommitted, needsRecheck: false, recovery: undefined };
    const next = afterPoll(reconciled, { kind: 'confirmed', confirmations: 25, blockHeight: 1 }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS);
    expect(next?.status).toBe('confirmed');
  });

  it('flags dropped/invalid for recheck, once', () => {
    const clean: SyncRecord = { ...acceptedUncommitted, needsRecheck: false };
    expect(afterPoll(clean, { kind: 'dropped' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)?.needsRecheck).toBe(true);
    expect(afterPoll(clean, { kind: 'invalid' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)?.needsRecheck).toBe(true);
    // already flagged → no redundant write
    expect(afterPoll(acceptedUncommitted, { kind: 'dropped' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)).toBeNull();
  });

  it('flags a pending TX only past the timeout; unavailable never mutates', () => {
    const clean: SyncRecord = { ...acceptedUncommitted, needsRecheck: false, updatedAt: NOW - 10_000 };
    expect(afterPoll(clean, { kind: 'pending' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)).toBeNull();
    const stale: SyncRecord = { ...clean, updatedAt: NOW - TX_TIMEOUT_MS - 1 };
    expect(afterPoll(stale, { kind: 'pending' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)?.needsRecheck).toBe(true);
    expect(afterPoll(clean, { kind: 'unavailable' }, NOW, CONFIRM_THRESHOLD, TX_TIMEOUT_MS)).toBeNull();
  });
});

describe('claimRestoredForUi (restoredCount accuracy)', () => {
  it('does NOT count a repaired note that is already visible', () => {
    // The storage repair still happens, but «Восстановлено N» must not include
    // a note the user could already see.
    const visible = new Set(['n-visible']);
    expect(claimRestoredForUi(visible, 'n-visible')).toBe(false);
  });

  it('counts an invisible (new or corrupted-local) note exactly once', () => {
    const visible = new Set(['n-visible']);
    let restoredCount = 0;
    // Same restore sweep sees the id twice (defensive — fetch dedups already).
    for (const id of ['n-repaired', 'n-repaired', 'n-new']) {
      if (claimRestoredForUi(visible, id)) restoredCount++;
    }
    expect(restoredCount).toBe(2); // n-repaired once + n-new once
    expect(visible.has('n-repaired')).toBe(true); // claimed for later sweeps
  });
});

describe('full reconciliation loop (triple-failure → recheck → commit → confirm)', () => {
  it('the recovery token survives until the server commits, then the TX confirms', () => {
    // 1. Triple-failure upload: accepted, committed:false, server hands a token.
    let rec = toAccepted('n1', undefined, { txId: 'TX1', committed: false, recovery: RECOVERY }, NOW);
    expect(rec.needsRecheck).toBe(true);
    expect(rec.recovery).toEqual(RECOVERY);

    // 2. Poll sees 30 confirmations — must NOT terminate reconciliation.
    expect(afterPoll(rec, { kind: 'confirmed', confirmations: 30, blockHeight: 1 }, NOW + 1, 25, TX_TIMEOUT_MS)).toBeNull();

    // 3. Recheck attempt starts: uploading still holds the token.
    rec = toUploading('n1', rec, NOW + 2);
    expect(rec.recovery).toEqual(RECOVERY);

    // 4. Server still has the live reservation → 409; state restored, token kept.
    rec = afterInProgress('n1', rec, NOW + 3)!;
    expect(rec).toMatchObject({ status: 'accepted', needsRecheck: true });
    expect(rec.recovery).toEqual(RECOVERY);

    // 5. Next recheck: transient 503; token still kept.
    rec = afterFailure('n1', toUploading('n1', rec, NOW + 4), true, 'HTTP 503', NOW + 5);
    expect(rec.recovery).toEqual(RECOVERY);

    // 6. Recheck finally reaches the server; it verifies the token and commits.
    rec = toAccepted('n1', toUploading('n1', rec, NOW + 6), { txId: 'TX1', committed: true }, NOW + 7);
    expect(rec.needsRecheck).toBe(false);
    expect(rec.recovery).toBeUndefined();

    // 7. Only now does polling confirm it.
    const done = afterPoll(rec, { kind: 'confirmed', confirmations: 30, blockHeight: 2 }, NOW + 8, 25, TX_TIMEOUT_MS);
    expect(done?.status).toBe('confirmed');
  });
});
