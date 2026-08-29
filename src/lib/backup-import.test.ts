import { describe, it, expect, vi } from 'vitest';
import { applyBackupImport, SKIP_COUNTERS, type ImportCounters, type ImportDeps } from './backup-import';
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
  ({ kind: 'note', id, record: rec(id), state: 'readable', topology: { root, rev, prev } });

/** A record stage A could not place, with the verdict it refused it under. */
const refused = (id: string, state: 'unsupported' | 'malformed' | 'damaged' = 'unsupported'): PlanInput =>
  ({ kind: 'note', id, record: rec(id), state });

const chain = (prefix: string, length: number): PlanInput[] =>
  Array.from({ length }, (_, i) =>
    node(`${prefix}${i + 1}`, i + 1, `${prefix}1`, i === 0 ? undefined : `${prefix}${i}`));

/**
 * The full counter map with only the named fields set.
 *
 * Asserting against ALL twelve at once is what makes «counted at most once»
 * checkable: a record that landed in two buckets shows up as a non-zero counter
 * nobody named, which a per-field expectation would happily ignore.
 */
const counted = (set: Partial<ImportCounters>): ImportCounters => ({
  added: 0, repaired: 0, quarantinedRepaired: 0, quarantinedDataRepaired: 0,
  quarantineStale: 0, unsupportedLocal: 0, conflicts: 0, deferred: 0,
  skipped: 0, unsupported: 0, concurrentChange: 0, quotaStopped: 0,
  ...set,
});

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
      refused('opaque'),
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

describe('a file that is already here in full', () => {
  it('applies nothing at all and still takes the mark off', async () => {
    // Every record present locally and publication-equivalent, so rule 2
    // answers all of them with a no-op: not one counter moves, and not one
    // payload is written. The mark must come off anyway. Tying its removal to
    // «did we write anything» would leave a device that is ALREADY complete
    // flagged as incompletely restored forever — and every export it makes
    // from then on would carry that lie forward to the next machine.
    const h = harness({ outcomes: { a1: 'noop', a2: 'noop', b1: 'noop' } });
    const plan = planBackupImport([...chain('a', 2), ...chain('b', 1)]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters).toEqual(counted({})); // all twelve, `added` included
    expect(report.allFileRecordsApplied).toBe(true);
    expect(report.incompleteRestore).toBe(false);
    expect(h.markerWrites).toEqual([true, false]); // the run's only writes
    expect(h.merged).toEqual(['a1', 'a2', 'b1']);  // each one was considered
  });
});

