import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildSignedTx,
  edgeFor,
  gatewayFetchMock,
  newWallet,
  notesTags,
  testWallet,
} from '../test-stubs/signed-tx';

// C2: restore must filter by trusted wallet owners, fail closed without them,
// and (v2) take truth from the decrypted envelope.
// config.ts reads VITE_TRUSTED_OWNERS at module load, so each test stubs the env
// then imports arweave.ts fresh (resetModules).

const OWNER_A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
const OWNER_B = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function anyKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The restore keyring: notes key + the two safebox halves. Tests that only
 *  care about notes reuse the same key for the safebox slots — no v4 candidate
 *  is served in those fixtures. */
function ring(key: CryptoKey) {
  return { note: key, safeboxMeta: key, safeboxSecret: key };
}
async function keyring() {
  return ring(await anyKey());
}

describe('fetchAllNotes owner filter (C2)', () => {
  it('passes the pinned trusted owners into the GraphQL query and query text', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', `${OWNER_A},${OWNER_B}`);
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { transactions: { edges: [], pageInfo: { hasNextPage: false } } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    await fetchAllNotes('owner-hash-xyz', await keyring());

    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // The filter must be wired both in the variables AND used in the query text —
    // otherwise deleting `owners: $owners` from the query wouldn't fail this test.
    expect(body.query).toMatch(/owners:\s*\$owners/);
    expect(body.variables.owners).toEqual([OWNER_A, OWNER_B]);
    expect(body.variables.ownerHash).toEqual(['owner-hash-xyz']);
  });

  it('fails closed (throws) when no trusted owners are pinned', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', '');
    const { fetchAllNotes } = await import('./arweave');
    await expect(fetchAllNotes('owner-hash-xyz', await keyring())).rejects.toThrow(/VITE_TRUSTED_OWNERS/);
  });

  it('fails closed (throws) on a malformed trusted owner (typo guard)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', 'not-a-real-address');
    const { fetchAllNotes } = await import('./arweave');
    await expect(fetchAllNotes('owner-hash-xyz', await keyring())).rejects.toThrow(/malformed Arweave address/);
  });
});

describe('uploadViaProxy committed flag', () => {
  it('passes through committed:false (server did not confirm the DO commit)', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ txId: 'tx1', committed: false }), { status: 200 }),
    ));
    const { uploadViaProxy } = await import('./arweave');
    expect(await uploadViaProxy('{}', 'pk', 'sig')).toEqual({ kind: 'accepted', txId: 'tx1', committed: false });
  });

  it('defaults committed:true when the field is absent', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ txId: 'tx2' }), { status: 200 }),
    ));
    const { uploadViaProxy } = await import('./arweave');
    const r = await uploadViaProxy('{}', 'pk', 'sig');
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') expect(r.committed).toBe(true);
  });

  it('maps 503 to a retryable unavailable result', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('deferred', { status: 503 })));
    const { uploadViaProxy } = await import('./arweave');
    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('unavailable');
  });
});

