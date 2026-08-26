import { describe, it, expect } from 'vitest';
import { validateChains, type ChainNode } from './backup-chains';

/**
 * The version graph a container carries.
 *
 * These are not schema checks: the graph lives inside the encrypted envelopes,
 * so it can only be judged after everything has been decrypted. A container
 * whose graph is broken is not slightly wrong — restore and the UI both group
 * by `root` and order by `rev`, so a missing predecessor renders a chain with
 * a hole in it, or promotes a middle version to «newest».
 */

const node = (over: Partial<ChainNode> & Pick<ChainNode, 'id' | 'rev' | 'root'>): ChainNode =>
  ({ kind: 'note', ...over });

/** A well-formed chain of `length` versions. */
function chain(prefix: string, length: number, kind: ChainNode['kind'] = 'note'): ChainNode[] {
  const out: ChainNode[] = [];
  for (let rev = 1; rev <= length; rev++) {
    out.push({
      kind,
      id: `${prefix}-${rev}`,
      rev,
      root: `${prefix}-1`,
      prev: rev === 1 ? undefined : `${prefix}-${rev - 1}`,
    });
  }
  return out;
}

const problems = (nodes: ChainNode[]) => validateChains(nodes).map(i => i.problem).sort();

describe('a well-formed container has no problems', () => {
  it('accepts single versions and long chains, in both collections', () => {
    expect(validateChains([
      ...chain('a', 1),
      ...chain('b', 4),
      ...chain('s', 3, 'safebox'),
    ])).toEqual([]);
  });

  it('accepts an empty container', () => {
    expect(validateChains([])).toEqual([]);
  });
});

describe('links that point at nothing', () => {
  it('a prev naming a version the file does not contain', () => {
    const nodes = chain('a', 3);
    nodes.splice(1, 1); // remove rev 2, leaving rev 3 pointing at it
    expect(problems(nodes)).toContain('missing_prev');
  });

  it('a root naming a version the file does not contain', () => {
    expect(problems([node({ id: 'x-2', rev: 2, root: 'gone', prev: 'x-1' })]))
      .toContain('bad_root');
  });

  it('a rev-1 record whose root is not itself', () => {
    expect(problems([node({ id: 'a-1', rev: 1, root: 'a-1' }), node({ id: 'b-1', rev: 1, root: 'a-1' })]))
      .toContain('bad_root');
  });

  it('a rev-1 record that still claims a predecessor', () => {
    expect(problems([node({ id: 'a-1', rev: 1, root: 'a-1', prev: 'a-1' })]))
      .toContain('bad_root');
  });

  it('a later revision with no predecessor at all', () => {
    expect(problems([node({ id: 'a-1', rev: 1, root: 'a-1' }), node({ id: 'a-2', rev: 2, root: 'a-1' })]))
      .toContain('missing_prev');
  });
});

describe('revisions', () => {
  it('a chain that skips a version — caught by the LINK, without scanning positions', () => {
    const nodes = [
      ...chain('a', 1),
      node({ id: 'a-3', rev: 3, root: 'a-1', prev: 'a-1' }),
    ];
    expect(problems(nodes)).toEqual(['broken_link']);
  });

  it('two records claiming the same position', () => {
    const nodes = [
      ...chain('a', 2),
      node({ id: 'a-2b', rev: 2, root: 'a-1', prev: 'a-1' }),
    ];
    expect(problems(nodes)).toContain('conflicting_rev');
  });

  it('a revision that is not a positive integer', () => {
    for (const rev of [0, -1, 1.5, NaN]) {
      expect(problems([node({ id: 'a-1', rev, root: 'a-1' })]), String(rev)).toContain('bad_rev');
    }
  });
});

describe('links across the collection boundary', () => {
  it('a note whose prev is a safebox id', () => {
    const nodes: ChainNode[] = [
      { kind: 'safebox', id: 's-1', rev: 1, root: 's-1' },
      { kind: 'note', id: 'n-2', rev: 2, root: 'n-1', prev: 's-1' },
      { kind: 'note', id: 'n-1', rev: 1, root: 'n-1' },
    ];
    expect(problems(nodes)).toContain('cross_kind');
  });

  it('a safebox entry whose root is a note id', () => {
    const nodes: ChainNode[] = [
      { kind: 'note', id: 'n-1', rev: 1, root: 'n-1' },
      { kind: 'safebox', id: 's-2', rev: 2, root: 'n-1', prev: 's-1' },
      { kind: 'safebox', id: 's-1', rev: 1, root: 's-1' },
    ];
    expect(problems(nodes)).toContain('cross_kind');
  });

  it('the two id spaces are judged separately — same id in both is fine', () => {
    // D10 forbids this INSIDE one container, and `backup.ts` rejects it long
    // before here; the point is only that this module does not conflate them.
    expect(validateChains([
      { kind: 'note', id: 'same', rev: 1, root: 'same' },
      { kind: 'safebox', id: 'same', rev: 1, root: 'same' },
    ])).toEqual([]);
  });
});

