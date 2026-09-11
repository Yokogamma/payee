import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { buildMetricsReportSql, METRICS_REPORTS } from '../src/metrics.ts';
import {
  REPORTS, reportSql, reportSqlAbsolute, rawRowsSqlAbsolute, indexFilter, sqlTime,
  sliceRange, assertSliceComplete, assertNotSampled, assertAllFromWorker, pickScriptKey,
  unwrap, archiveName, writeArchive, parseArgs, collectSlice, nextCursor, eventId,
  assertRunComplete, assertNoTruncatedEvents, COMPLETED_RUN_STATUS, resolveInterval, MAX_SPAN_MS, SECOND_MS, INGEST_LAG_MS,
  LOG_PAGE_LIMIT, LOG_QUERY_LIMIT, RAW_ROW_LIMIT, SCRIPT_KEY_CANDIDATES,
  messageOf, probeLines, assertProbeSeen, parseStructured, criticalLines, structuredOf,
} from './metrics-export.mjs';

const tmpDir = () => join(tmpdir(), `mx-${randomUUID()}`);

/**
 * The drift guard. This script exists because `/admin/metrics` is served BY the
 * worker: roll the worker back below the index split and its reader stops
 * seeing the new rows. A second reader is only useful while it reads the SAME
 * thing, so the two are compared character for character.
 */
describe('the standalone reader does not drift from the worker', () => {
  it('covers exactly the same reports', () => {
    expect([...REPORTS].sort()).toEqual([...METRICS_REPORTS].sort());
  });

  it('produces byte-identical SQL for every report and every horizon', () => {
    for (const report of METRICS_REPORTS) {
      for (const hours of [1, 24, 168]) {
        expect(reportSql(report, 'eternal_notes_metrics', hours))
          .toBe(buildMetricsReportSql(report, 'eternal_notes_metrics', hours));
      }
    }
  });

  it('reads BOTH index schemas', () => {
    expect(indexFilter('upload_outcome'))
      .toBe("(index1 = 'upload_outcome' OR index1 LIKE 'upload_outcome:%')");
  });
});

/**
 * `NOW()` is evaluated per statement, so a five-statement run would cover five
 * different windows and the raw rows would not add up to the aggregates they
 * exist to explain.
 */
describe('the archive uses ONE fixed interval, not NOW()', () => {
  const from = sqlTime(Date.UTC(2026, 8, 8, 12, 0, 0));
  const to = sqlTime(Date.UTC(2026, 8, 8, 13, 0, 0));

  it('formats time the way toDateTime wants it', () => {
    expect(from).toBe('2026-09-08 12:00:00');
    expect(from).not.toMatch(/[TZ]/);
  });

  it('pins every report and the raw rows to the SAME bounds', () => {
    const bounds = `timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}')`;
    for (const report of METRICS_REPORTS) {
      const sql = reportSqlAbsolute(report, 'eternal_notes_metrics', from, to);
      expect(sql).toContain(bounds);
      expect(sql).not.toContain('NOW()');
    }
    const raw = rawRowsSqlAbsolute('eternal_notes_metrics', from, to);
    expect(raw).toContain(bounds);
    expect(raw).not.toContain('NOW()');
    expect(raw).toContain(`LIMIT ${RAW_ROW_LIMIT}`);
  });

  it('refuses an unknown report rather than exporting nothing', () => {
    expect(() => reportSqlAbsolute('nope', 'd', from, to)).toThrow(/unknown report/);
  });
});

/**
 * Every guard below exists because its absence produced a SHORT FILE that
 * looked like a successful export — the one failure mode this tool must not
 * have, because the file is later read as «nothing happened».
 */
describe('an incomplete answer is refused, never archived', () => {
  it('a 200 carrying success:false is a failure, not an empty result', () => {
    expect(() => unwrap({ success: false, errors: [{ message: 'nope' }] }, 'query'))
      .toThrow(/API reported failure.*nope/s);
    expect(() => unwrap({ success: true }, 'query')).toThrow(/no result/);
    expect(() => unwrap(null, 'query')).toThrow(/not an object/);
    expect(unwrap({ success: true, result: { events: [] } }, 'query')).toEqual({ events: [] });
  });

  it('a sampled answer (abr_level > 1) is refused — its counts are estimates', () => {
    const slice = { from: 0, to: 3600_000 };
    expect(() => assertNotSampled({ abr_level: 10 }, slice)).toThrow(/abr_level=10.*SAMPLED.*do NOT archive/s);
    expect(assertNotSampled({ abr_level: 1 }, slice)).toBe(1);
    expect(assertNotSampled({}, slice)).toBe(null);
    expect(assertNotSampled(undefined, slice)).toBe(null);
  });

  it('a slice that reaches the query cap is refused', () => {
    const slice = { from: 0, to: 3600_000 };
    expect(() => assertSliceComplete(LOG_QUERY_LIMIT, slice))
      .toThrow(/query cap.*smaller --slice-minutes.*do NOT archive/s);
    expect(() => assertSliceComplete(LOG_QUERY_LIMIT - 1, slice)).not.toThrow();
  });

  it('the page size and the per-slice cap are different knobs', () => {
    // Passing one number to both made the completeness check meaningless.
    expect(LOG_PAGE_LIMIT).toBe(100);
    expect(LOG_QUERY_LIMIT).toBe(2000);
    expect(LOG_PAGE_LIMIT).toBeLessThan(LOG_QUERY_LIMIT);
  });
});