describe('getTxStatus semantics — QUORUM (L1, PR-3a)', () => {
  const TX = 'w9AF3YCc9eFb5IqD8rzqXfCgmWNpBJHrAPo1VzfZfjs'; // canonical 43 chars
  const G1 = 'https://g1.example';
  const G2 = 'https://g2.example';

  /** Two configured origins — the minimum at which `dead` is reachable at all. */
  function stubTwoGateways() {
    vi.stubEnv('VITE_STATUS_GATEWAYS', G1 + ',' + G2);
  }
  const respond = (per: Record<string, () => Response>) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [origin, make] of Object.entries(per)) {
        if (url.startsWith(origin)) return make();
      }
      throw new Error('unexpected ' + url);
    });

  it('a malformed txId is INVALID without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus('tx')).kind).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('202 from either gateway → pending', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response('', { status: 404 }),
      [G2]: () => new Response('Pending', { status: 202 }),
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('pending');
  });

  it('404 from EVERY configured gateway → dropped', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response('', { status: 404 }),
      [G2]: () => new Response('', { status: 404 }),
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('dropped');
  });

  // The normative example: agreeing 404s are not a quorum while anyone is silent.
  it('404 + timeout → unavailable, NOT dropped', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response('', { status: 404 }),
      [G2]: () => { throw new Error('timeout'); },
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });

  // CHANGED BEHAVIOR, deliberately: a 400 used to be `invalid`, which fed
  // needsRecheck — the paid re-post path — on one host's opinion alone.
  it('400 is unavailable, never invalid and never dropped', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response('', { status: 400 }),
      [G2]: () => new Response('', { status: 400 }),
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });

  it('5xx and network errors → unavailable', async () => {
    stubTwoGateways();
    const makers: Array<() => Response> = [
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 503 }),
      () => { throw new Error('network'); },
    ];
    for (const make of makers) {
      vi.stubGlobal('fetch', respond({ [G1]: make, [G2]: make }));
      const { getTxStatus } = await import('./arweave');
      expect((await getTxStatus(TX)).kind).toBe('unavailable');
    }
  });

  it('200 with a valid body → confirmed', async () => {
    stubTwoGateways();
    const body = () => new Response(
      JSON.stringify({ block_height: 5, number_of_confirmations: 42 }), { status: 200 });
    vi.stubGlobal('fetch', respond({ [G1]: body, [G2]: body }));
    const { getTxStatus } = await import('./arweave');
    const r = await getTxStatus(TX);
    expect(r.kind).toBe('confirmed');
    if (r.kind === 'confirmed') expect(r.confirmations).toBe(42);
  });

  it('disagreeing 200s aggregate to the LOWEST confirmation count', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response(JSON.stringify({ block_height: 9, number_of_confirmations: 40 }), { status: 200 }),
      [G2]: () => new Response(JSON.stringify({ block_height: 7, number_of_confirmations: 3 }), { status: 200 }),
    }));
    const { getTxStatus } = await import('./arweave');
    expect(await getTxStatus(TX)).toEqual({ kind: 'confirmed', confirmations: 3, blockHeight: 7 });
  });

  it('a 200 with a malformed body is not alive AND blocks dead', async () => {
    stubTwoGateways();
    vi.stubGlobal('fetch', respond({
      [G1]: () => new Response('not json', { status: 200 }),
      [G2]: () => new Response('', { status: 404 }),
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });

  it('a duplicated origin in the CSV cannot manufacture a quorum', async () => {
    // Both entries collapse to ONE configured origin, so `dead` would need a
    // second one that does not exist — the verdict can only be unavailable.
    vi.stubEnv('VITE_STATUS_GATEWAYS', G1 + ',' + G1 + '/');
    vi.stubGlobal('fetch', respond({ [G1]: () => new Response('', { status: 404 }) }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });

  // The empty env is NOT the old behavior: one configured origin makes `dead`
  // unreachable, so a lone 404 no longer authorizes anything.
  it('with the default single gateway a 404 is unavailable, not dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });
});

describe('isArweaveOnline — any live gateway', () => {
  it('a fast non-ok answer does not mask a slower 200', async () => {
    vi.stubEnv('VITE_STATUS_GATEWAYS', 'https://fast.example,https://slow.example');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      // fetch does NOT reject on 500; without an explicit throw per probe,
      // Promise.any would settle on this one and report the pool offline.
      if (String(input).startsWith('https://fast.example')) return new Response('', { status: 500 });
      await new Promise(r => setTimeout(r, 5));
      return new Response('{}', { status: 200 });
    }));
    const { isArweaveOnline } = await import('./arweave');
    expect(await isArweaveOnline()).toBe(true);
  });

  it('every gateway failing → offline', async () => {
    vi.stubEnv('VITE_STATUS_GATEWAYS', 'https://a.example,https://b.example');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const { isArweaveOnline } = await import('./arweave');
    expect(await isArweaveOnline()).toBe(false);
  });
});

describe('buildUploadPayload version-aware serialization', () => {
  it('serializes a v1 note with Timestamp tag and outer t', async () => {
    const { buildUploadPayload } = await import('./arweave');
    const note = { noteId: 'id1', ciphertext: 'c', iv: 'iv', createdAt: 123 };
    const p = buildUploadPayload(note, 'owner-hash', 1000);
    const names = p.tags.map(t => t.name);
    expect(names).toHaveLength(6);
    expect(names).toContain('Timestamp');
    expect(p.tags.find(t => t.name === 'App-Version')?.value).toBe('1');
    expect(JSON.parse(p.data)).toEqual({ id: 'id1', c: 'c', iv: 'iv', t: 123 });
  });

  it('serializes a v2 note WITHOUT Timestamp/outer t', async () => {
    const { buildUploadPayload } = await import('./arweave');
    const note = { noteId: 'id2', ciphertext: 'c', iv: 'iv', createdAt: 456, v: 2 as const };
    const p = buildUploadPayload(note, 'owner-hash', 1000);
    const names = p.tags.map(t => t.name);
    expect(names).toHaveLength(5);
    expect(names).not.toContain('Timestamp');
    expect(p.tags.find(t => t.name === 'App-Version')?.value).toBe('2');
    expect(JSON.parse(p.data)).toEqual({ id: 'id2', c: 'c', iv: 'iv' });
  });
});

describe('fetchAllNotes v2 envelope (C2 truth-after-decryption)', () => {
  it('decrypts a v2 note and takes id/date from the authenticated envelope', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'секрет v2');

    // Under D9 the payload must arrive with a header that actually verifies —
    // a bare JSON blob is no longer a restorable candidate.
    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );
    const fetchMock = vi.fn(gatewayFetchMock({ txs: [tx] }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('секрет v2');
    expect(res[0].encrypted.v).toBe(2);
    expect(res[0].encrypted.createdAt).toBe(note.createdAt);
    expect(res[0].txId).toBe(tx.txId);

    // Regression guard (restore CORS bug): the note payload MUST be fetched from
    // the /raw/<txId> endpoint. The bare gateway URL arweave.net/<txId> 302-
    // redirects to a sandbox subdomain that sends no CORS headers, so a browser
    // fetch is blocked — this silently broke restore for every user until pinned.
    const rawCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/raw/'));
    expect(String(rawCall?.[0])).toContain('/raw/' + tx.txId);
  });

  it('skips a candidate that fails to decrypt (replay/garbage)', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const otherKey = await deriveKey(generateMnemonic());
    // Ciphertext encrypted under a DIFFERENT key → won't decrypt with `key`.
    const foreign = await encryptEnvelope(otherKey, 'not yours');

    const tx = await buildSignedTx(
      JSON.stringify({ id: foreign.noteId, c: foreign.ciphertext, iv: foreign.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: foreign.noteId }),
      wallet,
    );
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs: [tx] })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(0);
    // A decrypt-failure is an intentional skip, NOT a partial restore.
    expect(incomplete).toBe(false);
  });

  it('restores notes posted under BOTH owners after a wallet rotation', async () => {
    // Rotation runbook: the old owner stays in TRUSTED_OWNERS, so notes signed
    // by either wallet must come back in one sweep — and now that D9 checks the
    // SIGNING wallet, this is a real two-key test rather than two labels.
    const oldWallet = await testWallet();
    const newWallet_ = await newWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', oldWallet.address + ',' + newWallet_.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const oldNote = await encryptEnvelope(key, 'под старым кошельком');
    const newNote = await encryptEnvelope(key, 'под новым кошельком');

    const oldTx = await buildSignedTx(
      JSON.stringify({ id: oldNote.noteId, c: oldNote.ciphertext, iv: oldNote.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: oldNote.noteId }),
      oldWallet,
    );
    const newTx = await buildSignedTx(
      JSON.stringify({ id: newNote.noteId, c: newNote.ciphertext, iv: newNote.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: newNote.noteId }),
      newWallet_,
    );
    const fetchMock = vi.fn(gatewayFetchMock({ txs: [oldTx, newTx] }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(false);
    expect(res.map(r => r.text).sort()).toEqual(['под новым кошельком', 'под старым кошельком']);
    // The GraphQL query itself must have asked for both owners.
    const gqlBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(gqlBody.variables.owners).toEqual([oldWallet.address, newWallet_.address]);
  });

  // D9 attribution: the edge is DISCOVERY only. When it disagrees with the
  // signed header, the header wins — nothing covers the edge.
  it('takes Note-Id from the SIGNED header, not from the GraphQL edge', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'подписанные теги решают');

    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );
    // The index announces a DIFFERENT Note-Id for the same txId.
    const lying = edgeFor(tx, {
      tags: [
        { name: 'App-Name', value: 'EternalNotes' },
        { name: 'App-Version', value: '2' },
        { name: 'Note-Id', value: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs: [tx], pages: [[lying]] })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(1);
    expect(res[0].encrypted.noteId).toBe(note.noteId);
  });

  // F1 regression: an index that ignores the `owners:` filter hands us a
  // stranger's edge. D9 rejects it on the trusted-owner step — before any
  // decryption, and without claiming the Note-Id.
  it('a foreign-owner candidate is skipped and does not mark the sweep incomplete', async () => {
    const trusted = await testWallet();
    const attacker = await newWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', trusted.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'чужая транзакция');

    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      attacker,
    );
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs: [tx] })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(0);
    // NOT incomplete: this candidate was never ours, nothing was lost.
    expect(incomplete).toBe(false);
  });
});

