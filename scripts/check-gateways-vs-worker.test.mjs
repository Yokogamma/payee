import { describe, it, expect } from 'vitest';
import { checkGateways, readWorkerStatusGateways } from './check-gateways-vs-worker.mjs';
import { EXPECTED_STATUS_CSV, EXPECTED_PAYLOAD_CSV, MIN_STATUS_ORIGINS } from './gateway-pins.mjs';

const toml = (
  prod = EXPECTED_STATUS_CSV,
  staging = EXPECTED_STATUS_CSV,
  { payloadProd = EXPECTED_PAYLOAD_CSV, payloadStaging = EXPECTED_PAYLOAD_CSV } = {},
) => `
name = "eternal-notes-proxy"

[vars]
ALLOWED_ORIGINS = "https://notes.example"
STATUS_GATEWAYS = "${prod}"
PAYLOAD_GATEWAYS = "${payloadProd}"
UPLOADS_ENABLED = "true"

[[analytics_engine_datasets]]
binding = "METRICS"

[env.staging]
name = "eternal-notes-proxy-staging"

[env.staging.vars]
ALLOWED_ORIGINS = "http://localhost:5173"
STATUS_GATEWAYS = "${staging}"
PAYLOAD_GATEWAYS = "${payloadStaging}"
UPLOADS_ENABLED = "true"
`;

describe('readWorkerStatusGateways', () => {
  it('reads production and staging as SEPARATE declarations', () => {
    const t = toml('https://a.example,https://b.example', 'https://c.example');
    expect(readWorkerStatusGateways(t, '').value).toBe('https://a.example,https://b.example');
    expect(readWorkerStatusGateways(t, 'env.staging.').value).toBe('https://c.example');
  });

  it('reports a missing block or a missing key instead of guessing', () => {
    expect(readWorkerStatusGateways('[vars]\nX = "1"\n', '').error).toMatch(/missing STATUS_GATEWAYS/);
    expect(readWorkerStatusGateways('', '').error).toMatch(/missing table/);
  });
});

describe('checkGateways — client and worker must mean the same pool', () => {
  it('passes when both sides equal the pin', () => {
    expect(checkGateways(EXPECTED_STATUS_CSV, toml())).toEqual({ ok: true, problems: [] });
  });

  it('normalizes before comparing: a trailing slash is the same origin', () => {
    const withSlashes = EXPECTED_STATUS_CSV.split(',').map(o => o + '/').join(',');
    expect(checkGateways(withSlashes, toml()).ok).toBe(true);
  });

  it('a duplicated entry is not a second witness', () => {
    const dup = `${EXPECTED_STATUS_CSV},https://arweave.net`;
    expect(checkGateways(dup, toml()).ok).toBe(true);
  });

  it('fails when the CLIENT list drifts from the pin', () => {
    const { ok, problems } = checkGateways('https://arweave.net,https://evil.example', toml());
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/VITE_STATUS_GATEWAYS does not match/);
  });

  it('fails when the WORKER list drifts — separately for prod and staging', () => {
    const prodDrift = checkGateways(EXPECTED_STATUS_CSV, toml('https://arweave.net,https://b.example'));
    expect(prodDrift.problems.join(' ')).toMatch(/production: worker STATUS_GATEWAYS does not match/);

    const stagingDrift = checkGateways(EXPECTED_STATUS_CSV, toml(EXPECTED_STATUS_CSV, 'https://arweave.net,https://b.example'));
    expect(stagingDrift.problems.join(' ')).toMatch(/staging: worker STATUS_GATEWAYS does not match/);
  });

  it('fails on an empty client list', () => {
    expect(checkGateways('', toml()).problems.join(' ')).toMatch(/missing, empty or fully unparseable/);
  });

  // With one origin the dead verdict is unreachable, which would disable redrop
  // rather than make it safe — the build must refuse, not ship it quietly.
  it(`fails below MIN_STATUS_ORIGINS (${MIN_STATUS_ORIGINS})`, () => {
    const one = 'https://arweave.net';
    expect(checkGateways(one, toml(one, one)).problems.join(' ')).toMatch(/fewer than MIN_STATUS_ORIGINS/);
  });

  it('--repo-only checks the worker against the pin without any Environment', () => {
    expect(checkGateways(undefined, toml(), { repoOnly: true })).toEqual({ ok: true, problems: [] });
    const drift = checkGateways(undefined, toml('https://arweave.net,https://b.example'), { repoOnly: true });
    expect(drift.ok).toBe(false);
  });
});

describe('the PAYLOAD pool (D2/D9) — pinned WITH its order', () => {
  const pinned = EXPECTED_PAYLOAD_CSV;
  const reordered = pinned.split(',').reverse().join(',');

  it('passes when both blocks match the pin exactly', () => {
    expect(checkGateways(EXPECTED_STATUS_CSV, toml()).ok).toBe(true);
  });

  it('refuses a REORDERED list — the order is part of the pin', () => {
    // The pool is tried in sequence, so reordering silently changes which
    // gateway is asked first. Contrast the status pool above, where probes run
    // in parallel and only the SET is compared.
    const verdict = checkGateways(EXPECTED_STATUS_CSV, toml(undefined, undefined, { payloadProd: reordered }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/production: worker PAYLOAD_GATEWAYS does not match/);
  });

  it('refuses a STAGING drift even when production is right', () => {
    const verdict = checkGateways(EXPECTED_STATUS_CSV, toml(undefined, undefined, { payloadStaging: reordered }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/staging: worker PAYLOAD_GATEWAYS does not match/);
    expect(verdict.problems.join('; ')).not.toMatch(/production: worker PAYLOAD_GATEWAYS/);
  });

  it('refuses an empty list', () => {
    const verdict = checkGateways(EXPECTED_STATUS_CSV, toml(undefined, undefined, { payloadProd: '' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/production: PAYLOAD_GATEWAYS is empty/);
  });

  it('refuses an undeclared key rather than treating it as unconstrained', () => {
    const withoutPayload = toml().replace(/^PAYLOAD_GATEWAYS = .*$/m, '');
    const verdict = checkGateways(EXPECTED_STATUS_CSV, withoutPayload);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('; ')).toMatch(/missing PAYLOAD_GATEWAYS/);
  });

  it('a trailing slash is not a difference — comparison is on canonized origins', () => {
    const slashed = pinned.split(',').map(o => `${o}/`).join(',');
    expect(checkGateways(EXPECTED_STATUS_CSV, toml(undefined, undefined, { payloadProd: slashed, payloadStaging: slashed })).ok)
      .toBe(true);
  });
});
