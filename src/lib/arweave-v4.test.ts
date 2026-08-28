import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSignedTx, gatewayFetchMock, notesTags, testWallet } from '../test-stubs/signed-tx';

// §4 (B3) + §8: the v4 half of restore and the v4 wire contract.
// config.ts reads VITE_TRUSTED_OWNERS at module load, so each test stubs the
// env then imports arweave.ts fresh (resetModules).

const OWNER_A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function safeboxKeyring() {
  const { generateMnemonic, deriveKey, deriveSafeboxMetaKey, deriveSafeboxSecretKey } = await import('./crypto');
  const mn = generateMnemonic();
  return {
    note: await deriveKey(mn),
    safeboxMeta: await deriveSafeboxMetaKey(mn),
    safeboxSecret: await deriveSafeboxSecretKey(mn),
  };
}

/** GraphQL page + /raw payloads keyed by txId. */
async function stubGateway(
  edges: Array<{ txId: string; version: string; noteId: string }>,
  payloads: Record<string, unknown>,
) {
  // Под D9 txId вычисляется из подписи, выдумать его нельзя. Хелпер подписывает
  // транзакции настоящим ключом и согласует с ним доверенный набор; тесты
  // продолжают говорить своими метками, маппинг живёт здесь.
  const wallet = await testWallet();
  vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);

  const realById = new Map<string, string>();
  const txs = [];
  for (const e of edges) {
    const tx = await buildSignedTx(
      JSON.stringify(payloads[e.txId] ?? {}),
      notesTags({ version: e.version, ownerHash: 'oh', noteId: e.noteId }),
      wallet,
    );
    realById.set(e.txId, tx.txId);
    txs.push(tx);
  }

  vi.stubGlobal('fetch', vi.fn(gatewayFetchMock({
    txs,
    pages: [edges.map((e, i) => ({
      txId: txs[i].txId,
      cursor: txs[i].txId,
      tags: [
        { name: 'App-Name', value: 'EternalNotes' },
        { name: 'App-Version', value: e.version },
        { name: 'Note-Id', value: e.noteId },
      ],
    }))],
  })));

  return { id: (label: string) => realById.get(label)! };
}

interface WireEntry {
  entryId: string;
  metaCiphertext: string; metaIv: string;
  secretCiphertext: string; secretIv: string;
}
const wire = (e: WireEntry) =>
  ({ id: e.entryId, mc: e.metaCiphertext, miv: e.metaIv, sc: e.secretCiphertext, siv: e.secretIv });

const ENTRY_INPUT = {
  title: 'GitHub', login: 'yoko', url: 'u', note: 'n', password: 'pw', files: [], rev: 1,
};