describe('checkRegistration structured result (RegistrationCheck)', () => {
  const proxyEnv = () => vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');

  it('maps 200 to allowed/denied without a message', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })));
    const { checkRegistration } = await import('./arweave');
    expect(await checkRegistration('pk', 'sig', '{}')).toEqual({ status: 'allowed' });
  });

  it('preserves the server text on a 401 (L13 clock-skew hint reaches the UI)', async () => {
    proxyEnv();
    const skewText = 'Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(skewText, { status: 401 })));
    const { checkRegistration } = await import('./arweave');
    const r = await checkRegistration('pk', 'sig', '{}');
    expect(r.status).toBe('invalid_request');
    expect(r.message).toMatch(/clock skew/);
  });

  it('maps 5xx/429 to unavailable and a network error to unavailable', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    const { checkRegistration } = await import('./arweave');
    expect((await checkRegistration('pk', 'sig', '{}')).status).toBe('unavailable');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.resetModules();
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    const { checkRegistration: check2 } = await import('./arweave');
    expect((await check2('pk', 'sig', '{}')).status).toBe('unavailable');
  });
});

describe('fetchAllNotes parallel pool + progress (Phase 6 perf-restore)', () => {
  it('reports progress per settled payload and restores everything', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const notes = await Promise.all(
      Array.from({ length: 7 }, (_, i) => encryptEnvelope(key, `заметка ${i}`)),
    );
    const txs = await Promise.all(notes.map(n => buildSignedTx(
      JSON.stringify({ id: n.noteId, c: n.ciphertext, iv: n.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: n.noteId }),
      wallet,
    )));
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs })));

    const progress: Array<[number, number]> = [];
    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key), (d, t) => progress.push([d, t]));

    expect(incomplete).toBe(false);
    expect(res).toHaveLength(7);
    // Every candidate settled exactly once, ending at total/total.
    expect(progress).toHaveLength(7);
    expect(progress.every(([, t]) => t === 7)).toBe(true);
    expect(progress[progress.length - 1]).toEqual([7, 7]);
  });

  it('never runs more than 5 payload fetches in flight (bounded pool)', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const notes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => encryptEnvelope(key, `n${i}`)),
    );
    const txs = await Promise.all(notes.map(n => buildSignedTx(
      JSON.stringify({ id: n.noteId, c: n.ciphertext, iv: n.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: n.noteId }),
      wallet,
    )));

    let inFlight = 0;
    let maxInFlight = 0;
    const serve = gatewayFetchMock({ txs });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/graphql')) return serve(input, init);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so the pool actually overlaps requests before any completes.
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return serve(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res } = await fetchAllNotes('oh', ring(key));

    expect(res).toHaveLength(12);
    expect(maxInFlight).toBeGreaterThan(1); // the pool really parallelizes...
    // ...but never beyond the cap. Each worker issues ONE request at a time
    // (header, then raw), so the bound is unchanged by D9's extra round trip.
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

