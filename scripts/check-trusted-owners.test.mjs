import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTrustedOwners, readWorkerOwners } from './check-trusted-owners.mjs';
import {
  HISTORICAL_OWNERS,
  NEVER_REMOVE,
  HISTORICAL_OWNERS_CSV,
  STAGING_ONLY_OWNERS,
  STAGING_NEVER_REMOVE,
} from './owner-pins.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const A = 'Vgd_c_CcaG_DmGQ-dIvu_AVfq0bS1Wav9sjpQyeEPdE'; // the real dev proxy wallet
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'; // a well-formed second owner
const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'; // a well-formed stranger

/** A wrangler.toml with the two tables the gate reads, and nothing else. */
const toml = ({ prod = A, staging = A } = {}) => `
name = "eternal-notes-proxy"

[vars]
ALLOWED_ORIGINS = "https://notes.matamata.dev"
${prod === null ? '' : `TRUSTED_OWNERS = "${prod}"`}

[env.staging.vars]
ALLOWED_ORIGINS = "http://localhost:5173"
${staging === null ? '' : `TRUSTED_OWNERS = "${staging}"`}
`;

describe('the repo registry itself', () => {
  it('contains every address that may never be removed', () => {
    // The monotonicity floor. If this fails, an owner was deleted from
    // HISTORICAL_OWNERS — and transactions signed by it are on chain forever.
    for (const owner of NEVER_REMOVE) {
      expect(HISTORICAL_OWNERS, `${owner} was removed from HISTORICAL_OWNERS`).toContain(owner);
    }
  });

  it('is not empty — D9 would have nothing to check an address against', () => {
    expect(HISTORICAL_OWNERS.length).toBeGreaterThan(0);
  });

  it('holds only well-formed Arweave addresses, de-duplicated', () => {
    for (const owner of HISTORICAL_OWNERS) expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(HISTORICAL_OWNERS).size).toBe(HISTORICAL_OWNERS.length);
  });
});

