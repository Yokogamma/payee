import { describe, it, expect } from 'vitest';
import { runUploadAttempt, type UploadAttemptDeps, type UploadKeys } from './upload-flow';
import type { UploadResult } from './arweave';
import type { SyncRecord } from './storage';
import type { EncryptedNote } from './crypto';

// Blocker tests (§7/§10): the point of no return. A lock BEFORE it cancels the
// attempt with zero writes and zero HTTP; a lock AFTER it changes nothing —
// the request dispatches and its result is persisted unconditionally.

const NOW = 1_750_000_000_000;

const NOTE: EncryptedNote = {
  noteId: 'note-1',
  ciphertext: 'Y2lwaGVy',
  iv: 'AAAAAAAAAAAAAAAA', // canonical base64 of exactly 12 bytes
  createdAt: NOW - 60_000,
};

const NOTE_ITEM = { kind: 'note', record: NOTE } as const;

const KEYS: UploadKeys = {
  signingKey: new Uint8Array(32).fill(7),
  ownerHash: 'owner-hash-b64',
  publicKey: new Uint8Array(32).fill(9),
};

const ACCEPTED: UploadResult = { kind: 'accepted', txId: 'TX9', committed: true };

interface Harness {
  deps: UploadAttemptDeps;
  writes: SyncRecord[];
  /** Atomic sync+meta commits for the v3_disabled branch (record, pausedAt). */
  pausedCommits: Array<{ record: SyncRecord; pausedAt: number }>;
  httpCalls: number;
  epoch: { value: number };
}

function makeHarness(opts?: {
  prev?: SyncRecord;
  result?: UploadResult;
  /** flip the epoch while the signature is being computed */
  lockDuringSign?: boolean;
  /** flip the epoch while the toUploading write is in flight */
  lockDuringToUploading?: boolean;
  /** flip the epoch while the HTTP request is in flight */
  lockDuringDispatch?: boolean;
}): Harness {
  const epoch = { value: 1 };
  const writes: SyncRecord[] = [];
  const pausedCommits: Array<{ record: SyncRecord; pausedAt: number }> = [];
  const h: Harness = { deps: null as unknown as UploadAttemptDeps, writes, pausedCommits, httpCalls: 0, epoch };
  h.deps = {
    now: () => NOW,
    currentEpoch: () => epoch.value,
    getSyncRecord: async () => opts?.prev,
    setSyncRecord: async record => {
      writes.push(record);
      if (record.status === 'uploading' && opts?.lockDuringToUploading) epoch.value++;
    },
    commitV3PausedFailure: async (record, pausedAt) => {
      pausedCommits.push({ record, pausedAt });
    },
    commitV4PausedFailure: async (record, pausedAt) => {
      pausedCommits.push({ record, pausedAt });
    },
    signPayload: async () => {
      if (opts?.lockDuringSign) epoch.value++;
      return 'signature-b64';
    },
    uploadViaProxy: async () => {
      h.httpCalls++;
      if (opts?.lockDuringDispatch) epoch.value++;
      return opts?.result ?? ACCEPTED;
    },
  };
  return h;
}

describe('runUploadAttempt — before the point of no return', () => {
  it('lock DURING the signature: no HTTP, no writes, outcome cancelled', async () => {
    const h = makeHarness({ lockDuringSign: true });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]); // no 'uploading' record left behind
  });

  it('epoch already stale at entry: cancelled before anything happens', async () => {
    const h = makeHarness();
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 0, h.deps); // captured epoch ≠ current
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]);
  });
});