describe('fetchAllNotes partial-restore flag (M1)', () => {
  it('flags incomplete when a later page fails, keeping page-1 notes', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'страница 1');

    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({
      txs: [tx],
      // Page 1 carries the note and announces a second page; that second call
      // fails, so the sweep keeps what it has and reports partial.
      pages: [[edgeFor(tx)], []],
      onGraphql: (call) => (call > 0 ? new Response('gateway down', { status: 502 }) : undefined),
    })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(true);   // user must see "partial", not silence
    expect(res).toHaveLength(1);     // what DID load is kept
    expect(res[0].text).toBe('страница 1');
  });

  it('THROWS when the FIRST page fails — nothing was retrieved, so "partial" would lie', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const { fetchAllNotes, ArweaveIndexUnavailableError } = await import('./arweave');
    await expect(fetchAllNotes('oh', await keyring()))
      .rejects.toBeInstanceOf(ArweaveIndexUnavailableError);
  });

  it('an ABORTED first page stays silent (incomplete), never a throw', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    // A lock/reset cancels through the SAME signal a timeout uses, so the two
    // are indistinguishable by error type — only `signal.aborted` separates them.
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    }));

    const { fetchAllNotes } = await import('./arweave');
    const res = await fetchAllNotes('oh', await keyring(), undefined, { signal: ac.signal });
    expect(res.incomplete).toBe(true);
    expect(res.notes).toHaveLength(0);
  });

  it('flags incomplete when a note payload cannot be fetched (network)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const { deriveKey, generateMnemonic } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());

    // A CANONICAL txId: the candidate must actually reach the network for this
    // to be a network failure rather than a local rejection.
    const CANONICAL = 'w9AF3YCc9eFb5IqD8rzqXfCgmWNpBJHrAPo1VzfZfjs';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: CANONICAL, tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: 'nid' },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      throw new Error('network reset');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(incomplete).toBe(true);
    expect(res).toHaveLength(0);
  });

  // A txId that cannot name an Arweave transaction costs NO request: asking a
  // gateway about it is waste, and it is an intentional skip — nothing was lost,
  // so the sweep is not partial.
  it('a NON-CANONICAL txId is skipped without any payload request', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const { deriveKey, generateMnemonic } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TX1', tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: 'nid' },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      throw new Error('should never be requested');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(0);
    expect(incomplete).toBe(false);
    expect(fetchMock.mock.calls.filter(c => !String(c[0]).includes('/graphql'))).toHaveLength(0);
  });
});

