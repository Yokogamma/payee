import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { buildMetricsReportSql, METRICS_REPORTS } from '../src/metrics';
import { setupOutboundMock } from './helpers/outbound-mock';

// POST /admin/metrics — the full contract (spec §R5): auth order 503→401→503,
// whitelist-only SQL, ONE response shape {rows}, upstream never proxied,
// Cache-Control: no-store on EVERY response of the path (centrally attached).

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

const { mockRoute } = setupOutboundMock();

const METRICS_SECRET = 'metrics-admin-secret-test';
const AUTH = `Bearer ${METRICS_SECRET}`;
const SQL_URL = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct-123\/analytics_engine\/sql$/;

const configuredEnv = (extra: Record<string, unknown> = {}): WorkerEnv => ({
  ...baseEnv,
  METRICS_ADMIN_SECRET: METRICS_SECRET,
  CF_ACCOUNT_ID: 'acct-123',
  CF_ANALYTICS_TOKEN: 'analytics-token-test',
  METRICS_DATASET: 'eternal_notes_metrics',
  ...extra,
}) as WorkerEnv;

function req(body: unknown, opts: { auth?: string | null; contentType?: string; method?: string; rawBody?: string } = {}): Request {
  const method = opts.method ?? 'POST';
  return new Request('https://proxy.example.com/admin/metrics', {
    method,
    headers: {
      ...(opts.contentType === undefined ? { 'Content-Type': 'application/json' }
        : opts.contentType === '' ? {} : { 'Content-Type': opts.contentType }),
      ...(opts.auth === null ? {} : { Authorization: opts.auth ?? AUTH }),
    },
    ...(method === 'GET' ? {} : { body: opts.rawBody ?? JSON.stringify(body) }),
  });
}

const UPSTREAM_OK = JSON.stringify({
  meta: [{ name: 'kind', type: 'String' }],
  data: [{ kind: 'post', host: 'arweave.net', class: '2xx', calls: 5, p95_ms: 120 }],
  rows: 1,
});

