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
 *    window is judged. Whatever is not written to disk daily is gone.
 *
 * 2. ROLLBACK. `/admin/metrics` is served BY the worker, so its SQL is whatever
 *    the deployed version contains. Roll the worker back below the index split
 *    and its reader stops seeing `event:discriminator` rows — the evidence
 *    would still exist and become unreadable through the endpoint. This script
 *    reads BOTH schemas regardless of what is deployed.
 *
 * THE GOVERNING RULE: an incomplete export must FAIL, never be archived. A
 * short file is worse than a missing one — it gets read later as «nothing
 * happened». Every check below therefore ends in an exception rather than in a
 * default value.
 *
 * That is a RULE, not a guarantee: it covers the failures and incompleteness
 * signals this script knows how to recognise. The contract of the observability
 * API is implemented from documentation and has never been exercised against a
 * live answer, so a shape nobody anticipated can still pass. Treat «it did not
 * throw» as «no KNOWN defect», never as «the export is provably complete».
 *
 * Usage:
 *   node scripts/metrics-export.mjs metrics --hours 168 --out DIR
 *   node scripts/metrics-export.mjs logs --hours 24 --worker eternal-notes-proxy
 *
 * Credentials — never on the command line (shell history, process listings):
 *   metrics: $CF_ANALYTICS_TOKEN, else the file $CF_ANALYTICS_TOKEN_FILE
 *            (scope: Account → Account Analytics → Read)
 *   logs:    $CF_LOGS_TOKEN, else the file $CF_LOGS_TOKEN_FILE
 *            (scope: Account → Workers Observability → Read — a DIFFERENT
 *             token; the analytics one does not carry it)
 *   both:    $CF_ACCOUNT_ID (an identifier, not a secret)
 */