describe('buildUploadPayload v3 + fail-closed serialization (P0)', () => {
  it('serializes a v3 note as 5 tags, App-Version=3, no Timestamp/outer t', async () => {
    const { buildUploadPayload } = await import('./arweave');
    const note = { noteId: 'id3', ciphertext: 'c', iv: 'iv', createdAt: 789, v: 3 as const };
    const p = buildUploadPayload(note, 'owner-hash', 1000);
    const names = p.tags.map(t => t.name);
    expect(names).toHaveLength(5);
    expect(names).not.toContain('Timestamp');
    expect(p.tags.find(t => t.name === 'App-Version')?.value).toBe('3');
    expect(JSON.parse(p.data)).toEqual({ id: 'id3', c: 'c', iv: 'iv' });
  });

  it('throws UnsupportedNoteVersionError for an unknown runtime v (never ships as v1)', async () => {
    const { buildUploadPayload } = await import('./arweave');
    const { UnsupportedNoteVersionError } = await import('./crypto');
    const base = { noteId: 'idX', ciphertext: 'c', iv: 'iv', createdAt: 1 };
    for (const v of [4, '3', 0, {}] as const) {
      const note = { ...base, v } as unknown as import('./crypto').EncryptedNote;
      expect(() => buildUploadPayload(note, 'oh', 1000)).toThrow(UnsupportedNoteVersionError);
    }
  });

  it('wire-payload boundary: a limit-sized v3 note fits under the worker cap (51200)', async () => {
    const { buildUploadPayload } = await import('./arweave');
    const { deriveKey, generateMnemonic, encryptEnvelopeV3 } = await import('./crypto');
    const { MAX_NOTE_JSON_BYTES } = await import('./limits');
    const key = await deriveKey(generateMnemonic());
    // Worst-case escaped text exactly at the limit: newlines double via JSON
    // escaping; the serialized form (quotes included) hits MAX exactly.
    const text = '\n'.repeat((MAX_NOTE_JSON_BYTES - 2) / 2);
    const note = await encryptEnvelopeV3(key, text, { fmt: 'md', rev: 1 });
    const payload = buildUploadPayload(note, 'x'.repeat(44), Date.now(), true, {
      txId: 'T'.repeat(43), postedAt: Date.now(), token: 'k'.repeat(44),
    });
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(bodyBytes).toBeLessThanOrEqual(51_200);
  });
});

