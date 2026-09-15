import { describe, it, expect } from 'vitest';
import { runUploadAttempt, uploadItemId, type UploadAttemptDeps, type UploadKeys } from './upload-flow';
import { toUploading } from './sync-transitions';
import type { UploadResult } from './arweave';
import type { SyncRecord } from './storage';
import type { EncryptedNote } from './crypto';

// Blocker tests (§7/§10): the point of no return. A lock BEFORE it cancels the
// attempt with zero writes and zero HTTP; a lock AFTER it changes nothing —
// the request dispatches and its result is persisted unconditionally.

const NOW = 1_750_000_000_000;

/** A real UUIDv4: v1/v2 ids live in that namespace, and the client now
 *  refuses anything else BEFORE signing (assertUploadableItem). */
const NOTE_ID = '11111111-2222-4333-8444-555555555555';

const NOTE: EncryptedNote = {
  noteId: NOTE_ID,
  // 16 bytes exactly: the GCM tag floor assertUploadableItem now enforces.
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
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
  pausedCommits: Array<{ record: SyncRecord; pausedAt: number; markers: string[] }>;
  /** Result commits REFUSED because the fresh row was quarantined. */
  blockedCommits: number;
  /** Result commits REFUSED because the fresh row belongs to another attempt
   *  (D14a) — a late answer arriving after someone else took the row over. */
  staleCommits: number;
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
  /** a restore/import replaced the stored payload between the queue snapshot
   *  and the atomic begin — the payload-CAS must refuse (D14) */
  payloadChangedBeforeBegin?: boolean;
  /** another writer takes the record over WHILE the request is in flight,
   *  leaving exactly what an import's rule 3 leaves: a minimal retryable row
   *  with no attempt owner. The late answer must not land on it (D14a). */
  takeoverDuringDispatch?: boolean;
}): Harness {
  const epoch = { value: 1 };
  let attemptCounter = 0;
  const writes: SyncRecord[] = [];
  const pausedCommits: Array<{ record: SyncRecord; pausedAt: number; markers: string[] }> = [];
  /** Marker(s) unconditional; the RECORD half is terminal-preserving AND
   *  attempt-scoped — like the real one. */
  const pauseCommit = (
    build: (fresh: SyncRecord | undefined) => SyncRecord,
    pausedAt: number,
    markers: string[],
    attemptId: string,
  ) => {
    if (row.value?.terminalError !== undefined) {
      h.blockedCommits++;
      pausedCommits.push({ record: row.value, pausedAt, markers });
      return;
    }
    if (row.value?.attemptId !== attemptId) {
      h.staleCommits++;
      pausedCommits.push({ record: row.value!, pausedAt, markers });
      return;
    }
    const rec = build(row.value);
    row.value = rec;
    pausedCommits.push({ record: rec, pausedAt, markers });
  };
  const row: { value: SyncRecord | undefined } = { value: opts?.prev };
  const h: Harness = {
    deps: null as unknown as UploadAttemptDeps,
    writes, pausedCommits, blockedCommits: 0, staleCommits: 0, row, httpCalls: 0, epoch,
  };
  const quarantineRow = (reason: NonNullable<SyncRecord['terminalError']>) => {
    row.value = {
      noteId: NOTE_ID, kind: 'note', txId: row.value?.txId, status: 'error',
      transport: 'proxy', updatedAt: NOW, recovery: row.value?.recovery,
      terminalError: reason,
    };
  };
  h.deps = {
    now: () => NOW,
    currentEpoch: () => epoch.value,
    getSyncRecord: async () => row.value,
    // Mirrors storage.beginUploadUnlessTerminal: quarantine guard, then the
    // payload-CAS against the SNAPSHOT (D14), then the attempt stamp (D14a).
    beginUpload: async (queued, now) => {
      if (row.value?.terminalError !== undefined) return { ok: false, reason: 'blocked' as const };
      if (opts?.payloadChangedBeforeBegin) return { ok: false, reason: 'stale' as const };
      const attemptId = `attempt-${++attemptCounter}`;
      row.value = toUploading(uploadItemId(queued), queued.kind, row.value, now, attemptId);
      writes.push(row.value);
      if (opts?.lockDuringToUploading) epoch.value++;
      return { ok: true as const, attemptId };
    },
    // Mirrors storage.commitUploadResultIfAttempt: quarantine reported first,
    // then the attempt check — both refuse before `build` runs.
    commitResult: async (_noteId, attemptId, build) => {
      if (row.value?.terminalError !== undefined) {
        h.blockedCommits++;
        return;
      }
      if (row.value?.attemptId !== attemptId) {
        h.staleCommits++;
        return;
      }
      const next = build(row.value);
      if (next !== null) {
        row.value = next;
        writes.push(next);
      }
    },
    commitV3PausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      pauseCommit(build, pausedAt, ['v3'], attemptId);
    },
    commitV4PausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      pauseCommit(build, pausedAt, ['v4'], attemptId);
    },
    // The GLOBAL switch pauses every version in ONE transaction.
    commitGlobalPausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      pauseCommit(build, pausedAt, ['global'], attemptId);
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
      if (opts?.takeoverDuringDispatch) {
        row.value = {
          noteId: NOTE_ID, kind: 'note', status: 'error',
          transport: 'proxy', updatedAt: NOW,
        };
      }
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
      noteId: NOTE_ID, kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
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
      noteId: NOTE_ID, kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
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
  noteId: NOTE_ID, kind: 'note', txId: 'TX-old', status: 'error', transport: 'proxy',
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
      noteId: NOTE_ID, kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
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
      noteId: NOTE_ID, kind: 'note', status: 'error', transport: 'proxy',
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

