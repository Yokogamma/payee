import { describe, it, expect, beforeEach } from 'vitest';
import {
  DraftStore,
  DRAFT_STORAGE_KEY,
  parseDraftEnvelope,
  dropLegacyPlaintextDraft,
  type DraftStorage,
  type DraftContext,
} from './draft';

function fakeStorage(initial?: Record<string, string>): DraftStorage & { dump(): string | null } {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
    dump: () => map.get(DRAFT_STORAGE_KEY) ?? null,
  };
}

async function makeCtx(vaultId = 'vault-A'): Promise<DraftContext> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, vaultId };
}

let ctx: DraftContext;
beforeEach(async () => {
  ctx = await makeCtx();
});

describe('DraftStore — envelope roundtrip', () => {
  it('persist → read returns the text; stored value is an envelope, not plaintext', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    await store.persist('секретный черновик', ctx);

    const raw = s.dump();
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('секретный'); // never plaintext at rest
    const env = parseDraftEnvelope(raw!);
    expect(env).toMatchObject({ v: 1, vaultId: 'vault-A' });

    expect(await store.read(ctx)).toBe('секретный черновик');
  });

  it('empty text → clears the stored draft', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    await store.persist('что-то', ctx);
    await store.persist('', ctx);
    expect(s.dump()).toBeNull();
  });
});

describe('DraftStore — generations (§2)', () => {
  it('two overlapping persists: the LATER one wins regardless of resolve order', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    const first = store.persist('старый текст', ctx);  // not awaited — in flight
    await store.persist('новый текст', ctx);
    await first;
    expect(await store.read(ctx)).toBe('новый текст');
  });

  it('clear() invalidates an in-flight persist (stale write discarded)', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    const inflight = store.persist('не должен сохраниться', ctx);
    store.clear();
    await inflight;
    expect(s.dump()).toBeNull();
  });
});

describe('DraftStore — mismatch and failure keep the ciphertext (§2)', () => {
  it('foreign vaultId: read → null, ciphertext NOT deleted', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    await store.persist('черновик vault-A', ctx);
    const stored = s.dump();

    const foreign = await makeCtx('vault-B');
    expect(await store.read(foreign)).toBeNull();
    expect(s.dump()).toBe(stored); // untouched
  });

  it('tampered ciphertext: read → null, ciphertext NOT deleted', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    await store.persist('текст', ctx);
    const env = parseDraftEnvelope(s.dump()!)!;
    const corrupted = { ...env, ct: env.ct.slice(0, -4) + 'AAAA' };
    s.setItem(DRAFT_STORAGE_KEY, JSON.stringify(corrupted));

    expect(await store.read(ctx)).toBeNull();
    expect(s.dump()).toBe(JSON.stringify(corrupted));
  });

  it('wrong key (same vaultId, different seed): read → null, kept', async () => {
    const s = fakeStorage();
    const store = new DraftStore(s);
    await store.persist('текст', ctx);
    const stored = s.dump();

    const otherKey = await makeCtx('vault-A'); // same id, different key
    expect(await store.read(otherKey)).toBeNull();
    expect(s.dump()).toBe(stored);
  });
});

describe('legacy plaintext drafts', () => {
  it('read ignores a legacy plaintext value', async () => {
    const s = fakeStorage({ [DRAFT_STORAGE_KEY]: 'старый плейнтекст-черновик' });
    const store = new DraftStore(s);
    expect(await store.read(ctx)).toBeNull();
  });

  it('first persist replaces legacy plaintext with an envelope', async () => {
    const s = fakeStorage({ [DRAFT_STORAGE_KEY]: 'старый плейнтекст' });
    const store = new DraftStore(s);
    await store.persist('новый', ctx);
    expect(parseDraftEnvelope(s.dump()!)).not.toBeNull();
  });

  it('dropLegacyPlaintextDraft removes plaintext but keeps an envelope', async () => {
    const legacy = fakeStorage({ [DRAFT_STORAGE_KEY]: 'плейнтекст' });
    dropLegacyPlaintextDraft(legacy);
    expect(legacy.dump()).toBeNull();

    const enveloped = fakeStorage();
    const store = new DraftStore(enveloped);
    await store.persist('шифртекст', ctx);
    const stored = enveloped.dump();
    dropLegacyPlaintextDraft(enveloped);
    expect(enveloped.dump()).toBe(stored);
  });

  it('JSON that is not a valid envelope counts as legacy (dropped on lock)', () => {
    for (const raw of ['{"v":2,"vaultId":"x","iv":"a","ct":"b"}', '{"vaultId":"x"}', '"строка"', '42', '{}']) {
      const s = fakeStorage({ [DRAFT_STORAGE_KEY]: raw });
      dropLegacyPlaintextDraft(s);
      expect(s.dump()).toBeNull();
    }
  });
});