/**
 * A delivery check that passes on somebody else's traffic proves nothing about
 * this worker — and that is exactly what an unfiltered query did.
 */
describe('events must belong to the worker that was asked for', () => {
  const key = '$metadata.service';
  const ev = (service) => ({ $metadata: { service } });

  it('passes when every event is from the target', () => {
    expect(() => assertAllFromWorker([ev('eternal-notes-proxy'), ev('eternal-notes-proxy')], key, 'eternal-notes-proxy'))
      .not.toThrow();
    expect(() => assertAllFromWorker([], key, 'eternal-notes-proxy')).not.toThrow();
  });

  it('refuses a single stray event from another worker', () => {
    expect(() => assertAllFromWorker([ev('eternal-notes-proxy'), ev('unrelated-worker')], key, 'eternal-notes-proxy'))
      .toThrow(/1 of 2 events are not from eternal-notes-proxy.*unrelated-worker.*NOT archive/si);
  });

  it('refuses events with the key missing — a wrong filter key must not read as a match', () => {
    expect(() => assertAllFromWorker([{}], key, 'eternal-notes-proxy')).toThrow(/not from/);
  });

  it('resolves the script-name key from the store instead of guessing it', () => {
    expect(pickScriptKey(['$metadata.message', '$metadata.service'])).toBe('$metadata.service');
    expect(pickScriptKey([{ key: '$workers.scriptName' }])).toBe('$workers.scriptName');
    // A wrong key would silently match nothing, and «no events» is the answer
    // that must never come from a bug.
    expect(() => pickScriptKey(['$metadata.message'])).toThrow(/none of the known script-name keys/);
    expect(() => pickScriptKey([])).toThrow(/Refusing to export unfiltered/);
    expect(SCRIPT_KEY_CANDIDATES.length).toBeGreaterThan(1);
  });
});

describe('sliceRange', () => {
  const H = 3600_000;

  it('covers the range exactly: no gap, no overlap, last slice clamped', () => {
    const slices = sliceRange(0, 2.5 * H, H);
    expect(slices).toEqual([{ from: 0, to: H }, { from: H, to: 2 * H }, { from: 2 * H, to: 2.5 * H }]);
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBe(slices[i - 1].to);
  });

  it('refuses a range or slice that cannot produce a complete export', () => {
    expect(() => sliceRange(10, 10, H)).toThrow(/bad range/);
    expect(() => sliceRange(20, 10, H)).toThrow(/bad range/);
    expect(() => sliceRange(0, H, 0)).toThrow(/bad slice/);
    expect(() => sliceRange(NaN, H, H)).toThrow(/bad range/);
  });
});

/**
 * Evidence already on disk is not this tool's to destroy. The first version
 * named files by date alone, so an hourly delivery check overwrote that day's
 * full export.
 */
