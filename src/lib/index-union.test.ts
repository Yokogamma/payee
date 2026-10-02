import { describe, it, expect } from 'vitest';
import {
  ageProvenByQuorum,
  compareCandidates,
  MAX_PRESENCE_PROBES_PER_SWEEP,
  MAX_STATUS_HEIGHT_SKEW,
  MIN_PRESENCE_CONFIRMATIONS,
  selectPresenceProbes,
  unionSweeps,
  type IndexEdge,
  type SourceSweep,
} from './index-union';
import type { StatusVote } from './status-quorum';

// PR-4: the pure rules of the multi-index union (docs/ARWEAVE-RESILIENCE-PLAN.md
// §4.PR-4, D11 v16). No network anywhere in this file — the walker that feeds
// these functions is exercised in arweave.union.test.ts.

const edge = (txId: string, noteId: string, height: number | null = null, version = '3'): IndexEdge =>
  ({ txId, noteId, version, height });
const sweep = (source: number, edges: IndexEdge[], complete = true): SourceSweep => ({ source, complete, edges });

describe('compareCandidates — ONE total order for the multi-source stream', () => {
  it('height DESC, null heights after every known height, then txId ASC', () => {
    const items = [
      { height: null, txId: 'b' }, { height: 10, txId: 'z' }, { height: 12, txId: 'a' },
      { height: null, txId: 'a' }, { height: 10, txId: 'a' },
    ];
    const sorted = [...items].sort(compareCandidates).map(i => `${i.height}:${i.txId}`);
    expect(sorted).toEqual(['12:a', '10:a', '10:z', 'null:a', 'null:b']);
  });

  it('is a strict total order: any permutation sorts to the same sequence', () => {
    const items = [
      { height: 5, txId: 'c' }, { height: null, txId: 'd' }, { height: 5, txId: 'a' },
      { height: 7, txId: 'b' }, { height: null, txId: 'a' },
    ];
    const expected = [...items].sort(compareCandidates);
    // Every rotation and the reverse must land on the same order.
    for (let k = 0; k < items.length; k++) {
      const rotated = [...items.slice(k), ...items.slice(0, k)];
      expect([...rotated].sort(compareCandidates)).toEqual(expected);
    }
    expect([...items].reverse().sort(compareCandidates)).toEqual(expected);
  });
});

