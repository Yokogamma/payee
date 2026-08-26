// Node environment on purpose: this suite is pure crypto + JSON with no DOM,
// and the doc-sync check below resolves a repo path from `import.meta.url`,
// which is an http URL under jsdom.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BACKUP_CAP_BYTES,
  BackupError,
  type EncodeBackupInput,
  backupFileName,
  canonicalJson,
  decodeBackup,
  deriveBackupKey,
  encodeBackup,
  headerAad,
  type BackupBody,
  type BackupRecord,
} from './backup';
import { bufferToBase64 } from './crypto';

/**
 * Container v1 — the format frozen in docs/BACKUP_FORMAT_V1.md.
 *
 * The properties worth breaking a build over: the file authenticates its own
 * open header, records travel without losing a field, ids are globally unique,
 * the nonce is fresh every time, and anything JSON would quietly mangle stops
 * the export instead of being written.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

const CREATED_AT = 1_756_000_000_000;
/** Fixed IV for the documented vector. Production NEVER injects one — the
 *  CSPRNG is stubbed here instead, which is also how the «is it really
 *  random?» test observes the single 12-byte draw. */
const VECTOR_IV = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const NOTE: BackupRecord = {
  noteId: '11111111-2222-4333-8444-555555555555',
  ciphertext: 'QUFBQQ==',
  iv: 'AAAAAAAAAAAAAAAA',
  createdAt: CREATED_AT,
};
const ENTRY: BackupRecord = {
  entryId: '88888888-9999-8aaa-baaa-cccccccccccc',
  metaCiphertext: 'QkJCQg==',
  metaIv: 'AAAAAAAAAAAAAAAA',
  secretCiphertext: 'Q0NDQw==',
  secretIv: 'AAAAAAAAAAAAAAAA',
  createdAt: CREATED_AT,
  v: 4,
};

const input = (over: Partial<Parameters<typeof encodeBackup>[0]> = {}) => ({
  notes: [NOTE],
  safebox: [ENTRY],
  incompleteRestore: false,
  containsUnsupportedRecords: false,
  createdAt: CREATED_AT,
  ...over,
});

function stubIv(iv: Uint8Array = VECTOR_IV) {
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
    if (buf instanceof Uint8Array) buf.set(iv.subarray(0, buf.length));
    return buf;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonicalJson', () => {
  it('sorts keys, keeps array order and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, 2, 1], c: { z: null, y: true } }))
      .toBe('{"a":[3,2,1],"b":1,"c":{"y":true,"z":null}}');
  });

  it('sorts by CODE POINT, not by UTF-16 code unit', () => {
    // 'Ｚ' (fullwidth Z) is a single code unit ABOVE the surrogate range,
    // while '𝄞' is an astral pair whose first unit is LOWER. Default sort
    // would put them the other way round.
    const out = canonicalJson({ 'Ｚ': 1, '\u{1D11E}': 2 });
    expect(out.indexOf('Ｚ')).toBeLessThan(out.indexOf('\u{1D11E}'));
  });

  it.each([
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a BigInt', { a: 1n }],
    ['a Date', { a: new Date(0) }],
    ['a Map', { a: new Map() }],
    ['a Set', { a: new Set() }],
    ['an ArrayBuffer', { a: new ArrayBuffer(4) }],
    ['a typed array', { a: new Uint8Array(4) }],
    ['NaN', { a: NaN }],
    ['Infinity', { a: Infinity }],
    ['-Infinity', { a: -Infinity }],
    ['negative zero', { a: -0 }],
  ])('refuses %s instead of mangling it', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(BackupError);
  });

  it('refuses a class instance (non-plain prototype)', () => {
    class Holder { x = 1; }
    expect(() => canonicalJson({ a: new Holder() })).toThrow(BackupError);
  });

  it('refuses a sparse array — the hole would come back as null', () => {
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(() => canonicalJson({ a: sparse })).toThrow(BackupError);
  });

  it('refuses extra non-index properties on an array — they would vanish', () => {
    const arr: unknown[] & { note?: string } = [1, 2];
    arr.note = 'lost';
    expect(() => canonicalJson({ a: arr })).toThrow(BackupError);
  });

  it('refuses a symbol key and a symbol value', () => {
    expect(() => canonicalJson({ [Symbol('k')]: 1, a: 2 })).toThrow(BackupError);
    expect(() => canonicalJson({ a: Symbol('v') })).toThrow(BackupError);
  });

  it('refuses a cycle instead of hanging', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(BackupError);
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('carries every unsupported value out as a typed export failure', () => {
    try {
      canonicalJson({ a: { b: [new Date(0)] } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BackupError);
      expect((e as BackupError).code).toBe('unsupported_value');
      expect((e as BackupError).at).toBe('$.a.b[0]');
    }
  });
});

