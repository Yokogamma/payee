import { describe, it, expect } from 'vitest';
import {
  AUTO_LOCK_TIMEOUT_OPTIONS,
  HIDDEN_AT_KEY,
  isValidAutoLockTimeout,
  parseHiddenMarker,
  markHidden,
  consumeHiddenMarker,
  decideLockOnReturn,
  decideBootstrapLock,
  type AutoLockTimeout,
  type BootstrapLockInput,
  type MarkerStorage,
  type ParsedMarker,
} from './auto-lock';

const NOW = 1_750_000_000_000;

function fakeStorage(initial?: Record<string, string>): MarkerStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: k => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: k => { map.delete(k); },
  };
}

const at = (hiddenAt: number): ParsedMarker => ({ kind: 'at', hiddenAt });
const NONE: ParsedMarker = { kind: 'none' };
const INVALID: ParsedMarker = { kind: 'invalid' };

describe('isValidAutoLockTimeout', () => {
  it('accepts exactly the whitelist', () => {
    for (const v of AUTO_LOCK_TIMEOUT_OPTIONS) expect(isValidAutoLockTimeout(v)).toBe(true);
  });

  it('rejects anything outside the whitelist (corrupted meta)', () => {
    for (const v of [undefined, 60, -1, 301, '300', NaN, Infinity, {}, true, 'never'])
      expect(isValidAutoLockTimeout(v)).toBe(false);
  });
});

describe('parseHiddenMarker (§6 validation)', () => {
  it('null → none', () => {
    expect(parseHiddenMarker(null, NOW)).toEqual(NONE);
  });

  it('valid timestamp → at', () => {
    expect(parseHiddenMarker(String(NOW - 1000), NOW)).toEqual(at(NOW - 1000));
  });

  it('boundary: exactly nowMs is valid', () => {
    expect(parseHiddenMarker(String(NOW), NOW)).toEqual(at(NOW));
  });

  it.each([
    ['garbage', 'abc'],
    ['empty string', ''],
    ['zero', '0'],
    ['negative', '-5'],
    ['future', String(NOW + 1)],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('fail-secure: %s → invalid', (_label, raw) => {
    expect(parseHiddenMarker(raw, NOW)).toEqual(INVALID);
  });
});

describe('markHidden — earliest marker wins', () => {
  it('writes the timestamp when no marker exists', () => {
    const s = fakeStorage();
    markHidden(s, NOW);
    expect(s.getItem(HIDDEN_AT_KEY)).toBe(String(NOW));
  });

  it('keeps an existing EARLIER marker (pagehide must not push it later)', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: String(NOW - 5000) });
    markHidden(s, NOW);
    expect(s.getItem(HIDDEN_AT_KEY)).toBe(String(NOW - 5000));
  });

  it('overwrites an invalid existing marker', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: 'garbage' });
    markHidden(s, NOW);
    expect(s.getItem(HIDDEN_AT_KEY)).toBe(String(NOW));
  });

  it('overwrites a future (invalid) marker with the earlier now', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: String(NOW + 60_000) });
    markHidden(s, NOW);
    expect(s.getItem(HIDDEN_AT_KEY)).toBe(String(NOW));
  });
});

describe('consumeHiddenMarker — atomic read + clear', () => {
  it('returns the parsed marker and clears it', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: String(NOW - 1000) });
    expect(consumeHiddenMarker(s, NOW)).toEqual(at(NOW - 1000));
    expect(s.getItem(HIDDEN_AT_KEY)).toBeNull();
  });

  it('second consume sees none (no double evaluation of one interval)', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: String(NOW - 1000) });
    consumeHiddenMarker(s, NOW);
    expect(consumeHiddenMarker(s, NOW)).toEqual(NONE);
  });

  it('clears even an invalid marker', () => {
    const s = fakeStorage({ [HIDDEN_AT_KEY]: 'junk' });
    expect(consumeHiddenMarker(s, NOW)).toEqual(INVALID);
    expect(s.getItem(HIDDEN_AT_KEY)).toBeNull();
  });
});

