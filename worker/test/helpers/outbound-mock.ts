import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest';

/**
 * Shared outbound-fetch mock for the direct-dispatch suites
 * (vitest.direct.config.mts). Outbound Arweave HTTP is mocked by stubbing the
 * isolate's GLOBAL fetch (vitest-pool-workers ≥0.18 dropped `fetchMock`).
 * Routes are SINGLE-USE by default (undici-interceptor semantics preserved):
 * an exhausted or unmocked request throws, and afterEach asserts every
 * registered route was fully consumed — an expected-but-never-sent request
 * fails the test, and a regression that fires the same paid request twice
 * cannot pass.
 *
 * Call `setupOutboundMock()` once at module scope per test file; it registers
 * the lifecycle hooks and returns the per-file `mockRoute`.
 */

export interface OutboundRoute {
  method: string;
  url: RegExp;
  status: number;
  body: string;
  times: number;
  calls: number;
}

export function setupOutboundMock() {
  const outboundRoutes: OutboundRoute[] = [];

  function mockRoute(method: string, url: RegExp, status: number, body: string, times = 1): OutboundRoute {
    const route: OutboundRoute = { method, url, status, body, times, calls: 0 };
    outboundRoutes.push(route);
    return route;
  }

  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = ((input instanceof Request ? input.method : init?.method) ?? 'GET').toUpperCase();
      const route = outboundRoutes.find(r => r.method === method && r.url.test(url) && r.calls < r.times);
      if (!route) throw new Error(`unmocked or exhausted outbound fetch: ${method} ${url}`);
      route.calls++;
      return new Response(route.body, { status: route.status });
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  afterEach(() => {
    // assertNoPendingInterceptors() equivalent: every route fully consumed.
    const pending = outboundRoutes
      .filter(r => r.calls !== r.times)
      .map(r => `${r.method} ${r.url} (${r.calls}/${r.times})`);
    outboundRoutes.length = 0; // clean slate for the next test either way
    expect(pending, `unconsumed outbound mocks: ${pending.join('; ')}`).toEqual([]);
  });

  return { mockRoute };
}

// ─── Shared crypto helpers for signed-request builders ──────────────

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
