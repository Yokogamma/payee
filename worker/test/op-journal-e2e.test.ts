import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';
import { addressOfJwk } from '../test-stubs/wallet-address';
import { computePublicationFp } from '../src/publication-fp';
import { setupOutboundMock, b64, sha256 } from './helpers/outbound-mock';
import type { OpProjection } from '../src/op-journal';
import uploadCodes from '../src/upload-codes.json';

// The operation journal end to end through the REAL /upload route (plan
// «soak D2 operation journal» v6.1 §9, tests 1–4, 7, 11): admission writes
// `begun` in the DO, every admitted answer is echoed and closed, the paid path
// journals its intent before the send, and every way the journal can fail
// leaves exactly the record the reconciliation expects — never a claim.
//
// Failure injection wraps the REAL RateLimiter namespace: the interceptor
// forwards to the live DO (or not) and may throw AFTER forwarding — that is
// the «transaction committed, response lost» case the plan is built around.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

const { mockRoute } = setupOutboundMock();

const C = 'AAAA';
const IV = 'AAAAAAAAAAAAAAAA'; // 12 bytes
const ANCHOR = 'A'.repeat(64);
const nextIp = () => `opj-${crypto.randomUUID().slice(0, 8)}`;
const VERSION_ID = 'version-under-test';
const RELEASE = 'c'.repeat(40);

let realJwk = '';
let realWalletOwners = '';
beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  realJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
  realWalletOwners = await addressOfJwk(realJwk);
});

type Identity = { priv: Uint8Array; pkB64: string; ownerHash: string };
async function makeIdentity(): Promise<Identity> {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function uploadRequest(
  id: Identity,
  noteId: string,
  opts: { operationId?: unknown; c?: string; recheck?: boolean; tamper?: boolean } = {},
): Promise<Request> {
  const body = JSON.stringify({
    data: JSON.stringify({ id: noteId, c: opts.c ?? C, iv: IV }),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '2' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: noteId },
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    ...(opts.recheck ? { recheck: true } : {}),
    ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': nextIp() },
    body: opts.tamper ? body + ' ' : body,
  });
}

const fpFor = (noteId: string, c = C) => computePublicationFp('2', JSON.stringify({ id: noteId, c, iv: IV }));

type Point = { blobs?: unknown[] };
function capture() {
  const points: Point[] = [];
  const dataset = { writeDataPoint: (p: Point) => { points.push(p); } } as unknown as AnalyticsEngineDataset;
  const byEvent = (event: string) => points.filter(p => p.blobs?.[0] === event);
  return { dataset, byEvent };
}

const mkEnv = (extra: Record<string, unknown> = {}): WorkerEnv => ({
  ...baseEnv, ARWEAVE_JWK: realJwk, TRUSTED_OWNERS: realWalletOwners,
  RELEASE_SHA: RELEASE, CF_VERSION_METADATA: { id: VERSION_ID }, ...extra,
}) as WorkerEnv;

function mockPaidLegs(opts: { anchorDelayMs?: number; post?: false | number } = {}) {
  const anchor = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, ANCHOR, 1, { delayMs: opts.anchorDelayMs });
  const price = mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '3049039377');
  const post = opts.post === false ? null
    : mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, opts.post ?? 200, opts.post && opts.post !== 200 ? 'nope' : 'OK');
  return { anchor, price, post };
}

/** The live journal, read through the real DO — never through the worker. */
async function opGet(pkB64: string, id: string): Promise<OpProjection | null> {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  const r = await stub.fetch('http://do/op-get', { method: 'POST', body: JSON.stringify({ id }) });
  return ((await r.json()) as { op: OpProjection | null }).op;
}
async function reserveStatus(pkB64: string, noteId: string, fp: string): Promise<string> {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  const r = await stub.fetch('http://do/check-and-reserve', { method: 'POST', body: JSON.stringify({ noteId, limit: 20, fp }) });
  return ((await r.json()) as { status: string }).status;
}
/** Seed a committed record under a given fp, directly in the DO. */
async function seedCommitted(pkB64: string, noteId: string, fp: string, txId: string): Promise<void> {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  const r = await stub.fetch('http://do/check-and-reserve', { method: 'POST', body: JSON.stringify({ noteId, limit: 20, fp }) });
  const { token } = (await r.json()) as { token: string };
  await stub.fetch('http://do/commit', { method: 'POST', body: JSON.stringify({ noteId, txId, token }) });
}

