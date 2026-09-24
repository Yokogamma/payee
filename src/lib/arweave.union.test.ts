import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSignedTx, gatewayFetchMock, notesTags, testWallet } from '../test-stubs/signed-tx';

// PR-4 «Multi-index restore union»: the walker over LOGICAL index sources
// (primary + transport-fallbacks), the union of their answers, the sentinel
// pass over the ordered union, and the D11 presence check against the STATUS
// quorum. Single-source behaviour is anchored elsewhere (arweave.incremental,
// bit-for-bit); this file only exercises what needs ≥2 sources or a fallback.
// Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-4, D11 (v16).

const SRC_A = 'https://index-a.example/graphql';
const SRC_A_FALLBACK = 'https://index-a-fallback.example/graphql';
const SRC_B = 'https://index-b.example/graphql';
const S1 = 'https://s1.example';
const S2 = 'https://s2.example';
const S3 = 'https://s3.example';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function ring(key: CryptoKey) {
  return { note: key, safeboxMeta: key, safeboxSecret: key };
}

async function noteKey(): Promise<CryptoKey> {
  const { deriveKey, generateMnemonic } = await import('./crypto');
  return deriveKey(generateMnemonic());
}

const v2wire = (n: { noteId: string; ciphertext: string; iv: string }) =>
  ({ id: n.noteId, c: n.ciphertext, iv: n.iv });

interface EdgeLabel { txId: string; version?: string; noteId: string; height?: number | null }

/**
 * Sources are described in LABELS ('T1', 'T2', …); the helper signs a real
 * transaction per label (D9: a txId is derived from the signature) and maps
 * both ways, so the tests read like the spec.
 */
async function stubSources(spec: {
  /** `VITE_INDEX_SOURCES` value. */
  sources: string;
  /** Pages per transport URL, in label form. */
  pages: Record<string, EdgeLabel[][]>;
  /** Decryptable bodies by label; a label without one answers /raw 404. */
  payloads: Record<string, unknown>;
  /** Status origins + operator map for D11. */
  status?: { origins?: string; operators?: string };
  onGraphql?: (call: number, url: string) => Response | undefined;
  /** Per-origin status answer for a txId GIVEN IN LABEL FORM. */
  onStatus?: (origin: string, label: string) => Response | undefined;
}) {
  const wallet = await testWallet();
  vi.stubEnv('VITE_TRUSTED_OWNERS', wallet.address);
  vi.stubEnv('VITE_INDEX_SOURCES', spec.sources);
  vi.stubEnv('VITE_STATUS_GATEWAYS', spec.status?.origins ?? `${S1},${S2},${S3}`);
  vi.stubEnv('VITE_STATUS_OPERATORS', spec.status?.operators ?? `${S1}=op1,${S2}=op2,${S3}=op3`);

  const labels = new Map<string, EdgeLabel>();
  for (const pages of Object.values(spec.pages)) {
    for (const page of pages) for (const e of page) if (!labels.has(e.txId)) labels.set(e.txId, e);
  }
  const realById = new Map<string, string>();
  const labelById = new Map<string, string>();
  const txs = [];
  for (const [label, e] of labels) {
    const body = label in spec.payloads ? JSON.stringify(spec.payloads[label]) : '{}';
    const tx = await buildSignedTx(body, notesTags({ version: e.version ?? '2', ownerHash: 'oh', noteId: e.noteId }), wallet);
    realById.set(label, tx.txId);
    labelById.set(tx.txId, label);
    txs.push(tx);
  }
  const toEdge = (e: EdgeLabel) => ({
    txId: realById.get(e.txId)!,
    cursor: realById.get(e.txId)!,
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: e.version ?? '2' },
      { name: 'Note-Id', value: e.noteId },
    ],
    height: e.height,
  });
  const pagesByUrl = Object.fromEntries(
    Object.entries(spec.pages).map(([url, pages]) => [url, pages.map(page => page.map(toEdge))]),
  );

  const serve = gatewayFetchMock({
    txs,
    pagesByUrl,
    onGraphql: spec.onGraphql,
    onRaw: (_origin, txId) =>
      labelById.has(txId) && (labelById.get(txId)! in spec.payloads)
        ? undefined
        : new Response('not found', { status: 404 }),
    onStatus: (origin, txId) => spec.onStatus?.(origin, labelById.get(txId) ?? txId),
  });
  const fetchMock = vi.fn(serve);
  vi.stubGlobal('fetch', fetchMock);

  const calls = () => fetchMock.mock.calls.map(c => String(c[0]));
  return {
    id: (label: string) => realById.get(label)!,
    rawCalls: () => calls().filter(u => u.includes('/raw/')).map(u => labelById.get(u.split('/raw/')[1]) ?? u),
    statusCalls: () => calls().filter(u => u.endsWith('/status')).map(u => labelById.get(u.split('/tx/')[1].replace('/status', '')) ?? u),
    graphqlCalls: () => calls().filter(u => u.endsWith('/graphql')),
    known: (...entries: Array<[string, { noteId: string; kind: 'note' | 'safebox' }]>) =>
      new Map(entries.map(([label, rec]) => [realById.get(label) ?? label, rec])),
  };
}

