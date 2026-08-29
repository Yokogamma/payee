import { describe, it, expect } from 'vitest';
import { checkDeployConfig, DEPLOY_VARS, EXPECTED } from './check-deploy-config.mjs';
import { AUTO_ALLOWED_WORKER_ORIGINS } from '../worker/scripts/smoke-target.mjs';
import {
  EXPECTED_PAYLOAD_CSV,
  EXPECTED_STATUS_CSV,
  INDEX_SOURCES as PINNED_INDEX_SOURCES,
} from './gateway-pins.mjs';

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
  VITE_STATUS_GATEWAYS: EXPECTED_STATUS_CSV,
  VITE_PAYLOAD_GATEWAYS: EXPECTED_PAYLOAD_CSV,
  VITE_INDEX_SOURCES: PINNED_INDEX_SOURCES,
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

// ── Gateway pins (PR-3a) ──────────────────────────────────────────────
describe('gateway sets are pinned EXACTLY, not merely present', () => {
  it('normalization applies: trailing slashes and duplicates are not a difference', () => {
    const withNoise = EXPECTED_STATUS_CSV.split(',').map(o => o + '/').join(',')
      + ',https://arweave.net';
    expect(checkDeployConfig({ ...GOOD, VITE_STATUS_GATEWAYS: withNoise })).toMatchObject({ ok: true });
  });

  it('a changed status SET fails', () => {
    const r = checkDeployConfig({ ...GOOD, VITE_STATUS_GATEWAYS: 'https://arweave.net,https://evil.example' });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/VITE_STATUS_GATEWAYS does not match/);
  });

  // Status probes run in parallel, so their order carries no meaning.
  it('status order is NOT part of the pin', () => {
    const reversed = EXPECTED_STATUS_CSV.split(',').reverse().join(',');
    expect(checkDeployConfig({ ...GOOD, VITE_STATUS_GATEWAYS: reversed })).toMatchObject({ ok: true });
  });

  // The payload pool is tried in sequence, and §2.1 approved that sequence.
  it('payload ORDER is part of the pin', () => {
    const reversed = EXPECTED_PAYLOAD_CSV.split(',').reverse().join(',');
    const r = checkDeployConfig({ ...GOOD, VITE_PAYLOAD_GATEWAYS: reversed });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/order is part of the pin/);
  });

  it('index GROUPING is part of the pin — flattening the fallback fails', () => {
    const flattened = PINNED_INDEX_SOURCES.replace('|', ',');
    const r = checkDeployConfig({ ...GOOD, VITE_INDEX_SOURCES: flattened });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/index sources/);
  });

  it('an empty gateway variable fails like any other missing one', () => {
    for (const name of ['VITE_STATUS_GATEWAYS', 'VITE_PAYLOAD_GATEWAYS', 'VITE_INDEX_SOURCES']) {
      expect(checkDeployConfig({ ...GOOD, [name]: '' }).ok).toBe(false);
    }
  });
});
