import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// RateLimiter DO lifecycle: reserve → commit/release, token CAS, redrop, and the
// split attempt/quota counters (C1/M6).

const RATE_LIMITER = (env as unknown as {
  RATE_LIMITER: DurableObjectNamespace;
}).RATE_LIMITER;

const RUN = crypto.randomUUID().slice(0, 8);
function stubFor(name: string) {
  return RATE_LIMITER.get(RATE_LIMITER.idFromName(`${name}-${RUN}`));
}

/** `fp` defaults to a fixed value so the ordinary lifecycle tests describe a
 *  POST-D2 record. Pass a different one to exercise the conflict branch, or
 *  `undefined` explicitly to write a legacy-shaped record. */
const FP_A = 'fp-payload-A';

async function reserve(
  stub: DurableObjectStub,
  noteId: string,
  limit = 20,
  fp: string | undefined = FP_A,
) {
  const r = await stub.fetch('http://do/check-and-reserve', {
    method: 'POST', body: JSON.stringify({ noteId, limit, ...(fp === undefined ? {} : { fp }) }),
  });
  return r.json() as Promise<{
    status: string; token?: string; txId?: string; committedAt?: number;
    deduped?: boolean; state?: string;
    snapshot?: { status: string; txId: string; token: string; gen: number };
  }>;
}
async function backfill(
  stub: DurableObjectStub,
  noteId: string,
  snapshot: { status: string; txId: string; token: string; gen: number },
  observedFp: string,
) {
  const r = await stub.fetch('http://do/backfill-fp', {
    method: 'POST', body: JSON.stringify({ noteId, snapshot, observedFp }),
  });
  return r.json() as Promise<{ ok: boolean; stale?: boolean; fp?: string | null }>;
}
async function markPosted(stub: DurableObjectStub, noteId: string, txId: string, token: string) {
  const r = await stub.fetch('http://do/mark-posted', {
    method: 'POST', body: JSON.stringify({ noteId, txId, token }),
  });
  return r.json() as Promise<{ ok: boolean; stale?: boolean }>;
}
async function commit(stub: DurableObjectStub, noteId: string, txId: string, token: string) {
  const r = await stub.fetch('http://do/commit', {
    method: 'POST', body: JSON.stringify({ noteId, txId, token }),
  });
  return r.json() as Promise<{ ok: boolean; stale?: boolean }>;
}
async function release(stub: DurableObjectStub, noteId: string, token: string) {
  const r = await stub.fetch('http://do/release', {
    method: 'POST', body: JSON.stringify({ noteId, token }),
  });
  return r.json() as Promise<{ ok: boolean }>;
}
async function redrop(stub: DurableObjectStub, noteId: string, txId: string, limit = 20) {
  const r = await stub.fetch('http://do/redrop', {
    method: 'POST', body: JSON.stringify({ noteId, txId, limit }),
  });
  return r.json() as Promise<{
    ok: boolean; token?: string; rateLimited?: boolean; inProgress?: boolean; committed?: boolean; txId?: string;
  }>;
}

describe('RateLimiter reserve/commit', () => {
  it('reserves with a token, then reports exists after commit', async () => {
    const s = stubFor('pk-A');
    const res = await reserve(s, 'n1');
    expect(res.status).toBe('ok');
    expect(res.token).toBeTruthy();

    const c = await commit(s, 'n1', 'tx-abc', res.token!);
    expect(c.ok).toBe(true);

    const again = await reserve(s, 'n1');
    expect(again.status).toBe('exists');
    expect(again.txId).toBe('tx-abc');
  });

  it('reports reserved while an upload is in progress', async () => {
    const s = stubFor('pk-B');
    await reserve(s, 'n2');
    expect((await reserve(s, 'n2')).status).toBe('reserved');
  });

  it('reserve → mark-posted → commit, and exposes the posted anchor for recheck', async () => {
    const s = stubFor('pk-P');
    const res = await reserve(s, 'n');
    expect((await markPosted(s, 'n', 'tx-p', res.token!)).ok).toBe(true);
    // While posted (commit not yet done), check-and-reserve surfaces the anchor.
    const posted = await reserve(s, 'n');
    expect(posted.status).toBe('posted');
    expect(posted.txId).toBe('tx-p');
    // Commit works from the posted state too.
    expect((await commit(s, 'n', 'tx-p', res.token!)).ok).toBe(true);
    expect((await reserve(s, 'n')).status).toBe('exists');
  });

  it('mark-posted is rejected with a stale token', async () => {
    const s = stubFor('pk-MP');
    await reserve(s, 'n');
    expect((await markPosted(s, 'n', 'tx', 'wrong')).ok).toBe(false);
  });

  it('mark-posted is idempotent for the same token + txId (retry safety)', async () => {
    const s = stubFor('pk-Idem');
    const r = await reserve(s, 'n');
    expect((await markPosted(s, 'n', 'tx', r.token!)).ok).toBe(true);
    // A retried mark-posted (lost response) must still succeed, not report stale.
    expect((await markPosted(s, 'n', 'tx', r.token!)).ok).toBe(true);
  });

  it('rejects a commit with a stale token (CAS)', async () => {
    const s = stubFor('pk-C');
    await reserve(s, 'n3');
    const c = await commit(s, 'n3', 'tx', 'wrong-token');
    expect(c.ok).toBe(false);
    expect(c.stale).toBe(true);
  });
});

