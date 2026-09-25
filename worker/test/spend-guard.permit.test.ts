import { describe, it } from 'vitest';

// D10 §12 — «барьер отправки и заморозка» (ревью #8 H2/M2, #9 H3): the DO +
// network half. The pure decisions these cases rest on are executable already
// (spend-ledger.test.ts: permitDecision, refusalBranch). Each `todo` below is
// one row of the §12 map; it becomes a test the day `worker/src/spend-guard.ts`
// exists. Spec: arweave-pr3b-d10-spendguard-spec-2026-09-23.md rev. 10 §4.0–4.1.

describe('D10 permit-send — the single path to the network', () => {
  it.todo('(1) counterexample review #8: a request parked in `begun` (waiting for a quote) → freeze → set closure → resume → permit-send = 503 spend_frozen, no POST, /op-abort reason `frozen` (no permit:<txId> — provably never sent), reservation released');
  it.todo('(1б) review #9 H3: durable `signed` was POSTed, the answer was lost → freeze → permit-send(resend) refused → record, txId, signedTx and the hold are kept, no release/abort, quorum reconciliation continues, confirmed → posted/spent');
  it.todo('(1в) durable `signed` that was never POSTed under freeze is not cancelled: it waits for the thaw and its first POST happens under a NEW permit');
  it.todo('(2) static: no transaction POST in worker/src outside the permit-send path (grep-level guard over the source tree)');
  it.todo('(3) under freeze permit-send(kind: marker) passes ONLY for init.txId of the current cycle; any other txId/kind refused; after the thaw a marker of a foreign cycle is refused');
  it.todo('(4) a second permit-send for the same txId returns the SAME permit (resend without double accounting)');
  it.todo('(5) SpendGuard unavailable (DO fetch throws) → 503 spend_guard_unavailable and not a single POST');
  it.todo('/admin/spend/freeze: SPEND_ADMIN_SECRET only; METRICS_ADMIN_SECRET → 403 wrong_scope; unset → 503 spend_admin_unconfigured; thaw refused unless init.state == done');
});
