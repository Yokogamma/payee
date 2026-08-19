import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { warmUpInviteManager } from './warmup';

beforeAll(() => warmUpInviteManager());

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

describe('CORS allowlist', () => {
  it('returns ACAO only for an origin in ALLOWED_ORIGINS', async () => {
    // localhost:5173 is in wrangler.toml ALLOWED_ORIGINS; a stranger is not.
    const allowed = await SELF.fetch('https://proxy.example.com/health', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');

    const stranger = await SELF.fetch('https://proxy.example.com/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows the PRODUCTION origin (notes.matamata.dev), incl. preflight', async () => {
    const prod = await SELF.fetch('https://proxy.example.com/health', {
      headers: { Origin: 'https://notes.matamata.dev' },
    });
    expect(prod.headers.get('Access-Control-Allow-Origin')).toBe('https://notes.matamata.dev');

    const preflight = await SELF.fetch('https://proxy.example.com/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://notes.matamata.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, X-Public-Key, X-Signature',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://notes.matamata.dev');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('X-Signature');
  });

  it('does NOT allow arbitrary *.pages.dev preview origins', async () => {
    const preview = await SELF.fetch('https://proxy.example.com/health', {
      headers: { Origin: 'https://random-preview.matamata-notes.pages.dev' },
    });
    expect(preview.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

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
  }, 20_000); // 60+ sequential requests — headroom under full-suite load

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
  }, 30_000);

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
  }, 20_000);

  it('/wallet-address uses its OWN bucket: exhausting it does not starve the main routes', async () => {
    // A third-party page can fire no-preflight GETs at the diagnostic endpoint;
    // that must burn only the 'diag' shard, never the user's upload budget.
    const ip = `diagsep-${RUN}`;
    let sawDiagLimit = false;
    for (let i = 0; i < IP_RATE_LIMIT + 5; i++) {
      const r = await get('/wallet-address', ip);
      if (r.status === 429) { sawDiagLimit = true; break; }
    }
    expect(sawDiagLimit).toBe(true); // diag bucket exhausted...

    // ...while the SAME IP still passes the main limiter on a protected route
    // (401 missing auth headers — i.e. it got past the rate limit).
    const up = await post('/upload', ip);
    expect(up.status).not.toBe(429);
  }, 20_000); // 60+ sequential requests — needs headroom under full-suite load
});
