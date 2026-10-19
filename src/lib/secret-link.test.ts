import { describe, it, expect, vi, afterEach } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';

// Both flag positions in one file: the getter is read at CALL time by
// `parseSecretLinkUrl`, so each test picks its position.
const flagState = vi.hoisted(() => ({ on: true }));
vi.mock('./flags', async importOriginal => ({
  ...(await importOriginal<typeof import('./flags')>()),
  get SECRET_LINK_ENABLED() { return flagState.on; },
}));

import {
  authSnapshotEquals,
  buildSecretLink,
  chooseHead,
  classifyKey,
  coverageDelta,
  decryptIndexBlob,
  deriveSecretLinkKey,
  encryptIndexBlob,
  fingerprintOf,
  indexHeadVersion,
  isCanonicalHandle,
  isCoverageRecord,
  isDropMessage,
  isIndexBlob,
  isIndexRecord,
  isReceiptRecord,
  issueSnapshotEquals,
  lockGenerationMatches,
  parseSecretLinkUrl,
  rawEquals,
  secretLinkHandle,
  SECRET_RECEIPT_TTL_MS,
  tryDecryptIndexBlob,
  validateDropInput,
  type AuthSnapshot,
  type CoverageRecord,
  type CoverageRow,
  type CurrentAuth,
  type IndexRecord,
  type IssueSnapshot,
  type IssueSnapshotRead,
  type ReceiptRecord,
} from './secret-link';
import type { PinEncryptedSeed } from './crypto';
import type { QuickUnlockRecord } from './quick-unlock';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_HEX = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1';
const K_LINK_HEX = 'd0c8cfd5df87be09a6abbf21ca41966dfb7ee3715a984a8f63776faacb0f98cf';
const ROOT1 = '00000000-0000-8000-8000-000000000001';
const ROOT2 = '00000000-0000-8000-8000-000000000002';
const WRONG_ROOT = '00000000-0000-0000-0000-000000000001';
const MAC1 = '4e7620687197b948d8be68256e5e83841e20ae9fbd831419fcefb2a53d86cd93';
const MAC2 = '0713d92d4c0474e488727162d4f92489ef107e2b805790ffeb9351a80a65dd91';
const H1 = 'TnYgaHGXuUjYvmglbl6DhA';
const H2 = 'BxPZLUwEdOSIcnFi1PkkiQ';
const H_WRONG = 'e0xKgKNnp4lyYpb96qb-Yg';

const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

afterEach(() => { flagState.on = true; });

describe('§1.1 test vector (literal)', () => {
  it('BIP-39 seed, first 32 bytes', () => {
    expect(hex(mnemonicToSeedSync(MNEMONIC).slice(0, 32))).toBe(SEED_HEX);
  });

  it('K_link hex — independent extractable HKDF in the test', async () => {
    const ikm = await crypto.subtle.importKey(
      'raw', mnemonicToSeedSync(MNEMONIC).slice(0, 32), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF', hash: 'SHA-256',
        salt: new TextEncoder().encode('eternal-notes-v1'),
        info: new TextEncoder().encode('secret-link-v1'),
      },
      ikm, 256);
    expect(hex(bits)).toBe(K_LINK_HEX);
  });

  it('K_link is HMAC-SHA-256/256, sign-only, NON-extractable', async () => {
    const k = await deriveSecretLinkKey(MNEMONIC);
    expect(k.extractable).toBe(false);
    expect(k.usages).toEqual(['sign']);
    expect(k.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 });
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });

  it('macs via the non-extractable key equal HMAC under the K_link hex', async () => {
    const k = await deriveSecretLinkKey(MNEMONIC);
    const ref = await crypto.subtle.importKey(
      'raw', Uint8Array.from(K_LINK_HEX.match(/../g)!.map(h => parseInt(h, 16))),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    for (const [root, mac] of [[ROOT1, MAC1], [ROOT2, MAC2]]) {
      const data = new TextEncoder().encode(root);
      expect(hex(await crypto.subtle.sign('HMAC', k, data))).toBe(mac);
      expect(hex(await crypto.subtle.sign('HMAC', ref, data))).toBe(mac);
    }
  });

  it('handles and fingerprints for both roots, and the «wrong root» control', async () => {
    const k = await deriveSecretLinkKey(MNEMONIC);
    expect(await secretLinkHandle(k, ROOT1)).toBe(H1);
    expect(await secretLinkHandle(k, ROOT2)).toBe(H2);
    expect(await secretLinkHandle(k, WRONG_ROOT)).toBe(H_WRONG);
    expect(fingerprintOf(H1)).toEqual({ hue1: 110, hue2: 166, tail: 'TnYg' });
    expect(fingerprintOf(H2)).toEqual({ hue1: 10, hue2: 27, tail: 'BxPZ' });
  });

  it('deterministic: two derivations give the same handle', async () => {
    const a = await secretLinkHandle(await deriveSecretLinkKey(MNEMONIC), ROOT1);
    const b = await secretLinkHandle(await deriveSecretLinkKey(MNEMONIC), ROOT1);
    expect(a).toBe(b);
  });

  it('refuses a root that is not canonical lower-case', async () => {
    const k = await deriveSecretLinkKey(MNEMONIC);
    await expect(secretLinkHandle(k, 'ABCDEF00-0000-8000-8000-000000000001')).rejects.toThrow();
    await expect(secretLinkHandle(k, ROOT1.slice(1))).rejects.toThrow();
    await expect(secretLinkHandle(k, `{${ROOT1}}`)).rejects.toThrow();
  });
});

