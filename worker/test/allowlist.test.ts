import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { readAllowCache, writeAllowCache, writeAllowCacheGuarded } from '../src/allowlist';

// D3: single typed model pk:<pk>={status}; legacy/invalid → 'miss' (no bypass).

const KV = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

describe('allowlist typed cache (D3)', () => {
  it('returns miss when the key is absent', async () => {
    expect(await readAllowCache(KV, 'pk-absent')).toBe('miss');
  });

  it('round-trips an allowed decision', async () => {
    await writeAllowCache(KV, 'pk-ok', 'allowed');
    expect(await readAllowCache(KV, 'pk-ok')).toBe('allowed');
  });

  it('round-trips a denied decision', async () => {
    await writeAllowCache(KV, 'pk-no', 'denied');
    expect(await readAllowCache(KV, 'pk-no')).toBe('denied');
  });

  it('treats legacy "true" as miss (re-derive from DO, no access bypass)', async () => {
    await KV.put('pk:pk-legacy', 'true');
    expect(await readAllowCache(KV, 'pk-legacy')).toBe('miss');
  });

  it('treats unparseable garbage as miss', async () => {
    await KV.put('pk:pk-garbage', '{not-json');
    expect(await readAllowCache(KV, 'pk-garbage')).toBe('miss');
  });

  it('treats an unknown status as miss', async () => {
    await KV.put('pk:pk-weird', JSON.stringify({ status: 'maybe' }));
    expect(await readAllowCache(KV, 'pk-weird')).toBe('miss');
  });
});

describe('writeAllowCacheGuarded (deny-wins race hardening)', () => {
  it('refuses to overwrite an existing denied — a raced revoke must not be resurrected', async () => {
    await writeAllowCache(KV, 'pk-race', 'denied');
    expect(await writeAllowCacheGuarded(KV, 'pk-race')).toBe(false);
    expect(await readAllowCache(KV, 'pk-race')).toBe('denied'); // deny wins
  });

  it('writes allowed normally when no deny is present (absent or stale/legacy)', async () => {
    expect(await writeAllowCacheGuarded(KV, 'pk-fresh')).toBe(true);
    expect(await readAllowCache(KV, 'pk-fresh')).toBe('allowed');

    await KV.put('pk:pk-legacy2', 'true'); // legacy value = miss
    expect(await writeAllowCacheGuarded(KV, 'pk-legacy2')).toBe(true);
    expect(await readAllowCache(KV, 'pk-legacy2')).toBe('allowed');
  });
});
