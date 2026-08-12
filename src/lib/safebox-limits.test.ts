import { describe, it, expect, vi, beforeEach } from 'vitest';

// §8 limits / wire-payload e2e: the store gate and the form counter must agree
// BYTE-FOR-BYTE, and both must be measured against the WORST-CASE signed body
// (recheck + recovery), because that body is strictly larger than the first
// upload's — an entry metered only against the happy path would pass once and
// then be stuck on the recheck path forever.

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_TRUSTED_OWNERS', 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE');
  vi.stubEnv('VITE_PROXY_URL', 'http://localhost:8787');
});

const OWNER_HASH = 'A'.repeat(44);

async function mods() {
  const crypto = await import('./crypto');
  const limits = await import('./limits');
  const arweave = await import('./arweave');
  return { crypto, limits, arweave };
}

async function makeEntry(input: {
  title?: string; login?: string; url?: string; note?: string; password?: string;
  files?: Array<{ name: string; mime: string; bytes: number }>;
  rev?: number; root?: string; prev?: string;
}) {
  const { crypto: c } = await mods();
  const mn = c.generateMnemonic();
  const metaKey = await c.deriveSafeboxMetaKey(mn);
  const secretKey = await c.deriveSafeboxSecretKey(mn);
  const files = (input.files ?? []).map(f => {
    const raw = new Uint8Array(f.bytes).fill(65);
    return {
      fid: c.randomUuidV8(),
      name: f.name,
      mime: f.mime,
      size: raw.byteLength,
      data: c.bufferToBase64(raw),
    };
  });
  const entry = await c.encryptSafeboxEntry(metaKey, secretKey, {
    title: input.title ?? '', login: input.login ?? '', url: input.url ?? '',
    note: input.note ?? '', password: input.password ?? '',
    files,
    rev: input.rev ?? 1,
    ...(input.root !== undefined ? { root: input.root } : {}),
    ...(input.prev !== undefined ? { prev: input.prev } : {}),
  });
  return { entry, files };
}

describe('safeboxUploadByteLength — the WHOLE signed body', () => {
  it('measures the worst case: recheck + full recovery envelope', async () => {
    const { limits, arweave } = await mods();
    const { entry } = await makeEntry({ title: 'x', password: 'p' });

    const plain = JSON.stringify(
      arweave.buildSafeboxUploadPayload(entry, OWNER_HASH, 1_700_000_000_000),
    ).length;
    const measured = limits.safeboxUploadByteLength(entry, OWNER_HASH);

    // The metered number must be the LARGER one — the recheck body.
    expect(measured).toBeGreaterThan(plain);
    // …and it must be exactly the recheck body, not an estimate.
    const worst = JSON.stringify(arweave.buildSafeboxUploadPayload(
      entry, OWNER_HASH, 9_999_999_999_999, true,
      { txId: 'A'.repeat(43), postedAt: 9_999_999_999_999, token: 'A'.repeat(44) },
    )).length;
    expect(measured).toBe(worst);
  });

  it('counts tags, ownerHash and both ciphertexts (payload > raw ciphertext)', async () => {
    const { limits } = await mods();
    const { entry } = await makeEntry({ title: 'x', password: 'p' });
    const ciphertextOnly = entry.metaCiphertext.length + entry.secretCiphertext.length;
    expect(limits.safeboxUploadByteLength(entry, OWNER_HASH)).toBeGreaterThan(ciphertextOnly + 200);
  });
});