describe('isCanonicalHandle / fingerprintOf negatives', () => {
  it('accepts the vector handles', () => {
    for (const h of [H1, H2, H_WRONG]) expect(isCanonicalHandle(h)).toBe(true);
  });

  it.each([
    ['+', 'TnYgaHGXuUjYvmglbl6D+A'],
    ['/', 'TnYgaHGXuUjYvmglbl6D/A'],
    ['=', 'TnYgaHGXuUjYvmglbl6Dh='],
    ['21 chars', H1.slice(0, 21)],
    ['23 chars', H1 + 'A'],
    ['non-ASCII', 'TnYgaHGXuUjYvmglbl6DhА'], // Cyrillic А
    ['non-canonical last char', 'TnYgaHGXuUjYvmglbl6DhB'],
    ['empty', ''],
  ])('%s → false / null', (_, h) => {
    expect(isCanonicalHandle(h)).toBe(false);
    expect(fingerprintOf(h)).toBeNull();
  });

  it('non-strings are not handles', () => {
    for (const x of [null, undefined, 22, {}, [H1]]) expect(isCanonicalHandle(x)).toBe(false);
  });
});

describe('parseSecretLinkUrl — §1.2 grammar', () => {
  const at = (hash: string, search = '') => new URL(`https://notes.example/app/${search}${hash}`);

  it('flag ON: the accepted shapes', () => {
    expect(parseSecretLinkUrl(at(`#/s/${H1}`))).toEqual({ kind: 'resolve', handle: H1, ordinal: null });
    expect(parseSecretLinkUrl(at(`#/s/${H1}@1`))).toEqual({ kind: 'resolve', handle: H1, ordinal: 1 });
    expect(parseSecretLinkUrl(at(`#/s/${H1}@123456789`))).toEqual({ kind: 'resolve', handle: H1, ordinal: 123456789 });
    expect(parseSecretLinkUrl(at('#/s/new'))).toEqual({ kind: 'new', from: null });
    expect(parseSecretLinkUrl(at('#/s/new?from=drop'))).toEqual({ kind: 'new', from: 'drop' });
  });

  it.each([
    '#/s/', '#/s/abc', `#/s/${H1}/x`, `#/s/${H1}?x=1`, '#/s/new/x', '#/s/new?from=other',
    '#/s/new?from=drop&from=drop', '#/s/new?', '#/s/new?from=drop?x', '#/s/new?from=drop&',
    '#/s/new?x=1&from=drop', '#/s/new?from=%64rop', `#/s/${H1}?from=drop`,
    `#/s/${H1}@0`, `#/s/${H1}@01`, `#/s/${H1}@1234567890`, `#/s/${H1}@`, `#/s/${H1}@-1`,
    '#/s/TnYgaHGXuUjYvmglbl6DhB', `#/s/${H1}A`, `#/s/${H1.slice(0, 21)}`,
    '#/s/TnYgaHGXuUjYvmglbl6D+A', '#/s/NEW', '#s/new', '#/notes', '', `#/S/${H1}`,
  ])('flag ON: %s → null', hash => {
    expect(parseSecretLinkUrl(at(hash))).toBeNull();
  });

  it('flag ON: any search part → null', () => {
    expect(parseSecretLinkUrl(at(`#/s/${H1}`, '?a=1'))).toBeNull();
    expect(parseSecretLinkUrl(at('#/s/new', '?a=1'))).toBeNull();
  });

  it('flag ON: non-ASCII in the handle (percent-encoded by URL) → null', () => {
    expect(parseSecretLinkUrl(at('#/s/TnYgaHGXuUjYvmglbl6DhА'))).toBeNull();
  });

  it('flag OFF: the whole table is null', () => {
    flagState.on = false;
    for (const hash of [`#/s/${H1}`, `#/s/${H1}@2`, '#/s/new', '#/s/new?from=drop']) {
      expect(parseSecretLinkUrl(at(hash))).toBeNull();
    }
  });
});

