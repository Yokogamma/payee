// NO SHEBANG: imported by its test (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Operator census of the recovery set — the proof a rollback below the reader
 * needs (runbook reader release §5.1, review 25.09 H3; route:
 * POST /admin/recovery-census, src/recovery-census.ts).
 *
 * Usage (read-only; the read-only METRICS_ADMIN_SECRET travels ONLY as the
 * Authorization header):
 *   CENSUS_URL=https://eternal-notes-proxy.sopi-88c.workers.dev \
 *   METRICS_ADMIN_SECRET=<metrics admin secret> \
 *   [CENSUS_MIN_KEYS=1] [SMOKE_ALLOW_ORIGIN=<origin>] \
 *   npm run census:recovery
 *
 * Exit codes — the ONLY thing a rollback decision may read:
 *   0  admissible: the enumeration is complete and every recovery set is
 *      empty (counter, index and a direct scan of the records all zero);
 *   1  REFUSED: incomplete enumeration, a failed or malformed read, a
 *      non-zero recovery set, fewer keys than CENSUS_MIN_KEYS, or any answer
 *      this script cannot fully validate;
 *   2  usage: a missing variable or a target outside the allowlist.
 *
 * CENSUS_MIN_KEYS (default 1) is the operator's own floor: a contour with
 * real users that suddenly lists zero keys is a misread, not an empty set.
 * Set it to 0 deliberately for a freshly provisioned staging.
 *
 * Run it under `freeze on`, after every issued permit has reported (runbook
 * §5.1 step 1) — the census is a snapshot, and the freeze is what keeps it
 * true until the rollback deploy.
 */

import { classifySmokeTarget } from './smoke-target.mjs';

const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const REASONS = new Set([
  'list_keys_failed', 'legacy_keys_failed', 'legacy_invites_unacknowledged', 'too_many_keys',
  'key_read_failed', 'recovery_present', 'counter_drift',
]);

/**
 * Pure verdict over one HTTP answer. Returns `{ ok, summary, problems }`:
 * `ok` only for a complete, empty census that passed every check.
 */
export function judgeCensus(status, body, { minKeys = 1 } = {}) {
  const problems = [];
  if (status !== 200) return { ok: false, summary: null, problems: [`HTTP ${status} — no census`] };
  const c = body?.census;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return { ok: false, summary: null, problems: ['answer carries no census object'] };

  const shape = [];
  if (typeof c.complete !== 'boolean') shape.push('complete');
  if (!['empty', 'not_empty', 'incomplete'].includes(c.verdict)) shape.push('verdict');
  for (const f of ['listed', 'checked', 'failed']) if (!isCount(c.keys?.[f])) shape.push(`keys.${f}`);
  for (const f of ['unknown', 'acknowledged']) if (!isCount(c.legacyInvites?.[f])) shape.push(`legacyInvites.${f}`);
  for (const f of ['count', 'due', 'records', 'keysWithRecovery']) if (!isCount(c.recovery?.[f])) shape.push(`recovery.${f}`);
  if (!Array.isArray(c.reasons) || !c.reasons.every((r) => REASONS.has(r))) shape.push('reasons');
  if (shape.length > 0) return { ok: false, summary: null, problems: [`census is malformed (${shape.join(', ')}) — refusing to read it as empty`] };

  const summary =
    `verdict=${c.verdict} complete=${c.complete} keys listed=${c.keys.listed} checked=${c.keys.checked} failed=${c.keys.failed} ` +
    `legacyInvites unknown=${c.legacyInvites.unknown} acknowledged=${c.legacyInvites.acknowledged} ` +
    `recovery count=${c.recovery.count} due=${c.recovery.due} records=${c.recovery.records} keysWithRecovery=${c.recovery.keysWithRecovery}` +
    (c.reasons.length ? ` reasons=${c.reasons.join(',')}` : '') +
    ` (worker ${body.workerVersionId ?? '?'} / ${body.releaseSha ?? '?'})`;

  // Every condition is checked on its own — the worker's own verdict is one
  // input, not the decision.
  if (c.verdict !== 'empty') problems.push(`verdict is ${c.verdict}`);
  if (c.complete !== true) problems.push('the enumeration is not complete');
  if (c.reasons.length > 0) problems.push(`reasons: ${c.reasons.join(', ')}`);
  if (c.keys.failed > 0) problems.push(`${c.keys.failed} key(s) could not be read`);
  if (c.keys.checked !== c.keys.listed) problems.push(`checked ${c.keys.checked} of ${c.keys.listed} listed keys`);
  if (c.legacyInvites.unknown > c.legacyInvites.acknowledged) problems.push(`${c.legacyInvites.unknown - c.legacyInvites.acknowledged} old-format invite(s) hide a key nobody acknowledged`);
  if (c.keys.listed < minKeys) problems.push(`${c.keys.listed} key(s) listed, fewer than CENSUS_MIN_KEYS=${minKeys} — a misread is not an empty set`);
  for (const f of ['count', 'due', 'records', 'keysWithRecovery']) {
    if (c.recovery[f] !== 0) problems.push(`recovery.${f} = ${c.recovery[f]}`);
  }
  return { ok: problems.length === 0, summary, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('recovery-census.mjs')) {
  const url = process.env.CENSUS_URL;
  const secret = process.env.METRICS_ADMIN_SECRET;
  if (!url || !secret) {
    console.error('CENSUS_URL and METRICS_ADMIN_SECRET are required');
    process.exit(2);
  }
  const rawMin = process.env.CENSUS_MIN_KEYS ?? '1';
  if (!/^\d+$/.test(rawMin)) {
    console.error(`CENSUS_MIN_KEYS must be a non-negative integer, got "${rawMin}"`);
    process.exit(2);
  }
  const target = classifySmokeTarget(url, process.env.SMOKE_ALLOW_ORIGIN);
  if (!target.ok) {
    console.error(`✗ ${target.reason}`);
    process.exit(2);
  }
  if (target.warning) console.warn(`⚠ ${target.warning}`);

  let status = 0;
  let body = null;
  try {
    const res = await fetch(`${target.origin}/admin/recovery-census`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: '{}',
      redirect: 'manual',
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = null; }
  } catch (e) {
    console.error(`✗ census read failed: ${e instanceof Error ? e.message : String(e)} — REFUSED (a failed read is not an empty set)`);
    process.exit(1);
  }
  const verdict = judgeCensus(status, body, { minKeys: Number(rawMin) });
  if (verdict.summary) console.log(verdict.summary);
  if (!verdict.ok) {
    console.error('✗ recovery census REFUSED — a rollback below the reader is NOT proven admissible:');
    for (const p of verdict.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('✓ recovery census: complete and empty — admissible for the rollback (valid while the freeze holds)');
}
