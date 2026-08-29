import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildUploadPayload, buildSafeboxUploadPayload } from './arweave';
import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import {
  PUBLICATION_FP_DOMAIN,
  publicationFpInput,
  computePublicationFp,
} from './publication-fp.fixture';

/**
 * The client half of the shared `fp` vector (docs/BACKUP_FORMAT_V1.md §1.5).
 *
 * Two independent things are pinned here, and they fail for different reasons:
 *  1. the REAL upload builders still produce the documented `data` strings —
 *     a serialization change would silently invalidate every stored `fp`;
 *  2. the client mirror of the fingerprint still produces the documented
 *     digests — the worker suite pins the same numbers from its own side.
 *
 * The document itself is asserted too: a frozen format whose vector drifts out
 * of its documentation is unverifiable by anyone who was not in the room.
 */

const NOTE_V1: EncryptedNote = {
  noteId: '11111111-2222-4333-8444-555555555555',
  ciphertext: 'AAAA',
  iv: 'AAAAAAAAAAAAAAAA',
  createdAt: 1756000000000,
};

const NOTE_V3: EncryptedNote = {
  noteId: '66666666-7777-8333-9444-555555555555',
  v: 3,
  ciphertext: 'BBBB',
  iv: 'BBBBBBBBBBBBBBBB',
  createdAt: 1756000000000,
};

const ENTRY_V4: EncryptedSafeboxEntry = {
  entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
  v: 4,
  metaCiphertext: 'CCCC',
  metaIv: 'CCCCCCCCCCCCCCCC',
  secretCiphertext: 'DDDD',
  secretIv: 'DDDDDDDDDDDDDDDD',
  createdAt: 1756000000000,
};

/** Verbatim from docs/BACKUP_FORMAT_V1.md §1.5. */
const VECTOR = [
  {
    name: 'A — v1 note',
    appVersion: '1',
    data: '{"id":"11111111-2222-4333-8444-555555555555","c":"AAAA","iv":"AAAAAAAAAAAAAAAA","t":1756000000000}',
    fp: '4a9a4c67b6935b6f9888d919307172fa0c1772912a4b2e9b99181f7dd3c9d883',
    build: () => buildUploadPayload(NOTE_V1, 'owner-hash-stub', 1),
  },
  {
    name: 'B — v3 note',
    appVersion: '3',
    data: '{"id":"66666666-7777-8333-9444-555555555555","c":"BBBB","iv":"BBBBBBBBBBBBBBBB"}',
    fp: '5f258ae47a951919e592998ab9fe95507f390edffef5b30eede5fdd893d78415',
    build: () => buildUploadPayload(NOTE_V3, 'owner-hash-stub', 1),
  },
  {
    name: 'C — v4 safebox entry',
    appVersion: '4',
    data: '{"id":"88888888-9999-8aaa-baaa-cccccccccccc","mc":"CCCC","miv":"CCCCCCCCCCCCCCCC","sc":"DDDD","siv":"DDDDDDDDDDDDDDDD"}',
    fp: 'acb55eaaf1d99b728ebe3ea523c9cec3918c3acfc21dc2f337f1b6a92e1ae143',
    build: () => buildSafeboxUploadPayload(ENTRY_V4, 'owner-hash-stub', 1),
  },
] as const;

describe('publication fingerprint — documented vector (client half)', () => {
  for (const c of VECTOR) {
    it(`case ${c.name}: the real builder still produces the documented data`, () => {
      const payload = c.build();
      expect(payload.data).toBe(c.data);
      expect(payload.tags.find(t => t.name === 'App-Version')?.value).toBe(c.appVersion);
    });

    it(`case ${c.name}: the documented data hashes to the documented fp`, async () => {
      await expect(computePublicationFp(c.appVersion, c.data)).resolves.toBe(c.fp);
    });

    it(`case ${c.name}: builder output and vector agree end to end`, async () => {
      const payload = c.build();
      const appVersion = payload.tags.find(t => t.name === 'App-Version')!.value;
      await expect(computePublicationFp(appVersion, payload.data)).resolves.toBe(c.fp);
    });
  }
});

describe('publication fingerprint — canonicalization', () => {
  it('the domain separator is the documented byte string ending in LF', () => {
    expect(PUBLICATION_FP_DOMAIN).toBe('eternal-notes/publication-fp/v1\n');
    expect(PUBLICATION_FP_DOMAIN.endsWith('\r\n')).toBe(false);
  });

  it('the hashed input is domain || canonical JSON with sorted keys', () => {
    expect(publicationFpInput('3', '{"id":"x"}')).toBe(
      'eternal-notes/publication-fp/v1\n{"appVersion":"3","data":"{\\"id\\":\\"x\\"}"}',
    );
  });

  it('appVersion is bound, not merely adjacent: it cannot be shifted into data', async () => {
    // Without JSON escaping and a fixed key order, ('1','a') and ('1a','')
    // could serialize to the same bytes. They must not.
    const a = await computePublicationFp('1', 'a');
    const b = await computePublicationFp('1a', '');
    expect(a).not.toBe(b);
  });

  it('a quote inside data cannot forge a second field', async () => {
    const a = await computePublicationFp('1', '","appVersion":"4');
    const b = await computePublicationFp('4', '');
    expect(a).not.toBe(b);
  });

  it('fails closed on non-string inputs', () => {
    // @ts-expect-error — the runtime guard exists precisely for untyped callers
    expect(() => publicationFpInput(1, 'x')).toThrow(TypeError);
    // @ts-expect-error — same
    expect(() => publicationFpInput('1', { id: 'x' })).toThrow(TypeError);
  });

  it('is a 64-character lowercase hex digest', async () => {
    expect(await computePublicationFp('1', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('publication fingerprint — documentation is the source of truth', () => {
  const doc = readFileSync(new URL('../../docs/BACKUP_FORMAT_V1.md', import.meta.url), 'utf8');

  it('the document exists and describes the fingerprint', () => {
    expect(doc).toContain('Publication fingerprint (`fp`)');
    expect(doc).toContain('eternal-notes/publication-fp/v1');
  });

  for (const c of VECTOR) {
    it(`case ${c.name} is documented with the same data and fp`, () => {
      expect(doc).toContain(c.data);
      expect(doc).toContain(c.fp);
    });
  }
});