describe('archives are unique, atomic and never overwritten', () => {
  const a = Date.UTC(2026, 8, 9, 0, 0, 0);
  const b = Date.UTC(2026, 8, 10, 0, 0, 0);
  const c = Date.UTC(2026, 8, 9, 23, 0, 0);

  it('names by mode, target and the EXACT interval', () => {
    const daily = archiveName('logs', 'eternal-notes-proxy', a, b);
    const hourly = archiveName('logs', 'eternal-notes-proxy', c, b);
    expect(daily).not.toBe(hourly);            // the collision that destroyed evidence
    expect(daily).toContain('eternal-notes-proxy');
    expect(daily).toContain('logs');
    expect(daily).not.toContain(':');          // usable as a filename on Windows
    expect(archiveName('metrics', 'eternal_notes_metrics', a, b)).not.toBe(daily);
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const dir = tmpDir();
    const path = await writeArchive(dir, 'x.json', { ok: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true });
    expect((await readdir(dir)).filter(f => f.includes('.tmp'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('REFUSES to overwrite an existing archive, and cleans up after itself', async () => {
    const dir = tmpDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.json'), '{"first":true}\n');

    await expect(writeArchive(dir, 'x.json', { second: true }))
      .rejects.toThrow(/already exists.*refusing to overwrite evidence/s);

    // The original survived, and the failed run left no debris.
    expect(JSON.parse(await readFile(join(dir, 'x.json'), 'utf8'))).toEqual({ first: true });
    expect((await readdir(dir)).filter(f => f.includes('.tmp'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('parseArgs', () => {
  it('reads the modes and flags', () => {
    expect(parseArgs(['metrics'])).toEqual({
      mode: 'metrics',
      opts: { hours: 24, hoursGiven: false, from: null, to: null, out: null, sliceMinutes: 60, worker: 'eternal-notes-proxy', expectProbe: null },
    });
    expect(parseArgs(['logs', '--hours', '168', '--slice-minutes', '15', '--out', 'D', '--worker', 'w-1']))
      .toEqual({ mode: 'logs', opts: { hours: 168, hoursGiven: true, from: null, to: null, out: 'D', sliceMinutes: 15, worker: 'w-1', expectProbe: null } });
  });

  it('refuses junk rather than exporting a wrong range', () => {
    expect(() => parseArgs(['logs', '--hours', '0'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--hours', '169'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--hours', '1.5'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--slice-minutes', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['logs', '--worker', 'Bad Name'])).toThrow(/script name/);
    expect(() => parseArgs(['logs', '--nope'])).toThrow(/unknown argument/);
  });
});
/**
 * Paging, end to end, without a network.
 *
 * The previous version incremented a NUMBER inside `parameters` and never
 * asked for page two: the API pages `view: 'events'` by the id of the last
 * event, at the TOP level. A one-page export of a multi-page slice is the
 * silent short file this tool exists to prevent.
 */
describe('paging follows the documented cursor', () => {
  const slice = { from: 0, to: 3600_000 };
  const KEY = '$metadata.service';
  const ev = (id) => ({ $metadata: { id, service: 'w' } });
  const page = (n, first) => Array.from({ length: n }, (_, i) => ev(`id-${first + i}`));
  const ok = (events, over = {}) => ({
    success: true,
    result: { run: { status: 'COMPLETED' }, statistics: { abr_level: 1 }, events: { events }, ...over },
  });

  it('sends the last $metadata.id as a TOP-LEVEL offset until a short page ends it', async () => {
    const sent = [];
    const post = async (body) => {
      sent.push(body);
      if (sent.length === 1) return ok(page(LOG_PAGE_LIMIT, 0));
      if (sent.length === 2) return ok(page(LOG_PAGE_LIMIT, 100));
      return ok(page(5, 200));
    };

    const { events, pages, runStatus, abrLevel } = await collectSlice({ post, slice, scriptKey: KEY, target: 'w' });

    expect(events).toHaveLength(2 * LOG_PAGE_LIMIT + 5);
    // the archived proof of paging: every page size, in order, second one non-empty
    expect(pages).toEqual([LOG_PAGE_LIMIT, LOG_PAGE_LIMIT, 5]);
    expect(sent).toHaveLength(3);
    expect(sent[0].offset).toBeUndefined();            // the first page carries no cursor
    expect(sent[1].offset).toBe('id-99');              // the LAST id of page one…
    expect(sent[2].offset).toBe('id-199');             // …then of page two
    expect(sent[1].parameters.offset).toBeUndefined(); // NOT a number inside parameters
    // Measured live: the TOP-LEVEL limit is the page size; parameters.limit is
    // not a page knob for view:'events' and is not sent at all.
    expect(sent[1].limit).toBe(LOG_PAGE_LIMIT);
    expect(sent[1].parameters.limit).toBeUndefined();
    expect(sent[1].parameters.filters).toEqual([{ key: KEY, operation: 'eq', value: 'w', type: 'string' }]);
    expect(runStatus).toBe('COMPLETED');
    expect(abrLevel).toBe(1);
  });

  it('a single short page needs no second request', async () => {
    let calls = 0;
    const post = async () => { calls += 1; return ok(page(3, 0)); };
    const { events, pages } = await collectSlice({ post, slice, scriptKey: KEY, target: 'w' });
    expect(events).toHaveLength(3);
    expect(pages).toEqual([3]);
    expect(calls).toBe(1);
  });

  it('an empty first page ends the slice without a cursor', async () => {
    let calls = 0;
    const post = async () => { calls += 1; return ok([]); };
    const { events, pages } = await collectSlice({ post, slice, scriptKey: KEY, target: 'w' });
    expect(events).toEqual([]);
    expect(pages).toEqual([0]);
    expect(calls).toBe(1);
  });

  it('refuses a cursor that does not advance — paging would loop or repeat', async () => {
    const post = async () => ok(page(LOG_PAGE_LIMIT, 0)); // always the same last id
    await expect(collectSlice({ post, slice, scriptKey: KEY, target: 'w' }))
      .rejects.toThrow(/cursor did not advance.*NOT archive/si);
  });

  it('refuses a full page whose last event has no id', async () => {
    const post = async () => ok([...page(LOG_PAGE_LIMIT - 1, 0), { $metadata: { service: 'w' } }]);
    await expect(collectSlice({ post, slice, scriptKey: KEY, target: 'w' }))
      .rejects.toThrow(/no \$metadata\.id.*cannot page safely/s);
  });

  it('nextCursor is null on a short page and refuses a repeat', () => {
    expect(nextCursor([], null)).toBe(null);
    expect(nextCursor([ev('a')], null)).toBe('a');
    expect(() => nextCursor([ev('a')], 'a')).toThrow(/did not advance/);
    expect(eventId(ev('z'))).toBe('z');
  });
});

/**
 * `success: true` says the REQUEST was accepted, not that the query finished.
 * A run still STARTED answers with what it had so far — and that answer passed
 * every other check here and was archived with exit 0.
 */
describe('a query that has not finished is refused', () => {
  const slice = { from: 0, to: 3600_000 };

  it('refuses run.status STARTED', () => {
    expect(() => assertRunComplete({ status: 'STARTED' }, slice))
      .toThrow(/run\.status=STARTED.*had not finished.*NOT archive/si);
  });

  it('refuses an ABSENT status — unverifiable completion is not completion', () => {
    expect(() => assertRunComplete({}, slice)).toThrow(/no run\.status/);
    expect(() => assertRunComplete(undefined, slice)).toThrow(/no run\.status/);
    expect(() => assertRunComplete({ status: '' }, slice)).toThrow(/no run\.status/);
  });

  // The documented enum is exactly STARTED | COMPLETED. Matching loosely would
  // risk accepting a status that does not mean completion.
  it('accepts ONLY the exact documented status', () => {
    expect(COMPLETED_RUN_STATUS).toBe('COMPLETED');
    expect(assertRunComplete({ status: 'COMPLETED' }, slice)).toBe('COMPLETED');
    for (const wrong of ['completed', 'Completed', 'COMPLETE', 'SUCCESS', 'SUCCEEDED', 'DONE']) {
      expect(() => assertRunComplete({ status: wrong }, slice)).toThrow(/had not finished/);
    }
  });

  it('the whole slice fails on it, not just the page', async () => {
    const post = async () => ({
      success: true,
      result: { run: { status: 'STARTED' }, statistics: { abr_level: 1 }, events: { events: [] } },
    });
    await expect(collectSlice({ post, slice, scriptKey: '$metadata.service', target: 'w' }))
      .rejects.toThrow(/had not finished/);
  });
});

/**
 * A truncated event is not the event: the message may be cut exactly where the
 * `{"critical":…}` payload sits, turning a recorded defect into an unreadable
 * line.
 */
describe('truncated events are refused', () => {
  const slice = { from: 0, to: 3600_000 };

  it('refuses a batch carrying a truncated event', () => {
    expect(() => assertNoTruncatedEvents([{}, { $workers: { truncated: true } }], slice))
      .toThrow(/1 of 2 events are marked truncated.*NOT archive/si);
    expect(() => assertNoTruncatedEvents([{ $workers: { truncated: false } }], slice)).not.toThrow();
  });

  it('the whole slice fails on it', async () => {
    const post = async () => ({
      success: true,
      result: {
        run: { status: 'COMPLETED' }, statistics: { abr_level: 1 },
        events: { events: [{ $metadata: { id: 'a', service: 'w' }, $workers: { truncated: true } }] },
      },
    });
    await expect(collectSlice({ post, slice, scriptKey: '$metadata.service', target: 'w' }))
      .rejects.toThrow(/marked truncated/);
  });
});

/**
 * `stat` then `rename` leaves a window in which another process publishes
 * between the two: both runs report success and one result is lost.
 */
describe('concurrent publication', () => {
  it('two simultaneous publishes: exactly one wins, the other says why', async () => {
    const dir = tmpDir();
    const settled = await Promise.allSettled([
      writeArchive(dir, 'race.json', { who: 1 }),
      writeArchive(dir, 'race.json', { who: 2 }),
    ]);

    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find(r => r.status === 'rejected');
    expect(String(loser.reason)).toMatch(/already exists.*refusing to overwrite evidence/s);
    // One archive, and no temp debris from the loser.
    const left = await readdir(dir);
    expect(left.filter(f => f.includes('.tmp'))).toEqual([]);
    expect(left).toEqual(['race.json']);
    await rm(dir, { recursive: true, force: true });
  });
});
/**
 * A RELATIVE run covers a different window every time it starts, so two runs of
 * the same command never collide — which also means the overwrite refusal is
 * never reached from the CLI. Archiving a NAMED window, and re-running the
 * identical export, need absolute bounds.
 */
describe('resolveInterval', () => {
  const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
  const rel = (over = {}) => ({ hours: 24, hoursGiven: false, from: null, to: null, ...over });

  // Measured: an export 11 s after a burst lacked 10 of 130 invocations that
  // were there 72 s later. A window ending at «now» archives an incomplete
  // tail by construction, so the relative window ends behind the present.
  it('relative: ends INGEST_LAG behind now and reaches back --hours from there', () => {
    const END = NOW - INGEST_LAG_MS;
    expect(resolveInterval(rel(), NOW)).toEqual({ fromMs: END - 24 * 3600_000, toMs: END });
    expect(resolveInterval(rel({ hours: 1 }), NOW)).toEqual({ fromMs: END - 3600_000, toMs: END });
    expect(INGEST_LAG_MS).toBe(5 * 60_000);
    expect(INGEST_LAG_MS % SECOND_MS).toBe(0); // keeps the whole-second guarantee
  });

  it('relative: still lands on whole seconds after the lag', () => {
    const { fromMs, toMs } = resolveInterval(rel({ hours: 1 }), NOW + 123);
    expect(toMs % SECOND_MS).toBe(0);
    expect(fromMs % SECOND_MS).toBe(0);
    expect(toMs).toBe(NOW - INGEST_LAG_MS);
  });

  it('absolute: honoured as typed, but a --to inside the lag is flagged as a young tail', () => {
    const iso = (ms) => new Date(ms).toISOString();
    const young = resolveInterval(rel({ from: iso(NOW - 3600_000), to: iso(NOW - 60_000) }), NOW);
    expect(young).toMatchObject({ fromMs: NOW - 3600_000, toMs: NOW - 60_000, youngTail: true });
    const settled = resolveInterval(rel({ from: iso(NOW - 3600_000), to: iso(NOW - INGEST_LAG_MS) }), NOW);
    expect(settled.youngTail).toBeUndefined();
    expect(settled).toEqual({ fromMs: NOW - 3600_000, toMs: NOW - INGEST_LAG_MS });
  });

  it('two relative runs of the SAME command cover different windows', () => {
    const a = resolveInterval(rel(), NOW);
    const b = resolveInterval(rel(), NOW + 1000);
    expect(a).not.toEqual(b); // …hence never the same archive name
  });

  it('absolute: the SAME bounds every time, so a re-run hits the same archive', () => {
    const opts = rel({ from: '2026-09-09T00:00:00Z', to: '2026-09-10T00:00:00Z' });
    const first = resolveInterval(opts, NOW);
    const second = resolveInterval(opts, NOW + 86_400_000);
    expect(first).toEqual(second);
    expect(first).toEqual({ fromMs: Date.UTC(2026, 8, 9), toMs: Date.UTC(2026, 8, 10) });
  });

  it('refuses a half-given, contradictory or impossible interval', () => {
    expect(() => resolveInterval(rel({ from: '2026-09-09T00:00:00Z' }), NOW)).toThrow(/together/);
    expect(() => resolveInterval(rel({ to: '2026-09-09T00:00:00Z' }), NOW)).toThrow(/together/);
    expect(() => resolveInterval(rel({ hoursGiven: true, from: '2026-09-09T00:00:00Z', to: '2026-09-10T00:00:00Z' }), NOW))
      .toThrow(/cannot be combined/);
    expect(() => resolveInterval(rel({ from: 'yesterday', to: '2026-09-10T00:00:00Z' }), NOW)).toThrow(/not a timestamp/);
    expect(() => resolveInterval(rel({ from: '2026-09-10T00:00:00Z', to: 'soon' }), NOW)).toThrow(/not a timestamp/);
    expect(() => resolveInterval(rel({ from: '2026-09-10T00:00:00Z', to: '2026-09-10T00:00:00Z' }), NOW)).toThrow(/after --from/);
    expect(() => resolveInterval(rel({ from: '2026-09-11T00:00:00Z', to: '2026-09-10T00:00:00Z' }), NOW)).toThrow(/after --from/);
  });

  it('refuses a span past the retention the evidence can come from', () => {
    const from = new Date(NOW - MAX_SPAN_MS - 1000).toISOString();
    expect(() => resolveInterval(rel({ from, to: new Date(NOW).toISOString() }), NOW))
      .toThrow(/must not exceed 168 hours/);
  });

  it('the absolute form drives the archive name, so a re-run collides on purpose', () => {
    const opts = rel({ from: '2026-09-09T00:00:00Z', to: '2026-09-10T00:00:00Z' });
    const { fromMs, toMs } = resolveInterval(opts, NOW);
    expect(archiveName('logs', 'w', fromMs, toMs)).toBe(archiveName('logs', 'w', fromMs, toMs));
  });
});
/**
 * The bound the archive CLAIMS must be the bound the query READ.
 *
 * `sqlTime` truncates to a whole second, so a `--from` of 12:00:00.900 made
 * Analytics Engine read from 12:00:00 while the metadata and the file name
 * still said 12:00:00.900 — an archive of a different interval than the one it
 * says it holds. Precision is therefore settled in ONE place, before anything
 * derives from it.
 */
describe('interval precision is consistent across SQL, metadata and the file name', () => {
  const rel = (over = {}) => ({ hours: 24, hoursGiven: false, from: null, to: null, ...over });
  /** What the SQL bound actually means, read back as a timestamp. */
  const readBack = (ms) => Date.parse(`${sqlTime(ms)}Z`);

  it('a relative run is floored to whole seconds despite a sub-second now', () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 1) + 137; // …:01.137
    const { fromMs, toMs } = resolveInterval(rel({ hours: 1 }), now);

    expect(toMs % SECOND_MS).toBe(0);
    expect(fromMs % SECOND_MS).toBe(0);
    expect(toMs).toBe(Date.UTC(2026, 8, 10, 12, 0, 1) - INGEST_LAG_MS); // floored, then the lag
    // The SQL bound means exactly what the metadata says.
    expect(readBack(fromMs)).toBe(fromMs);
    expect(readBack(toMs)).toBe(toMs);
    // …and so does the archive name, which strips the milliseconds.
    expect(archiveName('logs', 'w', fromMs, toMs)).toContain('2026-09-10T115501Z');
    expect(archiveName('logs', 'w', fromMs, toMs)).not.toMatch(/.d{3}Z/); // no lost milliseconds to hide
  });

  it('REFUSES sub-second absolute bounds instead of silently truncating them', () => {
    // The exact reproduction: 12:00:00.900 .. 12:00:01.100 would have been read
    // as 12:00:00 .. 12:00:01.
    expect(() => resolveInterval(rel({ from: '2026-09-10T12:00:00.900Z', to: '2026-09-10T12:00:01.100Z' }), 0))
      .toThrow(/whole seconds.*second resolution.*different interval/s);
    expect(() => resolveInterval(rel({ from: '2026-09-10T12:00:00.000Z', to: '2026-09-10T12:00:01.500Z' }), 0))
      .toThrow(/whole seconds/);
    expect(() => resolveInterval(rel({ from: '2026-09-10T12:00:00.001Z', to: '2026-09-10T13:00:00Z' }), 0))
      .toThrow(/whole seconds/);
  });

  it('accepts whole-second absolute bounds and keeps them exact everywhere', () => {
    const { fromMs, toMs } = resolveInterval(rel({ from: '2026-09-09T00:00:00Z', to: '2026-09-10T00:00:00Z' }), 0);
    expect(readBack(fromMs)).toBe(fromMs);
    expect(readBack(toMs)).toBe(toMs);
    expect(sqlTime(fromMs)).toBe('2026-09-09 00:00:00');
    // The same bounds reach the SQL of every report and of the raw rows.
    const sql = reportSqlAbsolute('upload_outcomes', 'd', sqlTime(fromMs), sqlTime(toMs));
    expect(sql).toContain("toDateTime('2026-09-09 00:00:00')");
    expect(sql).toContain("toDateTime('2026-09-10 00:00:00')");
  });

  it('the whole-second rule is checked BEFORE ordering, so the message names the real problem', () => {
    expect(() => resolveInterval(rel({ from: '2026-09-10T00:00:00.500Z', to: '2026-09-09T00:00:00.500Z' }), 0))
      .toThrow(/whole seconds/);
  });
});
/**
 * The delivery check, as an assertion.
 *
 * «I did not spot the probe in the output» is not a result: a probe that was
 * written and did not arrive is precisely the failure the exercise is looking
 * for, so its absence has to fail the run rather than be read past.
 */
describe('telemetry probe in the export', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const line = (msg) => ({ $metadata: { message: msg } });
  const probe = (id) => line(`{"probe":"telemetry_probe","probeId":"${id}","at":1}`);
  const critical = line('{"critical":"conflict","noteId":"n-1"}');

  it('reads the message wherever the store puts it', () => {
    expect(messageOf({ $metadata: { message: 'a' } })).toBe('a');
    expect(messageOf({ message: 'b' })).toBe('b');
    expect(messageOf({})).toBe('');
    expect(messageOf({ $metadata: { message: 42 } })).toBe(''); // never a non-string
  });

  it('counts probes SEPARATELY from critical outcomes', () => {
    const events = [probe(ID), critical, probe(OTHER)];
    expect(probeLines(events)).toHaveLength(2);
    // A probe must never be added to a number that has to read zero.
    expect(events.filter(e => messageOf(e).includes('"critical"'))).toHaveLength(1);
  });

  it('confirms the expected probe and counts it', () => {
    expect(assertProbeSeen([critical, probe(ID)], ID)).toBe(1);
    expect(assertProbeSeen([probe(ID), probe(ID)], ID)).toBe(2);
  });

  it('FAILS when the expected probe is absent — that is the whole point', () => {
    expect(() => assertProbeSeen([critical, probe(OTHER)], ID))
      .toThrow(/probe .* is NOT in this export.*delivery check has FAILED.*must not be opened/s);
    expect(() => assertProbeSeen([], ID)).toThrow(/NOT in this export/);
  });

  it('does not accept a probe line that merely looks similar', () => {
    // Right id, but not a probe line: an ordinary log that happens to quote it.
    expect(() => assertProbeSeen([line(`{"critical":"conflict","noteId":"${ID}"}`)], ID))
      .toThrow(/NOT in this export/);
  });

  it('--expect-probe must be the id the endpoint returned', () => {
    expect(parseArgs(['logs', '--expect-probe', ID]).opts.expectProbe).toBe(ID);
    expect(() => parseArgs(['logs', '--expect-probe', 'nope'])).toThrow(/probeId the endpoint returned/);
    expect(() => parseArgs(['logs', '--expect-probe', ''])).toThrow(/probeId the endpoint returned/);
  });
});
/**
 * Classification by PARSED FIELDS, never by substring.
 *
 * A substring search accepted a line whose `probeId` was a different probe
 * while the expected id merely appeared in another field — a green delivery
 * check for an event that never arrived. The same weakness sat next to it in
 * the `critical` count.
 */
describe('lines are classified by what they ARE, not by text they contain', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const line = (msg) => ({ $metadata: { message: msg } });

  it('parses a structured line and refuses everything that is not one', () => {
    expect(parseStructured('{"a":1}')).toEqual({ a: 1 });
    expect(parseStructured('[1,2]')).toBe(null);       // an array is not a line
    expect(parseStructured('{oops')).toBe(null);       // malformed
    expect(parseStructured('ARWEAVE_POST_FAILED n-1')).toBe(null); // plain text
    expect(parseStructured('')).toBe(null);
    expect(parseStructured(null)).toBe(null);
  });

  // The exact reproduction: the expected id sits in `detail`, the real probe
  // is a different one.
  it('does NOT accept the expected id from another field', () => {
    const decoy = line(`{"probe":"telemetry_probe","probeId":"${OTHER}","detail":"${ID}"}`);
    expect(probeLines([decoy])).toHaveLength(1);       // it IS a probe line…
    expect(() => assertProbeSeen([decoy], ID)).toThrow(/NOT in this export/); // …but not THIS one
  });

  it('matches on probeId exactly', () => {
    const real = line(`{"probe":"telemetry_probe","probeId":"${ID}","at":1}`);
    expect(assertProbeSeen([real], ID)).toBe(1);
    expect(() => assertProbeSeen([real], OTHER)).toThrow(/NOT in this export/);
  });

  it('a line that merely mentions the probe type is not a probe', () => {
    const mention = line(`{"critical":"conflict","noteId":"telemetry_probe","detail":"${ID}"}`);
    expect(probeLines([mention])).toEqual([]);
    expect(() => assertProbeSeen([mention], ID)).toThrow(/NOT in this export/);
  });

  it('critical lines are counted the same way — by the field', () => {
    const real = line('{"critical":"conflict","noteId":"n-1"}');
    const quoting = line('{"probe":"telemetry_probe","probeId":"x","detail":"the word critical"}');
    const nonJson = line('ARWEAVE_POST_FAILED n-1 Error: boom');
    expect(criticalLines([real, quoting, nonJson])).toHaveLength(1);
    // …and a probe never lands in the number that must read zero.
    expect(criticalLines(probeLines([real, quoting]))).toEqual([]);
  });
});

/**
 * The shape Workers Logs ACTUALLY stores — the reproduction of the first live
 * delivery check (2026-09-11, worker 9e0a9a1, probe d6197018…).
 *
 * The probe had arrived. The exporter refused the run anyway, because it was
 * reading `$metadata.message`, and for a `console.error(JSON.stringify(x))`
 * the store fills no such field: it parses the JSON and puts the fields in
 * the top-level `source` object, next to `level`. `$metadata.error` holds
 * just the string "error". A check that fails for a shape reason is not a
 * delivery result in either direction — so the shape is pinned here verbatim.
 */
describe('the live Workers Logs event shape', () => {
  const ID = 'd6197018-8bea-4573-8d94-408270e6b129';
  const OTHER = '99999999-2222-4333-8444-555555555555';
  const meta = (extra) => ({
    id: '01K4V7…', requestId: 'f5b9fe23…', service: 'eternal-notes-proxy',
    account: 'acc', trigger: 'POST /admin/telemetry-probe', ...extra,
  });
  // A structured console.error line, as stored: parsed into `source`, no message.
  const structured = (fields) => ({
    source: { level: 'error', ...fields },
    dataset: 'cloudflare-workers', timestamp: 1789132084768,
    $workers: { truncated: false, scriptVersion: { id: '2fd1afee-3ab2-44f2-9a31-e1b526f37550' } },
    $metadata: meta({ type: 'cf-worker', level: 'error', error: 'error' }),
  });
  // The request event of the same invocation: `source.message` = the request line.
  const request = (line) => ({
    source: { level: 'info', message: line },
    dataset: 'cloudflare-workers', timestamp: 1789132084700,
    $workers: { truncated: false },
    $metadata: meta({ type: 'cf-worker-event', level: 'info', message: line }),
  });
  const liveProbe = structured({ probe: 'telemetry_probe', probeId: ID, at: 1789132084768 });
  const liveRequest = request('POST https://eternal-notes-proxy.sopi-88c.workers.dev/admin/telemetry-probe');
  const liveHealth = request('GET https://eternal-notes-proxy.sopi-88c.workers.dev/health');

  it('reads the structured line from the top-level source object', () => {
    expect(structuredOf(liveProbe)).toMatchObject({ probe: 'telemetry_probe', probeId: ID });
    // and there is nothing in the old place to read
    expect(messageOf(liveProbe)).toBe('');
  });

  it('the first live check, replayed: the probe IS in the export', () => {
    const events = [liveRequest, liveProbe, liveHealth];
    expect(probeLines(events)).toHaveLength(1);
    expect(assertProbeSeen(events, ID)).toBe(1);
    expect(criticalLines(events)).toEqual([]);
  });

  it('a request event is neither a probe nor a critical line', () => {
    expect(structuredOf(liveRequest)).toEqual({ level: 'info', message: expect.stringMatching(/^POST /) });
    expect(probeLines([liveRequest, liveHealth])).toEqual([]);
    expect(criticalLines([liveRequest, liveHealth])).toEqual([]);
    // the request line itself is still readable as text
    expect(messageOf(liveRequest)).toMatch(/^POST https:/);
  });

  it('a critical outcome in the live shape is counted by its field', () => {
    const liveCritical = structured({ critical: 'conflict', noteId: 'n-1', at: 1 });
    expect(criticalLines([liveCritical, liveProbe, liveRequest])).toHaveLength(1);
    expect(probeLines([liveCritical])).toEqual([]);
  });

  it('matches the probeId FIELD in the live shape too — a decoy stays a decoy', () => {
    const decoy = structured({ probe: 'telemetry_probe', probeId: OTHER, detail: ID });
    expect(probeLines([decoy])).toHaveLength(1);
    expect(() => assertProbeSeen([decoy], ID)).toThrow(/NOT in this export/);
    // and a plain text line quoting the id is nothing at all
    expect(structuredOf(request(`log ${ID}`))?.probe).toBeUndefined();
  });

  it('falls back to parsing the text when a store leaves the line unparsed', () => {
    const asText = `{"probe":"telemetry_probe","probeId":"${ID}","at":1}`;
    expect(structuredOf({ source: { level: 'error', message: asText } })).toMatchObject({ probeId: ID });
    expect(structuredOf({ $metadata: { message: asText } })).toMatchObject({ probeId: ID });
    expect(assertProbeSeen([{ source: { level: 'error', message: asText } }], ID)).toBe(1);
  });

  it('a source that is not an object is not a structured line', () => {
    expect(structuredOf({ source: 'error text' })).toBe(null);
    expect(structuredOf({ source: ['a'] })).toBe(null);
    expect(structuredOf({ source: null, $metadata: {} })).toBe(null);
    expect(structuredOf({})).toBe(null);
  });
});

/**
 * A flag that is accepted and then ignored reports success for a check that
 * never ran — the worst possible answer from a verification tool.
 */
describe('--expect-probe is refused where it could only be ignored', () => {
  const ID = '11111111-2222-4333-8444-555555555555';

  it('refuses the flag in `metrics`, before any request goes out', () => {
    expect(() => parseArgs(['metrics', '--expect-probe', ID]))
      .toThrow(/applies only to `logs`.*no log lines/s);
  });

  it('accepts it in `logs`', () => {
    expect(parseArgs(['logs', '--expect-probe', ID]).opts.expectProbe).toBe(ID);
  });
});
