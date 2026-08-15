// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensurePersistentStorage, resetPersistenceAttemptForTests } from './persistence';

// The policy this file pins down (see persistence.ts):
//  - ask at most ONCE per page load, and never again in this tab after a
//    refusal (that is what stops a prompting engine re-asking on reload);
//  - a 'denied' permission short-circuits the call, anything else does NOT —
//    gating on 'granted' would mean never asking in Chromium at all.

type StorageStub = { persist?: unknown; persisted?: unknown };

function stubStorage(value: StorageStub | undefined): void {
  Object.defineProperty(navigator, 'storage', { value, configurable: true });
}

function stubPermissions(value: unknown): void {
  Object.defineProperty(navigator, 'permissions', { value, configurable: true });
}

beforeEach(() => {
  resetPersistenceAttemptForTests();
  sessionStorage.clear();
  stubPermissions(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensurePersistentStorage', () => {
  it('reports «unsupported» when the API is missing', async () => {
    stubStorage(undefined);
    expect(await ensurePersistentStorage()).toBe('unsupported');
  });

  it('reports «unsupported» when persist() alone is missing', async () => {
    stubStorage({ persisted: vi.fn(async () => false) });
    expect(await ensurePersistentStorage()).toBe('unsupported');
  });

  it('does NOT re-request when the origin is already persistent', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => true) });

    expect(await ensurePersistentStorage()).toBe('persisted');
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence and reports the grant', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });

    expect(await ensurePersistentStorage()).toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reports «denied» when the browser refuses', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persist, persisted: vi.fn(async () => false) });

    expect(await ensurePersistentStorage()).toBe('denied');
  });

  it('skips the request when the permission is already denied', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });
    stubPermissions({ query: vi.fn(async () => ({ state: 'denied' })) });

    expect(await ensurePersistentStorage()).toBe('denied');
    expect(persist).not.toHaveBeenCalled();
  });

  it('still asks when the permission is merely «prompt»', async () => {
    // The Chrome-first half of the policy: 'prompt' is the state a fresh origin
    // reports, and refusing to ask there would never fix anything.
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });
    stubPermissions({ query: vi.fn(async () => ({ state: 'prompt' })) });

    expect(await ensurePersistentStorage()).toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('asks anyway when the engine does not know the permission name', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });
    stubPermissions({ query: vi.fn(async () => { throw new TypeError('unknown name'); }) });

    expect(await ensurePersistentStorage()).toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('is single-flight: concurrent callers share ONE request', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });

    const [a, b] = await Promise.all([ensurePersistentStorage(), ensurePersistentStorage()]);

    expect(a).toBe('persisted');
    expect(b).toBe('persisted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('after a refusal it does not ask again in this tab — not even after a reload', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persist, persisted: vi.fn(async () => false) });

    expect(await ensurePersistentStorage()).toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1);

    // A reload keeps sessionStorage but drops the module state.
    resetPersistenceAttemptForTests();
    expect(await ensurePersistentStorage()).toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1); // still one — the marker held
  });

  it('a denied PERMISSION also marks the tab (no request on the next load)', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persist, persisted: vi.fn(async () => false) });
    stubPermissions({ query: vi.fn(async () => ({ state: 'denied' })) });

    await ensurePersistentStorage();
    resetPersistenceAttemptForTests();
    stubPermissions(undefined); // permission state unknown on the next load
    expect(await ensurePersistentStorage()).toBe('denied');
    expect(persist).not.toHaveBeenCalled();
  });

  it('survives a sessionStorage that throws (private mode)', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persist, persisted: vi.fn(async () => false) });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });

    expect(await ensurePersistentStorage()).toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('never rejects — a throwing API resolves to «unsupported»', async () => {
    stubStorage({
      persist: vi.fn(async () => true),
      persisted: vi.fn(async () => { throw new Error('boom'); }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await ensurePersistentStorage()).toBe('unsupported');
  });
});
