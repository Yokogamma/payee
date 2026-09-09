/**
 * Evidence export for the D2 soak — READ ONLY, and deliberately independent of
 * the deployed Worker.
 *
 * ⚠️ НЕ ДОБАВЛЯТЬ СЮДА SHEBANG — см. soak-d2.mjs (vite-node оборачивает модуль
 * в тело функции, и `#!` внутри неё ломает СБОРКУ теста, а не только запуск).
 *
 * Two reasons this is a separate tool and not another `/admin/metrics` report:
 *
 * 1. RETENTION. Workers Logs keeps at most seven days and a soak window is
 *    exactly seven, so the beginning of the window can age out on the day the
 *    window is judged. Analytics Engine is not indefinite either. Whatever is
 *    not written to disk daily is simply gone.
 *
 * 2. ROLLBACK. `/admin/metrics` is served BY the worker, so its SQL is whatever
 *    the deployed version happens to contain. Roll the worker back below the
 *    index split and its reader stops seeing `event:discriminator` rows — the
 *    evidence would still exist and become unreadable through the endpoint.
 *    This script reads BOTH schemas regardless of what is deployed.
 *
 * Usage:
 *   node scripts/metrics-export.mjs metrics --hours 168 --out DIR
 *   node scripts/metrics-export.mjs logs --hours 24 --out DIR
 *
 * Credentials — never on the command line (shell history, process listings):
 *   metrics: $CF_ANALYTICS_TOKEN, else the file $CF_ANALYTICS_TOKEN_FILE
 *            (scope: Account → Account Analytics → Read)
 *   logs:    $CF_LOGS_TOKEN, else the file $CF_LOGS_TOKEN_FILE
 *            (scope: Account → Workers Observability → Read — a DIFFERENT
 *             token; the analytics one does not carry it)
 *   both:    $CF_ACCOUNT_ID (an identifier, not a secret)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ACCOUNT_ID = '88cd072a3c0a9b861d52dcc126b9d57e';
export const DEFAULT_DATASET = 'eternal_notes_metrics';
export const REPORTS = ['gateway_health', 'upload_outcomes', 'status_verdicts', 'semantic_idempotency'];

/**
 * The union that reads BOTH index schemas — the same expression the worker's
 * templates use. A data point carries exactly ONE `index1`, so the two sides
 * are mutually exclusive per row and the union cannot double count.
 *
 * Kept identical to worker/src/metrics.ts by metrics-export.test.mjs, which
 * compares this module's SQL with `buildMetricsReportSql` character for
 * character. If that test fails, the two readers have drifted.
 */
export function indexFilter(event) {
  return `(index1 = '${event}' OR index1 LIKE '${event}:%')`;
}

/** Byte-for-byte the worker's whitelisted templates. */
export function reportSql(report, dataset, hours) {
  switch (report) {
    case 'gateway_health':
      return `SELECT blob2 AS kind, blob3 AS host, blob4 AS class, SUM(_sample_interval) AS calls, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM ${dataset} WHERE ${indexFilter('gateway_call')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY kind, host, class LIMIT 200 FORMAT JSON`;
    case 'upload_outcomes':
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('upload_outcome')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
    case 'status_verdicts':
      return `SELECT blob2 AS verdict, blob3 AS host, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('status_verdict')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY verdict, host LIMIT 100 FORMAT JSON`;
    case 'semantic_idempotency':
      return `SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM ${dataset} WHERE ${indexFilter('semantic_idempotency')} AND timestamp > NOW() - INTERVAL '${hours}' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON`;
    default:
      throw new Error(`unknown report: ${report}`);
  }
}

/** Raw rows, unaggregated — what a `SUM(_sample_interval)` estimate is built from. */
export function rawRowsSql(dataset, hours) {
  return `SELECT timestamp, index1, blob1, blob2, blob3, blob4, double1, _sample_interval FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR ORDER BY timestamp ASC LIMIT 10000 FORMAT JSON`;
}

// ── Log export ────────────────────────────────────────────────────────

/** The per-request cap this script asks the observability API for. */
export const LOG_PAGE_LIMIT = 1000;

/**
 * Split a range into slices, newest last.
 *
 * The observability query API is asked for a bounded number of events per
 * call. Rather than trust an undocumented cursor, the range is CUT into
 * slices and each slice is checked against the cap (see assertNotTruncated):
 * a slice that comes back full may have lost events, and the answer is a
 * narrower slice, never a silent partial export.
 */
export function sliceRange(fromMs, toMs, sliceMs) {
  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs)) || toMs <= fromMs) {
    throw new Error(`bad range: ${fromMs}..${toMs}`);
  }
  if (!(Number.isFinite(sliceMs) && sliceMs > 0)) throw new Error(`bad slice: ${sliceMs}`);
  const slices = [];
  for (let start = fromMs; start < toMs; start += sliceMs) {
    slices.push({ from: start, to: Math.min(start + sliceMs, toMs) });
  }
  return slices;
}

/**
 * A slice that returned exactly the cap is INDISTINGUISHABLE from a slice that
 * was truncated, and a silently short export is worse than none: it would be
 * archived as evidence and read as «nothing happened».
 */
export function assertNotTruncated(count, limit, slice) {
  if (count >= limit) {
    const from = new Date(slice.from).toISOString();
    const to = new Date(slice.to).toISOString();
    throw new Error(
      `slice ${from}..${to} returned ${count} events at the ${limit} cap — it may be truncated. `
      + 'Re-run with a smaller --slice-minutes; do NOT archive this run.',
    );
  }
}

