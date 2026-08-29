import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';
import { addressOfJwk } from '../test-stubs/wallet-address';
import { setupOutboundMock, b64, sha256, statusUrlRe } from './helpers/outbound-mock';

// PR-2 e2e: metric emission through the REAL /upload route (direct dispatch —
// env overrides inject a capturing METRICS dataset). Spec: §4.PR-2, §R4.
//
// Route hygiene doubles as the "exactly 3 outbound calls" assertion: every
// mocked route is single-use, afterEach fails on unconsumed routes, and any
// EXTRA outbound call throws (net-connect disabled) → 502 would fail the test.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

const { mockRoute, mockStatusOnAll } = setupOutboundMock();

const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA'; // 12 bytes
const nextIp = () => `met-${crypto.randomUUID().slice(0, 8)}`;

const ANCHOR = mockAnchorValue();
function mockAnchorValue(): string {
  return 'A'.repeat(64); // live gateways return the 64-char block indep-hash
}

let realJwk = '';
beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  realJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
  realWalletOwners = await addressOfJwk(realJwk);
});

async function makeIdentity() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

/** Well-formed v2 upload; opts let a test corrupt tags or attach recovery. */
async function uploadRequest(
  id: { priv: Uint8Array; pkB64: string; ownerHash: string },
  noteId: string,
  opts: {
    recheck?: boolean;
    extraTag?: { name: string; value: string };
    recovery?: { txId: string; postedAt: number; token: string };
  } = {},
): Promise<{ request: Request; dataString: string }> {
  const dataString = JSON.stringify({ id: noteId, c: C, iv: IV });
  const body = JSON.stringify({
    data: dataString,
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '2' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: noteId },
      ...(opts.extraTag ? [opts.extraTag] : []),
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    ...(opts.recheck ? { recheck: true } : {}),
    ...(opts.recovery ? { recovery: opts.recovery } : {}),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return {
    dataString,
    request: new Request('https://proxy.example.com/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': nextIp() },
      body,
    }),
  };
}

type Point = { indexes?: unknown[]; blobs?: unknown[]; doubles?: number[] };
function capture() {
  const points: Point[] = [];
  const dataset = { writeDataPoint: (p: Point) => { points.push(p); } } as unknown as AnalyticsEngineDataset;
  const byEvent = (event: string) => points.filter(p => p.blobs?.[0] === event);
  return { points, dataset, byEvent };
}

// `realWalletOwners` is the address realJwk derives to: /upload refuses while
// the signing wallet is outside TRUSTED_OWNERS (D2/D9), and these tests sign
// with a wallet they generate themselves. `extra` still wins, so the JWK-matrix
// cases below can substitute a broken key without also being told it is
// trusted — a key that cannot derive an address cannot sign, and keeps its own
// 502/`arweave_throw` outcome.
let realWalletOwners = '';

const metricsEnv = (dataset: AnalyticsEngineDataset, extra: Record<string, unknown> = {}): WorkerEnv =>
  ({
    ...baseEnv, ARWEAVE_JWK: realJwk, TRUSTED_OWNERS: realWalletOwners,
    METRICS_ENABLED: 'true', METRICS: dataset, ...extra,
  }) as WorkerEnv;

function mockPaidLegs(priceBody = '3049039377', opts: { postDelayMs?: number } = {}) {
  const anchor = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, ANCHOR);
  const price = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, priceBody);
  const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK',
    1, { delayMs: opts.postDelayMs });
  return { anchor, price, post };
}