describe('worker coverage, per block', () => {
  it('passes when both tables carry the whole registry', () => {
    expect(checkTrustedOwners(A, toml(), { repoOnly: true })).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
  });

  it('a table with MORE owners than the registry passes — containment, not equality', () => {
    // After a rotation the deployed set legitimately runs ahead of the pin.
    // Demanding equality would push someone to delete the old owner instead.
    const verdict = checkTrustedOwners(A, toml({ prod: `${A},${B}`, staging: `${A},${B}` }), { repoOnly: true });
    expect(verdict.ok).toBe(true);
  });

  it('refuses a production table missing a registry owner', () => {
    const verdict = checkTrustedOwners(A, toml({ prod: C }), { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/production: worker TRUSTED_OWNERS is missing/);
  });

  it('refuses a STAGING table missing it, even when production is correct', () => {
    // A named environment inherits nothing, so a correct production table says
    // nothing about staging — and a file-wide search would let one cover for
    // the other.
    const verdict = checkTrustedOwners(A, toml({ staging: C }), { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/staging: worker TRUSTED_OWNERS is missing/);
    expect(verdict.problems.join('\n')).not.toMatch(/production: worker TRUSTED_OWNERS is missing/);
  });

  it('refuses an undeclared staging key with a message that says WHY it needs its own', () => {
    const verdict = checkTrustedOwners(A, toml({ staging: null }), { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/staging: TRUSTED_OWNERS is not declared/);
    expect(verdict.problems.join('\n')).toMatch(/inherits NOTHING/);
  });

  it('refuses an empty set rather than treating it as "no constraint"', () => {
    const verdict = checkTrustedOwners(A, toml({ prod: '' }), { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/production: TRUSTED_OWNERS is empty/);
  });

  it('refuses a malformed address instead of silently dropping it', () => {
    const verdict = checkTrustedOwners(A, toml({ prod: 'not-an-address' }), { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/malformed Arweave address/);
  });

  it('refuses a duplicated [vars] table — the scanner, not indexOf', () => {
    // A second table is ambiguous: the gate would read one and wrangler the
    // other. Refusing is the only answer that cannot be gamed.
    const decoy = `${toml()}\n[vars]\nTRUSTED_OWNERS = "${C}"\n`;
    const verdict = checkTrustedOwners(A, decoy, { repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/declared 2 times/);
  });
});

describe('client/worker agreement (deploy mode)', () => {
  it('passes when both halves trust the same set', () => {
    expect(checkTrustedOwners(A, toml())).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
  });

  it('refuses when the client trusts an owner the worker does not', () => {
    const verdict = checkTrustedOwners(`${A},${B}`, toml());
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/worker and client trusted-owner sets differ/);
  });

  it('refuses when the worker trusts an owner the client does not', () => {
    const verdict = checkTrustedOwners(A, toml({ prod: `${A},${B}`, staging: `${A},${B}` }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/worker and client trusted-owner sets differ/);
  });

  it('order and duplicates are not a difference — the SET is compared', () => {
    const verdict = checkTrustedOwners(`${B},${A},${A}`, toml({ prod: `${A},${B}`, staging: `${B},${A}` }));
    expect(verdict.ok).toBe(true);
  });

  it('refuses an empty client list — restore would be disabled fail-closed', () => {
    const verdict = checkTrustedOwners('', toml());
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/VITE_TRUSTED_OWNERS is missing or empty/);
  });

  it('repo-only mode does not consult the client at all', () => {
    // There is no Environment on the CI path, and comparing the pin with
    // itself would prove nothing.
    expect(checkTrustedOwners(undefined, toml(), { repoOnly: true }).ok).toBe(true);
    expect(checkTrustedOwners(undefined, toml()).ok).toBe(false);
  });
});

/**
 * A separate staging wallet (runbook P11, review 25.09 H1). Before this rule
 * the Pages gate compared BOTH worker tables with the shipped client, so the
 * only way to give staging its own wallet was to put that test wallet into
 * the production client too. Three rules now hold together: production equals
 * the client; both tables keep the historical owners; staging adds only its
 * pinned own wallet.
 */
describe('contour separation — staging on its own wallet', () => {
  const S = 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS'; // the staging wallet
  const pinned = { stagingOnly: [S] };

  it('the Pages gate passes: staging trusts its wallet, the shipped client does not', () => {
    const cfg = toml({ prod: A, staging: `${A},${S}` });
    expect(checkTrustedOwners(A, cfg, pinned)).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
    expect(checkTrustedOwners(undefined, cfg, { ...pinned, repoOnly: true }).ok).toBe(true);
  });

  it('the same staging table is refused while the wallet is NOT pinned', () => {
    const cfg = toml({ prod: A, staging: `${A},${S}` });
    for (const opts of [{}, { repoOnly: true }]) {
      const verdict = checkTrustedOwners(A, cfg, { ...opts, stagingOnly: [] });
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join('\n')).toMatch(/staging: TRUSTED_OWNERS adds S+ beyond the production set/);
    }
  });

  it('refuses the staging wallet in the shipped client — the move the old gate forced', () => {
    const verdict = checkTrustedOwners(`${A},${S}`, toml({ prod: `${A},${S}`, staging: `${A},${S}` }), pinned);
    expect(verdict.ok).toBe(false);
    const text = verdict.problems.join('\n');
    expect(text).toMatch(/VITE_TRUSTED_OWNERS contains the staging-only wallet S+/);
    expect(text).toMatch(/production: TRUSTED_OWNERS contains the staging-only wallet S+/);
  });

  it('refuses the staging wallet in production even in repo-only mode (CI, worker deploy)', () => {
    const verdict = checkTrustedOwners(undefined, toml({ prod: `${A},${S}`, staging: `${A},${S}` }), { ...pinned, repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/production: TRUSTED_OWNERS contains the staging-only wallet/);
  });

  it('refuses a staging wallet that is also a HISTORICAL owner — it would be forced into the client', () => {
    const verdict = checkTrustedOwners(A, toml(), { stagingOnly: [A] });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/is both a staging-only wallet and a HISTORICAL owner/);
  });

  it('removing a historical owner is still refused — from staging, production or the client', () => {
    const fromStaging = checkTrustedOwners(A, toml({ prod: A, staging: S }), pinned);
    expect(fromStaging.ok).toBe(false);
    expect(fromStaging.problems.join('\n')).toMatch(/staging: worker TRUSTED_OWNERS is missing/);

    const fromProduction = checkTrustedOwners(A, toml({ prod: C, staging: `${A},${S}` }), pinned);
    expect(fromProduction.ok).toBe(false);
    expect(fromProduction.problems.join('\n')).toMatch(/production: worker TRUSTED_OWNERS is missing/);

    const fromClient = checkTrustedOwners(B, toml({ prod: A, staging: `${A},${S}` }), pinned);
    expect(fromClient.ok).toBe(false);
    expect(fromClient.problems.join('\n')).toMatch(/VITE_TRUSTED_OWNERS is missing/);
  });

  it('dev diverging from the client is still refused, with or without a staging wallet', () => {
    const verdict = checkTrustedOwners(A, toml({ prod: `${A},${B}`, staging: `${A},${B},${S}` }), pinned);
    expect(verdict.ok).toBe(false);
    const text = verdict.problems.join('\n');
    expect(text).toMatch(/production: worker and client trusted-owner sets differ/);
    expect(text).toMatch(/staging: worker and client trusted-owner sets differ \(worker without its staging-only wallet/);
  });

  it('refuses staging that drops an owner production trusts — staging is production PLUS its wallet', () => {
    const verdict = checkTrustedOwners(undefined, toml({ prod: `${A},${B}`, staging: `${A},${S}` }), { ...pinned, repoOnly: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/staging: TRUSTED_OWNERS lacks B+, which production trusts/);
  });

  it('the pinned STAGING_ONLY_OWNERS is well-formed, de-duplicated, disjoint from the registry and holds its floor', () => {
    for (const owner of STAGING_ONLY_OWNERS) expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(STAGING_ONLY_OWNERS).size).toBe(STAGING_ONLY_OWNERS.length);
    for (const owner of STAGING_ONLY_OWNERS) expect(HISTORICAL_OWNERS).not.toContain(owner);
    for (const owner of STAGING_NEVER_REMOVE) {
      expect(STAGING_ONLY_OWNERS, `${owner} was removed from STAGING_ONLY_OWNERS`).toContain(owner);
    }
  });
});

/**
 * Review of #221 (25.09, Medium): a pinned staging wallet could be dropped from
 * the staging table and the gate still passed — after a paid staging
 * publication that makes it unverifiable (D9), and dropping it from the pin
 * lifted the ban on it reaching the client. The staging history is now
 * append-only and the staging table must carry all of it.
 */
describe('staging wallets are append-only history', () => {
  const OLD = 'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'; // a used staging wallet
  const NEW = 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN'; // its replacement
  const rotated = { stagingOnly: [OLD, NEW], stagingNeverRemove: [OLD, NEW] };
  const MODERN = 'de41d287a89e293d7ea611db6f4e3386355b6a74';

  it('a rotation that APPENDS passes the Pages gate — old and new staging wallets, client untouched', () => {
    expect(checkTrustedOwners(A, toml({ prod: A, staging: `${A},${OLD},${NEW}` }), rotated).ok).toBe(true);
  });

  it('a rotation that DROPS the old staging wallet from the table is refused, in every mode but the dev deploy', () => {
    const cfg = toml({ prod: A, staging: `${A},${NEW}` });
    for (const opts of [{}, { repoOnly: true }]) {
      const verdict = checkTrustedOwners(A, cfg, { ...rotated, ...opts });
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join('\n')).toMatch(/staging: TRUSTED_OWNERS is missing the pinned staging wallet O+/);
    }
  });

  it('shrinking STAGING_ONLY_OWNERS is refused — the ban on the client is not lifted silently', () => {
    // The old wallet taken out of the pin AND out of the table, then let into
    // the client: the floor literal still names it.
    const verdict = checkTrustedOwners(`${A},${OLD}`, toml({ prod: `${A},${OLD}`, staging: `${A},${OLD},${NEW}` }), {
      stagingOnly: [NEW],
      stagingNeverRemove: [OLD, NEW],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/STAGING_ONLY_OWNERS no longer contains O+/);
  });

  it('the dev deploy of a candidate cut BEFORE the pin still passes (rollback), and only with --contour=dev', () => {
    const preStaging = toml({ prod: A, staging: A }); // what 394156d's tables look like
    const dev = checkTrustedOwners(undefined, preStaging, { ...rotated, repoOnly: true, candidate: MODERN, contour: 'dev' });
    expect(dev).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });

    const ci = checkTrustedOwners(undefined, preStaging, { ...rotated, repoOnly: true, candidate: MODERN });
    expect(ci.ok).toBe(false);
    expect(ci.problems.join('\n')).toMatch(/missing the pinned staging wallet/);
  });

  it('--contour=dev waives nothing else: a staging wallet in production or an unpinned staging addition is refused', () => {
    const opts = { ...rotated, repoOnly: true, candidate: MODERN, contour: 'dev' };
    const leaked = checkTrustedOwners(undefined, toml({ prod: `${A},${OLD}`, staging: `${A},${OLD},${NEW}` }), opts);
    expect(leaked.ok).toBe(false);
    expect(leaked.problems.join('\n')).toMatch(/production: TRUSTED_OWNERS contains the staging-only wallet O+/);

    const stranger = checkTrustedOwners(undefined, toml({ prod: A, staging: `${A},${C}` }), opts);
    expect(stranger.ok).toBe(false);
    expect(stranger.problems.join('\n')).toMatch(/staging: TRUSTED_OWNERS adds C+ beyond the production set/);

    const noHistory = checkTrustedOwners(undefined, toml({ prod: A, staging: NEW }), opts);
    expect(noHistory.ok).toBe(false);
    expect(noHistory.problems.join('\n')).toMatch(/staging: worker TRUSTED_OWNERS is missing/);
  });

  it('the CLI accepts --contour=dev and refuses any other contour', () => {
    const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-trusted-owners.mjs'), '--repo-only', ...args], { encoding: 'utf8' });
    expect(run('--contour=dev').status).toBe(0);
    const bad = run('--contour=staging');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown --contour=staging/);
  });
});

describe('against the real worker/wrangler.toml', () => {
  const real = readFileSync(join(ROOT, 'worker', 'wrangler.toml'), 'utf8');

  it('both shipped tables declare TRUSTED_OWNERS', () => {
    for (const prefix of ['', 'env.staging.']) {
      const read = readWorkerOwners(real, prefix);
      expect(read.error, `${prefix || 'production'}: ${read.error ?? ''}`).toBeUndefined();
      expect(read.value).toContain(HISTORICAL_OWNERS[0]);
    }
  });

  it('the shipped config passes the repo-only gate', () => {
    expect(checkTrustedOwners(undefined, real, { repoOnly: true })).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
  });

  it('the shipped config agrees with the pinned client expectation', () => {
    // Same value scripts/check-deploy-config.mjs requires VITE_TRUSTED_OWNERS
    // to include, so the two gates cannot drift apart.
    expect(checkTrustedOwners(HISTORICAL_OWNERS_CSV, real)).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
  });
});

/**
 * The historical exception — narrow on purpose.
 *
 * ff0954d predates D9 and therefore TRUSTED_OWNERS: the var is absent and no
 * code in that build would read it, so worker coverage is vacuous. The gate
 * skips ONLY that, ONLY for that SHA. The repo registry (step 1) is still
 * verified — it belongs to this checkout, not to the candidate.
 */
describe('a registered historical candidate is exempt from worker coverage only', () => {
  const FF = 'ff0954d1799c2dc0534a4ab73c6d11d3e01645f1';
  const MODERN = 'de41d287a89e293d7ea611db6f4e3386355b6a74';
  /** What ff0954d's wrangler.toml looks like: no TRUSTED_OWNERS anywhere. */
  const preD9 = `
[vars]
STATUS_GATEWAYS = "https://arweave.net,https://ar-io.dev"
UPLOADS_ENABLED = "true"

[env.staging.vars]
STATUS_GATEWAYS = "https://arweave.net,https://ar-io.dev"
UPLOADS_ENABLED = "true"
`;

  it('passes the pre-D9 config for ff0954d, and says coverage was skipped', () => {
    const r = checkTrustedOwners(undefined, preD9, { repoOnly: true, candidate: FF });
    expect(r.ok).toBe(true);
    expect(r.skippedWorkerCoverage).toBe(true);
  });

  it('the SAME config is refused for any other SHA', () => {
    for (const candidate of [MODERN, 'b6cea2f'.padEnd(40, '0'), null]) {
      const r = checkTrustedOwners(undefined, preD9, { repoOnly: true, candidate });
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toMatch(/TRUSTED_OWNERS is not declared/);
      expect(r.skippedWorkerCoverage).toBe(false);
    }
  });

  it('the modern candidate keeps the full gate', () => {
    const r = checkTrustedOwners(A, toml(), { repoOnly: true, candidate: MODERN });
    expect(r).toEqual({ ok: true, problems: [], skippedWorkerCoverage: false });
  });
});
