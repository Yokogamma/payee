import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptSafeboxEntry,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  SafeboxEnvelopeError,
  bufferToBase64,
  base64ToBuffer,
  randomUuidV8,
  type EncryptedSafeboxEntry,
  type SafeboxEntryInput,
} from './crypto';

// §8 crypto matrix for the safebox split envelope: roundtrip, key independence,
// the mix-and-match defence (GCM-bound id cross-check on BOTH halves), the
// fid/size contract, and fail-closed validation of every field.

const MN = generateMnemonic();
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function keys() {
  return {
    meta: await deriveSafeboxMetaKey(MN),
    secret: await deriveSafeboxSecretKey(MN),
  };
}

function input(over: Partial<SafeboxEntryInput> = {}): SafeboxEntryInput {
  return {
    title: 'GitHub',
    login: 'yoko',
    url: 'https://github.com',
    note: 'рабочий аккаунт',
    password: 'correct horse battery staple',
    files: [],
    rev: 1,
    ...over,
  };
}

function file(data: string, over: Partial<{ fid: string; name: string; mime: string }> = {}) {
  const bytes = new TextEncoder().encode(data);
  return {
    fid: over.fid ?? randomUuidV8(),
    name: over.name ?? 'key.pem',
    mime: over.mime ?? 'application/x-pem-file',
    size: bytes.byteLength,
    data: bufferToBase64(bytes),
  };
}

/** Re-encrypt an arbitrary object as the META half of `entry`. */
async function forgeMeta(key: CryptoKey, entry: EncryptedSafeboxEntry, envelope: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)),
  );
  return { ...entry, metaCiphertext: bufferToBase64(c), metaIv: bufferToBase64(iv) };
}
async function forgeSecret(key: CryptoKey, entry: EncryptedSafeboxEntry, envelope: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(envelope)),
  );
  return { ...entry, secretCiphertext: bufferToBase64(c), secretIv: bufferToBase64(iv) };
}

describe('safebox key derivation', () => {
  it('is deterministic and DISTINCT from the notes key and from each other', async () => {
    const m1 = await deriveSafeboxMetaKey(MN);
    const m2 = await deriveSafeboxMetaKey(MN);
    const s1 = await deriveSafeboxSecretKey(MN);
    const noteKey = await deriveKey(MN);

    const entry = await encryptSafeboxEntry(m1, s1, input());
    // Same mnemonic → same meta key (deterministic).
    await expect(decryptSafeboxMeta(m2, entry)).resolves.toMatchObject({ title: 'GitHub' });
    // The SECRET key must not open the meta half, and vice versa.
    await expect(decryptSafeboxMeta(s1, entry)).rejects.toBeDefined();
    await expect(decryptSafeboxSecret(m1, entry, [])).rejects.toBeDefined();
    // The notes key must not open either half.
    await expect(decryptSafeboxMeta(noteKey, entry)).rejects.toBeDefined();
    await expect(decryptSafeboxSecret(noteKey, entry, [])).rejects.toBeDefined();
  });

  it('a different mnemonic derives keys that cannot read the entry', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const other = await deriveSafeboxMetaKey(generateMnemonic());
    await expect(decryptSafeboxMeta(other, entry)).rejects.toBeDefined();
  });
});

