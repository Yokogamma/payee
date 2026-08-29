import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSignedTx, gatewayFetchMock, notesTags, testWallet } from '../test-stubs/signed-tx';

// Фаза 1 инкрементального sweep'а: sentinel-модель известных кандидатов.
// Известный txId не скачивается, но ОСТАЁТСЯ в упорядоченном списке и занимает
// свой Note-Id в порядке блоков — семантика выбора дубликатов обязана быть
// побитово равна полному sweep'у (план eternal-notes-incremental-sweep-phase1,
// §6.1б; тесты 1–9).
// config.ts читает VITE_TRUSTED_OWNERS при загрузке модуля, поэтому каждый тест
// стабит env и импортирует arweave.ts заново (resetModules).

const OWNER_A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function ring(key: CryptoKey) {
  return { note: key, safeboxMeta: key, safeboxSecret: key };
}

async function noteKey(): Promise<CryptoKey> {
  const { deriveKey, generateMnemonic } = await import('./crypto');
  return deriveKey(generateMnemonic());
}

async function safeboxKeyring() {
  const { generateMnemonic, deriveKey, deriveSafeboxMetaKey, deriveSafeboxSecretKey } = await import('./crypto');
  const mn = generateMnemonic();
  return {
    note: await deriveKey(mn),
    safeboxMeta: await deriveSafeboxMetaKey(mn),
    safeboxSecret: await deriveSafeboxSecretKey(mn),
  };
}

/**
 * GraphQL-страница (порядок edges = HEIGHT_DESC) + подписанные payload'ы.
 *
 * Под D9 txId больше нельзя выдумать: он вычисляется из подписи. Поэтому
 * хелпер подписывает транзакции НАСТОЯЩИМ ключом, а тесты продолжают
 * оперировать своими метками ('TXKNOWN', 'TXFRESH', …) — маппинг в обе
 * стороны живёт здесь, и семантика sentinel-модели проверяется ровно тем же
 * набором утверждений, что и до PR-3a.
 */
async function stubGateway(
  edges: Array<{ txId: string; version: string; noteId: string }>,
  payloads: Record<string, unknown>,
) {
  const wallet = await testWallet();
  // Под D9 доверие проверяется по ПОДПИСАВШЕМУ кошельку, а не по метке в env,
  // поэтому доверенный набор согласуется с тем, чем реально подписаны фикстуры.
  // Тесты по-прежнему стабят VITE_TRUSTED_OWNERS выше — здесь оно уточняется.
  vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
  const realById = new Map<string, string>();   // метка → настоящий txId
  const labelById = new Map<string, string>();  // настоящий txId → метка
  const txs = [];

  for (const e of edges) {
    // Кандидат без payload'а имитирует недоступное тело: заголовок есть,
    // /raw отвечает 404 — как и в прежнем моке.
    const body = e.txId in payloads ? JSON.stringify(payloads[e.txId]) : '{}';
    const tx = await buildSignedTx(
      body,
      notesTags({ version: e.version, ownerHash: 'oh', noteId: e.noteId }),
      wallet,
    );
    realById.set(e.txId, tx.txId);
    labelById.set(tx.txId, e.txId);
    txs.push(tx);
  }

  const serve = gatewayFetchMock({
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
    onRaw: (_origin, txId) =>
      labelById.has(txId) && (labelById.get(txId)! in payloads)
        ? undefined
        : new Response('not found', { status: 404 }),
  });
  const fetchMock = vi.fn(serve);
  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    /** Настоящий txId по метке теста. */
    id: (label: string) => realById.get(label)!,
    /** Какие /raw запрашивались — В МЕТКАХ, чтобы утверждения не менялись. */
    rawCalls: () =>
      fetchMock.mock.calls
        .map(c => String(c[0]))
        .filter(u => u.includes('/raw/'))
        .map(u => labelById.get(u.split('/raw/')[1]) ?? u.split('/raw/')[1]),
    /** `known`-карта, построенная по меткам. */
    known: (...entries: Array<[string, { noteId: string; kind: 'note' | 'safebox' }]>) =>
      new Map(entries.map(([label, rec]) => [realById.get(label) ?? label, rec])),
  };
}

const v2wire = (n: { noteId: string; ciphertext: string; iv: string }) =>
  ({ id: n.noteId, c: n.ciphertext, iv: n.iv });

