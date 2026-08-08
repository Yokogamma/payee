import { describe, it, expect } from 'vitest';
import { groupChains, byCurrentness } from './chains';
import type { NoteData } from './crypto';

function note(over: Partial<NoteData> & { id: string }): NoteData {
  return {
    text: 't',
    createdAt: 1000,
    fmt: 'md',
    rev: 1,
    root: over.id,
    ...over,
  };
}

describe('groupChains', () => {
  it('returns an empty list for no notes', () => {
    expect(groupChains([])).toEqual([]);
  });

  it('a single note is its own chain and current version', () => {
    const n = note({ id: 'a', createdAt: 5 });
    const chains = groupChains([n]);
    expect(chains).toHaveLength(1);
    expect(chains[0].root).toBe('a');
    expect(chains[0].current).toBe(n);
    expect(chains[0].versions).toEqual([n]);
  });

  it('groups a linear chain by root; latest createdAt is current', () => {
    const v1 = note({ id: 'a', rev: 1, createdAt: 100 });
    const v2 = note({ id: 'b', rev: 2, root: 'a', prev: 'a', createdAt: 200 });
    const v3 = note({ id: 'c', rev: 3, root: 'a', prev: 'b', createdAt: 300 });
    const chains = groupChains([v1, v3, v2]);
    expect(chains).toHaveLength(1);
    expect(chains[0].current).toBe(v3);
    expect(chains[0].versions.map(v => v.id)).toEqual(['c', 'b', 'a']);
  });

  it('fork with equal rev: later createdAt wins current, both stay in history', () => {
    const base = note({ id: 'a', rev: 1, createdAt: 100 });
    const deviceA = note({ id: 'b', rev: 2, root: 'a', prev: 'a', createdAt: 200 });
    const deviceB = note({ id: 'c', rev: 2, root: 'a', prev: 'a', createdAt: 250 });
    const chains = groupChains([base, deviceA, deviceB]);
    expect(chains[0].current).toBe(deviceB);
    expect(chains[0].versions).toHaveLength(3);
  });

  it('fork where higher rev is OLDER: createdAt still wins (accepted rule)', () => {
    const base = note({ id: 'a', rev: 1, createdAt: 100 });
    const higherRevOlder = note({ id: 'b', rev: 5, root: 'a', prev: 'a', createdAt: 150 });
    const lowerRevNewer = note({ id: 'c', rev: 2, root: 'a', prev: 'a', createdAt: 900 });
    const chains = groupChains([base, higherRevOlder, lowerRevNewer]);
    expect(chains[0].current).toBe(lowerRevNewer);
  });

  it('equal createdAt: rev breaks the tie', () => {
    const a = note({ id: 'a', rev: 1, createdAt: 100 });
    const b = note({ id: 'b', rev: 2, root: 'a', prev: 'a', createdAt: 100 });
    expect(groupChains([a, b])[0].current).toBe(b);
  });

  it('equal createdAt AND rev: id ASC breaks the tie deterministically', () => {
    const x = note({ id: 'x', rev: 2, root: 'a', prev: 'a', createdAt: 100 });
    const y = note({ id: 'y', rev: 2, root: 'a', prev: 'a', createdAt: 100 });
    const a = note({ id: 'a', rev: 1, createdAt: 50 });
    expect(groupChains([a, y, x])[0].current).toBe(x);
    expect(groupChains([a, x, y])[0].current).toBe(x); // input order irrelevant
  });

  it('missing middle version does not break grouping (flat by root, no walking)', () => {
    const v1 = note({ id: 'a', rev: 1, createdAt: 100 });
    // rev 2 lost/undecryptable; rev 3 still groups by root
    const v3 = note({ id: 'c', rev: 3, root: 'a', prev: 'b-missing', createdAt: 300 });
    const chains = groupChains([v1, v3]);
    expect(chains).toHaveLength(1);
    expect(chains[0].current).toBe(v3);
  });

  it('duplicate rev with identical createdAt keeps both (ordinal display handles it)', () => {
    const a = note({ id: 'a', rev: 1, createdAt: 10 });
    const d1 = note({ id: 'd1', rev: 2, root: 'a', prev: 'a', createdAt: 20 });
    const d2 = note({ id: 'd2', rev: 2, root: 'a', prev: 'a', createdAt: 20 });
    expect(groupChains([a, d1, d2])[0].versions).toHaveLength(3);
  });

  it('v1-only notes are independent single-version chains', () => {
    const a = note({ id: 'a', fmt: 'plain', createdAt: 100 });
    const b = note({ id: 'b', fmt: 'plain', createdAt: 200 });
    const chains = groupChains([a, b]);
    expect(chains).toHaveLength(2);
    expect(chains.map(c => c.root)).toEqual(['b', 'a']); // feed order: newest first
  });

  it('feed sorts by CURRENT createdAt (an edited old note jumps to the top)', () => {
    const oldRoot = note({ id: 'a', createdAt: 100 });
    const oldEdit = note({ id: 'b', rev: 2, root: 'a', prev: 'a', createdAt: 900 });
    const newer = note({ id: 'c', createdAt: 500 });
    const chains = groupChains([oldRoot, oldEdit, newer]);
    expect(chains.map(c => c.root)).toEqual(['a', 'c']);
  });

  it('feed tie on current.createdAt falls back to root ASC (deterministic)', () => {
    const a = note({ id: 'a', createdAt: 100 });
    const b = note({ id: 'b', createdAt: 100 });
    expect(groupChains([b, a]).map(c => c.root)).toEqual(['a', 'b']);
  });

  it('a prev pointing into another root does not merge chains (prev is informational)', () => {
    const a = note({ id: 'a', createdAt: 100 });
    const alien = note({ id: 'b', rev: 2, root: 'r-other', prev: 'a', createdAt: 200 });
    const chains = groupChains([a, alien]);
    expect(chains).toHaveLength(2);
  });
});

describe('byCurrentness', () => {
  it('orders by createdAt DESC, rev DESC, id ASC', () => {
    const arr = [
      note({ id: 'b', rev: 1, createdAt: 100 }),
      note({ id: 'a', rev: 1, createdAt: 100 }),
      note({ id: 'c', rev: 2, root: 'a', prev: 'a', createdAt: 100 }),
      note({ id: 'd', rev: 1, createdAt: 200 }),
    ];
    arr.sort(byCurrentness);
    expect(arr.map(n => n.id)).toEqual(['d', 'c', 'a', 'b']);
  });
});