const confirmed = (confirmations: number, blockHeight = 1000) =>
  new Response(JSON.stringify({ block_height: blockHeight, number_of_confirmations: confirmations }), { status: 200 });
const notFound = () => new Response('not found', { status: 404 });

describe('union: a note only one source returned is restored', () => {
  it('fresh by the status quorum → metric, no flag (honest lag)', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'both indexes have it');
    const n2 = await encryptEnvelope(key, 'only A has it');
    const gw = await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }, { txId: 'T2', noteId: n2.noteId, height: 199 }]],
        [SRC_B]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }]],
      },
      payloads: { T1: v2wire(n1), T2: v2wire(n2) },
      onStatus: () => confirmed(3),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes.map(n => n.text).sort()).toEqual(['both indexes have it', 'only A has it']);
    expect(out.incomplete).toBe(false);
    expect(out.indexDiagnostics).toMatchObject({
      presenceDisagreements: 1, metadataConflicts: 0, presenceProbes: 1, presenceAgeProven: 0, presenceBudgetExhausted: false,
      sources: [{ complete: true, transport: SRC_A }, { complete: true, transport: SRC_B }],
    });
    expect(gw.statusCalls()).toEqual(['T2', 'T2', 'T2']);
  });

  it('provably old by ≥2 independent operators → incomplete=true, note still restored', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'both');
    const n2 = await encryptEnvelope(key, 'silenced by B');
    await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }, { txId: 'T2', noteId: n2.noteId, height: 10 }]],
        [SRC_B]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }]],
      },
      payloads: { T1: v2wire(n1), T2: v2wire(n2) },
      onStatus: (origin) => origin === S3 ? notFound() : confirmed(600, origin === S1 ? 5000 : 5003),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes.map(n => n.text).sort()).toEqual(['both', 'silenced by B']);
    expect(out.incomplete).toBe(true);
    expect(out.indexDiagnostics).toMatchObject({ presenceDisagreements: 1, presenceProbes: 1, presenceAgeProven: 1 });
  });

  it('two confirming origins of ONE operator are one voice: no flag; a third operator completes the quorum', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n2 = await encryptEnvelope(key, 'only A');
    const run = async (operators: string, s3: () => Response) => {
      vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
      await stubSources({
        sources: `${SRC_A},${SRC_B}`,
        pages: { [SRC_A]: [[{ txId: 'T2', noteId: n2.noteId, height: 10 }]], [SRC_B]: [[]] },
        payloads: { T2: v2wire(n2) },
        status: { operators },
        onStatus: (origin) => origin === S3 ? s3() : confirmed(600),
      });
      const { fetchAllNotes } = await import('./arweave');
      return fetchAllNotes('oh', ring(key));
    };
    const oneOperator = await run(`${S1}=same,${S2}=same,${S3}=other`, () => notFound());
    expect(oneOperator.incomplete).toBe(false);
    expect(oneOperator.indexDiagnostics?.presenceAgeProven).toBe(0);

    const twoOperators = await run(`${S1}=same,${S2}=same,${S3}=other`, () => confirmed(600));
    expect(twoOperators.incomplete).toBe(true);
    expect(twoOperators.indexDiagnostics?.presenceAgeProven).toBe(1);
  });

  it('the status quorum entirely unavailable: metric, no flag, restore full', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n2 = await encryptEnvelope(key, 'only A');
    await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: { [SRC_A]: [[{ txId: 'T2', noteId: n2.noteId, height: 10 }]], [SRC_B]: [[]] },
      payloads: { T2: v2wire(n2) },
      onStatus: () => new Response('down', { status: 503 }),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes).toHaveLength(1);
    expect(out.incomplete).toBe(false);
    expect(out.indexDiagnostics).toMatchObject({ presenceDisagreements: 1, presenceProbes: 1, presenceAgeProven: 0 });
  });
});

