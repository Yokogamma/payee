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

// 16-byte ciphertexts: the upload barrier's GCM-tag floor (D14b) is real, and
// one branch below re-runs that barrier — a toy fixture would fail it for the
// wrong reason.
const localNote: EncryptedNote = {
  noteId: ID, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: IV, createdAt: NOW - 5000,
};
const incomingSame: EncryptedNote = { ...localNote };
const incomingOther: EncryptedNote = { ...localNote, ciphertext: 'QkJCQkJCQkJCQkJCQkJCQg==' };

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
    // ('malformed_record', 'readable') depends on the SHAPE — its own tests below.
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
        // Equivalent on purpose: this table is about the fate of the LOCAL
        // row. A differing file copy is a conflict FIRST, whatever the
        // quarantine says — that matrix is its own block below.
        incoming: localState === 'readable' ? incomingSame : incomingOther,
        local: localState === 'absent' ? undefined : localNote,
        sync: row({ terminalError: reason, txId: 'TX-EVIDENCE' }),
      });
      expect(d.outcome).toBe(outcome);
      expect(d.writePayload).toBe(writePayload);
      expectNeverPublishesOrQuarantines(d);
    });
  }

  it('malformed_record + readable lifts the quarantine ONLY if the shape is now valid', () => {
    // «Readable» is not the evidence THIS reason expires on: it is set for
    // SHAPE violations — a negative createdAt, an id from the wrong namespace,
    // non-canonical base64, a ciphertext shorter than the GCM tag — and none of
    // those is disproved by a successful decryption. Reporting a repair that
    // did not happen is worse than reporting nothing: the next queue pass
    // quarantines the record again, and the user is left with a «restored»
    // note that never sends.
    const stillBroken = { ...localNote, createdAt: -1 };
    expect(decide({
      local: stillBroken, incoming: { ...stillBroken }, localState: 'readable',
      sync: row({ terminalError: 'malformed_record' }),
    })).toEqual({ writePayload: false, sync: null, outcome: 'skipped' });

    expect(decide({
      local: localNote, incoming: localNote, localState: 'readable',
      sync: row({ terminalError: 'malformed_record' }),
    }).outcome).toBe('quarantineStale');
  });

  it('unsupported_version + readable lifts unconditionally — it expires on its OWN terms', () => {
    // That reason says «this build cannot handle such a record», and this build
    // just read it. No shape re-check is owed, and none is performed.
    const stillOddShape = { ...localNote, createdAt: -1 };
    expect(decide({
      local: stillOddShape, incoming: stillOddShape, localState: 'readable',
      sync: row({ terminalError: 'unsupported_version' }),
    }).outcome).toBe('quarantineStale');
  });

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
    const d = decide({
      localState: 'readable', incoming: incomingSame,
      sync: row({ terminalError: 'unsupported_version', txId: 'TX-OLD' }),
    });
    expect(d.outcome).toBe('quarantineStale');
    expect(d.sync).toEqual({ noteId: ID, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW });
  });
});

