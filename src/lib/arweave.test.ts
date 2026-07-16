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
    const res = await fetchAllNotes('oh', key);

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
    const res = await fetchAllNotes('oh', key);
    expect(res).toHaveLength(0);
  });
});
