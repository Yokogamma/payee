import { describe, it, expect } from 'vitest';
import {
  isRejection,
  ownerToAddress,
  parseTxHeader,
  readVerifiedTags,
  verifyBytes,
  verifyHeader,
  type TxHeader,
} from './tx-verify';
import { buildSignedTx, newWallet, notesTags, testWallet } from '../test-stubs/signed-tx';
import realTx from '../test-stubs/real-tx.fixture.json';

// A REAL transaction of this project, captured from arweave.net. It is what
// pins the merkle leaf formula and the format-2 deep-hash field order to the
// network rather than to my own reading of the spec: if either drifts, this
// stops verifying.
const REAL_TX_ID = realTx.txId;
const REAL_HEADER = realTx.header as unknown as TxHeader;
const REAL_BYTES = Uint8Array.from(atob(realTx.rawBase64), c => c.charCodeAt(0));
const REAL_OWNER = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';

const SUPPORTED = new Set(['1', '2', '3', '4']);
const OWNER_HASH = 'MpB2bWN6J4loBh1YNK6KcmGZX44UVL2lqXxdqPNujE0=';

describe('D9 against a REAL transaction of this project', () => {
  it('accepts the genuine header and its genuine bytes', async () => {
    expect(await verifyHeader(REAL_TX_ID, REAL_HEADER, [REAL_OWNER])).toBeNull();
    expect(await verifyBytes(REAL_HEADER, REAL_BYTES)).toBeNull();
  });

  it('derives the wallet address from the raw modulus', async () => {
    expect(await ownerToAddress(REAL_HEADER.owner)).toBe(REAL_OWNER);
  });

  it('rejects a single flipped byte of the body on data_root', async () => {
    const tampered = new Uint8Array(REAL_BYTES);
    tampered[tampered.length - 1] ^= 0x01;
    const rejection = await verifyBytes(REAL_HEADER, tampered);
    expect(rejection?.kind).toBe('gateway');
  });

  it('rejects a truncated body on data_size before hashing anything', async () => {
    const rejection = await verifyBytes(REAL_HEADER, REAL_BYTES.slice(0, -1));
    expect(rejection?.reason).toMatch(/data_size/);
  });

  // The owner check is a SKIP, not a gateway failure: every honest gateway
  // returns this same header, so retrying the pool is waste and marking the
  // sweep incomplete would be a lie.
  it('rejects a foreign TRUSTED_OWNERS set as an intentional skip', async () => {
    const rejection = await verifyHeader(REAL_TX_ID, REAL_HEADER, ['A'.repeat(43)]);
    expect(rejection).toEqual({ kind: 'skip', reason: 'owner is not in TRUSTED_OWNERS' });
  });

  it('reads attribution from the SIGNED tags', () => {
    const tags = readVerifiedTags(REAL_HEADER, {
      appName: 'EternalNotes',
      supportedVersions: SUPPORTED,
      ownerHash: OWNER_HASH,
    });
    expect(isRejection(tags)).toBe(false);
    expect(tags).toMatchObject({ noteId: '958bf1f1-2ee1-80e6-b14b-fe6ca608765e', version: '3' });
  });
});

