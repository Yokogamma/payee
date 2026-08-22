import { describe, it, expect } from 'vitest';
import {
  checkWorkflowInvariants,
  loadWorkflowFiles,
} from './check-workflow-invariants.mjs';

// Статический инвариант §1.7. Первый блок — интеграционный: РЕАЛЬНОЕ дерево
// .github/workflows/ обязано быть чистым, и именно этот тест делает инвариант
// частью каждого PR-прогона без правки ci.yml. Дальше — фикстуры по матрице
// плана: критерий семантический (идентификатор в любом синтаксисе), не
// привязка к канонической строке.

const SHA = 'ebbaa1584979971c8614a24965b4405ff95890e0';

/** Один воркфлоу с носителем токена в заданном виде. */
const carrier = (expr, uses = `cloudflare/wrangler-action@${SHA}`) => `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ${uses}
        with:
          apiToken: ${expr}
`;

const CANONICAL = carrier("${{ secrets.CLOUDFLARE_API_TOKEN }}");

const run = files => checkWorkflowInvariants(files);

describe('интеграция: реальные воркфлоу репозитория', () => {
  it('дерево .github/workflows чистое: ровно 2 носителя, оба легальные, ${{ }} в run: нет', () => {
    const result = run(loadWorkflowFiles('.github/workflows'));
    expect(result.violations).toEqual([]);
    expect(result.carriers).toHaveLength(2);
    for (const c of result.carriers) {
      expect(c.path[4]).toBe('with');
      expect(c.path[5]).toBe('apiToken');
    }
  });
});

describe('инвариант A: носители токена', () => {
  it('ровно два корректных носителя — ок', () => {
    expect(run([
      { name: 'a.yml', content: CANONICAL },
      { name: 'b.yml', content: CANONICAL },
    ])).toMatchObject({ ok: true });
  });

  it.each([
    ['без пробелов', '${{secrets.CLOUDFLARE_API_TOKEN}}'],
    ['bracket-нотация', "${{ secrets['CLOUDFLARE_API_TOKEN'] }}"],
  ])('эквивалентный синтаксис (%s) распознаётся как носитель', (_label, expr) => {
    const r = run([
      { name: 'a.yml', content: carrier(expr) },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(r).toMatchObject({ ok: true });
    expect(r.carriers).toHaveLength(2);
  });

  it('токен в env: шага — нарушение', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: cloudflare/wrangler-action@${SHA}
        env:
          TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        with:
          apiToken: x
`;
    const r = run([{ name: 'bad.yml', content: bad }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/outside with.apiToken/);
  });

  it('токен в env: job-уровня — нарушение', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - run: echo hi
`;
    const r = run([{ name: 'bad.yml', content: bad }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.ok).toBe(false);
  });

  it('токен в run: — нарушение обоих инвариантов', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy --token \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;
    const r = run([{ name: 'bad.yml', content: bad }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/outside with.apiToken/);
    expect(r.violations.join('\n')).toMatch(/inside run:/);
  });

  it('токен в ДРУГОМ входе with — нарушение', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: cloudflare/wrangler-action@${SHA}
        with:
          accountId: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          apiToken: x
`;
    const r = run([{ name: 'bad.yml', content: bad }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.ok).toBe(false);
  });

  it('упоминание в комментарии — ПРОХОДИТ (парсер выбрасывает комментарии)', () => {
    const withComment = `
name: t
# Requires repo secret: CLOUDFLARE_API_TOKEN (see docs)
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: cloudflare/wrangler-action@${SHA}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;
    const r = run([{ name: 'a.yml', content: withComment }, { name: 'b.yml', content: CANONICAL }]);
    expect(r).toMatchObject({ ok: true });
    expect(r.carriers).toHaveLength(2);
  });

  it('wrangler-action по ТЕГУ вместо 40-hex SHA — падает', () => {
    const r = run([
      { name: 'a.yml', content: carrier('${{ secrets.CLOUDFLARE_API_TOKEN }}', 'cloudflare/wrangler-action@v4.0.0') },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/pinned to a 40-hex SHA/);
  });

  it.each([
    [0, []],
    [1, [CANONICAL]],
    [3, [CANONICAL, CANONICAL, CANONICAL]],
  ])('%i носителя(ей) вместо двух — падает', (_n, contents) => {
    const files = contents.map((c, i) => ({ name: `f${i}.yml`, content: c }));
    const r = run(files);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/exactly 2 carriers/);
  });
});

describe('инвариант B: никаких ${{ }} внутри run:', () => {
  it('подстановка вывода шага в run: — нарушение', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - id: d
        uses: cloudflare/wrangler-action@${SHA}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      - run: node smoke.mjs "\${{ steps.d.outputs.url }}"
`;
    const r = run([{ name: 'bad.yml', content: bad }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toMatch(/inside run:/);
  });

  it('то же значение через env: + "$VAR" — проходит', () => {
    const good = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - id: d
        uses: cloudflare/wrangler-action@${SHA}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      - run: node smoke.mjs "$DEPLOY_URL"
        env:
          DEPLOY_URL: \${{ steps.d.outputs.url }}
`;
    expect(run([{ name: 'good.yml', content: good }, { name: 'b.yml', content: CANONICAL }]))
      .toMatchObject({ ok: true });
  });

  it('многострочный run: с выражением внутри — ловится', () => {
    const bad = `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo start
          curl "\${{ github.event.inputs.url }}"
`;
    const r = run([
      { name: 'bad.yml', content: bad },
      { name: 'a.yml', content: CANONICAL },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(r.ok).toBe(false);
  });
});
