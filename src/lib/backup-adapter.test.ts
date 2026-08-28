import { describe, it, expect, vi, beforeEach } from 'vitest';

// The «on» build. The flags are constants in the shipped source (both false
// today), and the point of these tests is the behaviour AFTER they flip — plus
// the one thing that must hold while they are off, which gets its own file.
vi.mock('./flags', () => ({
  V3_WRITER_ENABLED: true,
  SAFEBOX_WRITER_ENABLED: true,
  QUICK_UNLOCK_ENABLED: false,
  BACKUP_EXPORT_ENABLED: true,
  BACKUP_IMPORT_ENABLED: true,
}));

import {
  importSucceeded,
  prepareImport,
  runExport,
  runVerify,
  withImportLock,
  BackupCancelledError,
  BackupLockUnavailableError,
  LAST_EXPORT_ARTIFACT_KEY,
  LAST_VERIFIED_ARTIFACT_KEY,
  type BackupStorage,
  type BackupVault,
} from './backup-adapter';
import { encodeBackup, deriveBackupKey } from './backup';
import {
  deriveKey,
  encryptEnvelopeV3,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import type { ImportReport } from './backup-import';

/**
 * The wiring, which is where this feature can still go wrong.
 *
 * Every rule below is one of the seven acceptance criteria the plan writes
 * down for this seam (§4). They are not restatements of the pure modules'
 * tests: those prove the rules, these prove that the rules are what the app
 * actually runs — one reading of the file, one database generation, a lock
 * that refuses to be absent, and flags that live in the action rather than in
 * the markup.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_756_000_000_000;
const DB_GENERATION = 7;

const vault = (over: Partial<BackupVault> = {}): BackupVault => ({
  mnemonic: MNEMONIC,
  dbGeneration: DB_GENERATION,
  assertAlive: () => {},
  now: () => NOW,
  ...over,
});

/** The operations take a FACTORY, not a vault: with a release flag off, «the
 *  vault is locked» is a true statement and the wrong answer, so the flag is
 *  checked before the vault is asked for. */
const from = (v: BackupVault) => () => v;

function storage(over: Partial<BackupStorage> = {}) {
  const meta = new Map<string, unknown>();
  const merges: Array<{ id: string; generation: number; record: unknown }> = [];
  const base: BackupStorage = {
    readSnapshot: async () => ({
      ok: true,
      snapshot: { notes: [], safebox: [], incompleteRestore: false },
    }),
    getNote: async () => undefined,
    getEntry: async () => undefined,
    mergeRecord: async input => {
      merges.push({
        id: input.kind === 'note' ? input.incoming.noteId : input.incoming.entryId,
        generation: input.expectedDbGeneration,
        record: input.incoming,
      });
      return 'added';
    },
    readMeta: async key => meta.get(key) as never,
    writeMeta: async (key, value) => { meta.set(key, value); },
    ...over,
  };
  return { storage: base, meta, merges };
}

const makeNote = async (text = 'text', over: Parameters<typeof encryptEnvelopeV3>[2] = { fmt: 'plain', rev: 1 }) =>
  encryptEnvelopeV3(await deriveKey(MNEMONIC), text, over);

async function container(notes: EncryptedNote[], safebox: EncryptedSafeboxEntry[] = [], incompleteRestore = false) {
  return encodeBackup({
    notes: notes as unknown as Record<string, unknown>[],
    safebox: safebox as unknown as Record<string, unknown>[],
    incompleteRestore,
    containsUnsupportedRecords: false,
    createdAt: NOW,
  }, await deriveBackupKey(MNEMONIC));
}

/** A file whose reads are counted — «one reading of the file» is a claim that
 *  can only be checked by counting. */
function countedFile(text: string) {
  const read = vi.fn(async () => text);
  return { file: { size: new TextEncoder().encode(text).byteLength, text: read }, read };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('the file is read ONCE, and stage B writes what stage A judged', () => {
  it('preparing and applying an import never re-reads the container', async () => {
    // Two reads are two chances to disagree, and the disagreement surfaces as
    // «we checked one thing and wrote another» — the defect D14 prevents at
    // the other end of this same pipeline.
    const note = await makeNote('the one and only');
    const { file, read } = countedFile(await container([note]));
    const { storage: store, merges } = storage();

    const prepared = await prepareImport(from(vault()), file, store);
    await prepared.apply();

    expect(read).toHaveBeenCalledTimes(1);
    expect(merges.map(m => m.id)).toEqual([note.noteId]);
  });

  it('the plan carries the very records the report was formed from', async () => {
    const note = await makeNote('carried through');
    const { file } = countedFile(await container([note]));

    const { storage: store, merges } = storage();
    const prepared = await prepareImport(from(vault()), file, store);
    await prepared.apply();

    // The BYTES, not the id: an adapter that carried the right identifier and
    // the wrong ciphertext would pass an id-only assertion and write a record
    // the vault cannot read.
    expect(prepared.plannedCount).toBe(1);
    expect(merges.map(m => m.record)).toEqual([note]);
  });
});

describe('a prepared import belongs to the vault it was prepared against', () => {
  it('refuses to apply after a lock or a reset — before the marker and before any merge', async () => {
    // The gap this closes: stage A and stage B are separated by a human
    // decision, which takes long enough to lock the app, reset it and open a
    // DIFFERENT seed. A stage B that accepted a fresh vault would let the new
    // generation authorize writing the FIRST seed's ciphertext into the second
    // vault — permanently undecryptable there, and published under the new
    // identity by the queue.
    const { file } = countedFile(await container([await makeNote()]));
    const { storage: store, merges, meta } = storage();
    let alive = true;

    const prepared = await prepareImport(
      from(vault({ assertAlive: () => { if (!alive) throw new BackupCancelledError('reset'); } })),
      file,
      store,
    );

    alive = false; // lock / reset / a different seed opened
    await expect(prepared.apply()).rejects.toBeInstanceOf(BackupCancelledError);

    expect(merges).toEqual([]);
    expect(meta.size).toBe(0); // not even the provisional incompleteRestore marker
  });

  it('takes no vault at all — there is no parameter to hand it a different one', async () => {
    // Structural, and deliberately so: the guarantee is «cannot», not
    // «does not». `apply` is a method on the session, the session's vault is
    // private, and there is no argument through which a caller could offer a
    // second one.
    const { file } = countedFile(await container([await makeNote()]));
    const prepared = await prepareImport(from(vault()), file, storage().storage);

    expect(prepared.apply.length).toBe(0);
  });
});

describe('one database generation for the whole import', () => {
  it('every writer call gets the generation captured on the vault', async () => {
    // Re-capturing per record would let an import that outlived a reset carry
    // on into the new database — the writer refuses only what it is told to.
    const first = await makeNote('first');
    const second = await makeNote('second');
    const { file } = countedFile(await container([first, second]));
    const { storage: store, merges } = storage();

    const prepared = await prepareImport(from(vault({ dbGeneration: 42 })), file, store);
    await prepared.apply();

    // 42 is the generation STAGE A captured, and stage B uses that one — not a
    // fresh reading taken between the two.
    expect(merges).toHaveLength(2);
    expect(merges.every(m => m.generation === 42)).toBe(true);
  });
});

describe('stage A validates the graph, not just the records', () => {
  it('a broken chain reaches the preview as an issue', async () => {
    // The planner checks only the preconditions of its own ordering and says
    // so. An import that skipped the graph would hand it nodes whose links
    // nobody proved — and the user would confirm a file nobody judged.
    const key = await deriveKey(MNEMONIC);
    const first = await encryptEnvelopeV3(key, 'v1', { fmt: 'plain', rev: 1 });
    const third = await encryptEnvelopeV3(key, 'v3', {
      fmt: 'plain', rev: 3, root: first.noteId, prev: first.noteId, // rev 2 never existed
    });
    const { file } = countedFile(await container([first, third]));

    const prepared = await prepareImport(from(vault()), file, storage().storage);

    expect(prepared.report.ok).toBe(false);
    expect(prepared.report.issues.some(i => i.problem === 'chain')).toBe(true);
  });
});

describe('the lifecycle guard is honoured, and it throws', () => {
  it('a vault that dies during stage A stops it', async () => {
    const { file } = countedFile(await container([await makeNote()]));
    const boom = new Error('locked');
    let checks = 0;

    await expect(prepareImport(
      from(vault({ assertAlive: () => { if (++checks >= 2) throw boom; } })),
      file,
      storage().storage,
    )).rejects.toBe(boom);
  });
});

describe('the artifact markers (D21)', () => {
  it('an export records the file it produced', async () => {
    const { storage: store, meta } = storage();

    const { exported, markerRecorded } = await runExport(from(vault()), store);

    expect(markerRecorded).toBe(true);
    expect(meta.get(LAST_EXPORT_ARTIFACT_KEY)).toEqual(exported.artifact);
    expect(exported.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a verify records nothing unless the file is flawless', async () => {
    const damagedNote = await makeNote('gone');
    const damaged = { ...damagedNote, ciphertext: `${damagedNote.ciphertext.slice(0, -4)}AAAA` };
    const { file } = countedFile(await container([damaged]));
    const { storage: store, meta } = storage();

    const { report, markerRecorded } = await runVerify(from(vault()), file, store);

    expect(report.ok).toBe(false);
    expect(markerRecorded).toBe(false);
    expect(meta.has(LAST_VERIFIED_ARTIFACT_KEY)).toBe(false);
  });

  it('...and records it when it is', async () => {
    const { file } = countedFile(await container([await makeNote()]));
    const { storage: store, meta } = storage();

    const { report, markerRecorded } = await runVerify(from(vault()), file, store);

    expect(report.ok).toBe(true);
    expect(markerRecorded).toBe(true);
    expect(meta.get(LAST_VERIFIED_ARTIFACT_KEY)).toEqual({
      createdAt: report.createdAt, sha256: report.sha256, at: NOW,
    });
  });

  it('a marker that cannot be written does NOT take the file away', async () => {
    // The one moment this feature exists for is also the moment storage is
    // most likely to be full. Losing the emergency copy because a note-to-self
    // about it could not be stored would be the failure mode in person.
    const { storage: store } = storage({
      writeMeta: async () => { throw new Error('QuotaExceededError'); },
    });

    const { exported, markerRecorded } = await runExport(from(vault()), store);

    expect(markerRecorded).toBe(false);
    expect(exported.text.length).toBeGreaterThan(0);
    expect(exported.fileName).toMatch(/^eternal-notes-backup-/);
  });

  it('...and the same for a verify report', async () => {
    const { file } = countedFile(await container([await makeNote()]));
    const { storage: store } = storage({
      writeMeta: async () => { throw new Error('QuotaExceededError'); },
    });

    const { report, markerRecorded } = await runVerify(from(vault()), file, store);

    expect(report.ok).toBe(true);
    expect(markerRecorded).toBe(false);
  });
});

describe('the cross-tab lock', () => {
  it('is fail-closed when the browser has none', async () => {
    vi.stubGlobal('navigator', {});
    await expect(withImportLock(async () => 'ran')).rejects.toBeInstanceOf(BackupLockUnavailableError);
  });

  it('runs the work under an exclusive lock when it does', async () => {
    const request = vi.fn(async (_name: string, _opts: unknown, run: () => Promise<unknown>) => run());
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(withImportLock(async () => 'ran')).resolves.toBe('ran');
    expect(request.mock.calls[0][0]).toBe('eternal-notes-backup-import');
    expect(request.mock.calls[0][1]).toEqual({ mode: 'exclusive' });
  });

  it('hands the abort signal to the WAIT, not only to the work', async () => {
    // The wait can be long — another tab may be importing 30 MB — and a tab
    // that has gone away must stop queueing for a turn it no longer wants.
    const request = vi.fn(async (_name: string, _opts: unknown, run: () => Promise<unknown>) => run());
    vi.stubGlobal('navigator', { locks: { request } });
    const controller = new AbortController();

    await withImportLock(async () => 'ran', controller.signal);

    expect(request.mock.calls[0][1]).toEqual({ mode: 'exclusive', signal: controller.signal });
  });
});

describe('what counts as success', () => {
  const report = (over: Partial<ImportReport>): ImportReport => ({
    counters: {
      added: 1, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
      quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
      skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
    },
    allFileRecordsApplied: true,
    incompleteRestore: false,
    ...over,
  });

  it('needs BOTH halves', () => {
    // «Everything in the file was applied» and «the store is now a complete
    // backup of anything» are different questions, and a file made by an
    // incomplete restore answers the first yes and the second no.
    expect(importSucceeded(report({}))).toBe(true);
    expect(importSucceeded(report({ allFileRecordsApplied: false }))).toBe(false);
    expect(importSucceeded(report({ incompleteRestore: true }))).toBe(false);
  });
});