describe('D9 binds the header to the REQUESTED txId (review 3 H1)', () => {
  it('rejects a wholly genuine header+bytes pair for a DIFFERENT txId', async () => {
    // The attack D9 exists to stop: a gateway asked for X answers with a
    // complete, self-consistent, correctly signed transaction Y — a genuine
    // OLDER version of the same note. Signature, owner, tags and data_root all
    // check out; only the binding to the requested id does not.
    const wallet = await testWallet();
    const tags = notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'note-1' });
    const older = await buildSignedTx(JSON.stringify({ id: 'note-1', c: 'AAAA', iv: 'BBBB' }), tags, wallet);
    const newer = await buildSignedTx(JSON.stringify({ id: 'note-1', c: 'CCCC', iv: 'DDDD' }), tags, wallet);
    expect(older.txId).not.toBe(newer.txId);

    // The pair is internally perfect...
    expect(await verifyHeader(older.txId, older.header as unknown as TxHeader, [wallet.address])).toBeNull();
    // ...but it is not what we asked for.
    const rejection = await verifyHeader(newer.txId, older.header as unknown as TxHeader, [wallet.address]);
    expect(rejection).toEqual({
      kind: 'gateway',
      reason: 'header.id does not match the requested txId',
    });
  });

  it('rejects a non-canonical txId without touching crypto', async () => {
    const rejection = await verifyHeader('too-short', REAL_HEADER, [REAL_OWNER]);
    expect(rejection?.kind).toBe('skip');
  });

  it('rejects a header whose id is not the hash of its own signature', async () => {
    const forged = { ...REAL_HEADER, signature: REAL_HEADER.signature.slice(0, -4) + 'AAAA' };
    const rejection = await verifyHeader(REAL_TX_ID, forged, [REAL_OWNER]);
    expect(rejection).toEqual({
      kind: 'gateway',
      reason: 'header.id is not the hash of its own signature',
    });
  });
});

describe('D9 step 5 — a correctly signed ATTACKER transaction (review 11)', () => {
  it('is rejected on TRUSTED_OWNERS, with id/signature/data_root all valid', async () => {
    const attacker = await newWallet();
    const trusted = await testWallet();
    const tx = await buildSignedTx(
      JSON.stringify({ id: 'note-x', c: 'AAAA', iv: 'BBBB' }),
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'note-x' }),
      attacker,
    );
    const header = tx.header as unknown as TxHeader;

    // Everything the attacker CAN control is perfect: signed by their own
    // wallet, id derived from that signature, data_root over the real bytes.
    expect(await verifyBytes(header, tx.bytes)).toBeNull();
    expect(await verifyHeader(tx.txId, header, [attacker.address])).toBeNull();

    // Against the real trust set it stops at step 5 — and as a SKIP, so the
    // sweep is not marked incomplete and no Note-Id is claimed.
    const rejection = await verifyHeader(tx.txId, header, [trusted.address]);
    expect(rejection).toEqual({ kind: 'skip', reason: 'owner is not in TRUSTED_OWNERS' });
  });
});

describe('salt policy — 0 / 32 / max, as the Arweave client itself accepts', () => {
  // arweave-js in NODE signs with the MAXIMUM PSS salt, while the Worker's
  // WebCrypto driver uses 32. Both are valid on-chain; a verifier that accepted
  // only one of them would be stricter than the network and would make
  // legitimate transactions permanently unrestorable.
  it('accepts a max-salt signature (arweave-js node driver)', async () => {
    const wallet = await testWallet();
    const tx = await buildSignedTx('{"id":"n","c":"A","iv":"B"}',
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'n' }), wallet);
    expect(await verifyHeader(tx.txId, tx.header as unknown as TxHeader, [wallet.address])).toBeNull();
  });

  it('accepts the salt-32 signature of a real Worker-signed transaction', async () => {
    // REAL_HEADER is Worker-signed: this is the salt-32 branch.
    expect(await verifyHeader(REAL_TX_ID, REAL_HEADER, [REAL_OWNER])).toBeNull();
  });
});

