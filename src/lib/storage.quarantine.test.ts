// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  resetAll,
  setSyncRecord,
  getSyncRecord,
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
// Гонки «вкладка A поставила карантин, вкладка B дописала поздний результат»
// здесь эквивалентны последовательности «put карантина → вызов писателя»:
// оба примитива перечитывают строку ВНУТРИ своей readwrite-транзакции, и
// именно это перечитывание тестируется — предварительное чтение (как в
// mergeRestoredNote) точки приостановки больше не решает ничего.

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
    await setSyncRecord({
      noteId: 'b1', kind: 'note', txId: 'TX-1', status: 'error', transport: 'proxy',
      updatedAt: NOW - 100, recovery: { txId: 'TX-1', postedAt: 1, token: 't' },
    });
    expect(await beginUploadUnlessTerminal('b1', 'note', NOW)).toBe(true);
    const row = (await getSyncRecord('b1'))!;
    expect(row.status).toBe('uploading');
    expect(row.txId).toBe('TX-1');                 // поля свежей строки сохранены
    expect(row.recovery?.token).toBe('t');
  });

  it('карантин: отказывает и НЕ пишет ничего (HTTP у вызывающего не будет)', async () => {
    const q = quarantined('b2', 'recovery_invalidated');
    await setSyncRecord(q);
    expect(await beginUploadUnlessTerminal('b2', 'note', NOW)).toBe(false);
    expect(await getSyncRecord('b2')).toEqual(q);  // строка нетронута
  });

  it('отсутствующая строка: обычный первый uploading', async () => {
    expect(await beginUploadUnlessTerminal('b3', 'safebox', NOW)).toBe(true);
    expect((await getSyncRecord('b3'))?.kind).toBe('safebox');
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