describe('fetchAllNotes v4 (safebox split envelope through restore)', () => {
  it('restores a v4 entry with its authenticated meta and createdAt', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry } = await import('./crypto');
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, ENTRY_INPUT);

    const gw = await stubGateway([{ txId: 'TXV4', version: '4', noteId: entry.entryId }], { TXV4: wire(entry) });
    const { fetchAllNotes } = await import('./arweave');
    const { notes, safeboxEntries, incomplete } = await fetchAllNotes('oh', keys);

    expect(incomplete).toBe(false);
    expect(notes).toHaveLength(0);                       // never mixed with notes
    expect(safeboxEntries).toHaveLength(1);
    expect(safeboxEntries[0].meta.title).toBe('GitHub');
    expect(safeboxEntries[0].encrypted.v).toBe(4);
    // createdAt comes from the AUTHENTICATED envelope `t`, not from any tag.
    expect(safeboxEntries[0].encrypted.createdAt).toBe(entry.createdAt);
    expect(safeboxEntries[0].txId).toBe(gw.id('TXV4'));
  });

  it('the decrypted SECRET never leaves the sweep (only ciphertext is carried out)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry } = await import('./crypto');
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, {
      ...ENTRY_INPUT, password: 'SUPER-SECRET-42',
    });
    await stubGateway([{ txId: 'TX1', version: '4', noteId: entry.entryId }], { TX1: wire(entry) });

    const { fetchAllNotes } = await import('./arweave');
    const { safeboxEntries } = await fetchAllNotes('oh', keys);
    expect(JSON.stringify(safeboxEntries)).not.toContain('SUPER-SECRET-42');
  });

  it('rejects a candidate whose SECRET half is corrupted — WHOLESALE (fail closed)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry, base64ToBuffer, bufferToBase64 } = await import('./crypto');
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, ENTRY_INPUT);
    const rotten = base64ToBuffer(entry.secretCiphertext);
    rotten[0] ^= 0xff;

    await stubGateway([{ txId: 'TXBAD', version: '4', noteId: entry.entryId }], {
      TXBAD: { ...wire(entry), sc: bufferToBase64(rotten) },
    });
    const { fetchAllNotes } = await import('./arweave');
    const { safeboxEntries, incomplete } = await fetchAllNotes('oh', keys);
    // An intact META half must NOT be enough: a half-readable entry would look
    // fine in the list and fail at the moment the user needs the password.
    expect(safeboxEntries).toHaveLength(0);
    expect(incomplete).toBe(false); // a validation skip is not a partial restore
  });

  it('a corrupted duplicate does NOT shadow an intact older copy of the same id', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry, base64ToBuffer, bufferToBase64 } = await import('./crypto');
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, {
      ...ENTRY_INPUT, title: 'ИСПРАВНАЯ',
    });
    const rotten = base64ToBuffer(entry.secretCiphertext);
    rotten[0] ^= 0xff;

    // HEIGHT_DESC order: the corrupted replay comes FIRST.
    const gw = await stubGateway(
      [
        { txId: 'TXNEW', version: '4', noteId: entry.entryId },
        { txId: 'TXOLD', version: '4', noteId: entry.entryId },
      ],
      {
        TXNEW: { ...wire(entry), sc: bufferToBase64(rotten) },
        TXOLD: wire(entry),
      },
    );
    const { fetchAllNotes } = await import('./arweave');
    const { safeboxEntries } = await fetchAllNotes('oh', keys);
    expect(safeboxEntries).toHaveLength(1);
    expect(safeboxEntries[0].txId).toBe(gw.id('TXOLD'));    // claim-after-decrypt
    expect(safeboxEntries[0].meta.title).toBe('ИСПРАВНАЯ');
  });

  it('rejects a v4 candidate whose outer id does not match the Note-Id tag', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry, randomUuidV8 } = await import('./crypto');
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, ENTRY_INPUT);
    const foreignId = randomUuidV8();
    await stubGateway([{ txId: 'TX1', version: '4', noteId: foreignId }], {
      TX1: { ...wire(entry), id: foreignId },
    });
    const { fetchAllNotes } = await import('./arweave');
    expect((await fetchAllNotes('oh', keys)).safeboxEntries).toHaveLength(0);
  });

  it('skips a malformed v4 payload shape (missing halves)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { randomUuidV8 } = await import('./crypto');
    const id = randomUuidV8();
    await stubGateway([{ txId: 'TX1', version: '4', noteId: id }], {
      TX1: { id, mc: 'AAAA', miv: 'AAAAAAAAAAAAAAAA' }, // no sc/siv
    });
    const { fetchAllNotes } = await import('./arweave');
    const { safeboxEntries, incomplete } = await fetchAllNotes('oh', keys);
    expect(safeboxEntries).toHaveLength(0);
    expect(incomplete).toBe(false);
  });

  it('routes notes and safebox entries into SEPARATE result lists in one sweep', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry, encryptEnvelopeV3 } = await import('./crypto');
    const note = await encryptEnvelopeV3(keys.note, 'заметка', { fmt: 'md', rev: 1 });
    const entry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, {
      ...ENTRY_INPUT, title: 'секрет',
    });

    await stubGateway(
      [
        { txId: 'TXN', version: '3', noteId: note.noteId },
        { txId: 'TXS', version: '4', noteId: entry.entryId },
      ],
      {
        TXN: { id: note.noteId, c: note.ciphertext, iv: note.iv },
        TXS: wire(entry),
      },
    );
    const { fetchAllNotes } = await import('./arweave');
    const { notes, safeboxEntries } = await fetchAllNotes('oh', keys);
    expect(notes.map(n => n.text)).toEqual(['заметка']);
    expect(safeboxEntries.map(e => e.meta.title)).toEqual(['секрет']);
  });

  it('a v4 entry is invisible to a keyring whose safebox keys are foreign', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const mine = await safeboxKeyring();
    const theirs = await safeboxKeyring();
    const { encryptSafeboxEntry } = await import('./crypto');
    const entry = await encryptSafeboxEntry(mine.safeboxMeta, mine.safeboxSecret, ENTRY_INPUT);
    await stubGateway([{ txId: 'TX1', version: '4', noteId: entry.entryId }], { TX1: wire(entry) });
    const { fetchAllNotes } = await import('./arweave');
    expect((await fetchAllNotes('oh', theirs)).safeboxEntries).toHaveLength(0);
  });
});