describe('инкрементальный sweep: пропуск известных txId (тесты 1–2, 5)', () => {
  it('известный txId: payload не запрашивается, запись не возвращается повторно, incomplete=false', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const note = await encryptEnvelope(key, 'уже есть локально');

    const gw = await stubGateway(
      [{ txId: 'TXKNOWN', version: '2', noteId: note.noteId }],
      { TXKNOWN: v2wire(note) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXKNOWN', { noteId: note.noteId, kind: 'note' }]),
    });

    expect(gw.rawCalls()).toEqual([]);   // тест 1: ни одного /raw
    expect(notes).toHaveLength(0);             // sentinel не возвращается как «новая»
    expect(incomplete).toBe(false);            // тест 5: пропуск — не partial
  });

  it('незнакомый txId скачивается и возвращается, известный рядом — нет', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const knownNote = await encryptEnvelope(key, 'старая');
    const freshNote = await encryptEnvelope(key, 'новая с другого устройства');

    const gw = await stubGateway(
      [
        { txId: 'TXFRESH', version: '2', noteId: freshNote.noteId },
        { txId: 'TXKNOWN', version: '2', noteId: knownNote.noteId },
      ],
      { TXFRESH: v2wire(freshNote), TXKNOWN: v2wire(knownNote) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXKNOWN', { noteId: knownNote.noteId, kind: 'note' }]),
    });

    expect(gw.rawCalls()).toEqual(['TXFRESH']);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('новая с другого устройства');
    expect(notes[0].txId).toBe(gw.id('TXFRESH'));
    expect(incomplete).toBe(false);
  });
});

describe('отставшие транзакции не теряются (тест 3)', () => {
  it('кандидат на высоте НИЖЕ всех известных всё равно скачивается и возвращается', async () => {
    // Регрессионный сторож: тест падает, если кто-нибудь введёт отсечение по
    // высоте («дальше известного не смотрим») вместо пропуска по txId.
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const known1 = await encryptEnvelope(key, 'известная сверху');
    const known2 = await encryptEnvelope(key, 'известная в середине');
    const straggler = await encryptEnvelope(key, 'отставшая — попала в блок позже соседей');

    const gw = await stubGateway(
      [
        // HEIGHT_DESC: отставшая — ПОСЛЕДНЯЯ (самый низкий блок).
        { txId: 'TXK1', version: '2', noteId: known1.noteId },
        { txId: 'TXK2', version: '2', noteId: known2.noteId },
        { txId: 'TXSTRAGGLER', version: '2', noteId: straggler.noteId },
      ],
      { TXSTRAGGLER: v2wire(straggler) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(
        ['TXK1', { noteId: known1.noteId, kind: 'note' }],
        ['TXK2', { noteId: known2.noteId, kind: 'note' }],
      ),
    });

    expect(gw.rawCalls()).toEqual(['TXSTRAGGLER']);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('отставшая — попала в блок позже соседей');
  });
});

describe('прогресс (тест 4)', () => {
  it('знаменатель — только незнакомые кандидаты', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const known = await encryptEnvelope(key, 'известная');
    const fresh1 = await encryptEnvelope(key, 'новая 1');
    const fresh2 = await encryptEnvelope(key, 'новая 2');

    const gw = await stubGateway(
      [
        { txId: 'TXF1', version: '2', noteId: fresh1.noteId },
        { txId: 'TXKNOWN', version: '2', noteId: known.noteId },
        { txId: 'TXF2', version: '2', noteId: fresh2.noteId },
      ],
      { TXF1: v2wire(fresh1), TXF2: v2wire(fresh2) },
    );

    const progress: Array<[number, number]> = [];
    const { fetchAllNotes } = await import('./arweave');
    await fetchAllNotes('oh', ring(key), (d, t) => progress.push([d, t]), {
      known: gw.known(['TXKNOWN', { noteId: known.noteId, kind: 'note' }]),
    });

    // Все события — со знаменателем 2 (незнакомые), последний done === 2.
    expect(progress.length).toBe(2);
    expect(progress.every(([, t]) => t === 2)).toBe(true);
    expect(progress[progress.length - 1][0]).toBe(2);
  });

  it('полностью известная выборка: событий прогресса НЕТ (нормативно)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const a = await encryptEnvelope(key, 'а');
    const b = await encryptEnvelope(key, 'б');

    const gw = await stubGateway(
      [
        { txId: 'TXA', version: '2', noteId: a.noteId },
        { txId: 'TXB', version: '2', noteId: b.noteId },
      ],
      {},
    );

    const progress: Array<[number, number]> = [];
    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), (d, t) => progress.push([d, t]), {
      known: gw.known(
        ['TXA', { noteId: a.noteId, kind: 'note' }],
        ['TXB', { noteId: b.noteId, kind: 'note' }],
      ),
    });

    expect(progress).toEqual([]);
    expect(notes).toHaveLength(0);
    expect(incomplete).toBe(false);
  });
});

