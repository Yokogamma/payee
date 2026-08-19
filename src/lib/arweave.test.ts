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
            { name: 'App-Name', value: 'MatamataNotes' },
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
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(false);
    expect(res).toHaveLength(1);
    expect(res[0].text).toBe('секрет v2');
    expect(res[0].encrypted.v).toBe(2);
    expect(res[0].encrypted.createdAt).toBe(note.createdAt);
    expect(res[0].txId).toBe('TX1');

    // Regression guard (restore CORS bug): the note payload MUST be fetched from
    // the /raw/<txId> endpoint. The bare gateway URL arweave.net/<txId> 302-
    // redirects to a sandbox subdomain that sends no CORS headers, so a browser
    // fetch is blocked — this silently broke restore for every user until pinned.
    const dataCall = fetchMock.mock.calls.find(c => !String(c[0]).includes('/graphql'));
    expect(String(dataCall?.[0])).toContain('/raw/TX1');
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
            { name: 'App-Name', value: 'MatamataNotes' },
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
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
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
            { name: 'App-Name', value: 'MatamataNotes' },
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
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));

    expect(incomplete).toBe(false);
    expect(res.map(r => r.text).sort()).toEqual(['под новым кошельком', 'под старым кошельком']);
    // The GraphQL query itself must have asked for both owners.
    const gqlBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(gqlBody.variables.owners).toEqual([OWNER_A, OWNER_B]);
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
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const notes = await Promise.all(
      Array.from({ length: 7 }, (_, i) => encryptEnvelope(key, `заметка ${i}`)),
    );
    const byTx = new Map(notes.map((n, i) => [`TX${i}`, n]));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [...byTx.entries()].map(([txId, n]) => ({ cursor: txId, node: { id: txId, tags: [
            { name: 'App-Name', value: 'MatamataNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: n.noteId },
          ] } })),
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      const n = byTx.get(url.split('/').pop()!)!;
      return new Response(JSON.stringify({ id: n.noteId, c: n.ciphertext, iv: n.iv }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

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
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const notes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => encryptEnvelope(key, `n${i}`)),
    );
    const byTx = new Map(notes.map((n, i) => [`TX${i}`, n]));

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [...byTx.entries()].map(([txId, n]) => ({ cursor: txId, node: { id: txId, tags: [
            { name: 'App-Name', value: 'MatamataNotes' },
            { name: 'App-Version', value: '2' },
            { name: 'Note-Id', value: n.noteId },
          ] } })),
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so the pool actually overlaps requests before any completes.
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      const n = byTx.get(url.split('/').pop()!)!;
      return new Response(JSON.stringify({ id: n.noteId, c: n.ciphertext, iv: n.iv }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res } = await fetchAllNotes('oh', ring(key));

    expect(res).toHaveLength(12);
    expect(maxInFlight).toBeGreaterThan(1); // the pool really parallelizes...
    expect(maxInFlight).toBeLessThanOrEqual(5); // ...but never beyond the cap
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
            { name: 'App-Name', value: 'MatamataNotes' },
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TX1', tags: [
            { name: 'App-Name', value: 'MatamataNotes' },
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

describe('getWorkerCapabilities (strict /health validation, per version)', () => {
  const proxyEnv = () => vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
  const health = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('enabled ONLY on ok + versions containing the version + its own flag true', async () => {
    proxyEnv();
    health({ ok: true, versions: ['1', '2', '3', '4'], v3Uploads: true, v4Uploads: true });
    const { getWorkerCapabilities } = await import('./arweave');
    expect(await getWorkerCapabilities()).toEqual({ v3: 'enabled', v4: 'enabled' });
  });

  it('disabled when the worker reports a gate off', async () => {
    proxyEnv();
    health({ ok: true, versions: ['1', '2', '3', '4'], v3Uploads: false, v4Uploads: false });
    const { getWorkerCapabilities } = await import('./arweave');
    expect(await getWorkerCapabilities()).toEqual({ v3: 'disabled', v4: 'disabled' });
  });

  it('the two gates are INDEPENDENT (v4 off must not disable v3)', async () => {
    proxyEnv();
    health({ ok: true, versions: ['1', '2', '3', '4'], v3Uploads: true, v4Uploads: false });
    const { getWorkerCapabilities } = await import('./arweave');
    expect(await getWorkerCapabilities()).toEqual({ v3: 'enabled', v4: 'disabled' });
  });

  it('a worker that lists v4 but omits v4Uploads is UNKNOWN (pause stays)', async () => {
    proxyEnv();
    health({ ok: true, versions: ['1', '2', '3', '4'], v3Uploads: true });
    const { getWorkerCapabilities } = await import('./arweave');
    expect(await getWorkerCapabilities()).toEqual({ v3: 'enabled', v4: 'unknown' });
  });

  it('unknown for an OLD worker ({ok:true} without capability fields)', async () => {
    proxyEnv();
    health({ ok: true });
    const { getWorkerCapabilities } = await import('./arweave');
    expect(await getWorkerCapabilities()).toEqual({ v3: 'unknown', v4: 'unknown' });
  });

  it('unknown for malformed bodies, non-200 and network errors (pause stays)', async () => {
    proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    let mod = await import('./arweave');
    expect(await mod.getWorkerCapabilities()).toEqual({ v3: 'unknown', v4: 'unknown' });

    vi.resetModules(); proxyEnv();
    health({ ok: true, versions: ['1', '2'], v3Uploads: true, v4Uploads: true });
    mod = await import('./arweave');
    // versions without '3'/'4' → unknown even though the flags say true
    expect(await mod.getWorkerCapabilities()).toEqual({ v3: 'unknown', v4: 'unknown' });

    vi.resetModules(); proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    mod = await import('./arweave');
    expect(await mod.getWorkerCapabilities()).toEqual({ v3: 'unknown', v4: 'unknown' });

    vi.resetModules(); proxyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    mod = await import('./arweave');
    expect(await mod.getWorkerCapabilities()).toEqual({ v3: 'unknown', v4: 'unknown' });
  });
});

describe('fetchAllNotes v3 (chain meta through restore)', () => {
  it('restores a v3 note with its meta and authenticated createdAt', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, encryptEnvelopeV3, randomUuidV8 } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const root = randomUuidV8();
    const note = await encryptEnvelopeV3(key, '# v3 markdown', { fmt: 'md', rev: 2, root, prev: root });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TXV3', tags: [
            { name: 'App-Name', value: 'MatamataNotes' },
            { name: 'App-Version', value: '3' },
            { name: 'Note-Id', value: note.noteId },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: note.noteId, c: note.ciphertext, iv: note.iv }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

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
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);

    const { deriveKey, generateMnemonic, randomUuidV8, bufferToBase64 } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    // Forge a v3 record whose envelope violates the rev-1 linkage invariant.
    const id = randomUuidV8();
    const envelope = { v: 3, id, t: Date.now(), text: 'x', fmt: 'md', rev: 1, root: crypto.randomUUID() };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { transactions: {
          edges: [{ cursor: 'c1', node: { id: 'TXBAD', tags: [
            { name: 'App-Name', value: 'MatamataNotes' },
            { name: 'App-Version', value: '3' },
            { name: 'Note-Id', value: id },
          ] } }],
          pageInfo: { hasNextPage: false },
        } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id, c: bufferToBase64(ct), iv: bufferToBase64(iv) }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAllNotes } = await import('./arweave');
    const { notes: res, incomplete } = await fetchAllNotes('oh', ring(key));
    expect(res).toHaveLength(0);
    expect(incomplete).toBe(false); // malformed = intentional skip, not partial
  });
});
