import { describe, it, expect } from 'vitest';
import {
  runUploadAttempt,
  assertUploadableItem,
  uploadItemId,
  MalformedRecordError,
  type UploadAttemptDeps,
  type UploadItem,
  type UploadKeys,
} from './upload-flow';
import { toUploading } from './sync-transitions';
import type { UploadResult } from './arweave';
import { UnsupportedSafeboxVersionError } from './arweave';
import type { SyncRecord } from './storage';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import { UnsupportedNoteVersionError } from './crypto';

// The queue is kind-tagged: the payload builder and the pause marker are chosen
// from the ITEM, never sniffed off a record read back from IndexedDB. And every
// transition must carry `kind` (and `terminalError`) through untouched.

const NOW = 1_750_000_000_000;
const IV12 = 'AAAAAAAAAAAAAAAA';

const SB: EncryptedSafeboxEntry = {
  entryId: '11111111-2222-8333-8444-555555555555',
  // 16 bytes each: the GCM tag floor assertUploadableItem now enforces.
  metaCiphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', metaIv: IV12,
  secretCiphertext: 'QkJCQkJCQkJCQkJCQkJCQg==', secretIv: IV12,
  createdAt: NOW - 60_000, v: 4,
};
const SB_ITEM: UploadItem = { kind: 'safebox', record: SB };
const NOTE_ITEM: UploadItem = {
  kind: 'note',
  record: { noteId: '66666666-7777-8333-9444-555555555555', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: IV12, createdAt: NOW - 1000, v: 3 },
};

const KEYS: UploadKeys = {
  signingKey: new Uint8Array(32).fill(7),
  ownerHash: 'A'.repeat(44),
  publicKey: new Uint8Array(32).fill(9),
};

function harness(opts: { prev?: SyncRecord; result?: UploadResult } = {}) {
  const writes: SyncRecord[] = [];
  let attemptCounter = 0;
  const v3Pauses: Array<{ record: SyncRecord; pausedAt: number }> = [];
  const v4Pauses: Array<{ record: SyncRecord; pausedAt: number }> = [];
  const globalPauses: Array<{ record: SyncRecord; pausedAt: number }> = [];
  // In-memory sync row — the «fresh» source every commit re-reads, mirroring
  // the terminal-preserving storage primitives (§1.9).
  const row: { value: SyncRecord | undefined } = { value: opts.prev };
  let bodyText = '';
  let httpCalls = 0;
  const deps: UploadAttemptDeps = {
    now: () => NOW,
    currentEpoch: () => 1,
    getSyncRecord: async () => row.value,
    beginUpload: async (queued, now) => {
      if (row.value?.terminalError !== undefined) return { ok: false, reason: 'blocked' as const };
      const attemptId = `attempt-${++attemptCounter}`;
      row.value = toUploading(uploadItemId(queued), queued.kind, row.value, now, attemptId);
      writes.push(row.value);
      return { ok: true as const, attemptId };
    },
    commitResult: async (_noteId, attemptId, build) => {
      if (row.value?.terminalError !== undefined) return;
      if (row.value?.attemptId !== attemptId) return;
      const next = build(row.value);
      if (next !== null) { row.value = next; writes.push(next); }
    },
    // Marker unconditional, record half terminal-preserving AND attempt-scoped.
    commitV3PausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      if (row.value?.terminalError === undefined && row.value?.attemptId === attemptId) {
        row.value = build(row.value);
      }
      v3Pauses.push({ record: row.value!, pausedAt });
    },
    commitV4PausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      if (row.value?.terminalError === undefined && row.value?.attemptId === attemptId) {
        row.value = build(row.value);
      }
      v4Pauses.push({ record: row.value!, pausedAt });
    },
    // The GLOBAL switch: same discipline, its own ledger.
    commitGlobalPausedFailure: async (_noteId, attemptId, build, pausedAt) => {
      if (row.value?.terminalError === undefined && row.value?.attemptId === attemptId) {
        row.value = build(row.value);
      }
      globalPauses.push({ record: row.value!, pausedAt });
    },
    signPayload: async () => 'sig',
    uploadViaProxy: async body => {
      httpCalls++;
      bodyText = body;
      return opts.result ?? { kind: 'accepted', txId: 'TX', committed: true };
    },
  };
  return { deps, writes, v3Pauses, v4Pauses, globalPauses, row, calls: () => httpCalls, body: () => bodyText };
}

describe('uploadItemId', () => {
  it('reads the right primary key per kind', () => {
    expect(uploadItemId(NOTE_ITEM)).toBe(NOTE_ITEM.record.noteId);
    expect(uploadItemId(SB_ITEM)).toBe(SB.entryId);
  });
});