describe('buildSecretLink', () => {
  it('origin + base + #/s/ + handle, and it parses back', () => {
    const link = buildSecretLink('https://notes.example/app/', H1);
    expect(link).toBe(`https://notes.example/app/#/s/${H1}`);
    expect(parseSecretLinkUrl(new URL(link))).toEqual({ kind: 'resolve', handle: H1, ordinal: null });
  });

  it('refuses a bad handle or a base with query/fragment', () => {
    expect(() => buildSecretLink('https://notes.example/', 'TnYgaHGXuUjYvmglbl6DhB')).toThrow();
    expect(() => buildSecretLink('https://notes.example/?x', H1)).toThrow();
    expect(() => buildSecretLink('https://notes.example/#', H1)).toThrow();
  });
});

const indexRec = (over: Partial<IndexRecord> = {}): IndexRecord => ({
  v: 1, root: ROOT1, head: { id: ROOT1, rev: 1, createdAt: 1000 }, indexedAt: 2000, ...over,
});
const receiptRec = (over: Partial<ReceiptRecord> = {}): ReceiptRecord => ({
  v: 1, opOrigin: 'https://baobook.example', opId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  handle: H1, link: `https://notes.example/#/s/${H1}`, title: 'API key', committedAt: 10_000, ...over,
});

