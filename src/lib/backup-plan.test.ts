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
): PlanInput => ({ kind, id, record: rec(id), topology: { root, rev, prev } });

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
      { kind: 'note', id: 'opaque', record: rec('opaque') },
      { kind: 'safebox', id: 'opaque-entry', record: rec('opaque-entry') },
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.unsupported).toEqual([
      { kind: 'note', id: 'opaque' },
      { kind: 'safebox', id: 'opaque-entry' },
    ]);
  });

  it('an empty container plans nothing', () => {
    const plan = planBackupImport([]);
    expect(plan.ordered).toEqual([]);
    expect(plan.unsupported).toEqual([]);
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
      { kind: 'note', id: 'a2', record: rec('a2') }, // unreadable: no topology
      node('a3', 3, 'a1', 'a2'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.unsupported).toEqual([
      { kind: 'note', id: 'a2' },
      { kind: 'note', id: 'a3' },
    ]);
  });

  it('and so is everything behind IT', () => {
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      { kind: 'note', id: 'a2', record: rec('a2') },
      node('a3', 3, 'a1', 'a2'),
      node('a4', 4, 'a1', 'a3'),
      node('a5', 5, 'a1', 'a4'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['a1']);
    expect(plan.unsupported.map(r => r.id)).toEqual(['a2', 'a3', 'a4', 'a5']);
  });

  it('a chain of its own is unaffected', () => {
    const plan = planBackupImport([
      { kind: 'note', id: 'a1', record: rec('a1') },
      node('b1', 1, 'b1'),
      node('b2', 2, 'b1', 'b1'),
    ]);

    expect(plan.ordered.map(r => r.id)).toEqual(['b1', 'b2']);
    expect(plan.unsupported.map(r => r.id)).toEqual(['a1']);
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
    expect(plan.unsupported).toEqual([{ kind: 'note', id: 'a2' }]);
  });
});