type Interceptor = (path: string, body: string, forward: () => Promise<Response>) => Promise<Response>;
/** Wrap the real namespace so a test can drop, fake or observe DO calls. */
function wrapLimiter(interceptor: Interceptor): DurableObjectNamespace {
  return {
    idFromName: (name: string) => RATE_LIMITER.idFromName(name),
    get: (id: DurableObjectId) => {
      const real = RATE_LIMITER.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(input, init);
          const body = await req.clone().text();
          return interceptor(new URL(req.url).pathname, body, () => real.fetch(req));
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

const PRE = new Set(uploadCodes.preAdmission.map(c => `${c.status}:${c.code}`));
const POST = new Set(uploadCodes.postAdmission.map(c => `${c.status}:${c.code}`));

// ─── Happy paths ────────────────────────────────────────────────────

describe('journal: admitted answers are echoed and closed', () => {
  it('a paid publication and its dedupe re-send: two finished records, decision new, attests', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const op1 = crypto.randomUUID();
    mockPaidLegs();

    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: op1 }), mkEnv());
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Operation-Id')).toBe(op1);
    const body = await r.json() as { txId: string; operationId: string; committed: boolean };
    expect(body.operationId).toBe(op1);
    expect(body.committed).toBe(true);
    expect(await opGet(id.pkB64, op1)).toMatchObject({
      id: op1, noteId, requestedFp: await fpFor(noteId), mode: 'plain', declaredVersion: '2', idOrigin: 'client',
      releaseSha: RELEASE, workerVersionId: VERSION_ID,
      status: 'finished', paidResult: 'accepted', outcome: 'accepted', httpStatus: 200,
      decision: 'new', txId: body.txId, checkVerdict: 'ok', checkVerdicts: ['ok'], attests: [],
    });

    const op2 = crypto.randomUUID();
    const d = await worker.fetch(await uploadRequest(id, noteId, { operationId: op2 }), mkEnv());
    expect(d.status).toBe(200);
    expect(d.headers.get('X-Operation-Id')).toBe(op2);
    const dedupe = await d.json() as { txId: string; deduped: boolean; operationId: string };
    expect(dedupe).toMatchObject({ txId: body.txId, deduped: true, operationId: op2 });
    expect(await opGet(id.pkB64, op2)).toMatchObject({
      status: 'finished', paidResult: 'none', outcome: 'deduped', txId: body.txId, checkVerdict: 'exists', attests: ['deduped'],
    });
    expect((await opGet(id.pkB64, op2)) as Record<string, unknown>).not.toHaveProperty('decision');
  });

  it('an older client without operationId gets a server-minted id, journaled as idOrigin server', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    await seedCommitted(id.pkB64, noteId, await fpFor(noteId), 'T'.repeat(43));
    const r = await worker.fetch(await uploadRequest(id, noteId), mkEnv());
    expect(r.status).toBe(200);
    const echoed = r.headers.get('X-Operation-Id')!;
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect((await r.json() as { operationId: string }).operationId).toBe(echoed);
    expect(await opGet(id.pkB64, echoed)).toMatchObject({ idOrigin: 'server', outcome: 'deduped', status: 'finished' });
  });

  it('a present but malformed operationId is a validation failure, before admission (no echo, no record)', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: 'not-a-uuid' }), mkEnv());
    expect(r.status).toBe(400);
    expect(r.headers.get('X-Operation-Id')).toBeNull();
    expect(await r.json()).toMatchObject({ code: 'validation_failed' });
  });
});

// ─── The begin ──────────────────────────────────────────────────────