describe('auth & config order: own secret → bearer → upstream config', () => {
  it('503 while METRICS_ADMIN_SECRET is missing — even with a bearer presented', async () => {
    const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv({ METRICS_ADMIN_SECRET: undefined }));
    expect(r.status).toBe(503);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('401 on a wrong bearer AND on the ORDINARY ADMIN_SECRET — the secrets are separate', async () => {
    for (const auth of ['Bearer wrong', 'Bearer test-admin-secret']) {
      const r = await worker.fetch(req({ report: 'gateway_health' }, { auth }), configuredEnv());
      expect(r.status).toBe(401);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('503 when upstream config is incomplete or the dataset name is not a SQL identifier', async () => {
    const variants = [
      { CF_ACCOUNT_ID: '' },
      { CF_ANALYTICS_TOKEN: undefined },
      { METRICS_DATASET: 'Bad;DROP TABLE x' },
      { METRICS_DATASET: undefined },
    ];
    for (const extra of variants) {
      const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv(extra));
      expect(r.status).toBe(503);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});

describe('request validation', () => {
  it('400 on a report outside the whitelist and on malformed JSON', async () => {
    const r1 = await worker.fetch(req({ report: 'free_form_sql' }), configuredEnv());
    expect(r1.status).toBe(400);
    const r2 = await worker.fetch(req(null, { rawBody: 'not json' }), configuredEnv());
    expect(r2.status).toBe(400);
    expect(r2.headers.get('Cache-Control')).toBe('no-store');
  });

  it('400 on hours outside 1..168 or non-integer (M7)', async () => {
    for (const hours of [0, 169, 1.5, '24', null]) {
      const r = await worker.fetch(req({ report: 'gateway_health', hours }), configuredEnv());
      expect(r.status).toBe(400);
    }
  });

  it('413 when the request body exceeds the 1 KiB cap — authenticated ≠ exempt', async () => {
    const r = await worker.fetch(
      req(null, { rawBody: JSON.stringify({ report: 'gateway_health', pad: 'x'.repeat(2048) }) }),
      configuredEnv(),
    );
    expect(r.status).toBe(413);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('415 without JSON Content-Type and 404 on a wrong method — both carry no-store', async () => {
    const r1 = await worker.fetch(req({ report: 'gateway_health' }, { contentType: 'text/plain' }), configuredEnv());
    expect(r1.status).toBe(415);
    expect(r1.headers.get('Cache-Control')).toBe('no-store');

    const r2 = await worker.fetch(req(null, { method: 'GET' }), configuredEnv());
    expect(r2.status).toBe(404);
    expect(r2.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('upstream contract: bearer, SQL text, {rows} shape, no proxying', () => {
  it('sends the WHITELISTED SQL with the analytics bearer and returns {rows: data}', async () => {
    const route = mockRoute('POST', SQL_URL, 200, UPSTREAM_OK);
    const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.json()).toEqual({
      rows: [{ kind: 'post', host: 'arweave.net', class: '2xx', calls: 5, p95_ms: 120 }],
    });
    // Exact SQL from the template registry — hours defaults to 24.
    expect(route.lastBody).toBe(buildMetricsReportSql('gateway_health', 'eternal_notes_metrics', 24));
    expect(route.lastAuthorization).toBe('Bearer analytics-token-test');
    // Unlike the paid POST, the SQL call DOES run under an AbortSignal.
    expect(route.gotSignal).toBe(true);
  });

  it('honours an explicit hours value in the template', async () => {
    const route = mockRoute('POST', SQL_URL, 200, UPSTREAM_OK);
    const r = await worker.fetch(req({ report: 'status_verdicts', hours: 48 }), configuredEnv());
    expect(r.status).toBe(200);
    expect(route.lastBody).toContain("INTERVAL '48' HOUR");
    expect(route.lastBody).toContain("index1='status_verdict'");
  });

  it('accepts every whitelisted report', async () => {
    for (const report of METRICS_REPORTS) {
      mockRoute('POST', SQL_URL, 200, UPSTREAM_OK);
      const r = await worker.fetch(req({ report }), configuredEnv());
      expect(r.status).toBe(200);
    }
  });

  it('upstream non-2xx → 502 with OUR text, never the upstream body', async () => {
    mockRoute('POST', SQL_URL, 500, 'secret upstream internals');
    const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toContain('secret upstream internals');
  });

  it('malformed JSON at upstream 2xx → 502; data not an array → 502', async () => {
    mockRoute('POST', SQL_URL, 200, 'not json at all');
    const r1 = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r1.status).toBe(502);

    mockRoute('POST', SQL_URL, 200, JSON.stringify({ meta: [], data: { sneaky: true }, rows: 1 }));
    const r2 = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r2.status).toBe(502);
  });

  it('upstream body over the 256 KiB cap → 502', async () => {
    mockRoute('POST', SQL_URL, 200, `{"data":[{"pad":"${'x'.repeat(300 * 1024)}"}]}`);
    const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r.status).toBe(502);
  });

  it('network failure / timeout on the upstream → 503', async () => {
    // No route registered → the stub throws (net-connect disabled) → 503.
    const r = await worker.fetch(req({ report: 'gateway_health' }), configuredEnv());
    expect(r.status).toBe(503);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('SQL templates are pinned (r17)', () => {
  it('gateway_health', () => {
    expect(buildMetricsReportSql('gateway_health', 'eternal_notes_metrics', 24)).toMatchInlineSnapshot(
      `"SELECT blob2 AS kind, blob3 AS host, blob4 AS class, SUM(_sample_interval) AS calls, quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms FROM eternal_notes_metrics WHERE index1='gateway_call' AND timestamp > NOW() - INTERVAL '24' HOUR GROUP BY kind, host, class LIMIT 200 FORMAT JSON"`,
    );
  });

  it('upload_outcomes', () => {
    expect(buildMetricsReportSql('upload_outcomes', 'eternal_notes_metrics', 24)).toMatchInlineSnapshot(
      `"SELECT blob2 AS outcome, blob3 AS app_version, SUM(_sample_interval) AS n FROM eternal_notes_metrics WHERE index1='upload_outcome' AND timestamp > NOW() - INTERVAL '24' HOUR GROUP BY outcome, app_version LIMIT 50 FORMAT JSON"`,
    );
  });

  it('status_verdicts', () => {
    expect(buildMetricsReportSql('status_verdicts', 'eternal_notes_metrics', 24)).toMatchInlineSnapshot(
      `"SELECT blob2 AS verdict, blob3 AS host, SUM(_sample_interval) AS n FROM eternal_notes_metrics WHERE index1='status_verdict' AND timestamp > NOW() - INTERVAL '24' HOUR GROUP BY verdict, host LIMIT 100 FORMAT JSON"`,
    );
  });

  it('every template: weighted counters, weighted-exact percentiles, FORMAT JSON, hardcoded LIMIT', () => {
    for (const report of METRICS_REPORTS) {
      const sql = buildMetricsReportSql(report, 'eternal_notes_metrics', 24);
      expect(sql).toContain('SUM(_sample_interval)');
      expect(sql).toMatch(/FORMAT JSON$/);
      expect(sql).toMatch(/LIMIT \d+ FORMAT JSON$/);
      expect(sql).not.toContain('COUNT()');
    }
    expect(buildMetricsReportSql('gateway_health', 'eternal_notes_metrics', 24))
      .toContain('quantileExactWeighted(0.95)(double1, _sample_interval)');
  });
});