describe('successful upload: exactly 3 legs, full event set, privacy', () => {
  it('emits gateway_call ×3 + post_accepted + upload_outcome=accepted and leaks no ids', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const cap = capture();
    const { anchor, price, post } = mockPaidLegs();

    const { request, dataString } = await uploadRequest(id, noteId);
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(post.calls).toBe(1);

    // The SDK was given {last_tx, reward} PRE-LOADED: the priced byte count is
    // the UTF-8 length of the data string, the posted tx carries our reward
    // as the ORIGINAL string and the mocked anchor.
    const expectedBytes = new TextEncoder().encode(dataString).byteLength;
    expect(price.lastUrl).toMatch(new RegExp(`/price/${expectedBytes}$`));
    const postedTx = JSON.parse(post.lastBody!) as { reward: string; last_tx: string; data_size: string };
    expect(postedTx.reward).toBe('3049039377');
    expect(postedTx.last_tx).toBe(ANCHOR);
    expect(postedTx.data_size).toBe(String(expectedBytes));
    expect(anchor.calls).toBe(1);

    // Event set, in emission order.
    const gateway = cap.byEvent('gateway_call');
    expect(gateway.map(p => [p.blobs?.[1], p.blobs?.[3]])).toEqual([
      ['anchor', '2xx'], ['price', '2xx'], ['post', '2xx'],
    ]);
    expect(gateway.map(p => p.blobs?.[2])).toEqual(['arweave.net', 'arweave.net', 'arweave.net']);
    expect(gateway[1].doubles?.[1]).toBe(3049039377); // quotedWinston
    expect(cap.byEvent('post_accepted')).toHaveLength(1);
    expect(cap.byEvent('redrop_new_tx')).toHaveLength(0);
    expect(cap.byEvent('upload_outcome').map(p => [p.blobs?.[1], p.blobs?.[2]]))
      .toEqual([['accepted', '2']]);
    // indexes = [event] on every point (independent sampling per type).
    for (const p of cap.points) expect(p.indexes).toEqual([p.blobs?.[0]]);

    // Privacy: no noteId, no txId, no public key anywhere in the datapoints.
    const serialized = JSON.stringify(cap.points);
    expect(serialized).not.toContain(noteId);
    expect(serialized).not.toContain(body.txId);
    expect(serialized).not.toContain(id.pkB64);
  });

  it('a SLOW but accepted POST is never aborted: no signal, one POST, 200', async () => {
    const id = await makeIdentity();
    const cap = capture();
    const { post } = mockPaidLegs('0', { postDelayMs: 50 });

    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    expect(post.calls).toBe(1);
    // The SDK calls fetch(url, init) — init carried NO AbortSignal (the
    // active-timeout ban until PR-3b, HIGH r14).
    expect(post.gotSignal).toBe(false);
  });
});

describe('JWK matrix (spec §R4)', () => {
  it('broken and TRUNCATED JWK → 502 with ZERO outbound attempts (no gateway_call at all)', async () => {
    const id = await makeIdentity();
    for (const jwk of ['{}', JSON.stringify({ ...JSON.parse(realJwk), q: undefined })]) {
      const cap = capture();
      const { request } = await uploadRequest(id, crypto.randomUUID());
      const r = await worker.fetch(request, metricsEnv(cap.dataset, { ARWEAVE_JWK: jwk }));
      expect(r.status).toBe(502);
      // Had a fetch been attempted, gateway_call class=network would exist.
      expect(cap.byEvent('gateway_call')).toHaveLength(0);
      expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['arweave_throw']);
    }
  });

  it('structurally complete but CRYPTOGRAPHICALLY invalid JWK: anchor+price spent, signing fails, 502', async () => {
    const id = await makeIdentity();
    const cap = capture();
    // anchor + price are registered and WILL be consumed; no POST route —
    // signing must throw before the paid POST.
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, ANCHOR);
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');

    const badJwk = JSON.stringify({ ...JSON.parse(realJwk), d: '!!!not-base64url!!!' });
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset, { ARWEAVE_JWK: badJwk }));
    expect(r.status).toBe(502);
    expect(cap.byEvent('gateway_call').map(p => [p.blobs?.[1], p.blobs?.[3]]))
      .toEqual([['anchor', '2xx'], ['price', '2xx']]);
    expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['arweave_throw']);
  });
});

describe('gateway protocol defects → invalid_response, not SDK garbage', () => {
  it('malformed anchor (non-base64url) and oversized anchor stop the flow at the anchor leg', async () => {
    const id = await makeIdentity();
    for (const bad of ['!'.repeat(50), 'A'.repeat(3072)]) {
      const cap = capture();
      mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, bad);
      const { request } = await uploadRequest(id, crypto.randomUUID());
      const r = await worker.fetch(request, metricsEnv(cap.dataset));
      expect(r.status).toBe(502);
      expect(cap.byEvent('gateway_call').map(p => [p.blobs?.[1], p.blobs?.[3]]))
        .toEqual([['anchor', 'invalid_response']]); // and NOTHING went further
    }
  });

  it("malformed price ('12abc') → 502, class invalid_response", async () => {
    const id = await makeIdentity();
    const cap = capture();
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, ANCHOR);
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '12abc');
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(502);
    expect(cap.byEvent('gateway_call').map(p => [p.blobs?.[1], p.blobs?.[3]]))
      .toEqual([['anchor', '2xx'], ['price', 'invalid_response']]);
  });

  it('quotedWinston boundary e2e: over-MAX price still posts with the ORIGINAL string', async () => {
    const id = await makeIdentity();
    const cap = capture();
    const overMax = '9007199254740992'; // MAX_SAFE_INTEGER + 1
    const { post } = mockPaidLegs(overMax);
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    const priceCall = cap.byEvent('gateway_call').find(p => p.blobs?.[1] === 'price')!;
    expect(priceCall.doubles?.[1]).toBe(-1); // not representable → "not recorded"
    expect((JSON.parse(post.lastBody!) as { reward: string }).reward).toBe(overMax);
  });
});

