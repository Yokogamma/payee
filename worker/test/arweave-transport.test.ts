import { describe, it, expect } from 'vitest';
import {
  ARWEAVE_HOST,
  assertStructurallyCompleteJwk,
  classifyStatus,
  classifyThrow,
  getAnchor,
  getPrice,
  postSignedTx,
  readCappedText,
} from '../src/arweave-transport';
import { makeEmit } from '../src/metrics';
import { setupOutboundMock } from './helpers/outbound-mock';

// Unit tests of the PR-2 transport adapter (spec: §4.PR-2 «Реализация», §R1).
// Runs in the direct-dispatch config: this file stubs the isolate's global
// fetch (outbound-mock), which must never mix with SELF-based suites.

const { mockRoute } = setupOutboundMock();

type EmitCall = { event: string; blobs: string[]; doubles: number[] };
function capturingEmit() {
  const calls: EmitCall[] = [];
  const emit = (event: string, blobs: string[], doubles: number[]) => {
    calls.push({ event, blobs, doubles });
  };
  return { calls, emit };
}

async function realRsaJwk(): Promise<Record<string, string>> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  return await crypto.subtle.exportKey('jwk', keyPair.privateKey) as unknown as Record<string, string>;
}

describe('assertStructurallyCompleteJwk — the honest boundary', () => {
  it('rejects non-JSON, {}, arrays and non-RSA kty BEFORE any network', () => {
    expect(() => assertStructurallyCompleteJwk('not json')).toThrow(/not valid JSON/);
    expect(() => assertStructurallyCompleteJwk('{}')).toThrow(/kty/);
    expect(() => assertStructurallyCompleteJwk('[]')).toThrow(/not a JSON object/);
    expect(() => assertStructurallyCompleteJwk('{"kty":"EC"}')).toThrow(/kty/);
  });

  it('rejects a TRUNCATED private key (missing q / dp / empty field)', async () => {
    const jwk = await realRsaJwk();
    for (const missing of ['q', 'dp'] as const) {
      const broken: Record<string, string> = { ...jwk };
      delete broken[missing];
      expect(() => assertStructurallyCompleteJwk(JSON.stringify(broken)))
        .toThrow(new RegExp(`"${missing}"`));
    }
    expect(() => assertStructurallyCompleteJwk(JSON.stringify({ ...jwk, d: '' })))
      .toThrow(/"d"/);
  });

  it('accepts a full private RSA set — and (accepted limitation) also a structurally complete but cryptographically invalid one', async () => {
    const jwk = await realRsaJwk();
    expect(assertStructurallyCompleteJwk(JSON.stringify(jwk))).toBeTruthy();
    // Broken base64url passes the STRUCTURAL check by design — it spends the
    // anchor+price legs and fails at signing (e2e covers that flow).
    expect(assertStructurallyCompleteJwk(JSON.stringify({ ...jwk, d: '!!!not-base64url!!!' })))
      .toBeTruthy();
  });
});

describe('classifiers', () => {
  it('classifyStatus buckets', () => {
    expect(classifyStatus(200)).toBe('2xx');
    expect(classifyStatus(202)).toBe('2xx');
    expect(classifyStatus(404)).toBe('404');
    expect(classifyStatus(429)).toBe('4xx');
    expect(classifyStatus(500)).toBe('5xx');
    expect(classifyStatus(302)).toBe('network');
  });

  it('classifyThrow: TimeoutError/AbortError → timeout, anything else → network', () => {
    expect(classifyThrow(new DOMException('t', 'TimeoutError'))).toBe('timeout');
    expect(classifyThrow(new DOMException('a', 'AbortError'))).toBe('timeout');
    expect(classifyThrow(new Error('boom'))).toBe('network');
    expect(classifyThrow('string')).toBe('network');
  });
});

describe('readCappedText', () => {
  it('returns the text under the cap and null over it (stream cancelled)', async () => {
    expect(await readCappedText(new Response('abc'), 1024)).toBe('abc');
    expect(await readCappedText(new Response('x'.repeat(2048)), 1024)).toBeNull();
  });
});

