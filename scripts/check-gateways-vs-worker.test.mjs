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
    expect(checkGateways(EXPECTED_STATUS_CSV, toml())).toEqual({ ok: true, problems: [], skippedPayloadPool: false });
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
    expect(checkGateways(undefined, toml(), { repoOnly: true })).toEqual({ ok: true, problems: [], skippedPayloadPool: false });
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

/**
 * The historical exception — narrow on purpose.
 *
 * ff0954d is the pinned floor and the only build seed-legacy accepts, and it
 * predates PAYLOAD_GATEWAYS entirely. The gate skips ONLY that check, ONLY for
 * that SHA; the status pool — which that build does have — is still checked
 * in full. Any other SHA, including the one that introduced D9, is held to the
 * complete gate.
 */
describe('a registered historical candidate is exempt from the PAYLOAD check only', () => {
  const FF = 'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1';
  const MODERN = 'de41d287a89e293d7ea611db6f4e3386355b6a74';
  /** What ff0954d's wrangler.toml looks like: status pool yes, payload pool no. */
  const preD9 = (prod = EXPECTED_STATUS_CSV, staging = EXPECTED_STATUS_CSV) => `
[vars]
STATUS_GATEWAYS = "${prod}"
UPLOADS_ENABLED = "true"

[env.staging.vars]
STATUS_GATEWAYS = "${staging}"
UPLOADS_ENABLED = "true"
`;

  it('passes the pre-D9 config for ff0954d, and says the payload check was skipped', () => {
    const r = checkGateways(EXPECTED_STATUS_CSV, preD9(), { candidate: FF });
    expect(r.ok).toBe(true);
    expect(r.skippedPayloadPool).toBe(true);
  });

  it('the SAME config is refused for any other SHA — the exception is the SHA, not the shape', () => {
    for (const candidate of [MODERN, 'b6cea2f'.padEnd(40, '0'), null, undefined]) {
      const r = checkGateways(EXPECTED_STATUS_CSV, preD9(), { candidate });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/missing PAYLOAD_GATEWAYS/);
      expect(r.skippedPayloadPool).toBe(false);
    }
  });

  it('still checks the STATUS pool for ff0954d — that build has a quorum', () => {
    const r = checkGateways(EXPECTED_STATUS_CSV, preD9('https://only-one.example'), { candidate: FF });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/STATUS_GATEWAYS does not match the repo-pinned set/);
  });

  it('a modern config under ff0954d is not made worse — the payload check is skipped, nothing else changes', () => {
    // If someone hands the gate a modern toml with the historical SHA, the
    // status checks run exactly as before; only the payload block is bypassed.
    const r = checkGateways(EXPECTED_STATUS_CSV, toml(), { candidate: FF });
    expect(r.ok).toBe(true);
    expect(r.skippedPayloadPool).toBe(true);
  });

  it('the modern candidate keeps the full gate', () => {
    const r = checkGateways(EXPECTED_STATUS_CSV, toml(), { candidate: MODERN });
    expect(r.ok).toBe(true);
    expect(r.skippedPayloadPool).toBe(false);
  });
});
