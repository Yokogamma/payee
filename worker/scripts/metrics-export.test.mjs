import { describe, it, expect } from 'vitest';
import { buildMetricsReportSql, METRICS_REPORTS } from '../src/metrics.ts';
import {
  REPORTS, reportSql, indexFilter, sliceRange, assertNotTruncated, parseArgs, LOG_PAGE_LIMIT,
} from './metrics-export.mjs';

/**
 * The drift guard.
 *
 * This script exists because `/admin/metrics` is served BY the worker: roll the
 * worker back below the index split and its reader stops seeing the new rows.
 * A second reader is only useful while it reads the SAME thing, so the two are
 * compared character for character. If this fails, one of them was changed
 * alone — fix the pair, never the test.
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
    // Old rows (bare event) and new rows (event:discriminator). One `index1`
    // per row, so the union is a partition — it cannot double count.
    expect(indexFilter('upload_outcome'))
      .toBe("(index1 = 'upload_outcome' OR index1 LIKE 'upload_outcome:%')");
  });
});

describe('sliceRange', () => {
  const H = 3600_000;

  it('covers the range exactly: no gap, no overlap, last slice clamped', () => {
    const slices = sliceRange(0, 2.5 * H, H);
    expect(slices).toEqual([
      { from: 0, to: H },
      { from: H, to: 2 * H },
      { from: 2 * H, to: 2.5 * H },
    ]);
    expect(slices[0].from).toBe(0);
    expect(slices.at(-1).to).toBe(2.5 * H);
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBe(slices[i - 1].to);
  });

  it('returns one slice when the range is shorter than a slice', () => {
    expect(sliceRange(0, 10, H)).toEqual([{ from: 0, to: 10 }]);
  });

  it('refuses a range or slice that cannot produce a complete export', () => {
    expect(() => sliceRange(10, 10, H)).toThrow(/bad range/);
    expect(() => sliceRange(20, 10, H)).toThrow(/bad range/);
    expect(() => sliceRange(0, H, 0)).toThrow(/bad slice/);
    expect(() => sliceRange(NaN, H, H)).toThrow(/bad range/);
  });
});

/**
 * A silently short export is worse than no export: it gets archived as
 * evidence and later read as «nothing happened».
 */
describe('assertNotTruncated', () => {
  const slice = { from: 0, to: 3600_000 };

  it('passes while the answer is below the cap', () => {
    expect(() => assertNotTruncated(0, LOG_PAGE_LIMIT, slice)).not.toThrow();
    expect(() => assertNotTruncated(LOG_PAGE_LIMIT - 1, LOG_PAGE_LIMIT, slice)).not.toThrow();
  });

  it('refuses a slice that came back full, and says what to do', () => {
    expect(() => assertNotTruncated(LOG_PAGE_LIMIT, LOG_PAGE_LIMIT, slice))
      .toThrow(/may be truncated.*smaller --slice-minutes.*do NOT archive/s);
  });
});

describe('parseArgs', () => {
  it('reads the modes and flags', () => {
    expect(parseArgs(['metrics'])).toEqual({ mode: 'metrics', opts: { hours: 24, out: null, sliceMinutes: 60 } });
    expect(parseArgs(['logs', '--hours', '168', '--slice-minutes', '15', '--out', 'D']))
      .toEqual({ mode: 'logs', opts: { hours: 168, out: 'D', sliceMinutes: 15 } });
  });

  it('refuses junk rather than exporting a wrong range', () => {
    expect(() => parseArgs(['logs', '--hours', '0'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--hours', '169'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--hours', '1.5'])).toThrow(/1\.\.168/);
    expect(() => parseArgs(['logs', '--slice-minutes', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['logs', '--nope'])).toThrow(/unknown argument/);
  });
});