describe('links that point somewhere real, but wrong', () => {
  it('a prev in ANOTHER chain of the same kind', () => {
    // The one the old validator let through: `prev` existed, so it passed —
    // and after that, ordering by `rev` was no longer topological, because
    // the record it depends on lives in a chain that may be written later.
    const nodes = [
      ...chain('a', 1),
      ...chain('z', 1),
      node({ id: 'a-2', rev: 2, root: 'a-1', prev: 'z-1' }),
    ];
    expect(problems(nodes)).toEqual(['broken_link']);
  });

  it('a prev that is not the immediately preceding revision', () => {
    const nodes = [...chain('a', 3), node({ id: 'a-4', rev: 4, root: 'a-1', prev: 'a-2' })];
    expect(problems(nodes)).toEqual(['broken_link']);
  });

  it('a loop is reported by the link check, and RETURNS', () => {
    // No walk, no colouring: `rev` must fall by exactly one along `prev`, so a
    // loop cannot pass. The assertion that matters is that this terminates.
    const nodes: ChainNode[] = [
      { kind: 'note', id: 'a', rev: 2, root: 'a', prev: 'b' },
      { kind: 'note', id: 'b', rev: 3, root: 'a', prev: 'a' },
    ];
    expect(problems(nodes)).toEqual(['broken_link']);
  });

  it('a record pointing at itself', () => {
    expect(problems([node({ id: 'a', rev: 2, root: 'a', prev: 'a' })])).toEqual(['broken_link']);
  });
});

describe('the work is bounded by the FILE, never by the values in it', () => {
  const BUDGET = 100;

  /**
   * The old implementation walked positions `1…max`, so its cost came from the
   * VALUE of `rev` — a container of two records could hang the tab for years.
   *
   * The budget is deterministic on purpose. A wall-clock assertion is flaky on
   * a loaded CI, and at `MAX_SAFE_INTEGER` a regression would hang the runner
   * itself, timer included — so the guard has to fire from INSIDE the loop.
   */
  it('a far-away rev costs no more lookups than a nearby one', () => {
    const nodes = [
      ...chain('a', 1),
      node({ id: 'a-far', rev: 5_000_000, root: 'a-1', prev: 'a-1' }),
    ];

    type Lookup = (this: Map<unknown, unknown>, key: unknown) => unknown;
    const proto = Map.prototype as unknown as { has: Lookup; get: Lookup };
    const original = { has: proto.has, get: proto.get };
    let lookups = 0;
    const counted = (fn: Lookup): Lookup => function (this: Map<unknown, unknown>, key: unknown) {
      if (++lookups > BUDGET) {
        throw new Error(`chain validation made more than ${BUDGET} map lookups`);
      }
      return fn.call(this, key);
    };

    let found: string[];
    try {
      proto.has = counted(original.has);
      proto.get = counted(original.get);
      found = problems(nodes);
    } finally {
      // Restore BEFORE asserting: `expect` uses maps of its own.
      proto.has = original.has;
      proto.get = original.get;
    }

    expect(found).toEqual(['broken_link']);
    // Two-sided: a counter that observed nothing would pass in any
    // implementation, including one that never looks a predecessor up.
    expect(lookups).toBeGreaterThan(0);
  });

  it('a revision at the top of the integer range is a typed problem, not a hang', () => {
    const nodes = [
      ...chain('a', 1),
      node({ id: 'a-max', rev: Number.MAX_SAFE_INTEGER, root: 'a-1', prev: 'a-1' }),
    ];
    expect(problems(nodes)).toEqual(['broken_link']);
  });
});

describe('reporting', () => {
  it('lists every problem, not just the first', () => {
    const nodes: ChainNode[] = [
      node({ id: 'a-2', rev: 2, root: 'missing', prev: 'gone' }),
      node({ id: 'b-9', rev: 9, root: 'also-missing' }),
    ];
    const found = validateChains(nodes);
    // A verify report exists to tell the user what is wrong with the FILE;
    // stopping at the first broken link would make them re-check one record at
    // a time.
    expect(found.length).toBeGreaterThan(2);
    expect(new Set(found.map(i => i.id))).toEqual(new Set(['a-2', 'b-9']));
  });

  it('names the record the user actually has when a version is missing', () => {
    const nodes = [...chain('a', 1), node({ id: 'a-3', rev: 3, root: 'a-1', prev: 'a-1' })];
    const gap = validateChains(nodes).find(i => i.problem === 'broken_link');
    expect(gap?.id).toBe('a-3'); // not the absent 'a-2'
  });
});
