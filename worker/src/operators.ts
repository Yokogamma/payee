/**
 * The operator map of the status pool on the WORKER (D11 v16 M4, D10 §4.1/
 * §4.2/§7, review 25.09: a mandatory condition of the reader release).
 *
 * Every money decision of the spend guard — a settled spend, a credited
 * deposit, a marker's `done`, the proof that an anchor expired — needs
 * ≥ MIN_BALANCE_SOURCES independent OPERATORS, and two origins run by one
 * operator are ONE voice. The map `canonicalOrigin → operatorId` says who
 * runs what. It is the same map the client pins for the D11 age quorum
 * (`scripts/gateway-pins.mjs` STATUS_OPERATORS, `src/lib/gateways.ts`), parsed
 * by the same shared parser (`parseOperatorMap`), and shipped to the worker as
 * the var `STATUS_OPERATORS` (both blocks of wrangler.toml). The deploy gate
 * `scripts/check-gateways-vs-worker.mjs` refuses a config whose map does not
 * equal the pin, leaves a status origin without an operator, or names fewer
 * than two distinct operators.
 *
 * FAIL-CLOSED: an origin the map does not know casts NO money vote (`null`),
 * so a list extended without extending the map cannot loosen a quorum — it
 * can only fail to reach one. An unset/empty var falls back to the pinned
 * default, exactly as the client does; a SET var is taken as-is (the gate
 * holds it equal to the pin).
 */

import { parseOperatorMap } from '../../src/lib/gateways-parse';

/** The pinned map (must equal `scripts/gateway-pins.mjs` STATUS_OPERATORS —
 *  `scripts/check-gateways-vs-worker.test.mjs` holds the two together). */
export const DEFAULT_STATUS_OPERATORS =
  'https://arweave.net=arweave,https://ar-io.dev=ar-io,https://vilenarios.com=vilenarios,'
  + 'https://frostor.xyz=frostor,https://permagate.io=permagate';

export interface OperatorEnv { STATUS_OPERATORS?: string }

/** The operator behind a canonical status origin, or `null` when unknown. */
export type OperatorOf = (origin: string) => string | null;

export function operatorMapOf(env: OperatorEnv): ReadonlyMap<string, string> {
  const parsed = parseOperatorMap(env.STATUS_OPERATORS ?? '');
  return parsed.size > 0 ? parsed : parseOperatorMap(DEFAULT_STATUS_OPERATORS);
}

export function operatorOfEnv(env: OperatorEnv): OperatorOf {
  const map = operatorMapOf(env);
  return (origin) => map.get(origin) ?? null;
}

/** How many DISTINCT operators the configured status origins map to — the
 *  `/health` attestation the deploy smoke reads (a pool that cannot reach a
 *  money quorum must be visible, not discovered at the first settle). */
export function distinctOperators(env: OperatorEnv, origins: readonly string[]): number {
  const of = operatorOfEnv(env);
  const seen = new Set<string>();
  for (const o of origins) { const op = of(o); if (op !== null) seen.add(op); }
  return seen.size;
}
