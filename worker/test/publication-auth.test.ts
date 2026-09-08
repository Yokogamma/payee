import { beforeAll, describe, it, expect } from 'vitest';
import { authenticatePublication } from '../src/publication-auth';
// CROSS-HALF IMPORT (deliberate): the signing harness PR-3a built for the
// client's D9 suite. Reusing it is the point — the worker must accept exactly
// the transactions the client accepts, and a second harness would let the two
// drift while both stayed green.
import { buildSignedTx, newWallet, notesTags, testWallet } from '../../src/test-stubs/signed-tx';
import { computePublicationFp } from '../src/publication-fp';
import { assertSupportedRedirect } from './helpers/outbound-mock';

const OWNER_HASH = 'owner-hash-under-test';

// RSA-4096 keygen for the harness wallets runs ONCE per process and is paid by
// whichever test asks first — under CPU contention (a parallel client suite)
// that first test blew the default 5 s timeout. Pay it here, explicitly, with
// a budget that says what it is.
beforeAll(async () => { await testWallet(); await newWallet(); }, 60_000);
const NOTE_ID = '77777777-2222-8333-8444-555555555555';
const G1 = 'https://g1.test';
const G2 = 'https://g2.test';

const payload = (id = NOTE_ID) => JSON.stringify({ id, c: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA' });

/**
 * A fetch stub driven by a per-origin script. Each origin maps to a handler for
 * `/tx/<id>` and `/raw/<id>`; anything unscripted is a 404, which is what a
 * gateway that does not have the transaction actually answers.
 */
function gateways(script: Record<string, {
  header?: unknown | 'timeout' | 'network' | number;
  raw?: Uint8Array | 'timeout' | 'network' | number;
}>) {
  const calls: string[] = [];
  const redirects: (RequestRedirect | undefined)[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The stub refuses what workerd refuses. Without this the suite stayed
    // green on a `redirect` value the runtime rejects before any I/O.
    redirects.push(assertSupportedRedirect(input, init));
    const url = String(input);
    calls.push(url);
    const origin = Object.keys(script).find(o => url.startsWith(o));
    if (origin === undefined) return new Response('not found', { status: 404 });
    const entry = script[origin];
    const which = url.includes('/raw/') ? entry.raw : entry.header;
    if (which === undefined) return new Response('not found', { status: 404 });
    // A deadline and a dead socket are DIFFERENT gateway failures, and the
    // metrics must be able to tell them apart: `classifyThrow` keys on the
    // error's name, so the stub raises the names the runtime actually raises.
    if (which === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (which === 'network') throw new Error('connection reset');
    if (typeof which === 'number') return new Response('nope', { status: which });
    const body = which instanceof Uint8Array ? which : JSON.stringify(which);
    return new Response(body as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls, redirects };
}

async function ourTx(version = '3', data = payload()) {
  const wallet = await testWallet();
  const tx = await buildSignedTx(data, notesTags({ version, ownerHash: OWNER_HASH, noteId: NOTE_ID }), wallet);
  return { tx, wallet, data };
}

const deps = (
  script: Parameters<typeof gateways>[0],
  trustedOwners: readonly string[],
  origins: readonly string[] = [G1, G2],
) => {
  const { impl, calls, redirects } = gateways(script);
  return {
    deps: { origins, trustedOwners, ownerHash: OWNER_HASH, expectedNoteId: NOTE_ID, fetchImpl: impl },
    calls,
    redirects,
  };
};

describe('a genuine publication of ours', () => {
  it('authenticates and reports the fingerprint of the published bytes', async () => {
    const { tx, wallet, data } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);

    const verdict = await authenticatePublication(tx.txId, d);

    expect(verdict.kind).toBe('authenticated');
    if (verdict.kind !== 'authenticated') return;
    expect(verdict.noteId).toBe(NOTE_ID);
    expect(verdict.appVersion).toBe('3');
    expect(verdict.data).toBe(data);
    // The fingerprint is computed over what was ACTUALLY published, not over
    // what the caller believes it published — that is the whole point.
    expect(verdict.observedFp).toBe(await computePublicationFp('3', data));
  });

  it('takes the header from one gateway and the bytes from another', async () => {
    // Safe by construction: the header is bound to the id by the signature, and
    // the bytes to the header by data_root.
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps(
      { [G1]: { header: tx.header }, [G2]: { raw: tx.bytes } },
      [wallet.address],
    );
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('authenticated');
  });

  it('tries origins in the configured ORDER', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d, calls } = deps({ [G2]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    await authenticatePublication(tx.txId, d);
    expect(calls[0]).toBe(`${G1}/tx/${tx.txId}`); // asked first, missed
    expect(calls[1]).toBe(`${G2}/tx/${tx.txId}`);
  });

  it('authenticates a v4 safebox publication too', async () => {
    const wallet = await testWallet();
    const data = JSON.stringify({ id: NOTE_ID, mc: 'AAAA', miv: 'AAAA', sc: 'AAAA', siv: 'AAAA' });
    const tx = await buildSignedTx(data, notesTags({ version: '4', ownerHash: OWNER_HASH, noteId: NOTE_ID }), wallet);
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);

    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('authenticated');
    if (verdict.kind === 'authenticated') expect(verdict.appVersion).toBe('4');
  });
});

describe('«not ours» — sound, and none of our business', () => {
  it('a transaction signed by an UNTRUSTED wallet', async () => {
    // The precise failure the historical owner list exists to prevent in
    // reverse: an attacker posting their own well-formed transaction.
    const stranger = await newWallet();
    const tx = await buildSignedTx(
      payload(), notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID }), stranger,
    );
    const trusted = await testWallet();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [trusted.address]);

    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('not-ours');
  });

  it('stops the pool instead of asking every other gateway', async () => {
    // Every honest gateway would return the same bytes, so continuing is waste.
    const stranger = await newWallet();
    const tx = await buildSignedTx(
      payload(), notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID }), stranger,
    );
    const trusted = await testWallet();
    const { deps: d, calls } = deps(
      { [G1]: { header: tx.header, raw: tx.bytes }, [G2]: { header: tx.header, raw: tx.bytes } },
      [trusted.address],
    );
    await authenticatePublication(tx.txId, d);
    expect(calls.filter(c => c.includes('/tx/'))).toHaveLength(1);
  });

  it('an Owner-Hash belonging to ANOTHER vault', async () => {
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      payload(), notesTags({ version: '3', ownerHash: 'someone-elses-vault', noteId: NOTE_ID }), wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('not-ours');
  });

  it('a foreign App-Name', async () => {
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      payload(),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID, appName: 'SomeoneElse' }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('not-ours');
  });

  it('a real publication of OURS, but for a DIFFERENT note', async () => {
    // Same vault, same wallet, so every other D9 step passes. Without this
    // check the fingerprint of note Y's bytes would be written onto note X's
    // record, and every later request for X would conflict against it —
    // a healthy note quarantined forever by a mismatched pointer.
    const wallet = await testWallet();
    const otherId = '11111111-2222-8333-8444-555555555555';
    const tx = await buildSignedTx(
      payload(otherId),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: otherId }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('not-ours');
    if (verdict.kind === 'not-ours') expect(verdict.reason).toMatch(/not 77777777/);
  });

  it('an INNER id disagreeing with the signed Note-Id tag', async () => {
    // The upload path requires the two to agree of anything it accepts; a
    // publication where they diverge is not a fingerprintable answer.
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      payload('11111111-2222-8333-8444-555555555555'), // inner id ≠ tag
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('not-ours');
    if (verdict.kind === 'not-ours') expect(verdict.reason).toMatch(/inner id/);
  });

  it('a txId that cannot name a transaction at all — decided without a request', async () => {
    const { deps: d, calls } = deps({}, ['x'.repeat(43)]);
    const verdict = await authenticatePublication('too-short', d);
    expect(verdict.kind).toBe('not-ours');
    expect(calls).toEqual([]);
  });

  it('a proven body that the current canonicalization cannot read', async () => {
    // The bytes are PROVEN to be this transaction's, so this is not a gateway
    // fault. Returning the txId as a success would bind a fingerprint to a
    // publication whose shape we do not understand.
    const wallet = await testWallet();
    const tx = await buildSignedTx(
      new Uint8Array([0xff, 0xfe, 0xfd]),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);
    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('not-ours');
  });
});

