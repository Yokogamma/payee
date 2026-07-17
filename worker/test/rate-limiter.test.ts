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

async function reserve(stub: DurableObjectStub, noteId: string, limit = 20) {
  const r = await stub.fetch('http://do/check-and-reserve', {
    method: 'POST', body: JSON.stringify({ noteId, limit }),
  });
  return r.json() as Promise<{ status: string; token?: string; txId?: string; committedAt?: number }>;
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
  it('reports committedAt from reservedAt for a legacy committed record', async () => {
    const s = stubFor('pk-Legacy');
    const legacyTime = 1_000_000;
    // Inject a pre-committedAt record (time lived in reservedAt only).
    await runInDurableObject(s, async (_inst, state) => {
      await state.storage.put('note:leg', {
        status: 'committed', token: 't', gen: 0, txId: 'tx-legacy', reservedAt: legacyTime,
      });
    });
    const res = await reserve(s, 'leg');
    expect(res.status).toBe('exists');
    // Falls back to reservedAt (not 0) — so the 30-min recheck guard still holds.
    expect(res.committedAt).toBe(legacyTime);
  });
});
