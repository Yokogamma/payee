import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Integration: the default Worker fetch handler must run the sharded per-IP
// limiter at the START of protected routes (before body/auth/KV/DO), and
// short-circuit with 429 once the window is exhausted.

const IP_RATE_LIMIT = 60; // must match index.ts

function post(path: string, ip: string, body = '{}') {
  return SELF.fetch(`https://proxy.example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body,
  });
}

function get(path: string, ip: string) {
  return SELF.fetch(`https://proxy.example.com${path}`, {
    method: 'GET',
    headers: { 'CF-Connecting-IP': ip },
  });
}

// Unique IPs per run so watch-mode reuse never carries counters over.
const RUN = crypto.randomUUID().slice(0, 6);

describe('protected routes: per-IP limiter (D-baseline)', () => {
  it('runs the limiter before auth on /upload, then 429s once exhausted', async () => {
    const ip = `up-${RUN}`;
    // First request passes the limiter, then fails auth (missing X-Public-Key)
    // → 401. Proves the limiter ran but did not yet short-circuit.
    const early = await post('/upload', ip);
    expect(early.status).toBe(401);

    let sawLimit = false;
    for (let i = 0; i < IP_RATE_LIMIT + 5; i++) {
      const r = await post('/upload', ip);
      if (r.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });

  it('also limits /check-registration and /register per IP', async () => {
    for (const path of ['/check-registration', '/register']) {
      const ip = `${path.replace(/\W/g, '')}-${RUN}`;
      let sawLimit = false;
      for (let i = 0; i < IP_RATE_LIMIT + 5; i++) {
        const r = await post(path, ip);
        if (r.status === 429) { sawLimit = true; break; }
      }
      expect(sawLimit, `expected 429 on ${path}`).toBe(true);
    }
  });

  it('limits the /wallet-address diagnostic endpoint too', async () => {
    const ip = `wa-${RUN}`;
    // First GET is not rate-limited (200 with the address, or 503 if the test
    // JWK is a stub — either way NOT 429), proving the limiter let it through.
    const early = await get('/wallet-address', ip);
    expect(early.status).not.toBe(429);

    let sawLimit = false;
    for (let i = 0; i < IP_RATE_LIMIT + 5; i++) {
      const r = await get('/wallet-address', ip);
      if (r.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });
});
