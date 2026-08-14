import { describe, it, expect } from 'vitest';
import { computeSyncCounters } from './syncCounters';
import type { NoteChain } from './chains';
import type { NoteSyncInfo } from './store';

// Node env: the counters are arithmetic over already-loaded state, so testing
// them through a rendered panel only added a DOM and a collapsible block to
// click open.

type Status = NoteSyncInfo['status'];

function chain(root: string, ...versionIds: string[]): NoteChain {
  const versions = versionIds.map(id => ({
    id, text: '', createdAt: 0, fmt: 'plain' as const, rev: 1, root,
  }));
  return { root, versions, current: versions[versions.length - 1] };
}

const statuses = (m: Record<string, Status>): Record<string, NoteSyncInfo> =>
  Object.fromEntries(Object.entries(m).map(([id, status]) => [id, { status }]));

const AGG = { confirmedCount: 0, acceptedCount: 0, unsyncedCount: 0 };

describe('computeSyncCounters', () => {
  it('counts a chain as «в блокчейне» only when EVERY version is confirmed', () => {
    const chains = [chain('a', 'a1', 'a2')];
    expect(computeSyncCounters(chains, statuses({ a1: 'confirmed', a2: 'confirmed' }), AGG).confirmedChains).toBe(1);
    // A half-uploaded note must not look finished.
    expect(computeSyncCounters(chains, statuses({ a1: 'confirmed', a2: 'accepted' }), AGG).confirmedChains).toBe(0);
  });

  it('«accepted» is NOT «в блокчейне» — the reset dialog treats only confirmed as recoverable', () => {
    const chains = [chain('a', 'a1')];
    const c = computeSyncCounters(chains, statuses({ a1: 'accepted' }), AGG);
    expect(c.confirmedChains).toBe(0);
    expect(c.pendingChains).toBe(1);
  });

  it('the two lines are disjoint', () => {
    const chains = [chain('a', 'a1'), chain('b', 'b1')];
    const c = computeSyncCounters(chains, statuses({ a1: 'confirmed', b1: 'accepted' }), AGG);
    expect(c.confirmedChains).toBe(1);
    expect(c.pendingChains).toBe(1);
  });

  it('a chain holding a queued/errored version falls into NEITHER line', () => {
    const chains = [chain('a', 'a1', 'a2')];
    const c = computeSyncCounters(chains, statuses({ a1: 'confirmed', a2: 'queued' }), AGG);
    expect(c.confirmedChains).toBe(0);
    expect(c.pendingChains).toBe(0); // visible instead under «Ожидают загрузки»
  });

  it('an unknown id counts as not-synced rather than throwing', () => {
    const c = computeSyncCounters([chain('a', 'a1')], {}, AGG);
    expect(c.confirmedChains).toBe(0);
    expect(c.pendingChains).toBe(0);
  });

  it('totalVersions comes from the storage aggregates, not from the chains', () => {
    // The aggregates include versions this build cannot decrypt, which are
    // invisible in `chains` — using chains.length would under-report.
    const c = computeSyncCounters([chain('a', 'a1')], statuses({ a1: 'confirmed' }),
      { confirmedCount: 5, acceptedCount: 2, unsyncedCount: 1 });
    expect(c.totalVersions).toBe(8);
  });

  it('no chains at all is zeroes, not NaN', () => {
    expect(computeSyncCounters([], {}, AGG)).toEqual({ confirmedChains: 0, pendingChains: 0, totalVersions: 0 });
  });
});
