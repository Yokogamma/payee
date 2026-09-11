/**
 * Historical worker candidates — the ONE place a deploy gate may be told that a
 * release predates the thing the gate checks.
 *
 * Why this exists (2026-09-11, run 34598685134). The floor permits a rollback
 * to `ff0954d` — it IS the pinned minimum floor — and `seed-legacy` demands
 * exactly that build. But the config gates and the post-deploy smoke run from
 * the TRUSTED checkout, by design (PR #122), and they check for things that did
 * not exist yet at `ff0954d`: `PAYLOAD_GATEWAYS`, `TRUSTED_OWNERS` (both born
 * with D9 in b6cea2f) and a `semanticIdempotency: 1` in /health (D2). So the
 * rollback the floor allows was refused at the gateway gate — and had that gate
 * been loosened alone, the build would have been ACTIVATED and then failed the
 * smoke, which is the worst order of events there is.
 *
 * The floor is a necessary condition for admission, not a promise that the
 * other checks pass. This registry is how a historical candidate is admitted
 * through ALL of them consistently, or not at all.
 *
 * The rules, and each one is load-bearing:
 *
 *  - keyed by the FULL 40-hex SHA of ONE verified build. Never a range, never
 *    «every ancestor of X»: b6cea2f already carries D9 and is its own ancestor,
 *    so an ancestry rule would admit builds that need the very checks it skips;
 *  - a historical SHA may deploy ONLY under its own profile, and that profile
 *    may activate ONLY its SHA. The binding is two-way, and it is checked
 *    BEFORE materialization — a historical build under `normal` would pass the
 *    config gates only to fail the smoke after it was live;
 *  - `lacksVars` names precisely the vars whose gate is vacuous for this build
 *    because the code that reads them does not exist in it. Every other check
 *    (floor, reachability, STATUS_GATEWAYS, upload switches) still applies;
 *  - adding an entry is a reviewed change to a control-plane file, exactly
 *    like `MINIMUM_FLOOR` or the gateway pins.
 */

export const HISTORICAL_CANDIDATES = Object.freeze({
  // PR-3a: status quorum present (`all-configured-v1`), publication
  // fingerprinting absent, uploads ON. The only build `seed-legacy` accepts —
  // a note seeded on a fingerprinting worker is not legacy at all — and the
  // pinned MINIMUM_FLOOR. Deployed for one purpose: seeding legacy fixtures
  // ahead of a D2 soak window, after which the D2 candidate is deployed again.
  ff0954d1799c2dc0534a4ab73c6d11d3e01645f1: Object.freeze({
    profile: 'pre-d2',
    lacksVars: Object.freeze(['PAYLOAD_GATEWAYS', 'TRUSTED_OWNERS']),
    reason: 'PR-3a worker: quorum yes, fingerprinting no; the seed-legacy build',
  }),
});

const SHA_RE = /^[0-9a-f]{40}$/;

/** The registry entry for a candidate, or null. Only a full SHA can match. */
export function historicalCandidate(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return null;
  return HISTORICAL_CANDIDATES[sha] ?? null;
}

/** Profiles that exist only for historical candidates. */
export const HISTORICAL_PROFILES = Object.freeze(
  [...new Set(Object.values(HISTORICAL_CANDIDATES).map((c) => c.profile))],
);

/**
 * The two-way binding between a candidate and a deploy profile.
 *
 * Refuses: a historical profile with any SHA but its own; a historical SHA
 * under any profile but its own. Admits everything else untouched — a modern
 * build under `normal` or `emergency` is not this file's business.
 */
export function checkHistoricalBinding({ candidate, profile }) {
  const problems = [];
  const entry = historicalCandidate(candidate);
  const profileIsHistorical = HISTORICAL_PROFILES.includes(profile);

  if (entry && profile !== entry.profile) {
    problems.push(
      `candidate ${candidate} is the historical build «${entry.reason}» and may be deployed ONLY under ` +
        `profile "${entry.profile}", not "${profile}": under any other profile it passes the config ` +
        'gates and fails the post-deploy smoke AFTER activation.',
    );
  }
  if (profileIsHistorical && !entry) {
    problems.push(
      `profile "${profile}" exists only for a registered historical build, and ${candidate} is not one. ` +
        'A modern build under a historical profile would be waved past checks it needs.',
    );
  }
  return { ok: problems.length === 0, problems, entry };
}

/** Does this candidate's registry entry say the named var never existed in it? */
export function candidateLacksVar(candidate, varName) {
  const entry = historicalCandidate(candidate);
  return !!entry && entry.lacksVars.includes(varName);
}

if (process.argv[1]?.endsWith('historical-candidates.mjs')) {
  // The binding gate, run from the trusted checkout BEFORE the candidate is
  // materialized. Inputs through the environment, never through `${{ }}` in
  // run: (workflow invariant B).
  const candidate = process.env.WORKER_CANDIDATE_SHA ?? '';
  const profile = process.env.DEPLOY_PROFILE ?? 'normal';
  const { ok, problems, entry } = checkHistoricalBinding({ candidate, profile });
  if (!ok) {
    console.error('✗ historical-candidate binding:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    entry
      ? `✓ historical candidate ${candidate.slice(0, 7)} under its own profile "${profile}" — ` +
          `gates for ${entry.lacksVars.join(', ')} are vacuous for this build and will be skipped`
      : `✓ ${candidate.slice(0, 7)} is not a historical candidate; profile "${profile}" applies in full`,
  );
}
