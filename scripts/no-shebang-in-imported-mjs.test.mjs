import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

// Shebang в ИМПОРТИРУЕМОМ .mjs — запрещён.
//
// Модуль, который прогонщик оборачивает в тело функции, не может начинаться с
// `#!`: V8 читает это как «Invalid or unexpected token», и файл перестаёт
// СОБИРАТЬСЯ. Тесты, которые его импортируют, тогда не падают — они молча
// исчезают из прогона. Так в PR #23 пропали 4 теста паритета derive-smoke-key;
// PR #24 убрал shebang и оставил в самом файле предупреждение не возвращать его.
//
// ВАЖНО про этот тест: на нынешней связке (vite 8 / vitest 3) shebang в
// derive-smoke-key.mjs воспроизвести НЕ удалось — модуль собирается, 4 теста
// проходят. То есть поломка зависит от версий инструментов и может вернуться
// так же тихо, как ушла. Поэтому тест сторожит не конкретный баг конкретной
// версии, а само правило: имя файла в выводе появится раньше, чем очередной
// прогонщик снова начнёт давиться `#!`.
//
// Правило: shebang можно держать только в файлах, которые НИКТО не импортирует
// (их запускают явным `node <путь>` — shebang там и не нужен).
// check-bundle-budget.mjs, check-staging-config.mjs, smoke-v3/v4.mjs — как раз
// такие CLI-точки входа, их shebang'и легитимны и тест их не трогает.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Чужой код и артефакты — обходить незачем; их модули мы не собираем.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', '.wrangler', 'coverage']);
const SOURCE_RE = /\.[mc]?[jt]sx?$/;

// `from '…'`, `import '…'`, `import('…')`, `export … from '…'` — со спецификатором .mjs.
const MJS_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+\.mjs)['"]/g;

function* walkSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkSources(join(dir, entry.name));
    } else if (SOURCE_RE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

/** Кто кого импортирует: абсолютный путь .mjs → файлы, которые его тянут. */
function collectImportedMjs() {
  const importers = new Map();
  let scanned = 0;

  for (const file of walkSources(ROOT)) {
    scanned++;
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(MJS_SPECIFIER_RE)) {
      // Только относительные пути: пакеты из node_modules собирает не vite-node.
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push(file);
    }
  }

  return { importers, scanned };
}

const rel = absolute => relative(ROOT, absolute).split(sep).join(posix.sep);

describe('нет shebang в импортируемых .mjs', () => {
  const { importers, scanned } = collectImportedMjs();

  // Сканер, который ничего не нашёл, «проходит» всегда — а значит, молча
  // перестаёт быть защитой. Эти два ассерта держат его живым.
  it('сканер действительно обошёл дерево и нашёл импорты .mjs', () => {
    expect(scanned).toBeGreaterThan(0);
    expect(importers.size).toBeGreaterThan(0);
  });

  it('ни один импортируемый .mjs не начинается с #!', () => {
    const offenders = [...importers]
      .filter(([target]) => readFileSync(target, 'utf8').startsWith('#!'))
      .map(([target, from]) => `${rel(target)} ← импортируется из ${from.map(rel).join(', ')}`);

    expect(
      offenders,
      'Shebang в импортируемом модуле ломает его сборку в vite-node: тесты, ' +
        'которые его импортируют, не упадут, а тихо исчезнут из прогона. ' +
        'Уберите `#!` — такие файлы всё равно запускают явным `node <путь>`.',
    ).toEqual([]);
  });
});
