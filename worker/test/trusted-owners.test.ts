import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import Arweave from 'arweave';
import worker, { resolveTrustedOwners, walletTrust } from '../src/index';
import { setupOutboundMock, b64, sha256 } from './helpers/outbound-mock';
import { addressOfJwk } from '../test-stubs/wallet-address';
import { TEST_ARWEAVE_JWK, TEST_WALLET_ADDRESS } from '../test-stubs/test-wallet.mjs';

type Env = Parameters<typeof resolveTrustedOwners>[0];

const baseEnv = env as unknown as Env;
const withEnv = (extra: Record<string, unknown>) => ({ ...baseEnv, ...extra }) as unknown as Env;

const A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE';
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('resolveTrustedOwners — fail-closed by construction', () => {
  it('parses a well-formed list, de-duplicated', () => {
    expect(resolveTrustedOwners(withEnv({ TRUSTED_OWNERS: `${A},${B},${A}` }))).toEqual([A, B]);
  });

  it('tolerates surrounding whitespace, which operators paste in', () => {
    expect(resolveTrustedOwners(withEnv({ TRUSTED_OWNERS: ` ${A} , ${B} ` }))).toEqual([A, B]);
  });

  for (const [label, value] of [
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a non-string', 42],
  ] as const) {
    it(`returns null for ${label} — an absent list is a missing root of trust, not "no constraint"`, () => {
      expect(resolveTrustedOwners(withEnv({ TRUSTED_OWNERS: value }))).toBeNull();
    });
  }

  it('returns null when ANY entry is malformed, rather than keeping the good ones', () => {
    // Dropping the bad entry would leave a set that looks fine and is quietly
    // narrower — and a narrower set turns healthy old publications into
    // conflicts.
    expect(resolveTrustedOwners(withEnv({ TRUSTED_OWNERS: `${A},not-an-address` }))).toBeNull();
  });

  it('a too-short address is malformed, not a prefix to be matched', () => {
    expect(resolveTrustedOwners(withEnv({ TRUSTED_OWNERS: A.slice(0, 20) }))).toBeNull();
  });
});

describe('walletTrust — three states, and only one of them refuses', () => {
  it('«trusted» when the signing wallet is in the set', async () => {
    expect(await walletTrust(withEnv({}), [TEST_WALLET_ADDRESS])).toBe('trusted');
  });

  it('«untrusted» when it is not — this is what stops an unverifiable publication', async () => {
    expect(await walletTrust(withEnv({}), [A])).toBe('untrusted');
  });

  it('«undeterminable» for a JWK with no modulus — it cannot sign either', async () => {
    // Deliberately NOT «untrusted»: a key that cannot derive an address cannot
    // create a transaction, so this guard has nothing to protect against, and
    // the malformed-JWK paths keep their own typed 502/`arweave_throw`.
    expect(await walletTrust(withEnv({ ARWEAVE_JWK: '{}' }), [A])).toBe('undeterminable');
    expect(await walletTrust(withEnv({ ARWEAVE_JWK: 'not json' }), [A])).toBe('undeterminable');
  });

  it('re-derives when the JWK changes — the cache is keyed, not merely warm', async () => {
    // The address used to feed a diagnostic endpoint, where staleness was only
    // confusing. It now decides whether /upload may sign at all, so a cache
    // that ignored which key it derived from would clear the trust check for a
    // key that was never checked.
    const other = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const otherJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', other.privateKey));
    const otherAddress = await addressOfJwk(otherJwk);
    expect(otherAddress).not.toBe(TEST_WALLET_ADDRESS);

    // Warm the cache on the default wallet, then switch keys.
    expect(await walletTrust(withEnv({}), [TEST_WALLET_ADDRESS])).toBe('trusted');
    expect(await walletTrust(withEnv({ ARWEAVE_JWK: otherJwk }), [TEST_WALLET_ADDRESS]))
      .toBe('untrusted');
    expect(await walletTrust(withEnv({ ARWEAVE_JWK: otherJwk }), [otherAddress])).toBe('trusted');
    // …and back, so the switch is not one-way.
    expect(await walletTrust(withEnv({}), [TEST_WALLET_ADDRESS])).toBe('trusted');
  });
});