describe('«unproven» — a transport failure is never a verdict', () => {
  it('no gateway has the transaction', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({}, [wallet.address]);
    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('unproven');
  });

  it('every gateway throws', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps(
      { [G1]: { header: 'timeout', raw: 'timeout' }, [G2]: { header: 'timeout', raw: 'timeout' } },
      [wallet.address],
    );
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('unproven');
  });

  it('a gateway answers a request for X with a self-consistent header for Y', async () => {
    // The classic substitution: internally valid, wrong transaction. It must
    // not end the search at Y — and the NEXT gateway's correct answer wins.
    const { tx, wallet } = await ourTx();
    const other = await buildSignedTx(
      payload('11111111-2222-8333-8444-555555555555'),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: '11111111-2222-8333-8444-555555555555' }),
      wallet,
    );
    const { deps: d } = deps(
      { [G1]: { header: other.header }, [G2]: { header: tx.header, raw: tx.bytes } },
      [wallet.address],
    );
    const verdict = await authenticatePublication(tx.txId, d);
    expect(verdict.kind).toBe('authenticated');
    if (verdict.kind === 'authenticated') expect(verdict.noteId).toBe(NOTE_ID);
  });

  it('a lone gateway serving a substituted header proves nothing', async () => {
    const { tx, wallet } = await ourTx();
    const other = await buildSignedTx(
      payload('11111111-2222-8333-8444-555555555555'),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: '11111111-2222-8333-8444-555555555555' }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: other.header } }, [wallet.address], [G1]);
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('unproven');
  });

  it('bytes that do not hash to the header are refused, and a later gateway saves it', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps(
      {
        [G1]: { header: tx.header, raw: new TextEncoder().encode('tampered') },
        [G2]: { raw: tx.bytes },
      },
      [wallet.address],
    );
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('authenticated');
  });

  it('tampered bytes ALONE are unproven, never accepted', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps(
      { [G1]: { header: tx.header, raw: new TextEncoder().encode('tampered') } },
      [wallet.address], [G1],
    );
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('unproven');
  });

  it('a malformed header body is a gateway fault, not a verdict', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: { nonsense: true } } }, [wallet.address], [G1]);
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('unproven');
  });

  it('an empty trusted-owner set proves nothing rather than accepting anything', async () => {
    const { tx } = await ourTx();
    const { deps: d, calls } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, []);
    expect((await authenticatePublication(tx.txId, d)).kind).toBe('unproven');
    expect(calls).toEqual([]);
  });
});

