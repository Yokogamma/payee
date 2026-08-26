import { describe, it, expect } from 'vitest';
import { decideBackupMerge, type BackupMergeInput, type LocalPayloadState } from './backup-merge';
import type { SyncRecord } from './storage';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';

/**
 * The merge rules, as a table.
 *
 * Two invariants hold in EVERY cell below, and they are asserted for every
 * case rather than argued once: the decision never writes a `txId`, and it
 * never creates a quarantine. The container has no sync store, so a
 * `terminalError` arriving from a file does not exist as a phenomenon — only
 * the fate of a LOCAL one is being decided.
 */

const NOW = 1_750_000_000_000;
const ID = '11111111-2222-4333-8444-555555555555';
const IV = 'AAAAAAAAAAAAAAAA';

const localNote: EncryptedNote = { noteId: ID, ciphertext: 'QUFBQQ==', iv: IV, createdAt: NOW - 5000 };
const incomingSame: EncryptedNote = { ...localNote };
const incomingOther: EncryptedNote = { ...localNote, ciphertext: 'QkJCQg==' };

const row = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1000, ...over,
});

function decide(over: Partial<BackupMergeInput> = {}) {
  return decideBackupMerge({
    id: ID,
    kind: 'note',
    incoming: incomingOther,
    local: localNote,
    localState: 'readable',
    sync: undefined,
    now: NOW,
    ...over,
  });
}

/** Both universal invariants, checked on whatever the table produced. */
function expectNeverPublishesOrQuarantines(d: ReturnType<typeof decide>) {
  if (d.sync !== null) {
    expect(d.sync.txId, 'the import must never write a txId').toBeUndefined();
    expect(d.sync.recovery, 'nor a recovery hint').toBeUndefined();
    expect(d.sync.terminalError, 'the import must never CREATE a quarantine').toBeUndefined();
  }
}

describe('rule 1 — a local quarantine is decided by its REASON (D5a)', () => {
  const cases: Array<[SyncRecord['terminalError'], LocalPayloadState, string, boolean]> = [
    // reason, local state, expected outcome, expected writePayload
    ['unsupported_version', 'opaque', 'unsupportedLocal', false],
    ['unsupported_version', 'readable', 'quarantineStale', false],
    ['unsupported_version', 'corrupt', 'unsupportedLocal', false],
    ['unsupported_version', 'absent', 'unsupportedLocal', false],

    ['malformed_record', 'opaque', 'unsupportedLocal', false],
    ['malformed_record', 'readable', 'quarantineStale', false],
    ['malformed_record', 'corrupt', 'quarantinedRepaired', true],
    ['malformed_record', 'absent', 'quarantinedRepaired', true],

    ['publication_conflict', 'opaque', 'unsupportedLocal', false],
    ['publication_conflict', 'readable', 'noop', false],
    ['publication_conflict', 'corrupt', 'quarantinedDataRepaired', true],
    ['publication_conflict', 'absent', 'quarantinedDataRepaired', true],

    ['recovery_invalidated', 'opaque', 'unsupportedLocal', false],
    ['recovery_invalidated', 'readable', 'noop', false],
    ['recovery_invalidated', 'corrupt', 'quarantinedDataRepaired', true],
    ['recovery_invalidated', 'absent', 'quarantinedDataRepaired', true],
  ];

  for (const [reason, localState, outcome, writePayload] of cases) {
    it(`${reason} + ${localState} → ${outcome}`, () => {
      const d = decide({
        localState,
        local: localState === 'absent' ? undefined : localNote,
        sync: row({ terminalError: reason, txId: 'TX-EVIDENCE' }),
      });
      expect(d.outcome).toBe(outcome);
      expect(d.writePayload).toBe(writePayload);
      expectNeverPublishesOrQuarantines(d);
    });
  }

  it('an OPAQUE local record is never replaced, under any of the four reasons', () => {
    for (const reason of ['unsupported_version', 'malformed_record', 'publication_conflict', 'recovery_invalidated'] as const) {
      const d = decide({ localState: 'opaque', sync: row({ terminalError: reason }) });
      expect(d.writePayload, reason).toBe(false);
      expect(d.sync, reason).toBeNull(); // the quarantine and the bytes both stay
    }
  });

  it('the two blocking reasons keep their evidence when the payload is repaired', () => {
    for (const reason of ['publication_conflict', 'recovery_invalidated'] as const) {
      const d = decide({
        localState: 'corrupt',
        sync: row({ terminalError: reason, txId: 'TX-EVIDENCE', recovery: { txId: 'TX-EVIDENCE', postedAt: 1, token: 't' } }),
      });
      // Bytes restored, and the existing row — terminal, txId, recovery — is
      // left exactly as it was: they forbid PUBLISHING, not reading.
      expect(d.writePayload, reason).toBe(true);
      expect(d.sync, reason).toBeNull();
    }
  });

  it('a lifted quarantine leaves a retryable row with no publication claim', () => {
    const d = decide({ localState: 'readable', sync: row({ terminalError: 'unsupported_version', txId: 'TX-OLD' }) });
    expect(d.outcome).toBe('quarantineStale');
    expect(d.sync).toEqual({ noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW });
  });
});