describe('validators', () => {
  it('isIndexBlob', () => {
    expect(isIndexBlob({ v: 1, iv: 'a', ct: 'b' })).toBe(true);
    for (const x of [{}, null, undefined, [], { v: 1, iv: 'a' }, { v: 2, iv: 'a', ct: 'b' },
      { v: 1, iv: '', ct: 'b' }, { v: 1, iv: 'a', ct: 'b', x: 1 }, { v: 1, iv: 'a', ct: 5 }]) {
      expect(isIndexBlob(x)).toBe(false);
    }
  });

  it('isIndexRecord', () => {
    expect(isIndexRecord(indexRec())).toBe(true);
    expect(isIndexRecord({ ...indexRec(), extra: 1 })).toBe(false);
    expect(isIndexRecord(indexRec({ root: 'ABCDEF00-0000-8000-8000-000000000001' }))).toBe(false);
    expect(isIndexRecord(indexRec({ head: { id: ROOT1, rev: 0, createdAt: 1 } }))).toBe(false);
    expect(isIndexRecord(indexRec({ head: { id: ROOT1, rev: 1, createdAt: -1 } }))).toBe(false);
    expect(isIndexRecord(indexRec({ head: { id: '', rev: 1, createdAt: 1 } }))).toBe(false);
    expect(isIndexRecord(indexRec({ indexedAt: 1.5 }))).toBe(false);
    expect(isIndexRecord({ ...indexRec(), head: { id: ROOT1, rev: 1, createdAt: 1, x: 1 } })).toBe(false);
  });

  it('isCoverageRecord: sorted, unique, exact pairs', () => {
    expect(isCoverageRecord({ v: 1, rows: [] })).toBe(true);
    expect(isCoverageRecord({ v: 1, rows: [['a', 'x'], ['b', 'y']] })).toBe(true);
    expect(isCoverageRecord({ v: 1, rows: [['b', 'y'], ['a', 'x']] })).toBe(false); // unsorted
    expect(isCoverageRecord({ v: 1, rows: [['a', 'x'], ['a', 'y']] })).toBe(false); // duplicate id
    expect(isCoverageRecord({ v: 1, rows: [['a', 'x', 'z']] })).toBe(false);
    expect(isCoverageRecord({ v: 1, rows: [['a', '']] })).toBe(false);
    expect(isCoverageRecord({ v: 1, rows: [['a']] })).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(isCoverageRecord({ v: 1, rows: [['a', 'x'], , ['c', 'z']] })).toBe(false);
    expect(isCoverageRecord({ v: 1, rows: [['a', 'x']], extra: true })).toBe(false);
    expect(isCoverageRecord({ v: 2, rows: [] })).toBe(false);
  });

  it('isReceiptRecord', () => {
    expect(isReceiptRecord(receiptRec())).toBe(true);
    expect(isReceiptRecord(receiptRec({ opOrigin: 'https://baobook.example/' }))).toBe(false);
    expect(isReceiptRecord(receiptRec({ opId: ROOT1 }))).toBe(false); // not v4
    expect(isReceiptRecord(receiptRec({ handle: 'TnYgaHGXuUjYvmglbl6DhB' }))).toBe(false);
    expect(isReceiptRecord(receiptRec({ link: '' }))).toBe(false);
    expect(isReceiptRecord(receiptRec({ title: 'x'.repeat(201) }))).toBe(false);
    expect(isReceiptRecord({ ...receiptRec(), extra: 1 })).toBe(false);
  });

  it('isDropMessage', () => {
    const opId = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    const ok = [
      { t: 'matamata.drop.ready', v: 1 },
      { t: 'matamata.drop.secret', v: 1, opId, title: '', value: 'x' },
      { t: 'matamata.drop.lookup', v: 1, opId },
      { t: 'matamata.drop.result', v: 1, opId, link: 'https://n/#/s/x', title: 't' },
      { t: 'matamata.drop.error', v: 1, code: 'busy' },
      { t: 'matamata.drop.error', v: 1, opId, code: 'expired' },
    ];
    for (const m of ok) expect(isDropMessage(m)).toBe(true);
    const bad = [
      null, 'x', [], { t: 'matamata.drop.ready', v: 2 }, { t: 'matamata.drop.ready', v: 1, x: 1 },
      { t: 'matamata.drop.secret', v: 1, opId: 'nope', title: '', value: 'x' },
      { t: 'matamata.drop.secret', v: 1, opId, title: '', value: 1 },
      { t: 'matamata.drop.lookup', v: 1 },
      { t: 'matamata.drop.result', v: 1, opId, link: '', title: 't' },
      { t: 'matamata.drop.error', v: 1, code: 'boom' },
      { t: 'matamata.drop.error', v: 1, opId: undefined, code: 'busy' },
      { t: 'matamata.drop.other', v: 1 },
    ];
    for (const m of bad) expect(isDropMessage(m)).toBe(false);
  });

  it('validateDropInput', () => {
    expect(validateDropInput({ title: '  t  ', value: ' v\r\n' })).toEqual({ ok: true, title: 't', value: ' v\r\n' });
    expect(validateDropInput({ title: '   ', value: 'v' })).toEqual({ ok: true, title: 'Секрет без названия', value: 'v' });
    expect(validateDropInput({ title: '😀'.repeat(200), value: 'v' }).ok).toBe(true);
    expect(validateDropInput({ title: '😀'.repeat(201), value: 'v' })).toEqual({ ok: false, reason: 'title' });
    expect(validateDropInput({ title: '', value: '' })).toEqual({ ok: false, reason: 'value' });
    expect(validateDropInput({ title: '', value: ' ' }).ok).toBe(true); // no trim
    expect(validateDropInput({ title: '', value: '😀'.repeat(64_000) }).ok).toBe(true);
    expect(validateDropInput({ title: '', value: 'x'.repeat(64_001) })).toEqual({ ok: false, reason: 'value' });
    expect(validateDropInput({ title: 1, value: 'v' })).toEqual({ ok: false, reason: 'title' });
    expect(validateDropInput({ title: '', value: null })).toEqual({ ok: false, reason: 'value' });
  });
});

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('encryptIndexBlob / decryptIndexBlob', () => {
  it('round-trips, with a fresh IV each time', async () => {
    const k = await aesKey();
    const a = await encryptIndexBlob(k, indexRec());
    const b = await encryptIndexBlob(k, indexRec());
    expect(isIndexBlob(a)).toBe(true);
    expect(a.iv).not.toBe(b.iv);
    expect(await decryptIndexBlob(k, a)).toEqual(indexRec());
  });

  it('a wrong key or a tampered ct fails; tryDecrypt never throws', async () => {
    const a = await encryptIndexBlob(await aesKey(), indexRec());
    const other = await aesKey();
    await expect(decryptIndexBlob(other, a)).rejects.toThrow();
    expect(await tryDecryptIndexBlob(other, a)).toEqual({ ok: false });
    expect(await tryDecryptIndexBlob(other, { v: 1, iv: '!!', ct: '!!' })).toEqual({ ok: false });
    expect(await tryDecryptIndexBlob(other, {})).toEqual({ ok: false });
  });
});