describe('the cascade follows the BRANCH, not the root', () => {
  it('a conflict on one fork branch leaves the other branch fully restored', async () => {
    // A fork is ordinary history now: two devices editing offline both produce
    // rev 2. The cascade used to be keyed by `kind:root`, so a conflict on one
    // branch abandoned the whole root — including a sibling whose own
    // predecessor had just been written successfully. Worse, which branch
    // survived depended on which same-`rev` record the loop reached first, so
    // an everyday two-device edit lost a branch at random and the report
    // blamed a reason belonging to the other one.
    //
    // The rule the graph actually needs is narrower: a record may be written
    // only if the record it NAMES as `prev` is in the store.
    const h = harness({ outcomes: { a2: 'conflicts' } });
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      node('a2', 2, 'a1', 'a1'),   // branch A — conflicts
      node('a3', 3, 'a1', 'a2'),   // …and its child must not be written
      node('b2', 2, 'a1', 'a1'),   // branch B — independent, same position
      node('b3', 3, 'a1', 'b2'),
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    // `merged` records ATTEMPTS: a2 is attempted — that is how the conflict is
    // discovered — and only its child is never tried.
    expect(h.merged).toEqual(['a1', 'a2', 'b2', 'b3']);
    expect(report.counters.conflicts).toBe(2); // a2 and the child it stranded
    expect(report.counters.added).toBe(3);     // a1, b2, b3 — branch B intact
  });

  it('and the surviving branch is the one whose ancestor was applied, whatever the order', async () => {
    // The mirror image, with the branches swapped in the file. Under the old
    // root-keyed rule the outcome flipped with the input order; under the
    // predecessor rule it cannot.
    const h = harness({ outcomes: { b2: 'conflicts' } });
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      node('b2', 2, 'a1', 'a1'),
      node('b3', 3, 'a1', 'b2'),
      node('a2', 2, 'a1', 'a1'),
      node('a3', 3, 'a1', 'a2'),
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1', 'b2', 'a2', 'a3']);
    expect(report.counters.conflicts).toBe(2);
    expect(report.counters.added).toBe(3);
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

  it('counts the tail and NOTHING that had already been decided', async () => {
    // Mixed outcomes before the stop are where double counting hides. A record
    // already refused for its own reason must not also be swept into the tail,
    // and a record stranded behind one must be counted for the reason that
    // stopped its chain — once. Get it wrong and the report blames a full disk
    // for records that a conflict held back: the user goes off deleting photos
    // to make room instead of looking at the record that needs a decision.
    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const h = harness({
      outcomes: { a1: 'conflicts', b1: 'skipped', c1: 'noop' },
      throwOnMerge: id => (id === 'd1' ? quota : undefined),
    });
    const plan = planBackupImport([
      ...chain('a', 2), // a1 conflicts, a2 stranded behind it
      ...chain('b', 2), // b1 skipped, b2 stranded behind it
      ...chain('c', 2), // c1 already equivalent, c2 written
      ...chain('d', 3), // d1 runs into the quota, d2/d3 go with it
      ...chain('e', 2), // never reached at all
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters).toEqual(counted({
      conflicts: 2,    // a1, a2
      skipped: 2,      // b1, b2
      added: 1,        // c2 — c1 was a no-op and belongs in no counter at all
      quotaStopped: 5, // d1, d2, d3, e1, e2
    }));
    // Eleven records in the file, ten in the counters. The sum is deliberately
    // NOT the assertion (§8): only the per-counter values are, because a
    // successful no-op is honoured without being counted.
    expect(h.merged).toEqual(['a1', 'b1', 'c1', 'c2']); // the tail was never tried
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
      refused('a2'),
      node('a3', 3, 'a1', 'a2'),
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(h.merged).toEqual(['a1']);
    expect(report.counters.unsupported).toBe(2);
    expect(report.allFileRecordsApplied).toBe(false);
  });
});

describe('the counters stage A decided are the counters the report carries', () => {
  it('a broken record is `skipped`, not `unsupported`', async () => {
    // `unsupported` is the line that says «a newer version of the app may be
    // able to restore this». For a record whose shape is broken that is a
    // false lead, and the two must not share a counter.
    const h = harness();
    const plan = planBackupImport([
      node('a1', 1, 'a1'),
      refused('broken', 'malformed'),
      refused('older', 'unsupported'),
    ]);

    const report = await applyBackupImport(h.deps, plan, true);

    expect(report.counters.skipped).toBe(1);
    expect(report.counters.unsupported).toBe(1);
    expect(h.merged).toEqual(['a1']);
  });
});

describe('cancellation between the merge and the retry (D15)', () => {
  it('a lock after a `concurrentChange` stops the import before re-classifying', async () => {
    // The retry re-reads and re-decrypts the LOCAL record. A vault locked or
    // reset while the merge was running must not be classified against — the
    // guard has to sit between the merge and the second attempt, not only on
    // the way out of a successful one.
    const h = harness({ outcomes: { a1: ['concurrentChange', 'added'] } });
    let classifications = 0;
    let checks = 0;
    const deps: ImportDeps = {
      ...h.deps,
      classifyLocal: async (...args) => { classifications++; return h.deps.classifyLocal(...args); },
      // 1) marker read, 2) provisional write, 3) after classify, 4) after merge.
      assertAlive: () => { if (++checks >= 4) throw new Error('vault locked'); },
    };

    await expect(applyBackupImport(deps, planBackupImport([node('a1', 1, 'a1')]), true))
      .rejects.toThrow('vault locked');

    expect(classifications).toBe(1); // the retry never happened
  });
});
