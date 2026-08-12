#!/usr/bin/env node
/**
 * Печатает SMOKE_PRIVATE_KEY для smoke-v3/smoke-v4 — base64 32-байтового
 * Ed25519-seed'а, выведенного из seed-фразы ТОЧНО так же, как это делает
 * клиент (deriveSigningKeypair в src/lib/crypto.ts):
 *
 *   BIP-39 seed → первые 32 байта → HKDF-SHA256
 *   (salt "eternal-notes-v1", info "ed25519-signing-v1") → 32 байта
 *
 * Смысл: смоук должен ходить от ЗАРЕГИСТРИРОВАННОГО ключа, а регистрация в
 * этом приложении привязана к seed-фразе. Поэтому ключ не «где-то лежит» —
 * он выводится из фразы того хранилища, которое уже прошло /register.
 *
 * ⚠️ Печатает ПРИВАТНЫЙ материал в stdout. Фраза читается из stdin или из
 * переменной окружения — НИКОГДА из аргументов командной строки (те попадают
 * в историю шелла и в вывод `ps`).
 *
 * Использование:
 *   MNEMONIC="слово1 ... слово12" node scripts/derive-smoke-key.mjs
 *   # или, не оставляя фразу даже в окружении:
 *   node scripts/derive-smoke-key.mjs   # вставить фразу, затем Ctrl+D
 *
 * Дополнительно печатаются publicKey и ownerHash — по ним видно, под каким
 * аккаунтом пойдёт смоук и под чьим Owner-Hash появится тестовая запись.
 *
 * Паритет с приложением закреплён тестом scripts/derive-smoke-key.test.mjs
 * в КОРНЕВОМ наборе: разойдись константы — смоук падал бы невнятным
 * «Not registered», а не понятной ошибкой.
 */

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as ed from '@noble/ed25519';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const b64 = bytes => Buffer.from(bytes).toString('base64');

/** ЕДИНСТВЕННОЕ место с логикой вывода — экспортируется ради теста паритета. */
export async function deriveSmokeKey(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic);
  const keyMaterial = await subtle.importKey('raw', seed.slice(0, 32), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('eternal-notes-v1'),
      info: new TextEncoder().encode('ed25519-signing-v1'),
    },
    keyMaterial,
    256,
  );
  const privateKey = new Uint8Array(bits);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const ownerHash = new Uint8Array(await subtle.digest('SHA-256', publicKey));
  return { privateKey, publicKey, ownerHash };
}

async function readMnemonic() {
  if (process.env.MNEMONIC) return process.env.MNEMONIC.trim();
  process.stderr.write('Введите seed-фразу (12 слов) и нажмите Ctrl+D:\n');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const mnemonic = (await readMnemonic()).replace(/\s+/g, ' ');
  if (!mnemonic) {
    console.error('Пустой ввод. Задайте MNEMONIC или подайте фразу в stdin.');
    process.exit(2);
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    console.error('Это не валидная BIP-39 фраза (проверьте слова и порядок).');
    process.exit(2);
  }
  const { privateKey, publicKey, ownerHash } = await deriveSmokeKey(mnemonic);
  console.log(`SMOKE_PRIVATE_KEY=${b64(privateKey)}`);
  console.log(`# publicKey  = ${b64(publicKey)}`);
  console.log(`# ownerHash  = ${b64(ownerHash)}`);
  console.log('# ↑ смоук пойдёт от этого аккаунта; он должен быть зарегистрирован (/register).');
}

// Импорт из теста не должен запускать CLI и читать stdin.
const invoked = process.argv[1]?.replace(/\\/g, '/');
if (invoked && import.meta.url === `file://${invoked.startsWith('/') ? '' : '/'}${invoked}`) {
  await main();
}