describe('decideLockOnReturn — thresholds', () => {
  it('never locks without a PIN', () => {
    expect(decideLockOnReturn(0, false, at(NOW - 1), NOW)).toBe(false);
  });

  it('null («Никогда») never locks, even on an invalid marker', () => {
    expect(decideLockOnReturn(null, true, at(1), NOW)).toBe(false);
    expect(decideLockOnReturn(null, true, INVALID, NOW)).toBe(false);
  });

  it('no marker on a live tab → no lock (it never went hidden)', () => {
    expect(decideLockOnReturn(0, true, NONE, NOW)).toBe(false);
    expect(decideLockOnReturn(300, true, NONE, NOW)).toBe(false);
  });

  it('0 («Сразу») locks on ANY valid marker, however fresh', () => {
    expect(decideLockOnReturn(0, true, at(NOW), NOW)).toBe(true);
    expect(decideLockOnReturn(0, true, at(NOW - 1), NOW)).toBe(true);
  });

  it('invalid marker → fail-secure lock', () => {
    expect(decideLockOnReturn(300, true, INVALID, NOW)).toBe(true);
  });

  it.each([[300], [1800]] as const)('%s s: locks at/after the threshold, not before', (t: AutoLockTimeout & number) => {
    expect(decideLockOnReturn(t, true, at(NOW - t * 1000 + 1), NOW)).toBe(false); // 1ms short
    expect(decideLockOnReturn(t, true, at(NOW - t * 1000), NOW)).toBe(true);      // exactly
    expect(decideLockOnReturn(t, true, at(NOW - t * 1000 - 1), NOW)).toBe(true);  // past
  });
});

describe('decideBootstrapLock — navigation matrix (§5)', () => {
  const base: BootstrapLockInput = {
    hasPin: true,
    timeoutSeconds: 300,
    wasDiscarded: false,
    navigationType: 'navigate',
    marker: NONE,
    nowMs: NOW,
  };

  it('feature off (no PIN / timeout null) → never locks', () => {
    expect(decideBootstrapLock({ ...base, hasPin: false, marker: INVALID })).toBe(false);
    expect(decideBootstrapLock({ ...base, timeoutSeconds: null, marker: INVALID })).toBe(false);
  });

  it('reload does NOT lock', () => {
    expect(decideBootstrapLock({ ...base, navigationType: 'reload', marker: at(1) })).toBe(false);
  });

  it('PRIORITY: reload + wasDiscarded=true → the discard branch decides (locks past threshold)', () => {
    // Chrome reactivates a discarded tab as a 'reload' — the discard flag wins.
    expect(decideBootstrapLock({
      ...base, navigationType: 'reload', wasDiscarded: true, marker: at(NOW - 301_000),
    })).toBe(true);
  });

  it('discarded but back within the threshold → no lock', () => {
    expect(decideBootstrapLock({
      ...base, navigationType: 'reload', wasDiscarded: true, marker: at(NOW - 10_000),
    })).toBe(false);
  });

  it('discarded with NO marker → fail-secure lock (away-time unknown)', () => {
    expect(decideBootstrapLock({ ...base, wasDiscarded: true, marker: NONE })).toBe(true);
  });

  it('back_forward: marker decides; missing marker → fail-secure lock', () => {
    expect(decideBootstrapLock({ ...base, navigationType: 'back_forward', marker: at(NOW - 10_000) })).toBe(false);
    expect(decideBootstrapLock({ ...base, navigationType: 'back_forward', marker: at(NOW - 301_000) })).toBe(true);
    expect(decideBootstrapLock({ ...base, navigationType: 'back_forward', marker: NONE })).toBe(true);
  });

  it('navigate: same fail-secure evaluation (duplicated tab has no marker → lock)', () => {
    expect(decideBootstrapLock({ ...base, navigationType: 'navigate', marker: NONE })).toBe(true);
    expect(decideBootstrapLock({ ...base, navigationType: 'navigate', marker: at(NOW - 1000) })).toBe(false);
  });

  it('no navigation entry → treated like navigate (fail-secure)', () => {
    expect(decideBootstrapLock({ ...base, navigationType: 'none', marker: NONE })).toBe(true);
    expect(decideBootstrapLock({ ...base, navigationType: 'none', marker: at(NOW - 1000) })).toBe(false);
  });

  it('timeout 0 at bootstrap: any valid marker locks; reload still does not', () => {
    expect(decideBootstrapLock({ ...base, timeoutSeconds: 0, marker: at(NOW - 1) })).toBe(true);
    expect(decideBootstrapLock({ ...base, timeoutSeconds: 0, navigationType: 'reload', marker: at(NOW - 1) })).toBe(false);
  });

  it('invalid marker → fail-secure lock on every non-reload branch', () => {
    for (const navigationType of ['back_forward', 'navigate', 'none'] as const) {
      expect(decideBootstrapLock({ ...base, navigationType, marker: INVALID })).toBe(true);
    }
    expect(decideBootstrapLock({ ...base, wasDiscarded: true, marker: INVALID })).toBe(true);
  });
});
