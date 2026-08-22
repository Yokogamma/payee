import { describe, it, expect } from 'vitest';
import { runUploadAttempt, type UploadAttemptDeps, type UploadKeys } from './upload-flow';
import { toUploading } from './sync-transitions';
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
  /** Every APPLIED sync write, in order (begin + results). */
  writes: SyncRecord[];
  /** Atomic sync+meta commits for the vN_disabled branch (record, pausedAt). */
  pausedCommits: Array<{ record: SyncRecord; pausedAt: number }>;
  /** Result commits REFUSED because the fresh row was quarantined. */
  blockedCommits: number;
  /** The in-memory sync row — the «fresh» source every commit re-reads,
   *  faithfully mirroring the storage primitives' contract. */
  row: { value: SyncRecord | undefined };
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
  /** another tab quarantines the row while the signature is being computed
   *  (i.e. AFTER the queue read prev, BEFORE the atomic begin) */
  quarantineDuringSign?: NonNullable<SyncRecord['terminalError']>;
  /** another tab quarantines the row while the HTTP request is in flight */
  quarantineDuringDispatch?: NonNullable<SyncRecord['terminalError']>;
}): Harness {
  const epoch = { value: 1 };
  const writes: SyncRecord[] = [];
  const pausedCommits: Array<{ record: SyncRecord; pausedAt: number }> = [];
  const row: { value: SyncRecord | undefined } = { value: opts?.prev };
  const h: Harness = {
    deps: null as unknown as UploadAttemptDeps,
    writes, pausedCommits, blockedCommits: 0, row, httpCalls: 0, epoch,
  };
  const quarantineRow = (reason: NonNullable<SyncRecord['terminalError']>) => {
    row.value = {
      noteId: 'note-1', kind: 'note', txId: row.value?.txId, status: 'error',
      transport: 'proxy', updatedAt: NOW, recovery: row.value?.recovery,
      terminalError: reason,
    };
  };
  h.deps = {
    now: () => NOW,
    currentEpoch: () => epoch.value,
    getSyncRecord: async () => row.value,
    beginUpload: async (noteId, kind, now) => {
      if (row.value?.terminalError !== undefined) return false;
      row.value = toUploading(noteId, kind, row.value, now);
      writes.push(row.value);
      if (opts?.lockDuringToUploading) epoch.value++;
      return true;
    },
    commitResult: async (_noteId, build) => {
      if (row.value?.terminalError !== undefined) {
        h.blockedCommits++;
        return;
      }
      const next = build(row.value);
      if (next !== null) {
        row.value = next;
        writes.push(next);
      }
    },
    commitV3PausedFailure: async (_noteId, build, pausedAt) => {
      // Marker unconditional, record terminal-preserving — like the real one.
      if (row.value?.terminalError !== undefined) {
        h.blockedCommits++;
        pausedCommits.push({ record: row.value, pausedAt });
        return;
      }
      const rec = build(row.value);
      row.value = rec;
      pausedCommits.push({ record: rec, pausedAt });
    },
    commitV4PausedFailure: async (noteId, build, pausedAt) => {
      await h.deps.commitV3PausedFailure(noteId, build, pausedAt);
    },
    signPayload: async () => {
      if (opts?.lockDuringSign) epoch.value++;
      if (opts?.quarantineDuringSign) quarantineRow(opts.quarantineDuringSign);
      return 'signature-b64';
    },
    uploadViaProxy: async () => {
      h.httpCalls++;
      if (opts?.lockDuringDispatch) epoch.value++;
      if (opts?.quarantineDuringDispatch) quarantineRow(opts.quarantineDuringDispatch);
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

  it('commits the failure record + pause via commitV3PausedFailure, NOT the ordinary result commit', async () => {
    const h = makeHarness({ result: V3_DISABLED });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    // Only the begin write went through the ordinary path — the final record
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

// ─── §1.9: терминальный карантин и монотонность terminalError ────────

const QUARANTINED_PREV: SyncRecord = {
  noteId: 'note-1', kind: 'note', txId: 'TX-old', status: 'error', transport: 'proxy',
  updatedAt: NOW - 100_000, recovery: { txId: 'TX-old', postedAt: NOW - 200_000, token: 'tok' },
  terminalError: 'recovery_invalidated',
};

describe('runUploadAttempt — карантин между постановкой в очередь и begin', () => {
  it('терминальная запись при входе: begin отказывает, HTTP не отправляется, outcome blocked', async () => {
    const h = makeHarness({ prev: QUARANTINED_PREV });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]); // ни toUploading, ни чего-либо ещё
    expect(h.row.value).toEqual(QUARANTINED_PREV); // карантин нетронут
  });

  it('вторая вкладка ставит карантин ВО ВРЕМЯ подписи (до begin): отказ без HTTP', async () => {
    const h = makeHarness({ quarantineDuringSign: 'recovery_invalidated' });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.row.value?.terminalError).toBe('recovery_invalidated');
  });
});

describe('runUploadAttempt — поздний результат не стирает карантин', () => {
  // Гонка из плана: вкладка B ушла в HTTP, вкладка A поставила карантин,
  // затем B завершилась — accepted, 503 и обычной ошибкой. Во всех трёх
  // случаях карантин обязан сохраниться.
  it.each([
    ['accepted', { kind: 'accepted', txId: 'TX-late', committed: true } as UploadResult],
    ['503/unavailable', { kind: 'unavailable', error: '503' } as UploadResult],
    ['обычная ошибка', { kind: 'error', error: 'boom' } as UploadResult],
  ])('карантин во время запроса + результат «%s» → коммит заблокирован', async (_label, result) => {
    const h = makeHarness({ result, quarantineDuringDispatch: 'recovery_invalidated' });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed'); // HTTP состоялся — но…
    expect(h.blockedCommits).toBe(1);       // …запись результата отвергнута
    expect(h.row.value?.terminalError).toBe('recovery_invalidated');
    expect(h.row.value?.status).toBe('error'); // строка карантина, не «accepted»
  });

  it('vN_disabled во время карантина: запись пропущена, но маркер паузы поставлен', async () => {
    const h = makeHarness({
      result: { kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}' },
      quarantineDuringDispatch: 'malformed_record',
    });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.blockedCommits).toBe(1);
    expect(h.pausedCommits).toHaveLength(1); // пауза — состояние ВЕРСИИ, не записи
    expect(h.row.value?.terminalError).toBe('malformed_record');
  });
});

describe('runUploadAttempt — recovery_invalid → терминальный карантин', () => {
  const RECOVERY_INVALID: UploadResult = {
    kind: 'recovery_invalid',
    error: '{"code":"recovery_invalid","error":"Invalid recovery token"}',
  };

  it('запись становится recovery_invalidated; txId и recovery-данные сохранены', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
      recovery: { txId: 'TX-old', postedAt: NOW - 200_000, token: 'tok' },
    };
    const h = makeHarness({ prev, result: RECOVERY_INVALID });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    const final = h.row.value!;
    expect(final.terminalError).toBe('recovery_invalidated');
    expect(final.status).toBe('error');
    expect(final.needsRecheck).toBe(false); // вечный recheck остановлен
    expect(final.txId).toBe('TX-old');      // доказательства сохранены
    expect(final.recovery).toEqual(prev.recovery);
  });

  it('без prev.txId берётся txId из recovery-хинта (единственный след транзакции)', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', kind: 'note', status: 'error', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
      recovery: { txId: 'TX-hint', postedAt: NOW - 200_000, token: 'tok' },
    };
    const h = makeHarness({ prev, result: RECOVERY_INVALID });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.row.value?.txId).toBe('TX-hint');
  });

  it('уже стоящий карантин ДРУГОЙ причины не перезаписывается', async () => {
    const h = makeHarness({
      result: RECOVERY_INVALID,
      quarantineDuringDispatch: 'unsupported_version',
    });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.blockedCommits).toBe(1);
    expect(h.row.value?.terminalError).toBe('unsupported_version'); // первая причина стоит
  });
});
