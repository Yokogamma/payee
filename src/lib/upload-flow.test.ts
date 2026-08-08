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
  iv: 'aXZpdml2aXZpdg==',
  createdAt: NOW - 60_000,
};

const KEYS: UploadKeys = {
  signingKey: new Uint8Array(32).fill(7),
  ownerHash: 'owner-hash-b64',
  publicKey: new Uint8Array(32).fill(9),
};

const ACCEPTED: UploadResult = { kind: 'accepted', txId: 'TX9', committed: true };

interface Harness {
  deps: UploadAttemptDeps;
  writes: SyncRecord[];
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
  const h: Harness = { deps: null as unknown as UploadAttemptDeps, writes, httpCalls: 0, epoch };
  h.deps = {
    now: () => NOW,
    currentEpoch: () => epoch.value,
    getSyncRecord: async () => opts?.prev,
    setSyncRecord: async record => {
      writes.push(record);
      if (record.status === 'uploading' && opts?.lockDuringToUploading) epoch.value++;
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
    const outcome = await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]); // no 'uploading' record left behind
  });

  it('epoch already stale at entry: cancelled before anything happens', async () => {
    const h = makeHarness();
    const outcome = await runUploadAttempt(NOTE, KEYS, 0, h.deps); // captured epoch ≠ current
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]);
  });
});

describe('runUploadAttempt — past the point of no return (committed)', () => {
  it('lock during toUploading: the request STILL dispatches and the result persists', async () => {
    const h = makeHarness({ lockDuringToUploading: true, result: ACCEPTED });
    const outcome = await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'committed', result: ACCEPTED });
    expect(h.httpCalls).toBe(1);
    expect(h.writes.map(w => w.status)).toEqual(['uploading', 'accepted']);
    expect(h.writes[1].txId).toBe('TX9');
  });

  it('accepted after a mid-dispatch lock is persisted (never stranded uploading)', async () => {
    const h = makeHarness({ lockDuringDispatch: true, result: ACCEPTED });
    await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    expect(h.writes.map(w => w.status)).toEqual(['uploading', 'accepted']);
  });

  it('failure after a mid-dispatch lock is persisted', async () => {
    const h = makeHarness({
      lockDuringDispatch: true,
      result: { kind: 'unavailable', error: '503' },
    });
    await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('error'); // no prior txId → retryable hard error
    expect(final.lastError).toBe('503');
  });

  it('in_progress after a mid-dispatch lock is persisted', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', txId: 'TX-old', status: 'accepted', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
    };
    const h = makeHarness({
      prev, lockDuringDispatch: true,
      result: { kind: 'in_progress', error: '409' },
    });
    await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('accepted'); // prior accepted TX restored
    expect(final.txId).toBe('TX-old');
  });
});

describe('runUploadAttempt — in_progress WITHOUT a prior record (round-5 #1)', () => {
  it('records a RETRYABLE failure, never a stranded uploading', async () => {
    const h = makeHarness({ result: { kind: 'in_progress', error: '409 reservation' } });
    const outcome = await runUploadAttempt(NOTE, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    const final = h.writes.at(-1)!;
    expect(final.status).toBe('error');      // syncPendingNotes re-enqueues 'error'
    expect(final.status).not.toBe('uploading');
    expect(final.lastError).toBe('in_progress');
  });
});

describe('runUploadAttempt — happy path', () => {
  it('accepted: uploading → accepted, txId recorded, one HTTP call', async () => {
    const h = makeHarness({ result: ACCEPTED });
    const outcome = await runUploadAttempt(NOTE, KEYS, 1, h.deps);
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
      await runUploadAttempt(NOTE, KEYS, 1, h.deps);
      expect(h.writes.at(-1)!.status).not.toBe('uploading');
    }
  });
});
