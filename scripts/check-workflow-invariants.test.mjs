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
    environment: dev
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

describe('реестр co-deploy = env: шага подготовки', () => {
  it('каждый CO_DEPLOY_<NAME> в deploy-worker.yml есть в CO_DEPLOY_REGISTRY, и наоборот', async () => {
    const { CO_DEPLOY_REGISTRY } = await import('./require-co-deploy-secrets.mjs');
    const { load } = await import('js-yaml');
    const { readFileSync } = await import('node:fs');
    const doc = load(readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8'));
    const prep = (doc.jobs['deploy-worker'].steps ?? []).find(s => typeof s?.run === 'string' && s.run.includes('co-deploy-secrets.json') && s.env);
    expect(prep).toBeTruthy();
    const fromEnv = Object.keys(prep.env).filter(k => k.startsWith('CO_DEPLOY_')).map(k => k.slice('CO_DEPLOY_'.length)).sort();
    expect(fromEnv).toEqual([...CO_DEPLOY_REGISTRY].sort());
    expect(prep.run).toMatch(/node scripts\/require-co-deploy-secrets\.mjs/);
    expect(prep.run).not.toMatch(/read -ra/);
    // Every CO_DEPLOY_* env of the step is stripped from the Node process that parses the input.
    for (const k of Object.keys(prep.env).filter(k => k.startsWith('CO_DEPLOY_'))) {
      const call = prep.run.split(String.fromCharCode(10)).find(l => l.includes('node scripts/require-co-deploy-secrets.mjs'));
      expect(call).toBeTruthy();
      expect(call).toContain('env -u');
      expect(call.indexOf('env -u')).toBeLessThan(call.indexOf('node scripts/'));
      expect(call).toContain(k);
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
    environment: dev
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
    environment: dev
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
    environment: dev
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
    environment: dev
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
    environment: dev
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
    environment: dev
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
    environment: dev
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

describe('инвариант C: гейт-скрипт получает свою переменную', () => {
  const gate = (runLine, env = '') => `
name: t
on: workflow_dispatch
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - run: ${runLine}${env}
      - uses: cloudflare/wrangler-action@${SHA}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;
  const withEnv = (v) => `
        env:
          ${v}: \${{ vars.${v} }}`;

  // Ровно то, что уронило dispatch 5881da2: env: уехал на соседний шаг.
  it('check-gateways-vs-worker без VITE_STATUS_GATEWAYS — нарушение', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-gateways-vs-worker.mjs --config=x') },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(violations.join(' ')).toMatch(/check-gateways-vs-worker\.mjs without VITE_STATUS_GATEWAYS/);
  });

  it('та же команда с env: на шаге — проходит', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-gateways-vs-worker.mjs --config=x', withEnv('VITE_STATUS_GATEWAYS')) },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(violations).toEqual([]);
  });

  it('--repo-only не читает Environment — env: не требуется', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-trusted-owners.mjs --repo-only --config=x') },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(violations).toEqual([]);
  });

  it('check-trusted-owners без --repo-only и без VITE_TRUSTED_OWNERS — нарушение', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-trusted-owners.mjs --config=x') },
      { name: 'b.yml', content: CANONICAL },
    ]);
    expect(violations.join(' ')).toMatch(/check-trusted-owners\.mjs without VITE_TRUSTED_OWNERS/);
  });

  it('check-client-floor-gate без WORKER_FLOOR_SHA — нарушение', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-client-floor-gate.mjs') },
    ]);
    expect(violations.join(' ')).toMatch(/check-client-floor-gate\.mjs without WORKER_FLOOR_SHA/);
  });

  it('check-client-floor-gate с одной переменной из двух — нарушение по второй', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-client-floor-gate.mjs', withEnv('WORKER_FLOOR_SHA')) },
    ]);
    expect(violations.join(' ')).toMatch(/check-client-floor-gate\.mjs without WORKER_CANDIDATE_SHA/);
  });

  it('check-client-floor-gate не имеет режима --repo-only: флаг не освобождает от env', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-client-floor-gate.mjs --repo-only') },
    ]);
    expect(violations.join(' ')).toMatch(/check-client-floor-gate\.mjs without WORKER_FLOOR_SHA/);
  });

  it('check-client-floor-gate с обеими переменными — чисто', () => {
    const { violations } = run([
      { name: 'a.yml', content: gate('node scripts/check-client-floor-gate.mjs', withEnv('WORKER_FLOOR_SHA') + '\n          WORKER_CANDIDATE_SHA: ${{ inputs.worker_candidate }}') },
    ]);
    expect(violations.filter(v => v.includes('check-client-floor-gate'))).toEqual([]);
  });
});

// ── Инварианты D и E: секреты только под environment; --secrets-file готовится и удаляется ──

const SHA2 = 'ebbaa1584979971c8614a24965b4405ff95890e0';
/** Deploy-джоба с совместной активацией секретов; `mutate` меняет части фикстуры. */
const coDeploy = ({ environment = 'dev', prep = true, umask = true, cleanup = 'always()', path = '${{ runner.temp }}/co-deploy-secrets.json', leak = false, secretIn = 'env' } = {}) => `
name: t
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo tokenless
  deploy:
    runs-on: ubuntu-latest
${environment ? `    environment: ${environment}\n` : ''}    steps:
${prep ? `      - name: prep
        run: |
          set +x
          ${umask ? 'umask 077' : ''}
          FILE="$RUNNER_TEMP/co-deploy-secrets.json"
          jq -n --arg t "$CO_DEPLOY_CF_ANALYTICS_TOKEN" '{}' > "$FILE"
          ${leak ? 'cat "$FILE"' : 'echo "count=$(jq length "$FILE")"'}
        env:
          CO_DEPLOY_CF_ANALYTICS_TOKEN: \${{ secrets.CF_ANALYTICS_TOKEN }}
` : ''}      - uses: cloudflare/wrangler-action@${SHA2}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: deploy --var X:y --secrets-file ${path}${secretIn === 'command' ? ' --secret ${{ secrets.CF_ANALYTICS_TOKEN }}' : ''}
${cleanup ? `      - name: cleanup
        if: ${cleanup}
        run: rm -f "$RUNNER_TEMP/co-deploy-secrets.json"
` : ''}`;

describe('инвариант D: секреты только под environment и только в with.apiToken / env: run-шага', () => {
  it('каноническая совместная активация — ок', () => {
    const r = run([{ name: 'a.yml', content: coDeploy() }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations).toEqual([]);
  });

  it('секрет в джобе без environment — нарушение', () => {
    const r = run([{ name: 'a.yml', content: coDeploy({ environment: '' }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/outside an environment-bound job/);
  });

  it('секрет аргументом команды — нарушение', () => {
    const r = run([{ name: 'a.yml', content: coDeploy({ secretIn: 'command' }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/must be with.apiToken or env: of a run: step/);
  });
});

describe('инвариант E: --secrets-file под runner.temp, подготовлен в той же джобе, удалён всегда', () => {
  it('без шага подготовки — нарушение', () => {
    const r = run([{ name: 'a.yml', content: coDeploy({ prep: false }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/no earlier run: step in this job prepares co-deploy-secrets.json/);
  });

  it('без umask 077 — нарушение; печать файла — нарушение', () => {
    expect(run([{ name: 'a.yml', content: coDeploy({ umask: false }) }, { name: 'b.yml', content: CANONICAL }]).violations.join('\n')).toMatch(/umask 077/);
    expect(run([{ name: 'a.yml', content: coDeploy({ leak: true }) }, { name: 'b.yml', content: CANONICAL }]).violations.join('\n')).toMatch(/prints the secrets file/);
  });

  it('без очистки, или очистка не под if: always() — нарушение', () => {
    expect(run([{ name: 'a.yml', content: coDeploy({ cleanup: '' }) }, { name: 'b.yml', content: CANONICAL }]).violations.join('\n')).toMatch(/if: always\(\)/);
    expect(run([{ name: 'a.yml', content: coDeploy({ cleanup: 'success()' }) }, { name: 'b.yml', content: CANONICAL }]).violations.join('\n')).toMatch(/if: always\(\)/);
  });

  it('файл вне runner.temp — нарушение', () => {
    const r = run([{ name: 'a.yml', content: coDeploy({ path: 'candidate/secrets.json' }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/must point under \$\{\{ runner.temp \}\}/);
  });

  it('артефакт, который может унести файл секретов (сам файл, его каталог, runner.temp) — нарушение', () => {
    for (const path of ['${{ runner.temp }}/co-deploy-secrets.json', '${{ runner.temp }}', '$RUNNER_TEMP/']) {
      const content = coDeploy() + `      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: leak
          path: ${path}
`;
      const r = run([{ name: 'a.yml', content }, { name: 'b.yml', content: CANONICAL }]);
      expect(r.violations.join('\n')).toMatch(/uploads an artifact that could carry co-deploy-secrets.json/);
    }
    // An artifact of something else in the same job is fine.
    const ok = coDeploy() + `      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-identity
          path: release-identity.txt
`;
    expect(run([{ name: 'a.yml', content: ok }, { name: 'b.yml', content: CANONICAL }]).violations).toEqual([]);
  });
});

// ── Инвариант F: tokenless-джоба остаётся tokenless (проверяется по имени файла deploy-worker.yml) ──

const tokenless = ({ environment = false, secret = false, present = true } = {}) => `
name: t
on: workflow_dispatch
jobs:
${present ? `  test-candidate:
    runs-on: ubuntu-latest
${environment ? '    environment: dev\n' : ''}    steps:
      - run: npm test
${secret ? '        env:\n          X: \${{ secrets.CF_ANALYTICS_TOKEN }}\n' : ''}` : ''}  deploy-worker:
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: cloudflare/wrangler-action@${SHA2}
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;

describe('инвариант F: test-candidate без environment и без секретов', () => {
  it('чистая tokenless-джоба — ок', () => {
    expect(run([{ name: 'deploy-worker.yml', content: tokenless() }, { name: 'b.yml', content: CANONICAL }]).violations).toEqual([]);
  });

  it('environment у test-candidate — нарушение, даже если инвариант D доволен', () => {
    const r = run([{ name: 'deploy-worker.yml', content: tokenless({ environment: true }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/tokenless job test-candidate must not have an environment/);
  });

  it('секрет через env: в test-candidate под environment — нарушение F (D его пропустил бы)', () => {
    const r = run([{ name: 'deploy-worker.yml', content: tokenless({ environment: true, secret: true }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/tokenless job test-candidate references a secret/);
  });

  it('удалённая tokenless-джоба — нарушение (инвариант не может держаться над несуществующей джобой)', () => {
    const r = run([{ name: 'deploy-worker.yml', content: tokenless({ present: false }) }, { name: 'b.yml', content: CANONICAL }]);
    expect(r.violations.join('\n')).toMatch(/tokenless job test-candidate is missing/);
  });

  it('другой файл с джобой test-candidate под environment — инвариант F не применяется (только deploy-worker.yml)', () => {
    expect(run([{ name: 'other.yml', content: tokenless({ environment: true }) }, { name: 'b.yml', content: CANONICAL }]).violations).toEqual([]);
  });
});