describe('parseTxHeader — schema, ceiling, format', () => {
  const raw = JSON.stringify(realTx.header);

  it('accepts the real header', () => {
    expect(parseTxHeader(raw)).not.toBeNull();
  });

  it('rejects a body over the 64 KiB ceiling', () => {
    expect(parseTxHeader(raw + ' '.repeat(65536))).toBeNull();
  });

  it('rejects format ≠ 2 (the writer never produced format 1)', () => {
    expect(parseTxHeader(JSON.stringify({ ...realTx.header, format: 1 }))).toBeNull();
  });

  it('rejects malformed JSON, non-objects and missing fields', () => {
    expect(parseTxHeader('{')).toBeNull();
    expect(parseTxHeader('[]')).toBeNull();
    expect(parseTxHeader('null')).toBeNull();
    const withoutSignature: Record<string, unknown> = { ...realTx.header };
    delete withoutSignature.signature;
    expect(parseTxHeader(JSON.stringify({ ...withoutSignature, format: 2 }))).toBeNull();
  });

  it('rejects a non-numeric data_size and non-base64url fields', () => {
    expect(parseTxHeader(JSON.stringify({ ...realTx.header, data_size: '12abc' }))).toBeNull();
    expect(parseTxHeader(JSON.stringify({ ...realTx.header, owner: 'not base64url!' }))).toBeNull();
  });

  it('rejects malformed tag structures', () => {
    expect(parseTxHeader(JSON.stringify({ ...realTx.header, tags: [{ name: 1, value: 'x' }] }))).toBeNull();
    expect(parseTxHeader(JSON.stringify({ ...realTx.header, tags: 'nope' }))).toBeNull();
  });
});

describe('readVerifiedTags — the writer canon, mirrored exactly (R19)', () => {
  const base = { appName: 'EternalNotes', supportedVersions: SUPPORTED, ownerHash: OWNER_HASH };
  const headerWith = (tags: { name: string; value: string }[]): TxHeader => ({
    ...REAL_HEADER,
    tags: tags.map(t => ({
      name: btoa(t.name).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      value: btoa(t.value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    })),
  });

  it('accepts exactly 5 tags for v2–v4', () => {
    const tags = readVerifiedTags(headerWith(notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'n1' })), base);
    expect(tags).toMatchObject({ noteId: 'n1', version: '3' });
  });

  it('accepts exactly 6 tags for v1, including Timestamp', () => {
    const tags = readVerifiedTags(headerWith([
      ...notesTags({ version: '1', ownerHash: OWNER_HASH, noteId: 'n1' }),
      { name: 'Timestamp', value: '1700000000000' },
    ]), base);
    expect(tags).toMatchObject({ noteId: 'n1', version: '1', timestamp: '1700000000000' });
  });

  it('rejects Timestamp on v2–v4 — the upload path rejects it too', () => {
    const result = readVerifiedTags(headerWith([
      ...notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'n1' }),
      { name: 'Timestamp', value: '1700000000000' },
    ]), base);
    expect(isRejection(result)).toBe(true);
  });

  it('rejects an extra tag, a missing tag and a duplicate tag', () => {
    const five = notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'n1' });
    expect(isRejection(readVerifiedTags(headerWith([...five, { name: 'X', value: 'y' }]), base))).toBe(true);
    expect(isRejection(readVerifiedTags(headerWith(five.slice(1)), base))).toBe(true);
    expect(isRejection(readVerifiedTags(headerWith([...five.slice(1), five[0], five[0]]), base))).toBe(true);
  });

  it('rejects a foreign App-Name, Content-Type, App-Version and Owner-Hash', () => {
    const mk = (over: Partial<Record<string, string>>) => headerWith(
      notesTags({ version: '3', ownerHash: OWNER_HASH, noteId: 'n1' })
        .map(t => (over[t.name] !== undefined ? { ...t, value: over[t.name]! } : t)),
    );
    expect(isRejection(readVerifiedTags(mk({ 'App-Name': 'OtherApp' }), base))).toBe(true);
    expect(isRejection(readVerifiedTags(mk({ 'Content-Type': 'text/plain' }), base))).toBe(true);
    expect(isRejection(readVerifiedTags(mk({ 'App-Version': '9' }), base))).toBe(true);
    // Owner-Hash of ANOTHER vault: cryptographically sound, but not ours.
    expect(isRejection(readVerifiedTags(mk({ 'Owner-Hash': 'someone-else=' }), base))).toBe(true);
  });

  it('every tag rejection is a SKIP, never a gateway failure', () => {
    const result = readVerifiedTags(headerWith([{ name: 'App-Version', value: '3' }]), base);
    expect(isRejection(result) && result.kind).toBe('skip');
  });
});