describe('estimateSafeboxUploadByteLength — the form counter', () => {
  it('CONVERGES with the real post-encryption measurement (never under-reports)', async () => {
    const { limits } = await mods();
    const cases = [
      { title: 'GitHub', login: 'yoko', url: 'https://github.com', note: 'заметка', password: 'p'.repeat(24), files: [] },
      { title: 'Кириллица и эмодзи 🔐', login: '', url: '', note: '\n"кавычки"\n', password: 'x', files: [{ name: 'k.pem', mime: 'application/x-pem-file', bytes: 1200 }] },
      { title: 't', login: '', url: '', note: '', password: '', files: [{ name: 'a.bin', mime: 'application/octet-stream', bytes: 4096 }, { name: 'b.json', mime: 'application/json', bytes: 800 }] },
    ];
    for (const c of cases) {
      const { entry, files } = await makeEntry({ ...c, rev: 2, root: '11111111-2222-8333-8444-555555555555', prev: '22222222-2222-8333-8444-555555555555' });
      const real = limits.safeboxUploadByteLength(entry, OWNER_HASH);
      const predicted = limits.estimateSafeboxUploadByteLength({
        title: c.title, login: c.login, url: c.url, note: c.note, password: c.password,
        files: files.map(f => ({ fid: f.fid, name: f.name, mime: f.mime, size: f.size })),
      });
      // Byte-exact: both go through the same payload builder and the same
      // base64/GCM arithmetic. (A rev-2 entry with `prev` is the worst case the
      // estimate assumes, so equality is the contract here.)
      expect(predicted).toBe(real);
    }
  });
});

describe('the 51 200-byte boundary', () => {
  it('an entry at the boundary passes and one byte more is rejected', async () => {
    const { limits } = await mods();

    // The estimate's worst case is a NON-ROOT version (it carries `prev`), so
    // the real entries below use the same shape — that is what makes the
    // counter and the store gate byte-identical.
    const chain = {
      rev: 2,
      root: '11111111-2222-8333-8444-555555555555',
      prev: '22222222-2222-8333-8444-555555555555',
    };
    const base = { title: 't', login: '', url: '', password: 'p', files: [] as never[] };

    // Grow the note until the WORST-CASE body is just under the cap.
    let lo = 0, hi = 40_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const size = limits.estimateSafeboxUploadByteLength({ ...base, note: 'a'.repeat(mid) });
      if (size <= limits.MAX_UPLOAD_BODY_BYTES) lo = mid;
      else hi = mid - 1;
    }
    const fitting = 'a'.repeat(lo);
    expect(limits.estimateSafeboxUploadByteLength({ ...base, note: fitting }))
      .toBeLessThanOrEqual(limits.MAX_UPLOAD_BODY_BYTES);
    // Exactly ONE more character crosses the line for the counter.
    expect(limits.estimateSafeboxUploadByteLength({ ...base, note: fitting + 'a' }))
      .toBeGreaterThan(limits.MAX_UPLOAD_BODY_BYTES);

    // …and the REAL encrypted entries agree on both sides of that line.
    const { entry } = await makeEntry({ ...base, ...chain, note: fitting });
    expect(limits.isSafeboxEntryTooLarge(entry)).toBe(false);
    const { entry: tooBig } = await makeEntry({ ...base, ...chain, note: fitting + 'a' });
    expect(limits.isSafeboxEntryTooLarge(tooBig)).toBe(true);
  }, 30_000);

  it('the documented ~24 KB raw attachment budget survives the double base64', async () => {
    const { limits } = await mods();
    const { entry } = await makeEntry({
      title: 'ключ', password: 'p',
      files: [{ name: 'id_ed25519', mime: 'text/plain', bytes: limits.MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES }],
    });
    const bytes = limits.safeboxUploadByteLength(entry, OWNER_HASH);
    expect(bytes).toBeLessThan(limits.MAX_UPLOAD_BODY_BYTES);
    // ×16/9 is the real inflation factor (base64 inside base64 + GCM + JSON).
    expect(bytes).toBeGreaterThan(limits.MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES * 1.7);
  }, 30_000);

  it('SafeboxEntryTooLargeError carries the measured size', async () => {
    const { limits } = await mods();
    const err = new limits.SafeboxEntryTooLargeError(60_000);
    expect(err.name).toBe('SafeboxEntryTooLargeError');
    expect(err.byteLength).toBe(60_000);
  });
});

describe('note limits are untouched', () => {
  it('MAX_NOTE_JSON_BYTES still meters the escaped envelope text', async () => {
    const { limits } = await mods();
    expect(limits.isNoteTooLong('a'.repeat(limits.MAX_NOTE_JSON_BYTES - 2))).toBe(false);
    expect(limits.isNoteTooLong('a'.repeat(limits.MAX_NOTE_JSON_BYTES + 1))).toBe(true);
  });
});