describe('RateLimiter quota vs attempts (M6)', () => {
  it('counts in-flight reservations so concurrent reserves cannot exceed the limit', async () => {
    const s = stubFor('pk-Par');
    // Two DIFFERENT noteIds reserved without committing must fill the quota.
    expect((await reserve(s, 'p0', 2)).status).toBe('ok');
    expect((await reserve(s, 'p1', 2)).status).toBe('ok');
    // Third distinct note: count=0 but inFlight=2 → rate limited (the bug fix).
    expect((await reserve(s, 'p2', 2)).status).toBe('rate_limited');
  });

  it('spends quota only on commit, so releases do not consume it', async () => {
    const s = stubFor('pk-Q');
    // Reserve + RELEASE three times at limit=2 — quota must stay 0.
    for (let i = 0; i < 3; i++) {
      const r = await reserve(s, `r-${i}`, 2);
      expect(r.status).toBe('ok');
      await release(s, `r-${i}`, r.token!);
    }
    // Now two successful commits fit under the quota…
    for (let i = 0; i < 2; i++) {
      const r = await reserve(s, `c-${i}`, 2);
      expect(r.status).toBe('ok');
      expect((await commit(s, `c-${i}`, `tx-${i}`, r.token!)).ok).toBe(true);
    }
    // …and the third commit-bound reserve is rate limited (quota=2).
    expect((await reserve(s, 'c-over', 2)).status).toBe('rate_limited');
  });

  it('caps reserve attempts even without commits (anti-abuse)', async () => {
    const s = stubFor('pk-Att');
    // limit=1 → attempt ceiling = 3. Reserve+release burns an attempt each time.
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const r = await reserve(s, `a-${i}`, 1);
      if (r.status === 'rate_limited') { limited = true; break; }
      await release(s, `a-${i}`, r.token!);
    }
    expect(limited).toBe(true);
  });
});

