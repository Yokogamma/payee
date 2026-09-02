/**
 * TEST-ONLY mirror of the canonical publication fingerprint (`fp`).
 *
 * `fp` is a SERVER concept: the proof that «these bytes are that publication»
 * lives entirely in the worker, and the client has no production consumer for
 * it (plan §5). Shipping one would create a second source of truth for a byte
 * format that must never diverge — and a client that computed `fp` locally
 * would tempt a future change into trusting it.
 *
 * This module exists for ONE reason: so the client half can be checked against
 * the same documented byte vector as `worker/src/publication-fp.ts`. Written as
 * an INDEPENDENT implementation on purpose — a shared import would make the
 * parity test tautological.
 *
 * Importing it from production code is a lint error (`eslint.config.js`).
 *
 * Normative definition and the vector: `docs/BACKUP_FORMAT_V1.md`.
 */

/** Must equal `PUBLICATION_FP_DOMAIN` in `worker/src/publication-fp.ts`. */
export const PUBLICATION_FP_DOMAIN = 'eternal-notes/publication-fp/v1\n';

function canonicalStringRecord(record: Record<string, string>): string {
  const keys = Object.keys(record).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(',')}}`;
}

export function publicationFpInput(appVersion: string, data: string): string {
  if (typeof appVersion !== 'string' || typeof data !== 'string') {
    throw new TypeError('publicationFpInput: appVersion and data must be strings');
  }
  return PUBLICATION_FP_DOMAIN + canonicalStringRecord({ appVersion, data });
}

export async function computePublicationFp(appVersion: string, data: string): Promise<string> {
  const bytes = new TextEncoder().encode(publicationFpInput(appVersion, data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
