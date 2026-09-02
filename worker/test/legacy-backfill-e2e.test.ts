import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';
import { setupOutboundMock, b64, sha256 } from './helpers/outbound-mock';
import { addressOfJwk } from '../test-stubs/wallet-address';
// The signing harness PR-3a built for the client's D9 suite: real RSA
// signatures, real deep-hash, real data_root. A hand-rolled stub could not
// produce a transaction the verifier accepts, which is the point.
import { buildSignedTx, notesTags, newWallet, testWallet } from '../../src/test-stubs/signed-tx';
import { computePublicationFp } from '../src/publication-fp';

/**
 * The LEGACY path end to end: a record written before semantic idempotency
 * existed, so its bytes were never fingerprinted.
 *
 * The DO cannot answer for such a record — proving what the transaction
 * actually contains needs network I/O, which a Durable Object must not perform
 * while holding its input gate. So it hands out a snapshot, the top-level
 * worker runs D9, and the result comes back through /backfill-fp under a
 * compare-and-swap. These tests drive that whole loop through /upload.
 */

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;
const baseEnv = env as unknown as Record<string, unknown>;

const { mockRoute } = setupOutboundMock();

// RSA-4096 keygen for the harness wallets runs ONCE per process and is paid by
// whichever test asks first — under CPU contention (a parallel client suite)
// that first test blew the default 5 s timeout. Pay it here, explicitly, with
// a budget that says what it is.
beforeAll(async () => { await testWallet(); await newWallet(); }, 60_000);

const NOTE_ID = '33333333-4444-4555-8666-777777777777';
const C = 'AAAAAAAAAAAAAAAAAAAAAA==';
const IV = 'AAAAAAAAAAAAAAAA';
const VERSION = '2';
const G1 = 'https://arweave.net';

/** Exactly what the request below publishes. */
const dataFor = (noteId: string) => JSON.stringify({ id: noteId, c: C, iv: IV });

let identity: { priv: Uint8Array; pkB64: string; ownerHash: string };

beforeAll(async () => {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  identity = { priv, pkB64, ownerHash };
});

async function uploadRequest(noteId: string, ip: string): Promise<Request> {
  const body = JSON.stringify({
    data: dataFor(noteId),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: VERSION },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: identity.ownerHash },
      { name: 'Note-Id', value: noteId },
    ],
    ownerHash: identity.ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), identity.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': identity.pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': ip,
    },
    body,
  });
}

/** Seed a committed record with NO fp — i.e. written before D2. */
async function seedLegacyCommitted(noteId: string, txId: string) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(identity.pkB64));
  await runInDurableObject(stub, async (_i, state) => {
    await state.storage.put(`note:${noteId}`, {
      status: 'committed', token: 'legacy-token', gen: 0, txId,
      committedAt: Date.now() - 60 * 60_000,
    });
  });
}

async function storedFp(noteId: string): Promise<string | undefined> {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(identity.pkB64));
  return runInDurableObject(stub, async (_i, state) =>
    (await state.storage.get<{ fp?: string }>(`note:${noteId}`))?.fp);
}

/** Serve a real signed transaction from the payload pool. The raw body is
 *  BYTES, so it goes through `makeBody` rather than the string field. */
function serveTx(tx: { txId: string; header: Record<string, unknown>; bytes: Uint8Array }) {
  mockRoute('GET', new RegExp(`^${G1}/tx/${tx.txId}$`), 200, JSON.stringify(tx.header));
  mockRoute('GET', new RegExp(`^${G1}/raw/${tx.txId}$`), 200, '', 1, { makeBody: () => tx.bytes });
}

/** Analytics Engine capture, so each legacy outcome can be asserted as the
 *  soak metric it becomes. */
type Point = { blobs?: string[]; doubles?: number[]; indexes?: string[] };
function capture() {
  const points: Point[] = [];
  const dataset = { writeDataPoint: (p: Point) => { points.push(p); } };
  const outcomes = () => points
    .filter(p => p.blobs?.[0] === 'semantic_idempotency')
    .map(p => p.blobs?.[1]);
  return { dataset, outcomes };
}

/**
 * env with a single-origin payload pool and BOTH wallets trusted:
 *  - the harness wallet, because it signed the publication D9 must accept;
 *  - the worker's own signing wallet, because /upload refuses while that one is
 *    outside the set (it would otherwise 503 before reaching this path).
 */
