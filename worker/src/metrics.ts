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
 * Data-point shape: the event name is BOTH the index (low cardinality,
 * independent sampling per event type) and the first blob; callers pass the
 * remaining blobs in the documented order (docs/METRICS.md).
 */
export function makeEmit(env: MetricsEnv): Emit {
  const dataset = env.METRICS;
  if (env.METRICS_ENABLED !== 'true' || !dataset || typeof dataset.writeDataPoint !== 'function') {
    return () => {};
  }
  return (event, blobs, doubles) => {
    try {
      dataset.writeDataPoint({ indexes: [event], blobs: [event, ...blobs], doubles });
    } catch {
      /* telemetry must never break the request */
    }
  };
}

// ─── /admin/metrics SQL contract ────────────────────────────────────

export const METRICS_REPORTS = ['gateway_health', 'upload_outcomes', 'status_verdicts', 'semantic_idempotency'] as const;
export type MetricsReport = (typeof METRICS_REPORTS)[number];

/** Dataset names are substituted into SQL — only after THIS validation. */
export const METRICS_DATASET_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Whitelisted SQL templates — the implementation never invents SQL. Counters
 * are always SUM(_sample_interval) (Analytics Engine samples!), percentiles
 * only the weighted exact form (quantileExactWeighted). LIMIT is hardcoded in
 * the template, never a parameter. `dataset` must already match
 * METRICS_DATASET_RE; `hours` must already be a validated integer 1..168 —
 * unchecked concatenation is forbidden.
 */
export function buildMetricsReportSql(report: MetricsReport, dataset: string, hours: number): string {
  switch (report) {
    case 'gateway_health':
      return `SELECT blob2 AS kind, blob3 AS host, blob4 AS class, SUM(_sample_interval) AS calls, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM ${dataset} WHERE index1='gateway_call' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY kind, host, class LIMIT 200 FORMAT JSON`;
    case 'upload_outcomes':
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1='upload_outcome' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
    case 'status_verdicts':
      return `SELECT blob2 AS verdict, blob3 AS host, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1='status_verdict' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY verdict, host LIMIT 100 FORMAT JSON`;
    case 'semantic_idempotency':
      // The D2 soak report: how the fingerprint protocol decided, per outcome.
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1='semantic_idempotency' AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
  }
}