describe('the body reader refuses oversize BEFORE reading it all', () => {
  it('an over-cap /raw with no Content-Length is refused, and the stream is cancelled', async () => {
    // `arrayBuffer()`-then-check would read the whole body first; a hostile
    // gateway could hand the isolate hundreds of megabytes before the check
    // ever ran. This stub yields chunks forever and counts how many were
    // pulled: a streaming reader stops within a few chunks of the cap.
    const { tx, wallet } = await ourTx();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(65_536)); },
    });
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/raw/')) return new Response(endless, { status: 200 }); // no Content-Length
      return new Response(JSON.stringify(tx.header), { status: 200 });
    }) as unknown as typeof fetch;

    const verdict = await authenticatePublication(tx.txId, {
      origins: [G1], trustedOwners: [wallet.address], ownerHash: OWNER_HASH,
      expectedNoteId: NOTE_ID, fetchImpl: impl,
    });

    expect(verdict.kind).toBe('unproven');
    // 262 144-byte cap → crossed on the 5th 64 KiB chunk. Anything near that is
    // streaming; a full read would never return at all.
    expect(pulled).toBeLessThanOrEqual(8);
  });

  it('a Content-Length above the cap is refused without reading a byte', async () => {
    const { tx, wallet } = await ourTx();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(1)); },
    });
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/raw/')) {
        return new Response(body, { status: 200, headers: { 'Content-Length': String(10 * 1024 * 1024) } });
      }
      return new Response(JSON.stringify(tx.header), { status: 200 });
    }) as unknown as typeof fetch;

    await authenticatePublication(tx.txId, {
      origins: [G1], trustedOwners: [wallet.address], ownerHash: OWNER_HASH,
      expectedNoteId: NOTE_ID, fetchImpl: impl,
    });
    // At most the ONE pull the stream performs on construction to fill its
    // queue — none from the reader, which never touched the body.
    expect(pulled).toBeLessThanOrEqual(1);
  });
});

