/**
 * Eternal Notes — version-chain validation for a backup container.
 *
 * A note or safebox entry is one VERSION in a chain: `root` names the chain,
 * `rev` is its position, `prev` points at the version before it. The graph is
 * private — it lives inside the encrypted envelope — so it can only be checked
 * after every record has been decrypted, which is why this runs during the
 * dry-run rather than during schema validation.
 *
 * What is checked is the SHAPE of the graph, and nothing else reaches this
 * module: ids, revisions and links. No plaintext, no titles, no note text —
 * the caller extracts the topology and drops everything else (D11).
 *
 * Why a container with a broken graph must not read as healthy: restore and
 * the UI both group by `root` and order by `rev`. A version whose predecessor
 * is missing is not a small inconsistency — it is a chain the app will render
 * with a hole in it, or silently treat a middle version as the newest. And the
 * import applies records in `rev` order, which is only a TOPOLOGICAL order if
 * `prev` really is the previous revision of the same chain.
 *
 * ── One pass, direct links, and what that makes unnecessary ──────────
 *
 * Every check below is local to a record and its immediate predecessor:
 * `prev` exists, belongs to the SAME chain, and sits exactly one revision
 * back. Existence alone was not enough — a link into another chain of the same
 * kind passed it, after which ordering by `rev` stopped being topological and
 * a descendant could be written before the record it points at (D12a).
 *
 * Two things follow from the direct link and are therefore NOT implemented
 * here, deliberately:
 *
 *  - **no scan for gaps.** A record at `rev = k` requires a predecessor at
 *    `k-1` in its chain, which requires one at `k-2`, down to 1 — so a hole
 *    cannot exist among records that all pass. (Equivalently: the lowest
 *    revision in a chain must be 1, or its own `prev` check fails.) The
 *    previous implementation walked positions `1…max` instead, which is
 *    bounded by the VALUE of `rev` rather than by the size of the file:
 *    `rev` may be any safe integer, so a container of two records could hang
 *    the tab for years — in the read-only operation a user runs when
 *    something is already wrong.
 *  - **no cycle detection.** `rev` strictly decreases by one along `prev` and
 *    is bounded below by 1, so a loop cannot pass the link check at all. The
 *    old walk was O(n²) and, on a long chain, slow enough to matter.
 *
 * What does NOT follow, and is kept: at most one record per position. Two
 * records at `rev = k` both pointing at `k-1` is a fork, and the direct link
 * says nothing against it.
 */

export type ChainProblem =
  /** `prev` names a version this container does not contain. */
  | 'missing_prev'
  /** `root` names a version this container does not contain, or a rev-1
   *  record whose root is not itself. */
  | 'bad_root'
  /** `rev` is not a positive integer. */
  | 'bad_rev'
  /** `prev` exists, but it is not the immediately preceding version of THIS
   *  chain: another chain, or the wrong revision. A loop lands here too. */
  | 'broken_link'
  /** Two records claim the same position in one chain. */
  | 'conflicting_rev'
  /** A link points into the OTHER collection's id space. */
  | 'cross_kind';

export interface ChainNode {
  kind: 'note' | 'safebox';
  id: string;
  rev: number;
  root: string;
  prev?: string;
}

export interface ChainIssue {
  kind: 'note' | 'safebox';
  id: string;
  problem: ChainProblem;
}

/**
 * Validate every chain in one container. Returns the problems found —
 * exhaustively, not first-failure: a verify report exists to tell the user
 * what is wrong with the file, and stopping at the first broken link would
 * make them fix and re-check one record at a time.
 *
 * Linear in the number of records, whatever the values inside them.
 */
export function validateChains(nodes: readonly ChainNode[]): ChainIssue[] {
  const issues: ChainIssue[] = [];
  const add = (node: ChainNode, problem: ChainProblem) =>
    issues.push({ kind: node.kind, id: node.id, problem });

  const byKind = {
    note: new Map<string, ChainNode>(),
    safebox: new Map<string, ChainNode>(),
  };
  for (const node of nodes) byKind[node.kind].set(node.id, node);

  /** `kind:root:rev` → the record that claimed that position first. */
  const positions = new Set<string>();

  for (const node of nodes) {
    const own = byKind[node.kind];
    const foreign = byKind[node.kind === 'note' ? 'safebox' : 'note'];

    if (!Number.isSafeInteger(node.rev) || node.rev < 1) {
      // Without a usable position there is nothing to compare a link against,
      // and reporting one defect twice helps nobody. A record pointing AT this
      // one still fails its own link check, so the chain is not let through.
      add(node, 'bad_rev');
      continue;
    }

    // A link into the other collection is its own problem, not a missing
    // record: the id spaces are disjoint (D10), so this is a container whose
    // halves reference each other — the result of a restore would depend on
    // which collection was processed first.
    if (!own.has(node.root)) {
      add(node, foreign.has(node.root) ? 'cross_kind' : 'bad_root');
    }

    const position = `${node.kind}:${node.root}:${node.rev}`;
    if (positions.has(position)) add(node, 'conflicting_rev');
    else positions.add(position);

    // A chain's first version names itself and has no predecessor. Getting
    // this wrong means the chain has no beginning, and every consumer that
    // walks it backwards runs off the end.
    if (node.rev === 1) {
      if (node.root !== node.id || node.prev !== undefined) add(node, 'bad_root');
      continue;
    }

    if (node.prev === undefined) {
      add(node, 'missing_prev');
      continue;
    }
    const prev = own.get(node.prev);
    if (prev === undefined) {
      add(node, foreign.has(node.prev) ? 'cross_kind' : 'missing_prev');
      continue;
    }
    // The link must be DIRECT. This single comparison is what makes ordering
    // by `rev` topological, what closes the gap scan, and what makes a loop
    // impossible — see the module header.
    if (prev.root !== node.root || prev.rev !== node.rev - 1) add(node, 'broken_link');
  }

  return issues;
}
