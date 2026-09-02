import { describe, it, expect } from 'vitest';
import {
  PUBLICATION_FP_DOMAIN,
  publicationFpInput,
  computePublicationFp,
  decodePublicationData,
} from '../src/publication-fp';
// CROSS-HALF IMPORT (deliberate — do not "fix" to a local helper): the second
// implementation below is the client's TEST-ONLY mirror from
// src/lib/publication-fp.fixture.ts. Running both in ONE process is the only
// place where a divergence between the halves is caught as a diff rather than
// as two suites that each pass against their own idea of the format. Pattern
// precedent: test/client-parity.test.ts (client crypto ↔ worker verification).
import {
  PUBLICATION_FP_DOMAIN as CLIENT_DOMAIN,
  publicationFpInput as clientFpInput,
  computePublicationFp as clientFp,
} from '../../src/lib/publication-fp.fixture';

/** Verbatim from docs/BACKUP_FORMAT_V1.md §1.5 — the same three cases the
 *  client suite pins from its side. */
const VECTOR = [
  {
    name: 'A — v1 note',
    appVersion: '1',
    data: '{"id":"11111111-2222-4333-8444-555555555555","c":"AAAA","iv":"AAAAAAAAAAAAAAAA","t":1756000000000}',
    fp: '4a9a4c67b6935b6f9888d919307172fa0c1772912a4b2e9b99181f7dd3c9d883',
  },
  {
    name: 'B — v3 note',
    appVersion: '3',
    data: '{"id":"66666666-7777-8333-9444-555555555555","c":"BBBB","iv":"BBBBBBBBBBBBBBBB"}',
    fp: '5f258ae47a951919e592998ab9fe95507f390edffef5b30eede5fdd893d78415',
  },
  {
    name: 'C — v4 safebox entry',
    appVersion: '4',
    data: '{"id":"88888888-9999-8aaa-baaa-cccccccccccc","mc":"CCCC","miv":"CCCCCCCCCCCCCCCC","sc":"DDDD","siv":"DDDDDDDDDDDDDDDD"}',
    fp: 'acb55eaaf1d99b728ebe3ea523c9cec3918c3acfc21dc2f337f1b6a92e1ae143',
  },
] as const;

describe('publication fingerprint — documented vector (worker half)', () => {
  for (const c of VECTOR) {
    it(`case ${c.name} hashes to the documented fp`, async () => {
      await expect(computePublicationFp(c.appVersion, c.data)).resolves.toBe(c.fp);
    });
  }
});

describe('publication fingerprint — canonicalization', () => {
  it('the domain separator is the documented byte string ending in LF', () => {
    expect(PUBLICATION_FP_DOMAIN).toBe('eternal-notes/publication-fp/v1\n');
  });

  it('the hashed input is domain || canonical JSON with sorted keys', () => {
    expect(publicationFpInput('3', '{"id":"x"}')).toBe(
      'eternal-notes/publication-fp/v1\n{"appVersion":"3","data":"{\\"id\\":\\"x\\"}"}',
    );
  });

  it('appVersion is bound, not merely adjacent', async () => {
    expect(await computePublicationFp('1', 'a')).not.toBe(await computePublicationFp('1a', ''));
  });

  it('a quote inside data cannot forge a second field', async () => {
    expect(await computePublicationFp('1', '","appVersion":"4')).not.toBe(
      await computePublicationFp('4', ''),
    );
  });

  it('the transport fields are outside the fingerprint by construction', async () => {
    // `fp` takes exactly two inputs, so a retry that differs only in
    // timestamp/recheck/recovery cannot move it. Pinned as behavior, not only
    // as a comment: the DO compares fingerprints across reserved → posted →
    // committed, where those fields legitimately differ every time.
    const first = await computePublicationFp(VECTOR[1].appVersion, VECTOR[1].data);
    const second = await computePublicationFp(VECTOR[1].appVersion, VECTOR[1].data);
    expect(second).toBe(first);
  });

  it('fails closed on non-string inputs — a coerced input would hash cleanly and mean nothing', () => {
    expect(() => publicationFpInput(1 as unknown as string, 'x')).toThrow(TypeError);
    expect(() => publicationFpInput('1', { id: 'x' } as unknown as string)).toThrow(TypeError);
    expect(() => publicationFpInput(undefined as unknown as string, 'x')).toThrow(TypeError);
  });

  it('is a 64-character lowercase hex digest', async () => {
    expect(await computePublicationFp('1', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('publication fingerprint — client ↔ worker parity in one process', () => {
  it('both halves declare the same domain separator', () => {
    expect(CLIENT_DOMAIN).toBe(PUBLICATION_FP_DOMAIN);
  });

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ...VECTOR.map(c => [c.appVersion, c.data] as const),
    ['1', ''],
    ['4', '{}'],
    ['2', '{"c":"a\\"b"}'],            // an escaped quote inside data
    ['3', '{"c":"a\\b"}'],           // a literal backslash
    ['3', '{"c":"line1\nline2"}'],     // a raw newline
    ['3', '{"c":"тест ✓ 𝄞"}'],         // non-ASCII, incl. a surrogate pair
    ['3', '{"c":"\uD800"}'],           // a LONE surrogate — escaped, never encoded raw
    ['3', '{"c":"\u0000\u001f"}'],     // control characters
  ];

  for (const [appVersion, data] of CASES) {
    it(`agrees on (${JSON.stringify(appVersion)}, ${JSON.stringify(data).slice(0, 40)})`, async () => {
      expect(clientFpInput(appVersion, data)).toBe(publicationFpInput(appVersion, data));
      expect(await clientFp(appVersion, data)).toBe(await computePublicationFp(appVersion, data));
    });
  }
});

describe('publication fingerprint — the bytes → string boundary', () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  it('round-trips a real publication body', () => {
    expect(decodePublicationData(enc(VECTOR[0].data))).toBe(VECTOR[0].data);
  });

  it('accepts a Uint8Array and its underlying buffer alike', () => {
    const bytes = enc('{"c":"ok"}');
    expect(decodePublicationData(bytes)).toBe('{"c":"ok"}');
    expect(decodePublicationData(bytes.buffer as ArrayBuffer)).toBe('{"c":"ok"}');
  });

  it('THROWS on invalid UTF-8 instead of collapsing it to U+FFFD', () => {
    // The whole point: a lossy decode would map both of these onto the same
    // string, so two different publications would share one fingerprint.
    expect(() => decodePublicationData(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow();
    expect(() => decodePublicationData(new Uint8Array([0xc3]))).toThrow();      // truncated 2-byte seq
    expect(() => decodePublicationData(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(); // lone surrogate
  });

  it('keeps a leading BOM instead of normalizing the bytes away', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]); // U+FEFF + "{}"
    const decoded = decodePublicationData(withBom);
    expect(decoded).toBe('﻿{}');
    expect(decoded).not.toBe('{}');
  });

  it('a byte-level difference survives into a different fp', async () => {
    const a = await computePublicationFp('1', decodePublicationData(enc('{"c":"a"}')));
    const b = await computePublicationFp('1', decodePublicationData(enc('{"c":"b"}')));
    expect(a).not.toBe(b);
  });
});
