import { describe, it, expect } from 'vitest';
import { planBackupImport, cascades, chainKey, type PlanInput } from './backup-plan';
import type { EncryptedNote } from './crypto';

/**
 * The order records are applied in, and which failures poison the rest of a
 * chain.
 *
 * Stage B is allowed to stop early, so what these rules buy is a single
 * property: whatever prefix got committed is a valid graph — no version stored
 * without the one it points back to (D12a).
 */

const rec = (id: string): EncryptedNote =>
  ({ noteId: id, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', createdAt: 1 });

const node = (
  id: string,
  rev: number,
  root: string,
  prev?: string,
  kind: 'note' | 'safebox' = 'note',
): PlanInput => ({ kind, id, record: rec(id), state: 'readable', topology: { root, rev, prev } });

/** A record stage A refused, with the verdict it refused it under. */
const refused = (
  id: string,
  state: 'unsupported' | 'malformed' | 'damaged' = 'unsupported',
  kind: 'note' | 'safebox' = 'note',
): PlanInput => ({ kind, id, record: rec(id), state });

describe('order', () => {
  it('applies a chain from its first version upwards, whatever order it arrives in', () => {
    const plan = planBackupImport([
      node('a3', 3, 'a1', 'a2'),
      node('a1', 1, 'a1'),
      node('a2', 2, 'a1', 'a1'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('keeps chains together so a stopped import reads as whole chains', () => {
    const plan = planBackupImport([
      node('b2', 2, 'b1', 'b1'),
      node('a2', 2, 'a1', 'a1'),
      node('b1', 1, 'b1'),
      node('a1', 1, 'a1'),
    ]);

    const ids = plan.ordered.map(r => r.id);
    expect(ids.indexOf('a2')).toBe(ids.indexOf('a1') + 1);
    expect(ids.indexOf('b2')).toBe(ids.indexOf('b1') + 1);
  });

  it('never places a version before the one it points back to', () => {
    const plan = planBackupImport([
      node('s2', 2, 's1', 's1', 'safebox'),
      node('a4', 4, 'a1', 'a3'),
      node('a1', 1, 'a1'),
      node('s1', 1, 's1', undefined, 'safebox'),
      node('a3', 3, 'a1', 'a2'),
      node('a2', 2, 'a1', 'a1'),
    ]);

    const seen = new Set<string>();
    for (const r of plan.ordered) {
      if (r.prev !== undefined) expect(seen.has(r.prev), `${r.id} before ${r.prev}`).toBe(true);
      seen.add(r.id);
    }
  });

  it('separates the two collections even when ids collide', () => {
    const plan = planBackupImport([
      node('same', 1, 'same'),
      node('same', 1, 'same', undefined, 'safebox'),
    ]);
    expect(chainKey('note', 'same')).not.toBe(chainKey('safebox', 'same'));
    expect(plan.ordered).toHaveLength(2);
  });
});

describe('records this build cannot read', () => {
  it('are set aside, never ordered for writing', () => {
    // Writing one would make the local queue try to serialize it and
    // quarantine it permanently as `unsupported_version` — and that quarantine
    // is irreversible. It is counted, warned about, and left in the file.
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      refused('opaque'),
      refused('opaque-entry', 'unsupported', 'safebox'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied).toEqual([
      { kind: 'note', id: 'opaque', counter: 'unsupported' },
      { kind: 'safebox', id: 'opaque-entry', counter: 'unsupported' },
    ]);
  });

  it('an empty container plans nothing', () => {
    const plan = planBackupImport([]);
    expect(plan.ordered).toEqual([]);
    expect(plan.notApplied).toEqual([]);
  });
});

describe('which outcomes poison the rest of a chain', () => {
  it('anything that leaves the record unapplied cascades', () => {
    for (const outcome of ['conflicts', 'unsupportedLocal', 'deferred', 'skipped', 'concurrentChange', 'quotaStopped']) {
      expect(cascades(outcome), outcome).toBe(true);
    }
  });

  it('anything that leaves it present and agreeing with the file does NOT', () => {
    // The test is «did this record end up present and matching the file?», not
    // «did anything change». A no-op leaves it present and equivalent, so its
    // descendants are still safe to write.
    for (const outcome of ['added', 'repaired', 'quarantinedRepaired', 'quarantinedDataRepaired', 'quarantineStale', 'noop']) {
      expect(cascades(outcome), outcome).toBe(false);
    }
  });
});

describe('a descendant whose predecessor is not in the plan', () => {
  it('is set aside with it, not applied on its own', () => {
    // The cascade in `runPlan` cannot see this case: a record this build could
    // not read has no topology, so it belongs to no chain and stops nothing.
    // Applied alone, `a3` would land in the store pointing at a `prev` the
    // store does not have — the hole D12a exists to prevent.
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      refused('a2'), // unreadable: stage A could not place it
      node('a3', 3, 'a1', 'a2'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied).toEqual([
      { kind: 'note', id: 'a2', counter: 'unsupported' },
      // Missing for its ANCESTOR's reason, not for one of its own.
      { kind: 'note', id: 'a3', counter: 'unsupported' },
    ]);
  });

  it('and so is everything behind IT', () => {
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      refused('a2'),
      node('a3', 3, 'a1', 'a2'),
      node('a4', 4, 'a1', 'a3'),
      node('a5', 5, 'a1', 'a4'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied.map(r => r.id)).toEqual(['a2', 'a3', 'a4', 'a5']);
    expect(plan.notApplied.every(r => r.counter === 'unsupported')).toBe(true);
  });

  it('a chain of its own is unaffected', () => {
    const plan = planBackupImport([
      refused('a1'),
      node('b1', 1, 'b1'),
      node('b2', 2, 'b1', 'b1'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['b1', 'b2']);
    expect(plan.notApplied.map(r => r.id)).toEqual(['a1']);
  });

  it('a link stage A would have rejected is set aside fail-closed', () => {
    // `prev` in ANOTHER chain: stage A refuses such a container outright, so
    // reaching here means something is already wrong. The plan does not try to
    // rescue it — it declines to write a record it cannot place.
    const plan = planBackupImport([
      node('z1', 1, 'z1'),
      node('a1', 1, 'a1'),
      node('a2', 2, 'a1', 'z1'), // ordered BEFORE z1: chain «a» sorts first
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1', 'z1']);
    // No ancestor to inherit from: «left unapplied» is all that can be said.
    expect(plan.notApplied).toEqual([{ kind: 'note', id: 'a2', counter: 'skipped' }]);
  });
});

describe('the counter a refused record lands in', () => {
  it('an unknown VERSION is `unsupported`; a broken shape or damaged bytes are not', () => {
    // `unsupported` means «this build does not know this version» and nothing
    // else — it is the line that tells the user a NEWER build might restore the
    // record. Saying it about a provably broken one sends them looking for a
    // build that does not exist.
    const plan = planBackupImport([
      refused('older', 'unsupported'),
      refused('broken', 'malformed'),
      refused('gone', 'damaged'),
    ]);

    expect(plan.notApplied).toEqual([
      { kind: 'note', id: 'older', counter: 'unsupported' },
      { kind: 'note', id: 'broken', counter: 'skipped' },
      { kind: 'note', id: 'gone', counter: 'skipped' },
    ]);
  });

  it('a descendant inherits the counter of the record that stranded it', () => {
    const plan = planBackupImport([
      refused('b1', 'damaged'),
      node('b2', 2, 'b1', 'b1'),
    ]);
    expect(plan.notApplied).toEqual([
      { kind: 'note', id: 'b1', counter: 'skipped' },
      { kind: 'note', id: 'b2', counter: 'skipped' },
    ]);
  });
});

describe('the predecessor test does not depend on sort order', () => {
  it('a prev in a chain that sorts EARLIER is still not a predecessor', () => {
    // The trap in a set-of-accepted-ids check: chain «a» is ordered first, so
    // `a1` is already accepted by the time `z2` is considered, and `z2` would
    // be written — leaving chain «z» with a rev 2 whose rev 1 may never arrive.
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      node('z1', 1, 'z1'),
      node('z2', 2, 'z1', 'a1'), // prev is real, accepted, and NOT its predecessor
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1', 'z1']);
    expect(plan.notApplied).toEqual([{ kind: 'note', id: 'z2', counter: 'skipped' }]);
  });

  it('a later revision with no prev at all is refused, not silently applied', () => {
    const plan = planBackupImport([node('a1', 1, 'a1'), node('a2', 2, 'a1')]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied).toEqual([{ kind: 'note', id: 'a2', counter: 'skipped' }]);
  });

  it('a rev-1 record that still claims a predecessor is refused', () => {
    const plan = planBackupImport([node('a1', 1, 'a1'), node('b1', 1, 'b1', 'a1')]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied.map(r => r.id)).toEqual(['b1']);
  });

  it('a rev-1 record that does not name ITSELF as its chain is refused', () => {
    // It would be a second «first version» of someone else's chain — and the
    // link check alone cannot see that, because such a record claims no
    // predecessor at all.
    const plan = planBackupImport([node('a1', 1, 'a1'), node('x1', 1, 'zzz')]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.notApplied).toEqual([{ kind: 'note', id: 'x1', counter: 'skipped' }]);
  });

  it('a FORK is refused: two records cannot hold one position', () => {
    // Both have a perfectly good predecessor, so the link check passes for
    // each of them — and the store would end up with two records claiming to
    // be revision 2, after which «which one is current» has no answer.
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      node('a2', 2, 'a1', 'a1'),
      node('a2b', 2, 'a1', 'a1'),
      node('a3b', 3, 'a1', 'a2b'), // and everything behind the loser goes too
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1', 'a2']);
    expect(plan.notApplied).toEqual([
      { kind: 'note', id: 'a2b', counter: 'skipped' },
      { kind: 'note', id: 'a3b', counter: 'skipped' },
    ]);
  });

  it('a healthy chain is untouched by any of it', () => {
    const plan = planBackupImport([...chainOf('a', 3), ...chainOf('b', 2)]);
    expect(plan.ordered.map(r => r.id)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    expect(plan.notApplied).toEqual([]);
  });
});

/** A well-formed chain, as stage A would hand it over. */
function chainOf(prefix: string, length: number): PlanInput[] {
  return Array.from({ length }, (_, i) =>
    node(`${prefix}${i + 1}`, i + 1, `${prefix}1`, i === 0 ? undefined : `${prefix}${i}`));
}
