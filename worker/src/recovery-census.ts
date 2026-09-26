/**
 * The operator's RECOVERY CENSUS — the proof a rollback below the reader
 * needs (runbook reader release §5.1, review 25.09 H3).
 *
 * Why it exists: the pre-reader build (394156d) does not know `signed` /
 * `redrop_pending`. Its `/check-and-reserve` answers `ok` over such a record
 * and rewrites it to `reserved` — the txId and the signed bytes are lost and a
 * second paid publication becomes possible. So a rollback is admissible only
 * when EVERY key's recovery set is proven empty: an enumeration, never a wait.
 *
 * The key set is the one the legacy closure uses (legacy-closure.ts): every
 * key that ever held access — used invites incl. REVOKED ones, the live
 * `pk:*`, and the keys the operator registered through
 * `/admin/spend/init-legacy-keys`. Old-format invites that hide their key
 * keep the census INCOMPLETE until acknowledged, exactly as they keep the
 * closure open.
 *
 * Fail-closed at every step: a failed or malformed read is `incomplete`,
 * never «empty». The answer is a SUMMARY — counts and reason codes; no key,
 * noteId or txId ever leaves (the route sits behind the read-only
 * METRICS_ADMIN_SECRET).
 */

import { listHistoricalKeys, type LegacyClosureEnv } from './legacy-closure';

/** Keys one census may read. A larger set answers `incomplete / too_many_keys`
 *  (fail-closed) rather than risk the invocation's subrequest budget. */
export const CENSUS_MAX_KEYS = 200;
/** Per-key reads in flight at once. */
export const CENSUS_CONCURRENCY = 8;

export type CensusReason =
  | 'list_keys_failed'
  | 'legacy_keys_failed'
  | 'legacy_invites_unacknowledged'
  | 'too_many_keys'
  | 'key_read_failed'
  | 'recovery_present'
  | 'counter_drift';

export interface RecoveryCensus {
  /** Every key was enumerated AND read. Only a complete census can be empty. */
  complete: boolean;
  verdict: 'empty' | 'not_empty' | 'incomplete';
  keys: { listed: number; checked: number; failed: number };
  legacyInvites: { unknown: number; acknowledged: number };
  /** Sums over the keys read: the persistent counter, the index, and the
   *  records found by a direct scan; `keysWithRecovery` counts keys where any
   *  of the three is non-zero. */
  recovery: { count: number; due: number; records: number; keysWithRecovery: number };
  reasons: CensusReason[];
}

export type RecoveryCensusEnv = Pick<LegacyClosureEnv, 'INVITE_MANAGER' | 'RATE_LIMITER'> & {
  SPEND_GUARD?: DurableObjectNamespace;
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

async function postJson(ns: DurableObjectNamespace, name: string, path: string): Promise<Record<string, unknown>> {
  const res = await ns.get(ns.idFromName(name)).fetch(`http://internal${path}`, { method: 'POST', body: '{}' });
  if (res.status < 200 || res.status >= 300) throw new Error(`${path}: HTTP ${res.status}`);
  const parsed: unknown = JSON.parse(await res.text());
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path}: not an object`);
  return parsed as Record<string, unknown>;
}

/** The operator-registered keys and acknowledgement, strictly validated. */
async function readRegisteredKeys(env: RecoveryCensusEnv): Promise<{ keys: string[]; acknowledged: number }> {
  if (!env.SPEND_GUARD) throw new Error('SPEND_GUARD binding missing');
  const b = await postJson(env.SPEND_GUARD, 'global', '/legacy-keys');
  if (b.ok !== true) throw new Error('/legacy-keys: ok !== true');
  if (!Array.isArray(b.keys) || !b.keys.every((k) => typeof k === 'string')) throw new Error('/legacy-keys: keys[] invalid');
  if (!isCount(b.acknowledgedInvites)) throw new Error('/legacy-keys: acknowledgedInvites invalid');
  return { keys: b.keys as string[], acknowledged: b.acknowledgedInvites };
}

type KeyCounts = { recoveryCount: number; due: number; records: number };

async function readKey(env: RecoveryCensusEnv, key: string): Promise<KeyCounts | null> {
  try {
    const b = await postJson(env.RATE_LIMITER, key, '/recovery-census');
    if (!isCount(b.recoveryCount) || !isCount(b.due) || !isCount(b.records)) return null;
    return { recoveryCount: b.recoveryCount, due: b.due, records: b.records };
  } catch {
    return null;
  }
}

export async function recoveryCensus(env: RecoveryCensusEnv): Promise<RecoveryCensus> {
  const reasons = new Set<CensusReason>();
  const census: RecoveryCensus = {
    complete: false,
    verdict: 'incomplete',
    keys: { listed: 0, checked: 0, failed: 0 },
    legacyInvites: { unknown: 0, acknowledged: 0 },
    recovery: { count: 0, due: 0, records: 0, keysWithRecovery: 0 },
    reasons: [],
  };

  let historical: string[] = [];
  let listed = true;
  try {
    const h = await listHistoricalKeys(env as LegacyClosureEnv);
    historical = h.keys;
    census.legacyInvites.unknown = h.unknownLegacyInvites;
  } catch {
    listed = false;
    reasons.add('list_keys_failed');
  }
  let registered: string[] = [];
  try {
    const r = await readRegisteredKeys(env);
    registered = r.keys;
    census.legacyInvites.acknowledged = r.acknowledged;
  } catch {
    listed = false;
    reasons.add('legacy_keys_failed');
  }
  if (listed && census.legacyInvites.unknown > census.legacyInvites.acknowledged) reasons.add('legacy_invites_unacknowledged');

  const keys = [...new Set([...historical, ...registered])];
  census.keys.listed = keys.length;
  if (keys.length > CENSUS_MAX_KEYS) {
    reasons.add('too_many_keys');
  } else {
    for (let i = 0; i < keys.length; i += CENSUS_CONCURRENCY) {
      const batch = await Promise.all(keys.slice(i, i + CENSUS_CONCURRENCY).map((k) => readKey(env, k)));
      for (const counts of batch) {
        if (counts === null) { census.keys.failed++; continue; }
        census.keys.checked++;
        census.recovery.count += counts.recoveryCount;
        census.recovery.due += counts.due;
        census.recovery.records += counts.records;
        if (counts.recoveryCount > 0 || counts.due > 0 || counts.records > 0) census.recovery.keysWithRecovery++;
        if (counts.recoveryCount !== counts.records || counts.due !== counts.records) reasons.add('counter_drift');
      }
    }
    if (census.keys.failed > 0) reasons.add('key_read_failed');
  }
  if (census.recovery.keysWithRecovery > 0) reasons.add('recovery_present');

  census.complete = listed
    && !reasons.has('legacy_invites_unacknowledged')
    && !reasons.has('too_many_keys')
    && census.keys.failed === 0
    && census.keys.checked === census.keys.listed;
  census.verdict = !census.complete ? 'incomplete' : census.recovery.keysWithRecovery > 0 ? 'not_empty' : 'empty';
  census.reasons = [...reasons].sort();
  return census;
}
