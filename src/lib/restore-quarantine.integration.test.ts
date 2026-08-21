// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';

// §1.9, интеграция: снятие карантина recovery_invalidated — привилегия
// ДОКАЗАТЕЛЬНОГО пути, то есть кандидата, которого restore-конвейер
// (fetchAllNotes) реально довёл до restore-писателя. Конвейер отбрасывает:
//  - повреждённый/неаутентифицированный envelope — расшифровка AES-GCM не
//    сходится (это и есть аутентификация: GCM-тег);
//  - чужого владельца — owners-фильтр зашит в сам GraphQL-запрос (закреплено
//    тестом «passes the pinned trusted owners…» в arweave.test.ts), поэтому
//    такой кандидат в выдачу не попадает вовсе.
// Здесь проверяется СЛЕДСТВИЕ для карантина: отброшенный кандидат оставляет
// terminalError на месте (вместе с txId-доказательствами), валидный — снимает.
//
// Цикл мержа — зеркало store.tsx (restore-sweep вызывает mergeRestoredNote /
// mergeRestoredSafeboxEntry по результату fetchAllNotes); если sweep меняет
// форму, обновить и этот цикл.

const OWNER_A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Storage = typeof import('./storage');

async function loadStorage(): Promise<Storage> {
  const storage = await import('./storage');
  await storage.initStorage();
  await storage.resetAll();
  return storage;
}

function quarantinedRow(storage: Storage, noteId: string, kind: 'note' | 'safebox') {
  return storage.setSyncRecord({
    noteId, kind, status: 'error', transport: 'proxy', updatedAt: 1,
    txId: 'TX-EVIDENCE', recovery: { txId: 'TX-EVIDENCE', postedAt: 1, token: 'tok' },
    terminalError: 'recovery_invalidated',
  });
}

/** GraphQL page + /raw payloads keyed by txId (as in arweave-v4.test.ts). */
function stubGateway(
  edges: Array<{ txId: string; version: string; noteId: string }>,
  payloads: Record<string, unknown>,
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/graphql')) {
      return new Response(JSON.stringify({ data: { transactions: {
        edges: edges.map(e => ({ cursor: e.txId, node: { id: e.txId, tags: [
          { name: 'App-Name', value: 'EternalNotes' },
          { name: 'App-Version', value: e.version },
          { name: 'Note-Id', value: e.noteId },
        ] } })),
        pageInfo: { hasNextPage: false },
      } } }), { status: 200 });
    }
    const txId = url.split('/raw/')[1];
    return new Response(JSON.stringify(payloads[txId]), { status: 200 });
  }));
}

/** Зеркало restore-цикла store.tsx: мержится ТОЛЬКО то, что конвейер вернул. */
async function runMergeLoop(
  storage: Storage,
  fetched: {
    notes: Array<{ encrypted: import('./crypto').EncryptedNote; txId: string }>;
    safeboxEntries: Array<{ encrypted: import('./crypto').EncryptedSafeboxEntry; txId: string }>;
  },
) {
  const now = Date.now();
  for (const remote of fetched.notes) {
    await storage.mergeRestoredNote(remote.encrypted, remote.txId, now, storage.getDbGeneration());
  }
  for (const remote of fetched.safeboxEntries) {
    await storage.mergeRestoredSafeboxEntry(remote.encrypted, remote.txId, now, storage.getDbGeneration());
  }
}