describe('uploadViaProxy v3_disabled classification', () => {
  it('maps a 503 with the machine code to kind v3_disabled', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'v3_uploads_disabled' }), { status: 503 })));
    const { uploadViaProxy } = await import('./arweave');
    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('v3_disabled');
  });

  it('keeps a plain-text 503 as the generic retryable unavailable', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('recheck deferred', { status: 503 })));
    const { uploadViaProxy } = await import('./arweave');
    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('unavailable');
  });

  it('a 503 with unrelated JSON stays unavailable', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'other' }), { status: 503 })));
    const { uploadViaProxy } = await import('./arweave');
    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('unavailable');
  });
});

describe('getWorkerCapabilities — the full verdict table (PR-3a)', () => {
  // Resuming a persisted upload pause is a DECISION, so the answer it is made
  // on must be fresh, from a worker that implements the semantics this client
  // expects, over the same gateway pool. Anything less is 'unknown' and the
  // pause simply stays up.
  const proxyEnv = () => vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');

  /** A worker that answers correctly, echoing whatever nonce it was sent. */
  function healthy(overrides: Record<string, unknown> = {}, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const nonce = new URL(String(input)).searchParams.get('nonce');
      const { QUORUM_POLICY_ID } = await import('./status-quorum');
      const { serializeStatusOrigins } = await import('./gateways-parse');
      const { STATUS_GATEWAYS } = await import('./gateways');
      const digest = new Uint8Array(await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(serializeStatusOrigins(STATUS_GATEWAYS))));
      const hash = [...digest].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
      return new Response(JSON.stringify({
        ok: true,
        versions: ['1', '2', '3', '4'],
        uploads: true,
        v3Uploads: true,
        v4Uploads: true,
        statusQuorumPolicy: QUORUM_POLICY_ID,
        statusGatewaysHash: hash,
        statusGatewaysCount: STATUS_GATEWAYS.length,
        nonce,
        ...overrides,
      }), { status });
    }));
  }
  const caps = async () => (await import('./arweave')).getWorkerCapabilities();
  const UNKNOWN = { v3: 'unknown', v4: 'unknown' };

  it('enabled when EVERY condition holds', async () => {
    proxyEnv(); healthy();
    expect(await caps()).toEqual({ v3: 'enabled', v4: 'enabled' });
  });

  // THE hole this closes: the global switch was ignored, so an emergency build
  // that refuses every upload would have had its pause lifted.
  it('uploads:false disables BOTH versions even with per-version flags true', async () => {
    proxyEnv(); healthy({ uploads: false });
    expect(await caps()).toEqual({ v3: 'disabled', v4: 'disabled' });
  });

  it('per-version gates stay independent under uploads:true', async () => {
    proxyEnv(); healthy({ v4Uploads: false });
    expect(await caps()).toEqual({ v3: 'enabled', v4: 'disabled' });
  });

  it('a MISSING flag is unknown, never a decision', async () => {
    proxyEnv(); healthy({ v4Uploads: undefined });
    expect(await caps()).toEqual({ v3: 'enabled', v4: 'unknown' });
    vi.resetModules(); proxyEnv(); healthy({ uploads: undefined });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('a non-boolean flag is unknown', async () => {
    proxyEnv(); healthy({ uploads: 'true' });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('a foreign or missing quorum policy is unknown', async () => {
    proxyEnv(); healthy({ statusQuorumPolicy: 'legacy-single-v0' });
    expect(await caps()).toEqual(UNKNOWN);
    vi.resetModules(); proxyEnv(); healthy({ statusQuorumPolicy: undefined });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('a gateway pool that disagrees with ours is unknown', async () => {
    proxyEnv(); healthy({ statusGatewaysHash: 'deadbeefdeadbeef' });
    expect(await caps()).toEqual(UNKNOWN);
    vi.resetModules(); proxyEnv(); healthy({ statusGatewaysCount: 99 });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('a version absent from the versions list is unknown despite a true flag', async () => {
    proxyEnv(); healthy({ versions: ['1', '2'] });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('ok:false is unknown', async () => {
    proxyEnv(); healthy({ ok: false });
    expect(await caps()).toEqual(UNKNOWN);
  });

  // Freshness: no-store keeps an intermediary from serving a stale answer, but
  // only the echo proves the answer we HOLD is the one we just asked for.
  it('a missing or wrong nonce echo is unknown, however valid the rest is', async () => {
    proxyEnv(); healthy({ nonce: undefined });
    expect(await caps()).toEqual(UNKNOWN);
    vi.resetModules(); proxyEnv(); healthy({ nonce: '0000000000000000' });
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('sends a FRESH nonce on every attempt', async () => {
    proxyEnv();
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).searchParams.get('nonce') ?? '');
      return new Response('{}', { status: 500 }); // force all retries
    }));
    expect(await caps()).toEqual(UNKNOWN);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3); // a retry must not replay the same request
    expect(seen.every(n => /^[0-9a-f]{16}$/.test(n))).toBe(true);
  });

  it('asks with cache: no-store', async () => {
    proxyEnv();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await caps();
    expect((fetchMock.mock.calls[0][1] as RequestInit).cache).toBe('no-store');
  });

  it('an OLD worker (no attestation fields) is unknown — the pause stays', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, versions: ['1', '2', '3', '4'], v3Uploads: true }), { status: 200 })));
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('an oversized body is unknown', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, pad: 'x'.repeat(9000) }), { status: 200 })));
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('malformed bodies, non-200 and network errors are unknown', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await caps()).toEqual(UNKNOWN);

    vi.resetModules(); proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    expect(await caps()).toEqual(UNKNOWN);

    vi.resetModules(); proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await caps()).toEqual(UNKNOWN);
  });

  it('unknown when no proxy is configured (no request at all)', async () => {
    vi.stubEnv('VITE_PROXY_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await caps()).toEqual(UNKNOWN);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('fetchAllNotes v3 (chain meta through restore)', () => {
  it('restores a v3 note with its meta and authenticated createdAt', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, encryptEnvelopeV3, randomUuidV8 } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const root = randomUuidV8();
    const note = await encryptEnvelopeV3(key, '# v3 markdown', { fmt: 'md', rev: 2, root, prev: root });

    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '3', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs: [tx] })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('# v3 markdown');
    expect(res[0].encrypted.v).toBe(3);
    expect(res[0].encrypted.createdAt).toBe(note.createdAt);
    expect(res[0].meta).toEqual({ fmt: 'md', rev: 2, root, prev: root });
  });

  it('skips a v3 candidate whose envelope meta is malformed (intentional skip)', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

    const { deriveKey, generateMnemonic, randomUuidV8, bufferToBase64 } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    // Forge a v3 record whose envelope violates the rev-1 linkage invariant.
    const id = randomUuidV8();
    const envelope = { v: 3, id, t: Date.now(), text: 'x', fmt: 'md', rev: 1, root: crypto.randomUUID() };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)));

    // The TRANSACTION is perfectly valid — only the envelope inside is not, so
    // this stays an intentional skip rather than a gateway failure.
    const tx = await buildSignedTx(
      JSON.stringify({ id, c: bufferToBase64(ct), iv: bufferToBase64(iv) }),
      notesTags({ version: '3', ownerHash: 'oh', noteId: id }),
      wallet,
    );
    vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({ txs: [tx] })));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(0);
    expect(incomplete).toBe(false); // malformed = intentional skip, not partial
  });
});

