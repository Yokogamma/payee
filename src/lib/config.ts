/**
 * Trusted Arweave wallet address(es) — the ROOT OF TRUST for restore (C2).
 *
 * All legitimate notes are signed and paid for by the proxy's server wallet, so
 * on-chain their `owner` == the proxy wallet address. Filtering restore by these
 * addresses defeats Note-Id squatting/replay: an attacker cannot post a TX under
 * the proxy wallet, so their forged candidate never enters the result set.
 *
 * PINNED AT BUILD TIME via VITE_TRUSTED_OWNERS (comma-separated). Restore must NOT
 * depend on a live Worker endpoint, so this is never fetched at runtime. The
 * `GET /wallet-address` worker endpoint exists only for diagnostics / discovering
 * the value to pin — it must never auto-expand the trust set.
 *
 * Wallet rotation: (1) add the NEW address here and deploy; (2) only then switch
 * ARWEAVE_JWK on the worker; (3) NEVER remove old addresses (old notes must stay
 * restorable).
 */

import { parseTrustedOwners } from './trusted-owners';

const raw = (import.meta.env.VITE_TRUSTED_OWNERS ?? '') as string;

// Validate at module load, but defer FAILURE to restore time so a misconfig
// doesn't crash the whole app — it just disables restore (fail-closed).
let owners: string[] = [];
let configError: string | null = null;
try {
  owners = parseTrustedOwners(raw);
  if (owners.length === 0) {
    configError =
      'VITE_TRUSTED_OWNERS is not set. Restore is disabled (fail-closed) to avoid ' +
      'trusting arbitrary on-chain transactions. Pin the proxy wallet address(es).';
  }
} catch (e) {
  configError = e instanceof Error ? e.message : String(e);
}

export const TRUSTED_OWNERS: string[] = owners;

/** Fail-closed guard. Throws if the trust set is missing or malformed. */
export function assertTrustedOwners(): void {
  if (configError) throw new Error(configError);
}