describe('split-envelope roundtrip', () => {
  it('encrypts a rev-1 root and decrypts both halves', async () => {
    const { meta, secret } = await keys();
    const f = file('-----BEGIN KEY-----');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));

    expect(entry.v).toBe(4);
    expect(entry.entryId).toMatch(UUID_V8);
    expect(base64ToBuffer(entry.metaIv).byteLength).toBe(12);
    expect(base64ToBuffer(entry.secretIv).byteLength).toBe(12);
    expect(entry.metaCiphertext).not.toBe(entry.secretCiphertext);

    const m = await decryptSafeboxMeta(meta, entry);
    expect(m).toMatchObject({
      id: entry.entryId, title: 'GitHub', login: 'yoko',
      url: 'https://github.com', note: 'рабочий аккаунт', rev: 1, root: entry.entryId,
    });
    expect(m.createdAt).toBe(entry.createdAt);
    expect(m.prev).toBeUndefined();
    // Descriptors live in the META half; contents only in the SECRET half.
    expect(m.files).toEqual([{ fid: f.fid, name: f.name, mime: f.mime, size: f.size }]);

    const s = await decryptSafeboxSecret(secret, entry, m.files);
    expect(s.password).toBe('correct horse battery staple');
    expect(s.files).toEqual([{ fid: f.fid, data: f.data }]);
  });

  it('carries rev/root/prev for a non-root version', async () => {
    const { meta, secret } = await keys();
    const root = randomUuidV8();
    const prev = randomUuidV8();
    const entry = await encryptSafeboxEntry(meta, secret, input({ rev: 4, root, prev }));
    const m = await decryptSafeboxMeta(meta, entry);
    expect(m).toMatchObject({ rev: 4, root, prev });
  });

  it('the password NEVER appears in the meta ciphertext plaintext', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input({ password: 'SUPER-SECRET-42' }));
    const decoded = new TextDecoder().decode(base64ToBuffer(
      bufferToBase64(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(entry.metaIv) },
        meta,
        base64ToBuffer(entry.metaCiphertext),
      )),
    ));
    expect(decoded).not.toContain('SUPER-SECRET-42');
  });
});

describe('mix-and-match defence (GCM-bound id cross-check)', () => {
  it('rejects entry A’s SECRET blob grafted onto entry B', async () => {
    const { meta, secret } = await keys();
    const a = await encryptSafeboxEntry(meta, secret, input({ title: 'A' }));
    const b = await encryptSafeboxEntry(meta, secret, input({ title: 'B' }));

    const frankenstein: EncryptedSafeboxEntry = {
      ...b,
      secretCiphertext: a.secretCiphertext,
      secretIv: a.secretIv,
    };
    const m = await decryptSafeboxMeta(meta, frankenstein); // meta half still fine
    expect(m.title).toBe('B');
    // …but the secret half is bound to A's id and must be refused.
    await expect(decryptSafeboxSecret(secret, frankenstein, m.files)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects entry A’s META blob grafted onto entry B', async () => {
    const { meta, secret } = await keys();
    const a = await encryptSafeboxEntry(meta, secret, input({ title: 'A' }));
    const b = await encryptSafeboxEntry(meta, secret, input({ title: 'B' }));
    const frankenstein: EncryptedSafeboxEntry = {
      ...b,
      metaCiphertext: a.metaCiphertext,
      metaIv: a.metaIv,
    };
    await expect(decryptSafeboxMeta(meta, frankenstein)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects a forged inner id that does not match the record', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const forged = await forgeMeta(meta, entry, {
      v: 1, id: randomUuidV8(), t: Date.now(), title: 't', login: '', url: '', note: '',
      files: [], rev: 1, root: entry.entryId,
    });
    await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });
});