import { readFile, writeFile, mkdir, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const DEFAULT_ACCOUNT_ID = '88cd072a3c0a9b861d52dcc126b9d57e';
export const DEFAULT_DATASET = 'eternal_notes_metrics';
export const DEFAULT_WORKER = 'eternal-notes-proxy';
export const REPORTS = ['gateway_health', 'upload_outcomes', 'status_verdicts', 'semantic_idempotency'];

// ── Analytics Engine SQL ──────────────────────────────────────────────

/**
 * The union that reads BOTH index schemas — the same expression the worker's
 * templates use. A data point carries exactly ONE `index1`, so the two sides
 * are mutually exclusive per row and the union cannot double count.
 */
export function indexFilter(event) {
  return `(index1 = '${event}' OR index1 LIKE '${event}:%')`;
}

const PROJECTION = {
  gateway_health: "SELECT blob2 AS kind, blob3 AS host, blob4 AS class, SUM(_sample_interval) AS calls, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms",
  upload_outcomes: 'SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n',
  status_verdicts: 'SELECT blob2 AS verdict, blob3 AS host, SUM(_sample_interval) AS n',
  semantic_idempotency: 'SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n',
};
const EVENT_OF = {
  gateway_health: 'gateway_call',
  upload_outcomes: 'upload_outcome',
  status_verdicts: 'status_verdict',
  semantic_idempotency: 'semantic_idempotency',
};
const TAIL = {
  gateway_health: 'GROUP BY kind, host, class LIMIT 200 FORMAT JSON',
  upload_outcomes: 'GROUP BY outcome, app_version LIMIT 50 FORMAT JSON',
  status_verdicts: 'GROUP BY verdict, host LIMIT 100 FORMAT JSON',
  semantic_idempotency: 'GROUP BY outcome, app_version LIMIT 50 FORMAT JSON',
};

/**
 * The RELATIVE form — byte-identical to the worker's whitelisted templates.
 * Kept only so metrics-export.test.mjs can prove the two readers have not
 * drifted; the archive itself uses the absolute form below.
 */
export function reportSql(report, dataset, hours) {
  if (!PROJECTION[report]) throw new Error(`unknown report: ${report}`);
  return `${PROJECTION[report]} FROM ${dataset} WHERE ${indexFilter(EVENT_OF[report])} AND timestamp > NOW() - INTERVAL '${hours}' HOUR ${TAIL[report]}`;
}

/**
 * The ABSOLUTE form — what the archive uses.
 *
 * `NOW()` is evaluated per query, so a run that fires five statements covers
 * five slightly different windows and the raw rows do not add up to the
 * aggregates they are supposed to explain. One fixed interval for every
 * statement of a run makes the export reproducible and self-consistent.
 */
export function reportSqlAbsolute(report, dataset, fromIso, toIso) {
  if (!PROJECTION[report]) throw new Error(`unknown report: ${report}`);
  return `${PROJECTION[report]} FROM ${dataset} WHERE ${indexFilter(EVENT_OF[report])} AND timestamp >= toDateTime('${fromIso}') AND timestamp < toDateTime('${toIso}') ${TAIL[report]}`;
}

/** Raw rows for one interval — an aggregate cannot be re-derived once the window ages out. */
export const RAW_ROW_LIMIT = 10000;
export function rawRowsSqlAbsolute(dataset, fromIso, toIso) {
  return `SELECT timestamp, index1, blob1, blob2, blob3, blob4, double1, _sample_interval FROM ${dataset} WHERE timestamp >= toDateTime('${fromIso}') AND timestamp < toDateTime('${toIso}') ORDER BY timestamp ASC LIMIT ${RAW_ROW_LIMIT} FORMAT JSON`;
}

/**
 * ClickHouse `toDateTime` wants `YYYY-MM-DD HH:MM:SS`, not an ISO `T`/`Z`.
 *
 * TRUNCATES to a whole second, which is why `resolveInterval` guarantees whole
 * seconds: feeding it a sub-second bound would quietly read a different
 * interval than the archive's own name and metadata report.
 */
export function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ── Completeness guards ───────────────────────────────────────────────

/**
 * The observability API's documented caps. `parameters.limit` is the PAGE size
 * (max 100); the top-level `limit` bounds the whole query (max 2000). They are
 * different knobs and passing one value to both — as the first version of this
 * script did — makes any completeness check meaningless.
 */
export const LOG_PAGE_LIMIT = 100;
export const LOG_QUERY_LIMIT = 2000;
/** Pages per slice before the slice is declared too broad to export safely. */
export const MAX_PAGES_PER_SLICE = Math.ceil(LOG_QUERY_LIMIT / LOG_PAGE_LIMIT);

/** Split a range into slices, oldest first. */
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
 * A slice that exhausts the query cap may have lost events, and a silently
 * short export is archived as evidence and later read as «nothing happened».
 */
export function assertSliceComplete(count, slice) {
  if (count >= LOG_QUERY_LIMIT) {
    throw new Error(
      `slice ${new Date(slice.from).toISOString()}..${new Date(slice.to).toISOString()} reached the `
      + `${LOG_QUERY_LIMIT}-event query cap — it may be truncated. Re-run with a smaller `
      + '--slice-minutes; do NOT archive this run.',
    );
  }
}

/**
 * The envelope check. A 200 carrying `success: false` is a FAILURE, and the
 * first version of this script turned it into an empty array and exit 0.
 */
export function unwrap(doc, what) {
  if (!doc || typeof doc !== 'object') throw new Error(`${what}: answer is not an object`);
  if (doc.success !== true) {
    throw new Error(`${what}: API reported failure — ${JSON.stringify(doc.errors ?? doc).slice(0, 300)}`);
  }
  if (!('result' in doc)) throw new Error(`${what}: no result in a successful answer`);
  return doc.result;
}

/**
 * Adaptive Bit Rate: the observability store may answer from a SAMPLED tier,
 * and `abr_level` says which. Anything above the exact tier means the counts
 * are estimates — which is the very property this export exists to avoid, so
 * it is refused rather than archived with a footnote nobody reads.
 */
export function assertNotSampled(statistics, slice) {
  const level = statistics?.abr_level;
  if (level !== undefined && level !== null && Number(level) > 1) {
    throw new Error(
      `slice ${new Date(slice.from).toISOString()}..${new Date(slice.to).toISOString()} was answered at `
      + `abr_level=${level} — the store SAMPLED it, so these counts are estimates. `
      + 'Re-run with a smaller --slice-minutes; do NOT archive this run.',
    );
  }
  return level ?? null;
}

/**
 * The query must have RUN TO COMPLETION.
 *
 * A `success: true` envelope only says the REQUEST was accepted. A run still
 * `STARTED` answers with whatever it had gathered so far, and archiving that is
 * exactly the silent short file this tool exists to prevent — it passed every
 * other check here (array present, abr_level 1, right worker) and was written
 * out with exit 0.
 *
 * The documented enum is exactly `STARTED | COMPLETED`, so the match is EXACT:
 * no case coercion, no plausible-looking synonyms. An earlier version guessed a
 * wider allowlist, which risks accepting a status that does not actually mean
 * completion — and there was nothing to guess about, the contract says so.
 *
 * An ABSENT status is a refusal too: completion that cannot be verified is not
 * completion.
 */
export const COMPLETED_RUN_STATUS = 'COMPLETED';

export function assertRunComplete(run, slice) {
  const where = `slice ${new Date(slice.from).toISOString()}..${new Date(slice.to).toISOString()}`;
  const status = run?.status;
  if (status === undefined || status === null || status === '') {
    throw new Error(`${where}: the answer carries no run.status, so completion cannot be verified. Do NOT archive this run.`);
  }
  if (status !== COMPLETED_RUN_STATUS) {
    throw new Error(
      `${where}: run.status=${status} — the query had not finished (the documented statuses are `
      + `STARTED | ${COMPLETED_RUN_STATUS}), so the events are partial. Do NOT archive this run.`,
    );
  }
  return status;
}

/**
 * An event the store TRUNCATED is not the event: the message may be cut exactly
 * where the `{"critical":…}` payload sits, which would turn a recorded defect
 * into a line nobody can read.
 */
export function assertNoTruncatedEvents(events, slice) {
  const cut = events.filter((e) => e?.$workers?.truncated === true);
  if (cut.length) {
    throw new Error(
      `slice ${new Date(slice.from).toISOString()}..${new Date(slice.to).toISOString()}: `
      + `${cut.length} of ${events.length} events are marked truncated — their payload is incomplete. `
      + 'Do NOT archive this run.',
    );
  }
}

/** The log line an event carries, wherever the store puts it. */
export function messageOf(event) {
  const msg = event?.$metadata?.message ?? event?.message ?? '';
  return typeof msg === 'string' ? msg : '';
}

/**
 * A log line as a structured object, or null when it is not one.
 *
 * Classification is by PARSED FIELDS, never by substring. A line is matched on
 * what it *is*, not on what text happens to appear somewhere inside it: a
 * `detail` field quoting the expected id, or the word `critical` inside a
 * message, would otherwise be counted as the thing itself.
 */
export function parseStructured(message) {
  if (typeof message !== 'string' || message[0] !== '{') return null;
  try {
    const value = JSON.parse(message);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The control event of the delivery check (`POST /admin/telemetry-probe`).
 *
 * Counted SEPARATELY from `critical`: a probe is not a soak outcome and must
 * never be added to a number that has to read zero.
 */
export function probeLines(events) {
  return events.filter((e) => parseStructured(messageOf(e))?.probe === 'telemetry_probe');
}

/** The critical-outcome lines — by the parsed field, for the same reason. */
export function criticalLines(events) {
  return events.filter((e) => typeof parseStructured(messageOf(e))?.critical === 'string');
}

/**
 * The delivery check, as an ASSERTION rather than something to eyeball.
 *
 * A probe that was written but did not arrive is exactly the failure the whole
 * exercise is looking for, and «I did not spot it in the output» is not a
 * result. Absence therefore fails the run.
 *
 * The id is compared against the `probeId` FIELD. A substring search over the
 * whole message accepted a line whose `probeId` was some other probe while the
 * expected id merely appeared in another field — a green check for an event
 * that never arrived.
 */
export function assertProbeSeen(events, probeId) {
  const seen = events.filter((e) => {
    const line = parseStructured(messageOf(e));
    return line?.probe === 'telemetry_probe' && line.probeId === probeId;
  });
  if (!seen.length) {
    throw new Error(
      `the telemetry probe ${probeId} is NOT in this export. Either the structured line never `
      + 'reached Workers Logs, or it did not reach it within this interval — the delivery check '
      + 'has FAILED and the soak window must not be opened on it.',
    );
  }
  return seen.length;
}

/** The events cursor: `$metadata.id`, passed at the TOP level as `offset`. */
export function eventId(e) {
  return e?.$metadata?.id;
}

/**
 * The next cursor, or null when the page was the last one.
 *
 * NOT a row count: the API pages `view: 'events'` by the id of the last event
 * seen, at the top level. The previous version incremented a NUMBER inside
 * `parameters`, which is a different knob — it never asked for page two.
 */
export function nextCursor(batch, previous) {
  if (!batch.length) return null;
  const last = eventId(batch[batch.length - 1]);
  if (typeof last !== 'string' || !last) {
    throw new Error('the last event of a full page carries no $metadata.id — cannot page safely. Do NOT archive this run.');
  }
  if (last === previous) {
    throw new Error(`the cursor did not advance (${last}) — paging would loop or silently repeat. Do NOT archive this run.`);
  }
  return last;
}

/**
 * One slice, paged to exhaustion. `post` is injected so the whole loop —
 * cursor handling included — is exercised by the tests without a network.
 */
export async function collectSlice({ post, slice, scriptKey, target }) {
  const events = [];
  let cursor = null;
  let abrLevel = null;
  let runStatus = null;
  for (let page = 0; page < MAX_PAGES_PER_SLICE; page++) {
    const body = {
      queryId: `soak-export-${slice.from}-${page}`,
      timeframe: { from: slice.from, to: slice.to },
      parameters: {
        datasets: ['cloudflare-workers'],
        limit: LOG_PAGE_LIMIT,
        filters: [{ key: scriptKey, operation: 'eq', value: target, type: 'string' }],
      },
      view: 'events',
      limit: LOG_QUERY_LIMIT,
      dry: false,
    };
    if (cursor) body.offset = cursor;

    const result = unwrap(await post(body, `page ${page + 1}`), 'query');
    runStatus = assertRunComplete(result?.run, slice);
    abrLevel = assertNotSampled(result?.statistics, slice);
    const batch = result?.events?.events;
    if (!Array.isArray(batch)) throw new Error('query: no events array in a successful answer');
    assertNoTruncatedEvents(batch, slice);
    assertAllFromWorker(batch, scriptKey, target);
    events.push(...batch);
    assertSliceComplete(events.length, slice);

    if (batch.length < LOG_PAGE_LIMIT) return { events, abrLevel, runStatus };
    cursor = nextCursor(batch, cursor);
  }
  // Every page came back full and the pages ran out: the slice is too broad.
  assertSliceComplete(LOG_QUERY_LIMIT, slice);
  return { events, abrLevel, runStatus };
}

/**
 * Every returned event must belong to the worker that was asked for.
 *
 * The first version passed `filters: []`, so one event from any other worker
 * in the account made the delivery check pass. A filter alone is not enough
 * either: if the filter KEY is wrong the API may quietly match everything, so
 * membership is verified on the rows that come back.
 */
export function assertAllFromWorker(events, scriptKey, target) {
  const readKey = (e) => scriptKey.split('.').reduce((v, k) => (v == null ? v : v[k]), e);
  const strays = events
    .map((e) => readKey(e))
    .filter((v) => v !== target);
  if (strays.length) {
    const seen = [...new Set(strays.map((v) => String(v)))].slice(0, 5);
    throw new Error(
      `${strays.length} of ${events.length} events are not from ${target} (saw ${seen.join(', ')}) — `
      + `the filter on ${scriptKey} did not hold. Do NOT archive this run.`,
    );
  }
}

/**
 * Which field carries the script name is not something to guess: a wrong key
 * silently matches nothing, and «no events» is exactly the answer that must
 * never be produced by a bug. The key is resolved against the store's own key
 * list and the run fails loudly when none of the candidates exists.
 */
export const SCRIPT_KEY_CANDIDATES = ['$metadata.service', '$workers.scriptName', '$metadata.scriptName', 'scriptName'];

export function pickScriptKey(availableKeys) {
  const names = new Set(availableKeys.map((k) => (typeof k === 'string' ? k : k?.key)).filter(Boolean));
  const hit = SCRIPT_KEY_CANDIDATES.find((c) => names.has(c));
  if (!hit) {
    throw new Error(
      `none of the known script-name keys (${SCRIPT_KEY_CANDIDATES.join(', ')}) exists in this store; `
      + `available: ${[...names].slice(0, 20).join(', ')}. Refusing to export unfiltered.`,
    );
  }
  return hit;
}

/**
 * Archive name: mode, target and the EXACT interval. Two exports on one day —
 * a daily one and an hourly delivery check — must not collide, and the first
 * version's `YYYY-MM-DD-mode.json` let the second destroy the first.
 */
export function archiveName(mode, target, fromMs, toMs) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp(fromMs)}--${stamp(toMs)}-${mode}-${target}.json`;
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

async function cfPost(url, token, body, asJson, what) {
  const res = await fetch(url, {
    method: 'POST',
    headers: asJson
      ? { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      : { Authorization: `Bearer ${token}` },
    body: asJson ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} — ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: non-JSON answer — ${text.slice(0, 200)}`);
  }
}

