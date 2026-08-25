// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initStorage,
  resetAll,
  saveNote,
  setSyncRecord,
  getSyncRecord,
  beginUploadUnlessTerminal,
  commitUploadResultIfAttempt,
  commitV3PausedFailure,
  readV3PauseMeta,
  type SyncRecord,
} from './storage';
import type { EncryptedNote } from './crypto';

/**
 * D14 (payload-CAS) and D14a (attempt-CAS) at the storage level — the two
 * halves of «a txId may only ever be written next to the bytes it belongs to».
 *
 *  - BEFORE the request: the body was serialized and signed from a snapshot
 *    the queue captured earlier. If another writer replaced the stored bytes
 *    in the meantime, sending that snapshot would bind the resulting txId to a
 *    payload the store no longer has.
 *  - AFTER the request: the proxy POST has no timeout by design, so an attempt
 *    can outlive the ten-minute stale window and come back to a row that now
 *    belongs to someone else. Time proves nothing here; identity does.
 *
 * Neither guard is sufficient alone, which is why both live in the same
 * release and the same floor.
 */

const NOW = 1_750_000_000_000;
const IV = 'AAAAAAAAAAAAAAAA';

const v1Note: EncryptedNote = { noteId: 'c-1', ciphertext: 'QUFBQQ==', iv: IV, createdAt: NOW - 5000 };
const v3Note: EncryptedNote = { noteId: 'c-3', ciphertext: 'QUFBQQ==', iv: IV, createdAt: NOW - 5000, v: 3 };

const errorRow = (noteId: string): SyncRecord => ({
  noteId, kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1000,
});

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('D14 — payload-CAS: the signed snapshot must still be what the store holds', () => {
  it('an unchanged payload begins normally and stamps a fresh attemptId', async () => {
    await saveNote(v1Note);
    await setSyncRecord(errorRow('c-1'));

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began).toEqual({ ok: true, attemptId: expect.any(String) });
    const row = (await getSyncRecord('c-1'))!;
    expect(row.status).toBe('uploading');
    expect(row.attemptId).toBe(began.ok ? began.attemptId : undefined);
  });

  it('a payload replaced since the snapshot refuses with «stale» and writes NOTHING', async () => {
    await saveNote(v1Note);
    const before = errorRow('c-1');
    await setSyncRecord(before);

    // Another writer (restore today, import from step 8) replaces the bytes.
    await saveNote({ ...v1Note, ciphertext: 'QkJCQg==' });

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began).toEqual({ ok: false, reason: 'stale' });
    expect(await getSyncRecord('c-1')).toEqual(before); // no 'uploading' write
  });

  it('a payload that vanished refuses too — fail closed, not «nothing to compare, carry on»', async () => {
    await setSyncRecord(errorRow('c-1'));

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began).toEqual({ ok: false, reason: 'stale' });
  });

  it('a change confined to a field that never reaches the chain does NOT abandon the attempt', async () => {
    // v3 publishes {id,c,iv} and no Timestamp tag: the outer createdAt is
    // local ordering only. Abandoning a signed attempt over it would mean
    // re-signing and re-queueing a record that is byte-identical on-chain.
    await saveNote(v3Note);
    await setSyncRecord(errorRow('c-3'));
    await saveNote({ ...v3Note, createdAt: NOW - 1 });

    const began = await beginUploadUnlessTerminal('c-3', { kind: 'note', record: v3Note }, NOW);

    expect(began.ok).toBe(true);
  });

  it('...but for v1, where createdAt IS published, the same change is stale', async () => {
    await saveNote(v1Note);
    await setSyncRecord(errorRow('c-1'));
    await saveNote({ ...v1Note, createdAt: NOW - 1 });

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began).toEqual({ ok: false, reason: 'stale' });
  });

  it('a quarantined row is refused as «blocked», before the payload is even read', async () => {
    await saveNote(v1Note);
    const q: SyncRecord = { ...errorRow('c-1'), terminalError: 'malformed_record' };
    await setSyncRecord(q);

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began).toEqual({ ok: false, reason: 'blocked' });
    expect(await getSyncRecord('c-1')).toEqual(q);
  });

  it('every attempt gets its own id', async () => {
    await saveNote(v1Note);
    const first = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);
    const second = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(first.ok && second.ok).toBe(true);
    expect(first.ok ? first.attemptId : '').not.toBe(second.ok ? second.attemptId : '');
  });

  it('the comparison performs no async work: crypto.subtle is never touched inside the transaction', async () => {
    // A `crypto.subtle` call (or any non-IndexedDB await) between the read and
    // the write lets the transaction go inactive — the guard would then either
    // throw or, worse, be skipped. Pinned as an observable fact rather than a
    // comment.
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await saveNote(v1Note);

    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);

    expect(began.ok).toBe(true);
    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });
});