describe('kind-driven serialization', () => {
  it('a safebox item is sent as App-Version=4 with the split-envelope data', async () => {
    const h = harness();
    await runUploadAttempt(SB_ITEM, KEYS, 1, h.deps);
    const payload = JSON.parse(h.body()) as { tags: Array<{ name: string; value: string }>; data: string };
    expect(payload.tags.find(t => t.name === 'App-Version')?.value).toBe('4');
    expect(Object.keys(JSON.parse(payload.data)).sort()).toEqual(['id', 'mc', 'miv', 'sc', 'siv']);
  });

  it('a note item is still sent as its own version', async () => {
    const h = harness();
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    const payload = JSON.parse(h.body()) as { tags: Array<{ name: string; value: string }>; data: string };
    expect(payload.tags.find(t => t.name === 'App-Version')?.value).toBe('3');
    expect(Object.keys(JSON.parse(payload.data)).sort()).toEqual(['c', 'id', 'iv']);
  });

  it('EVERY persisted transition carries kind:safebox', async () => {
    for (const result of [
      { kind: 'accepted', txId: 'T', committed: true },
      { kind: 'unavailable', error: 'ua' },
      { kind: 'in_progress', error: '409' },
    ] as UploadResult[]) {
      const h = harness({ result });
      await runUploadAttempt(SB_ITEM, KEYS, 1, h.deps);
      expect(h.writes.length).toBeGreaterThan(0);
      for (const w of h.writes) expect(w.kind).toBe('safebox');
    }
  });

  it('карантинная запись вообще не стартует: begin отказывает, HTTP нет (§1.9)', async () => {
    // Раньше terminalError «переживал» транзишены; теперь строже — карантинная
    // строка не доходит до транзишенов вовсе: атомарный begin отказывает.
    const prev: SyncRecord = {
      noteId: SB.entryId, kind: 'safebox', status: 'error', transport: 'proxy',
      updatedAt: NOW - 1, terminalError: 'unsupported_version',
    };
    const h = harness({ prev, result: { kind: 'unavailable', error: 'ua' } });
    const outcome = await runUploadAttempt(SB_ITEM, KEYS, 1, h.deps);
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(h.calls()).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.row.value?.terminalError).toBe('unsupported_version');
  });
});

describe('v4 kill switch routing', () => {
  it('a v4_disabled result commits the V4 pause marker, never the v3 one', async () => {
    const h = harness({ result: { kind: 'v4_disabled', error: '{"code":"v4_uploads_disabled"}' } });
    await runUploadAttempt(SB_ITEM, KEYS, 1, h.deps);
    expect(h.v4Pauses).toHaveLength(1);
    expect(h.v3Pauses).toHaveLength(0);
    expect(h.v4Pauses[0].record.kind).toBe('safebox');
    expect(h.v4Pauses[0].record.status).toBe('error');
    expect(h.writes.map(w => w.status)).toEqual(['uploading']); // final record went atomically
  });

  it('a v3_disabled result still commits the V3 marker', async () => {
    const h = harness({ result: { kind: 'v3_disabled', error: '{"code":"v3_uploads_disabled"}' } });
    await runUploadAttempt(NOTE_ITEM, KEYS, 1, h.deps);
    expect(h.v3Pauses).toHaveLength(1);
    expect(h.v4Pauses).toHaveLength(0);
  });

  it('the pause preserves txId/recovery/needsRecheck from the prior record', async () => {
    const prev: SyncRecord = {
      noteId: SB.entryId, kind: 'safebox', txId: 'TX-OLD', status: 'accepted',
      transport: 'proxy', updatedAt: NOW - 100, needsRecheck: true,
      recovery: { txId: 'TX-OLD', postedAt: NOW - 200, token: 'tok' },
    };
    const h = harness({ prev, result: { kind: 'v4_disabled', error: 'x' } });
    await runUploadAttempt(SB_ITEM, KEYS, 1, h.deps);
    const rec = h.v4Pauses[0].record;
    expect(rec.txId).toBe('TX-OLD');
    expect(rec.recovery).toEqual(prev.recovery);
    expect(rec.status).not.toBe('uploading');
  });
});