describe('journal: begin (tests 1, 2, 2b, 2c, 2d)', () => {
  it('1: the DO answers without taking the operation → 503 audit_unavailable, no echo, no paid attempt', async () => {
    const id = await makeIdentity();
    const limiter = wrapLimiter(async (path) => {
      if (path === '/check-and-reserve') return Response.json({ status: 'ok', token: 'fake' }); // no opAccepted
      throw new Error(`unexpected DO call ${path}`);
    });
    // No outbound routes: had the paid path run, the unmocked fetch would throw.
    const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: crypto.randomUUID() }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(r.headers.get('X-Operation-Id')).toBeNull();
    expect(await r.json()).toMatchObject({ code: 'audit_unavailable' });
  });

  it('2: the DO call throws before any transaction → 503 audit_unconfirmed with the id in the body only, and NO further DO call', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const calls: string[] = [];
    const limiter = wrapLimiter(async (path) => { calls.push(path); throw new Error('DO unreachable'); });
    const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(r.headers.get('X-Operation-Id')).toBeNull();
    expect(await r.json()).toMatchObject({ code: 'audit_unconfirmed', operationId: opId });
    expect(calls).toEqual(['/check-and-reserve']);
    expect(await opGet(id.pkB64, opId)).toBeNull();
  });

  it('2b: transaction committed, response lost → the begun record exists with the verdict; the worker touches nothing else', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const calls: string[] = [];
    const limiter = wrapLimiter(async (path, _body, forward) => {
      calls.push(path);
      await forward(); // the DO did its work
      throw new Error('response lost');
    });
    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(r.headers.get('X-Operation-Id')).toBeNull();
    expect(await r.json()).toMatchObject({ code: 'audit_unconfirmed', operationId: opId });
    expect(calls).toEqual(['/check-and-reserve']);
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'begun', paidResult: 'none', checkVerdict: 'ok', noteId });
    // The reservation the DO made is still there (it expires by TTL).
    expect(await reserveStatus(id.pkB64, noteId, await fpFor(noteId))).toBe('reserved');
  });

  it('2c: the same loss over a conflicting record keeps the DO verdict id_payload_conflict on the begun record', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    await seedCommitted(id.pkB64, noteId, await fpFor(noteId, 'BBBB'), 'S'.repeat(43));
    const limiter = wrapLimiter(async (_path, _body, forward) => { await forward(); throw new Error('response lost'); });
    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'begun', checkVerdict: 'id_payload_conflict', checkVerdicts: ['id_payload_conflict'] });
  });

  it('2d: a repeat with the same id against a RUNNING call cannot touch it: B is refused (lost), A completes', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    let checkCalls = 0;
    let bWindow = false;
    const callsInB: string[] = [];
    const limiter = wrapLimiter(async (path, _body, forward) => {
      if (bWindow) callsInB.push(path);
      if (path === '/check-and-reserve') {
        checkCalls += 1;
        if (checkCalls === 2) { await forward(); throw new Error('response to B lost'); }
      }
      return forward();
    });
    const envB = mkEnv({ RATE_LIMITER: limiter });
    mockPaidLegs({ anchorDelayMs: 300 }); // A pauses AFTER begin, BEFORE /op-posting

    const a = worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), envB);
    await new Promise(res => setTimeout(res, 60));
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'begun' });

    bWindow = true;
    const b = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), envB);
    bWindow = false;
    expect(b.status).toBe(503);
    expect(b.headers.get('X-Operation-Id')).toBeNull();
    expect(await b.json()).toMatchObject({ code: 'audit_unconfirmed', operationId: opId });
    expect(callsInB).toEqual(['/check-and-reserve']);
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'begun' }); // untouched by B

    const ra = await a;
    expect(ra.status).toBe(200);
    expect(ra.headers.get('X-Operation-Id')).toBe(opId);
    const body = await ra.json() as { txId: string };
    expect(await opGet(id.pkB64, opId)).toMatchObject({
      status: 'finished', outcome: 'accepted', paidResult: 'accepted', decision: 'new', txId: body.txId,
    });
  });

  it('6: two concurrent requests for ONE note under DIFFERENT ids → two records, both finished, none begun', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const opA = crypto.randomUUID();
    const opB = crypto.randomUUID();
    mockPaidLegs({ anchorDelayMs: 200 }); // A holds the reservation while B arrives
    const a = worker.fetch(await uploadRequest(id, noteId, { operationId: opA }), mkEnv());
    await new Promise(res => setTimeout(res, 40));
    const rb = await worker.fetch(await uploadRequest(id, noteId, { operationId: opB }), mkEnv());
    expect(rb.status).toBe(409);
    expect(rb.headers.get('X-Operation-Id')).toBe(opB);
    expect(await rb.json()).toMatchObject({ code: 'upload_in_progress', operationId: opB });
    const ra = await a;
    expect(ra.status).toBe(200);
    const recA = await opGet(id.pkB64, opA);
    const recB = await opGet(id.pkB64, opB);
    expect(recA).toMatchObject({ status: 'finished', outcome: 'accepted', paidResult: 'accepted' });
    expect(recB).toMatchObject({ status: 'finished', outcome: 'in_progress', paidResult: 'none', checkVerdict: 'reserved' });
    expect(recA!.id).not.toBe(recB!.id);
  });

  it('a repeated id AFTER the operation finished is refused with operation_id_reused and no echo', async () => {
    const id = await makeIdentity();
    const noteId = crypto.randomUUID();
    const opId = crypto.randomUUID();
    await seedCommitted(id.pkB64, noteId, await fpFor(noteId), 'R'.repeat(43));
    expect((await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv())).status).toBe(200);
    const before = JSON.stringify(await opGet(id.pkB64, opId));
    const again = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv());
    expect(again.status).toBe(409);
    expect(again.headers.get('X-Operation-Id')).toBeNull();
    expect(await again.json()).toMatchObject({ code: 'operation_id_reused' });
    expect(JSON.stringify(await opGet(id.pkB64, opId))).toBe(before);
  });
});

