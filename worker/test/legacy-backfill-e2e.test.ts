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

/**
 * env with a single-origin payload pool and BOTH wallets trusted:
 *  - the harness wallet, because it signed the publication D9 must accept;
 *  - the worker's own signing wallet, because /upload refuses while that one is
 *    outside the set (it would otherwise 503 before reaching this path).
 */
async function envFor(): Promise<Record<string, unknown>> {
  const publisher = await testWallet();
  const signer = await addressOfJwk(String(baseEnv.ARWEAVE_JWK));
  return {
    ...baseEnv,
    TRUSTED_OWNERS: `${signer},${publisher.address}`,
    PAYLOAD_GATEWAYS: G1,
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

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-1'), await envFor() as never);

    expect(r.status).toBe(200);
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

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-3'), await envFor() as never);

    expect(r.status).toBe(409);
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

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-4'), await envFor() as never);

    expect(r.status).toBe(409);
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

    const r = await worker.fetch(await uploadRequest(noteId, 'lb-5'), await envFor() as never);

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