describe('fail-closed envelope validation', () => {
  const base = (id: string) => ({
    v: 1, id, t: 1_700_000_000_000, title: 't', login: 'l', url: 'u', note: 'n',
    files: [] as unknown[], rev: 1, root: id,
  });

  it('rejects an unknown envelope version', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const forged = await forgeMeta(meta, entry, { ...base(entry.entryId), v: 2 });
    await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects an unknown RECORD version (v !== 4)', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const bad = { ...entry, v: 5 as unknown as 4 };
    await expect(decryptSafeboxMeta(meta, bad)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
    await expect(decryptSafeboxSecret(secret, bad, [])).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects extra AND missing meta fields (exact key set)', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const extra = await forgeMeta(meta, entry, { ...base(entry.entryId), smuggled: 1 });
    await expect(decryptSafeboxMeta(meta, extra)).rejects.toBeInstanceOf(SafeboxEnvelopeError);

    const missing = { ...base(entry.entryId) } as Record<string, unknown>;
    delete missing.note;
    const short = await forgeMeta(meta, entry, missing);
    await expect(decryptSafeboxMeta(meta, short)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects a malformed timestamp and a non-string field', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    for (const patch of [{ t: -1 }, { t: 'soon' }, { title: 42 }]) {
      const forged = await forgeMeta(meta, entry, { ...base(entry.entryId), ...patch });
      await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
    }
  });

  it('enforces the rev/root/prev linkage invariants', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const other = randomUuidV8();
    const cases = [
      { rev: 1, root: other },                              // rev-1 must be its own root
      { rev: 1, root: entry.entryId, prev: other },         // rev-1 cannot have prev
      { rev: 2, root: other },                              // rev>1 needs prev
      { rev: 2, root: entry.entryId, prev: other },         // rev>1 cannot be its own root
      { rev: 0, root: entry.entryId },                      // rev must be >= 1
    ];
    for (const patch of cases) {
      const forged = await forgeMeta(meta, entry, { ...base(entry.entryId), ...patch });
      await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
    }
  });

  it('rejects a UUIDv4 in `root` or `prev` (the chain is v8-only)', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const v4 = '11111111-2222-4333-8444-555555555555';
    const v8Other = randomUuidV8();
    // Unlike NOTES — where a v3 version may legitimately be rooted at a legacy
    // UUIDv4 note — a safebox chain consists exclusively of v4-record entryIds,
    // which are always UUIDv8.
    const cases = [
      { rev: 2, root: v4, prev: v8Other },
      { rev: 2, root: v8Other, prev: v4 },
      { rev: 1, root: v4 },
    ];
    for (const patch of cases) {
      const forged = await forgeMeta(meta, entry, {
        v: 1, id: entry.entryId, t: 1, title: 't', login: '', url: '', note: '',
        files: [], rev: 1, root: entry.entryId, ...patch,
      });
      await expect(decryptSafeboxMeta(meta, forged), JSON.stringify(patch))
        .rejects.toBeInstanceOf(SafeboxEnvelopeError);
    }
  });

  it('encryptSafeboxEntry refuses to MAKE a chain link outside the v8 namespace', async () => {
    const { meta, secret } = await keys();
    const v4 = '11111111-2222-4333-8444-555555555555';
    await expect(encryptSafeboxEntry(meta, secret, input({ rev: 2, root: v4, prev: randomUuidV8() })))
      .rejects.toBeInstanceOf(SafeboxEnvelopeError);
    await expect(encryptSafeboxEntry(meta, secret, input({ rev: 2, root: randomUuidV8(), prev: v4 })))
      .rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects an id outside the UUIDv8 namespace', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const v4Id = '11111111-2222-4333-8444-555555555555';
    const forged = await forgeMeta(meta, { ...entry, entryId: v4Id }, base(v4Id));
    await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });
});

