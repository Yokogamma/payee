import { describe, it, expect } from 'vitest';
import {
  parseQuickUnlockRecord,
  quickUnlockBelongsToVault,
  quickUnlockRecordEquals,
  judgeQuickUnlock,
  bytesToBase64Url,
  base64UrlToBytes,
  type QuickUnlockRecord,
} from './quick-unlock';
import { bufferToBase64 } from './crypto';

const b64 = (n: number, fill = 1) => bufferToBase64(new Uint8Array(n).fill(fill));
const b64url = (n: number, fill = 1) => bytesToBase64Url(new Uint8Array(n).fill(fill));

const PK = b64(32, 9);

function record(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    v: 1,
    credentialId: b64url(32),
    prfSalt: b64(32, 2),
    hkdfSalt: b64(32, 3),
    iv: b64(12, 4),
    ciphertext: b64(48, 5),
    pk: PK,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

const valid = () => parseQuickUnlockRecord(record()) as QuickUnlockRecord;

// ─── base64url helpers ───────────────────────────────────────────────

describe('base64url helpers', () => {
  it('round-trip without padding', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const s = bytesToBase64Url(bytes);
    expect(s).not.toContain('=');
    expect(Array.from(base64UrlToBytes(s) ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects standard-base64 characters and padding', () => {
    expect(base64UrlToBytes('a+b/c=')).toBeNull();
    expect(base64UrlToBytes('AAAA=')).toBeNull();
  });

  it('rejects a NON-canonical spelling of the same bytes', () => {
    // 'AQ' and 'AR' decode to the same single byte; only one is canonical.
    const canonical = bytesToBase64Url(new Uint8Array([1]));
    expect(base64UrlToBytes(canonical)).not.toBeNull();
    const other = canonical === 'AQ' ? 'AR' : 'AQ';
    expect(base64UrlToBytes(other)).toBeNull();
  });
});

// ─── Record validation (fail-closed) ─────────────────────────────────

describe('parseQuickUnlockRecord', () => {
  it('accepts a well-formed record', () => {
    expect(parseQuickUnlockRecord(record())).not.toBeNull();
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 42, 'x', []]) expect(parseQuickUnlockRecord(bad)).toBeNull();
  });

  it('rejects any version other than 1', () => {
    for (const v of [0, 2, '1', undefined]) expect(parseQuickUnlockRecord(record({ v }))).toBeNull();
  });

  it('rejects a credentialId that is not canonical base64url', () => {
    expect(parseQuickUnlockRecord(record({ credentialId: b64(32) }))).toBeNull(); // standard b64
    expect(parseQuickUnlockRecord(record({ credentialId: 'not base64!' }))).toBeNull();
    expect(parseQuickUnlockRecord(record({ credentialId: 42 }))).toBeNull();
  });

  it('rejects a credentialId outside 16…1024 bytes', () => {
    expect(parseQuickUnlockRecord(record({ credentialId: b64url(15) }))).toBeNull();
    expect(parseQuickUnlockRecord(record({ credentialId: b64url(1025) }))).toBeNull();
    expect(parseQuickUnlockRecord(record({ credentialId: b64url(16) }))).not.toBeNull();
    expect(parseQuickUnlockRecord(record({ credentialId: b64url(1024) }))).not.toBeNull();
  });

  it('rejects salts that are not exactly 32 bytes', () => {
    for (const n of [31, 33]) {
      expect(parseQuickUnlockRecord(record({ prfSalt: b64(n) }))).toBeNull();
      expect(parseQuickUnlockRecord(record({ hkdfSalt: b64(n) }))).toBeNull();
    }
  });

  it('rejects an iv that is not exactly 12 bytes', () => {
    for (const n of [11, 13, 16]) expect(parseQuickUnlockRecord(record({ iv: b64(n) }))).toBeNull();
  });

  it('rejects a ciphertext shorter than the GCM tag', () => {
    expect(parseQuickUnlockRecord(record({ ciphertext: b64(15) }))).toBeNull();
    expect(parseQuickUnlockRecord(record({ ciphertext: b64(16) }))).not.toBeNull();
  });

  it('rejects a ciphertext over the upper bound — before it reaches WebCrypto', () => {
    expect(parseQuickUnlockRecord(record({ ciphertext: b64(256) }))).not.toBeNull();
    expect(parseQuickUnlockRecord(record({ ciphertext: b64(257) }))).toBeNull();
    // A hostile length must be refused on the ENCODED string, without
    // allocating megabytes from the record's own claim.
    expect(parseQuickUnlockRecord(record({ ciphertext: 'A'.repeat(5_000_000) }))).toBeNull();
  });

  it('rejects non-canonical base64 in a binary field', () => {
    // 12 bytes canonically end in '=='; flipping the last data char changes
    // the ignored trailing bits, which atob tolerates and we must not.
    const canonical = b64(12, 4);
    const tweaked = canonical.slice(0, -3) + (canonical[canonical.length - 3] === 'A' ? 'B' : 'A') + '==';
    expect(tweaked).not.toBe(canonical);
    expect(parseQuickUnlockRecord(record({ iv: tweaked }))).toBeNull();
  });

  it('rejects an invalid createdAt', () => {
    for (const t of [undefined, null, '2020', -1, 1.5, Number.MAX_SAFE_INTEGER])
      expect(parseQuickUnlockRecord(record({ createdAt: t }))).toBeNull();
  });

  it('rejects an empty or oversized pk', () => {
    expect(parseQuickUnlockRecord(record({ pk: '' }))).toBeNull();
    expect(parseQuickUnlockRecord(record({ pk: 'A'.repeat(200) }))).toBeNull();
  });

  it('tolerates unknown extra fields but does NOT carry them through', () => {
    const parsed = parseQuickUnlockRecord(record({ futureField: 'whatever' }));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual(
      ['ciphertext', 'createdAt', 'credentialId', 'hkdfSalt', 'iv', 'pk', 'prfSalt', 'v'],
    );
  });
});

