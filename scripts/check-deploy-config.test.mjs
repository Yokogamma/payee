import { describe, it, expect } from 'vitest';
import { checkDeployConfig, DEPLOY_VARS, EXPECTED } from './check-deploy-config.mjs';
import { AUTO_ALLOWED_WORKER_ORIGINS } from '../worker/scripts/smoke-target.mjs';

// Ранний конфиг-гейт §1.7: наличие/непустота несекретных variables + сверка
// с закоммиченными ожиданиями. Токен скрипту не передаётся ПРИНЦИПИАЛЬНО
// (workflow_dispatch запускается с произвольной ветки) — тест фиксирует,
// что CLOUDFLARE_API_TOKEN не входит в проверяемый набор.

const DEV_OWNER = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
const OTHER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const GOOD = {
  CF_PAGES_PROJECT: 'eternal-notes',
  VITE_PROXY_URL: AUTO_ALLOWED_WORKER_ORIGINS[0],
  VITE_TRUSTED_OWNERS: DEV_OWNER,
  CLOUDFLARE_ACCOUNT_ID: 'some-account-id',
};

describe('checkDeployConfig', () => {
  it('полный корректный набор проходит', () => {
    expect(checkDeployConfig(GOOD)).toMatchObject({ ok: true, problems: [] });
  });

  it('секретный токен не входит в проверяемый набор', () => {
    expect(DEPLOY_VARS).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(Object.keys(EXPECTED)).not.toContain('CLOUDFLARE_API_TOKEN');
  });

  it.each(DEPLOY_VARS)('отсутствие %s роняет гейт', name => {
    const env = { ...GOOD };
    delete env[name];
    const r = checkDeployConfig(env);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`${name} is missing`);
  });

  it.each(DEPLOY_VARS)('пустое/пробельное значение %s роняет гейт', name => {
    const r = checkDeployConfig({ ...GOOD, [name]: '   ' });
    expect(r.ok).toBe(false);
  });

  it('VITE_PROXY_URL пиннится к origin dev-воркера из smoke-target (один источник истины)', () => {
    expect(EXPECTED.VITE_PROXY_URL.equals).toBe(AUTO_ALLOWED_WORKER_ORIGINS[0]);
    const r = checkDeployConfig({ ...GOOD, VITE_PROXY_URL: 'https://evil.example' });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/repo-pinned/);
  });

  it('VITE_TRUSTED_OWNERS — вхождение, не равенство: старый+новый проходит', () => {
    const r = checkDeployConfig({ ...GOOD, VITE_TRUSTED_OWNERS: `${OTHER},${DEV_OWNER}` });
    expect(r).toMatchObject({ ok: true });
  });

  it('VITE_TRUSTED_OWNERS без текущего владельца роняет гейт', () => {
    const r = checkDeployConfig({ ...GOOD, VITE_TRUSTED_OWNERS: OTHER });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/does not include/);
  });

  it('кривой список владельцев роняет гейт, а не пропускается', () => {
    const r = checkDeployConfig({ ...GOOD, VITE_TRUSTED_OWNERS: 'not-an-address' });
    expect(r.ok).toBe(false);
  });

  it('сообщения не содержат фактических значений env', () => {
    const secretish = 'super-secret-project-name';
    const r = checkDeployConfig({ ...GOOD, CF_PAGES_PROJECT: '', VITE_PROXY_URL: secretish });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).not.toContain(secretish);
  });

  it('узкий набор (воркер-деплой) проверяет только переданные имена', () => {
    const r = checkDeployConfig({ CLOUDFLARE_ACCOUNT_ID: 'x' }, ['CLOUDFLARE_ACCOUNT_ID']);
    expect(r).toMatchObject({ ok: true });
  });
});