// ── Regressions found in code review ──────────────────────────────────────
describe('status probes must not follow redirects (quorum collapse)', () => {
  // `fetch` follows redirects by default. A gateway answering 302 → another
  // gateway would make TWO configured origins report the opinion of ONE host,
  // and unanimity over the pool is what authorizes a paid redrop.
  it('a redirecting gateway is `other`, so 404 elsewhere cannot reach dropped', async () => {
    const TX = 'w9AF3YCc9eFb5IqD8rzqXfCgmWNpBJHrAPo1VzfZfjs';
    vi.stubEnv('VITE_STATUS_GATEWAYS', 'https://g1.example,https://g2.example');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // The mock enforces the contract a real runtime would: with
      // redirect:'error' a 3xx becomes a rejected promise, not a followed hop.
      if (url.startsWith('https://g1.example')) {
        if (init?.redirect === 'error') throw new TypeError('unexpected redirect');
        return new Response('', { status: 404 });
      }
      return new Response('', { status: 404 });
    }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus(TX)).kind).toBe('unavailable');
  });

  it('asks with redirect: error on every status probe', async () => {
    const TX = 'w9AF3YCc9eFb5IqD8rzqXfCgmWNpBJHrAPo1VzfZfjs';
    vi.stubEnv('VITE_STATUS_GATEWAYS', 'https://g1.example,https://g2.example');
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { getTxStatus } = await import('./arweave');
    await getTxStatus(TX);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe('error');
    }
  });
});

