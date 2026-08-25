// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  resetAll,
  setSyncRecord,
  getSyncRecord,
  saveNote,
  beginUploadUnlessTerminal,
  commitSyncUnlessTerminal,
  saveNoteWithSync,
  saveSafeboxEntryWithSync,
  mergeRestoredNote,
  mergeRestoredSafeboxEntry,
  getNoteById,
  getSafeboxEntryById,
  getDbGeneration,
  type SyncRecord,
} from './storage';
import { afterPoll, toRecoveryInvalidated } from './sync-transitions';

// §1.9: монотонность terminalError на границе записи (IndexedDB-уровень).
// Два уровня проверки:
//  1. последовательные сценарии — каждый исход по отдельности (ниже);
//  2. НАСТОЯЩИЕ конкурентные потоки (блок «конкурентные транзакции» в конце):
//     перекрывающиеся вызовы через Promise.all, где интерливинг задаётся
//     ПОРЯДКОМ СОЗДАНИЯ транзакций — IndexedDB исполняет транзакции с
//     пересекающимся scope в порядке создания, что даёт управляемый барьер:
//     pre-read restore (readonly, создан первым) → транзакция карантина →
//     readwrite restore. Это ровно TOCTOU-гонка из плана, без моков.

const NOW = 1_750_000_000_000;

const NOTE = { noteId: 'q-note', ciphertext: 'Y2lwaGVy', iv: 'AAAAAAAAAAAAAAAA', createdAt: NOW - 1000 };
const SB_ENTRY = {
  entryId: 'aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee',
  metaCiphertext: 'AAAA', metaIv: 'AAAAAAAAAAAAAAAA',
  secretCiphertext: 'BBBB', secretIv: 'AAAAAAAAAAAAAAAA',
  createdAt: NOW - 1000, v: 4 as const,
};

const quarantined = (
  noteId: string,
  reason: NonNullable<SyncRecord['terminalError']>,
  extra: Partial<SyncRecord> = {},
): SyncRecord => ({
  noteId, kind: 'note', status: 'error', transport: 'proxy',
  updatedAt: NOW - 500, terminalError: reason,
  txId: 'TX-EVIDENCE', recovery: { txId: 'TX-EVIDENCE', postedAt: NOW - 900, token: 'tok' },
  ...extra,
});

beforeEach(async () => {
  await initStorage();
  await resetAll();
});

describe('beginUploadUnlessTerminal', () => {
  it('без карантина: пишет uploading, построенный из СВЕЖЕЙ строки', async () => {
    const note = { ...NOTE, noteId: 'b1' };
    await saveNoteWithSync(note, {
      noteId: 'b1', kind: 'note', txId: 'TX-1', status: 'error', transport: 'proxy',
      updatedAt: NOW - 100, recovery: { txId: 'TX-1', postedAt: 1, token: 't' },
    });
    const began = await beginUploadUnlessTerminal('b1', { kind: 'note', record: note }, NOW);
    expect(began.ok).toBe(true);
    const row = (await getSyncRecord('b1'))!;
    expect(row.status).toBe('uploading');
    expect(row.txId).toBe('TX-1');                 // поля свежей строки сохранены
    expect(row.recovery?.token).toBe('t');
  });

  it('карантин: отказывает и НЕ пишет ничего (HTTP у вызывающего не будет)', async () => {
    const note = { ...NOTE, noteId: 'b2' };
    const q = quarantined('b2', 'recovery_invalidated');
    await saveNoteWithSync(note, q);
    // Карантин проверяется ДО чтения payload — отказ именно 'blocked'.
    expect(await beginUploadUnlessTerminal('b2', { kind: 'note', record: note }, NOW))
      .toEqual({ ok: false, reason: 'blocked' });
    expect(await getSyncRecord('b2')).toEqual(q);  // строка нетронута
  });

  it('отсутствующая строка: обычный первый uploading', async () => {
    const note = { ...NOTE, noteId: 'b3' };
    await saveNote(note); // payload есть, sync-строки нет
    const began = await beginUploadUnlessTerminal('b3', { kind: 'note', record: note }, NOW);
    expect(began.ok).toBe(true);
    expect((await getSyncRecord('b3'))?.status).toBe('uploading');
  });

  it('kind берётся из СНИМКА, а не из строки', async () => {
    const entry = { ...SB_ENTRY, entryId: 'bbbbbbbb-bbbb-8ccc-8ddd-eeeeeeeeeeee' };
    await saveSafeboxEntryWithSync(entry, {
      noteId: entry.entryId, kind: 'safebox', status: 'error', transport: 'proxy', updatedAt: NOW - 1,
    });
    const began = await beginUploadUnlessTerminal(entry.entryId, { kind: 'safebox', record: entry }, NOW);
    expect(began.ok).toBe(true);
    expect((await getSyncRecord(entry.entryId))?.kind).toBe('safebox');
  });
});

