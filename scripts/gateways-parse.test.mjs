import { describe, it, expect } from 'vitest';
import {
  canonicalIndexUrl as canonicalIndexUrlJs,
  canonicalOrigin as canonicalOriginJs,
  cspConnectOrigins,
  parseIndexSources as parseIndexSourcesJs,
  parseOriginList as parseOriginListJs,
  serializeStatusOrigins as serializeJs,
} from './gateways-parse.mjs';
import {
  canonicalIndexUrl as canonicalIndexUrlTs,
  canonicalOrigin as canonicalOriginTs,
  parseIndexSources as parseIndexSourcesTs,
  parseOriginList as parseOriginListTs,
  serializeStatusOrigins as serializeTs,
} from '../src/lib/gateways-parse';

// Паритет JS-зеркала (для деплой-скриптов вне TS-тулчейна) с каноническим
// src/lib/gateways-parse.ts. Расхождение хоть в одном правиле означало бы, что
// CSP разрешит не то, что запросит рантайм, — или наоборот.

const ORIGIN_CASES = [
  'https://arweave.net',
  'https://arweave.net/',
  '  https://arweave.net  ',
  'https://arweave.net,https://ar-io.dev',
  'https://arweave.net,https://arweave.net/',
  'https://a.example,,https://b.example',
  'http://arweave.net',
  'https://arweave.net/graphql',
  'https://arweave.net/?x=1',
  'https://arweave.net/#f',
  'https://u:p@arweave.net',
  'arweave.net',
  '',
  ' , , ',
];

const INDEX_CASES = [
  'https://arweave.net/graphql',
  'https://arweave.net/graphql|https://vilenarios.com/graphql,https://arweave-search.goldsky.com/graphql',
  'https://h.example/graphql,https://h.example/search',
  'https://a.example/graphql,https://a.example/graphql',
  'https://a.example/gql?v=2',
  'https://a.example/graphql#frag',
  'http://a.example/graphql,https://ok.example/graphql',
  '',
];

describe('gateways-parse.mjs ↔ src/lib/gateways-parse.ts', () => {
  it.each(ORIGIN_CASES)('canonicalOrigin одинаков: %j', raw => {
    expect(canonicalOriginJs(raw)).toEqual(canonicalOriginTs(raw));
  });

  it.each(ORIGIN_CASES)('parseOriginList одинаков: %j', raw => {
    expect(parseOriginListJs(raw)).toEqual(parseOriginListTs(raw));
  });

  it.each(INDEX_CASES)('canonicalIndexUrl одинаков: %j', raw => {
    expect(canonicalIndexUrlJs(raw)).toEqual(canonicalIndexUrlTs(raw));
  });

  it.each(INDEX_CASES)('parseIndexSources одинаков: %j', raw => {
    expect(parseIndexSourcesJs(raw)).toEqual(parseIndexSourcesTs(raw));
  });

  it('serializeStatusOrigins совпадает побайтно — на нём строится хеш /health', () => {
    const origins = ['https://b.example', 'https://a.example'];
    expect(serializeJs(origins)).toBe(serializeTs(origins));
  });
});

describe('cspConnectOrigins — то, что попадёт в connect-src', () => {
  it('объединяет три списка, для индексов берёт только origin', () => {
    expect(cspConnectOrigins({
      status: 'https://arweave.net,https://ar-io.dev',
      payload: 'https://arweave.net,https://frostor.xyz',
      indexSources: 'https://arweave.net/graphql|https://vilenarios.com/graphql,https://goldsky.example/graphql',
    })).toEqual([
      'https://ar-io.dev',
      'https://arweave.net',
      'https://frostor.xyz',
      'https://goldsky.example',
      'https://vilenarios.com',
    ]);
  });

  it('сортирован и дедуплицирован — перестановка env не меняет артефакт', () => {
    const a = cspConnectOrigins({ status: 'https://b.example,https://a.example', payload: '', indexSources: '' });
    const b = cspConnectOrigins({ status: 'https://a.example,https://b.example', payload: '', indexSources: '' });
    expect(a).toEqual(b);
  });

  it('пустой конфиг не добавляет ничего — дефолт подставляет сборка', () => {
    expect(cspConnectOrigins({ status: '', payload: '', indexSources: '' })).toEqual([]);
  });
});
