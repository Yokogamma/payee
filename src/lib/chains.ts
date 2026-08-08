/**
 * Version-chain grouping — pure functions, no I/O.
 *
 * Chain identity = `root` (the noteId of the chain's first version, carried
 * inside every v3 envelope; synthesized as the own noteId for v1/v2). Grouping
 * is a single pass over a flat list, immune to missing middles (a failed or
 * undecryptable version) — unlike prev-chain walking, which breaks at the
 * first gap. `prev` is informational only and never affects grouping; a prev
 * pointing at a version with a different root is simply ignored.
 */

import type { NoteData } from './crypto';

export interface NoteChain {
  root: string;
  /** The version shown in the feed: latest createdAt (the accepted fork rule —
   *  a device with the later clock wins; history preserves everything). */
  current: NoteData;
  /** All versions, current-first (byCurrentness order). */
  versions: NoteData[];
}

/**
 * Deterministic "currentness": createdAt DESC, then rev DESC, then id ASC.
 * The tie-breaks make fork resolution stable across devices — two versions
 * with identical timestamps can never flip-flop between syncs.
 */
export function byCurrentness(a: NoteData, b: NoteData): number {
  return (b.createdAt - a.createdAt) || (b.rev - a.rev) || a.id.localeCompare(b.id);
}

/** Group a flat decrypted-note list into chains, feed-sorted (newest current
 *  first, root as the final tie-break). */
export function groupChains(notes: NoteData[]): NoteChain[] {
  const byRoot = new Map<string, NoteData[]>();
  for (const n of notes) {
    const bucket = byRoot.get(n.root);
    if (bucket) bucket.push(n);
    else byRoot.set(n.root, [n]);
  }

  const chains: NoteChain[] = [];
  for (const [root, versions] of byRoot) {
    versions.sort(byCurrentness);
    chains.push({ root, current: versions[0], versions });
  }

  chains.sort((a, b) =>
    (b.current.createdAt - a.current.createdAt) || a.root.localeCompare(b.root));
  return chains;
}