/**
 * Atomic and NON-DESTRUCTIVE.
 *
 * Written to a sibling temp file and renamed, so a process killed mid-write
 * never leaves a half-file under the real name — and an existing archive is
 * never replaced: evidence that is already on disk is not this tool's to
 * destroy. The temp file is removed on every failure path.
 */
export async function writeArchive(dir, name, payload) {
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, name);
  // Unique per PROCESS, not just per pid: two runs on one machine must not
  // collide on the temp file either.
  const tmp = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    // `link` is an ATOMIC create-if-absent: it fails with EEXIST rather than
    // replacing. A `stat` followed by `rename` — what this used to do — leaves
    // a window in which another process publishes between the two, and both
    // runs then report success while only one file survives.
    try {
      await link(tmp, finalPath);
    } catch (e) {
      if (e?.code === 'EEXIST') {
        throw new Error(`archive already exists: ${finalPath} — refusing to overwrite evidence`);
      }
      throw e;
    }
  } finally {
    // Always: the content now lives at `finalPath` through the hard link, and
    // a failure anywhere above must not leave debris. The write itself is
    // INSIDE the try, so a failure during it is cleaned up too.
    await rm(tmp, { force: true });
  }
  return finalPath;
}

// ── Exports ───────────────────────────────────────────────────────────

