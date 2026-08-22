import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';
import { setupOutboundMock, b64, sha256 } from './helpers/outbound-mock';

// Direct-dispatch suite (env-override) for the v4 upload kill switch and the
// v4 committed-idempotency e2e. Same pattern as v3-gate-e2e.test.ts: SELF gets
// its own env copy, so gate/JWK overrides must go through worker.fetch directly.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

const { mockRoute } = setupOutboundMock();

const MC = 'AAAAAAAA';
const SC = 'BBBBBBBB';
const IV = 'AAAAAAAAAAAAAAAA'; // 12 bytes

function uuidV8(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function makeIdentity() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

async function versionedRequest(
  id: { priv: Uint8Array; pkB64: string; ownerHash: string },
  noteId: string,
  ip: string,
  version: '3' | '4' = '4',
): Promise<Request> {
  const tags = [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: version },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: id.ownerHash },
    { name: 'Note-Id', value: noteId },
  ];
  const dataObj = version === '4'
    ? { id: noteId, mc: MC, miv: IV, sc: SC, siv: IV }
    : { id: noteId, c: MC, iv: IV };
  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags,
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

const nextIp = () => `v4g-${crypto.randomUUID().slice(0, 8)}`;

describe('/health capability surface (v4)', () => {
  it('reports v4 in versions and the live gate state, independently of v3', async () => {
    const rOn = await worker.fetch(new Request('https://proxy.example.com/health'), baseEnv);
    const bOn = await rOn.json() as { ok: boolean; versions: string[]; v3Uploads: boolean; v4Uploads: boolean };
    expect(bOn.ok).toBe(true);
    expect(bOn.versions).toEqual(['1', '2', '3', '4']);
    expect(bOn.v4Uploads).toBe(true); // wrangler.toml vars: V4_UPLOADS_ENABLED="true"

    // The two switches are independent: v4 off must not read as v3 off.
    const rOff = await worker.fetch(
      new Request('https://proxy.example.com/health'),
      { ...baseEnv, V4_UPLOADS_ENABLED: 'false' },
    );
    const bOff = await rOff.json() as { versions: string[]; v3Uploads: boolean; v4Uploads: boolean };
    expect(bOff.v4Uploads).toBe(false);
    expect(bOff.v3Uploads).toBe(true);
    // `versions` describes the ACCEPTOR and still contains '4' while the gate
    // is off — a client that resumed on `versions` alone would burst uploads.
    expect(bOff.versions).toContain('4');
  });
});

describe('v4 upload kill switch (V4_UPLOADS_ENABLED)', () => {
  // No outbound routes are registered in these tests: any Arweave attempt would
  // throw in the post path and surface as 502 — a 503 with the machine code
  // proves the request never reached the paid path.
  const gateOff = { ...baseEnv, V4_UPLOADS_ENABLED: 'false' };

  it('503s a valid signed v4 upload with the machine-readable code, before the per-owner DO', async () => {
    const id = await makeIdentity();

    let ownerDoCalls = 0;
    const countingLimiter = {
      idFromName: (name: string) => RATE_LIMITER.idFromName(name),
      get: () => ({ fetch: async () => { ownerDoCalls++; throw new Error('must not be called'); } }),
    } as unknown as DurableObjectNamespace;

    const r = await worker.fetch(
      await versionedRequest(id, uuidV8(), nextIp()),
      { ...gateOff, RATE_LIMITER: countingLimiter },
    );
    expect(r.status).toBe(503);
    expect(r.headers.get('Content-Type')).toBe('application/json');
    const body = await r.json() as { code: string };
    expect(body.code).toBe('v4_uploads_disabled');
    expect(ownerDoCalls).toBe(0);
  });

  it('fails CLOSED when the var is missing or garbage', async () => {
    const id = await makeIdentity();
    const missingEnv = { ...baseEnv } as Record<string, unknown>;
    delete missingEnv.V4_UPLOADS_ENABLED;

    const rMissing = await worker.fetch(
      await versionedRequest(id, uuidV8(), nextIp()), missingEnv as WorkerEnv,
    );
    expect(rMissing.status).toBe(503);
    expect(((await rMissing.json()) as { code: string }).code).toBe('v4_uploads_disabled');

    const rGarbage = await worker.fetch(
      await versionedRequest(id, uuidV8(), nextIp()),
      { ...baseEnv, V4_UPLOADS_ENABLED: 'yes' },
    );
    expect(rGarbage.status).toBe(503);
  });

  it('pauses even committed reconciliation — the DO record stays untouched', async () => {
    const id = await makeIdentity();
    const noteId = uuidV8();

    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    const committedRecord = {
      status: 'committed', txId: 'TX-COMMITTED-V4', committedAt: Date.now() - 60 * 60_000, gen: 0,
    };
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteId}`, committedRecord);
    });

    const r = await worker.fetch(await versionedRequest(id, noteId, nextIp()), gateOff);
    expect(r.status).toBe(503);

    const rec = await runInDurableObject(stub, async (_i, state) =>
      state.storage.get<typeof committedRecord>(`note:${noteId}`));
    expect(rec).toEqual(committedRecord);
  });

  it('leaves v3 uploads untouched while the v4 gate is off (502 at Arweave stub)', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(await versionedRequest(id, uuidV8(), nextIp(), '3'), gateOff);
    expect(r.status).toBe(502); // passed validation + gates, failed at stub JWK
  });

  it('leaves v4 uploads untouched while the V3 gate is off', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(
      await versionedRequest(id, uuidV8(), nextIp(), '4'),
      { ...baseEnv, V3_UPLOADS_ENABLED: 'false' },
    );
    expect(r.status).toBe(502);
  });
});

describe('v4 e2e idempotency (committed): exactly one paid POST', () => {
  it('repeat upload of the same entryId returns the same txId without a second POST', async () => {
    const id = await makeIdentity();
    const noteId = uuidV8();

    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keyPair.privateKey));
    const envWithJwk = { ...baseEnv, ARWEAVE_JWK: jwk };

    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, 'A'.repeat(43));
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');
    const postTx = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');

    const r1 = await worker.fetch(await versionedRequest(id, noteId, nextIp()), envWithJwk);
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as { txId: string; status: string; committed: boolean };
    expect(b1.status).toBe('accepted');
    expect(b1.committed).toBe(true);

    const r2 = await worker.fetch(await versionedRequest(id, noteId, nextIp()), envWithJwk);
    expect(r2.status).toBe(200);
    const b2 = await r2.json() as { txId: string; committed: boolean };
    expect(b2.txId).toBe(b1.txId);
    expect(b2.committed).toBe(true);

    expect(postTx.calls).toBe(1); // the financial invariant
  });
});