describe('RateLimiter release + redrop', () => {
  it('release frees the reservation so the note can be reserved again', async () => {
    const s = stubFor('pk-R');
    const r1 = await reserve(s, 'n');
    await release(s, 'n', r1.token!);
    const r2 = await reserve(s, 'n');
    expect(r2.status).toBe('ok'); // reservable again
  });

  it('release is token-scoped (wrong token is a no-op)', async () => {
    const s = stubFor('pk-R2');
    await reserve(s, 'n');
    await release(s, 'n', 'wrong');
    expect((await reserve(s, 'n')).status).toBe('reserved'); // still held
  });

  it('redrop converts a committed dropped-TX back to a fresh reservation', async () => {
    const s = stubFor('pk-D');
    const r = await reserve(s, 'n');
    await commit(s, 'n', 'tx-dead', r.token!);
    const rd = await redrop(s, 'n', 'tx-dead');
    expect(rd.ok).toBe(true);
    expect(rd.token).toBeTruthy();
    // It is now reservable/re-postable (reserved), not 'exists'.
    expect((await reserve(s, 'n')).status).toBe('reserved');
  });

  it('redrop reports committed + the new txId when already re-posted', async () => {
    const s = stubFor('pk-D2');
    const r = await reserve(s, 'n');
    await commit(s, 'n', 'tx-current', r.token!);
    const rd = await redrop(s, 'n', 'tx-old'); // caller's txId is stale
    expect(rd.ok).toBe(false);
    expect(rd.committed).toBe(true);
    expect(rd.txId).toBe('tx-current');
  });

  it('redrop reports inProgress when another request is mid-repost', async () => {
    const s = stubFor('pk-D3');
    await reserve(s, 'n'); // reserved, not committed
    const rd = await redrop(s, 'n', 'anything');
    expect(rd.ok).toBe(false);
    expect(rd.inProgress).toBe(true);
  });

  it('reclaims a stale reservation slot on re-reserve (no quota deadlock)', async () => {
    const s = stubFor('pk-Stale');
    expect((await reserve(s, 'n', 1)).status).toBe('ok'); // inFlight=1 at limit=1
    // Backdate the reservation past the 10-min TTL.
    await runInDurableObject(s, async (_i, state) => {
      const rec = await state.storage.get<Record<string, unknown>>('note:n');
      await state.storage.put('note:n', { ...rec, reservedAt: Date.now() - 11 * 60_000 });
    });
    // Re-reserve must succeed by reclaiming the stale slot, not rate_limited.
    expect((await reserve(s, 'n', 1)).status).toBe('ok');
  });

  it('does not charge the current window for a previous-generation commit', async () => {
    const s = stubFor('pk-Gen');
    await runInDurableObject(s, async (_i, state) => {
      // New window fully spent (count=2 at limit=2) + an OLD-gen reservation.
      await state.storage.put('count', 2);
      await state.storage.put('inFlight', 0);
      await state.storage.put('attempts', 0);
      await state.storage.put('resetAt', Date.now() + 3_600_000);
      await state.storage.put('note:old', { status: 'reserved', token: 'tk', gen: 1, reservedAt: Date.now() });
    });
    expect((await commit(s, 'old', 'tx-old', 'tk')).ok).toBe(true);
    await runInDurableObject(s, async (_i, state) => {
      expect(await state.storage.get('count')).toBe(2); // not charged to the new window
    });
  });
});

describe('RateLimiter legacy records', () => {
  it('hands out a SNAPSHOT instead of a verdict — the bytes were never fingerprinted', async () => {
    const s = stubFor('pk-Legacy');
    const legacyTime = 1_000_000;
    await runInDurableObject(s, async (_inst, state) => {
      await state.storage.put('note:leg', {
        status: 'committed', token: 't', gen: 0, txId: 'tx-legacy', reservedAt: legacyTime,
      });
    });

    const res = await reserve(s, 'leg');

    // NOT 'exists'. A record whose payload nobody fingerprinted cannot be
    // compared, and answering `exists` would hand out a historical txId for
    // bytes nobody checked — the defect D2 exists to close.
    expect(res.status).toBe('legacy');
    expect(res.snapshot).toEqual({
      status: 'committed', txId: 'tx-legacy', token: 't', gen: 0,
    });
  });

  it('still reports committedAt from reservedAt once the fp is backfilled', async () => {
    const s = stubFor('pk-Legacy2');
    const legacyTime = 1_000_000;
    await runInDurableObject(s, async (_inst, state) => {
      await state.storage.put('note:leg2', {
        status: 'committed', token: 't', gen: 0, txId: 'tx-legacy', reservedAt: legacyTime,
      });
    });
    await backfill(s, 'leg2', { status: 'committed', txId: 'tx-legacy', token: 't', gen: 0 }, FP_A);

    const res = await reserve(s, 'leg2');
    expect(res.status).toBe('exists');
    // Falls back to reservedAt (not 0) — so the 30-min recheck guard still holds.
    expect(res.committedAt).toBe(legacyTime);
  });

  it('a legacy RESERVED record is in-progress, never a backfill candidate', async () => {
    // It has no txId, so there is nothing to authenticate — and the plan is
    // explicit that this branch performs no GET at all.
    const s = stubFor('pk-Legacy3');
    await runInDurableObject(s, async (_inst, state) => {
      await state.storage.put('note:leg3', {
        status: 'reserved', token: 't', gen: 0, reservedAt: Date.now(),
      });
    });
    expect((await reserve(s, 'leg3')).status).toBe('reserved');
  });
});

// ─── D2: the fingerprint, and what it refuses ────────────────────────

