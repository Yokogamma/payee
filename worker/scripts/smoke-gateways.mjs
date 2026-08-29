// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Post-deploy smoke: does the LIVE worker match the release that was gated?
 *
 * A green deploy step proves wrangler accepted the upload. It does not prove
 * that the thing now answering implements the quorum semantics we expect, over
 * the pool we configured, from the commit we approved. This asks.
 *
 * Used twice: after a Worker deploy, and — always with `--profile=normal` —
 * as the PRE-PUBLISH gate of the Pages release, where it answers the question
 * «is the safe worker actually live right now?» that a static config check
 * cannot.
 *
 * Freshness is proven, not assumed: every attempt carries a NEW nonce that the
 * worker must echo verbatim. `no-store` stops an intermediary from serving a
 * stale answer; only the echo shows that the answer we are holding is the one
 * we just asked for.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOriginList, serializeStatusOrigins } from '../../scripts/gateways-parse.mjs';
import { readWorkerStatusGateways } from '../../scripts/check-gateways-vs-worker.mjs';
import {
  AUTO_ALLOWED_WORKER_ORIGINS,
  DEPLOY_PROFILES,
  EXPECTED_VERSIONS,
} from './smoke-target.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** A health body is a few hundred bytes; anything larger is not one. */
export const BODY_CAP_BYTES = 8192;
export const DEADLINE_MS = 15_000;
/** Total attempts, not retries-after-the-first. */
export const ATTEMPTS = 3;

export function randomNonce() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** First 16 hex of SHA-256 over the canonical, SORTED origin list. */
export async function statusGatewaysHash(origins) {
  const bytes = new TextEncoder().encode(serializeStatusOrigins(origins));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Pure verdict over a `/health` body. Returns `{ ok, problems }`.
 *
 * `expected.releaseSha` and `expected.workerVersionId` are optional so the same
 * core serves the Pages pre-publish gate, which knows the SHA it requires but
 * learns the version id from the Worker run that produced it.
 */
export function checkHealth(body, expected) {
  const problems = [];
  const profile = DEPLOY_PROFILES[expected.profile];
  if (!profile) return { ok: false, problems: [`unknown profile: ${expected.profile}`] };

  if (typeof body !== 'object' || body === null) {
    return { ok: false, problems: ['health body is not an object'] };
  }

  // Freshness first: an unproven answer makes every other check meaningless.
  if (body.nonce !== expected.nonce) {
    problems.push('nonce was not echoed verbatim — the answer is not provably fresh');
    return { ok: false, problems };
  }
  if (body.ok !== true) problems.push('ok is not true');

  // EXACT equality, never "at least": a new semantics gets a new id and has to
  // be named explicitly rather than slipping past an inequality.
  if (body.statusQuorumPolicy !== profile.statusQuorumPolicy) {
    problems.push(
      `statusQuorumPolicy is ${JSON.stringify(body.statusQuorumPolicy)}, ` +
        `profile "${expected.profile}" requires ${JSON.stringify(profile.statusQuorumPolicy)}`,
    );
  }
  if (body.statusGatewaysHash !== expected.statusGatewaysHash) {
    problems.push('statusGatewaysHash does not match the set configured in wrangler.toml');
  }
  if (body.statusGatewaysCount !== expected.statusGatewaysCount) {
    problems.push('statusGatewaysCount does not match wrangler.toml');
  }

  if (!Array.isArray(body.versions)
    || body.versions.join(',') !== EXPECTED_VERSIONS.join(',')) {
    problems.push('versions does not match the repo-pinned list');
  }

  for (const flag of ['uploads', 'v3Uploads', 'v4Uploads']) {
    if (typeof body[flag] !== 'boolean') problems.push(`${flag} is not a boolean`);
  }
  // The emergency lineage is defined by every switch being OFF; a build that
  // carries the old semantics with uploads on is exactly what must not exist.
  if (profile.requireUploadsOff) {
    for (const flag of ['uploads', 'v3Uploads', 'v4Uploads']) {
      if (body[flag] !== false) problems.push(`${flag} must be false under the emergency profile`);
    }
  }

  if (expected.releaseSha !== undefined && body.releaseSha !== expected.releaseSha) {
    problems.push(
      `releaseSha is ${JSON.stringify(body.releaseSha)}, expected the deployed candidate`,
    );
  }
  // The SHA alone cannot tell a re-deploy of the same commit from the original;
  // the ACTIVE version id can, which is why both are checked when known.
  if (expected.workerVersionId !== undefined && body.workerVersionId !== expected.workerVersionId) {
    problems.push(
      `workerVersionId is ${JSON.stringify(body.workerVersionId)}, ` +
        'expected the version the deploy just activated',
    );
  }

  return { ok: problems.length === 0, problems };
}

/** Expectations derived from the repository for a given wrangler block. */
export async function expectationsFromRepo(blockPrefix = '') {
  const toml = readFileSync(join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
  const read = readWorkerStatusGateways(toml, blockPrefix);
  if (read.error) throw new Error(read.error);
  const origins = parseOriginList(read.value);
  return { statusGatewaysHash: await statusGatewaysHash(origins), statusGatewaysCount: origins.length };
}

/** One attempt: fetch with a fresh nonce, cap the body, parse. */
async function probe(origin, nonce) {
  const response = await fetch(`${origin}/health?nonce=${nonce}`, {
    method: 'GET',
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  if (!response.ok) return { error: `HTTP ${response.status}` };
  if (response.headers.get('Cache-Control') !== 'no-store') {
    return { error: 'health answered without Cache-Control: no-store' };
  }
  const text = await response.text();
  if (text.length > BODY_CAP_BYTES) return { error: 'health body over the size ceiling' };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'health body is not JSON' };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('smoke-gateways.mjs')) {
  const args = process.argv.slice(2);
  const profile = (args.find(a => a.startsWith('--profile='))?.split('=')[1]) ?? 'normal';
  const blockPrefix = args.includes('--staging') ? 'env.staging.' : '';
  // The target is repo-pinned, not an argument: a smoke pointed wherever the
  // caller likes proves nothing about the release that was gated.
  const origin = AUTO_ALLOWED_WORKER_ORIGINS[0];

  const expected = {
    profile,
    ...(await expectationsFromRepo(blockPrefix)),
    ...(process.env.EXPECT_RELEASE_SHA ? { releaseSha: process.env.EXPECT_RELEASE_SHA } : {}),
    ...(process.env.EXPECT_WORKER_VERSION_ID
      ? { workerVersionId: process.env.EXPECT_WORKER_VERSION_ID } : {}),
  };

  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // A NEW nonce every attempt: reusing one would let the retry reproduce the
    // very cached answer the retry exists to get past.
    const nonce = randomNonce();
    let result;
    try {
      result = await probe(origin, nonce);
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    if (result.error) {
      last = [result.error];
      if (attempt < ATTEMPTS) continue;
      break;
    }
    const { ok, problems } = checkHealth(result.body, { ...expected, nonce });
    if (ok) {
      console.log(`✓ smoke-gateways: ${origin} matches the "${profile}" profile`);
      process.exit(0);
    }
    last = problems;
    // A verdict about the CONTENT will not change on retry; only transport
    // failures are worth another attempt.
    break;
  }

  console.error(`✗ smoke-gateways FAILED for ${origin} (profile "${profile}"):`);
  for (const p of last ?? ['no answer']) console.error(`  - ${p}`);
  process.exit(1);
}