async function envFor(cap?: ReturnType<typeof capture>): Promise<Record<string, unknown>> {
  const publisher = await testWallet();
  const signer = await addressOfJwk(String(baseEnv.ARWEAVE_JWK));
  return {
    ...baseEnv,
    TRUSTED_OWNERS: `${signer},${publisher.address}`,
    PAYLOAD_GATEWAYS: G1,
    ...(cap ? { METRICS_ENABLED: 'true', METRICS: cap.dataset } : {}),
  };
}

describe('a legacy record whose publication IS the payload being sent', () => {
  it('backfills the fingerprint and answers the dedupe', async () => {
    const noteId = NOTE_ID;
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    serveTx(tx);
    const cap = capture();

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-1'), await envFor(cap) as never);

    expect(r.status).toBe(200);
    // One proof, then one dedupe on the re-check — in that order.
    expect(cap.outcomes()).toEqual(['legacy_backfilled', 'deduped']);
    const body = await r.json() as { txId: string; committed: boolean; deduped?: boolean };
    expect(body.txId).toBe(tx.txId);
    expect(body.committed).toBe(true);
    expect(body.deduped).toBe(true);

    // The proof was expensive, so its RESULT is kept: the record is no longer
    // legacy and the next request compares without any network at all.
    expect(await storedFp(noteId)).toBe(await computePublicationFp(VERSION, dataFor(noteId)));
  });

  it('does not repeat the verification on the next request', async () => {
    const noteId = '33333333-4444-4555-8666-777777777aaa';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    serveTx(tx);
    await worker.fetch(await uploadRequest(noteId, 'lb-2a'), await envFor() as never);

    // No routes are registered for the second pass. If it tried to verify
    // again the fetch would fail and the answer would be a 503.
    const r = await worker.fetch(await uploadRequest(noteId, 'lb-2b'), await envFor() as never);
    expect(r.status).toBe(200);
    expect((await r.json() as { deduped?: boolean }).deduped).toBe(true);
  });
});

describe('a legacy record whose publication is something ELSE', () => {
  it('answers a typed conflict and never hands back the historical txId', async () => {
    const noteId = '33333333-4444-4555-8666-777777777bbb';
    const wallet = await testWallet();
    // The transaction on chain carries DIFFERENT bytes under this same id.
    const tx = await buildSignedTx(
      JSON.stringify({ id: noteId, c: 'BBBBBBBBBBBBBBBBBBBBBB==', iv: IV }),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    serveTx(tx);
    const cap = capture();

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-3'), await envFor(cap) as never);

    expect(r.status).toBe(409);
    expect(cap.outcomes()).toEqual(['legacy_backfilled', 'conflict']);
    const body = await r.json() as { code: string; txId?: string };
    expect(body.code).toBe('id_payload_conflict');
    // The proof still landed — the fingerprint of what is ACTUALLY published.
    expect(await storedFp(noteId)).toBe(
      await computePublicationFp(VERSION, JSON.stringify({ id: noteId, c: 'BBBBBBBBBBBBBBBBBBBBBB==', iv: IV })),
    );
  });

  it('a transaction signed by an UNTRUSTED wallet is a conflict, and writes nothing', async () => {
    const noteId = '33333333-4444-4555-8666-777777777ccc';
    const stranger = await newWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      stranger,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    // ONLY the header is served — and only the header is fetched. D9 rejects an
    // untrusted signer before the body is ever requested, so registering a /raw
    // route here would leave it unconsumed. That is the assertion: the pool
    // does not spend a second request on a transaction it has already refused.
    mockRoute('GET', new RegExp(`^${G1}/tx/${tx.txId}$`), 200, JSON.stringify(tx.header));
    const cap = capture();

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-4'), await envFor(cap) as never);

    expect(r.status).toBe(409);
    expect(cap.outcomes()).toEqual(['legacy_not_ours']);
    // Nothing is bound: we cannot fingerprint a publication that is not ours.
    expect(await storedFp(noteId)).toBeUndefined();
  });
});

describe('an unprovable legacy record', () => {
  it('503s and writes nothing when no gateway can serve the transaction', async () => {
    const noteId = '33333333-4444-4555-8666-777777777ddd';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    // No routes: the pool is unreachable.
    const cap = capture();

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-5'), await envFor(cap) as never);
    expect(cap.outcomes()).toEqual(['legacy_unproven']);

    // Absence of evidence is a TRANSPORT failure, not a verdict. A conflict
    // here would quarantine a healthy record over a bad afternoon on the
    // gateway network — permanently, since the client treats it as terminal.
    expect(r.status).toBe(503);
    expect(await storedFp(noteId)).toBeUndefined();
  });

  it('retries successfully once the pool recovers', async () => {
    const noteId = '33333333-4444-4555-8666-777777777eee';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);

    expect((await worker.fetch(await uploadRequest(noteId, 'lb-6a'), await envFor() as never)).status)
      .toBe(503);

    serveTx(tx);
    const r = await worker.fetch(await uploadRequest(noteId, 'lb-6b'), await envFor() as never);
    expect(r.status).toBe(200);
    expect((await r.json() as { deduped?: boolean }).deduped).toBe(true);
  });
});