/**
 * The redirect mode is part of the proof's transport contract, and the runtime
 * has an opinion about it that a mock cannot soften.
 *
 * History: `redirect: 'error'` shipped here. workerd rejects the VALUE with a
 * TypeError while parsing init — before any I/O — so every gateway read became
 * an instant miss, D9 never completed, and every legacy record answered 503
 * `legacy_unproven`. The suites stayed green because the stubs ignored `init`
 * entirely. These tests pin BOTH halves: the stub refuses what the runtime
 * refuses, and the call site passes the mode that actually works.
 */
describe('redirect mode', () => {
  it('the stub refuses `error`, exactly as workerd does', async () => {
    const { tx, wallet } = await ourTx();
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assertSupportedRedirect(input, init);
      return new Response(JSON.stringify(tx.header), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(impl(`${G1}/tx/${tx.txId}`, { redirect: 'error' }))
      .rejects.toThrow(/Invalid redirect value/);
    await expect(impl(`${G1}/tx/${tx.txId}`, { redirect: 'manual' })).resolves.toBeInstanceOf(Response);
    void wallet;
  });

  it('`init` wins over the Request it is given — a bare Request says `follow`', async () => {
    // The failing call looked like `fetch(new Request(url), { redirect: 'error' })`
    // and a guard reading the Request first would have seen `follow` and passed.
    expect(() => assertSupportedRedirect(new Request('https://g1.test/tx/x'), { redirect: 'error' }))
      .toThrow(/Invalid redirect value/);
    expect(assertSupportedRedirect(new Request('https://g1.test/tx/x'))).toBe('follow');
    expect(assertSupportedRedirect('https://g1.test/tx/x')).toBeUndefined();
    expect(assertSupportedRedirect('https://g1.test/tx/x', { redirect: 'manual' })).toBe('manual');
  });

  it('every D9 read asks for `manual` — not `follow`, which would pool two hosts as one', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d, redirects } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address]);

    const verdict = await authenticatePublication(tx.txId, d);

    expect(verdict.kind).toBe('authenticated');
    expect(redirects.length).toBeGreaterThan(0);          // header AND raw
    expect(redirects.every(r => r === 'manual')).toBe(true);
  });

  it('a 3xx is a MISS, never a proof: the pool moves on and the verdict stays unproven', async () => {
    const { tx, wallet } = await ourTx();
    // Both origins answer 302. `manual` hands those back as responses, so the
    // reader must refuse them by status rather than by an exception.
    const { deps: d } = deps(
      { [G1]: { header: 302, raw: 302 }, [G2]: { header: 302, raw: 302 } },
      [wallet.address],
    );

    const verdict = await authenticatePublication(tx.txId, d);

    expect(verdict.kind).toBe('unproven');
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/no gateway produced a verifiable header/) });
  });

  it('a 3xx on /raw alone leaves the header proven and the BYTES unproven', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: 302 } }, [wallet.address], [G1]);

    const verdict = await authenticatePublication(tx.txId, d);

    expect(verdict.kind).toBe('unproven');
    expect(verdict).toMatchObject({ reason: expect.stringMatching(/no gateway produced bytes matching the header/) });
  });
});

