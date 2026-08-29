// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDB } from 'idb';
import {
  DB_VERSION,
  initStorage,
  resetAll,
  isDbVersionError,
  saveNote,
  saveNoteWithSync,
  setSyncRecord,
  getNoteById,
  getSyncRecord,
  mergeRestoredNote,
  beginUploadUnlessTerminal,
  commitUploadResultIfAttempt,
  getDbGeneration,
  type SyncRecord,
} from './storage';

/**
 * THE `client-b1` COMPOSITION GATE.
 *
 * `client-b1` is declared the minimum safe rollback target once DB_VERSION 3
 * ships, and that declaration is only true if the tag actually contains all
 * four parts. A release cut without one of them would still open the v3
 * database — and quietly reintroduce the defect the floor exists to prevent,
 * with nothing to notice it.
 *
 * So each part is asserted here, minimally and behaviourally, in one place a
 * release check can point at. The exhaustive suites live next door
 * (client-floor.d12.test.ts, client-floor.cas.test.ts); this file is the
 * checklist, not the proof.
 */

const NOW = 1_750_000_000_000;
const IV = 'AAAAAAAAAAAAAAAA';
const note = { noteId: 'cb1', ciphertext: 'QUFBQQ==', iv: IV, createdAt: NOW - 5000 };

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('client-b1 — part 1: DB_VERSION is 3 (the floor itself)', () => {
  it('the schema version is 3', () => {
    expect(DB_VERSION).toBe(3);
  });

  it('an older build is locked out with a SAFE VersionError, and the data survives', async () => {
    await saveNote(note);

    // A pre-v3 build asks for the version it knows about.
    const err = await openDB('eternal-notes', 2).then(() => null, (e: unknown) => e);

    expect(err).not.toBeNull();
    // Recognized as «the stored DB is newer», which routes the UI to the
    // non-destructive reload screen — NOT to the generic error screen whose
    // destructive reset is two clicks away.
    expect(isDbVersionError(err)).toBe(true);
    // Nothing was migrated, reshaped or lost: v3 adds no store and no index.
    expect((await getNoteById('cb1'))?.ciphertext).toBe(note.ciphertext);
  });
});

describe('client-b1 — part 2: D12, the restore pair is atomic', () => {
  it('a different on-chain transaction moves the txId together with the bytes', async () => {
    await saveNoteWithSync(note, {
      noteId: 'cb1', kind: 'note', txId: 'tx-A', status: 'confirmed',
      transport: 'proxy', updatedAt: NOW - 1000,
    });

    await mergeRestoredNote({ ...note, ciphertext: 'QkJCQg==' }, 'tx-B', NOW, getDbGeneration());

    expect((await getNoteById('cb1'))?.ciphertext).toBe('QkJCQg==');
    expect((await getSyncRecord('cb1'))?.txId).toBe('tx-B');
  });
});

describe('client-b1 — part 3: D14, the payload-CAS', () => {
  it('a snapshot the store no longer holds cannot start an attempt', async () => {
    await saveNote(note);
    await saveNote({ ...note, ciphertext: 'QkJCQg==' }); // replaced under the snapshot

    const began = await beginUploadUnlessTerminal('cb1', { kind: 'note', record: note }, NOW);

    expect(began).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('client-b1 — part 4: D14a, the attempt-CAS', () => {
  it('a late answer cannot be applied to a row this attempt no longer owns', async () => {
    await saveNote(note);
    const hung = await beginUploadUnlessTerminal('cb1', { kind: 'note', record: note }, NOW);
    expect(hung.ok).toBe(true);

    // Whoever takes the row over — an import, another tab, the next queue pass.
    const takenOver: SyncRecord = {
      noteId: 'cb1', kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW,
    };
    await setSyncRecord(takenOver);

    const verdict = await commitUploadResultIfAttempt('cb1', hung.ok ? hung.attemptId : 'x', () => ({
      noteId: 'cb1', kind: 'note', txId: 'TX-LATE', status: 'accepted',
      transport: 'proxy', updatedAt: NOW,
    }));

    expect(verdict).toBe('stale');
    expect(await getSyncRecord('cb1')).toEqual(takenOver);
  });

  it('the field exists in the schema — an older build would ignore it, which is why the floor is hard', async () => {
    await saveNote(note);
    const began = await beginUploadUnlessTerminal('cb1', { kind: 'note', record: note }, NOW);

    expect(began.ok).toBe(true);
    expect((await getSyncRecord('cb1'))?.attemptId).toEqual(expect.any(String));
  });
});