describe('a malformed header must cost ONE gateway, never the sweep', () => {
  it('falls through to the next gateway and still restores the note', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
    vi.stubEnv('VITE_PAYLOAD_GATEWAYS', 'https://bad.example,https://good.example');

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'пережила битый заголовок');
    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );

    // "A" matches the base64url alphabet and makes atob throw — the exact shape
    // that used to escape as an exception and reject the cached promise, taking
    // every other candidate down with it.
    const serve = gatewayFetchMock({
      txs: [tx],
      onHeader: (origin) => origin === 'https://bad.example'
        ? new Response(JSON.stringify({ ...tx.header, signature: 'A' }), { status: 200 })
        : undefined,
    });
    vi.stubGlobal('fetch', vi.fn(serve));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('пережила битый заголовок');
    expect(incomplete).toBe(false);
  });

  it('a corrupted BODY on the first gateway is neutralized by a valid second', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
    vi.stubEnv('VITE_PAYLOAD_GATEWAYS', 'https://bad.example,https://good.example');

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'тело со второго шлюза');
    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );

    const serve = gatewayFetchMock({
      txs: [tx],
      onRaw: (origin) => origin === 'https://bad.example'
        ? new Response('{"id":"nope","c":"AAAA","iv":"BBBB"}', { status: 200 })
        : undefined,
    });
    vi.stubGlobal('fetch', vi.fn(serve));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete, gatewayMismatches } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(1);
    expect(incomplete).toBe(false);
    // The failure is COUNTED locally (D5: nothing is transmitted) and named by host.
    expect(gatewayMismatches).toMatchObject({ 'https://bad.example': 1 });
  });

  // The protocol binds header and bytes cryptographically, so mixing sources is
  // safe by construction — and useful when one gateway is half-broken.
  it('accepts a header and a body from DIFFERENT gateways', async () => {
    const wallet = await testWallet();
    vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
    vi.stubEnv('VITE_PAYLOAD_GATEWAYS', 'https://headers.example,https://bodies.example');

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'смешанные источники');
    const tx = await buildSignedTx(
      JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
      notesTags({ version: '2', ownerHash: 'oh', noteId: note.noteId }),
      wallet,
    );

    const serve = gatewayFetchMock({
      txs: [tx],
      onHeader: (origin) => origin === 'https://bodies.example'
        ? new Response('down', { status: 503 }) : undefined,
      onRaw: (origin) => origin === 'https://headers.example'
        ? new Response('down', { status: 503 }) : undefined,
    });
    vi.stubGlobal('fetch', vi.fn(serve));

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('смешанные источники');
  });
});
