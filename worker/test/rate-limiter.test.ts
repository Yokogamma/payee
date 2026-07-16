import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Phase 0 smoke test — pins current RateLimiter DO behavior before Phase 2 rework.
// The DO exposes an internal HTTP interface (/check-and-reserve, /commit).

const RATE_LIMITER = (env as unknown as {
  RATE_LIMITER: DurableObjectNamespace;
}).RATE_LIMITER;

// Unique per-run suffix so reused workerd state (watch mode, isolatedStorage off)
// never leaks exhausted counters into the next run.
const RUN = crypto.randomUUID().slice(0, 8);

function stubFor(name: string) {
  return RATE_LIMITER.get(RATE_LIMITER.idFromName(`${name}-${RUN}`));
}

async function reserve(stub: DurableObjectStub, noteId: string, limit = 20) {
  const resp = await stub.fetch('http://do/check-and-reserve', {
    method: 'POST',
    body: JSON.stringify({ noteId, limit }),
  });
  return resp.json() as Promise<{ status: string; txId?: string; remaining?: number }>;
}

describe('RateLimiter DO (current behavior)', () => {
  it('reserves a new noteId, then reports exists after commit', async () => {
    const stub = stubFor('pk-A');
    const first = await reserve(stub, 'note-1');
    expect(first.status).toBe('ok');

    await stub.fetch('http://do/commit', {
      method: 'POST',
      body: JSON.stringify({ noteId: 'note-1', txId: 'tx-abc' }),
    });

    const second = await reserve(stub, 'note-1');
    expect(second.status).toBe('exists');
    expect(second.txId).toBe('tx-abc');
  });

  it('reports reserved while an upload is in progress', async () => {
    const stub = stubFor('pk-B');
    await reserve(stub, 'note-2');
    const again = await reserve(stub, 'note-2');
    expect(again.status).toBe('reserved');
  });

  it('rate-limits once the per-window quota is exhausted', async () => {
    const stub = stubFor('pk-C');
    for (let i = 0; i < 3; i++) {
      const r = await reserve(stub, `n-${i}`, 3);
      expect(r.status).toBe('ok');
    }
    const over = await reserve(stub, 'n-over', 3);
    expect(over.status).toBe('rate_limited');
  });
});