// ─── D14 / D14a: the two CAS guards, seen from the attempt state machine ─────

describe('D14 — a snapshot the store no longer holds is never dispatched', () => {
  it('the atomic begin refuses with «stale»: no HTTP, no writes', async () => {
    const h = makeHarness({
      prev: { noteId: NOTE_ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1 },
      payloadChangedBeforeBegin: true,
    });

    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(outcome).toEqual({ kind: 'stale' });
    expect(h.httpCalls).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.row.value?.status).toBe('error'); // the row keeps its previous state
  });
});

describe('D14a — a late answer never lands on a row this attempt no longer owns', () => {
  /** Every branch that persists something. The scenario is identical in each:
   *  the request is in flight, another writer normalizes the row (exactly what
   *  an import leaves — a minimal retryable row with no attempt owner), and the
   *  answer finally arrives. Covering ONLY the successful branch would be
   *  useless: an `in_progress`, a quarantine verdict or a 5xx written onto
   *  someone else's row is the same defect with a different value. */
  const BRANCHES: ReadonlyArray<{
    name: string;
    result: UploadResult;
    prev?: SyncRecord;
    paused?: 'v3' | 'v4';
  }> = [
    { name: 'accepted', result: ACCEPTED },
    {
      name: 'in_progress WITH a prior txId (restores accepted)',
      result: { kind: 'in_progress', error: '409' },
      prev: { noteId: NOTE_ID, kind: 'note', txId: 'TX-OLD', status: 'accepted', transport: 'proxy', updatedAt: NOW - 1 },
    },
    { name: 'in_progress WITHOUT one (falls back to a failure)', result: { kind: 'in_progress', error: '409' } },
    { name: 'recovery_invalid (quarantine verdict)', result: { kind: 'recovery_invalid', error: 'recovery_invalid' } },
    { name: 'generic 5xx', result: { kind: 'unavailable', error: '503' } },
    { name: 'error', result: { kind: 'error', error: 'boom' } },
    { name: 'v3_disabled', result: { kind: 'v3_disabled', error: 'v3_uploads_disabled' }, paused: 'v3' },
    { name: 'v4_disabled', result: { kind: 'v4_disabled', error: 'v4_uploads_disabled' }, paused: 'v4' },
  ];

  for (const branch of BRANCHES) {
    it(`${branch.name}: the answer is dropped and the row is untouched`, async () => {
      const h = makeHarness({ prev: branch.prev, result: branch.result, takeoverDuringDispatch: true });

      const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

      // The request DID happen and its outcome is reported honestly...
      expect(outcome).toEqual({ kind: 'committed', result: branch.result });
      expect(h.httpCalls).toBe(1);
      // ...but nothing was written on top of the new owner's row.
      expect(h.staleCommits).toBe(1);
      expect(h.blockedCommits).toBe(0);
      expect(h.row.value).toEqual({
        noteId: NOTE_ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW,
      });
      // Only the 'uploading' write of this attempt ever applied.
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0].status).toBe('uploading');
    });
  }

  it('the version-global pause marker is written even when the record half is skipped', async () => {
    // The kill switch is state about the WORKER, not about this attempt.
    // Dropping it because the row changed owners would let the next unlock
    // burst the whole backlog at a worker that has already said no.
    const h = makeHarness({
      result: { kind: 'v3_disabled', error: 'v3_uploads_disabled' },
      takeoverDuringDispatch: true,
    });

    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(h.pausedCommits).toHaveLength(1);
    expect(h.pausedCommits[0].pausedAt).toBe(NOW);
    expect(h.staleCommits).toBe(1);
  });

  it('an UNDISTURBED attempt still applies its answer (the guard is not a blanket refusal)', async () => {
    const h = makeHarness({ result: ACCEPTED });

    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(h.staleCommits).toBe(0);
    expect(h.row.value?.status).toBe('accepted');
    expect(h.row.value?.txId).toBe('TX9');
    // The row left 'uploading', so it no longer names an attempt — a replayed
    // or duplicated answer finds nothing to match.
    expect(h.row.value?.attemptId).toBeUndefined();
  });
});

