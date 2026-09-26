import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { operatorsFloorFor } from './operators-floor.mjs';

// Runbook reader release §6.9 (owner decision 2026-09-27: automatic): after a
// dev deploy the smoke asserts statusOperatorsCount >= 2 — but only for a
// candidate that carries SpendGuard, so a rollback to a historical build
// (no such field in its /health) is never refused by this check.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const WITH_GUARD = `
[[durable_objects.bindings]]
name = "SPEND_GUARD"
class_name = "SpendGuard"
`;
const WITHOUT_GUARD = `
[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiter"
`;

describe('operatorsFloorFor', () => {
  it('a candidate with SpendGuard must show at least 2 independent operators; one without is not asked', () => {
    expect(operatorsFloorFor(WITH_GUARD)).toBe(2);
    expect(operatorsFloorFor(WITHOUT_GUARD)).toBeNull();
  });

  it('the repository config (the reader) carries SpendGuard → 2', () => {
    expect(operatorsFloorFor(readFileSync(join(ROOT, 'worker', 'wrangler.toml'), 'utf8'))).toBe(2);
  });
});

describe('CLI — what deploy-worker.yml appends to $GITHUB_OUTPUT', () => {
  it('prints min_operators=2 for a SpendGuard config and an empty value otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opfloor-'));
    try {
      const run = (toml) => {
        const file = join(dir, `w-${Math.random().toString(36).slice(2)}.toml`);
        writeFileSync(file, toml);
        return spawnSync(process.execPath, ['scripts/operators-floor.mjs', `--config=${file}`], { cwd: ROOT, encoding: 'utf8' });
      };
      const guarded = run(WITH_GUARD);
      expect(guarded.status).toBe(0);
      expect(guarded.stdout.trim()).toBe('min_operators=2');
      const historical = run(WITHOUT_GUARD);
      expect(historical.status).toBe(0);
      expect(historical.stdout.trim()).toBe('min_operators=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deploy-worker.yml wires the floor into the post-deploy smoke', () => {
  const doc = load(readFileSync(join(ROOT, '.github/workflows/deploy-worker.yml'), 'utf8'));
  const steps = doc.jobs['deploy-worker'].steps;
  const floorIndex = steps.findIndex((s) => s?.id === 'opfloor');
  const smokeIndex = steps.findIndex((s) => typeof s?.run === 'string' && s.run.includes('worker/scripts/smoke-gateways.mjs'));

  it('the floor is decided from the CANDIDATE config, by this checkout, before the smoke', () => {
    expect(floorIndex).toBeGreaterThanOrEqual(0);
    expect(smokeIndex).toBeGreaterThan(floorIndex);
    expect(steps[floorIndex].run).toMatch(/^node scripts\/operators-floor\.mjs --config=candidate\/worker\/wrangler\.toml >> "\$GITHUB_OUTPUT"$/m);
  });

  it('the smoke receives it as EXPECT_MIN_OPERATORS (empty for a candidate without SpendGuard → nothing asserted)', () => {
    expect(steps[smokeIndex].env.EXPECT_MIN_OPERATORS).toBe('${{ steps.opfloor.outputs.min_operators }}');
    // The smoke treats an empty value as «not asked» — the rollback path.
    const smoke = readFileSync(join(ROOT, 'worker/scripts/smoke-gateways.mjs'), 'utf8');
    expect(smoke).toMatch(/\.\.\.\(process\.env\.EXPECT_MIN_OPERATORS \? \{ minOperators: parseMinOperators\(process\.env\.EXPECT_MIN_OPERATORS\) \} : \{\}\)/);
  });
});
