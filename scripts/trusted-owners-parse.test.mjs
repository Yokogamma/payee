import { describe, it, expect } from 'vitest';
import { parseTrustedOwners as parseJs } from './trusted-owners-parse.mjs';
import { parseTrustedOwners as parseTs } from '../src/lib/trusted-owners';

// Паритет JS-зеркала (для деплой-скриптов вне TS-тулчейна) с каноническим
// src/lib/trusted-owners.ts. Если они разойдутся хоть в одном правиле,
// значение сможет пройти один гейт и упасть на другом — тест держит их вместе.

const A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
const B = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const OK_CASES = [
  A,
  `${A},${B}`,
  `  ${A} , ${B}  `,
  `${A},${A},${B}`,
  '',
  ' , , ',
];

const THROW_CASES = ['foo', `${A},short`, 'WALLET_A', `${A};${B}`];

describe('trusted-owners-parse.mjs ↔ src/lib/trusted-owners.ts', () => {
  it.each(OK_CASES)('одинаковый результат: %j', raw => {
    expect(parseJs(raw)).toEqual(parseTs(raw));
  });

  it.each(THROW_CASES)('одинаково бросают: %j', raw => {
    expect(() => parseTs(raw)).toThrow();
    expect(() => parseJs(raw)).toThrow();
  });

  it('дедупликация и трим совпадают', () => {
    expect(parseJs(` ${A} ,${A}, ${B} `)).toEqual([A, B]);
  });
});
