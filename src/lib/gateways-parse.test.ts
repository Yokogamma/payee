import { describe, it, expect } from 'vitest';
import {
  canonicalIndexUrl,
  canonicalOrigin,
  parseIndexSources,
  parseOriginList,
  serializeStatusOrigins,
} from './gateways-parse';

describe('canonicalOrigin — bare https origins only', () => {
  it('accepts a bare origin, with or without a trailing slash', () => {
    expect(canonicalOrigin('https://arweave.net')).toBe('https://arweave.net');
    expect(canonicalOrigin('https://arweave.net/')).toBe('https://arweave.net');
    expect(canonicalOrigin('  https://arweave.net  ')).toBe('https://arweave.net');
  });

  // REJECT, not strip: `new URL(x).origin` would silently discard the extra and
  // produce requests to a URL the operator never configured.
  it('rejects a path, query or fragment instead of dropping it', () => {
    expect(canonicalOrigin('https://arweave.net/graphql')).toBeNull();
    expect(canonicalOrigin('https://arweave.net/?x=1')).toBeNull();
    expect(canonicalOrigin('https://arweave.net/#frag')).toBeNull();
  });

  it('rejects credentials — they would ride along on every request', () => {
    expect(canonicalOrigin('https://user:pass@arweave.net')).toBeNull();
    expect(canonicalOrigin('https://user@arweave.net')).toBeNull();
  });

  it('rejects non-https and unparseable values', () => {
    expect(canonicalOrigin('http://arweave.net')).toBeNull();
    expect(canonicalOrigin('arweave.net')).toBeNull();
    expect(canonicalOrigin('')).toBeNull();
  });
});

describe('canonicalIndexUrl — full URLs, path is significant', () => {
  it('keeps the path and the query, drops the fragment', () => {
    expect(canonicalIndexUrl('https://arweave.net/graphql')).toBe('https://arweave.net/graphql');
    expect(canonicalIndexUrl('https://h.example/gql?v=2')).toBe('https://h.example/gql?v=2');
    expect(canonicalIndexUrl('https://arweave.net/graphql#x')).toBe('https://arweave.net/graphql');
  });

  it('rejects credentials and non-https', () => {
    expect(canonicalIndexUrl('https://u:p@arweave.net/graphql')).toBeNull();
    expect(canonicalIndexUrl('http://arweave.net/graphql')).toBeNull();
  });
});

describe('parseOriginList — dedup by ORIGIN, order preserved', () => {
  it('preserves order (normative for the payload pool)', () => {
    expect(parseOriginList('https://a.example,https://b.example,https://c.example'))
      .toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });

  // A repeated origin must not manufacture a second "independent" vote for the
  // dead quorum — that is the whole reason this list dedups by origin.
  it('collapses a duplicated origin so it cannot fake a quorum', () => {
    expect(parseOriginList('https://a.example,https://a.example/,https://b.example'))
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('drops unusable entries instead of throwing, and tolerates stray commas', () => {
    expect(parseOriginList('https://a.example,,http://b.example,https://c.example/p'))
      .toEqual(['https://a.example']);
    expect(parseOriginList('')).toEqual([]);
  });
});

describe('parseIndexSources — logical groups, dedup by FULL URL', () => {
  it('parses groups and transport-fallbacks', () => {
    expect(parseIndexSources('https://a.example/graphql|https://b.example/graphql,https://c.example/graphql'))
      .toEqual([
        ['https://a.example/graphql', 'https://b.example/graphql'],
        ['https://c.example/graphql'],
      ]);
  });

  // The approved Goldsky search is `origin + /graphql`: two endpoints CAN share
  // an origin, and an origin-keyed dedup would throw one of them away.
  it('keeps two different endpoints that share one origin', () => {
    const parsed = parseIndexSources('https://h.example/graphql,https://h.example/search');
    expect(parsed).toEqual([['https://h.example/graphql'], ['https://h.example/search']]);
  });

  it('dedups the same URL GLOBALLY — one URL cannot serve two logical sources', () => {
    const parsed = parseIndexSources('https://a.example/graphql,https://a.example/graphql');
    expect(parsed).toEqual([['https://a.example/graphql']]);
  });

  it('drops a group left empty by validation rather than keeping []', () => {
    expect(parseIndexSources('http://insecure.example/graphql,https://ok.example/graphql'))
      .toEqual([['https://ok.example/graphql']]);
    expect(parseIndexSources('')).toEqual([]);
  });
});

describe('serializeStatusOrigins — the attestation hash input', () => {
  // The status order is not normative, so reordering wrangler.toml must not
  // change the hash the deploy smoke compares against /health.
  it('is invariant to permutation', () => {
    const a = serializeStatusOrigins(['https://b.example', 'https://a.example', 'https://c.example']);
    const b = serializeStatusOrigins(['https://c.example', 'https://b.example', 'https://a.example']);
    expect(a).toBe(b);
  });

  it('is a stable, explicit byte sequence', () => {
    expect(serializeStatusOrigins(['https://b.example', 'https://a.example']))
      .toBe('["https://a.example","https://b.example"]');
  });

  it('distinguishes different sets', () => {
    expect(serializeStatusOrigins(['https://a.example']))
      .not.toBe(serializeStatusOrigins(['https://a.example', 'https://b.example']));
  });
});