describe('a source that failed mid-walk is not a witness (v16)', () => {
  it('its omission is no disagreement: no probe, no flag from D11 — but the sweep IS incomplete', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'page 1 of both');
    const n2 = await encryptEnvelope(key, 'page 2, A only');
    const gw = await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }], [{ txId: 'T2', noteId: n2.noteId, height: 100 }]],
        [SRC_B]: [[{ txId: 'T1', noteId: n1.noteId, height: 200 }], [{ txId: 'T2', noteId: n2.noteId, height: 100 }]],
      },
      payloads: { T1: v2wire(n1), T2: v2wire(n2) },
      onGraphql: (call, url) => (url === SRC_B && call === 1 ? new Response('boom', { status: 503 }) : undefined),
      onStatus: () => confirmed(600),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes).toHaveLength(2);
    expect(out.incomplete).toBe(true);
    expect(out.indexDiagnostics).toMatchObject({
      presenceDisagreements: 0, presenceProbes: 0,
      sources: [{ complete: true, transport: SRC_A }, { complete: false, transport: SRC_B }],
    });
    expect(gw.statusCalls()).toEqual([]);
  });
});

describe('transport fallback inside one logical source', () => {
  it('primary fails on its first page, fallback reads the source to the end → complete, incomplete=false', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'via fallback');
    await stubSources({
      sources: `${SRC_A}|${SRC_A_FALLBACK},${SRC_B}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 5 }]],
        [SRC_A_FALLBACK]: [[{ txId: 'T1', noteId: n1.noteId, height: 5 }]],
        [SRC_B]: [[{ txId: 'T1', noteId: n1.noteId, height: 5 }]],
      },
      payloads: { T1: v2wire(n1) },
      onGraphql: (_call, url) => (url === SRC_A ? new Response('down', { status: 503 }) : undefined),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes.map(n => n.text)).toEqual(['via fallback']);
    expect(out.incomplete).toBe(false);
    expect(out.indexDiagnostics?.sources).toEqual([{ complete: true, transport: SRC_A_FALLBACK }, { complete: true, transport: SRC_B }]);
  });

  it('primary fails on page 2 → RESTART on the fallback from page 1; pages of the two transports are never mixed', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'genuine');
    const decoy = await encryptEnvelope(key, 'only on the failed primary');
    const gw = await stubSources({
      sources: `${SRC_A}|${SRC_A_FALLBACK}`,
      pages: {
        // The primary's page 1 carries a candidate the fallback never lists;
        // once the primary fails on page 2 that page is DISCARDED with it.
        [SRC_A]: [[{ txId: 'DECOY', noteId: decoy.noteId, height: 9 }], [{ txId: 'T1', noteId: n1.noteId, height: 8 }]],
        [SRC_A_FALLBACK]: [[{ txId: 'T1', noteId: n1.noteId, height: 8 }]],
      },
      payloads: { T1: v2wire(n1), DECOY: v2wire(decoy) },
      onGraphql: (call, url) => (url === SRC_A && call === 1 ? new Response('down', { status: 503 }) : undefined),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes.map(n => n.text)).toEqual(['genuine']);
    expect(out.incomplete).toBe(false);
    expect(gw.rawCalls()).toEqual(['T1']);
    expect(out.indexDiagnostics?.sources).toEqual([{ complete: true, transport: SRC_A_FALLBACK }]);
  });

  it('every transport fails → the LONGEST partial read is kept and the source is incomplete', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'partial but kept');
    await stubSources({
      sources: `${SRC_A}|${SRC_A_FALLBACK}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 8 }], [{ txId: 'T1', noteId: n1.noteId, height: 8 }]],
        [SRC_A_FALLBACK]: [[{ txId: 'T1', noteId: n1.noteId, height: 8 }]],
      },
      payloads: { T1: v2wire(n1) },
      onGraphql: (call, url) => (url === SRC_A && call === 1) || url === SRC_A_FALLBACK ? new Response('down', { status: 503 }) : undefined,
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes.map(n => n.text)).toEqual(['partial but kept']);
    expect(out.incomplete).toBe(true);
    expect(out.indexDiagnostics?.sources).toEqual([{ complete: false, transport: SRC_A }]);
  });
});

describe('ArweaveIndexUnavailableError — only when NOTHING answered a first page', () => {
  it('first page down at every transport of every source → thrown', async () => {
    const key = await noteKey();
    await stubSources({
      sources: `${SRC_A}|${SRC_A_FALLBACK},${SRC_B}`,
      pages: { [SRC_A]: [[]], [SRC_A_FALLBACK]: [[]], [SRC_B]: [[]] },
      payloads: {},
      onGraphql: () => new Response('down', { status: 503 }),
    });
    const { fetchAllNotes, ArweaveIndexUnavailableError } = await import('./arweave');
    await expect(fetchAllNotes('oh', ring(key))).rejects.toBeInstanceOf(ArweaveIndexUnavailableError);
  });

  it('one source answered its first page → no throw; the other source is incomplete', async () => {
    const key = await noteKey();
    await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: { [SRC_A]: [[]], [SRC_B]: [[]] },
      payloads: {},
      onGraphql: (_call, url) => (url === SRC_A ? new Response('down', { status: 503 }) : undefined),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.incomplete).toBe(true);
    expect(out.indexDiagnostics?.sources).toEqual([{ complete: false, transport: null }, { complete: true, transport: SRC_B }]);
  });

  it('an abort during the first page is a cancellation, not an unreachable index', async () => {
    const key = await noteKey();
    const controller = new AbortController();
    await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: { [SRC_A]: [[]], [SRC_B]: [[]] },
      payloads: {},
      onGraphql: () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); },
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key), undefined, { signal: controller.signal });
    expect(out.incomplete).toBe(true);
    expect(out.notes).toEqual([]);
  });
});