describe('the test fixture derives addresses the way Arweave does', () => {
  // The fixture computes base64url(SHA-256(decode(n))) by hand so it works in
  // a config file and inside workerd. If the SDK ever disagreed, every upload
  // test would start answering 503 for an unrelated reason.
  const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

  it('matches jwkToAddress for the bindings wallet', async () => {
    const viaSdk = await arweave.wallets.jwkToAddress(JSON.parse(TEST_ARWEAVE_JWK));
    expect(viaSdk).toBe(TEST_WALLET_ADDRESS);
    expect(await addressOfJwk(TEST_ARWEAVE_JWK)).toBe(TEST_WALLET_ADDRESS);
  });

  it('matches it for a freshly generated wallet too', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    expect(await addressOfJwk(jwk)).toBe(await arweave.wallets.jwkToAddress(JSON.parse(jwk)));
  });
});

// ─── The guard where it actually bites: /upload ──────────────────────

// No routes registered: any Arweave call would surface as 502, so a 503 below
// is the config refusal and nothing else.
setupOutboundMock();

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

async function allowedIdentity() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

/** App-Version 3 requires a UUIDv8 Note-Id — a v4 is refused at 400, which
 *  would make the positive control below prove nothing. */
function uuidV8(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function signedUpload(id: Awaited<ReturnType<typeof allowedIdentity>>): Promise<Request> {
  const noteId = uuidV8();
  const body = JSON.stringify({
    // 16 bytes: the GCM tag floor. A shorter ciphertext is refused by payload
    // validation (400) before the Arweave path, which would make the positive
    // control below prove nothing.
    data: JSON.stringify({ id: noteId, c: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA' }),
    tags: [
      { name: 'App-Name', value: 'EternalNotes' },
      { name: 'App-Version', value: '3' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Owner-Hash', value: id.ownerHash },
      { name: 'Note-Id', value: noteId },
    ],
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': id.pkB64,
      'X-Signature': sig,
      'CF-Connecting-IP': `to-${crypto.randomUUID().slice(0, 8)}`,
    },
    body,
  });
}

describe('/upload refuses while the trust configuration is unusable', () => {
  it('503s with no TRUSTED_OWNERS — D9 would have no root of trust', async () => {
    const id = await allowedIdentity();
    const r = await worker.fetch(await signedUpload(id), withEnv({ TRUSTED_OWNERS: undefined }));
    expect(r.status).toBe(503);
  });

  it('503s on a malformed list rather than using the entries that parsed', async () => {
    const id = await allowedIdentity();
    const r = await worker.fetch(
      await signedUpload(id),
      withEnv({ TRUSTED_OWNERS: `${TEST_WALLET_ADDRESS},not-an-address` }),
    );
    expect(r.status).toBe(503);
  });

  it('503s when the SIGNING wallet is outside the set', async () => {
    // The transaction this request would create is one neither half could ever
    // authenticate: the money is spent and the record is unverifiable forever.
    // Refusing is strictly better than posting it.
    const id = await allowedIdentity();
    const r = await worker.fetch(await signedUpload(id), withEnv({ TRUSTED_OWNERS: A }));
    expect(r.status).toBe(503);
  });

  it('gets PAST the guard when wallet and set agree (502 at the absent Arweave stub)', async () => {
    // The positive control: without it every assertion above would also pass
    // for a worker that answers 503 to everything.
    const id = await allowedIdentity();
    const r = await worker.fetch(
      await signedUpload(id),
      withEnv({ TRUSTED_OWNERS: `${A},${TEST_WALLET_ADDRESS}` }),
    );
    expect(r.status).toBe(502);
  });
});
