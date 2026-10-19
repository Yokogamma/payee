import { describe, it } from 'vitest';

// D10 §12 — «reinit — ведомость цикла ≠ аудит ≠ бюджет» (ревью #8 M1, #7 M1).
// The ledger arithmetic of every case is already exercised in
// spend-ledger.test.ts (reinit, spentLast24h, prepareDecision); these are the
// same scenarios through the DO routes on real storage. Spec §4.4.

describe('D10 reinit through the DO', () => {
  it.todo('review #8 scenario: deposited 1000, spent 900, reinit, 100 returned and credited → /status available = 100 (not −800); the archive holds the old cycle whole');
  it.todo('window cap exhausted → reinit → prepare still refused by spend_window_cap until the spending leaves the 24 h window (buckets are cross-cycle)');
  it.todo('held legacy sums are carried into the new cycle pending; audit:* contains both cycles');
  it.todo('reinit without freeze → 503 spend_init_not_frozen; reinit with an active reservation → the reservation is part of the closed set (held)');
  it.todo('withdrawal inside the cycle (freeze → close → withdraw → marker → return → credit) keeps the ledger consistent; withdrawal outside a cycle trips the §3.4 detector → 503 spend_ledger_inconsistent until reinit');
});