describe('отказы сети (тесты 6–7)', () => {
  it('сбой payload НЕЗНАКОМОГО txId → incomplete=true, известные при этом не качаются', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const known = await encryptEnvelope(key, 'известная');
    const fresh = await encryptEnvelope(key, 'недоступная сейчас');

    // /raw для TXFRESH отдаёт 404 (payloads без ключа).
    const gw = await stubGateway(
      [
        { txId: 'TXFRESH', version: '2', noteId: fresh.noteId },
        { txId: 'TXKNOWN', version: '2', noteId: known.noteId },
      ],
      {},
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXKNOWN', { noteId: known.noteId, kind: 'note' }]),
    });

    expect(incomplete).toBe(true);              // реальная запись могла не доехать
    expect(notes).toHaveLength(0);
    expect(gw.rawCalls()).toEqual(['TXFRESH']);
  });

  it('падение ПЕРВОЙ страницы без отмены → ArweaveIndexUnavailableError (регрессия Фазы 0)', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const { fetchAllNotes, ArweaveIndexUnavailableError } = await import('./arweave');
    const key = await noteKey();
    await expect(
      fetchAllNotes('oh', ring(key), undefined, { known: new Map() }),
    ).rejects.toBeInstanceOf(ArweaveIndexUnavailableError);
  });
});

describe('сейф v4 (тест 8)', () => {
  const ENTRY_INPUT = {
    title: 'GitHub', login: 'yoko', url: 'u', note: 'n', password: 'pw', files: [], rev: 1,
  };
  const wire = (e: {
    entryId: string; metaCiphertext: string; metaIv: string;
    secretCiphertext: string; secretIv: string;
  }) => ({ id: e.entryId, mc: e.metaCiphertext, miv: e.metaIv, sc: e.secretCiphertext, siv: e.secretIv });

  it('известный v4-txId пропущен, незнакомый v4 скачан, расшифрован в обеих половинах и слит', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const keys = await safeboxKeyring();
    const { encryptSafeboxEntry } = await import('./crypto');
    const knownEntry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, {
      ...ENTRY_INPUT, title: 'ИЗВЕСТНАЯ',
    });
    const freshEntry = await encryptSafeboxEntry(keys.safeboxMeta, keys.safeboxSecret, {
      ...ENTRY_INPUT, title: 'НОВАЯ',
    });

    const gw = await stubGateway(
      [
        { txId: 'TXSFRESH', version: '4', noteId: freshEntry.entryId },
        { txId: 'TXSKNOWN', version: '4', noteId: knownEntry.entryId },
      ],
      { TXSFRESH: wire(freshEntry), TXSKNOWN: wire(knownEntry) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { safeboxEntries, incomplete } = await fetchAllNotes('oh', keys, undefined, {
      known: gw.known(['TXSKNOWN', { noteId: knownEntry.entryId, kind: 'safebox' }]),
    });

    expect(gw.rawCalls()).toEqual(['TXSFRESH']);
    expect(safeboxEntries).toHaveLength(1);
    expect(safeboxEntries[0].meta.title).toBe('НОВАЯ');
    expect(incomplete).toBe(false);
  });
});

