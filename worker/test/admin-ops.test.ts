import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import type { OpBegin, OpProjection } from '../src/op-journal';

// POST /admin/ops — the journal's read-only projection (plan v6.1 §4, test 9):
// same bearer and ordering as /admin/metrics, validated inputs, a time slice
// with a cursor or a point read, the worker's identity on every answer, never
// the reservation token, no-store on every answer of the path.

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;

const SECRET = 'ops-admin-secret-test';
const AUTH = `Bearer ${SECRET}`;
const VERSION_ID = 'ops-version-under-test';
const RELEASE = 'd'.repeat(40);

const configuredEnv = (extra: Record<string, unknown> = {}): WorkerEnv => ({
  ...baseEnv, METRICS_ADMIN_SECRET: SECRET, RELEASE_SHA: RELEASE, CF_VERSION_METADATA: { id: VERSION_ID }, ...extra,
}) as WorkerEnv;

function req(body: unknown, opts: { auth?: string | null; rawBody?: string } = {}): Request {
  return new Request('https://proxy.example.com/admin/ops', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.auth === null ? {} : { Authorization: opts.auth ?? AUTH }),
    },
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

/** A canonical 32-byte key, base64 — the journal is addressed by it. */
const ownerPk = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

async function seedOps(pk: string, n: number): Promise<{ ids: string[]; t0: number; t1: number; token: string }> {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pk));
  const ids: string[] = [];
  const t0 = Date.now();
  let token = '';
  for (let i = 0; i < n; i++) {
    const op: OpBegin = {
      id: crypto.randomUUID(), mode: 'plain', declaredVersion: '2', releaseSha: RELEASE, workerVersionId: VERSION_ID, idOrigin: 'client',
    };
    ids.push(op.id);
    const r = await stub.fetch('http://do/check-and-reserve', {
      method: 'POST', body: JSON.stringify({ noteId: `n${i}`, limit: 20, fp: 'a'.repeat(64), op }),
    });
    token = ((await r.json()) as { token: string }).token;
  }
  return { ids, t0, t1: Date.now(), token };
}

describe('auth and config order', () => {
  it('503 without METRICS_ADMIN_SECRET, 401 with a bad bearer, 401 without one', async () => {
    const pk = ownerPk();
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }), configuredEnv({ METRICS_ADMIN_SECRET: undefined }))).status).toBe(503);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }, { auth: 'Bearer nope' }), configuredEnv())).status).toBe(401);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }, { auth: null }), configuredEnv())).status).toBe(401);
  });

  it('every answer on the path is no-store', async () => {
    const pk = ownerPk();
    for (const r of [
      await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }, { auth: null }), configuredEnv()),
      await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }), configuredEnv()),
      await worker.fetch(req({ ownerPk: 'bad' }), configuredEnv()),
    ]) {
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});

describe('validation', () => {
  it('400 for a bad body, a non-canonical ownerPk, a bad range, a bad limit, a bad operationId', async () => {
    const pk = ownerPk();
    expect((await worker.fetch(req(null, { rawBody: '{' }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req([]), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: 'not-a-key', from: 0, to: 1 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk }), configuredEnv())).status).toBe(400); // neither operationId nor range
    expect((await worker.fetch(req({ ownerPk: pk, from: 10, to: 5 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 15 * 24 * 3_600_000 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1, limit: 0 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1, limit: 501 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1, cursor: 5 }), configuredEnv())).status).toBe(400);
    expect((await worker.fetch(req({ ownerPk: pk, operationId: 'nope' }), configuredEnv())).status).toBe(400);
  });
});

describe('reading the journal', () => {
  it('lists a time slice with a cursor, stamps the worker identity, never the token', async () => {
    const pk = ownerPk();
    const { ids, t0, t1 } = await seedOps(pk, 5);
    const page1 = await (await worker.fetch(req({ ownerPk: pk, from: t0 - 1000, to: t1 + 1000, limit: 3 }), configuredEnv())).json() as {
      workerVersionId: string; releaseSha: string; ops: OpProjection[]; cursor: string | null;
    };
    expect(page1.workerVersionId).toBe(VERSION_ID);
    expect(page1.releaseSha).toBe(RELEASE);
    expect(page1.ops).toHaveLength(3);
    expect(page1.cursor).toEqual(expect.any(String));
    const page2 = await (await worker.fetch(req({ ownerPk: pk, from: t0 - 1000, to: t1 + 1000, limit: 3, cursor: page1.cursor }), configuredEnv())).json() as {
      ops: OpProjection[]; cursor: string | null;
    };
    expect(page2.ops).toHaveLength(2);
    expect(page2.cursor).toBeNull();
    const all = [...page1.ops, ...page2.ops];
    expect(all.map(o => o.id).sort()).toEqual([...ids].sort());
    for (const o of all) {
      expect(o).not.toHaveProperty('token');
      expect(o).toMatchObject({ status: 'begun', checkVerdict: 'ok', workerVersionId: VERSION_ID });
    }
    // Default limit applies; out-of-range slice is empty.
    const dflt = await (await worker.fetch(req({ ownerPk: pk, from: t0 - 1000, to: t1 + 1000 }), configuredEnv())).json() as { ops: OpProjection[] };
    expect(dflt.ops).toHaveLength(5);
    const none = await (await worker.fetch(req({ ownerPk: pk, from: t0 - 9000, to: t0 - 5000 }), configuredEnv())).json() as { ops: OpProjection[] };
    expect(none.ops).toEqual([]);
  });

  it('reads one record by operationId, null for an unknown one — and a posting record still hides its token', async () => {
    const pk = ownerPk();
    const { ids, token } = await seedOps(pk, 1);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pk));
    await stub.fetch('http://do/op-posting', { method: 'POST', body: JSON.stringify({ id: ids[0], token, txId: 'X'.repeat(43), decision: 'new' }) });
    const one = await (await worker.fetch(req({ ownerPk: pk, operationId: ids[0] }), configuredEnv())).json() as {
      workerVersionId: string; op: OpProjection | null;
    };
    expect(one.workerVersionId).toBe(VERSION_ID);
    expect(one.op).toMatchObject({ id: ids[0], status: 'posting', paidResult: 'unknown', txId: 'X'.repeat(43) });
    expect(one.op).not.toHaveProperty('token');
    const missing = await (await worker.fetch(req({ ownerPk: pk, operationId: crypto.randomUUID() }), configuredEnv())).json() as { op: OpProjection | null };
    expect(missing.op).toBeNull();
  });

  it('503 when the journal DO is unreachable; nothing is written by reads', async () => {
    const failing = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => { throw new Error('DO down'); } }),
    } as unknown as DurableObjectNamespace;
    const pk = ownerPk();
    expect((await worker.fetch(req({ ownerPk: pk, from: 0, to: 1 }), configuredEnv({ RATE_LIMITER: failing }))).status).toBe(503);
    expect((await worker.fetch(req({ ownerPk: pk, operationId: crypto.randomUUID() }), configuredEnv({ RATE_LIMITER: failing }))).status).toBe(503);
  });
});