describe('classifyKey — §1.3 table by role', () => {
  const blob = { v: 1 as const, iv: 'iv', ct: 'CT' };
  const now = 1_000_000_000;

  it('absent', () => {
    for (const role of ['index', 'coverage', 'receipt'] as const) {
      expect(classifyKey({ present: false }, role, now)).toEqual({ kind: 'absent' });
    }
  });

  it.each([
    ['{}', {}], ['null', null], ['without ct', { v: 1, iv: 'iv' }], ['undefined value', undefined],
  ])('malformed: %s, for every role', (_, raw) => {
    for (const role of ['index', 'coverage', 'receipt'] as const) {
      expect(classifyKey({ present: true, raw }, role, now, { ok: true, plain: indexRec() }).kind).toBe('malformed');
    }
  });

  it('malformed: blob that did not decrypt / no decryption supplied', () => {
    expect(classifyKey({ present: true, raw: blob }, 'index', now, { ok: false }).kind).toBe('malformed');
    expect(classifyKey({ present: true, raw: blob }, 'coverage', now).kind).toBe('malformed');
  });

  it('malformed: decrypted plaintext of the wrong role', () => {
    expect(classifyKey({ present: true, raw: blob }, 'coverage', now, { ok: true, plain: indexRec() }).kind).toBe('malformed');
    expect(classifyKey({ present: true, raw: blob }, 'index', now, { ok: true, plain: { v: 1, rows: [] } }).kind).toBe('malformed');
    expect(classifyKey({ present: true, raw: blob }, 'receipt', now, { ok: true, plain: indexRec() }).kind).toBe('malformed');
  });

  it('live index / coverage carry ct and record', () => {
    expect(classifyKey({ present: true, raw: blob }, 'index', now, { ok: true, plain: indexRec() }))
      .toEqual({ kind: 'live', ct: 'CT', record: indexRec() });
    const cov: CoverageRecord = { v: 1, rows: [['a', 'x']] };
    expect(classifyKey({ present: true, raw: blob }, 'coverage', now, { ok: true, plain: cov }))
      .toEqual({ kind: 'live', ct: 'CT', record: cov });
  });

  it('receipt: live strictly before committedAt + 24 h, expired at and after', () => {
    const r = receiptRec({ committedAt: now - SECRET_RECEIPT_TTL_MS + 1 });
    expect(classifyKey({ present: true, raw: blob }, 'receipt', now, { ok: true, plain: r }).kind).toBe('live');
    const e = receiptRec({ committedAt: now - SECRET_RECEIPT_TTL_MS });
    expect(classifyKey({ present: true, raw: blob }, 'receipt', now, { ok: true, plain: e }))
      .toEqual({ kind: 'expired', ct: 'CT', record: e });
  });

  it('index/coverage never expire', () => {
    const old = indexRec({ indexedAt: 0, head: { id: ROOT1, rev: 1, createdAt: 0 } });
    expect(classifyKey({ present: true, raw: blob }, 'index', Number.MAX_SAFE_INTEGER, { ok: true, plain: old }).kind).toBe('live');
  });
});