describe('buildSafeboxUploadPayload (wire shape)', () => {
  const ENTRY = {
    entryId: '11111111-2222-8333-8444-555555555555',
    metaCiphertext: 'MC', metaIv: 'MIV', secretCiphertext: 'SC', secretIv: 'SIV',
    createdAt: 5, v: 4 as const,
  };

  it('emits 5 tags and the split-envelope data object', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const { buildSafeboxUploadPayload } = await import('./arweave');
    const payload = buildSafeboxUploadPayload(ENTRY, 'OH', 1234);
    expect(payload.tags.map(t => t.name).sort()).toEqual(
      ['App-Name', 'App-Version', 'Content-Type', 'Note-Id', 'Owner-Hash']);
    expect(payload.tags.find(t => t.name === 'App-Version')?.value).toBe('4');
    // NO Timestamp tag and no `t` — the date lives inside the envelope.
    expect(JSON.parse(payload.data)).toEqual({
      id: ENTRY.entryId, mc: 'MC', miv: 'MIV', sc: 'SC', siv: 'SIV',
    });
    expect(payload.recheck).toBeUndefined();
  });

  it('attaches recheck + recovery only when asked', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const { buildSafeboxUploadPayload } = await import('./arweave');
    const hint = { txId: 'TX', postedAt: 1, token: 'tok' };
    expect(buildSafeboxUploadPayload(ENTRY, 'OH', 1, false, hint).recovery).toBeUndefined();
    expect(buildSafeboxUploadPayload(ENTRY, 'OH', 1, true, hint)).toMatchObject({
      recheck: true, recovery: hint,
    });
  });

  it('fails CLOSED on an unexpected record version', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const { buildSafeboxUploadPayload, UnsupportedSafeboxVersionError } = await import('./arweave');
    const bad = { ...ENTRY, v: 9 as unknown as 4 };
    expect(() => buildSafeboxUploadPayload(bad, 'OH', 1)).toThrow(UnsupportedSafeboxVersionError);
  });
});

describe('uploadViaProxy — v4 kill switch classification', () => {
  it('maps 503 {code:v4_uploads_disabled} to its own result kind', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'v4_uploads_disabled' }), { status: 503 })));
    const { uploadViaProxy } = await import('./arweave');
    expect((await uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('v4_disabled');
  });

  it('still maps the v3 code to v3_disabled and unknown codes to unavailable', async () => {
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'v3_uploads_disabled' }), { status: 503 })));
    let mod = await import('./arweave');
    expect((await mod.uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('v3_disabled');

    vi.resetModules();
    vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'something_else' }), { status: 503 })));
    mod = await import('./arweave');
    expect((await mod.uploadViaProxy('{}', 'pk', 'sig')).kind).toBe('unavailable');
  });
});