describe('METRICS_ENABLED matrix + fail-open request path', () => {
  it("writes only on the EXACT string 'true'; false/garbage/missing var/missing binding stay silent", async () => {
    const id = await makeIdentity();
    const variants: Array<Record<string, unknown>> = [
      { METRICS_ENABLED: 'false' },
      { METRICS_ENABLED: 'yes' },
      { METRICS_ENABLED: undefined },
      { METRICS: undefined }, // binding missing, switch on
    ];
    for (const extra of variants) {
      const cap = capture();
      mockPaidLegs('0');
      const { request } = await uploadRequest(id, crypto.randomUUID());
      const r = await worker.fetch(request, metricsEnv(cap.dataset, extra));
      expect(r.status).toBe(200); // the request path never notices
      expect(cap.points).toEqual([]);
    }
  });

  it('a THROWING writeDataPoint changes nothing for the client', async () => {
    const id = await makeIdentity();
    const throwing = { writeDataPoint: () => { throw new Error('AE down'); } } as unknown as AnalyticsEngineDataset;
    mockPaidLegs('0');
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(throwing));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { committed: boolean }).committed).toBe(true);
  });
});

describe('upload_outcome matrix — paid-path returns ONLY (L r19/r20)', () => {
  it('idempotent hit emits NO upload_outcome', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    mockPaidLegs('0');
    const first = await worker.fetch((await uploadRequest(id, noteId)).request, metricsEnv(capture().dataset));
    expect(first.status).toBe(200);

    const cap = capture(); // fresh capture: only the second request's events
    const r = await worker.fetch((await uploadRequest(id, noteId)).request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    expect(cap.byEvent('upload_outcome')).toHaveLength(0);
    expect(cap.byEvent('gateway_call')).toHaveLength(0); // and no paid legs either
  });

  it('validation 400 emits nothing', async () => {
    const id = await makeIdentity();
    const cap = capture();
    const { request } = await uploadRequest(id, crypto.randomUUID(), { extraTag: { name: 'Evil', value: 'x' } });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(400);
    expect(cap.points).toEqual([]);
  });

  it('kill switch 503 emits nothing', async () => {
    const id = await makeIdentity();
    const cap = capture();
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset, { UPLOADS_ENABLED: 'false' }));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe('uploads_disabled');
    expect(cap.points).toEqual([]);
  });

  it('quota 429 emits nothing', async () => {
    const id = await makeIdentity();
    const cap = capture();
    const rateLimited = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(JSON.stringify({ status: 'rate_limited' })) }),
    } as unknown as DurableObjectNamespace;
    const { request } = await uploadRequest(id, crypto.randomUUID());
    const r = await worker.fetch(request, metricsEnv(cap.dataset, { RATE_LIMITER: rateLimited }));
    expect(r.status).toBe(429);
    expect(cap.points).toEqual([]);
  });
});

