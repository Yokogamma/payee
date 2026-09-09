/**
 * PR-2 «Метрики» — Analytics Engine emission + the /admin/metrics SQL contract.
 * Spec: docs/ARWEAVE-RESILIENCE-PLAN.md §4.PR-2 «Реализация»; docs/METRICS.md.
 *
 * Privacy boundary (Analytics Engine only): no noteId, no txId, no keys, no
 * IPs — events carry enum-like labels (event/kind/host/class/verdict/
 * appVersion) and safe numbers. Worker logs (console.error) are a separate,
 * documented residual risk — see docs/METRICS.md.
 */

export type Emit = (event: string, blobs: string[], doubles: number[]) => void;

export interface MetricsEnv {
  METRICS?: AnalyticsEngineDataset;
  METRICS_ENABLED?: string;
  METRICS_DATASET?: string;
}

/**
 * Telemetry is fail-closed, the request path is fail-open: writes happen
 * STRICTLY when METRICS_ENABLED === 'true' AND the binding exists; any other
 * value (false, garbage, missing var, missing binding) disables writes, and a
 * writeDataPoint failure never propagates into the request.
 *
 * Data-point shape: `blob1` is the event name and the caller's blobs follow in
 * the documented order (docs/METRICS.md). The INDEX is event + discriminator —
 * see metricIndexKey, and read the reason there before changing it.
 */
export function makeEmit(env: MetricsEnv): Emit {
  const dataset = env.METRICS;
  if (env.METRICS_ENABLED !== 'true' || !dataset || typeof dataset.writeDataPoint !== 'function') {
    return () => {};
  }
  return (event, blobs, doubles) => {
    try {
      dataset.writeDataPoint({ indexes: [metricIndexKey(event, blobs)], blobs: [event, ...blobs], doubles });
    } catch {
      /* telemetry must never break the request */
    }
  };
}

/**
 * Only these may ride in the index: enum-like, lower-case, short. Anything
 * else falls back to the bare event name, so a careless call site can never
 * put a high-cardinality value (or user data) into the index.
 */
const INDEX_DISCRIMINATOR_RE = /^[a-z0-9_.:-]{1,48}$/;

/**
 * The index is `event:discriminator`, not just `event` — and this is the whole
 * point of the change.
 *
 * Analytics Engine samples PER INDEX. With the bare event name as the index,
 * every kind of `gateway_call` shared ONE sampling bucket, and so did every
 * outcome of `semantic_idempotency`. Measured on 2026-09-09 over the D2 soak:
 * only 36 of 84 `gateway_call` rows survived, and the survivors happened to be
 * all `anchor`/`price` — `post` and both `payload_*` kinds vanished from the
 * report entirely while the weighted TOTAL stayed correct. The same mechanism
 * inflated `legacy_backfilled` to 4 against a real 2.
 *
 * That is fatal for the exit criteria in docs/ROLLBACK.md, which require
 * `conflict` and friends to read STRICTLY ZERO: a rare outcome sharing a bucket
 * with a frequent one CAN disappear from the sample entirely — which of them
 * the sampler drops was not measured, and does not need to be. Giving each
 * discriminator its own bucket does not PROVE a zero — nothing sampled can —
 * but it stops the frequent outcomes from crowding out the rare ones.
 *
 * `blob1` keeps the bare event name, so every report's blob positions are
 * unchanged and old rows stay readable (see buildMetricsReportSql).
 */
export function metricIndexKey(event: string, blobs: readonly string[]): string {
  const discriminator = blobs[0];
  return typeof discriminator === 'string' && INDEX_DISCRIMINATOR_RE.test(discriminator)
    ? `${event}:${discriminator}`
    : event;
}

// ─── /admin/metrics SQL contract ────────────────────────────────────

export const METRICS_REPORTS = ['gateway_health', 'upload_outcomes', 'status_verdicts', 'semantic_idempotency'] as const;
export type MetricsReport = (typeof METRICS_REPORTS)[number];

/** Dataset names are substituted into SQL — only after THIS validation. */
export const METRICS_DATASET_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Reads BOTH index schemas: the old rows whose `index1` is the bare event name,
 * and the new `event:discriminator` rows (see metricIndexKey).
 *
 * It cannot double count. A data point carries exactly ONE `index1`, so the two
 * sides of the OR are mutually exclusive per row — the union is a partition of
 * the event's rows, not an overlap. `blob1` still holds the bare event name in
 * both schemas, so every projection below is unchanged.
 *
 * `event` is always a literal from the switch beneath, never caller input.
 * Verified against the live SQL API on 2026-09-09: `LIKE` is supported and the
 * union returns the same count as the old equality did for pre-split rows.
 */
function indexFilter(event: string): string {
  return `(index1 = '${event}' OR index1 LIKE '${event}:%')`;
}

/**
 * Whitelisted SQL templates — the implementation never invents SQL. Counters
 * are always SUM(_sample_interval) (Analytics Engine samples!), percentiles
 * only the weighted exact form (quantileExactWeighted). LIMIT is hardcoded in
 * the template, never a parameter. `dataset` must already match
 * METRICS_DATASET_RE; `hours` must already be a validated integer 1..168 —
 * unchecked concatenation is forbidden.
 *
 * A counter here is still an ESTIMATE, in both schemas. These reports say how
 * things went; they do not on their own establish that something never
 * happened — for the strictly-zero criteria see docs/ROLLBACK.md and the
 * critical-outcome log lines that back them.
 */
export function buildMetricsReportSql(report: MetricsReport, dataset: string, hours: number): string {
  switch (report) {
    case 'gateway_health':
      return `SELECT blob2 AS kind, blob3 AS host, blob4 AS class, SUM(_sample_interval) AS calls, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM ${dataset} WHERE ${indexFilter('gateway_call')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY kind, host, class LIMIT 200 FORMAT JSON`;
    case 'upload_outcomes':
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('upload_outcome')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
    case 'status_verdicts':
      return `SELECT blob2 AS verdict, blob3 AS host, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('status_verdict')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY verdict, host LIMIT 100 FORMAT JSON`;
    case 'semantic_idempotency':
      // The D2 soak report: how the fingerprint protocol decided, per outcome.
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('semantic_idempotency')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
  }
}