async function exportMetrics({ accountId, dataset, fromMs, toMs, fetchImpl }) {
  const token = await credential('CF_ANALYTICS_TOKEN', 'CF_ANALYTICS_TOKEN_FILE');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const from = sqlTime(fromMs);
  const to = sqlTime(toMs);
  const post = (sql, what) => cfPost(url, token, sql, false, what);

  const reports = {};
  for (const report of REPORTS) {
    const doc = await post(reportSqlAbsolute(report, dataset, from, to), report);
    if (!Array.isArray(doc?.data)) throw new Error(`${report}: no data array in the answer`);
    reports[report] = doc.data;
    console.log(`  ${report}: ${doc.data.length} row(s)`);
  }

  const rawDoc = await post(rawRowsSqlAbsolute(dataset, from, to), 'raw');
  if (!Array.isArray(rawDoc?.data)) throw new Error('raw: no data array in the answer');
  if (rawDoc.data.length >= RAW_ROW_LIMIT) {
    throw new Error(
      `raw rows hit the ${RAW_ROW_LIMIT} cap — the export may be truncated. Narrow --hours; `
      + 'do NOT archive this run.',
    );
  }
  console.log(`  raw rows: ${rawDoc.data.length}`);

  return {
    at: new Date().toISOString(), kind: 'metrics', dataset,
    interval: { from, to, fromMs, toMs },
    reports, raw: rawDoc.data,
  };
}