describe('redrop_new_tx: a NEW paid txId after a PROVEN dead — both paths (review PR #105)', () => {
  it('doRedrop path: aged posted anchor + dead status → repost emits EXACTLY ONE redrop_new_tx', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const deadTxId = `TXDEAD${noteId.slice(0, 8)}`;
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteId}`, {
        status: 'posted', token: 'srv-token', gen: 0,
        txId: deadTxId, postedAt: Date.now() - 31 * 60_000,
      });
    });

    const cap = capture();
    mockStatusOnAll(deadTxId, 404, 'not found');
    mockPaidLegs('0');

    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).not.toBe(deadTxId);

    expect(cap.byEvent('redrop_new_tx')).toHaveLength(1);
    expect(cap.byEvent('post_accepted')).toHaveLength(1);
    // One row per configured host plus the aggregated _quorum row.
    expect(cap.byEvent('status_verdict').map(p => [p.blobs?.[1], p.blobs?.[2]]))
      .toEqual([['dead', 'arweave.net'], ['dead', 'g2.test'], ['dead', '_quorum']]);
    expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['accepted']);
  });

  it('recovery-hint path: triple-failure token + dead + age guard → repost emits EXACTLY ONE redrop_new_tx', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const deadTxId = `TXDEAD${noteId.slice(0, 8)}`;
    const postedAt = Date.now() - 31 * 60_000; // past the 30-min age guard
    // Recreate signRecovery: HMAC over `${noteId}:${txId}:${postedAt}` with a
    // key derived from SHA-256(RECOVERY_HMAC_SECRET + ':recovery').
    const secret = (baseEnv as unknown as { RECOVERY_HMAC_SECRET: string }).RECOVERY_HMAC_SECRET;
    const material = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + ':recovery')),
    );
    const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const token = b64(new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${noteId}:${deadTxId}:${postedAt}`)),
    ));

    const cap = capture();
    mockStatusOnAll(deadTxId, 404, 'not found');
    mockPaidLegs('0');

    // The DO has NO record (that is the triple-failure): the fresh reservation
    // reconciles through the recovery hint, proves dead, passes the age guard
    // and re-posts — a new paid txId after a proven dead, same event.
    const { request } = await uploadRequest(id, noteId, {
      recheck: true, recovery: { txId: deadTxId, postedAt, token },
    });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean };
    expect(body.committed).toBe(true);
    expect(body.txId).not.toBe(deadTxId);

    expect(cap.byEvent('redrop_new_tx')).toHaveLength(1);
    expect(cap.byEvent('post_accepted')).toHaveLength(1);
    // One row per configured host plus the aggregated _quorum row.
    expect(cap.byEvent('status_verdict').map(p => [p.blobs?.[1], p.blobs?.[2]]))
      .toEqual([['dead', 'arweave.net'], ['dead', 'g2.test'], ['dead', '_quorum']]);
    expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['accepted']);
  });
});

