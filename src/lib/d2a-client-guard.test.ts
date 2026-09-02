import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * D2a, client half: what this build refuses to record, and why.
 *
 * The worker proves a publication before handing back a historical `txId`, and
 * says so in every answer (`semanticIdempotency: 1`). That marker is only worth
 * anything if the client actually reads it — otherwise an old worker, reached
 * after a rollback, could still make a new client store an unproven binding.
 *
 * Both flag states are exercised, and the OFF one is not a formality: until a
 * released client has import on, nothing depends on semantic idempotency, and
 * refusing there would close the safe worker-rollback window D2a deliberately
 * keeps open until the import flip.
 */

const PROXY = 'https://proxy.test';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Load `uploadViaProxy` with the import flag at a chosen value. */
async function loadUpload(importEnabled: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_PROXY_URL', PROXY);
  vi.doMock('./flags', () => ({
    V3_WRITER_ENABLED: true,
    SAFEBOX_WRITER_ENABLED: true,
    QUICK_UNLOCK_ENABLED: false,
    BACKUP_EXPORT_ENABLED: false,
    BACKUP_IMPORT_ENABLED: importEnabled,
  }));
  const { uploadViaProxy } = await import('./arweave');
  return uploadViaProxy;
}

/** A fetch stub that records the init it was called with. */
function stubFetch(response: Response) {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return response;
  }));
  return calls;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const conflict = () =>
  new Response(JSON.stringify({ code: 'id_payload_conflict', txId: 'TX-THEIRS' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } });

describe('the capability marker gates recording a txId', () => {
  it('WITH import on: an answer without the marker is refused, and refused RETRYABLY', async () => {
    // Not the record's fault and not terminal — the worker is simply below the
    // floor, so the row is kept and the queue waits, exactly as for a 503.
    const uploadViaProxy = await loadUpload(true);
    stubFetch(ok({ txId: 'TX-1', committed: true }));

    const result = await uploadViaProxy('{}', 'pk', 'sig');

    expect(result.kind).toBe('unattested');
    expect('txId' in result).toBe(false); // nothing to store, by construction
  });

  it('WITH import on: the recovery hint SURVIVES the refusal', async () => {
    // The refusal is about the txId, not about the proof that money was spent.
    // Drop the hint and the triple-failure path posts again.
    const uploadViaProxy = await loadUpload(true);
    const hint = { txId: 'TX-1', postedAt: 123, token: 'tok' };
    stubFetch(ok({ txId: 'TX-1', committed: false, recovery: hint }));

    const result = await uploadViaProxy('{}', 'pk', 'sig');

    expect(result.kind).toBe('unattested');
    if (result.kind === 'unattested') expect(result.recovery).toEqual(hint);
  });

  it('WITH import on: the marker present is an ordinary success', async () => {
    const uploadViaProxy = await loadUpload(true);
    stubFetch(ok({ txId: 'TX-1', committed: true, semanticIdempotency: 1 }));

    const result = await uploadViaProxy('{}', 'pk', 'sig');

    expect(result).toMatchObject({ kind: 'accepted', txId: 'TX-1', committed: true });
  });

  it('a WRONG marker value is not "close enough"', async () => {
    const uploadViaProxy = await loadUpload(true);
    for (const value of [0, 2, '1', true, null]) {
      stubFetch(ok({ txId: 'TX-1', committed: true, semanticIdempotency: value }));
      expect((await uploadViaProxy('{}', 'pk', 'sig')).kind, String(value)).toBe('unattested');
    }
  });

  it('WITH import OFF: a marker-less answer is still accepted', async () => {
    // This is the rollback window D2a keeps open on purpose. Refusing here
    // would mean a defect found during the worker soak could only be cured by
    // an urgent forward fix.
    const uploadViaProxy = await loadUpload(false);
    stubFetch(ok({ txId: 'TX-1', committed: true }));

    expect(await uploadViaProxy('{}', 'pk', 'sig')).toMatchObject({ kind: 'accepted', txId: 'TX-1' });
  });
});

describe('the two 409s are different answers', () => {
  it('a typed conflict is TERMINAL, not "already in progress"', async () => {
    // Read as in-progress it would be retried forever against a settled fact:
    // the id is spent, on chain, and the answer cannot change.
    const uploadViaProxy = await loadUpload(true);
    stubFetch(conflict());

    const result = await uploadViaProxy('{}', 'pk', 'sig');
    expect(result.kind).toBe('publication_conflict');
  });

  it('a plain 409 keeps meaning in_progress', async () => {
    const uploadViaProxy = await loadUpload(true);
    stubFetch(new Response('Upload already in progress for this noteId', { status: 409 }));

    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('in_progress');
  });

  it('a 409 whose body is JSON but not this code stays in_progress', async () => {
    const uploadViaProxy = await loadUpload(true);
    stubFetch(new Response(JSON.stringify({ code: 'something_else' }), { status: 409 }));

    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('in_progress');
  });

  it('the conflict is recognised with import OFF too', async () => {
    // The flag gates what this build DEPENDS on, never what it understands: a
    // conflict is a fact about the id whatever the release is configured to do.
    const uploadViaProxy = await loadUpload(false);
    stubFetch(conflict());

    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('publication_conflict');
  });
});

describe('the request itself refuses caching', () => {
  it('sends cache: no-store', async () => {
    // The worker sends `Cache-Control: no-store`; this is the other half. A
    // replayed answer would replay its capability claim and its txId with it.
    const uploadViaProxy = await loadUpload(true);
    const calls = stubFetch(ok({ txId: 'TX-1', committed: true, semanticIdempotency: 1 }));

    await uploadViaProxy('{}', 'pk', 'sig');

    expect(calls).toHaveLength(1);
    expect(calls[0].cache).toBe('no-store');
  });
});

describe('toPublicationConflict — what lands in the record', () => {
  it('quarantines without recording the conflicting txId', async () => {
    const { toPublicationConflict } = await import('./sync-transitions');
    const prev = {
      noteId: 'n1', kind: 'note' as const, txId: 'TX-OURS', status: 'error' as const,
      transport: 'proxy' as const, updatedAt: 1,
    };

    const next = toPublicationConflict('n1', 'note', prev, 'conflict body', 1000);

    expect(next.terminalError).toBe('publication_conflict');
    expect(next.needsRecheck).toBe(false); // no polling a settled answer
    // The row keeps ITS OWN txId as evidence and gains nothing from the server:
    // storing the conflicting one would record the very binding — payload B
    // under transaction A — that the protocol exists to prevent.
    expect(next.txId).toBe('TX-OURS');
  });

  it('records no txId at all when the row never had one', async () => {
    const { toPublicationConflict } = await import('./sync-transitions');
    const next = toPublicationConflict('n1', 'note', undefined, 'conflict body', 1000);
    expect(next.txId).toBeUndefined();
    expect(next.terminalError).toBe('publication_conflict');
  });
});