// ── IO ────────────────────────────────────────────────────────────────

async function credential(envName, fileEnvName) {
  const inline = process.env[envName];
  if (inline && inline.trim()) return inline.trim();
  const file = process.env[fileEnvName];
  if (file) {
    const t = (await readFile(file, 'utf8')).trim();
    if (t) return t;
  }
  throw new Error(`missing credential: set $${envName} or point $${fileEnvName} at a file containing it`);
}

async function cfPost(url, token, body, asJson) {
  const res = await fetch(url, {
    method: 'POST',
    headers: asJson
      ? { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      : { Authorization: `Bearer ${token}` },
    body: asJson ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON answer from ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  }
}

async function exportMetrics({ accountId, dataset, hours, outDir }) {
  const token = await credential('CF_ANALYTICS_TOKEN', 'CF_ANALYTICS_TOKEN_FILE');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const out = { at: new Date().toISOString(), kind: 'metrics', dataset, hours, reports: {}, raw: null };
  for (const report of REPORTS) {
    const doc = await cfPost(url, token, reportSql(report, dataset, hours), false);
    out.reports[report] = doc.data ?? doc;
    console.log(`  ${report}: ${Array.isArray(doc.data) ? doc.data.length : '?'} row(s)`);
  }
  // The raw rows too: an aggregate cannot be re-derived once the window ages
  // out, and `_sample_interval` is only visible here.
  const raw = await cfPost(url, token, rawRowsSql(dataset, hours), false);
  out.raw = raw.data ?? raw;
  console.log(`  raw rows: ${Array.isArray(out.raw) ? out.raw.length : '?'}`);
  return out;
}

async function exportLogs({ accountId, hours, sliceMs, outDir }) {
  const token = await credential('CF_LOGS_TOKEN', 'CF_LOGS_TOKEN_FILE');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
  const to = Date.now();
  const from = to - hours * 3600_000;
  const slices = sliceRange(from, to, sliceMs);
  const events = [];
  for (const slice of slices) {
    const doc = await cfPost(url, token, {
      queryId: `soak-export-${slice.from}`,
      timeframe: { from: slice.from, to: slice.to },
      parameters: { datasets: ['cloudflare-workers'], filters: [], limit: LOG_PAGE_LIMIT },
      view: 'events',
      limit: LOG_PAGE_LIMIT,
      dry: false,
    }, true);
    const batch = doc?.result?.events?.events ?? [];
    assertNotTruncated(batch.length, LOG_PAGE_LIMIT, slice);
    events.push(...batch);
    console.log(`  ${new Date(slice.from).toISOString()} .. ${new Date(slice.to).toISOString()}: ${batch.length} event(s)`);
  }
  const critical = events.filter((e) => {
    const msg = e?.$metadata?.message ?? e?.message ?? '';
    return typeof msg === 'string' && msg.includes('"critical"');
  });
  console.log(`  total ${events.length} event(s), of which ${critical.length} critical`);
  // An EMPTY export is a finding, not a success: it is what «logs were never
  // collected» looks like, and it must not be mistaken for «nothing happened».
  if (events.length === 0) {
    console.log('  ! ZERO events in the whole range — verify that observability is enabled and collecting');
  }
  return {
    at: new Date().toISOString(), kind: 'logs', hours,
    sliceMinutes: sliceMs / 60_000, slices: slices.length,
    counts: { events: events.length, critical: critical.length },
    critical, events,
  };
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { hours: 24, out: null, sliceMinutes: 60 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--hours') { opts.hours = Number(rest[++i]); continue; }
    if (a === '--out') { opts.out = String(rest[++i] ?? ''); continue; }
    if (a === '--slice-minutes') { opts.sliceMinutes = Number(rest[++i]); continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.hours) || opts.hours < 1 || opts.hours > 168) {
    throw new Error('--hours must be an integer in 1..168');
  }
  if (!Number.isInteger(opts.sliceMinutes) || opts.sliceMinutes < 1) {
    throw new Error('--slice-minutes must be a positive integer');
  }
  return { mode, opts };
}

export async function main(argv) {
  const { mode, opts } = parseArgs(argv);
  if (!['metrics', 'logs'].includes(mode)) {
    console.error('usage: metrics-export.mjs <metrics | logs> [--hours N] [--slice-minutes N] [--out DIR]');
    return 2;
  }
  const accountId = process.env.CF_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
  const dataset = process.env.METRICS_DATASET ?? DEFAULT_DATASET;
  const outDir = opts.out ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.eternal-notes-soak', 'snapshots');
  await mkdir(outDir, { recursive: true });

  console.log(`${mode}: last ${opts.hours}h → ${outDir}`);
  const payload = mode === 'metrics'
    ? await exportMetrics({ accountId, dataset, hours: opts.hours, outDir })
    : await exportLogs({ accountId, hours: opts.hours, sliceMs: opts.sliceMinutes * 60_000, outDir });

  const file = join(outDir, `${new Date().toISOString().slice(0, 10)}-${mode}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n');
  console.log(`kept: ${file}`);
  return 0;
}

if (process.argv[1]?.endsWith('metrics-export.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`✗ ${err?.message ?? err}`); process.exitCode = 1; },
  );
}