describe('commitSyncUnlessTerminal — карантин побеждает любой исход запроса', () => {
  it.each([
    ['accepted', (fresh: SyncRecord | undefined): SyncRecord => ({
      noteId: 'c1', kind: 'note', txId: 'TX-LATE', status: 'accepted',
      transport: 'proxy', updatedAt: NOW, needsRecheck: false, recovery: fresh?.recovery,
    })],
    ['ошибка/503', (fresh: SyncRecord | undefined): SyncRecord => ({
      noteId: 'c1', kind: 'note', txId: fresh?.txId, status: 'error',
      transport: 'proxy', lastError: '503', updatedAt: NOW,
    })],
  ])('поздний результат «%s» заблокирован, карантин цел', async (_label, build) => {
    const q = quarantined('c1', 'recovery_invalidated');
    await setSyncRecord(q);
    expect(await commitSyncUnlessTerminal('c1', build)).toBe('blocked');
    expect(await getSyncRecord('c1')).toEqual(q);
  });

  it('поздний afterPoll (confirmed и dropped) — карантин цел', async () => {
    const q = quarantined('c2', 'recovery_invalidated', { status: 'error' });
    await setSyncRecord(q);
    for (const status of [
      { kind: 'confirmed' as const, confirmations: 99, blockHeight: 1 },
      { kind: 'dropped' as const },
    ]) {
      const verdict = await commitSyncUnlessTerminal('c2', fresh =>
        fresh && fresh.status === 'accepted'
          ? afterPoll(fresh, status, NOW, 10, 60_000)
          : null);
      expect(verdict).toBe('blocked');
      expect(await getSyncRecord('c2')).toEqual(q);
    }
  });

  it('без карантина строит из СВЕЖЕЙ строки и применяет', async () => {
    await setSyncRecord({
      noteId: 'c3', kind: 'note', txId: 'TX-F', status: 'accepted',
      transport: 'proxy', updatedAt: NOW - 100,
    });
    const verdict = await commitSyncUnlessTerminal('c3', fresh => ({
      noteId: 'c3', kind: 'note', txId: fresh?.txId, status: 'confirmed',
      transport: 'proxy', updatedAt: NOW,
    }));
    expect(verdict).toBe('applied');
    expect((await getSyncRecord('c3'))?.txId).toBe('TX-F');
  });

  it('УСТАНОВКА карантина через тот же примитив: вторая причина не затирает первую', async () => {
    await setSyncRecord(quarantined('c4', 'malformed_record'));
    const verdict = await commitSyncUnlessTerminal('c4', fresh =>
      toRecoveryInvalidated('c4', 'note', fresh, 'late', NOW));
    expect(verdict).toBe('blocked');
    expect((await getSyncRecord('c4'))?.terminalError).toBe('malformed_record');
  });

  it('builder возвращает null — осознанный no-op, строка не тронута', async () => {
    const before: SyncRecord = {
      noteId: 'c5', kind: 'note', status: 'accepted', transport: 'proxy', updatedAt: NOW - 1,
    };
    await setSyncRecord(before);
    expect(await commitSyncUnlessTerminal('c5', () => null)).toBe('noop');
    expect(await getSyncRecord('c5')).toEqual(before);
  });
});