describe('malformed-record quarantine (no HTTP, no writes)', () => {
  it('rejects a safebox row with a non-12-byte IV BEFORE anything is sent', async () => {
    const h = harness();
    await expect(runUploadAttempt(
      { kind: 'safebox', record: { ...SB, secretIv: 'AAAA' } }, KEYS, 1, h.deps,
    )).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.calls()).toBe(0);
    expect(h.writes).toEqual([]); // no stranded 'uploading'
  });

  it('assertUploadableItem enforces the whole shape', () => {
    expect(() => assertUploadableItem(SB_ITEM)).not.toThrow();
    const bad: Array<Partial<EncryptedSafeboxEntry>> = [
      // NOTE: an unrecognized `v` is deliberately absent from this list — it is
      // an OPAQUE record, not a malformed one. See the dedicated test below.
      { entryId: 'not-a-uuid' },
      { entryId: '11111111-2222-4333-8444-555555555555' }, // UUIDv4 → wrong namespace
      { metaCiphertext: '' },
      { metaIv: 'AAAA' },
      { secretCiphertext: '' },
      { createdAt: -1 },
      // Valid base64, but shorter than the 128-bit GCM tag: provably not
      // something AES-GCM produced. Both halves are checked.
      { metaCiphertext: 'AAAA' },                        // 3 bytes
      { secretCiphertext: 'AAAA' },                      // 3 bytes
      { metaCiphertext: 'AAAAAAAAAAAAAAAAAAAA' },        // 15 bytes — one short
      { secretCiphertext: 'AAAAAAAAAAAAAAAAAAAA' },      // 15 bytes — one short
    ];
    for (const patch of bad) {
      expect(() => assertUploadableItem({ kind: 'safebox', record: { ...SB, ...patch } }),
        JSON.stringify(patch)).toThrow(MalformedRecordError);
    }
  });

  it('also guards note rows (a corrupted iv can never be posted)', () => {
    expect(() => assertUploadableItem({
      kind: 'note', record: { noteId: '11111111-2222-4333-8444-555555555555', ciphertext: 'AAAA', iv: 'AAAA', createdAt: 1 },
    })).toThrow(MalformedRecordError);
  });

  it('a NON-CANONICAL base64 spelling is quarantined, though it decodes fine', () => {
    // All three below are accepted by `atob` and decode to the same 16 valid
    // bytes — they differ only in spelling: missing padding, non-zero trailing
    // bits, trailing whitespace. The spelling is what gets published (`data` is
    // a JSON string), so a variant would go on chain as a DIFFERENT record for
    // the same bytes, permanently, under the same idempotent id.
    const V4 = '11111111-2222-4333-8444-555555555555';
    const iv = 'AAAAAAAAAAAAAAAA';
    const variants = [
      'AAAAAAAAAAAAAAAAAAAAAA',    // no padding
      'AAAAAAAAAAAAAAAAAAAAAB==',  // non-zero trailing bits
      'AAAAAAAAAAAAAAAAAAAAAA==\n', // trailing whitespace
    ];
    for (const ciphertext of variants) {
      expect(() => assertUploadableItem({
        kind: 'note', record: { noteId: V4, ciphertext, iv, createdAt: 1 },
      }), ciphertext).toThrow(MalformedRecordError);
    }
    // The IV is held to the same rule. Note that a 12-byte IV has NO spare
    // bits — 16 base64 chars, no padding — so its only non-canonical spellings
    // are superfluous padding and whitespace.
    expect(() => assertUploadableItem({
      kind: 'note',
      record: { noteId: V4, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA==', createdAt: 1 },
    })).toThrow(MalformedRecordError);
    // ...and the canonical spelling passes.
    expect(() => assertUploadableItem({
      kind: 'note',
      record: { noteId: V4, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv, createdAt: 1 },
    })).not.toThrow();
  });

  it('an id from the WRONG namespace is quarantined before anything is signed', () => {
    // v1/v2 ids are UUIDv4, v3/v4 ids are UUIDv8 — disjoint namespaces the
    // worker enforces with a plain 400. A plain 400 is untyped, so the client
    // would turn it into a RETRYABLE error and re-enqueue the row on every
    // queue pass: one corrupted record becomes an endless request loop that
    // burns the shared IP rate limit. Caught here instead, with no HTTP.
    const iv = 'AAAAAAAAAAAAAAAA';
    const ciphertext = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const V4 = '11111111-2222-4333-8444-555555555555';
    const V8 = '66666666-7777-8333-9444-555555555555';

    const bad: Array<[string, Partial<EncryptedNote>]> = [
      ['v1 with a UUIDv8 id', { noteId: V8 }],
      ['v2 with a UUIDv8 id', { noteId: V8, v: 2 }],
      ['v3 with a UUIDv4 id', { noteId: V4, v: 3 }],
      ['an arbitrary non-empty string', { noteId: 'note-1' }],
      ['an empty id', { noteId: '' }],
      ['a UUID-shaped string with a bad variant nibble', { noteId: '11111111-2222-4333-0444-555555555555' }],
    ];
    for (const [name, patch] of bad) {
      expect(() => assertUploadableItem({
        kind: 'note', record: { noteId: V4, ciphertext, iv, createdAt: 1, ...patch },
      }), name).toThrow(MalformedRecordError);
    }

    // ...and the two legitimate namespaces pass.
    expect(() => assertUploadableItem({
      kind: 'note', record: { noteId: V4, ciphertext, iv, createdAt: 1 },
    })).not.toThrow();
    expect(() => assertUploadableItem({
      kind: 'note', record: { noteId: V8, ciphertext, iv, createdAt: 1, v: 3 },
    })).not.toThrow();
  });

  it('an unknown SAFEBOX version is opaque, not malformed — no signature, no HTTP', async () => {
    // The distinction D14b calls load-bearing, on the half that used to get it
    // wrong: `v: 5` was collapsed into MalformedRecordError, which maps to
    // `malformed_record` — the verdict under which D5a lets a backup REPLACE
    // the bytes. A record written by a NEWER build would then be overwritten by
    // an older copy of itself. It must surface as UnsupportedSafeboxVersionError
    // → `unsupported_version`, the verdict that never replaces.
    for (const v of [5, 3, undefined, 'garbage']) {
      const record = { ...SB, v } as unknown as EncryptedSafeboxEntry;
      expect(() => assertUploadableItem({ kind: 'safebox', record }), String(v)).not.toThrow();

      const h = harness();
      await expect(runUploadAttempt({ kind: 'safebox', record }, KEYS, 1, h.deps), String(v))
        .rejects.toBeInstanceOf(UnsupportedSafeboxVersionError);
      expect(h.calls(), String(v)).toBe(0);
      expect(h.writes, String(v)).toEqual([]);
    }
  });

  it('unknown version AND a broken entryId is MALFORMED, not opaque — the stable field wins', async () => {
    // Priority, stated as behaviour: `entryId` is stable across every version of
    // a safebox record, so it is judged first. A row that is both of an unknown
    // version and missing a usable id is provably broken — sealing it as
    // 'unsupported_version' would promise never to replace it, which for a
    // corrupted row means never repairing it from a backup either (D5a).
    const brokenIds: unknown[] = [
      '',                                       // empty
      'not-a-uuid',                             // arbitrary string
      '11111111-2222-4333-8444-555555555555',   // the WRONG namespace (UUIDv4)
      42,                                       // not a string at all
      null,
      undefined,
    ];
    for (const entryId of brokenIds) {
      const record = { ...SB, v: 5, entryId } as unknown as EncryptedSafeboxEntry;
      expect(() => assertUploadableItem({ kind: 'safebox', record }), String(entryId))
        .toThrow(MalformedRecordError);
    }
    // ...while an unknown version with a VALID id stays opaque.
    const opaque = { ...SB, v: 5 } as unknown as EncryptedSafeboxEntry;
    expect(() => assertUploadableItem({ kind: 'safebox', record: opaque })).not.toThrow();
  });

  it('an UNRECOGNIZED note version is NOT judged by the namespace rule', async () => {
    // It must surface as UnsupportedNoteVersionError, not MalformedRecordError.
    // The distinction is load-bearing: D5a treats an OPAQUE record — one a
    // NEWER build wrote — differently from a malformed one and must never
    // replace it. Mislabelling it here would throw that protection away.
    const opaque = {
      noteId: '66666666-7777-8333-9444-555555555555',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA',
      createdAt: 1, v: 9,
    } as unknown as EncryptedNote;

    expect(() => assertUploadableItem({ kind: 'note', record: opaque })).not.toThrow();

    const h = harness();
    await expect(runUploadAttempt({ kind: 'note', record: opaque }, KEYS, 1, h.deps))
      .rejects.toBeInstanceOf(UnsupportedNoteVersionError);
    expect(h.calls()).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it('a wrong-namespace id never reaches the network', async () => {
    const h = harness();
    await expect(runUploadAttempt({
      kind: 'note',
      record: {
        noteId: '66666666-7777-8333-9444-555555555555', // v8 id on a v1 record
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', createdAt: 1,
      },
    }, KEYS, 1, h.deps)).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.calls()).toBe(0);
    expect(h.writes).toEqual([]); // no stranded 'uploading'
  });

  it('a ciphertext shorter than the GCM tag is quarantined, never published', () => {
    // The cost of getting this wrong is permanent: the record would be posted
    // under its forever-idempotent noteId, paid for, and undecryptable by
    // anyone including its owner. Valid base64 says nothing about being a
    // cipher envelope, so 0-15 bytes must all fail.
    const iv = 'AAAAAAAAAAAAAAAA';
    for (const ciphertext of ['AAAA', 'AAAAAAAA', 'AAAAAAAAAAAAAAAAAAAA']) {
      expect(() => assertUploadableItem({
        kind: 'note', record: { noteId: '11111111-2222-4333-8444-555555555555', ciphertext, iv, createdAt: 1 },
      }), ciphertext).toThrow(MalformedRecordError);
    }
    // ...and exactly 16 bytes (an empty plaintext plus the tag) passes.
    expect(() => assertUploadableItem({
      kind: 'note', record: { noteId: '11111111-2222-4333-8444-555555555555', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv, createdAt: 1 },
    })).not.toThrow();
  });
});