describe('the conflict check is ORTHOGONAL to the quarantine table', () => {
  const REASONS = [
    undefined,
    'unsupported_version',
    'malformed_record',
    'publication_conflict',
    'recovery_invalidated',
  ] as const;

  it.each(REASONS)('a DIFFERING readable payload is a conflict — reason: %s', reason => {
    // Every branch of the quarantine table answers a question about the LOCAL
    // row and none of them looks at the file. Letting a quarantine
    // short-circuit the comparison was silent data loss, not a mis-count: the
    // file's bytes went unapplied, nothing was counted, and the import could
    // report complete success — after which the user deletes the only copy of
    // a record they no longer have.
    const d = decide({
      localState: 'readable',
      local: localNote,
      incoming: incomingOther,
      sync: reason === undefined ? undefined : row({ terminalError: reason, txId: 'TX-EVIDENCE' }),
    });

    expect(d.outcome).toBe('conflicts');
    expect(d.writePayload).toBe(false);
    // Nothing at all is written — not even a stale quarantine is lifted.
    // Lifting one while refusing the bytes mixes two decisions that merely
    // happen to be adjacent.
    expect(d.sync).toBeNull();
  });

  it.each(REASONS)('an EQUIVALENT readable payload still follows the table — reason: %s', reason => {
    const d = decide({
      localState: 'readable',
      local: localNote,
      incoming: incomingSame,
      sync: reason === undefined ? undefined : row({ terminalError: reason, txId: 'TX-EVIDENCE' }),
    });
    expect(d.outcome).not.toBe('conflicts');
  });

  it('a readable state with no local record fails closed as a conflict', () => {
    // The caller contradicted itself. «Not equivalent» is the safe reading:
    // the file holds something the store cannot be shown to have.
    const d = decide({ localState: 'readable', local: undefined, incoming: incomingSame });
    expect(d.outcome).toBe('conflicts');
    expect(d.writePayload).toBe(false);
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
    metaCiphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', metaIv: IV,
    secretCiphertext: 'QkJCQkJCQkJCQkJCQkJCQg==', secretIv: IV,
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
      id: entry.entryId, kind: 'safebox', incoming: { ...entry, secretCiphertext: 'Q0NDQ0NDQ0NDQ0NDQ0NDQw==' },
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

describe('bytes from the FILE meet the same barrier as bytes about to be signed (D14b)', () => {
  /**
   * A record can decrypt perfectly and still be unsendable: the barrier judges
   * SHAPE — the id namespace, canonical base64, a 12-byte IV, a ciphertext at
   * least as long as the GCM tag — and a successful decryption disproves none
   * of it.
   *
   * Writing such a record would have the queue quarantine it as
   * `malformed_record` on its next pass, which is the import CREATING a
   * quarantine (D8 (2) forbids it); and in the cell below it would ALSO lift
   * the quarantine that is already there and report `quarantinedRepaired` — a
   * repair announced to a user who is deciding whether the file is still
   * needed.
   */
  const badNamespace: EncryptedNote = { ...localNote, v: 3 }; // v3 lives in the UUIDv8 space
  const shortCiphertext: EncryptedNote = { ...localNote, ciphertext: 'QUFBQQ==' }; // 4 bytes

  it('a damaged local payload is NOT «repaired» from a malformed file record', () => {
    const d = decide({
      incoming: badNamespace, local: localNote, localState: 'corrupt',
      sync: row({ terminalError: 'malformed_record' }),
    });
    expect(d.outcome).toBe('skipped');
    expect(d.writePayload).toBe(false);
    // The quarantine stays exactly where it was: nothing was proved about it.
    expect(d.sync).toBeNull();
  });

  it('a record this device does not have at all is not «added» from one either', () => {
    const d = decide({ incoming: shortCiphertext, local: undefined, localState: 'absent' });
    expect(d).toEqual({ writePayload: false, sync: null, outcome: 'skipped' });
  });

  it('the two blocking reasons gain no repair from malformed bytes', () => {
    for (const reason of ['publication_conflict', 'recovery_invalidated'] as const) {
      const d = decide({
        incoming: badNamespace, local: localNote, localState: 'corrupt',
        sync: row({ terminalError: reason, txId: 'TX-OLD' }),
      });
      expect(d.outcome, reason).toBe('skipped');
      expect(d.writePayload, reason).toBe(false);
      expect(d.sync, reason).toBeNull();
    }
  });

  it('a well-formed file record still repairs — the barrier is not a blanket refusal', () => {
    const d = decide({
      incoming: incomingOther, local: localNote, localState: 'corrupt',
      sync: row({ terminalError: 'malformed_record' }),
    });
    expect(d.outcome).toBe('quarantinedRepaired');
    expect(d.writePayload).toBe(true);
    expect(d.sync?.terminalError).toBeUndefined();
  });

  it('a safebox entry is judged in ITS id space, and the stable field comes first', () => {
    const good = {
      entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
      metaCiphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', metaIv: IV,
      secretCiphertext: 'QkJCQkJCQkJCQkJCQkJCQg==', secretIv: IV,
      createdAt: NOW - 5000, v: 4,
    } satisfies EncryptedSafeboxEntry;
    // A note-shaped id: refused whatever the version says, because `entryId`
    // is stable across versions and is judged before the version is.
    const wrongSpace: EncryptedSafeboxEntry = { ...good, entryId: ID };

    const refused = decideBackupMerge({
      id: wrongSpace.entryId, kind: 'safebox', incoming: wrongSpace,
      local: undefined, localState: 'absent', sync: undefined, now: NOW,
    });
    expect(refused).toEqual({ writePayload: false, sync: null, outcome: 'skipped' });

    const accepted = decideBackupMerge({
      id: good.entryId, kind: 'safebox', incoming: good,
      local: undefined, localState: 'absent', sync: undefined, now: NOW,
    });
    expect(accepted.outcome).toBe('added');
  });

  it('the refusal is counted, never a silent no-op', () => {
    // `skipped` and `noop` differ in exactly one way that matters: the first
    // is visible in «Не восстановлено: K», the second is not. Something WAS
    // left unapplied here, so it has to be the first.
    const d = decide({ incoming: shortCiphertext, local: undefined, localState: 'absent' });
    expect(d.outcome).not.toBe('noop');
    expectNeverPublishesOrQuarantines(d);
  });
});