describe('D14a — attempt-CAS: an answer is applied only to the row that asked for it', () => {
  const accepted = (): SyncRecord => ({
    noteId: 'c-1', kind: 'note', txId: 'TX-1', status: 'accepted',
    transport: 'proxy', updatedAt: NOW,
  });

  async function begin(): Promise<string> {
    await saveNote(v1Note);
    const began = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);
    if (!began.ok) throw new Error(`begin refused: ${began.reason}`);
    return began.attemptId;
  }

  it('the owning attempt applies its result', async () => {
    const attemptId = await begin();

    await expect(commitUploadResultIfAttempt('c-1', attemptId, accepted)).resolves.toBe('applied');
    expect((await getSyncRecord('c-1'))?.txId).toBe('TX-1');
  });

  it('a late answer from a superseded attempt is dropped, and the row is untouched', async () => {
    const hung = await begin();
    // Another tab (or the next queue pass) takes the record over.
    const takenOver = await begin();
    expect(takenOver).not.toBe(hung);
    const before = (await getSyncRecord('c-1'))!;

    await expect(commitUploadResultIfAttempt('c-1', hung, accepted)).resolves.toBe('stale');
    expect(await getSyncRecord('c-1')).toEqual(before);
  });

  it('a row that left «uploading» owns no attempt — the same answer replayed is dropped', async () => {
    const attemptId = await begin();
    await commitUploadResultIfAttempt('c-1', attemptId, accepted);
    const after = (await getSyncRecord('c-1'))!;
    expect(after.attemptId).toBeUndefined();

    // Cross-tab replay, a duplicated response, a retried persist: same outcome.
    await expect(commitUploadResultIfAttempt('c-1', attemptId, () => ({
      ...accepted(), txId: 'TX-LATE',
    }))).resolves.toBe('stale');
    expect((await getSyncRecord('c-1'))?.txId).toBe('TX-1');
  });

  it('a quarantine set mid-flight still wins, and is reported as «blocked»', async () => {
    const attemptId = await begin();
    await setSyncRecord({ ...errorRow('c-1'), terminalError: 'recovery_invalidated' });

    await expect(commitUploadResultIfAttempt('c-1', attemptId, accepted)).resolves.toBe('blocked');
    expect((await getSyncRecord('c-1'))?.terminalError).toBe('recovery_invalidated');
  });

  it('a builder that declines returns «noop» without writing', async () => {
    const attemptId = await begin();
    const before = (await getSyncRecord('c-1'))!;

    await expect(commitUploadResultIfAttempt('c-1', attemptId, () => null)).resolves.toBe('noop');
    expect(await getSyncRecord('c-1')).toEqual(before);
  });

  it('a missing row cannot be resurrected by a late answer', async () => {
    await expect(commitUploadResultIfAttempt('gone', 'attempt-x', accepted)).resolves.toBe('stale');
    expect(await getSyncRecord('gone')).toBeUndefined();
  });
});

describe('D14a — the vN_disabled branch: record attempt-scoped, marker unconditional', () => {
  it('a stale attempt does not move the row, but the pause marker is still written', async () => {
    await saveNote(v1Note);
    const hung = await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW);
    await beginUploadUnlessTerminal('c-1', { kind: 'note', record: v1Note }, NOW); // takeover
    const before = (await getSyncRecord('c-1'))!;
    expect(hung.ok).toBe(true);

    await commitV3PausedFailure('c-1', hung.ok ? hung.attemptId : 'x', () => ({
      noteId: 'c-1', kind: 'note', status: 'error', transport: 'proxy',
      updatedAt: NOW, lastError: 'v3_uploads_disabled',
    }), NOW);

    // The row belongs to the newer attempt and must not move...
    expect(await getSyncRecord('c-1')).toEqual(before);
    // ...but the kill switch is real, version-global, and independent of who
    // owns the record: losing it would let the next unlock burst the backlog.
    expect(await readV3PauseMeta()).toEqual({ pausedAt: NOW });
  });
});
