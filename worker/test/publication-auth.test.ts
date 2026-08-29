import { describe, it, expect } from 'vitest';
import { authenticatePublication } from '../src/publication-auth';
// CROSS-HALF IMPORT (deliberate): the signing harness PR-3a built for the
// client's D9 suite. Reusing it is the point — the worker must accept exactly
// the transactions the client accepts, and a second harness would let the two
// drift while both stayed green.
import { buildSignedTx, newWallet, notesTags, testWallet } from '../../src/test-stubs/signed-tx';
import { computePublicationFp } from '../src/publication-fp';

const OWNER_HASH = 'owner-hash-under-test';
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
  header?: unknown | 'timeout' | number;
  raw?: Uint8Array | 'timeout' | number;
}>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const origin = Object.keys(script).find(o => url.startsWith(o));
    if (origin === undefined) return new Response('not found', { status: 404 });
    const entry = script[origin];
    const which = url.includes('/raw/') ? entry.raw : entry.header;
    if (which === undefined) return new Response('not found', { status: 404 });
    if (which === 'timeout') throw new Error('network');
    if (typeof which === 'number') return new Response('nope', { status: which });
    const body = which instanceof Uint8Array ? which : JSON.stringify(which);
    return new Response(body as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
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
  const { impl, calls } = gateways(script);
  return { deps: { origins, trustedOwners, ownerHash: OWNER_HASH, fetchImpl: impl }, calls };
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