describe('container round-trip', () => {
  it('re-reads exactly what was written', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);

    const { header, body } = await decodeBackup(text, key);

    expect(header).toEqual({
      format: 'eternal-notes-backup',
      v: 1,
      minReaderVersion: 1,
      containsUnsupportedRecords: false,
      createdAt: CREATED_AT,
    });
    expect(body.counts).toEqual({ notes: 1, safebox: 1 });
    expect(body.incompleteRestore).toBe(false);
    expect(canonicalJson(body.notes)).toBe(canonicalJson([NOTE]));
    expect(canonicalJson(body.safebox)).toBe(canonicalJson([ENTRY]));
  });

  it('carries UNKNOWN fields through untouched (opaque round-trip)', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const exotic: BackupRecord = { ...NOTE, v: 9, futureField: { nested: [1, 2, 3] }, extra: null };
    const entryExotic: BackupRecord = { ...ENTRY, futureHalf: 'ZZZZ' };

    const text = await encodeBackup(
      input({ notes: [exotic], safebox: [entryExotic], containsUnsupportedRecords: true }), key);
    const { header, body } = await decodeBackup(text, key);

    expect(header.containsUnsupportedRecords).toBe(true);
    expect(canonicalJson(body.notes[0])).toBe(canonicalJson(exotic));
    expect(canonicalJson(body.safebox[0])).toBe(canonicalJson(entryExotic));
  });

  it('a v1 note with NO `v` of its own survives without gaining one', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input({ safebox: [] }), key);

    const { body } = await decodeBackup(text, key);

    expect(Object.hasOwn(body.notes[0], 'v')).toBe(false);
  });

  it('an empty store round-trips', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input({ notes: [], safebox: [] }), key);
    const { body } = await decodeBackup(text, key);
    expect(body.counts).toEqual({ notes: 0, safebox: 0 });
  });

  it('carries NO sync section — publication state is never in the file (D6)', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const { body } = await decodeBackup(text, key);

    expect(Object.keys(body).sort()).toEqual(['counts', 'incompleteRestore', 'notes', 'safebox']);
    // And the ciphertext cannot be hiding one: the body has exact keys.
    expect(text).not.toContain('sync');
  });
});

