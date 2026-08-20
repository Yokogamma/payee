import { describe, it, expect } from 'vitest';
import { assertOwnersIncludeWorker } from './check-owners-vs-worker.mjs';

// Семантическая сверка §1.7: /wallet-address воркера обязан ВХОДИТЬ в
// VITE_TRUSTED_OWNERS. Матрица из плана: старый+новый, пробелы, дубликаты,
// отсутствие текущего адреса (падает), пустое значение (падает, не «пропуск»).

const CURRENT = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
const OLD = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('assertOwnersIncludeWorker', () => {
  it('список «старый,новый» проходит (ротация кошелька законна)', () => {
    expect(assertOwnersIncludeWorker(`${OLD},${CURRENT}`, CURRENT)).toEqual([OLD, CURRENT]);
  });

  it('лишние пробелы не мешают', () => {
    expect(assertOwnersIncludeWorker(`  ${CURRENT} , ${OLD} `, CURRENT)).toContain(CURRENT);
  });

  it('дубликаты схлопываются и проходят', () => {
    expect(assertOwnersIncludeWorker(`${CURRENT},${CURRENT}`, CURRENT)).toEqual([CURRENT]);
  });

  it('ОТСУТСТВИЕ текущего адреса — обязан падать', () => {
    expect(() => assertOwnersIncludeWorker(OLD, CURRENT)).toThrow(/NOT in VITE_TRUSTED_OWNERS/);
  });

  it('пустое значение — обязан падать, а не «пропускать»', () => {
    expect(() => assertOwnersIncludeWorker('', CURRENT)).toThrow(/empty/);
    expect(() => assertOwnersIncludeWorker(' , ', CURRENT)).toThrow(/empty/);
  });

  it('кривой адрес в списке — падает на парсинге', () => {
    expect(() => assertOwnersIncludeWorker(`${CURRENT},garbage`, CURRENT)).toThrow(/malformed/);
  });
});
