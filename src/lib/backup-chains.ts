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
 * with a hole in it, or silently treat a middle version as the newest.
 */

export type ChainProblem =
  /** `prev` names a version this container does not contain. */
  | 'missing_prev'
  /** `root` names a version this container does not contain, or a rev-1
   *  record whose root is not itself. */
  | 'bad_root'
  /** `rev` is not a positive integer, or the chain skips a position. */
  | 'bad_rev'
  /** Two records claim the same position in one chain. */
  | 'conflicting_rev'
  /** Following `prev` returns to a version already visited. */
  | 'cycle'
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

  for (const node of nodes) {
    const own = byKind[node.kind];
    const foreign = byKind[node.kind === 'note' ? 'safebox' : 'note'];

    if (!Number.isSafeInteger(node.rev) || node.rev < 1) add(node, 'bad_rev');

    // A link into the other collection is its own problem, not a missing
    // record: the id spaces are disjoint (D10), so this is a container whose
    // halves reference each other — the result of a restore would depend on
    // which collection was processed first.
    if (!own.has(node.root)) {
      add(node, foreign.has(node.root) ? 'cross_kind' : 'bad_root');
    }
    if (node.prev !== undefined && !own.has(node.prev)) {
      add(node, foreign.has(node.prev) ? 'cross_kind' : 'missing_prev');
    }

    // A chain's first version names itself and has no predecessor. Getting
    // this wrong means the chain has no beginning, and every consumer that
    // walks it backwards runs off the end.
    if (node.rev === 1 && (node.root !== node.id || node.prev !== undefined)) {
      add(node, 'bad_root');
    }
    if (node.rev > 1 && node.prev === undefined) {
      add(node, 'missing_prev');
    }
  }

  validateChainPositions(nodes, add);
  detectCycles(nodes, byKind, add);
  return issues;
}

/** Within one chain the revisions must be exactly 1…n, each once. A gap means
 *  a version is missing from the file; a repeat means two records claim the
 *  same position and no consumer can say which is newer. */
function validateChainPositions(
  nodes: readonly ChainNode[],
  add: (node: ChainNode, problem: ChainProblem) => void,
): void {
  const chains = new Map<string, ChainNode[]>();
  for (const node of nodes) {
    const key = `${node.kind}:${node.root}`;
    const bucket = chains.get(key);
    if (bucket) bucket.push(node);
    else chains.set(key, [node]);
  }

  for (const members of chains.values()) {
    const seen = new Map<number, ChainNode>();
    for (const node of members) {
      const clash = seen.get(node.rev);
      if (clash !== undefined) {
        add(node, 'conflicting_rev');
        continue;
      }
      seen.set(node.rev, node);
    }
    // Exactly 1…n, so the highest revision equals the number of distinct ones.
    const highest = Math.max(...seen.keys());
    if (Number.isFinite(highest) && highest !== seen.size) {
      for (let rev = 1; rev <= highest; rev++) {
        const gap = !seen.has(rev);
        if (!gap) continue;
        // Blame the version that points across the hole, so the report names a
        // record the user actually has rather than one they do not.
        const orphan = seen.get(rev + 1);
        if (orphan) add(orphan, 'bad_rev');
      }
    }
  }
}

/** Follow `prev` from every node. A cycle cannot be reached by an honest
 *  writer, but a crafted or damaged container can contain one, and a consumer
 *  that walks the chain would hang rather than fail. */
function detectCycles(
  nodes: readonly ChainNode[],
  byKind: { note: Map<string, ChainNode>; safebox: Map<string, ChainNode> },
  add: (node: ChainNode, problem: ChainProblem) => void,
): void {
  for (const start of nodes) {
    const seen = new Set<string>([start.id]);
    let current: ChainNode | undefined = start;
    while (current?.prev !== undefined) {
      if (seen.has(current.prev)) {
        add(start, 'cycle');
        break;
      }
      seen.add(current.prev);
      current = byKind[start.kind].get(current.prev);
    }
  }
}