describe('getAnchor — runtime schema 43..64 base64url', () => {
  const deps = () => {
    const { calls, emit } = capturingEmit();
    return { calls, deps: { host: ARWEAVE_HOST, emit } };
  };

  it('accepts a 43-char anchor AND a real 64-char block indep-hash', async () => {
    mockRoute('GET', /\/tx_anchor$/, 200, 'A'.repeat(43));
    const d1 = deps();
    expect(await getAnchor(d1.deps)).toBe('A'.repeat(43));
    expect(d1.calls).toEqual([
      { event: 'gateway_call', blobs: ['anchor', ARWEAVE_HOST, '2xx'], doubles: [expect.any(Number)] },
    ]);

    // Live gateway 2026-08-21: /tx_anchor returned 64 chars — "exactly 43"
    // would have broken production.
    mockRoute('GET', /\/tx_anchor$/, 200, 'B-_'.repeat(21) + 'C'); // 64 chars
    const d2 = deps();
    expect(await getAnchor(d2.deps)).toHaveLength(64);
  });

  it('rejects a too-short / non-base64url / oversized body as invalid_response', async () => {
    for (const bad of ['A'.repeat(42), '!'.repeat(50), 'A'.repeat(3072)]) {
      mockRoute('GET', /\/tx_anchor$/, 200, bad);
      const d = deps();
      await expect(getAnchor(d.deps)).rejects.toThrow(/invalid_response/);
      expect(d.calls[0].blobs).toEqual(['anchor', ARWEAVE_HOST, 'invalid_response']);
    }
  });

  it('classifies HTTP failures and network throws; never returns them', async () => {
    mockRoute('GET', /\/tx_anchor$/, 500, 'oops');
    const d1 = deps();
    await expect(getAnchor(d1.deps)).rejects.toThrow(/5xx/);
    expect(d1.calls[0].blobs).toEqual(['anchor', ARWEAVE_HOST, '5xx']);

    // No route registered → the stub throws (net-connect disabled) → 'network'.
    const d2 = deps();
    await expect(getAnchor(d2.deps)).rejects.toThrow(/network/);
    expect(d2.calls[0].blobs).toEqual(['anchor', ARWEAVE_HOST, 'network']);
  });
});

describe('getPrice — digits 1..20, returned AS A STRING', () => {
  const deps = () => {
    const { calls, emit } = capturingEmit();
    return { calls, deps: { host: ARWEAVE_HOST, emit } };
  };

  it('returns the price string and records quotedWinston as the second double', async () => {
    mockRoute('GET', /\/price\/51200$/, 200, '3049039377');
    const d = deps();
    expect(await getPrice(51200, d.deps)).toBe('3049039377');
    expect(d.calls[0].blobs).toEqual(['price', ARWEAVE_HOST, '2xx']);
    expect(d.calls[0].doubles[1]).toBe(3049039377);
  });

  it('requests EXACTLY the byte count it was given', async () => {
    const route = mockRoute('GET', /\/price\/\d+$/, 200, '0');
    await getPrice(12345, deps().deps);
    expect(route.lastUrl).toMatch(/\/price\/12345$/);
  });

  it('quotedWinston precision boundary (L r18/r19): MAX_SAFE_INTEGER in, +1 → −1, string preserved', async () => {
    const max = String(Number.MAX_SAFE_INTEGER); // 9007199254740991
    mockRoute('GET', /\/price\/1$/, 200, max);
    const d1 = deps();
    expect(await getPrice(1, d1.deps)).toBe(max);
    expect(d1.calls[0].doubles[1]).toBe(Number.MAX_SAFE_INTEGER);

    const overMax = '9007199254740992';
    mockRoute('GET', /\/price\/1$/, 200, overMax);
    const d2 = deps();
    // The metric double degrades to −1; the RETURNED price string is intact —
    // the SDK always receives the reward as a string.
    expect(await getPrice(1, d2.deps)).toBe(overMax);
    expect(d2.calls[0].doubles[1]).toBe(-1);
  });

  it('rejects non-digit and >20-digit bodies as invalid_response — garbage never reaches the SDK', async () => {
    for (const bad of ['12abc', '1'.repeat(21), '']) {
      mockRoute('GET', /\/price\/9$/, 200, bad);
      const d = deps();
      await expect(getPrice(9, d.deps)).rejects.toThrow(/invalid_response/);
      expect(d.calls[0].blobs).toEqual(['price', ARWEAVE_HOST, 'invalid_response']);
    }
  });
});