describe('unionSweeps — single source keeps the edge order, byte for byte', () => {
  it('does not re-sort one source, even when its heights are out of order', () => {
    const edges = [edge('t1', 'n1', 3), edge('t2', 'n2', 9), edge('t3', 'n3', null), edge('t4', 'n4', 5)];
    const out = unionSweeps([sweep(0, edges)]);
    expect(out.resorted).toBe(false);
    expect(out.ordered.map(c => c.txId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(out.presenceDisagreements).toEqual([]);
    expect(out.metadataConflicts).toBe(0);
  });

  it('a single source assembled from two transports IS re-sorted (review 24.09 #2)', () => {
    const edges = [edge('t-known', 'n', 8), edge('t-early', 'n', 9)]; // appended find last
    const out = unionSweeps([{ ...sweep(0, edges), merged: true }]);
    expect(out.resorted).toBe(true);
    expect(out.ordered.map(c => c.txId)).toEqual(['t-early', 't-known']);
  });

  it('collapses a txId an index returned twice (paging glitch) into one candidate', () => {
    const out = unionSweeps([sweep(0, [edge('t1', 'n1', 3), edge('t1', 'n1', 3)])]);
    expect(out.ordered).toHaveLength(1);
  });
});

describe('unionSweeps — two or more sources', () => {
  it('unions by txId and orders deterministically regardless of who answered first', () => {
    const a = [edge('t-old', 'n1', 100), edge('t-new', 'n1', 200)];
    const b = [edge('t-new', 'n1', 200), edge('t-mid', 'n1', 150), edge('t-null', 'n2', null)];
    const ab = unionSweeps([sweep(0, a), sweep(1, b)]);
    const ba = unionSweeps([sweep(0, b), sweep(1, a)]);
    expect(ab.resorted).toBe(true);
    expect(ab.ordered.map(c => c.txId)).toEqual(['t-new', 't-mid', 't-old', 't-null']);
    expect(ba.ordered.map(c => c.txId)).toEqual(ab.ordered.map(c => c.txId));
  });

  it('a height disagreement never drops the candidate: the MAX reported height orders it', () => {
    const out = unionSweeps([
      sweep(0, [edge('t1', 'n1', 100)]),
      sweep(1, [edge('t1', 'n1', 120), edge('t2', 'n2', 110)]),
    ]);
    expect(out.ordered.map(c => `${c.txId}@${c.height}`)).toEqual(['t1@120', 't2@110']);
    expect(out.metadataConflicts).toBe(0);
  });

  it('a SIGNED-field disagreement keeps the txId and marks it, never removes it', () => {
    const out = unionSweeps([
      sweep(0, [edge('t1', 'n1', 100)]),
      sweep(1, [edge('t1', 'n-other', 100)]),
    ]);
    expect(out.ordered).toHaveLength(1);
    expect(out.ordered[0].metadataConflict).toBe(true);
    expect(out.metadataConflicts).toBe(1);
    // Presence is not in question: both sources returned it.
    expect(out.presenceDisagreements).toEqual([]);
  });

  it('presence is judged ONLY between COMPLETE sources', () => {
    const complete = unionSweeps([
      sweep(0, [edge('t1', 'n1', 1), edge('t2', 'n2', 2)]),
      sweep(1, [edge('t1', 'n1', 1)]),
    ]);
    expect(complete.presenceDisagreements).toEqual(['t2']);

    // The same omission by a source that failed mid-walk is NOT a disagreement
    // (v16): it is not read, so it is not a witness of silence.
    const partial = unionSweeps([
      sweep(0, [edge('t1', 'n1', 1), edge('t2', 'n2', 2)]),
      sweep(1, [edge('t1', 'n1', 1)], false),
    ]);
    expect(partial.presenceDisagreements).toEqual([]);
    // …but its candidates are still in the union.
    expect(partial.ordered.map(c => c.txId)).toEqual(['t2', 't1']);
  });

  it('disagreements are listed in txId order, and a txId every complete source has is not one', () => {
    const out = unionSweeps([
      sweep(0, [edge('t-b', 'n', 1), edge('t-a', 'n', 1), edge('t-c', 'n', 1)]),
      sweep(1, [edge('t-c', 'n', 1)]),
      sweep(2, [edge('t-c', 'n', 1), edge('t-a', 'n', 1)]),
    ]);
    expect(out.presenceDisagreements).toEqual(['t-a', 't-b']);
  });
});

describe('ageProvenByQuorum — the STATUS quorum decides, indexes never do', () => {
  const ops = new Map([
    ['https://a', 'op-a'], ['https://a2', 'op-a'], ['https://b', 'op-b'], ['https://c', 'op-c'],
  ]);
  const operatorOf = (origin: string) => ops.get(origin) ?? null;
  const confirmed = (origin: string, confirmations: number, blockHeight = 1000): StatusVote =>
    ({ origin, kind: 'confirmed', confirmations, blockHeight });

  it('two independent operators past the threshold, heights within the skew → proven', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', MIN_PRESENCE_CONFIRMATIONS), confirmed('https://b', MIN_PRESENCE_CONFIRMATIONS + 3, 1000 + MAX_STATUS_HEIGHT_SKEW),
    ], operatorOf)).toBe(true);
  });

  it('two origins of ONE operator are one voice: not proven; a third operator completes it', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', 500), confirmed('https://a2', 500),
    ], operatorOf)).toBe(false);
    expect(ageProvenByQuorum([
      confirmed('https://a', 500), confirmed('https://a2', 500), confirmed('https://c', 500),
    ], operatorOf)).toBe(true);
  });

  it('an origin with no known operator casts no vote (fail-closed)', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', 500), confirmed('https://unknown.example', 500),
    ], operatorOf)).toBe(false);
  });

  it('a fresh txId (below the confirmation threshold) is never "old" — that is honest lag', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', MIN_PRESENCE_CONFIRMATIONS - 1), confirmed('https://b', 500),
    ], operatorOf)).toBe(false);
  });

  it('heights spread beyond MAX_STATUS_HEIGHT_SKEW do not describe one chain → not proven', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', 500, 1000), confirmed('https://b', 500, 1000 + MAX_STATUS_HEIGHT_SKEW + 1),
    ], operatorOf)).toBe(false);
  });

  it('pending / dead / other votes are not age votes; one confirmed voice alone is not enough', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', 500),
      { origin: 'https://b', kind: 'pending' },
      { origin: 'https://c', kind: 'dead404' },
    ], operatorOf)).toBe(false);
  });

  it('within one operator the LOWEST confirmation count is that operator\'s voice', () => {
    expect(ageProvenByQuorum([
      confirmed('https://a', 500), confirmed('https://a2', MIN_PRESENCE_CONFIRMATIONS - 1), confirmed('https://b', 500),
    ], operatorOf)).toBe(false);
  });
});

describe('selectPresenceProbes — deterministic, budgeted', () => {
  it('probes at most the budget, oldest key first (txId ASC), and says when it cut', () => {
    const many = Array.from({ length: MAX_PRESENCE_PROBES_PER_SWEEP + 1 }, (_, i) => `tx-${String(i).padStart(3, '0')}`).reverse();
    const out = selectPresenceProbes(many);
    expect(out.probe).toHaveLength(MAX_PRESENCE_PROBES_PER_SWEEP);
    expect(out.probe[0]).toBe('tx-000');
    expect(out.budgetExhausted).toBe(true);
    expect(selectPresenceProbes(['b', 'a']).probe).toEqual(['a', 'b']);
    expect(selectPresenceProbes(['b', 'a']).budgetExhausted).toBe(false);
  });
});
