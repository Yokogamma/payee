import { describe, it, expect } from 'vitest';
import { checkConnectSrc } from './smoke-csp-origins.mjs';
import { cspConnectOrigins } from './gateways-parse.mjs';
import { EXPECTED_PAYLOAD_CSV, EXPECTED_STATUS_CSV, INDEX_SOURCES } from './gateway-pins.mjs';

const PROXY = 'https://proxy.example';
const APPROVED = cspConnectOrigins({
  status: EXPECTED_STATUS_CSV,
  payload: EXPECTED_PAYLOAD_CSV,
  indexSources: INDEX_SOURCES,
});

const csp = (connectSrc) =>
  `default-src 'self'; script-src 'self'; connect-src ${connectSrc}; frame-ancestors 'none'`;
const good = () => csp(["'self'", ...APPROVED, PROXY].join(' '));

describe('checkConnectSrc', () => {
  it('accepts the policy the build actually generates', () => {
    expect(checkConnectSrc(good(), PROXY)).toEqual({ ok: true, problems: [] });
  });

  // A dropped origin makes that gateway unreachable from the browser while
  // every local check stays green — a multi-gateway build silently reverting to
  // a single-gateway one.
  it('fails when an approved gateway is missing', () => {
    const missing = ["'self'", ...APPROVED.slice(1), PROXY].join(' ');
    const { ok, problems } = checkConnectSrc(csp(missing), PROXY);
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/missing https:\/\//);
  });

  // An extra origin is an egress destination nobody approved.
  it('fails on an unapproved source', () => {
    const extra = ["'self'", ...APPROVED, PROXY, 'https://evil.example'].join(' ');
    const { ok, problems } = checkConnectSrc(csp(extra), PROXY);
    expect(ok).toBe(false);
    expect(problems.join(' ')).toMatch(/unapproved source: https:\/\/evil\.example/);
  });

  it("requires 'self' — the app fetches its own origin", () => {
    const withoutSelf = [...APPROVED, PROXY].join(' ');
    expect(checkConnectSrc(csp(withoutSelf), PROXY).problems.join(' ')).toMatch(/missing 'self'/);
  });

  it('requires the proxy origin', () => {
    const withoutProxy = ["'self'", ...APPROVED].join(' ');
    expect(checkConnectSrc(csp(withoutProxy), PROXY).problems.join(' ')).toMatch(/missing https:\/\/proxy/);
  });

  it('fails on a missing header or a missing directive', () => {
    expect(checkConnectSrc(null, PROXY).problems).toEqual(['no Content-Security-Policy header']);
    expect(checkConnectSrc("default-src 'self'", PROXY).problems)
      .toEqual(['CSP has no connect-src directive']);
  });

  it('is order-insensitive — the directive is a set', () => {
    const shuffled = ["'self'", PROXY, ...[...APPROVED].reverse()].join(' ');
    expect(checkConnectSrc(csp(shuffled), PROXY).ok).toBe(true);
  });
});