// ─── The paid path ──────────────────────────────────────────────────

describe('journal: the paid path (tests 3, 3b, 4, 7)', () => {
  it('3: finish lost after an accepted POST → 200 with txId and echo; the record stays posting/unknown with the txId; a re-send dedupes', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const limiter = wrapLimiter(async (path, _body, forward) => {
      if (path === '/op-finish') throw new Error('finish lost');
      return forward();
    });
    mockPaidLegs();
    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Operation-Id')).toBe(opId);
    const body = await r.json() as { txId: string; committed: boolean; operationId: string };
    expect(body.committed).toBe(true);
    expect(body.operationId).toBe(opId);
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'posting', paidResult: 'unknown', txId: body.txId, decision: 'new' });
    // No second payment: the same bytes dedupe onto the same txId.
    const op2 = crypto.randomUUID();
    const d = await worker.fetch(await uploadRequest(id, noteId, { operationId: op2 }), mkEnv());
    expect(d.status).toBe(200);
    expect(await d.json()).toMatchObject({ txId: body.txId, deduped: true });
  });

  it('3b(i): /op-posting committed but the answer lost → NO POST, abort with the token, 503 audit_unconfirmed with echo, record audit_aborted', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const calls: string[] = [];
    const limiter = wrapLimiter(async (path, _body, forward) => {
      calls.push(path);
      if (path === '/op-posting') { await forward(); throw new Error('answer lost'); }
      return forward();
    });
    mockPaidLegs({ post: false }); // a POST would hit an unmocked route and throw → not what we assert
    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(r.headers.get('X-Operation-Id')).toBe(opId);
    expect(await r.json()).toMatchObject({ code: 'audit_unconfirmed', operationId: opId });
    expect(calls.filter(p => p === '/op-abort')).toHaveLength(1);
    expect(calls.indexOf('/op-abort')).toBeGreaterThan(calls.indexOf('/op-posting'));
    expect(await opGet(id.pkB64, opId)).toMatchObject({
      status: 'finished', outcome: 'audit_aborted', paidResult: 'none', code: 'audit_unconfirmed', httpStatus: 503, decision: 'new',
    });
    expect((await opGet(id.pkB64, opId))!.txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Reservation released: the note can be retried.
    expect(await reserveStatus(id.pkB64, noteId, await fpFor(noteId))).toBe('ok');
  });

  it('3b(ii): /op-posting throws before any transaction → NO POST, record closes as audit_unconfirmed from begun', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const limiter = wrapLimiter(async (path, _body, forward) => {
      if (path === '/op-posting') throw new Error('DO down');
      return forward();
    });
    mockPaidLegs({ post: false });
    const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'audit_unconfirmed', operationId: opId });
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'finished', outcome: 'audit_unconfirmed', paidResult: 'none' });
  });

  it('3b(iii): the DO refuses /op-posting → NO POST, 503 audit_unavailable with echo', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const limiter = wrapLimiter(async (path, _body, forward) => {
      if (path === '/op-posting') return Response.json({ ok: false, reason: 'injected' });
      return forward();
    });
    mockPaidLegs({ post: false });
    const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }), mkEnv({ RATE_LIMITER: limiter }));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'audit_unavailable', operationId: opId });
    expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'finished', outcome: 'audit_unavailable', paidResult: 'none' });
  });

  it('4: the POST throws → 502 arweave_post_unknown with echo and txId; record finished/unknown keeps txId and decision', async () => {
    const id = await makeIdentity();
    const opId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const cap = capture();
    mockPaidLegs({ post: false }); // the unmocked POST throws inside the SDK
    const r = await worker.fetch(await uploadRequest(id, noteId, { operationId: opId }), mkEnv({ METRICS_ENABLED: 'true', METRICS: cap.dataset }));
    expect(r.status).toBe(502);
    expect(r.headers.get('X-Operation-Id')).toBe(opId);
    const body = await r.json() as { code: string; txId: string; operationId: string };
    expect(body).toMatchObject({ code: 'arweave_post_unknown', operationId: opId });
    expect(body.txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await opGet(id.pkB64, opId)).toMatchObject({
      status: 'finished', outcome: 'post_unknown', paidResult: 'unknown', txId: body.txId, decision: 'new', code: 'arweave_post_unknown', httpStatus: 502,
    });
    expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['post_unknown']);
    expect(await reserveStatus(id.pkB64, noteId, await fpFor(noteId))).toBe('ok'); // released, as before
  });

  it('7: prepare throw → arweave_internal / arweave_throw; anchor throw → arweave_gateway_unavailable; POST 400 → arweave_rejected', async () => {
    const id = await makeIdentity();
    // prepare: a broken JWK, zero outbound calls
    {
      const opId = crypto.randomUUID();
      const cap = capture();
      const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }),
        mkEnv({ ARWEAVE_JWK: '{}', METRICS_ENABLED: 'true', METRICS: cap.dataset }));
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: 'arweave_internal', operationId: opId });
      expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'finished', outcome: 'arweave_throw', paidResult: 'none' });
      expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['arweave_throw']);
    }
    // anchor: no route → the GET throws in the anchor_price phase
    {
      const opId = crypto.randomUUID();
      const cap = capture();
      const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }),
        mkEnv({ METRICS_ENABLED: 'true', METRICS: cap.dataset }));
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: 'arweave_gateway_unavailable', operationId: opId });
      expect(await opGet(id.pkB64, opId)).toMatchObject({ status: 'finished', outcome: 'gateway_unavailable_pre_post', paidResult: 'none' });
      expect((await opGet(id.pkB64, opId)) as Record<string, unknown>).not.toHaveProperty('txId');
      expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['gateway_unavailable_pre_post']);
    }
    // post rejected: the gateway answered, and said no
    {
      const opId = crypto.randomUUID();
      const cap = capture();
      mockPaidLegs({ post: 400 });
      const r = await worker.fetch(await uploadRequest(id, crypto.randomUUID(), { operationId: opId }),
        mkEnv({ METRICS_ENABLED: 'true', METRICS: cap.dataset }));
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: 'arweave_rejected', operationId: opId });
      const rec = await opGet(id.pkB64, opId);
      expect(rec).toMatchObject({ status: 'finished', outcome: 'arweave_error', paidResult: 'rejected', decision: 'new' });
      expect(rec!.txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cap.byEvent('upload_outcome').map(p => p.blobs?.[1])).toEqual(['arweave_error']);
    }
  });
});