describe('status leg: per-host metrics + the _quorum row (PR-3a)', () => {
  // PR-3a probes EVERY configured origin, so the status leg now emits one
  // gateway_call and one status_verdict per host, plus ONE aggregated row under
  // the sentinel host `_quorum`. The blob schema is unchanged — only the number
  // of rows and the host values are.
  //
  // The `host` label deliberately stays a BARE hostname ('arweave.net'), not
  // the canonical origin: switching it would split the historical series in two.
  async function seedCommitted(pkB64: string, noteId: string) {
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteId}`, {
        status: 'committed', txId: `TX-${noteId.slice(0, 8)}`, committedAt: Date.now() - 60_000, gen: 0,
      });
    });
    return `TX-${noteId.slice(0, 8)}`;
  }
  const HOSTS = ['arweave.net', 'g2.test'];

  it('valid 200 from every host → alive per host AND on the quorum row', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId);
    const cap = capture();
    mockStatusOnAll(txId, 200,
      JSON.stringify({ block_height: 1500000, block_indep_hash: 'H', number_of_confirmations: 120 }));

    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200); // alive → committed answer unchanged

    expect(cap.byEvent('gateway_call').map(p => [p.blobs?.[1], p.blobs?.[2], p.blobs?.[3]]))
      .toEqual(HOSTS.map(h => ['status', h, '2xx']));
    expect(cap.byEvent('status_verdict').map(p => [p.blobs?.[1], p.blobs?.[2], p.doubles?.[0]]))
      .toEqual([
        ...HOSTS.map(h => ['alive', h, 120]),
        ['alive', '_quorum', 120],
      ]);
    // Privacy: the txId never reaches the datapoints.
    expect(JSON.stringify(cap.points)).not.toContain(txId);
  });

  it('disagreeing 200s put the LOWEST confirmation count on the quorum row', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId);
    const cap = capture();
    mockRoute('GET', statusUrlRe('https://arweave.net', txId), 200,
      JSON.stringify({ block_height: 1500000, number_of_confirmations: 120 }));
    mockRoute('GET', statusUrlRe('https://g2.test', txId), 200,
      JSON.stringify({ block_height: 1499000, number_of_confirmations: 7 }));

    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(200);
    const quorum = cap.byEvent('status_verdict').filter(p => p.blobs?.[2] === '_quorum');
    expect(quorum.map(p => [p.blobs?.[1], p.doubles?.[0]])).toEqual([['alive', 7]]);
  });

  // CHANGED CONTRACT (PR-3a): a 200 whose body fails the schema is no longer
  // "alive with −1". It is a PROTOCOL defect — classified invalid_response, not
  // alive, and for the quorum it is a non-404 outcome. The recheck therefore
  // answers 503 (status unknown) instead of confirming on a body it could not read.
  it('malformed / oversized / non-integer bodies → invalid_response, NOT alive', async () => {
    const id = await makeIdentity();
    const bodies = [
      'garbage not json',
      JSON.stringify({ number_of_confirmations: 'many' }),
      JSON.stringify({ number_of_confirmations: 12.5 }),
      JSON.stringify({ number_of_confirmations: -3 }),
      `{"pad":"${'x'.repeat(2048)}","number_of_confirmations":120}`, // over the 1 KiB cap
    ];
    for (const body of bodies) {
      const noteId = crypto.randomUUID();
      const txId = await seedCommitted(id.pkB64, noteId);
      const cap = capture();
      mockStatusOnAll(txId, 200, body);
      const { request } = await uploadRequest(id, noteId, { recheck: true });
      const r = await worker.fetch(request, metricsEnv(cap.dataset));
      expect(r.status).toBe(503); // status unknown — never confirmed on an unreadable body
      expect(cap.byEvent('gateway_call').map(p => p.blobs?.[3]))
        .toEqual(HOSTS.map(() => 'invalid_response'));
      expect(cap.byEvent('status_verdict').map(p => [p.blobs?.[1], p.blobs?.[2]]))
        .toEqual([
          ...HOSTS.map(h => ['unavailable', h]),
          ['unavailable', '_quorum'],
        ]);
    }
  });

  it('TRUNCATED body stream (connection reset mid-read) → invalid_response', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId);
    const cap = capture();
    mockStatusOnAll(txId, 200, '', {
      makeBody: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"number_of_confirmations":'));
          controller.error(new Error('connection reset'));
        },
      }),
    });

    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(503);
    expect(cap.byEvent('gateway_call').map(p => p.blobs?.[3]))
      .toEqual(HOSTS.map(() => 'invalid_response'));
  });

  it('404 from EVERY host → dead per host and on the quorum row', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId); // committedAt is fresh
    const cap = capture();
    mockStatusOnAll(txId, 404, 'not found');

    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    // dead, but the commit is fresh → the age guard defers the redrop (503).
    expect(r.status).toBe(503);
    expect(cap.byEvent('status_verdict').map(p => [p.blobs?.[1], p.blobs?.[2], p.doubles?.[0]]))
      .toEqual([
        ...HOSTS.map(h => ['dead', h, -1]),
        ['dead', '_quorum', -1],
      ]);
  });

  // The normative example of the formula, at the Worker end: agreeing 404s are
  // not a quorum while another origin is silent — and a false dead is what
  // authorizes a paid re-post.
  it('404 + network failure → unavailable on the quorum row, NOT dead', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId);
    const cap = capture();
    mockRoute('GET', statusUrlRe('https://arweave.net', txId), 404, 'not found');
    // g2.test is left unmocked: the harness throws on an unmocked request,
    // which is exactly the network failure this case is about.
    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(503);
    const quorum = cap.byEvent('status_verdict').filter(p => p.blobs?.[2] === '_quorum');
    expect(quorum.map(p => p.blobs?.[1])).toEqual(['unavailable']);
  });

  // 400 used to be classified dead outright; under the quorum it is an ordinary
  // non-404 outcome and can only ever BLOCK dead.
  it('400 can never produce dead', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const txId = await seedCommitted(id.pkB64, noteId);
    const cap = capture();
    mockStatusOnAll(txId, 400, 'bad request');
    const { request } = await uploadRequest(id, noteId, { recheck: true });
    const r = await worker.fetch(request, metricsEnv(cap.dataset));
    expect(r.status).toBe(503);
    const quorum = cap.byEvent('status_verdict').filter(p => p.blobs?.[2] === '_quorum');
    expect(quorum.map(p => p.blobs?.[1])).toEqual(['unavailable']);
  });
});
