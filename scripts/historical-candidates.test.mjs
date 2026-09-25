import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HISTORICAL_CANDIDATES, HISTORICAL_PROFILES,
  historicalCandidate, checkHistoricalBinding, candidateLacksVar,
} from './historical-candidates.mjs';
import { MINIMUM_FLOOR } from './check-worker-floor.mjs';
import { DEPLOY_PROFILES } from '../worker/scripts/smoke-target.mjs';

const FF = 'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1';
// b6cea2f introduced D9 (PAYLOAD_GATEWAYS, TRUSTED_OWNERS). It is its OWN
// ancestor, which is exactly why the registry is keyed by SHA and not by
// ancestry: an ancestry rule would admit the very build that needs the checks.
const B6 = 'b6cea2f'.padEnd(40, '0');
const MODERN = 'de41d287a89e293d7ea611db6f4e3386355b6a74';

describe('the registry', () => {
  it('contains exactly the seed-legacy build, keyed by its full SHA', () => {
    expect(Object.keys(HISTORICAL_CANDIDATES)).toEqual([FF]);
    expect(HISTORICAL_CANDIDATES[FF]).toMatchObject({
      profile: 'pre-d2',
      lacksVars: ['PAYLOAD_GATEWAYS', 'TRUSTED_OWNERS'],
    });
  });

  // Until the floor was raised to the D2 worker (immediately before the import
  // flip) this build WAS the pinned minimum floor, and the registry existed so
  // the rest of the pipeline could admit what the floor admitted. Since the
  // raise it is HISTORY: a strict ancestor of the pin, kept on record, and no
  // longer deployable — the profile binding still passes first, and
  // `check-worker-floor.mjs` refuses it second, before anything is
  // materialized. Both halves are asserted: the entry is not the floor, and it
  // is below it (a registry entry that were NOT an ancestor would mean the
  // floor moved to a different line of history, which is a different mistake).
  it('the historical build is NOT the pinned minimum floor', () => {
    expect(FF).not.toBe(MINIMUM_FLOOR);
  });

  // The ancestry half needs the real history. CI's checkout is shallow (no
  // fetch-depth), so there the two SHAs are not commits at all and the check
  // is SKIPPED, visibly — not passed. The deploy workflows fetch depth 0 and
  // `check-worker-floor.mjs` computes exactly this ancestry before any deploy,
  // so the property is enforced where it matters; this test pins it for a full
  // local checkout, where a wrong pin would be caught before a PR is opened.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const commitPresent = sha => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, stdio: 'ignore' }).status === 0;
  const historyAvailable = commitPresent(FF) && commitPresent(MINIMUM_FLOOR);
  it.skipIf(!historyAvailable)('… and is a strict ancestor of it (full history only; shallow CI checkout skips this)', () => {
    const isAncestor = () => execFileSync(
      'git', ['merge-base', '--is-ancestor', FF, MINIMUM_FLOOR],
      { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    expect(isAncestor).not.toThrow();
  });

  it('every historical profile exists in the smoke table, and no modern profile is historical', () => {
    for (const p of HISTORICAL_PROFILES) expect(DEPLOY_PROFILES[p]).toBeDefined();
    expect(HISTORICAL_PROFILES).not.toContain('normal');
    expect(HISTORICAL_PROFILES).not.toContain('emergency');
  });

  it('matches only a full 40-hex SHA — never a prefix, never a tag', () => {
    expect(historicalCandidate(FF)).not.toBeNull();
    expect(historicalCandidate('ff0954d')).toBeNull();
    expect(historicalCandidate(FF.toUpperCase())).toBeNull();
    expect(historicalCandidate('main')).toBeNull();
    expect(historicalCandidate(undefined)).toBeNull();
  });

  it('does NOT admit b6cea2f or any other ancestor-shaped SHA', () => {
    expect(historicalCandidate(B6)).toBeNull();
    expect(historicalCandidate(MODERN)).toBeNull();
  });
});

describe('the two-way binding', () => {
  it('admits the historical build under its own profile', () => {
    const r = checkHistoricalBinding({ candidate: FF, profile: 'pre-d2' });
    expect(r.ok).toBe(true);
    expect(r.entry).not.toBeNull();
  });

  // The P1 this exists for: under `normal` the build would pass every config
  // gate and fail the smoke only after it was live.
  it('refuses the historical build under normal and under emergency', () => {
    for (const profile of ['normal', 'emergency']) {
      const r = checkHistoricalBinding({ candidate: FF, profile });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/ONLY under profile "pre-d2".*fails the post-deploy smoke AFTER activation/s);
    }
  });

  it('refuses the historical profile with any other SHA', () => {
    for (const candidate of [MODERN, B6, '']) {
      const r = checkHistoricalBinding({ candidate, profile: 'pre-d2' });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/exists only for a registered historical build/);
    }
  });

  it('leaves modern builds alone under modern profiles', () => {
    expect(checkHistoricalBinding({ candidate: MODERN, profile: 'normal' }).ok).toBe(true);
    expect(checkHistoricalBinding({ candidate: MODERN, profile: 'emergency' }).ok).toBe(true);
  });
});

describe('vacuous gates', () => {
  it('names the vars that never existed in the build, and nothing else', () => {
    expect(candidateLacksVar(FF, 'PAYLOAD_GATEWAYS')).toBe(true);
    expect(candidateLacksVar(FF, 'TRUSTED_OWNERS')).toBe(true);
    // The quorum DID exist there — that check must keep running.
    expect(candidateLacksVar(FF, 'STATUS_GATEWAYS')).toBe(false);
    expect(candidateLacksVar(FF, 'UPLOADS_ENABLED')).toBe(false);
  });

  it('is false for every non-historical SHA', () => {
    expect(candidateLacksVar(MODERN, 'PAYLOAD_GATEWAYS')).toBe(false);
    expect(candidateLacksVar(B6, 'PAYLOAD_GATEWAYS')).toBe(false);
    expect(candidateLacksVar(null, 'PAYLOAD_GATEWAYS')).toBe(false);
  });
});