// ─── Echo and codes ─────────────────────────────────────────────────

describe('journal: the echo marks admission, the codes are closed lists (test 11)', () => {
  it('post-admission refusals carry the echo and a postAdmission code', async () => {
    const id = await makeIdentity();
    // conflict: same id, different bytes
    const noteId = crypto.randomUUID();
    await seedCommitted(id.pkB64, noteId, await fpFor(noteId, 'BBBB'), 'S'.repeat(43));
    const opC = crypto.randomUUID();
    const c = await worker.fetch(await uploadRequest(id, noteId, { operationId: opC }), mkEnv());
    expect(c.status).toBe(409);
    expect(c.headers.get('X-Operation-Id')).toBe(opC);
    const cb = await c.json() as { code: string; operationId: string; txId: string };
    expect(cb).toMatchObject({ code: 'id_payload_conflict', operationId: opC, txId: 'S'.repeat(43) });
    expect(POST.has(`409:${cb.code}`)).toBe(true);
    expect(await opGet(id.pkB64, opC)).toMatchObject({ status: 'finished', outcome: 'conflict', txId: 'S'.repeat(43), attests: ['conflict'], checkVerdict: 'id_payload_conflict' });

    // in progress: a live reservation held by someone else
    const note2 = crypto.randomUUID();
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await stub.fetch('http://do/check-and-reserve', { method: 'POST', body: JSON.stringify({ noteId: note2, limit: 20, fp: await fpFor(note2) }) });
    const opP = crypto.randomUUID();
    const p = await worker.fetch(await uploadRequest(id, note2, { operationId: opP }), mkEnv());
    expect(p.status).toBe(409);
    expect(p.headers.get('X-Operation-Id')).toBe(opP);
    const pb = await p.json() as { code: string };
    expect(pb.code).toBe('upload_in_progress');
    expect(await opGet(id.pkB64, opP)).toMatchObject({ status: 'finished', outcome: 'in_progress', httpStatus: 409, code: 'upload_in_progress' });
  });

  it('pre-admission refusals carry NO echo and a preAdmission code; nothing is journaled', async () => {
    const id = await makeIdentity();
    const cases: Array<[Request, number, string]> = [
      [await uploadRequest(id, crypto.randomUUID(), { operationId: crypto.randomUUID(), tamper: true }), 401, 'auth_failed'],
      [await uploadRequest(id, 'not-a-uuid', { operationId: crypto.randomUUID() }), 400, 'validation_failed'],
    ];
    const stranger = { ...id, pkB64: id.pkB64 };
    void stranger;
    for (const [req, status, code] of cases) {
      const r = await worker.fetch(req, mkEnv());
      expect(r.status).toBe(status);
      expect(r.headers.get('X-Operation-Id')).toBeNull();
      const body = await r.json() as { code: string; error: string; operationId?: string };
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe('string');
      expect(body.operationId).toBeUndefined();
      expect(PRE.has(`${status}:${code}`)).toBe(true);
    }
    // not registered
    const unknown = await (async () => {
      const priv = ed.utils.randomSecretKey();
      const pub = await ed.getPublicKeyAsync(priv);
      return { priv, pkB64: b64(pub), ownerHash: b64(await sha256(pub)) };
    })();
    const opId = crypto.randomUUID();
    const r = await worker.fetch(await uploadRequest(unknown, crypto.randomUUID(), { operationId: opId }), mkEnv());
    expect(r.status).toBe(403);
    expect(r.headers.get('X-Operation-Id')).toBeNull();
    expect(await r.json()).toMatchObject({ code: 'not_registered' });
    expect(await opGet(unknown.pkB64, opId)).toBeNull();
    // kill switch, 415
    const off = await worker.fetch(await uploadRequest(id, crypto.randomUUID()), mkEnv({ UPLOADS_ENABLED: 'false' }));
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: 'uploads_disabled' });
    const bad = await worker.fetch(new Request('https://proxy.example.com/upload', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': nextIp() }, body: 'x',
    }), mkEnv());
    expect(bad.status).toBe(415);
    expect(await bad.json()).toMatchObject({ code: 'unsupported_media_type' });
  });
});
