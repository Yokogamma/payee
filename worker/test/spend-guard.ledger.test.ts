import { describe, it } from 'vitest';

// D10 §12 — «пополнение и маркер» (ревью #4–#6) and the §3.4 detector, through
// the worker routes with a stubbed gateway pool. Pure parts executable now:
// creditDeposit, prepareDecision (spend-ledger.test.ts). Spec §3.4, §4.2, §5.

describe('D10 deposits, marker height and the balance detector', () => {
  it.todo('counterexample review #6 on a stand: /info says 99 while the balance already includes a transfer mined at 100; marker at 105 → the transfer at 100 is refused (409 deposit_before_marker), a transfer at 106 is credited exactly once');
  it.todo('credit-deposit with the txId of an OUTGOING transaction or of the marker itself → 503 deposit_unverified (target/quantity check in the worker)');
  it.todo('credit-deposit requires ≥2 independent operators confirmed with ≥ MIN_DEPOSIT_CONFIRMATIONS and heights within MAX_STATUS_HEIGHT_SKEW; depositHeight = the minimum');
  it.todo('prepare before init done → 503 spend_not_initialized');
  it.todo('concurrent prepare around credit-deposit: each in its own storage transaction, no partial state, available never goes negative');
  it.todo('observedMin (minimum over ≥ MIN_BALANCE_SOURCES gateway answers) below available → 503 spend_ledger_inconsistent until reinit; fewer answers than MIN_BALANCE_SOURCES → detector inert, prepare proceeds on the ledger alone');
  it.todo('/admin/spend/* with METRICS_ADMIN_SECRET → 403 wrong_scope');
  it.todo('price quote bound to size: quoteId from /refresh-price must match the bytes in prepare → otherwise 503 spend_quote_mismatch');
});
