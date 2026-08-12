/**
 * Version-chain grouping — pure functions, no I/O.
 *
 * Chain identity = `root` (the id of the chain's first version, carried inside
 * every v3 note envelope / v4 safebox meta envelope; synthesized as the own
 * noteId for v1/v2 notes). Grouping is a single pass over a flat list, immune
 * to missing middles (a failed or undecryptable version) — unlike prev-chain
 * walking, which breaks at the first gap. `prev` is informational only and
 * never affects grouping; a prev pointing at a version with a different root is
 * simply ignored.
 *
 * SAFEBOX NOTE (load-bearing): the fields fed in here MUST come from the
 * AUTHENTICATED envelope (`t`/`rev`/`root`), never from a record's outer,
 * locally-mutable `createdAt` — otherwise tampering with a local row would
 * promote an old password to «current».
 */

import type { NoteData, SafeboxEntryData } from './crypto';

/** The minimum a value needs to take part in chain grouping. */
export interface ChainVersion {
  id: string;
  createdAt: number;
  rev: number;
  root: string;
}

export interface Chain<T extends ChainVersion> {
  root: string;
  /** The version shown in the feed: latest createdAt (the accepted fork rule —
   *  a device with the later clock wins; history preserves everything). */
  current: T;
  /** All versions, current-first (byCurrentness order). */
  versions: T[];
}

export type NoteChain = Chain<NoteData>;
export type SafeboxChain = Chain<SafeboxEntryData>;

/**
 * Deterministic "currentness": createdAt DESC, then rev DESC, then id ASC.
 * The tie-breaks make fork resolution stable across devices — two versions
 * with identical timestamps can never flip-flop between syncs.
 */
export function byCurrentness<T extends ChainVersion>(a: T, b: T): number {
  return (b.createdAt - a.createdAt) || (b.rev - a.rev) || a.id.localeCompare(b.id);
}

/** Group a flat decrypted list into chains, feed-sorted (newest current first,
 *  root as the final tie-break). */
function group<T extends ChainVersion>(items: T[]): Chain<T>[] {
  const byRoot = new Map<string, T[]>();
  for (const n of items) {
    const bucket = byRoot.get(n.root);
    if (bucket) bucket.push(n);
    else byRoot.set(n.root, [n]);
  }

  const chains: Chain<T>[] = [];
  for (const [root, versions] of byRoot) {
    versions.sort(byCurrentness);
    chains.push({ root, current: versions[0], versions });
  }

  chains.sort((a, b) =>
    (b.current.createdAt - a.current.createdAt) || a.root.localeCompare(b.root));
  return chains;
}

export function groupChains(notes: NoteData[]): NoteChain[] {
  return group(notes);
}

/** Same grouping for safebox entries. The input MUST be decrypted META
 *  (`SafeboxEntryData.createdAt` is the authenticated envelope `t`). */
export function groupSafeboxChains(entries: SafeboxEntryData[]): SafeboxChain[] {
  return group(entries);
}