describe('authentication', () => {
  it('a different seed phrase cannot open the file', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const other = await deriveBackupKey(OTHER_MNEMONIC);
    const text = await encodeBackup(input(), key);

    await expect(decodeBackup(text, other)).rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('editing the OPEN header breaks decryption — the header is the AAD', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const tampered = JSON.parse(text) as Record<string, unknown>;
    tampered.createdAt = CREATED_AT + 1;

    await expect(decodeBackup(JSON.stringify(tampered), key))
      .rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('flipping containsUnsupportedRecords breaks decryption too', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const tampered = JSON.parse(text) as Record<string, unknown>;
    tampered.containsUnsupportedRecords = true;

    await expect(decodeBackup(JSON.stringify(tampered), key))
      .rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('the AAD is the canonical header and nothing else', async () => {
    const aad = new TextDecoder().decode(headerAad({
      format: 'eternal-notes-backup', v: 1, minReaderVersion: 1,
      containsUnsupportedRecords: false, createdAt: CREATED_AT,
    }));
    expect(aad).toBe(
      '{"containsUnsupportedRecords":false,"createdAt":1756000000000,'
      + '"format":"eternal-notes-backup","minReaderVersion":1,"v":1}',
    );
  });

  it('an extra top-level key is refused — it would sit OUTSIDE the AAD', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const smuggled = { ...JSON.parse(text), note: 'trust me' };

    await expect(decodeBackup(JSON.stringify(smuggled), key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });
});

describe('the nonce contract (D3)', () => {
  it('draws exactly ONE 12-byte value from the CSPRNG per export', async () => {
    const spy = stubIv();
    const key = await deriveBackupKey(MNEMONIC);

    await encodeBackup(input(), key);

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as Uint8Array;
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(arg.length).toBe(12);
  });

  it('two exports of the SAME data use different nonces', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const first = JSON.parse(await encodeBackup(input(), key)) as { body: { iv: string } };
    const second = JSON.parse(await encodeBackup(input(), key)) as { body: { iv: string } };
    expect(first.body.iv).not.toBe(second.body.iv);
  });

  it('refuses an IV that is not exactly 12 bytes', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const broken = JSON.parse(text) as { body: { iv: string } };
    broken.body.iv = bufferToBase64(new Uint8Array(11));

    await expect(decodeBackup(JSON.stringify(broken), key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });

  it('refuses a ciphertext shorter than the GCM tag', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const broken = JSON.parse(text) as { body: { ciphertext: string } };
    broken.body.ciphertext = bufferToBase64(new Uint8Array(15));

    await expect(decodeBackup(JSON.stringify(broken), key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });

  it('refuses non-canonical base64 in the envelope', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const broken = JSON.parse(text) as { body: { ciphertext: string } };
    broken.body.ciphertext = `${broken.body.ciphertext}\n`;

    await expect(decodeBackup(JSON.stringify(broken), key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });
});

describe('version gates', () => {
  it.each([
    ['a newer container version', 'v'],
    ['a higher minReaderVersion', 'minReaderVersion'],
  ])('%s reads as «made by a newer app», not «damaged»', async (_name, field) => {
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const newer = JSON.parse(text) as Record<string, unknown>;
    newer[field] = 2;

    await expect(decodeBackup(JSON.stringify(newer), key)).rejects.toMatchObject({ code: 'too_new' });
  });

  it('a foreign format is not a container at all', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    await expect(decodeBackup('{"format":"something-else"}', key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });

  it('plain garbage is not a container', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    await expect(decodeBackup('not json at all', key))
      .rejects.toMatchObject({ code: 'not_a_container' });
  });
});

describe('body consistency', () => {
  /** Re-encrypts a deliberately inconsistent body and hands back the FILE, so
   *  the assertion below observes `decodeBackup` rejecting — awaiting the
   *  decode inside this helper would throw here instead. */
  async function tamperBody(mutate: (body: BackupBody) => void): Promise<{ text: string; key: CryptoKey }> {
    // Re-encrypt a deliberately inconsistent body with the real key: the file
    // authenticates, so the failure can only come from the content checks.
    const key = await deriveBackupKey(MNEMONIC);
    const text = await encodeBackup(input(), key);
    const { body } = await decodeBackup(text, key);
    mutate(body);

    const container = JSON.parse(text) as { body: { iv: string; ciphertext: string } };
    const header = { ...JSON.parse(text) } as Record<string, unknown>;
    delete header.body;
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128,
        additionalData: new TextEncoder().encode(canonicalJson(header)) as BufferSource,
      },
      key,
      new TextEncoder().encode(canonicalJson(body)),
    );
    container.body = { iv: bufferToBase64(iv), ciphertext: bufferToBase64(ciphertext) };
    return { text: JSON.stringify(container), key };
  }

  async function expectCorrupt(prepared: Promise<{ text: string; key: CryptoKey }>): Promise<void> {
    const { text, key } = await prepared;
    await expect(decodeBackup(text, key)).rejects.toMatchObject({ code: 'corrupt' });
  }

  it('counts that disagree with the collections are corruption', async () => {
    await expectCorrupt(tamperBody(b => { b.counts.notes = 5; }));
  });

  it('a duplicate note id is refused (D10)', async () => {
    await expectCorrupt(tamperBody(b => {
      b.notes = [NOTE, { ...NOTE }];
      b.counts.notes = 2;
    }));
  });

  it('a duplicate safebox id is refused (D10)', async () => {
    await expectCorrupt(tamperBody(b => {
      b.safebox = [ENTRY, { ...ENTRY }];
      b.counts.safebox = 2;
    }));
  });

  it('an id used by BOTH collections is refused — one key space downstream (D10)', async () => {
    await expectCorrupt(tamperBody(b => {
      b.safebox = [{ ...ENTRY, entryId: NOTE.noteId as string }];
    }));
  });

  it('a note without a noteId is corruption', async () => {
    await expectCorrupt(tamperBody(b => {
      b.notes = [{ ciphertext: 'QUFBQQ==' }];
    }));
  });

  it('a safebox entry without a version is corruption', async () => {
    await expectCorrupt(tamperBody(b => {
      const rest = { ...ENTRY };
      delete rest.v;
      b.safebox = [rest];
    }));
  });

  it.each([
    ['an empty note id', (b: BackupBody) => { b.notes = [{ ...NOTE, noteId: '' }]; }],
    ['a non-string note id', (b: BackupBody) => { b.notes = [{ ...NOTE, noteId: 42 }]; }],
    ['a safebox entry without a version', (b: BackupBody) => {
      const rest = { ...ENTRY };
      delete rest.v;
      b.safebox = [rest];
    }],
  ])('%s is refused on the way IN as well as on the way OUT', async (_name, mutate) => {
    // Symmetry, asserted on the ROUTE and not merely on the shared function:
    // the same defect is refused by the encoder AND by the decoder reading a
    // properly authenticated container that carries it. An encoder laxer than
    // its decoder would produce a file that only fails at restore time, on
    // another device, possibly after the original data is gone.
    const key = await deriveBackupKey(MNEMONIC);
    const exported = { ...input() } as unknown as BackupBody;
    mutate(exported);
    await expect(encodeBackup({
      notes: exported.notes,
      safebox: exported.safebox,
      incompleteRestore: false,
      containsUnsupportedRecords: false,
      createdAt: CREATED_AT,
    }, key)).rejects.toMatchObject({ code: 'corrupt' });

    await expectCorrupt(tamperBody(mutate));
  });

  it('an unexpected body key is corruption — no smuggling a sync section in', async () => {
    await expectCorrupt(tamperBody(b => {
      (b as unknown as Record<string, unknown>).sync = [{ noteId: 'x', txId: 'TX' }];
    }));
  });
});

describe('export-side stable fields — an export cannot write what its own import refuses', () => {
  it.each([
    ['a note with no noteId', { notes: [{ ciphertext: 'QUFBQQ==' }] }],
    ['a note with an empty noteId', { notes: [{ ...NOTE, noteId: '' }] }],
    ['a note with a non-string noteId', { notes: [{ ...NOTE, noteId: 42 }] }],
    ['a safebox entry with no entryId', { safebox: [{ ...ENTRY, entryId: undefined }] }],
    ['a safebox entry with an empty entryId', { safebox: [{ ...ENTRY, entryId: '' }] }],
    ['a safebox entry with no version', { safebox: [{ ...ENTRY, v: undefined }] }],
  ])('refuses to encode %s', async (_name, patch) => {
    const key = await deriveBackupKey(MNEMONIC);
    await expect(encodeBackup(input(patch as Partial<EncodeBackupInput>), key))
      .rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('export-side uniqueness', () => {
  it('an export that would produce a file its own import refuses fails HERE', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    await expect(encodeBackup(input({ notes: [NOTE, { ...NOTE }] }), key))
      .rejects.toMatchObject({ code: 'corrupt' });
  });

  it('a cross-collection id collision fails on export too', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    await expect(encodeBackup(input({ safebox: [{ ...ENTRY, entryId: NOTE.noteId as string }] }), key))
      .rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('the 32 MB cap (D17)', () => {
  it('is measured on the FINAL file size, so a near-cap export imports back', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    // ~2 MB of ciphertext: comfortably under the cap AFTER base64 + wrapper,
    // which is the point — the plaintext measure would have been ~1.33× off.
    const big = { ...NOTE, ciphertext: bufferToBase64(new Uint8Array(1_500_000)) };
    const text = await encodeBackup(input({ notes: [big], safebox: [] }), key);

    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(BACKUP_CAP_BYTES);
    await expect(decodeBackup(text, key)).resolves.toBeTruthy();
  });

  it('refuses to decode a file over the cap before doing any work', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const oversized = `{"pad":"${'a'.repeat(BACKUP_CAP_BYTES)}"}`;
    await expect(decodeBackup(oversized, key)).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('file name', () => {
  it('is dated to the minute so several exports a day stay apart', () => {
    expect(backupFileName(new Date(2026, 7, 24, 9, 5))).toBe('eternal-notes-backup-2026-08-24-0905.json');
    expect(backupFileName(new Date(2026, 11, 1, 23, 59))).toBe('eternal-notes-backup-2026-12-01-2359.json');
  });
});

describe('the documented container vector (docs/BACKUP_FORMAT_V1.md §2.8)', () => {
  /** The exact file, byte for byte, that this mnemonic + this IV + this data
   *  must produce. A frozen format needs one artefact anyone can re-derive
   *  years later without the code that wrote it — including whoever has only
   *  a saved copy of `backup-viewer.html` and this document. */
  const CONTAINER = '{"body":{"ciphertext":"JNsiCBJ4BSIexY24Y4b/iJ4yvPHrP5OAleKyB9Whav/jI8SzB9/2x90D50DyEekqxM3o5SUmoePUt7vR46k0JiU7HjKi2fIfyN+J7rCzPskPpDCrjOstJ/lnHmTGPiQmedRV4Ix/vUG28lHQQRNJv6LE5Dt7pQDtQHEEUbQVspOmXY6LfGkq8OS9gz3I0E4EynQXfWY5Jf6D2c12F5BYd0xff8ZpvSjHzK4jrsflb5dA2hX9zWIU6YvYApd1tzFkWD171pw9VpIU8kEa4fAUpb/Hwef6MHBCcM4UVk02aatA3NHW6rrsQzYmz6CraNKbmGJvtFKwiWIR6PG2IOtJJTuGZUGM5KjChHuRa9qNukazZPNI9QXcF6pGacAYzIl5HnOdv24mEZrx2fsUXpmJJXNjSugOylmbYQMq+pXbIrAspkIheW1gVn/vhbbvADksaswOB3aNULjB3MTH4c9eSq755V2TMYoBHEpKtC292bW6WpG2VZqa4GcT4SG21/RuCEvUgDggGI+y6e6q/V/4oWBnVEJa/KtB9Fr1ID4i5OrihZUq+A==","iv":"AQIDBAUGBwgJCgsM"},"containsUnsupportedRecords":false,"createdAt":1756000000000,"format":"eternal-notes-backup","minReaderVersion":1,"v":1}';

  const BODY_JSON = '{"counts":{"notes":1,"safebox":1},"incompleteRestore":false,"notes":[{"ciphertext":"QUFBQQ==","createdAt":1756000000000,"iv":"AAAAAAAAAAAAAAAA","noteId":"11111111-2222-4333-8444-555555555555"}],"safebox":[{"createdAt":1756000000000,"entryId":"88888888-9999-8aaa-baaa-cccccccccccc","metaCiphertext":"QkJCQg==","metaIv":"AAAAAAAAAAAAAAAA","secretCiphertext":"Q0NDQw==","secretIv":"AAAAAAAAAAAAAAAA","v":4}]}';

  it('canonicalizes the body exactly as documented', () => {
    expect(canonicalJson({
      counts: { notes: 1, safebox: 1 },
      incompleteRestore: false,
      notes: [NOTE],
      safebox: [ENTRY],
    })).toBe(BODY_JSON);
  });

  it('produces the documented file byte for byte', async () => {
    stubIv();
    const key = await deriveBackupKey(MNEMONIC);
    expect(await encodeBackup(input(), key)).toBe(CONTAINER);
  });

  it('reads the documented file back', async () => {
    const key = await deriveBackupKey(MNEMONIC);
    const { header, body } = await decodeBackup(CONTAINER, key);
    expect(header.createdAt).toBe(CREATED_AT);
    expect(canonicalJson(body)).toBe(BODY_JSON);
  });

  it('the document still carries the same vector', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../../docs/BACKUP_FORMAT_V1.md', import.meta.url), 'utf8');
    expect(doc).toContain(CONTAINER);
    expect(doc).toContain(BODY_JSON);
    expect(doc).toContain(MNEMONIC);
  });
});
