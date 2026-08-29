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
  /** Optional artificial latency before the mocked response resolves. */
  delayMs?: number;
  /** Optional body factory overriding `body` — lets a test hand out a
   *  streaming/erroring body (e.g. a truncated connection). */
  makeBody?: () => BodyInit;
  /** Body of the LAST matching request (string bodies and Request inputs). */
  lastBody?: string;
  /** URL of the LAST matching request (for asserting computed path params). */
  lastUrl?: string;
  /** True when the caller passed an AbortSignal via init (string-URL calls
   *  only — a Request input always carries its own signal object, so the
   *  distinction is meaningless there and the field stays undefined). */
  gotSignal?: boolean;
  /** Authorization header of the LAST matching request, if any. */
  lastAuthorization?: string;
}

/** Status origins configured for the test isolates (vitest*.config.mts). */
export const STATUS_ORIGINS = ['https://arweave.net', 'https://g2.test'] as const;

/** Matches "<origin>/tx/<txId>/status", with the origin's dots escaped. */
export function statusUrlRe(origin: string, txId: string): RegExp {
  return new RegExp('^' + origin.replace(/\./g, '\\.') + '/tx/' + txId + '/status$');
}

export function setupOutboundMock() {
  const outboundRoutes: OutboundRoute[] = [];

  function mockRoute(
    method: string, url: RegExp, status: number, body: string, times = 1,
    opts: { delayMs?: number; makeBody?: () => BodyInit } = {},
  ): OutboundRoute {
    const route: OutboundRoute = {
      method, url, status, body, times, calls: 0,
      delayMs: opts.delayMs, makeBody: opts.makeBody,
    };
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
      route.lastUrl = url;
      if (!(input instanceof Request)) route.gotSignal = init?.signal != null;
      if (typeof init?.body === 'string') route.lastBody = init.body;
      else if (input instanceof Request) {
        try { route.lastBody = await input.clone().text(); } catch { /* keep undefined */ }
      }
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      route.lastAuthorization = headers.get('Authorization') ?? undefined;
      if (route.delayMs) await new Promise(r => setTimeout(r, route.delayMs));
      return new Response(route.makeBody ? route.makeBody() : route.body, { status: route.status });
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

  /**
   * Register the SAME status answer on EVERY configured status origin.
   *
   * PR-3a probes the whole pool and the dead verdict requires unanimity, so a
   * test that mocked a single host would describe a PARTIAL set — which can
   * only ever produce `unavailable`, never the `dead` these suites are about.
   */
  function mockStatusOnAll(
    txId: string, status: number, body: string,
    opts: { delayMs?: number; makeBody?: () => BodyInit } = {},
  ): OutboundRoute[] {
    return STATUS_ORIGINS.map(origin =>
      mockRoute('GET', statusUrlRe(origin, txId), status, body, 1, opts));
  }

  return { mockRoute, mockStatusOnAll };
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
