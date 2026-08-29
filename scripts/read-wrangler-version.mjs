// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Read the ACTIVATED worker version id out of wrangler's structured output.
 *
 * Wrangler writes NDJSON — one JSON object per line — to the file named by
 * `WRANGLER_OUTPUT_FILE_PATH`, not a single JSON document, and the pinned
 * `wrangler-action` exposes no version-id output of its own. So the deploy
 * record is parsed here, from the TRUSTED checkout, and emitted as a step
 * output for the smoke to compare against what `/health` reports.
 *
 * Why this matters at all: `releaseSha` is self-declared, and a re-deploy of
 * the SAME commit produces the same SHA but a DIFFERENT version. Only the
 * version id can tell the two apart, which is exactly what an attestation
 * needs to be worth anything.
 *
 * Fails loudly on anything ambiguous. A missing, unreadable or multi-deploy
 * output is not "probably fine": it means we cannot say what is running.
 */

import { readFileSync } from 'node:fs';
import { WORKER_NAME } from '../worker/scripts/smoke-target.mjs';

/** Wrangler's deploy record; the key name has varied across versions. */
const DEPLOY_TYPES = new Set(['deploy', 'deployment']);

/**
 * Pure core: NDJSON text → `{ workerName, versionId }` or `{ error }`.
 * Exactly ONE deploy record must be present.
 */
export function parseWranglerOutput(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A malformed line means the output is not what we think it is. Skipping
      // it silently would risk reading a DIFFERENT record than wrangler wrote.
      return { error: 'wrangler output contains a line that is not JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    const versionId = parsed.version_id ?? parsed.versionId;
    // The TYPE decides. Accepting "any record carrying a version_id" would let
    // an unrelated line (a preview upload, a future record shape) stand in for
    // the deployment — identity has to come from the record that means deploy.
    if (DEPLOY_TYPES.has(type)) {
      records.push({
        workerName: parsed.worker_name ?? parsed.workerName ?? null,
        versionId: typeof versionId === 'string' ? versionId : null,
      });
    }
  }

  if (records.length === 0) return { error: 'wrangler output contains no deploy record' };
  if (records.length > 1) {
    return { error: `wrangler output contains ${records.length} deploy records, expected exactly one` };
  }
  const [record] = records;
  if (!record.versionId) return { error: 'the deploy record carries no version id' };
  // The name is CHECKED against the repo pin, not just carried through: a
  // deploy that landed on a different worker is the one case an identity check
  // exists to catch, and credentials pointing elsewhere produce exactly that.
  if (record.workerName !== null && record.workerName !== WORKER_NAME) {
    return { error: `deploy landed on worker "${record.workerName}", expected "${WORKER_NAME}"` };
  }
  return record;
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('read-wrangler-version.mjs')) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/read-wrangler-version.mjs <wrangler-output.ndjson>');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`✗ cannot read wrangler output at ${path}`);
    process.exit(1);
  }
  const result = parseWranglerOutput(text);
  if (result.error) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }
  // GITHUB_OUTPUT format; the caller redirects stdout into it.
  console.log(`version_id=${result.versionId}`);
  if (result.workerName) console.log(`worker_name=${result.workerName}`);
}