describe('chooseHead — byCurrentness tie-break', () => {
  const v = (id: string, createdAt: number, rev: number) => ({ id, createdAt, rev, root: ROOT1 });

  it('createdAt DESC, then rev DESC, then id ASC', () => {
    expect(chooseHead([v('a', 1, 1), v('b', 2, 1)])?.id).toBe('b');
    expect(chooseHead([v('a', 2, 1), v('b', 2, 3)])?.id).toBe('b');
    expect(chooseHead([v('b', 2, 3), v('a', 2, 3)])?.id).toBe('a');
    expect(chooseHead([v('a', 2, 3), v('b', 2, 3)])?.id).toBe('a');
    expect(chooseHead([])).toBeNull();
  });

  it('an index head competes as a ChainVersion («never lower the head»)', () => {
    const rec = indexRec({ head: { id: 'z', rev: 2, createdAt: 5 } });
    expect(chooseHead([indexHeadVersion(rec), v('a', 4, 9)])?.id).toBe('z');
    expect(chooseHead([indexHeadVersion(rec), v('a', 6, 1)])?.id).toBe('a');
  });
});

describe('coverageDelta', () => {
  it('delta and missing by exact pair', () => {
    const rows: CoverageRow[] = [['a', 'x'], ['b', 'y'], ['c', 'NEW']];
    const cov: CoverageRow[] = [['a', 'x'], ['c', 'z'], ['d', 'w']];
    expect(coverageDelta(rows, cov)).toEqual({
      delta: [['b', 'y'], ['c', 'NEW']],
      missing: [['c', 'z'], ['d', 'w']],
    });
  });

  it('equal sets → both empty', () => {
    expect(coverageDelta([['a', 'x']], [['a', 'x']])).toEqual({ delta: [], missing: [] });
  });

  it('pair encoding is unambiguous', () => {
    expect(coverageDelta([['a,b', 'c']], [['a', 'b,c']]).delta).toHaveLength(1);
  });
});

