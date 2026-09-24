#!/usr/bin/env node
/**
 * D10 spend-guard staging smoke (spec §9, PR-6): drives the OPERATOR routes of
 * the deployed worker and prints what the guard says at every step.
 *
 *   status → [freeze] → init (repeated until `done` or `waiting`) →
 *   [credit-deposit <txId>] → [thaw] → status
 *
 * Usage (CLI — sends no Origin header):
 *   SMOKE_URL=https://eternal-notes-proxy-staging.<acct>.workers.dev \
 *   SPEND_ADMIN_SECRET=<the staging spend admin secret> \
 *   [SMOKE_SPEND_FREEZE=1] [SMOKE_DEPOSIT_TXID=<43-char id>] [SMOKE_SPEND_THAW=1] \
 *   npm run smoke:spend
 *
 * NOTES — read before running:
 *   - `init` SIGNS AND SENDS a real (tiny, quantity 0) marker transaction paid
 *     by that contour's wallet the first time it runs in `none`; every later
 *     call only continues by state (resend of the same bytes / quorum). No
 *     second marker is ever signed while one is `signed`/`posted`.
 *   - `init` refuses until the legacy set is closed (keys, open permits,
 *     journals, verified rewards): a refusal with `spend_init_legacy_*` is a
 *     finding to act on, not a smoke failure of the worker.
 *   - The paid cycle `refresh-price → prepare → activate → permit-send →
 *     settle` is exercised by a signed upload — run smoke-v3 / smoke-v4 AFTER
 *     the guard is `done`, funded (`credit-deposit`) and thawed.
 *   - Target policy: smoke-target.mjs (fail-closed allowlist of worker
 *     origins; a non-listed target needs SMOKE_ALLOW_ORIGIN — record why in
 *     docs/ROLLBACK.md). The secret travels ONLY as the Authorization header.
 */

import { classifySmokeTarget } from './smoke-target.mjs';

const url = process.env.SMOKE_URL;
const secret = process.env.SPEND_ADMIN_SECRET;
if (!url || !secret) {
  console.error('SMOKE_URL and SPEND_ADMIN_SECRET are required');
  process.exit(2);
}
const target = classifySmokeTarget(url, process.env.SMOKE_ALLOW_ORIGIN);
if (!target.ok) {
  console.error(`✗ ${target.reason}`);
  process.exit(2);
}
if (target.warning) console.warn(`⚠ ${target.warning}`);
const origin = target.origin;

let failures = 0;
const fail = (msg) => { failures++; console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);

async function call(op, body = {}) {
  const res = await fetch(`${origin}/admin/spend/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: res.status, json };
}

const brief = (s) => {
  const g = s.json?.guard ?? {};
  return `init=${g.init?.state ?? '?'}/cycle ${g.init?.cycle ?? '?'} freeze=${g.freeze?.active ?? '?'} available=${g.available ?? '?'} pending=${g.ledger?.pending ?? '?'} spent=${g.ledger?.spent ?? '?'} limits=${s.json?.limits?.configured ?? '?'}`;
};

// 1. status
let s = await call('status');
if (s.status !== 200) { fail(`status: HTTP ${s.status} ${JSON.stringify(s.json)}`); process.exit(1); }
ok(`status: ${brief(s)}`);
if (s.json?.limits?.configured !== true) fail('limits are not configured on this worker (503 spend_guard_unconfigured on every paid path)');

// 2. freeze (optional)
if (process.env.SMOKE_SPEND_FREEZE === '1') {
  const f = await call('freeze', { active: true });
  if (f.status === 200) ok(`freeze: epoch ${f.json?.freeze?.epoch}`); else fail(`freeze: HTTP ${f.status} ${JSON.stringify(f.json)}`);
}

// 3. init — continue by state, at most 6 calls in this run. The verdict is
// the LAST answer: only `done` or `waiting` is a pass; retries that never
// get there are a failure, not a shrug (review 24.09 #2, medium).
let last = null;
for (let i = 0; i < 6; i++) {
  const r = await call('init');
  last = r;
  const step = r.json?.step ?? r.json?.code ?? `HTTP ${r.status}`;
  console.log(`  init #${i + 1}: ${step} ${r.json?.init ? `(state ${r.json.init.state}, txId ${r.json.init.txId ?? '-'})` : ''}${r.json?.legacy ? ` legacy=${JSON.stringify(r.json.legacy)}` : ''}`);
  if (r.status === 200 && (r.json?.step === 'done' || r.json?.step === 'waiting')) break;
  if (r.status === 200 && r.json?.step === 'dead') { console.log('  marker dead — a new one is signed on the next call'); continue; }
  if (r.status >= 500 && /^spend_init_/.test(String(r.json?.code))) break;
  if (r.status === 502) { console.log(`  gateway: ${r.json?.code} — retrying`); continue; }
  if (r.status >= 400) break;
}
if (last && last.status === 200 && (last.json?.step === 'done' || last.json?.step === 'waiting')) ok(`init: ${last.json.step}`);
else if (last && /^spend_init_/.test(String(last.json?.code))) fail(`init refused: ${last.json.code} ${JSON.stringify(last.json)} — close the legacy set (docs/ROLLBACK.md «Spend guard»)`);
else fail(`init did not reach done/waiting: last answer HTTP ${last?.status} ${JSON.stringify(last?.json)}`);

// 4. credit-deposit (optional)
if (process.env.SMOKE_DEPOSIT_TXID) {
  const d = await call('credit-deposit', { txId: process.env.SMOKE_DEPOSIT_TXID });
  if (d.status === 200) ok(`credit-deposit: credited=${d.json?.credited} amount=${d.json?.amount} height=${d.json?.depositHeight} available=${d.json?.available}`);
  else fail(`credit-deposit: HTTP ${d.status} ${JSON.stringify(d.json)}`);
}

// 5. thaw (optional; refused until done)
if (process.env.SMOKE_SPEND_THAW === '1') {
  const t = await call('freeze', { active: false });
  if (t.status === 200) ok('thaw'); else fail(`thaw: HTTP ${t.status} ${JSON.stringify(t.json)}`);
}

// 6. status again
s = await call('status');
if (s.status === 200) ok(`status: ${brief(s)}`); else fail(`status: HTTP ${s.status}`);

if (failures > 0) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('spend smoke OK');