// ─── Vault binding and equality ──────────────────────────────────────

describe('quickUnlockBelongsToVault', () => {
  it('matches only the exact bound key', () => {
    expect(quickUnlockBelongsToVault(valid(), PK)).toBe(true);
    expect(quickUnlockBelongsToVault(valid(), b64(32, 8))).toBe(false);
    expect(quickUnlockBelongsToVault(valid(), undefined)).toBe(false);
    expect(quickUnlockBelongsToVault(valid(), '')).toBe(false);
  });
});

describe('quickUnlockRecordEquals', () => {
  it('is true for two independently parsed copies of the same record', () => {
    expect(quickUnlockRecordEquals(valid(), valid())).toBe(true);
  });

  it('is false when ANY single field differs', () => {
    const base = valid();
    const variants: Array<Partial<QuickUnlockRecord>> = [
      { credentialId: b64url(32, 7) },
      { prfSalt: b64(32, 7) },
      { hkdfSalt: b64(32, 7) },
      { iv: b64(12, 7) },
      { ciphertext: b64(48, 7) },
      { pk: b64(32, 7) },
      { createdAt: base.createdAt + 1 },
    ];
    for (const over of variants) {
      expect(quickUnlockRecordEquals(base, { ...base, ...over })).toBe(false);
    }
  });

  it('is false against null on either side', () => {
    expect(quickUnlockRecordEquals(null, valid())).toBe(false);
    expect(quickUnlockRecordEquals(valid(), null)).toBe(false);
  });
});

// ─── The compatibility rule ──────────────────────────────────────────

describe('judgeQuickUnlock — «no pin-seed ⇒ the record is void»', () => {
  const PIN = { ciphertext: 'ct', iv: 'iv', salt: 's' };

  it("'none' when the key is absent entirely", () => {
    expect(judgeQuickUnlock(undefined, PIN, PK)).toEqual({ kind: 'none' });
  });

  it("'valid' with a PIN and the matching vault", () => {
    const verdict = judgeQuickUnlock(record(), PIN, PK);
    expect(verdict.kind).toBe('valid');
  });

  it("'stale/no-pin' once the PIN is gone — an OLDER client removed it", () => {
    // The exact compatibility hole: a build without this feature clears the
    // PIN through a clearPinConfigMeta that knows nothing about the record.
    expect(judgeQuickUnlock(record(), undefined, PK)).toEqual({ kind: 'stale', reason: 'no-pin' });
  });

  it("'stale/foreign-vault' when the record belongs to another seed", () => {
    expect(judgeQuickUnlock(record(), PIN, b64(32, 8))).toEqual({ kind: 'stale', reason: 'foreign-vault' });
  });

  it("'stale/invalid' for an unparseable record — checked BEFORE the PIN", () => {
    // Order matters: a corrupt record is corrupt regardless of the PIN, and
    // reporting 'no-pin' for it would send the caller down the wrong message.
    expect(judgeQuickUnlock({ v: 2 }, undefined, PK)).toEqual({ kind: 'stale', reason: 'invalid' });
  });
});