describe('restore-писатели: решение ПО ПРИЧИНЕ внутри транзакции', () => {
  const CONFIRMED: SyncRecord = {
    noteId: NOTE.noteId, kind: 'note', txId: 'TX-CHAIN', status: 'confirmed',
    transport: 'proxy', updatedAt: NOW,
  };

  it('recovery_invalidated СНИМАЕТСЯ: восстановление — доказательный путь', async () => {
    await setSyncRecord(quarantined(NOTE.noteId, 'recovery_invalidated'));
    // К моменту записи конвейер восстановления уже установил доверенного
    // владельца, аутентифицированный envelope и транзакцию в цепочке.
    await saveNoteWithSync(NOTE, CONFIRMED);
    const row = (await getSyncRecord(NOTE.noteId))!;
    expect(row.status).toBe('confirmed');
    expect(row.terminalError).toBeUndefined();
    expect(row.txId).toBe('TX-CHAIN');
    expect(await getNoteById(NOTE.noteId)).toBeTruthy();
  });

  it.each(['unsupported_version', 'malformed_record'] as const)(
    '%s СОХРАНЯЕТСЯ: payload записан, карантин остаётся',
    async reason => {
      await setSyncRecord(quarantined(NOTE.noteId, reason));
      await saveNoteWithSync(NOTE, CONFIRMED);
      const row = (await getSyncRecord(NOTE.noteId))!;
      expect(row.terminalError).toBe(reason);      // причина пережила restore
      expect(await getNoteById(NOTE.noteId)).toBeTruthy(); // upsert-repair состоялся
    },
  );

  it('гонка (заметка): карантин, поставленный ПОСЛЕ предварительного чтения mergeRestoredNote, сохраняется', async () => {
    // mergeRestoredNote читает sync ДО транзакции записи (точка приостановки).
    // Эквивалент гонки: карантин уже в базе к моменту транзакции — решает
    // перечитывание ВНУТРИ saveNoteWithSync, а не устаревшее чтение.
    await setSyncRecord(quarantined(NOTE.noteId, 'unsupported_version'));
    await mergeRestoredNote(NOTE, 'TX-CHAIN', NOW, getDbGeneration());
    expect((await getSyncRecord(NOTE.noteId))?.terminalError).toBe('unsupported_version');
  });

  it('гонка (сейф): malformed_record сохраняется при mergeRestoredSafeboxEntry', async () => {
    await setSyncRecord({ ...quarantined(SB_ENTRY.entryId, 'malformed_record'), kind: 'safebox' });
    await mergeRestoredSafeboxEntry(SB_ENTRY, 'TX-CHAIN', NOW, getDbGeneration());
    const row = (await getSyncRecord(SB_ENTRY.entryId))!;
    expect(row.terminalError).toBe('malformed_record');
    expect(await getSafeboxEntryById(SB_ENTRY.entryId)).toBeTruthy();
  });

  it('сейф: recovery_invalidated снимается restore-путём', async () => {
    await setSyncRecord({ ...quarantined(SB_ENTRY.entryId, 'recovery_invalidated'), kind: 'safebox' });
    await saveSafeboxEntryWithSync(SB_ENTRY, {
      noteId: SB_ENTRY.entryId, kind: 'safebox', txId: 'TX-SB', status: 'confirmed',
      transport: 'proxy', updatedAt: NOW,
    });
    const row = (await getSyncRecord(SB_ENTRY.entryId))!;
    expect(row.status).toBe('confirmed');
    expect(row.terminalError).toBeUndefined();
  });

  it('регресс: восстановление БЕЗ карантина по-прежнему даёт confirmed', async () => {
    await mergeRestoredNote(NOTE, 'TX-PLAIN', NOW, getDbGeneration());
    const row = (await getSyncRecord(NOTE.noteId))!;
    expect(row.status).toBe('confirmed');
    expect(row.txId).toBe('TX-PLAIN');
    expect(row.terminalError).toBeUndefined();
  });
});

