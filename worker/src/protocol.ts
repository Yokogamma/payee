/**
 * The on-chain canon of this project's publications — stated ONCE.
 *
 * Three places used to spell it out independently: upload validation, the
 * `/health` capability list, and the D9 tag check. They agreed by luck. A
 * version added to one and not the others would let the worker accept an
 * upload it cannot later authenticate — or advertise a version it refuses.
 */

/** The `App-Name` tag every publication carries. */
export const APP_NAME = 'EternalNotes';

/**
 * Every `App-Version` this build accepts on upload AND recognises on chain.
 * Ordered: it is reported verbatim by `/health` and pinned by the smoke.
 */
export const SUPPORTED_VERSIONS = ['1', '2', '3', '4'] as const;
export type AppVersion = (typeof SUPPORTED_VERSIONS)[number];

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_VERSIONS);

export function isSupportedVersion(value: unknown): value is AppVersion {
  return typeof value === 'string' && SUPPORTED_SET.has(value);
}