/**
 * Per-origin telemetry — the half that did not exist.
 *
 * `onOrigin` was declared from the first day and passed by nobody, and what it
 * could have said was too coarse anyway: a thrown fetch, a 404, a 500 and an
 * oversized body all collapsed into one `miss`. So `legacy_unproven` meant
 * «the proof did not complete» and nothing else — an outage, a dropped
 * transaction and a worker unable to issue a request at all were one row. It
 * took a full soak window to tell them apart by hand.
 */
describe('per-origin telemetry', () => {
  const record = () => {
    const rows: { origin: string; stage: string; outcome: string; ms: number }[] = [];
    return {
      rows,
      onOrigin: (origin: string, stage: string, outcome: string, ms: number) =>
        void rows.push({ origin, stage, outcome, ms }),
    };
  };

  it('names the STAGE: a header miss and a bytes miss are different failures', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: 404 } }, [wallet.address], [G1]);
    const { rows, onOrigin } = record();

    await authenticatePublication(tx.txId, { ...d, onOrigin });

    expect(rows).toEqual([
      { origin: G1, stage: 'header', outcome: 'ok', ms: expect.any(Number) },
      { origin: G1, stage: 'raw', outcome: '404', ms: expect.any(Number) },
    ]);
  });

  it.each([
    ['a deadline', 'timeout' as const, 'timeout'],
    ['a dead socket', 'network' as const, 'network'],
    ['a redirect', 302, 'network'],   // 3xx is not a valid gateway answer
    ['not found', 404, '404'],
    ['a broken gateway', 503, '5xx'],
    ['a refusal', 429, '4xx'],
  ])('names WHY the header read failed: %s', async (_label, answer, expected) => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: answer } }, [wallet.address], [G1]);
    const { rows, onOrigin } = record();

    const verdict = await authenticatePublication(tx.txId, { ...d, onOrigin });

    expect(verdict.kind).toBe('unproven');
    expect(rows).toEqual([{ origin: G1, stage: 'header', outcome: expected, ms: expect.any(Number) }]);
  });

  it('separates «served something unusable» from «served nothing»', async () => {
    // A 200 whose bytes do not hash to the header's data_root is a MISMATCH,
    // not a miss: the gateway answered, and the answer failed the proof.
    const { tx, wallet } = await ourTx();
    const other = await buildSignedTx(
      payload('99999999-2222-8333-8444-555555555555'),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: NOTE_ID }),
      wallet,
    );
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: other.bytes } }, [wallet.address], [G1]);
    const { rows, onOrigin } = record();

    const verdict = await authenticatePublication(tx.txId, { ...d, onOrigin });

    expect(verdict.kind).toBe('unproven');
    expect(rows.map(r => `${r.stage}:${r.outcome}`)).toEqual(['header:ok', 'raw:mismatch']);
  });

  it('reports a duration for every read', async () => {
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address], [G1]);
    const { rows, onOrigin } = record();

    await authenticatePublication(tx.txId, { ...d, onOrigin });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Number.isFinite(row.ms)).toBe(true);
      expect(row.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('a THROWING hook does not turn a completed proof into a failure', async () => {
    // The hook comes from the caller. A metric that can break the request is
    // worse than no metric — and this module cannot assume the adapter is sane.
    const { tx, wallet } = await ourTx();
    const { deps: d } = deps({ [G1]: { header: tx.header, raw: tx.bytes } }, [wallet.address], [G1]);

    const verdict = await authenticatePublication(tx.txId, {
      ...d,
      onOrigin: () => { throw new Error('metrics backend is down'); },
    });

    expect(verdict.kind).toBe('authenticated');
  });
});