// ─── Конкурентные транзакции: интерливинг по порядку создания ────────
//
// IndexedDB гарантирует: readwrite-транзакции с пересекающимся scope
// исполняются в порядке СОЗДАНИЯ. Вызов mergeRestoredNote синхронно создаёт
// readonly-транзакцию своего pre-read; созданная СЛЕДОМ транзакция карантина
// встаёт в очередь ПЕРЕД readwrite-транзакцией restore (та создаётся только
// после resolve pre-read). Это даёт детерминированный барьер ровно на TOCTOU-
// окне плана — двумя реально перекрывающимися асинхронными потоками.

describe('конкурентные транзакции (§1.9): карантин против restore', () => {
  it('гонка (заметка): карантин unsupported_version ставится МЕЖДУ pre-read и записью restore — сохраняется', async () => {
    // Пустая строка на старте: pre-read restore прочитает «карантина нет».
    const mergeP = mergeRestoredNote(NOTE, 'TX-RACE', NOW, getDbGeneration());
    const quarP = commitSyncUnlessTerminal(NOTE.noteId, fresh => ({
      noteId: NOTE.noteId, kind: 'note', txId: fresh?.txId, status: 'error',
      transport: 'proxy', updatedAt: NOW, terminalError: 'unsupported_version',
    }));
    await Promise.all([mergeP, quarP]);

    const row = (await getSyncRecord(NOTE.noteId))!;
    expect(row.terminalError).toBe('unsupported_version'); // карантин пережил гонку
    expect(await getNoteById(NOTE.noteId)).toBeTruthy();   // payload при этом записан
    // Отпечаток ИМЕННО целевого интерливинга: restore-писатель успел после
    // карантина и сохранил флаг поверх своей confirmed-строки. При вырожденном
    // порядке (карантин после мержа) строка была бы карантинной, status 'error'.
    expect(row.status).toBe('confirmed');
  });

  it('гонка (сейф): malformed_record между pre-read и записью — сохраняется', async () => {
    const mergeP = mergeRestoredSafeboxEntry(SB_ENTRY, 'TX-RACE', NOW, getDbGeneration());
    const quarP = commitSyncUnlessTerminal(SB_ENTRY.entryId, fresh => ({
      noteId: SB_ENTRY.entryId, kind: 'safebox', txId: fresh?.txId, status: 'error',
      transport: 'proxy', updatedAt: NOW, terminalError: 'malformed_record',
    }));
    await Promise.all([mergeP, quarP]);

    const row = (await getSyncRecord(SB_ENTRY.entryId))!;
    expect(row.terminalError).toBe('malformed_record');
    expect(await getSafeboxEntryById(SB_ENTRY.entryId)).toBeTruthy();
    expect(row.status).toBe('confirmed'); // отпечаток окна — см. тест заметки
  });

  it('гонка: recovery_invalidated, поставленный в TOCTOU-окно restore, корректно СНИМАЕТСЯ', async () => {
    // Тот же интерливинг, причина другая: для recovery_invalidated restore —
    // доказательный путь, и правило по причине применяется на перечитывании
    // ВНУТРИ readwrite-транзакции, а не на устаревшем pre-read.
    const mergeP = mergeRestoredNote(NOTE, 'TX-RACE2', NOW, getDbGeneration());
    const quarP = commitSyncUnlessTerminal(NOTE.noteId, fresh =>
      toRecoveryInvalidated(NOTE.noteId, 'note', fresh, 'late', NOW));
    await Promise.all([mergeP, quarP]);

    const row = (await getSyncRecord(NOTE.noteId))!;
    expect(row.terminalError).toBeUndefined();
    expect(row.status).toBe('confirmed');
  });

  it('перекрывающиеся begin-загрузки и карантин: в ЛЮБОМ порядке финал терминален и без uploading', async () => {
    for (const order of ['begin-first', 'quarantine-first'] as const) {
      const raceNote = { ...NOTE, noteId: 'race-b' };
      await saveNoteWithSync(raceNote, {
        noteId: 'race-b', kind: 'note', status: 'error', transport: 'proxy', updatedAt: NOW - 1,
      });
      const begin = () => beginUploadUnlessTerminal('race-b', { kind: 'note', record: raceNote }, NOW);
      const quarantine = () => commitSyncUnlessTerminal('race-b', fresh =>
        toRecoveryInvalidated('race-b', 'note', fresh, 'q', NOW));
      let beginRes: Awaited<ReturnType<typeof beginUploadUnlessTerminal>>;
      if (order === 'begin-first') {
        [beginRes] = await Promise.all([begin(), quarantine()]);
      } else {
        const [, b] = await Promise.all([quarantine(), begin()]);
        beginRes = b;
      }

      const row = (await getSyncRecord('race-b'))!;
      // Инвариант монотонности, независимый от победителя гонки: карантин
      // в финале стоит, строка не застряла в uploading. Если begin успел
      // раньше (true) — карантин лёг поверх uploading; если позже — begin
      // обязан был отказать.
      expect(row.terminalError).toBe('recovery_invalidated');
      expect(row.status).toBe('error');
      if (order === 'quarantine-first') expect(beginRes.ok).toBe(false);
      await resetAll();
    }
  });

  it('перекрывающийся поздний результат и карантин: в любом порядке финал — карантин', async () => {
    for (const order of ['result-first', 'quarantine-first'] as const) {
      await setSyncRecord({
        noteId: 'race-r', kind: 'note', txId: 'TX-1', status: 'uploading',
        transport: 'proxy', updatedAt: NOW - 1,
      });
      const lateResult = () => commitSyncUnlessTerminal('race-r', fresh => ({
        noteId: 'race-r', kind: 'note', txId: 'TX-LATE', status: 'accepted',
        transport: 'proxy', updatedAt: NOW, needsRecheck: false, recovery: fresh?.recovery,
      }));
      const quarantine = () => commitSyncUnlessTerminal('race-r', fresh =>
        toRecoveryInvalidated('race-r', 'note', fresh, 'q', NOW));
      await (order === 'result-first'
        ? Promise.all([lateResult(), quarantine()])
        : Promise.all([quarantine(), lateResult()]));

      const row = (await getSyncRecord('race-r'))!;
      expect(row.terminalError).toBe('recovery_invalidated');
      expect(row.status).toBe('error');
      await resetAll();
    }
  });
});