describe('attachment fid / size contract', () => {
  it('rejects a duplicate fid in the META half', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    const fid = randomUuidV8();
    const forged = await forgeMeta(meta, entry, {
      v: 1, id: entry.entryId, t: 1, title: 't', login: '', url: '', note: '',
      files: [
        { fid, name: 'a', mime: 'text/plain', size: 1 },
        { fid, name: 'b', mime: 'text/plain', size: 1 },
      ],
      rev: 1, root: entry.entryId,
    });
    await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects a duplicate fid in the SECRET half only', async () => {
    const { meta, secret } = await keys();
    const f = file('abc');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const forged = await forgeSecret(secret, entry, {
      v: 1, id: entry.entryId, password: 'p',
      files: [{ fid: f.fid, data: f.data }, { fid: f.fid, data: f.data }],
    });
    await expect(decryptSafeboxSecret(secret, forged, m.files)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects a cardinality mismatch between descriptors and contents', async () => {
    const { meta, secret } = await keys();
    const f = file('abc');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const forged = await forgeSecret(secret, entry, {
      v: 1, id: entry.entryId, password: 'p', files: [],
    });
    await expect(decryptSafeboxSecret(secret, forged, m.files)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects an fid present in one half only', async () => {
    const { meta, secret } = await keys();
    const f = file('abc');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const forged = await forgeSecret(secret, entry, {
      v: 1, id: entry.entryId, password: 'p',
      files: [{ fid: randomUuidV8(), data: f.data }],
    });
    await expect(decryptSafeboxSecret(secret, forged, m.files)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects descriptor.size ≠ decoded content length', async () => {
    const { meta, secret } = await keys();
    const f = file('abcdef');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const lying = m.files.map(d => ({ ...d, size: d.size + 1 }));
    await expect(decryptSafeboxSecret(secret, entry, lying)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects non-canonical base64 content', async () => {
    const { meta, secret } = await keys();
    const f = file('abc');
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const forged = await forgeSecret(secret, entry, {
      v: 1, id: entry.entryId, password: 'p',
      files: [{ fid: f.fid, data: 'YWJj=' }], // padded where it must not be
    });
    await expect(decryptSafeboxSecret(secret, forged, m.files)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('rejects a malformed descriptor shape (extra key / bad fid)', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());
    for (const files of [
      [{ fid: randomUuidV8(), name: 'a', mime: 'text/plain', size: 1, extra: true }],
      [{ fid: 'not-a-uuid', name: 'a', mime: 'text/plain', size: 1 }],
      [{ fid: randomUuidV8(), name: '', mime: 'text/plain', size: 1 }],
      [{ fid: randomUuidV8(), name: 'a', mime: 'text/plain', size: -1 }],
    ]) {
      const forged = await forgeMeta(meta, entry, {
        v: 1, id: entry.entryId, t: 1, title: 't', login: '', url: '', note: '',
        files, rev: 1, root: entry.entryId,
      });
      await expect(decryptSafeboxMeta(meta, forged)).rejects.toBeInstanceOf(SafeboxEnvelopeError);
    }
  });

  it('encryptSafeboxEntry refuses to MAKE a duplicate-fid entry permanent', async () => {
    const { meta, secret } = await keys();
    const fid = randomUuidV8();
    await expect(encryptSafeboxEntry(meta, secret, input({
      files: [file('a', { fid }), file('b', { fid })],
    }))).rejects.toBeInstanceOf(SafeboxEnvelopeError);
  });

  it('encryptSafeboxEntry refuses an inconsistent rev/root linkage', async () => {
    const { meta, secret } = await keys();
    await expect(encryptSafeboxEntry(meta, secret, input({ rev: 2 })))
      .rejects.toBeInstanceOf(SafeboxEnvelopeError); // rev>1 without prev
  });

  it('a 0-byte attachment roundtrips (size 0 is legal)', async () => {
    const { meta, secret } = await keys();
    const f = { fid: randomUuidV8(), name: 'empty.txt', mime: 'text/plain', size: 0, data: '' };
    const entry = await encryptSafeboxEntry(meta, secret, input({ files: [f] }));
    const m = await decryptSafeboxMeta(meta, entry);
    const s = await decryptSafeboxSecret(secret, entry, m.files);
    expect(s.files).toEqual([{ fid: f.fid, data: '' }]);
  });
});

describe('tamper detection', () => {
  it('a flipped byte in either ciphertext fails the GCM tag', async () => {
    const { meta, secret } = await keys();
    const entry = await encryptSafeboxEntry(meta, secret, input());

    const flip = (b64: string) => {
      const bytes = base64ToBuffer(b64);
      bytes[0] ^= 0xff;
      return bufferToBase64(bytes);
    };
    await expect(decryptSafeboxMeta(meta, { ...entry, metaCiphertext: flip(entry.metaCiphertext) }))
      .rejects.toBeDefined();
    await expect(decryptSafeboxSecret(secret, { ...entry, secretCiphertext: flip(entry.secretCiphertext) }, []))
      .rejects.toBeDefined();
  });
});
