import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { buildMetricsReportSql, METRICS_REPORTS } from '../src/metrics.ts';
import {
  REPORTS, reportSql, reportSqlAbsolute, rawRowsSqlAbsolute, indexFilter, sqlTime,
  sliceRange, assertSliceComplete, assertNotSampled, assertAllFromWorker, pickScriptKey,
  unwrap, archiveName, writeArchive, parseArgs,
  LOG_PAGE_LIMIT, LOG_QUERY_LIMIT, RAW_ROW_LIMIT, SCRIPT_KEY_CANDIDATES,
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

  it('the page size and the query cap are different knobs', () => {
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
      mode: 'metrics', opts: { hours: 24, out: null, sliceMinutes: 60, worker: 'eternal-notes-proxy' },
    });
    expect(parseArgs(['logs', '--hours', '168', '--slice-minutes', '15', '--out', 'D', '--worker', 'w-1']))
      .toEqual({ mode: 'logs', opts: { hours: 168, out: 'D', sliceMinutes: 15, worker: 'w-1' } });
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
