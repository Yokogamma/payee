import { describe, it, expect } from 'vitest';
import { checkSpendLimits, checkSpendLimitsFile, carriesSpendGuard, SPEND_LIMIT_VARS } from './check-spend-limits.mjs';

// D10 limits gate (PR-6): applicable only to a config that carries the
// SpendGuard binding; then all three limits in BOTH blocks, digits only,
// ceiling ≤ window cap. The real worker/wrangler.toml must pass.

const guard = `
[durable_objects]
bindings = [
  { name = "SPEND_GUARD", class_name = "SpendGuard" }
]
`;
const vars = (o, prefix = '') => `
[${prefix}vars]
UPLOADS_ENABLED = "true"
${Object.entries(o).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}
`;
const GOOD = { WALLET_FLOOR_WINSTON: '70000000000', SPEND_WINDOW_CAP_WINSTON: '150000000000', MAX_TX_REWARD_WINSTON: '15000000000' };
const both = (prod = GOOD, staging = GOOD) => guard + vars(prod) + vars(staging, 'env.staging.');

describe('applicability', () => {
  it('a config without the SpendGuard binding is not applicable and passes (historical candidates)', () => {
    const r = checkSpendLimits('[vars]\nUPLOADS_ENABLED = "true"\n');
    expect(r).toMatchObject({ ok: true, applicable: false, problems: [] });
    expect(carriesSpendGuard('[durable_objects]\nbindings = [ { name = "RATE_LIMITER", class_name = "RateLimiter" } ]')).toBe(false);
  });
  it('the binding makes it applicable', () => {
    expect(carriesSpendGuard(guard)).toBe(true);
  });
});

describe('the three limits in both blocks', () => {
  it('a full, consistent pair of blocks passes and reports the values', () => {
    const r = checkSpendLimits(both());
    expect(r).toMatchObject({ ok: true, applicable: true, problems: [] });
    expect(r.limits['[vars]']).toEqual(GOOD);
    expect(r.limits['[env.staging.vars]']).toEqual(GOOD);
  });
  it.each(SPEND_LIMIT_VARS)('missing %s in [vars] fails', name => {
    const prod = { ...GOOD }; delete prod[name];
    const r = checkSpendLimits(both(prod));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`[vars]: ${name}: missing`);
  });
  it.each(SPEND_LIMIT_VARS)('missing %s in [env.staging.vars] fails — a named environment inherits nothing', name => {
    const staging = { ...GOOD }; delete staging[name];
    const r = checkSpendLimits(both(GOOD, staging));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`[env.staging.vars]: ${name}: missing`);
  });
  it('a non-digit value fails (a number literal, a decimal, an empty string)', () => {
    expect(checkSpendLimits(both({ ...GOOD, MAX_TX_REWARD_WINSTON: '1.5e9' })).problems.join('\n')).toMatch(/digits only/);
    expect(checkSpendLimits(both({ ...GOOD, WALLET_FLOOR_WINSTON: '' })).ok).toBe(false);
    expect(checkSpendLimits(guard + '[vars]\nWALLET_FLOOR_WINSTON = 70000000000\nSPEND_WINDOW_CAP_WINSTON = "1"\nMAX_TX_REWARD_WINSTON = "1"\n' + vars(GOOD, 'env.staging.')).problems.join('\n')).toMatch(/not a basic string/);
  });
  it('a ceiling above the window cap fails; zero ceiling or cap fails; a zero floor is legal', () => {
    expect(checkSpendLimits(both({ ...GOOD, MAX_TX_REWARD_WINSTON: '150000000001' })).problems.join('\n')).toMatch(/exceeds SPEND_WINDOW_CAP_WINSTON/);
    expect(checkSpendLimits(both({ ...GOOD, MAX_TX_REWARD_WINSTON: '0' })).problems.join('\n')).toMatch(/MAX_TX_REWARD_WINSTON must be > 0/);
    expect(checkSpendLimits(both({ ...GOOD, SPEND_WINDOW_CAP_WINSTON: '0', MAX_TX_REWARD_WINSTON: '0' })).ok).toBe(false);
    expect(checkSpendLimits(both({ ...GOOD, WALLET_FLOOR_WINSTON: '0' })).ok).toBe(true);
  });
  it('a duplicated table is refused, never silently read', () => {
    const r = checkSpendLimits(both() + vars(GOOD));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/declared 2 times/);
  });
});

describe('the real worker/wrangler.toml', () => {
  it('carries the guard and passes the gate', () => {
    const r = checkSpendLimitsFile();
    expect(r.applicable).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