describe('semantic idempotency — the same id under DIFFERENT bytes', () => {
  it('a repeat with the SAME fp is a dedupe', async () => {
    const s = stubFor('pk-Fp1');
    const res = await reserve(s, 'n-fp');
    await commit(s, 'n-fp', 'tx-1', res.token!);

    const again = await reserve(s, 'n-fp');
    expect(again.status).toBe('exists');
    expect(again.txId).toBe('tx-1');
    expect(again.deduped).toBe(true);
  });

  it('a repeat with a DIFFERENT fp is a typed conflict, not a replay', async () => {
    // The whole point: returning `exists` here would hand out transaction A for
    // payload B — the pair the two irreversible floors exist to make impossible.
    const s = stubFor('pk-Fp2');
    const res = await reserve(s, 'n-fp2');
    await commit(s, 'n-fp2', 'tx-2', res.token!);

    const conflict = await reserve(s, 'n-fp2', 20, 'fp-payload-B');
    expect(conflict.status).toBe('id_payload_conflict');
    expect(conflict.txId).toBe('tx-2');
    expect(conflict.state).toBe('committed');
  });

  it('compares in the POSTED state too, not only committed', async () => {
    // A posted record hands out a historical txId as well, so comparing one
    // state and not the other would leave the defect reachable via recheck.
    const s = stubFor('pk-Fp3');
    const res = await reserve(s, 'n-fp3');
    await markPosted(s, 'n-fp3', 'tx-3', res.token!);

    expect((await reserve(s, 'n-fp3', 20, 'fp-payload-B')).status).toBe('id_payload_conflict');
    // …and a matching fp keeps the existing protocol path rather than `exists`:
    // `posted` still owes a liveness check and a commit.
    expect((await reserve(s, 'n-fp3')).status).toBe('posted');
  });

  it('carries the fp UNCHANGED through mark-posted and commit', async () => {
    const s = stubFor('pk-Fp4');
    const res = await reserve(s, 'n-fp4');
    await markPosted(s, 'n-fp4', 'tx-4', res.token!);
    await commit(s, 'n-fp4', 'tx-4', res.token!);

    const stored = await runInDurableObject(s, async (_i, state) =>
      state.storage.get<{ fp?: string }>('note:n-fp4'));
    expect(stored?.fp).toBe(FP_A);
    expect((await reserve(s, 'n-fp4', 20, 'fp-payload-B')).status).toBe('id_payload_conflict');
  });
});

describe('/backfill-fp — snapshot CAS', () => {
  const seedLegacy = async (stub: DurableObjectStub, noteId: string) => {
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteId}`, {
        status: 'committed', token: 'tok', gen: 0, txId: 'tx-legacy', reservedAt: 1,
      });
    });
    return { status: 'committed', txId: 'tx-legacy', token: 'tok', gen: 0 };
  };

  it('writes the observed fp when the snapshot still matches', async () => {
    const s = stubFor('pk-Bf1');
    const snap = await seedLegacy(s, 'bf1');
    expect(await backfill(s, 'bf1', snap, 'fp-observed')).toEqual({ ok: true, fp: 'fp-observed' });
    expect((await reserve(s, 'bf1', 20, 'fp-observed')).status).toBe('exists');
  });

  it('refuses when the record moved on — a stale snapshot writes nothing', async () => {
    const s = stubFor('pk-Bf2');
    const snap = await seedLegacy(s, 'bf2');
    await runInDurableObject(s, async (_i, state) => {
      await state.storage.put('note:bf2', {
        status: 'committed', token: 'DIFFERENT', gen: 0, txId: 'tx-legacy', reservedAt: 1,
      });
    });
    const r = await backfill(s, 'bf2', snap, 'fp-observed');
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
  });

  it('refuses a SECOND backfill even with an identical snapshot', async () => {
    // Two concurrent backfills can hold snapshots identical in all four fields.
    // Without the `fp === undefined` requirement the second would overwrite the
    // first's result — a lost update the four-field CAS cannot see.
    const s = stubFor('pk-Bf3');
    const snap = await seedLegacy(s, 'bf3');
    expect((await backfill(s, 'bf3', snap, 'fp-first')).ok).toBe(true);

    const second = await backfill(s, 'bf3', snap, 'fp-second');
    expect(second.ok).toBe(false);
    expect(second.stale).toBe(true);
    // The loser is told what is already there, so it need not repeat the GET.
    expect(second.fp).toBe('fp-first');
  });

  it('refuses for a record that no longer exists', async () => {
    const s = stubFor('pk-Bf4');
    const r = await backfill(s, 'gone', { status: 'committed', txId: 't', token: 'k', gen: 0 }, 'fp');
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
  });
});
