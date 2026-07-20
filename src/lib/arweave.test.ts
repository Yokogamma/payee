import { describe, it, expect, vi, afterEach } from 'vitest';

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
    await fetchAllNotes('owner-hash-xyz', await anyKey());

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
    await expect(fetchAllNotes('owner-hash-xyz', await anyKey())).rejects.toThrow(/VITE_TRUSTED_OWNERS/);
  });

  it('fails closed (throws) on a malformed trusted owner (typo guard)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', 'not-a-real-address');
    const { fetchAllNotes } = await import('./arweave');
    await expect(fetchAllNotes('owner-hash-xyz', await anyKey())).rejects.toThrow(/malformed Arweave address/);
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

describe('getTxStatus semantics (L1)', () => {
  const cases: Array<[number, string]> = [
    [202, 'pending'],
    [404, 'dropped'],
    [400, 'invalid'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];
  for (const [httpStatus, kind] of cases) {
    it(`maps HTTP ${httpStatus} → ${kind}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: httpStatus })));
      const { getTxStatus } = await import('./arweave');
      expect((await getTxStatus('tx')).kind).toBe(kind);
    });
  }

  it('maps HTTP 200 + confirmations → confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ block_height: 5, number_of_confirmations: 42 }), { status: 200 }),
    ));
    const { getTxStatus } = await import('./arweave');
    const r = await getTxStatus('tx');
    expect(r.kind).toBe('confirmed');
    if (r.kind === 'confirmed') expect(r.confirmations).toBe(42);
  });

  it('maps a network error → unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const { getTxStatus } = await import('./arweave');
    expect((await getTxStatus('tx')).kind).toBe('unavailable');
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
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'секрет v2');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TX1', tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: note.noteId },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      // v2 outer JSON: {id, c, iv} — no `t`
      return new Response(
        JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', key);

    expect(incomplete).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('секрет v2');
    expect(res[0].encrypted.v).toBe(2);
    expect(res[0].encrypted.createdAt).toBe(note.createdAt);
    expect(res[0].txId).toBe('TX1');
  });

  it('skips a candidate that fails to decrypt (replay/garbage)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const otherKey = await deriveKey(generateMnemonic());
    // Ciphertext encrypted under a DIFFERENT key → won't decrypt with `key`.
    const foreign = await encryptEnvelope(otherKey, 'not yours');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TX1', tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: foreign.noteId },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: foreign.noteId, c: foreign.ciphertext, iv: foreign.iv }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', key);
    expect(res).toHaveLength(0);
    // A decrypt-failure is an intentional skip, NOT a partial restore.
    expect(incomplete).toBe(false);
  });

  it('restores notes posted under BOTH owners after a wallet rotation', async () => {
    // Rotation runbook: the old owner stays in TRUSTED_OWNERS, so notes signed
    // by either wallet must come back in one sweep.
    vi.stubEnv('VITE_TRUSTED_OWNERS', `${OWNER_A},${OWNER_B}`);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const oldNote = await encryptEnvelope(key, 'под старым кошельком');
    const newNote = await encryptEnvelope(key, 'под новым кошельком');

    const byId: Record<string, { id: string; c: string; iv: string }> = {
      TXOLD: { id: oldNote.noteId, c: oldNote.ciphertext, iv: oldNote.iv },
      TXNEW: { id: newNote.noteId, c: newNote.ciphertext, iv: newNote.iv },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: ['TXOLD', 'TXNEW'].map(txId => ({ cursor: txId, node: { id: txId, tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: byId[txId].id },
          ] } })),
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      const txId = url.split('/').pop()!;
      return new Response(JSON.stringify(byId[txId]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', key);

    expect(incomplete).toBe(false);
    expect(res.map(r => r.text).sort()).toEqual(['под новым кошельком', 'под старым кошельком']);
    // The GraphQL query itself must have asked for both owners.
    const gqlBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(gqlBody.variables.owners).toEqual([OWNER_A, OWNER_B]);
  });
});

describe('fetchAllNotes partial-restore flag (M1)', () => {
  it('flags incomplete when a later page fails, keeping page-1 notes', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const note = await encryptEnvelope(key, 'страница 1');

    let gqlCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        gqlCalls++;
        if (gqlCalls > 1) return new Response('gateway down', { status: 502 });
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TX1', tags: [
            { name: 'App-Name', value: 'EternalNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: note.noteId },
          ] } }],
          pageInfo: { hasNextPage: true }, // → second page will be requested
        } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', key);

    expect(incomplete).toBe(true);   // user must see "partial", not silence
    expect(res).toHaveLength(1);     // what DID load is kept
    expect(res[0].text).toBe('страница 1');
  });

  it('flags incomplete when a note payload cannot be fetched (network)', async () => {
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
      throw new Error('network reset');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', key);
    expect(incomplete).toBe(true);
    expect(res).toHaveLength(0);
  });
});
