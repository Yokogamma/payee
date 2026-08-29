import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

// §1.9, инвентаризация: ВСЕ прямые записи в стор `sync` перечислены и учтены.
//
// Монотонность terminalError держится на том, что обычные писатели ходят через
// beginUploadUnlessTerminal / commitSyncUnlessTerminal (или через
// terminal-preserving commitPausedFailure), а restore-писатели применяют
// правило по причине внутри своей транзакции. Один новый «удобный»
// setSyncRecord в обход примитивов — и карантин снова стираем last-write-wins.
// Этот тест ловит такое дополнение на PR, а не на инциденте.
//
// Правило: появление нового вызова требует ОСОЗНАННОГО обновления списка ниже
// вместе с ответом на вопрос «почему этому писателю можно».

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', '.wrangler', 'coverage']);
const SOURCE_RE = /\.[mc]?[jt]sx?$/;

function* walkSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkSources(join(dir, entry.name));
    } else if (SOURCE_RE.test(entry.name) && !entry.name.includes('.test.')) {
      yield join(dir, entry.name);
    }
  }
}

const rel = (absolute: string) => relative(ROOT, absolute).split(sep).join(posix.sep);

/** file → count of occurrences per pattern (comments are NOT stripped — an
 *  occurrence in a comment is cheap to allow explicitly and keeps the scanner
 *  simple enough to audit at a glance). */
function countOccurrences(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walkSources(ROOT)) {
    const source = readFileSync(file, 'utf8');
    const matches = source.match(pattern);
    if (matches && matches.length > 0) found[rel(file)] = matches.length;
  }
  return found;
}

describe('инвентаризация писателей стора sync', () => {
  it("прямой put('sync'…) существует только внутри storage.ts", () => {
    // Все транзакционные записи (примитивы §1.9, restore-писатели,
    // commitPausedFailure) живут в storage.ts — там их охраняют перечитывание
    // строки и правило по причине.
    const puts = countOccurrences(/objectStore\('sync'\)|put\('sync'/g);
    expect(Object.keys(puts)).toEqual(['lib/storage.ts']);
  });

  it('setSyncRecord вызывается только из перечисленных мест', () => {
    const calls = countOccurrences(/\bsetSyncRecord\(/g);
    // storage.ts — определение (+ упоминания в комментариях примитивов);
    // НИ ОДНОГО вызова из store.tsx или upload-flow.ts: обычные пути обязаны
    // ходить через terminal-preserving примитивы. Прямой вызов остаётся
    // легальным только в тестах (сеттинг фикстур), которые сканер пропускает.
    expect(calls).toEqual({ 'lib/storage.ts': 1 });
  });

  it('путь загрузки НЕ использует безусловный commitSyncUnlessTerminal (D14a)', () => {
    // Результат попытки применяется ТОЛЬКО через commitUploadResultIfAttempt:
    // он сверяет attemptId и отбрасывает ответ зависшей отправки, за время
    // которой строку успел забрать другой писатель. commitSyncUnlessTerminal
    // остаётся законным для poll-путей и постановки карантина — у них своей
    // попытки нет, — но в upload-flow.ts его быть не должно вовсе: один
    // «удобный» вызов там возвращает ровно тот дефект, ради которого введён
    // attemptId.
    const calls = countOccurrences(/commitSyncUnlessTerminal\(/g);
    expect(calls['lib/upload-flow.ts']).toBeUndefined();
    // И наоборот: сам примитив существует и объявлен в storage.ts.
    const attemptWriter = countOccurrences(/commitUploadResultIfAttempt\(/g);
    expect(Object.keys(attemptWriter).sort()).toEqual(['lib/storage.ts', 'lib/store.tsx']);
  });

  it('импорт бэкапа пишет sync ТОЛЬКО через свой транзакционный примитив', () => {
    // mergeBackupRecord — единственный писатель на пути импорта: он
    // перечитывает строку, сверяет снимок синхронно (D13) и применяет чистое
    // решение из backup-merge.ts. Правила в отдельном модуле намеренно НЕ
    // умеют писать: у них нет доступа к базе, поэтому «удобный» обход
    // примитива потребовал бы новой транзакции, а её здесь видно.
    const writer = countOccurrences(/mergeBackupRecord\(/g);
    expect(Object.keys(writer)).toContain('lib/storage.ts');
    const rules = countOccurrences(/objectStore\(|getDB\(/g);
    expect(rules['lib/backup-merge.ts']).toBeUndefined();
  });

  it('сканер жив: исходники реально обойдены', () => {
    // Пустой результат «всё чисто» без обхода — это не защита. Проверяем, что
    // дерево видит и storage.ts, и store.tsx.
    const files = [...walkSources(ROOT)].map(rel);
    expect(files).toContain('lib/storage.ts');
    expect(files).toContain('lib/store.tsx');
    expect(files.length).toBeGreaterThan(20);
  });
});