// ─── BFCache / заморозка вкладки ─────────────────────────────────────

describe('BFCache/заморозка (§1.9): удержанный результат не воскрешает строку', () => {
  it('continuation, пережившая заморозку, коммитит ПОСЛЕ карантина — блокируется', async () => {
    // Модель BFCache: вкладка ушла в фриз, держа в замыкании знание о своём
    // запросе (результат + намерение записать). Пока она стояла, другая
    // вкладка инвалидировала запись. Возврат из фриза = продолжение исполнения
    // с того же места — реальная приостановка на таймере, не пересказ.
    await setSyncRecord({
      noteId: 'bf-1', kind: 'note', txId: 'TX-1', status: 'uploading',
      transport: 'proxy', updatedAt: NOW - 1,
    });

    // «Вкладка B»: результат получен, continuation задержана заморозкой.
    const frozenCommit = (async () => {
      await new Promise(resolve => setTimeout(resolve, 40)); // фриз
      return commitSyncUnlessTerminal('bf-1', fresh => ({
        noteId: 'bf-1', kind: 'note', txId: 'TX-LATE', status: 'accepted',
        transport: 'proxy', updatedAt: NOW, needsRecheck: false, recovery: fresh?.recovery,
      }));
    })();

    // «Вкладка A»: пока B стоит, карантин устанавливается и коммитится.
    const quar = await commitSyncUnlessTerminal('bf-1', fresh =>
      toRecoveryInvalidated('bf-1', 'note', fresh, 'rotated', NOW));
    expect(quar).toBe('applied');

    // B размораживается и пытается дописать своё «accepted».
    expect(await frozenCommit).toBe('blocked');
    const row = (await getSyncRecord('bf-1'))!;
    expect(row.terminalError).toBe('recovery_invalidated');
    expect(row.txId).toBe('TX-1'); // строка карантина, не поздний TX-LATE
  });
});