describe('authSnapshotEquals / issueSnapshotEquals', () => {
  const b64 = (n: number, fill: number) => btoa(String.fromCharCode(...new Array<number>(n).fill(fill)));
  // A structurally valid stored PIN blob (pbkdf2 — no Argon2 profile needed).
  const pinSeed = { ciphertext: b64(32, 1), iv: b64(12, 2), salt: b64(16, 3), kdf: 'pbkdf2' } as unknown as PinEncryptedSeed;
  // Stand-in for storage.ts pinSeedEquals (the real one is exercised through
  // readIssueSnapshot in store.secret-index.test.tsx): field-wise, objects only.
  const pinSeedEq = (a: unknown, b: unknown) => {
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
    const x = a as PinEncryptedSeed, y = b as PinEncryptedSeed;
    return x.ciphertext === y.ciphertext && x.iv === y.iv && x.salt === y.salt && x.kdf === y.kdf && x.v === y.v;
  };
  const prf: QuickUnlockRecord = {
    v: 1, credentialId: 'cred', prfSalt: 'p', hkdfSalt: 'h', iv: 'i', ciphertext: 'c', pk: 'pk', createdAt: 1,
  };
  const pinAuth: AuthSnapshot = {
    factor: 'pin', pinSeed, enabled: true, origins: ['https://a.example', 'https://b.example'],
    configId: 'cfg', lockGeneration: 3,
  };
  const prfAuth: AuthSnapshot = {
    factor: 'prf', prfRecord: prf, pinPresent: true, enabled: true, origins: ['https://a.example'],
    configId: 'cfg', lockGeneration: 0,
  };
  const current = (over: Partial<CurrentAuth> = {}): CurrentAuth => ({
    pinSeed: { ...pinSeed }, quickUnlock: { kind: 'valid', record: { ...prf } }, enabled: true,
    origins: ['https://a.example', 'https://b.example'], configId: 'cfg', lockGeneration: 3, ...over,
  });

  it('pin branch: every field', () => {
    expect(authSnapshotEquals(current(), pinAuth, pinSeedEq)).toBe(true);
    expect(authSnapshotEquals(current({ pinSeed: undefined }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ pinSeed: { ...pinSeed, ciphertext: 'x' } }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ enabled: undefined }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ enabled: 'true' }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ origins: ['https://b.example', 'https://a.example'] }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ origins: ['https://a.example'] }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ origins: undefined }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ configId: null }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ configId: 'other' }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ lockGeneration: 4 }), pinAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals(current({ lockGeneration: '3' }), pinAuth, pinSeedEq)).toBe(false);
  });

  it('lock generation: absent counter = 0, damaged never matches', () => {
    const at0: AuthSnapshot = { ...pinAuth, lockGeneration: 0 };
    expect(authSnapshotEquals(current({ lockGeneration: undefined }), at0, pinSeedEq)).toBe(true);
    expect(authSnapshotEquals(current({ lockGeneration: 0 }), at0, pinSeedEq)).toBe(true);
    for (const bad of [null, '0', -0.5, NaN, {}]) {
      expect(authSnapshotEquals(current({ lockGeneration: bad }), at0, pinSeedEq)).toBe(false);
    }
    expect(lockGenerationMatches(undefined, 0)).toBe(true);
    expect(lockGenerationMatches(undefined, 1)).toBe(false);
    expect(lockGenerationMatches('3', 3)).toBe(false);
  });

  it('prf branch: valid record + a usable pin-seed', () => {
    const c = current({ origins: ['https://a.example'], lockGeneration: 0 });
    expect(authSnapshotEquals(c, prfAuth, pinSeedEq)).toBe(true);
    expect(authSnapshotEquals({ ...c, pinSeed: undefined }, prfAuth, pinSeedEq)).toBe(false);
    // A damaged pin-seed counts as absent, exactly like a missing one.
    expect(authSnapshotEquals({ ...c, pinSeed: {} }, prfAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals({ ...c, pinSeed: { ...pinSeed, iv: 'short' } }, prfAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals({ ...c, quickUnlock: { kind: 'none' } }, prfAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals({ ...c, quickUnlock: { kind: 'stale', reason: 'no-pin' } }, prfAuth, pinSeedEq)).toBe(false);
    expect(authSnapshotEquals({ ...c, quickUnlock: { kind: 'valid', record: { ...prf, ciphertext: 'x' } } }, prfAuth, pinSeedEq))
      .toBe(false);
  });

  const snap: IssueSnapshot = {
    recCt: 'R', covCt: 'C', headMetaIv: 'H', rows: [['a', 'x'], ['b', 'y']], auth: pinAuth,
  };
  const read = (over: Partial<IssueSnapshotRead> = {}): IssueSnapshotRead => ({
    recCt: 'R', covCt: 'C', headMetaIv: 'H', rows: [['a', 'x'], ['b', 'y']], currentAuth: current(), ...over,
  });

  it('fresh snapshot → true', () => {
    expect(issueSnapshotEquals(read(), snap, pinAuth, pinSeedEq)).toBe(true);
  });

  it.each([
    ['recCt', { recCt: 'R2' }], ['recCt gone', { recCt: null }], ['covCt', { covCt: 'C2' }],
    ['covCt gone', { covCt: null }], ['headMetaIv', { headMetaIv: 'H2' }], ['head gone', { headMetaIv: null }],
    ['new row (old writer)', { rows: [['a', 'x'], ['b', 'y'], ['c', 'z']] as CoverageRow[] }],
    ['row payload', { rows: [['a', 'x'], ['b', 'Y']] as CoverageRow[] }],
    ['row order', { rows: [['b', 'y'], ['a', 'x']] as CoverageRow[] }],
    ['auth', { currentAuth: current({ lockGeneration: 4 }) }],
  ])('stale %s → false', (_, over) => {
    expect(issueSnapshotEquals(read(over as Partial<IssueSnapshotRead>), snap, pinAuth, pinSeedEq)).toBe(false);
  });

  it('op.auth disagreeing with the snapshot auth → false (nothing reconstructed)', () => {
    expect(issueSnapshotEquals(read(), snap, { ...pinAuth, configId: 'other' }, pinSeedEq)).toBe(false);
  });
});

describe('rawEquals — exact, fail-closed (5-M3)', () => {
  it('present-undefined ≠ absent key', () => {
    expect(rawEquals({}, { a: undefined })).toBe(false);
    expect(rawEquals({ a: undefined }, {})).toBe(false);
    expect(rawEquals({ a: undefined }, { a: undefined })).toBe(true);
    expect(rawEquals(undefined, undefined)).toBe(true);
  });

  it('NaN and null', () => {
    expect(rawEquals(NaN, NaN)).toBe(true);
    expect(rawEquals({ x: NaN }, { x: NaN })).toBe(true);
    expect(rawEquals(null, null)).toBe(true);
    expect(rawEquals(null, undefined)).toBe(false);
    expect(rawEquals(null, {})).toBe(false);
    expect(rawEquals({}, null)).toBe(false);
    expect(rawEquals(0, -0)).toBe(false);
    expect(rawEquals(1, '1')).toBe(false);
  });

  it('array hole / undefined / null are three different things', () => {
    // eslint-disable-next-line no-sparse-arrays
    const hole = [1, , 3];
    const undef = [1, undefined, 3];
    const nul = [1, null, 3];
    expect(rawEquals(hole, undef)).toBe(false);
    expect(rawEquals(undef, hole)).toBe(false);
    expect(rawEquals(undef, nul)).toBe(false);
    expect(rawEquals(hole, nul)).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(rawEquals(hole, [1, , 3])).toBe(true);
    expect(rawEquals(undef, [1, undefined, 3])).toBe(true);
    expect(rawEquals([1, 2], [1, 2, 3])).toBe(false);
    const extra = Object.assign([1], { x: 1 });
    expect(rawEquals(extra, Object.assign([1], { x: 1 }))).toBe(false);
  });

  it('deep plain structures compare by value, key order irrelevant', () => {
    expect(rawEquals({ a: [1, { b: 'x' }], c: true }, { c: true, a: [1, { b: 'x' }] })).toBe(true);
    expect(rawEquals({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false);
    expect(rawEquals([], {})).toBe(false);
    expect(rawEquals(Object.create(null), {})).toBe(true);
  });

  it('outside the domain → false, even against itself', () => {
    const d = new Date(0);
    expect(rawEquals(d, d)).toBe(false);
    expect(rawEquals(new Date(0), new Date(0))).toBe(false);
    const m = new Map();
    expect(rawEquals(m, m)).toBe(false);
    expect(rawEquals(new Set(), new Set())).toBe(false);
    expect(rawEquals(1n, 1n)).toBe(false);
    expect(rawEquals({ x: 1n }, { x: 1n })).toBe(false);
    expect(rawEquals(new ArrayBuffer(1), new ArrayBuffer(1))).toBe(false);
    expect(rawEquals(new Uint8Array(1), new Uint8Array(1))).toBe(false);
    expect(rawEquals(Object(1), Object(1))).toBe(false);
    const s = Symbol('s');
    expect(rawEquals(s, s)).toBe(false);
    expect(rawEquals({ [s]: 1 }, { [s]: 1 })).toBe(false);
    const f = () => 0;
    expect(rawEquals(f, f)).toBe(false);
    class Sub extends Array {}
    expect(rawEquals(new Sub(), new Sub())).toBe(false);
  });

  it('cycles → false', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(rawEquals(a, a)).toBe(false);
    const b: unknown[] = [];
    b.push(b);
    expect(rawEquals(b, b)).toBe(false);
  });

  it('shared (non-cyclic) references are fine', () => {
    const shared = { k: 1 };
    expect(rawEquals({ a: shared, b: shared }, { a: { k: 1 }, b: { k: 1 } })).toBe(true);
  });
});
