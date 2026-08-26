import { describe, it, expect, vi } from 'vitest';
import { applyBackupImport, SKIP_COUNTERS, type ImportDeps } from './backup-import';
import { planBackupImport, type PlanInput } from './backup-plan';
import type { BackupMergeResult } from './storage';
import type { EncryptedNote } from './crypto';

/**
 * Stage B: applying a planned container.
 *
 * The three properties worth breaking a build over are all about HONESTY
 * rather than throughput — an import that quietly does less than it claims is
 * how a user ends up deleting the only copy of something:
 *
 *  - a record that goes unapplied is always counted, and counted once;
 *  - the completeness marker is set before the first write, not after the last;
 *  - a chain whose first version could not be applied is not half-written.
 */

const NOW = 1_750_000_000_000;

const rec = (id: string): EncryptedNote =>
  ({ noteId: id, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', createdAt: 1 });

const node = (id: string, rev: number, root: string, prev?: string): PlanInput =>
  ({ kind: 'note', id, record: rec(id), topology: { root, rev, prev } });

const chain = (prefix: string, length: number): PlanInput[] =>
  Array.from({ length }, (_, i) =>
    node(`${prefix}${i + 1}`, i + 1, `${prefix}1`, i === 0 ? undefined : `${prefix}${i}`));

interface Harness {
  deps: ImportDeps;
  merged: string[];
  markerWrites: boolean[];
  marker: { value: boolean };
}

function harness(opts: {
  outcomes?: Record<string, BackupMergeResult | BackupMergeResult[]>;
  startMarker?: boolean;
  throwOnMerge?: (id: string) => unknown;
  markerWriteFails?: boolean;
  lockUnavailable?: boolean;
} = {}): Harness {
  const merged: string[] = [];
  const markerWrites: boolean[] = [];
  const marker = { value: opts.startMarker ?? false };
  const pending = new Map<string, BackupMergeResult[]>();

  const deps: ImportDeps = {
    now: () => NOW,
    assertAlive: () => {},
    classifyLocal: async () => ({ state: 'absent' }),
    mergeRecord: async (_kind, incoming) => {
      const id = (incoming as EncryptedNote).noteId;
      const boom = opts.throwOnMerge?.(id);
      if (boom) throw boom;
      merged.push(id);
      const configured = opts.outcomes?.[id];
      if (Array.isArray(configured)) {
        const queue = pending.get(id) ?? [...configured];
        pending.set(id, queue);
        return queue.shift() ?? 'added';
      }
      return configured ?? 'added';
    },
    readIncompleteMarker: async () => marker.value,
    writeIncompleteMarker: async (value: boolean) => {
      if (opts.markerWriteFails) throw new Error('meta write failed');
      markerWrites.push(value);
      marker.value = value;
    },
    withExclusiveLock: async run => {
      if (opts.lockUnavailable) throw new Error('navigator.locks unavailable');
      return run();
    },
  };
  return { deps, merged, markerWrites, marker };
}

describe('counting', () => {
  it('counts each applied record once and successful no-ops not at all', async () => {
    // A file whose records are already present and equivalent has been fully
    // honoured. Counting those as skipped would make a complete, correctly
    // applied import report itself as incomplete.
    const h = harness({ outcomes: { a1: 'noop', b1: 'added', c1: 'repaired' } });
    const plan = planBackupImport([node('a1', 1, 'a1'), node('b1', 1, 'b1'), node('c1', 1, 'c1')]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.added).toBe(1);
    expect(report.counters.repaired).toBe(1);
    expect(SKIP_COUNTERS.every(name => report.counters[name] === 0)).toBe(true);
    expect(report.allFileRecordsApplied).toBe(true);
  });

  it('a file record this build cannot read is counted without being written', async () => {
    const h = harness();
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      { kind: 'note', id: 'opaque', record: rec('opaque') },
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.unsupported).toBe(1);
    expect(h.merged).toEqual(['a1']); // never attempted
    expect(report.allFileRecordsApplied).toBe(false);
  });

  it('no record is counted twice', async () => {
    const h = harness({ outcomes: { a1: 'conflicts' } });
    const plan = planBackupImport(chain('a', 3));

    const report = await applyBackupImport(h.deps, plan, true);

    const total = Object.values(report.counters).reduce((a, b) => a + b, 0);
    expect(total).toBe(3); // exactly the number of records in the file
  });
});

describe('a chain that cannot be applied is not half-written', () => {
  it('a conflict on the first version stops the rest of its chain', async () => {
    const h = harness({ outcomes: { a1: 'conflicts' } });
    const plan = planBackupImport([...chain('a', 3), ...chain('b', 2)]);

    const report = await applyBackupImport(h.deps, plan, true);

    // Descendants are not even attempted: writing one would leave a version
    // whose predecessor the store does not have.
    expect(h.merged).toEqual(['a1', 'b1', 'b2']);
    // ...and they are counted under the reason that stopped the chain, which
    // says WHY a whole chain is missing rather than merely that it is.
    expect(report.counters.conflicts).toBe(3);
    expect(report.counters.added).toBe(2);
  });

  it('a mid-chain failure stops only what follows it', async () => {
    const h = harness({ outcomes: { a2: 'deferred' } });
    const plan = planBackupImport(chain('a', 4));

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1', 'a2']);
    expect(report.counters.added).toBe(1);
    expect(report.counters.deferred).toBe(3);
  });

  it('an outcome that leaves the record present does NOT stop the chain', async () => {
    const h = harness({ outcomes: { a1: 'noop', a2: 'quarantineStale' } });
    const plan = planBackupImport(chain('a', 3));

    await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1', 'a2', 'a3']);
  });

  it('one chain stopping leaves the others alone', async () => {
    const h = harness({ outcomes: { a1: 'unsupportedLocal' } });
    const plan = planBackupImport([...chain('a', 2), ...chain('b', 2), ...chain('c', 1)]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.added).toBe(3);
    expect(report.counters.unsupportedLocal).toBe(2);
  });
});

describe('running out of space', () => {
  it('keeps what was written and counts the WHOLE remaining tail', async () => {
    // A flag or a count of one would understate the loss at exactly the moment
    // it is largest — the report line «not restored: K» would lie low.
    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const h = harness({ throwOnMerge: id => (id === 'b1' ? quota : undefined) });
    const plan = planBackupImport([...chain('a', 2), ...chain('b', 2), ...chain('c', 3)]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.added).toBe(2);        // chain a landed
    expect(report.counters.quotaStopped).toBe(5); // b1,b2 and all of c
    expect(report.allFileRecordsApplied).toBe(false);
  });

  it('any other error is not swallowed', async () => {
    const h = harness({ throwOnMerge: id => (id === 'a1' ? new Error('bug') : undefined) });
    const plan = planBackupImport(chain('a', 1));

    await expect(applyBackupImport(h.deps, plan, true)).rejects.toThrow('bug');
  });
});

describe('a record that moved under us', () => {
  it('is retried exactly once', async () => {
    const h = harness({ outcomes: { a1: ['concurrentChange', 'added'] } });
    const plan = planBackupImport(chain('a', 1));

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1', 'a1']);
    expect(report.counters.added).toBe(1);
    expect(report.counters.concurrentChange).toBe(0);
  });

  it('a second failure is reported rather than fought', async () => {
    // Looping would let a busy other tab hold the import open indefinitely.
    const h = harness({ outcomes: { a1: ['concurrentChange', 'concurrentChange', 'added'] } });
    const plan = planBackupImport(chain('a', 1));

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toHaveLength(2);
    expect(report.counters.concurrentChange).toBe(1);
    expect(report.allFileRecordsApplied).toBe(false);
  });
});

describe('the completeness marker', () => {
  it('is set to true BEFORE the first write', async () => {
    const order: string[] = [];
    const h = harness();
    const merge = h.deps.mergeRecord;
    h.deps.mergeRecord = async (...args) => { order.push('merge'); return merge(...args); };
    h.deps.writeIncompleteMarker = async v => { order.push(`marker:${v}`); h.marker.value = v; };

    await applyBackupImport(h.deps, planBackupImport(chain('a', 1)), true);

    // A crash, a hidden page or a full disk halfway through must leave the
    // store honestly marked incomplete. Marking at the end would miss exactly
    // the case the marker exists for.
    expect(order[0]).toBe('marker:true');
    expect(order).toContain('merge');
  });

  it('is rolled back only for a clean import of a complete file that began clean', async () => {
    const h = harness({ startMarker: false });
    const report = await applyBackupImport(h.deps, planBackupImport(chain('a', 2)), true);

    expect(report.incompleteRestore).toBe(false);
    expect(h.markerWrites).toEqual([true, false]);
  });

  it('stays true when anything at all went unapplied', async () => {
    const h = harness({ startMarker: false, outcomes: { a1: 'conflicts' } });
    const report = await applyBackupImport(h.deps, planBackupImport(chain('a', 1)), true);

    expect(report.incompleteRestore).toBe(true);
    expect(h.markerWrites).toEqual([true]);
  });

  it('stays true when the FILE itself was incomplete — the trait is inherited', async () => {
    const h = harness({ startMarker: false });
    const report = await applyBackupImport(h.deps, planBackupImport(chain('a', 1)), false);
    expect(report.incompleteRestore).toBe(true);
  });

  it('is sticky: a clean import cannot clear a mark that was already set', async () => {
    // «A complete import of a complete file» does not prove that a record
    // dropped by an earlier partial restore came back — importing an OLDER
    // complete copy, which never contained it, produces the same zero counts.
    const h = harness({ startMarker: true });
    const report = await applyBackupImport(h.deps, planBackupImport(chain('a', 2)), true);

    expect(report.incompleteRestore).toBe(true);
    expect(h.markerWrites).toEqual([true]);
  });

  it('is read INSIDE the lock, not before it', async () => {
    const order: string[] = [];
    const h = harness();
    h.deps.readIncompleteMarker = async () => { order.push('read'); return false; };
    h.deps.withExclusiveLock = async run => { order.push('lock'); return run(); };

    await applyBackupImport(h.deps, planBackupImport(chain('a', 1)), true);

    // Two tabs that both read `false` before acquiring the lock could race: the
    // partial import sets true, and the other clears it from a stale value.
    expect(order).toEqual(['lock', 'read']);
  });

  it('a failing marker write touches nothing at all', async () => {
    const h = harness({ markerWriteFails: true });

    await expect(applyBackupImport(h.deps, planBackupImport(chain('a', 2)), true)).rejects.toThrow();
    expect(h.merged).toEqual([]); // better to import nothing than half
  });
});

describe('serialization across tabs', () => {
  it('an import that cannot be serialized does not start', async () => {
    const h = harness({ lockUnavailable: true });

    await expect(applyBackupImport(h.deps, planBackupImport(chain('a', 1)), true)).rejects.toThrow();
    expect(h.merged).toEqual([]);
    expect(h.markerWrites).toEqual([]);
  });

  it('the whole import runs inside one lock hold', async () => {
    const h = harness();
    let insideLock = false;
    const merge = h.deps.mergeRecord;
    h.deps.mergeRecord = async (...args) => {
      expect(insideLock, 'a merge ran outside the lock').toBe(true);
      return merge(...args);
    };
    h.deps.withExclusiveLock = async run => {
      insideLock = true;
      try { return await run(); } finally { insideLock = false; }
    };

    await applyBackupImport(h.deps, planBackupImport(chain('a', 3)), true);
    expect(h.merged).toHaveLength(3);
  });
});

describe('cancellation', () => {
  it('a locked vault stops the import', async () => {
    const boom = new Error('locked');
    const h = harness();
    const alive = vi.fn(() => { throw boom; });
    h.deps.assertAlive = alive;

    await expect(applyBackupImport(h.deps, planBackupImport(chain('a', 1)), true)).rejects.toBe(boom);
  });
});

describe('what the report is, and what it is not', () => {
  it('«everything applied» is not «this is a complete backup»', () => {
    // The two questions are orthogonal (D11a), and the field name has to keep
    // them apart: a clean import of a file that was ITSELF made by a partial
    // restore applies every record it carries and still leaves the device
    // marked incomplete. A field called `complete` here would be shown green.
    return harnessedFullImport().then(report => {
      expect(report.allFileRecordsApplied).toBe(true);
      expect(report.incompleteRestore).toBe(true);
    });
  });

  async function harnessedFullImport() {
    const h = harness();
    const plan = planBackupImport([node('a1', 1, 'a1')]);
    return applyBackupImport(h.deps, plan, false); // the FILE was incomplete
  }

  it('a record the store contradicts itself about is skipped, not thrown away with the report', async () => {
    // One record's problem: the local sync row says «safebox» under a note's
    // id. Letting it escape would discard the counters for the whole file —
    // telling a user who just imported half a vault nothing about which half.
    const contract = Object.assign(new Error('sync row is a safebox, not a note'), {
      name: 'BackupMergeContractError',
    });
    const h = harness({ throwOnMerge: id => (id === 'a2' ? contract : undefined) });
    const plan = planBackupImport([...chain('a', 3), ...chain('b', 1)]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.added).toBe(2);      // a1 and b1
    expect(report.counters.skipped).toBe(2);    // a2, and a3 behind it
    // a2 was attempted and refused (the harness records only merges that
    // return); a3 was never attempted at all — the cascade stopped its chain.
    expect(h.merged).toEqual(['a1', 'b1']);
    expect(report.allFileRecordsApplied).toBe(false);
  });

  it('a descendant stranded behind an unreadable record is counted, never attempted', async () => {
    const h = harness();
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      { kind: 'note', id: 'a2', record: rec('a2') },
      node('a3', 3, 'a1', 'a2'),
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1']);
    expect(report.counters.unsupported).toBe(2);
    expect(report.allFileRecordsApplied).toBe(false);
  });
});
