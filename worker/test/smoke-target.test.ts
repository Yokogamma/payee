import { describe, it, expect } from 'vitest';
// Plain-JS operator script module; worker tsconfig typechecks src/ only, and
// vitest bundles the .mjs import directly.
import {
  classifySmokeTarget,
  AUTO_ALLOWED_WORKER_ORIGINS,
} from '../scripts/smoke-target.mjs';

// Матрица §1.5: смоуки постят РЕАЛЬНЫЕ платные транзакции, поэтому цель
// классифицируется fail-closed по ПОЛНОМУ URL. Автосписок содержит только
// origin'ы ВОРКЕРА — клиентский Pages-origin не обслуживает /health и /upload.
const DEV_WORKER = 'https://eternal-notes-proxy.sopi-88c.workers.dev';

describe('classifySmokeTarget — автосписок и локальные цели', () => {
  it('репо-пиннинг: dev-воркер стоит в автосписке', () => {
    expect(AUTO_ALLOWED_WORKER_ORIGINS).toContain(DEV_WORKER);
  });

  it.each(['http://localhost:8787', 'http://127.0.0.1:8787'])(
    'локальный wrangler dev разрешён: %s',
    url => {
      const r = classifySmokeTarget(url);
      expect(r).toMatchObject({ ok: true });
      if (r.ok) expect(r.origin).toBe(new URL(url).origin);
    },
  );

  it('dev-воркер — штатная цель, без флага и без предупреждения', () => {
    const r = classifySmokeTarget(DEV_WORKER);
    expect(r).toMatchObject({ ok: true, origin: DEV_WORKER });
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it('IPv6-loopback НЕ в списке литералов — отказ (задокументированное ожидание)', () => {
    expect(classifySmokeTarget('http://[::1]:8787')).toMatchObject({ ok: false });
  });
});

describe('classifySmokeTarget — http', () => {
  it('удалённый http отклоняется: сам dev-воркер по http — отказ', () => {
    const httpDev = DEV_WORKER.replace('https://', 'http://');
    expect(classifySmokeTarget(httpDev)).toMatchObject({ ok: false });
  });

  it('удалённый http отклоняется ДАЖЕ с совпадающим разрешением', () => {
    const r = classifySmokeTarget('http://example.com', 'http://example.com');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/plaintext|http/i);
  });
});

describe('classifySmokeTarget — неизвестные https-цели требуют точного origin-разрешения', () => {
  // Pages-клиент — не ложная цель, а ВООБЩЕ не цель; допустим только через
  // явное точное разрешение, если кто-то намеренно проверяет именно его.
  const NEEDS_GRANT = [
    'https://notes.matamata.dev',
    // прежний шаблон *staging* был fail-open: чужой домен со словом staging
    // получал право публиковать платные транзакции без подтверждения
    'https://staging.evil.example',
    'https://production-staging.attacker.example',
    // ловушка на суффикс без границы метки
    'https://evilmatamata.app',
    'https://matamata.app',
    'https://dev.matamata.app',
  ];

  it.each(NEEDS_GRANT)('%s — отказ без SMOKE_ALLOW_ORIGIN', url => {
    expect(classifySmokeTarget(url)).toMatchObject({ ok: false });
  });

  it.each(NEEDS_GRANT)('%s — разрешено с ТЕМ ЖЕ origin, с предупреждением', url => {
    const r = classifySmokeTarget(url, url);
    expect(r).toMatchObject({ ok: true, origin: url });
    if (r.ok) expect(r.warning).toMatch(/SMOKE_ALLOW_ORIGIN/);
  });

  it('залежавшееся разрешение НЕ переносится на другую цель', () => {
    const r = classifySmokeTarget('https://staging.evil.example', 'https://notes.matamata.dev');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/does not match/);
  });

  it('точный staging-воркер сейчас требует разрешения (внести в список при провижининге)', () => {
    // Значение станет известно при первом деплое staging-воркера; до этого
    // штатный staging-смоук честно требует явного SMOKE_ALLOW_ORIGIN.
    const staging = 'https://eternal-notes-proxy-staging.sopi-88c.workers.dev';
    expect(classifySmokeTarget(staging)).toMatchObject({ ok: false });
    expect(classifySmokeTarget(staging, staging)).toMatchObject({ ok: true });
  });
});

describe('classifySmokeTarget — origin, а не хост', () => {
  it('разрешение на example.com не открывает example.com:8443 (другой origin)', () => {
    const r = classifySmokeTarget('https://example.com:8443', 'https://example.com');
    expect(r).toMatchObject({ ok: false });
  });

  it('нестандартный порт разрешается только точным совпадением origin', () => {
    const r = classifySmokeTarget('https://example.com:8443', 'https://example.com:8443');
    expect(r).toMatchObject({ ok: true, origin: 'https://example.com:8443' });
  });

  it('https://host и https://host:443 эквивалентны — URL.origin нормализует стандартный порт', () => {
    // Фиксируем тестом, чтобы это было решением, а не случайностью.
    const a = classifySmokeTarget(`${DEV_WORKER}:443`);
    expect(a).toMatchObject({ ok: true, origin: DEV_WORKER });
    const b = classifySmokeTarget('https://example.com:443', 'https://example.com');
    expect(b).toMatchObject({ ok: true, origin: 'https://example.com' });
  });
});

describe('classifySmokeTarget — нормализация цели', () => {
  it.each([
    [`${DEV_WORKER}/some/path`, 'путь'],
    [`${DEV_WORKER}/?q=1`, 'query'],
    [`${DEV_WORKER}/#hash`, 'hash'],
  ])('%s — отказ (%s): pathname обязан быть "/", search и hash пусты', url => {
    expect(classifySmokeTarget(url)).toMatchObject({ ok: false });
  });

  it('credentials в цели запрещены', () => {
    const withCreds = DEV_WORKER.replace('https://', 'https://user:pass@');
    expect(classifySmokeTarget(withCreds)).toMatchObject({ ok: false });
  });

  it('голый origin с завершающим "/" — это pathname "/", разрешено', () => {
    expect(classifySmokeTarget(`${DEV_WORKER}/`)).toMatchObject({ ok: true, origin: DEV_WORKER });
  });

  it('невалидный URL — отказ', () => {
    expect(classifySmokeTarget('not a url')).toMatchObject({ ok: false });
  });

  it('запросы строятся от разрешённого origin: /health и /upload резолвятся корректно', () => {
    // Скрипты обязаны делать new URL('/upload', origin), а не клеить строку —
    // здесь фиксируем, что возвращённый origin даёт правильные адреса.
    const r = classifySmokeTarget(DEV_WORKER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(new URL('/health', r.origin).href).toBe(`${DEV_WORKER}/health`);
      expect(new URL('/upload', r.origin).href).toBe(`${DEV_WORKER}/upload`);
    }
  });

  it('разрешение с мусором (путь/креды/query) — отказ, а не тихая нормализация', () => {
    const target = 'https://example.com';
    expect(classifySmokeTarget(target, 'https://example.com/some/path')).toMatchObject({ ok: false });
    expect(classifySmokeTarget(target, 'https://u:p@example.com')).toMatchObject({ ok: false });
    // Завершающий "/" — это по-прежнему bare origin, допускаем.
    expect(classifySmokeTarget(target, 'https://example.com/')).toMatchObject({ ok: true });
  });
});