describe('runUploadAttempt — uploads_disabled (GLOBAL kill switch)', () => {
  const GLOBAL_DISABLED: UploadResult = {
    kind: 'uploads_disabled', error: '{"code":"uploads_disabled"}',
  };

  // The global switch refuses v1–v4 alike, before the body is even read.
  // Pausing only this item's version would leave the queue marching through the
  // rest of the backlog against a worker that answers 503 to all of it — the
  // incident lever would look like it did nothing.
  it('writes the dedicated GLOBAL marker, not the two version ones', async () => {
    const h = makeHarness({ result: GLOBAL_DISABLED });
    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(outcome.kind).toBe('committed');
    expect(h.pausedCommits).toHaveLength(1);
    // A dedicated key, because the queue consults the version markers only for
    // v3/safebox — writing those would have left v1/v2 uploading.
    expect(h.pausedCommits[0].markers).toEqual(['global']);
    expect(h.pausedCommits[0].pausedAt).toBe(NOW);
    expect(h.pausedCommits[0].record.status).toBe('error');
    expect(h.pausedCommits[0].record.lastError).toContain('uploads_disabled');
  });

  it('preserves txId/recovery like every other pause branch', async () => {
    const prev: SyncRecord = {
      noteId: 'note-1', kind: 'note', txId: 'TX-old', status: 'accepted', transport: 'proxy',
      updatedAt: NOW - 100_000, needsRecheck: true,
      recovery: { txId: 'TX-old', postedAt: NOW - 200_000, token: 'tok' },
    };
    const h = makeHarness({ prev, result: GLOBAL_DISABLED });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    const rec = h.pausedCommits[0].record;
    expect(rec.txId).toBe('TX-old');
    expect(rec.recovery).toEqual(prev.recovery);
  });

  it('persists even when a lock lands mid-dispatch', async () => {
    const h = makeHarness({ lockDuringDispatch: true, result: GLOBAL_DISABLED });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.pausedCommits).toHaveLength(1);
  });

  it('a per-version switch still pauses only its own version', async () => {
    const h3 = makeHarness({ result: { kind: 'v3_disabled', error: 'x' } });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h3.deps);
    expect(h3.pausedCommits[0].markers).toEqual(['v3']);
  });
});

