import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { deriveSigningKeypair, deriveOwnerHash, signPayload, bufferToBase64 } from './crypto';

/**
 * PINNED bytes of the signing domain (seed phrase → Ed25519 keypair → owner
 * hash → signature).
 *
 * `crypto.test.ts` proves the derivation is REPEATABLE, and the worker's
 * client-parity test proves the worker ACCEPTS what this wrapper signs — but
 * both stay green if a dependency bump changed every key: a fresh key
 * re-derives the same way twice and is registered just before it is checked.
 * A changed public key is not a harmless refactor here. The worker's allowlist,
 * the invite records and every published note are bound to the owner hash
 * derived from it, so a user restoring by seed phrase would come back as a
 * stranger to their own data.
 *
 * Ed25519 is deterministic (RFC 8032), so the expected values are exact bytes.
 * They were computed before the @noble/ed25519 3.1 → 3.2 bump (Dependabot
 * triage 2026-09-18) and must NEVER be regenerated to make a failing run pass:
 * a mismatch means the derivation changed, and that is the finding.
 */

const VECTORS = [
  {
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    publicKey: 'kTaDSnuCTzUC81qpfQxPMTX9SQkxSB9ea6SCGrg/aMA=',
    ownerHash: 'VdgVkmIJ08CGsstG1Lm5QsYQmba178KrNtnYTzaA50Q=',
  },
  {
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    publicKey: 'ry+CuLfqGAo7gFBih2nRzegeIVA1QWpc81DDoE+SaUA=',
    ownerHash: 'C0wJd9WXdrVXBp/AvNMAn++1j77dXUfnFYnqLkA0iCE=',
  },
  {
    mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    publicKey: '5iGe/uvtSkFhIFhuJN7SpWKIB0YzGisSHk3uoZ2+oDw=',
    ownerHash: 'hm+eDU807beTWDZGa+JpktvvJJNi1ulkJ2xk2wVvPNM=',
  },
] as const;

// The exact body the client signs for /check-registration, with a FIXED
// timestamp: key order and spacing are part of the signed bytes.
const SIGNED_BODY = '{"publicKey":"kTaDSnuCTzUC81qpfQxPMTX9SQkxSB9ea6SCGrg/aMA=","timestamp":1700000000000}';
const SIGNATURE = 'GfVOOKXMj/BsbEN/gKAw7qUWyNfUxKiHDQOWvEDUdBltIe2HypcYcDvk+aT1fo+eHlYJcIBiLiAy/Tb58L8YCw==';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!, b => parseInt(b, 16));
const toHex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');

describe('pinned signing vectors — seed phrase → public key → owner hash', () => {
  it.each(VECTORS)('$mnemonic', async ({ mnemonic, publicKey, ownerHash }) => {
    const keypair = await deriveSigningKeypair(mnemonic);
    expect(bufferToBase64(keypair.publicKey)).toBe(publicKey);
    expect(await deriveOwnerHash(keypair.publicKey)).toBe(ownerHash);
  });
});

describe('pinned signature — the exact bytes a fixed body signs to', () => {
  it('signPayload over the fixed /check-registration body', async () => {
    const { privateKey } = await deriveSigningKeypair(VECTORS[0].mnemonic);
    expect(await signPayload(privateKey, SIGNED_BODY)).toBe(SIGNATURE);
  });
});

describe('the library itself — RFC 8032 §7.1, TEST 1', () => {
  // Independent of this app's HKDF: if this fails, the Ed25519 implementation
  // moved; if only the vectors above fail, the derivation around it did.
  it('public key and signature of the empty message', async () => {
    const secretKey = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    expect(toHex(await ed.getPublicKeyAsync(secretKey)))
      .toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(toHex(await ed.signAsync(new Uint8Array(0), secretKey))).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });
});