describe('rule 2 — a readable local payload is never overwritten', () => {
  it('an equivalent record is a no-op and is NOT counted', () => {
    const d = decide({ incoming: incomingSame, localState: 'readable' });
    expect(d).toEqual({ writePayload: false, sync: null, outcome: 'noop' });
  });

  it('a different record is a conflict, and still writes nothing', () => {
    const d = decide({ incoming: incomingOther, localState: 'readable' });
    expect(d).toEqual({ writePayload: false, sync: null, outcome: 'conflicts' });
  });

  it('equivalence ignores fields that never reach the chain', () => {
    // v3 publishes {id,c,iv} and no Timestamp tag, so the outer createdAt is
    // local ordering only — a difference there is not a conflict.
    const v3: EncryptedNote = { ...localNote, v: 3, noteId: '66666666-7777-8333-9444-555555555555' };
    const d = decide({
      local: v3,
      incoming: { ...v3, createdAt: v3.createdAt + 1 },
      localState: 'readable',
    });
    expect(d.outcome).toBe('noop');
  });
});

describe('rule 3 — missing or unusable bytes are restored', () => {
  it('no local record at all → added, and no sync row is invented', () => {
    const d = decide({ localState: 'absent', local: undefined, sync: undefined });
    expect(d).toEqual({ writePayload: true, sync: null, outcome: 'added' });
  });

  it('a damaged local payload → repaired', () => {
    const d = decide({ localState: 'corrupt', sync: undefined });
    expect(d.outcome).toBe('repaired');
    expect(d.writePayload).toBe(true);
  });

  it('an existing sync row is replaced UNCONDITIONALLY by a retryable one', () => {
    // Including rows that carry no txId: an `accepted`/`confirmed` row without
    // one is dead — the queue skips it by status, polling skips it for want of
    // a txId — so leaving it would restore data that never gets sent.
    for (const prev of [
      row({ status: 'accepted' }),
      row({ status: 'confirmed' }),
      row({ status: 'accepted', needsRecheck: true }),
      row({ status: 'confirmed', txId: 'TX-OLD' }),
    ]) {
      const d = decide({ localState: 'corrupt', sync: prev });
      expect(d.sync, prev.status).toEqual({
        noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW,
      });
      expectNeverPublishesOrQuarantines(d);
    }
  });

  it('an opaque local record without a quarantine is still never replaced', () => {
    const d = decide({ localState: 'opaque', sync: undefined });
    expect(d).toEqual({ writePayload: false, sync: null, outcome: 'unsupportedLocal' });
  });
});

describe('safebox entries follow the same table', () => {
  const entry: EncryptedSafeboxEntry = {
    entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
    metaCiphertext: 'QUFBQQ==', metaIv: IV,
    secretCiphertext: 'QkJCQg==', secretIv: IV,
    createdAt: NOW - 5000, v: 4,
  };

  it('an equivalent entry is a no-op', () => {
    const d = decideBackupMerge({
      id: entry.entryId, kind: 'safebox', incoming: { ...entry },
      local: entry, localState: 'readable', sync: undefined, now: NOW,
    });
    expect(d.outcome).toBe('noop');
  });

  it('a differing secret half is a conflict', () => {
    const d = decideBackupMerge({
      id: entry.entryId, kind: 'safebox', incoming: { ...entry, secretCiphertext: 'Q0NDQw==' },
      local: entry, localState: 'readable', sync: undefined, now: NOW,
    });
    expect(d.outcome).toBe('conflicts');
  });

  it('a damaged entry is repaired with a safebox-kinded row', () => {
    const d = decideBackupMerge({
      id: entry.entryId, kind: 'safebox', incoming: entry,
      local: entry, localState: 'corrupt', sync: {
        noteId: entry.entryId, kind: 'safebox', status: 'confirmed',
        transport: 'proxy', updatedAt: NOW - 1, txId: 'TX-OLD',
      }, now: NOW,
    });
    expect(d.writePayload).toBe(true);
    expect(d.sync?.kind).toBe('safebox');
    expect(d.sync?.txId).toBeUndefined();
  });
});