describe('restore-конвейер × карантин recovery_invalidated (заметки)', () => {
  it('повреждённый/неаутентифицированный envelope отброшен — карантин стоит', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const storage = await loadStorage();
    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const otherKey = await deriveKey(generateMnemonic());
    // Кандидат под ЧУЖИМ ключом: GCM-тег не сойдётся → конвейер отбросит.
    const foreign = await encryptEnvelope(otherKey, 'not yours');
    await quarantinedRow(storage, foreign.noteId, 'note');

    stubGateway([{ txId: 'TX-F', version: '2', noteId: foreign.noteId }],
      { 'TX-F': { id: foreign.noteId, c: foreign.ciphertext, iv: foreign.iv } });
    const { fetchAllNotes } = await import('./arweave');
    const fetched = await fetchAllNotes('oh', { note: key, safeboxMeta: key, safeboxSecret: key });
    expect(fetched.notes).toHaveLength(0); // конвейер не довёл кандидата

    await runMergeLoop(storage, fetched);
    const row = (await storage.getSyncRecord(foreign.noteId))!;
    expect(row.terminalError).toBe('recovery_invalidated'); // карантин стоит
    expect(row.txId).toBe('TX-EVIDENCE');                   // доказательства целы
  });

  it('чужой владелец не проходит owners-фильтр запроса — выдача пуста, карантин стоит', async () => {
    // Сам фильтр (owners: $owners в запросе и переменных) закреплён тестом в
    // arweave.test.ts; здесь — его следствие: шлюз, честно исполнивший фильтр,
    // не возвращает транзакцию чужого кошелька, и снимать карантин нечем.
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const storage = await loadStorage();
    const { deriveKey, generateMnemonic } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    await quarantinedRow(storage, '11111111-2222-8333-8444-555555555555', 'note');

    stubGateway([], {});
    const { fetchAllNotes } = await import('./arweave');
    const fetched = await fetchAllNotes('oh', { note: key, safeboxMeta: key, safeboxSecret: key });
    await runMergeLoop(storage, fetched);

    const row = (await storage.getSyncRecord('11111111-2222-8333-8444-555555555555'))!;
    expect(row.terminalError).toBe('recovery_invalidated');
  });

  it('валидный аутентифицированный кандидат доходит до писателя — карантин снят, запись confirmed', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const storage = await loadStorage();
    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const key = await deriveKey(generateMnemonic());
    const good = await encryptEnvelope(key, 'моя заметка');
    await quarantinedRow(storage, good.noteId, 'note');

    stubGateway([{ txId: 'TX-G', version: '2', noteId: good.noteId }],
      { 'TX-G': { id: good.noteId, c: good.ciphertext, iv: good.iv } });
    const { fetchAllNotes } = await import('./arweave');
    const fetched = await fetchAllNotes('oh', { note: key, safeboxMeta: key, safeboxSecret: key });
    expect(fetched.notes).toHaveLength(1);

    await runMergeLoop(storage, fetched);
    const row = (await storage.getSyncRecord(good.noteId))!;
    expect(row.terminalError).toBeUndefined(); // доказательный путь снял карантин
    expect(row.status).toBe('confirmed');
    expect(row.txId).toBe('TX-G');
    expect(await storage.getNoteById(good.noteId)).toBeTruthy(); // payload дошёл
  });
});

describe('restore-конвейер × карантин recovery_invalidated (сейф)', () => {
  async function safeboxKeyring() {
    const { generateMnemonic, deriveKey, deriveSafeboxMetaKey, deriveSafeboxSecretKey } = await import('./crypto');
    const mn = generateMnemonic();
    return {
      note: await deriveKey(mn),
      safeboxMeta: await deriveSafeboxMetaKey(mn),
      safeboxSecret: await deriveSafeboxSecretKey(mn),
    };
  }
  const ENTRY_INPUT = { title: 'GitHub', login: 'y', url: 'u', note: 'n', password: 'pw', files: [], rev: 1 };
  const wire = (e: { entryId: string; metaCiphertext: string; metaIv: string; secretCiphertext: string; secretIv: string }) =>
    ({ id: e.entryId, mc: e.metaCiphertext, miv: e.metaIv, sc: e.secretCiphertext, siv: e.secretIv });

  it('повреждённый envelope сейфа отброшен — карантин стоит', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const storage = await loadStorage();
    const keys = await safeboxKeyring();
    const foreignKeys = await safeboxKeyring(); // другой seed → другие ключи
    const { encryptSafeboxEntry } = await import('./crypto');
    const foreign = await encryptSafeboxEntry(foreignKeys.safeboxMeta, foreignKeys.safeboxSecret, ENTRY_INPUT);
    await quarantinedRow(storage, foreign.entryId, 'safebox');

    stubGateway([{ txId: 'TX-SF', version: '4', noteId: foreign.entryId }], { 'TX-SF': wire(foreign) });
    const { fetchAllNotes } = await import('./arweave');
    const fetched = await fetchAllNotes('oh', keys);
    expect(fetched.safeboxEntries).toHaveLength(0);

    await runMergeLoop(storage, fetched);
    const row = (await storage.getSyncRecord(foreign.entryId))!;
    expect(row.terminalError).toBe('recovery_invalidated');
    expect(row.txId).toBe('TX-EVIDENCE');
  });

  it('валидный кандидат сейфа снимает карантин', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const storage = await loadStorage();
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry } = await import('./crypto');
    const good = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, ENTRY_INPUT);
    await quarantinedRow(storage, good.entryId, 'safebox');

    stubGateway([{ txId: 'TX-SG', version: '4', noteId: good.entryId }], { 'TX-SG': wire(good) });
    const { fetchAllNotes } = await import('./arweave');
    const fetched = await fetchAllNotes('oh', keys);
    expect(fetched.safeboxEntries).toHaveLength(1);

    await runMergeLoop(storage, fetched);
    const row = (await storage.getSyncRecord(good.entryId))!;
    expect(row.terminalError).toBeUndefined();
    expect(row.status).toBe('confirmed');
    expect(await storage.getSafeboxEntryById(good.entryId)).toBeTruthy();
  });
});