async function exportLogs({ accountId, target, fromMs, toMs, sliceMs, expectProbe }) {
  const token = await credential('CF_LOGS_TOKEN', 'CF_LOGS_TOKEN_FILE');
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry`;

  const keysDoc = await cfPost(`${base}/keys`, token, {
    timeframe: { from: fromMs, to: toMs }, datasets: ['cloudflare-workers'], limit: 200,
  }, true, 'keys');
  const scriptKey = pickScriptKey(unwrap(keysDoc, 'keys') ?? []);
  console.log(`  script-name key: ${scriptKey}`);

  const post = (body, what) => cfPost(`${base}/query`, token, body, true, what);
  const slices = sliceRange(fromMs, toMs, sliceMs);
  const events = [];
  const sliceMeta = [];
  for (const slice of slices) {
    const { events: batch, abrLevel, runStatus } = await collectSlice({ post, slice, scriptKey, target });
    events.push(...batch);
    sliceMeta.push({
      from: new Date(slice.from).toISOString(), to: new Date(slice.to).toISOString(),
      events: batch.length, abrLevel, runStatus,
    });
    console.log(`  ${new Date(slice.from).toISOString()} .. ${new Date(slice.to).toISOString()}: ${batch.length} event(s)`);
  }

  const critical = criticalLines(events);
  const probes = probeLines(events);
  console.log(`  total ${events.length} event(s): ${critical.length} critical, ${probes.length} probe`);
  if (expectProbe) console.log(`  probe ${expectProbe}: seen ${assertProbeSeen(events, expectProbe)} time(s)`);
  if (events.length === 0) {
    console.log('  ! ZERO events for this worker in the whole range — that is what «logs were never');
    console.log('  ! collected» looks like. Do not read it as «nothing happened».');
  }
  return {
    at: new Date().toISOString(), kind: 'logs', target, scriptKey,
    interval: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs },
    sliceMinutes: sliceMs / 60_000, slices: sliceMeta,
    counts: { events: events.length, critical: critical.length, probes: probes.length },
    expectProbe: expectProbe ?? null,
    critical, probes, events,
  };
}

export const MAX_SPAN_MS = 168 * 3600_000;

/**
 * The interval of a run, fixed BEFORE the first request.
 *
 * `--hours` is relative to now, which makes two runs of the same command cover
 * two different windows: convenient daily, useless for archiving a NAMED
 * window and for re-running the identical export (the archive name carries the
 * interval, so a relative run never collides and the overwrite refusal is
 * never exercised). `--from/--to` give the reproducible form.
 */
export const SECOND_MS = 1000;

export function resolveInterval(opts, nowMs) {
  const hasAbsolute = opts.from !== null || opts.to !== null;
  if (!hasAbsolute) {
    // Floored to a whole second BEFORE anything derives from it. `--hours` is a
    // whole number of seconds, so the lower bound stays exact too.
    const toMs = Math.floor(nowMs / SECOND_MS) * SECOND_MS;
    return { fromMs: toMs - opts.hours * 3600_000, toMs };
  }
  if (opts.from === null || opts.to === null) throw new Error('--from and --to must be given together');
  if (opts.hoursGiven) throw new Error('--hours cannot be combined with --from/--to');
  const fromMs = Date.parse(opts.from);
  const toMs = Date.parse(opts.to);
  if (!Number.isFinite(fromMs)) throw new Error(`--from is not a timestamp: ${opts.from}`);
  if (!Number.isFinite(toMs)) throw new Error(`--to is not a timestamp: ${opts.to}`);
  // NOT rounded silently. `sqlTime` truncates to a whole second, so a bound of
  // 12:00:00.900 would make Analytics Engine read from 12:00:00 while the
  // metadata and the archive NAME still claimed 12:00:00.900 — an archive of a
  // different interval than the one it says it holds. What the operator typed
  // is either exact or refused.
  if (fromMs % SECOND_MS !== 0 || toMs % SECOND_MS !== 0) {
    throw new Error(
      '--from/--to must land on whole seconds: the Analytics Engine bound has second resolution, '
      + 'so a sub-second bound would archive a different interval than its name and metadata claim',
    );
  }
  if (toMs <= fromMs) throw new Error('--to must be after --from');
  if (toMs - fromMs > MAX_SPAN_MS) throw new Error('the interval must not exceed 168 hours');
  return { fromMs, toMs };
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { hours: 24, hoursGiven: false, from: null, to: null, out: null, sliceMinutes: 60, worker: DEFAULT_WORKER, expectProbe: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--hours') { opts.hours = Number(rest[++i]); opts.hoursGiven = true; continue; }
    if (a === '--from') { opts.from = String(rest[++i] ?? ''); continue; }
    if (a === '--to') { opts.to = String(rest[++i] ?? ''); continue; }
    if (a === '--out') { opts.out = String(rest[++i] ?? ''); continue; }
    if (a === '--slice-minutes') { opts.sliceMinutes = Number(rest[++i]); continue; }
    if (a === '--worker') { opts.worker = String(rest[++i] ?? ''); continue; }
    if (a === '--expect-probe') { opts.expectProbe = String(rest[++i] ?? ''); continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.hours) || opts.hours < 1 || opts.hours > 168) {
    throw new Error('--hours must be an integer in 1..168');
  }
  if (!Number.isInteger(opts.sliceMinutes) || opts.sliceMinutes < 1) {
    throw new Error('--slice-minutes must be a positive integer');
  }
  if (!/^[a-z0-9-]{1,64}$/.test(opts.worker)) throw new Error('--worker must be a script name');
  if (opts.expectProbe !== null && !/^[0-9a-f-]{36}$/.test(opts.expectProbe)) {
    throw new Error('--expect-probe must be the probeId the endpoint returned');
  }
  // Refused HERE, before any request goes out. `metrics` reads Analytics
  // Engine, which holds no log lines at all, so the flag could only be
  // ignored — and an ignored delivery check that still writes an archive and
  // exits 0 reports success for a check that never ran.
  if (opts.expectProbe !== null && mode !== 'logs') {
    throw new Error(`--expect-probe applies only to \`logs\`; in \`${mode}\` there are no log lines to find it in`);
  }
  return { mode, opts };
}