// ─── The recovery-token branch binds an EXISTING txId too ────────────

/** The server's recovery HMAC (key = SHA-256(secret + ':recovery')). */
async function signRecovery(noteId: string, txId: string, postedAt: number): Promise<string> {
  const material = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode('test-recovery-secret:recovery')));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${noteId}:${txId}:${postedAt}`));
  return b64(new Uint8Array(sig));
}

async function recoveryUpload(
  noteId: string, ip: string, recovery: { txId: string; postedAt: number; token: string },
): Promise<Request> {
  const body = JSON.stringify({
    data: dataFor(noteId),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: VERSION },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: identity.ownerHash },
      { name: 'Note-Id', value: noteId },
    ],
    ownerHash: identity.ownerHash,
    timestamp: Date.now(),
    recheck: true,
    recovery,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), identity.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': identity.pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': ip,
    },
    body,
  });
}

describe('recovery token — the token proves the id, never the bytes', () => {
  it('reconciles an alive TX whose publication IS this payload (no re-post)', async () => {
    const noteId = '33333333-4444-4555-8666-777777777fff';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    const postedAt = Date.now() - 60_000;
    // Alive on every status origin, then provable on the payload pool.
    for (const origin of ['https://arweave.net', 'https://g2.test']) {
      mockRoute('GET', new RegExp(`^${origin}/tx/${tx.txId}/status$`), 200,
        JSON.stringify({ block_height: 1, number_of_confirmations: 3 }));
    }
    serveTx(tx);

    const cap = capture();
    const r = await worker.fetch(
      await recoveryUpload(noteId, 'rc-ok', { txId: tx.txId, postedAt, token: await signRecovery(noteId, tx.txId, postedAt) }),
      await envFor(cap) as never,
    );

    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; committed: boolean; deduped?: boolean };
    expect(body.txId).toBe(tx.txId);
    expect(body.committed).toBe(true);
    expect(body.deduped).toBe(true);
    // Its own outcome, so `recovery_*` is a complete family and the share of
    // refusals in it is a number.
    expect(cap.outcomes()).toEqual(['recovery_reconciled']);
  });

  it('REFUSES to bind when the alive publication carries different bytes', async () => {
    // The exact defect the branch exists to stop: a valid token plus a live
    // transaction is not evidence about the payload. Committing here would mint
    // «payload B under transaction A» with the server's own signature on it.
    const noteId = '33333333-4444-4555-8666-77777777aaaa';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      JSON.stringify({ id: noteId, c: 'BBBBBBBBBBBBBBBBBBBBBB==', iv: IV }),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    const postedAt = Date.now() - 60_000;
    for (const origin of ['https://arweave.net', 'https://g2.test']) {
      mockRoute('GET', new RegExp(`^${origin}/tx/${tx.txId}/status$`), 200,
        JSON.stringify({ block_height: 1, number_of_confirmations: 3 }));
    }
    serveTx(tx);

    const r = await worker.fetch(
      await recoveryUpload(noteId, 'rc-bad', { txId: tx.txId, postedAt, token: await signRecovery(noteId, tx.txId, postedAt) }),
      await envFor() as never,
    );

    expect(r.status).toBe(409);
    expect((await r.json() as { code: string }).code).toBe('id_payload_conflict');
    // Reservation released, nothing bound.
    expect(await storedFp(noteId)).toBeUndefined();
  });
});

describe('a legacy record whose transaction is PROVEN gone', () => {
  it('re-posts instead of answering 503 forever', async () => {
    // The distinction that makes this necessary: from the payload pool, «the
    // gateways are having a bad afternoon» and «this transaction is gone» look
    // identical. Treating both as retryable is safe for the first and PERMANENT
    // for the second — the redrop path is only reachable once a record is
    // comparable, and a legacy record over a dropped transaction never becomes
    // comparable on its own.
    const noteId = '33333333-4444-4555-8666-77777777bbbb';
    const deadTx = 'DEADDEADDEADDEADDEADDEADDEADDEADDEADDEADDEA'; // 43 base64url
    await seedLegacyCommitted(noteId, deadTx); // committedAt is an hour ago

    // Unreachable on the payload pool…
    // …and unanimously 404 on the status pool, which is what `dead` requires.
    for (const origin of ['https://arweave.net', 'https://g2.test']) {
      mockRoute('GET', new RegExp(`^${origin}/tx/${deadTx}/status$`), 404, 'not found');
    }
    // The re-post legs.
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, 'A'.repeat(43));
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');
    const postTx = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');

    const signer = await newWallet();
    const cap = capture();
    const r = await worker.fetch(await uploadRequest(noteId, 'lb-dead'), {
      ...(await envFor(cap)),
      // A real signable wallet, declared trusted, so the re-post can complete.
      ARWEAVE_JWK: JSON.stringify(signer.jwk),
      TRUSTED_OWNERS: signer.address,
    } as never);

    expect(r.status).toBe(200);
    const body = await r.json() as { txId: string; deduped?: boolean };
    expect(postTx.calls).toBe(1);       // exactly one paid POST
    expect(body.txId).not.toBe(deadTx); // under a NEW transaction
    expect(body.deduped).toBe(false);   // this one was paid for
    expect(cap.outcomes()).toEqual(['legacy_dead_redrop']);

    // …and the record is no longer legacy: it carries this payload's fp.
    expect(await storedFp(noteId)).toBe(await computePublicationFp(VERSION, dataFor(noteId)));
  });
});

describe('the capability marker rides on every successful answer (D2a)', () => {
  it('a fresh paid upload carries semanticIdempotency and is not cacheable', async () => {
    // A one-off /health probe cannot protect against a rollback that happens
    // AFTER it. The guarantee has to be atomic with the answer it qualifies,
    // so a client with import refuses to store a txId from a response without
    // this field — which an older worker physically cannot emit.
    const noteId = '33333333-4444-4555-8666-77777777cccc';
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/tx_anchor$/, 200, 'A'.repeat(43));
    mockRoute('GET', /^https:\/\/arweave\.net(?::443)?\/price\/\d+$/, 200, '0');
    mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');

    const signer = await newWallet();
    const r = await worker.fetch(await uploadRequest(noteId, 'cap-1'), {
      ...(await envFor()),
      ARWEAVE_JWK: JSON.stringify(signer.jwk),
      TRUSTED_OWNERS: signer.address,
    } as never);

    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect((await r.json() as { semanticIdempotency?: number }).semanticIdempotency).toBe(1);
  });

  it('a DEDUPED answer carries it too — that is the one a rollback would forge', async () => {
    const noteId = '33333333-4444-4555-8666-77777777dddd';
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      dataFor(noteId),
      notesTags({ version: VERSION, ownerHash: identity.ownerHash, noteId }),
      wallet,
    );
    await seedLegacyCommitted(noteId, tx.txId);
    serveTx(tx);

    const r = await worker.fetch(await uploadRequest(noteId, 'cap-2'), await envFor() as never);
    const body = await r.json() as { deduped?: boolean; semanticIdempotency?: number };
    expect(body.deduped).toBe(true);
    expect(body.semanticIdempotency).toBe(1);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('/health advertises it as a CONSTANT, not a configurable var', async () => {
    // If it came from configuration, a build carrying the old logic could be
    // relabelled as the safe one and have uploads switched back on.
    const r = await worker.fetch(
      new Request('https://proxy.example.com/health'),
      { ...(await envFor()), SEMANTIC_IDEMPOTENCY: '0' } as never,
    );
    expect((await r.json() as { semanticIdempotency?: number }).semanticIdempotency).toBe(1);
  });
});
