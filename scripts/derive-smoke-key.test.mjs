import { describe, it, expect } from 'vitest';
import { deriveSmokeKey } from '../worker/scripts/derive-smoke-key.mjs';
import { deriveSigningKeypair, deriveOwnerHash, bufferToBase64 } from '../src/lib/crypto';

// Паритет операторского helper'а с приложением.
//
// smoke-v3/v4 ходят от ЗАРЕГИСТРИРОВАННОГО ключа, а регистрация привязана к
// seed-фразе. Если helper и клиент разойдутся хоть в одной константе HKDF,
// смоук будет падать невнятным «Not registered» — и это выглядело бы как
// поломка воркера, а не как рассинхрон инструмента. Тест удерживает их вместе.

const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
];

describe('derive-smoke-key ↔ src/lib/crypto', () => {
  it.each(MNEMONICS)('выводит тот же ключ, что и приложение: %s', async mnemonic => {
    const helper = await deriveSmokeKey(mnemonic);
    const app = await deriveSigningKeypair(mnemonic);

    expect(bufferToBase64(helper.privateKey)).toBe(bufferToBase64(app.privateKey));
    expect(bufferToBase64(helper.publicKey)).toBe(bufferToBase64(app.publicKey));
    // ownerHash — то, по чему воркер сверяет владельца загрузки.
    expect(bufferToBase64(helper.ownerHash)).toBe(await deriveOwnerHash(app.publicKey));
  });

  it('детерминирован и различает фразы', async () => {
    const a1 = await deriveSmokeKey(MNEMONICS[0]);
    const a2 = await deriveSmokeKey(MNEMONICS[0]);
    const b = await deriveSmokeKey(MNEMONICS[1]);
    expect(bufferToBase64(a1.privateKey)).toBe(bufferToBase64(a2.privateKey));
    expect(bufferToBase64(a1.privateKey)).not.toBe(bufferToBase64(b.privateKey));
    expect(a1.privateKey).toHaveLength(32);
  });
});