describe('sentinels over the ORDERED union', () => {
  it('a known txId claims its Note-Id by height; an older duplicate from the OTHER source is dropped unfetched, whichever source answers first', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const held = await encryptEnvelope(key, 'held locally, newest');
    const older = { ...(await encryptEnvelope(key, 'older duplicate')), noteId: held.noteId };
    const run = async (sources: string) => {
      vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
      const gw = await stubSources({
        sources,
        pages: {
          [SRC_A]: [[{ txId: 'OLDER', noteId: held.noteId, height: 100 }]],
          [SRC_B]: [[{ txId: 'KNOWN', noteId: held.noteId, height: 200 }]],
        },
        payloads: { KNOWN: v2wire(held), OLDER: v2wire(older) },
        onStatus: () => confirmed(3),
      });
      const { fetchAllNotes } = await import('./arweave');
      const out = await fetchAllNotes('oh', ring(key), undefined, { known: gw.known(['KNOWN', { noteId: held.noteId, kind: 'note' }]) });
      return { out, raw: gw.rawCalls() };
    };
    const ab = await run(`${SRC_A},${SRC_B}`);
    expect(ab.raw).toEqual([]);          // the duplicate sits BELOW the sentinel in height order
    expect(ab.out.notes).toEqual([]);    // the sentinel itself is not returned as new
    const ba = await run(`${SRC_B},${SRC_A}`);
    expect(ba.raw).toEqual([]);
    expect(ba.out.notes).toEqual([]);
  });

  it('a metadata conflict makes the candidate UNKNOWN: fetched through the full pipeline, never treated as a sentinel', async () => {
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const n1 = await encryptEnvelope(key, 'genuine');
    const gw = await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: {
        [SRC_A]: [[{ txId: 'T1', noteId: n1.noteId, height: 100 }]],
        [SRC_B]: [[{ txId: 'T1', noteId: 'a-lying-index-said-so', height: 100 }]],
      },
      payloads: { T1: v2wire(n1) },
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key), undefined, { known: gw.known(['T1', { noteId: n1.noteId, kind: 'note' }]) });
    expect(gw.rawCalls()).toEqual(['T1']);              // NOT skipped as known
    expect(out.notes.map(n => n.text)).toEqual(['genuine']); // the verified header, not the edge, attributes it
    expect(out.indexDiagnostics).toMatchObject({ metadataConflicts: 1, presenceDisagreements: 0 });
    expect(out.incomplete).toBe(false);
  });
});

describe('the presence-probe budget', () => {
  it('probes at most MAX_PRESENCE_PROBES_PER_SWEEP disagreements; the rest keep the metric only', async () => {
    const { MAX_PRESENCE_PROBES_PER_SWEEP } = await import('./index-union');
    const key = await noteKey();
    const { encryptEnvelope } = await import('./crypto');
    const count = MAX_PRESENCE_PROBES_PER_SWEEP + 1;
    const notes = await Promise.all(Array.from({ length: count }, (_, i) => encryptEnvelope(key, `note ${i}`)));
    const pageA = notes.map((n, i) => ({ txId: `T${i}`, noteId: n.noteId, height: 1000 - i }));
    const gw = await stubSources({
      sources: `${SRC_A},${SRC_B}`,
      pages: { [SRC_A]: [pageA], [SRC_B]: [[]] },
      payloads: Object.fromEntries(notes.map((n, i) => [`T${i}`, v2wire(n)])),
      onStatus: () => confirmed(600),
    });
    const { fetchAllNotes } = await import('./arweave');
    const out = await fetchAllNotes('oh', ring(key));
    expect(out.notes).toHaveLength(count);
    expect(out.indexDiagnostics).toMatchObject({
      presenceDisagreements: count, presenceProbes: MAX_PRESENCE_PROBES_PER_SWEEP, presenceBudgetExhausted: true,
    });
    expect(new Set(gw.statusCalls()).size).toBe(MAX_PRESENCE_PROBES_PER_SWEEP);
    expect(out.incomplete).toBe(true); // the probed ones proved old
  }, 60_000);
});