export async function main(argv) {
  const { mode, opts } = parseArgs(argv);
  if (!['metrics', 'logs'].includes(mode)) {
    console.error('usage: metrics-export.mjs <metrics | logs> [--hours N | --from ISO --to ISO] [--slice-minutes N] [--worker NAME] [--expect-probe UUID] [--out DIR]');
    return 2;
  }
  const accountId = process.env.CF_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
  const dataset = process.env.METRICS_DATASET ?? DEFAULT_DATASET;
  const outDir = opts.out ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.eternal-notes-soak', 'snapshots');
  // ONE interval for the whole run, fixed before the first request.
  const { fromMs, toMs } = resolveInterval(opts, Date.now());

  console.log(`${mode}: ${new Date(fromMs).toISOString()} .. ${new Date(toMs).toISOString()} → ${outDir}`);
  const payload = mode === 'metrics'
    ? await exportMetrics({ accountId, dataset, fromMs, toMs })
    : await exportLogs({ accountId, target: opts.worker, fromMs, toMs, sliceMs: opts.sliceMinutes * 60_000, expectProbe: opts.expectProbe });

  const target = mode === 'metrics' ? dataset : opts.worker;
  const path = await writeArchive(outDir, archiveName(mode, target, fromMs, toMs), payload);
  console.log(`kept: ${path}`);
  return 0;
}

if (process.argv[1]?.endsWith('metrics-export.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`✗ ${err?.message ?? err}`); process.exitCode = 1; },
  );
}