describe('дубликаты по Note-Id: sentinel-семантика (тест 9)', () => {
  it('(а) незнакомый дубликат НИЖЕ известного не скачивается и не сливается', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const note = await encryptEnvelope(key, 'redrop-пара');

    const gw = await stubGateway(
      [
        // HEIGHT_DESC: известный (новый) TX выше, старый уцелевший дубликат ниже.
        { txId: 'TXNEW', version: '2', noteId: note.noteId },
        { txId: 'TXOLD', version: '2', noteId: note.noteId },
      ],
      { TXNEW: v2wire(note), TXOLD: v2wire(note) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXNEW', { noteId: note.noteId, kind: 'note' }]),
    });

    expect(gw.rawCalls()).toEqual([]); // дубликат ниже sentinel'а — ноль загрузок
    expect(notes).toHaveLength(0);
    expect(incomplete).toBe(false);
  });

  it('(б) незнакомый дубликат ВЫШЕ известного скачивается и побеждает claim — принятый redrop-остаток', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const note = await encryptEnvelope(key, 'перевыложенная');

    const gw = await stubGateway(
      [
        { txId: 'TXNEWER', version: '2', noteId: note.noteId },
        { txId: 'TXKNOWN', version: '2', noteId: note.noteId },
      ],
      { TXNEWER: v2wire(note), TXKNOWN: v2wire(note) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXKNOWN', { noteId: note.noteId, kind: 'note' }]),
    });

    // Более новый TX побеждает, как в полном sweep'е. Обновление sync-записи —
    // дело merge на стороне store (confirmed сохраняет свой txId), поэтому на
    // СЛЕДУЮЩЕМ sweep'е TXNEWER снова будет незнакомым и снова скачается:
    // принятый остаток (план §3), зафиксированный здесь как ожидаемый.
    expect(gw.rawCalls()).toEqual(['TXNEWER']);
    expect(notes).toHaveLength(1);
    expect(notes[0].txId).toBe(gw.id('TXNEWER'));
  });

  it('(в) совпал только txId: чужой Note-Id тег или чужой класс версии — кандидат НЕ известен', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const noteA = await encryptEnvelope(key, 'тег не совпал');
    const noteB = await encryptEnvelope(key, 'класс версии не совпал');

    const gw = await stubGateway(
      [
        { txId: 'TXMISMATCH', version: '2', noteId: noteA.noteId },
        { txId: 'TXWRONGKIND', version: '2', noteId: noteB.noteId },
      ],
      { TXMISMATCH: v2wire(noteA), TXWRONGKIND: v2wire(noteB) },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(
        // Битая sync-запись: txId совпал, но noteId в ней — другой.
        ['TXMISMATCH', { noteId: 'совсем-другой-id', kind: 'note' }],
        // Запись сейфа не может объявить известным TX с версией заметки.
        ['TXWRONGKIND', { noteId: noteB.noteId, kind: 'safebox' }],
      ),
    });

    expect(gw.rawCalls().sort()).toEqual(['TXMISMATCH', 'TXWRONGKIND']);
    expect(notes.map(n => n.text).sort()).toEqual(['класс версии не совпал', 'тег не совпал']);
  });

  it('(г) fallback claim-after-decrypt поверх sentinel: новый дубликат бит → id занимает sentinel', async () => {
    vi.stubEnv('VITE_TRUSTED_OWNERS', OWNER_A);
    const key = await noteKey();
    const { deriveKey, generateMnemonic, encryptEnvelope } = await import('./crypto');
    const note = await encryptEnvelope(key, 'исправная известная');
    // «Битый» новый дубликат: шифротекст под чужим ключом с тем же внешним id.
    const foreignKey = await deriveKey(generateMnemonic());
    const rotten = await encryptEnvelope(foreignKey, 'мусор');

    const gw = await stubGateway(
      [
        { txId: 'TXROTTEN', version: '2', noteId: note.noteId },  // новее, не расшифруется
        { txId: 'TXKNOWN', version: '2', noteId: note.noteId },   // sentinel
        { txId: 'TXOLD', version: '2', noteId: note.noteId },     // ниже sentinel'а
      ],
      {
        TXROTTEN: { id: note.noteId, c: rotten.ciphertext, iv: rotten.iv },
        TXOLD: v2wire(note),
      },
    );

    const { fetchAllNotes } = await import('./arweave');
    const { notes, incomplete } = await fetchAllNotes('oh', ring(key), undefined, {
      known: gw.known(['TXKNOWN', { noteId: note.noteId, kind: 'note' }]),
    });

    // Битый скачался (он выше и незнаком) и intentional-skip'нулся; ниже
    // sentinel'а не скачивалось ничего; merge нет; провала sweep'а нет.
    expect(gw.rawCalls()).toEqual(['TXROTTEN']);
    expect(notes).toHaveLength(0);
    expect(incomplete).toBe(false);
  });
});