describe('publication_conflict — the id is spent, and the record says so', () => {
  it('quarantines terminally and stops rechecking', async () => {
    // Read as a generic 409 this would be `in_progress` and retried forever
    // against an answer that can never change. The whole point of the typed
    // code is that the queue converges instead.
    const h = makeHarness({
      result: { kind: 'publication_conflict', error: '{"code":"id_payload_conflict","txId":"TX-THEIRS"}' },
    });

    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(outcome.kind).toBe('committed');
    expect(h.row.value?.terminalError).toBe('publication_conflict');
    expect(h.row.value?.needsRecheck).toBe(false);
  });

  it('does NOT record the conflicting txId', async () => {
    // Storing it would write the exact binding the fingerprint protocol exists
    // to prevent — payload B under transaction A — this time by the client.
    const prev: SyncRecord = {
      noteId: NOTE_ID, kind: 'note', txId: 'TX-OURS', status: 'accepted',
      transport: 'proxy', updatedAt: NOW - 1,
    };
    const h = makeHarness({
      prev,
      result: { kind: 'publication_conflict', error: '{"code":"id_payload_conflict","txId":"TX-THEIRS"}' },
    });

    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    // The AUTHORITATIVE fields keep ours and gain nothing from the server.
    expect(h.row.value?.txId).toBe('TX-OURS');
    expect(h.row.value?.recovery?.txId).toBeUndefined();
    // `lastError` carries the raw body, conflicting id included — deliberate,
    // and the only place it may appear: storage.ts documents it as diagnostics.
    // What must never happen is that id becoming the record's OWN txId.
    expect(h.row.value?.lastError).toContain('TX-THEIRS');
  });

  it('a late conflict never lands on a row this attempt no longer owns (D14a)', async () => {
    const h = makeHarness({
      result: { kind: 'publication_conflict', error: 'conflict' },
      takeoverDuringDispatch: true,
    });

    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(h.staleCommits).toBe(1);
    expect(h.row.value?.terminalError).toBeUndefined();
  });
});

describe('unattested — below-floor worker, the hint is evidence and the txId is not', () => {
  const HINT = { txId: 'TX-POSTED', postedAt: NOW - 5, token: 'tok' };

  it('records the recovery hint, not the txId, and stays retryable', async () => {
    const h = makeHarness({ result: { kind: 'unattested', error: 'no attestation', recovery: HINT } });

    const outcome = await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);

    expect(outcome.kind).toBe('committed');
    expect(h.row.value?.txId).toBeUndefined();          // not taken
    expect(h.row.value?.recovery).toEqual(HINT);         // kept as evidence
    expect(h.row.value?.needsRecheck).toBe(true);        // the next attempt sends it back
    expect(h.row.value?.terminalError).toBeUndefined();  // retryable, not a verdict
  });

  it('without a hint it is an ordinary retryable failure', async () => {
    const h = makeHarness({ result: { kind: 'unattested', error: 'no attestation' } });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.row.value?.txId).toBeUndefined();
    expect(h.row.value?.recovery).toBeUndefined();
    expect(h.row.value?.status).toBe('error');
  });

  it('never downgrades a row that already holds a txId', async () => {
    const prev: SyncRecord = {
      noteId: NOTE_ID, kind: 'note', txId: 'TX-OURS', status: 'accepted',
      transport: 'proxy', updatedAt: NOW - 1,
    };
    const h = makeHarness({ prev, result: { kind: 'unattested', error: 'no attestation', recovery: HINT } });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.row.value?.txId).toBe('TX-OURS');
    expect(h.row.value?.status).toBe('accepted');
    expect(h.row.value?.recovery).toEqual(HINT);
  });
});
