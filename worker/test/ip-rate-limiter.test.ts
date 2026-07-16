import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// D-baseline: sharded per-IP limiter (idFromName(ip)) with self-cleaning alarm.

const IP = (env as unknown as { IP_RATE_LIMITER: DurableObjectNamespace }).IP_RATE_LIMITER;

// Unique per-run suffix so reused workerd state never leaks between runs.
const RUN = crypto.randomUUID().slice(0, 8);

function shard(ip: string) {
  return IP.get(IP.idFromName(`${ip}-${RUN}`));
}

async function check(stub: DurableObjectStub, limit: number, windowMs = 60_000) {
  const resp = await stub.fetch('http://ip-limiter/check', {
    method: 'POST',
    body: JSON.stringify({ limit, windowMs }),
  });
  return resp.status;
}

describe('IpRateLimiter DO', () => {
  it('allows under the limit and 429s over it', async () => {
    const s = shard('10.0.0.1');
    expect(await check(s, 3)).toBe(200);
    expect(await check(s, 3)).toBe(200);
    expect(await check(s, 3)).toBe(200);
    expect(await check(s, 3)).toBe(429);
  });

  it('isolates counters per IP shard', async () => {
    const a = shard('10.0.0.2');
    const b = shard('10.0.0.3');
    expect(await check(a, 1)).toBe(200);
    expect(await check(a, 1)).toBe(429); // a exhausted
    expect(await check(b, 1)).toBe(200); // b unaffected
  });

  it('alarm() wipes storage once the window has fully elapsed', async () => {
    const s = shard('10.0.0.9');
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('win', { count: 5, resetAt: Date.now() - 1000 }); // expired
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
      expect(await state.storage.get('win')).toBeUndefined();
    });
  });

  it('alarm() preserves a still-live window and re-arms (at-least-once safety)', async () => {
    const s = shard('10.0.0.10');
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('win', { count: 3, resetAt: Date.now() + 60_000 }); // live
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
      expect(await state.storage.get('win')).toBeDefined(); // counter untouched
      expect(await state.storage.getAlarm()).not.toBeNull(); // re-armed for current window
    });
  });
});