describe('runUploadAttempt — past the point of no return (committed)', () => {
  it('lock during toUploading: the request STILL dispatches and the result persists', async () => {
    const h = makeHarness({ lockDuringToUploading: true, result: ACCEPTED });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'committed', result: ACCEPTED });
    expect(h.httpCalls).toBe(1);
    expect(h.writes.map(w => w.status)).toEqual(['uploading', 'accepted']);
    expect(h.writes[1].txId).toBe('TX9');
  });

  it('accepted after a mid-dispatch lock is persisted (never stranded uploading)', async () => {
    const h = makeHarness({ lockDuringDispatch: true, result: ACCEPTED });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.writes.map(w => w.status)).toEqual(['uploading', 'accepted']);
  });

  it('failure after a mid-dispatch lock is persisted', async () => {
    const h = makeHarness({
      lockDuringDispatch: true,
      result: { kind: 'unavailable', error: '503' },
    });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('error'); // no prior txId → retryable hard error
    expect(final.lastError).toBe('503');
  });

  it('in_progress after a mid-dispatch lock is persisted', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
    };
    const h = makeHarness({
      prev, lockDuringDispatch: true,
      result: { kind: 'in_progress', error: '409' },
    });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('accepted'); // prior accepted TX restored
    expect(final.txId).toBe('TX-old');
  });
});

describe('runUploadAttempt — in_progress WITHOUT a prior record (round-5 #1)', () => {
  it('records a RETRYABLE failure, never a stranded uploading', async () => {
    const h = makeHarness({ result: { kind: 'in_progress', error: '409 reservation' } });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('error');      // syncPendingNotes re-enqueues 'error'
    expect(final.status).not.toBe('uploading');
    expect(final.lastError).toBe('in_progress');
  });
});

describe('runUploadAttempt — v3_disabled (worker kill switch → atomic pause)', () => {
  const V3_DISABLED: UploadResult = { kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}' };

  it('commits the failure record + pause via commitV3PausedFailure, NOT setSyncRecord', async () => {
    const h = makeHarness({ result: V3_DISABLED });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    // Only the toUploading write went through setSyncRecord — the final record
    // travelled through the atomic sync+meta path exactly once.
    expect(h.writes.map(w => w.status)).toEqual(['uploading']);
    expect(h.pausedCommits).toHaveLength(1);
    expect(h.pausedCommits[0].pausedAt).toBe(NOW);
    const rec = h.pausedCommits[0].record;
    expect(rec.status).toBe('error');
    expect(rec.lastError).toContain('v3_uploads_disabled');
  });

  it('preserves txId/recovery/needsRecheck from the prior record (afterFailure semantics)', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
      recovery: { txId: 'TX-old', postedAt: NOW - 200_000, token: 'tok' },
    };
    const h = makeHarness({ prev, result: V3_DISABLED });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    const rec = h.pausedCommits[0].record;
    expect(rec.txId).toBe('TX-old');           // accepted TX never downgraded away
    expect(rec.recovery).toEqual(prev.recovery); // recovery hint survives the pause
    expect(rec.status).not.toBe('uploading');
  });

  it('persists even when a lock lands mid-dispatch (no epoch gate after the point of no return)', async () => {
    const h = makeHarness({ lockDuringDispatch: true, result: V3_DISABLED });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.pausedCommits).toHaveLength(1); // pause not lost to the lock
  });
});

describe('runUploadAttempt — happy path', () => {
  it('accepted: uploading → accepted, txId recorded, one HTTP call', async () => {
    const h = makeHarness({ result: ACCEPTED });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'committed', result: ACCEPTED });
    expect(h.httpCalls).toBe(1);
    expect(h.writes.map(w => w.status)).toEqual(['uploading', 'accepted']);
  });

  it('every processed result kind ends with a non-uploading record', async () => {
    const kinds: UploadResult[] = [
      { kind: 'accepted', txId: 'T', committed: false },
      { kind: 'rate_limited', error: 'rl' },
      { kind: 'not_registered', error: 'nr' },
      { kind: 'in_progress', error: 'ip' },
      { kind: 'unavailable', error: 'ua' },
      { kind: 'error', error: 'e' },
    ];
    for (const result of kinds) {
      const h = makeHarness({ result });
      await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
      expect(h.writes.at(-1)!.status).not.toBe('uploading');
    }
  });
});