describe('postSignedTx — a passive stopwatch, nothing more', () => {
  type FakeArweave = Parameters<typeof postSignedTx>[0];
  const fakeTx = {} as Parameters<typeof postSignedTx>[1];

  it('waits out a SLOW but accepted POST and measures it (no abort, no retry)', async () => {
    const fake = {
      transactions: {
        post: async () => {
          await new Promise(r => setTimeout(r, 50));
          return { status: 200 };
        },
      },
    } as unknown as FakeArweave;
    const { calls, emit } = capturingEmit();
    const res = await postSignedTx(fake, fakeTx, { host: ARWEAVE_HOST, emit });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { event: 'gateway_call', blobs: ['post', ARWEAVE_HOST, '2xx'], doubles: [expect.any(Number)] },
    ]);
    expect(calls[0].doubles[0]).toBeGreaterThanOrEqual(45);
  });

  it('passes non-2xx responses THROUGH (the caller owns the 502 decision)', async () => {
    const fake = {
      transactions: { post: async () => ({ status: 400 }) },
    } as unknown as FakeArweave;
    const { calls, emit } = capturingEmit();
    const res = await postSignedTx(fake, fakeTx, { host: ARWEAVE_HOST, emit });
    expect(res.status).toBe(400);
    expect(calls[0].blobs).toEqual(['post', ARWEAVE_HOST, '4xx']);
  });

  it('rethrows post exceptions unchanged after recording the class', async () => {
    const boom = new Error('socket reset');
    const fake = {
      transactions: { post: async () => { throw boom; } },
    } as unknown as FakeArweave;
    const { calls, emit } = capturingEmit();
    await expect(postSignedTx(fake, fakeTx, { host: ARWEAVE_HOST, emit })).rejects.toBe(boom);
    expect(calls[0].blobs).toEqual(['post', ARWEAVE_HOST, 'network']);
  });
});

describe('makeEmit — fail-closed telemetry, fail-open requests', () => {
  const point = () => ({ indexes: ['upload_outcome'], blobs: ['upload_outcome', 'accepted', '2'], doubles: [] });

  it("writes STRICTLY when METRICS_ENABLED === 'true' and the binding exists", () => {
    const written: unknown[] = [];
    const dataset = { writeDataPoint: (p: unknown) => { written.push(p); } } as AnalyticsEngineDataset;
    makeEmit({ METRICS_ENABLED: 'true', METRICS: dataset })('upload_outcome', ['accepted', '2'], []);
    expect(written).toEqual([point()]);
  });

  it('any other value — false, garbage, missing var, missing binding — writes nothing', () => {
    const written: unknown[] = [];
    const dataset = { writeDataPoint: (p: unknown) => { written.push(p); } } as AnalyticsEngineDataset;
    makeEmit({ METRICS_ENABLED: 'false', METRICS: dataset })('e', [], []);
    makeEmit({ METRICS_ENABLED: 'yes', METRICS: dataset })('e', [], []);
    makeEmit({ METRICS: dataset })('e', [], []);
    makeEmit({ METRICS_ENABLED: 'true' })('e', [], []);
    expect(written).toEqual([]);
  });

  it('a throwing writeDataPoint never propagates', () => {
    const dataset = { writeDataPoint: () => { throw new Error('AE down'); } } as unknown as AnalyticsEngineDataset;
    expect(() => makeEmit({ METRICS_ENABLED: 'true', METRICS: dataset })('e', [], [])).not.toThrow();
  });
});
