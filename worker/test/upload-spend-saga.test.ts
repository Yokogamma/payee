import { describe, it } from 'vitest';

// D10 §12 — «интеграция потока» (§8): check-and-reserve → refresh-balance →
// price → refresh-price(quoteId) → prepare → sign → durable signed → activate
// → permit-send → POST → settle(spent) by the confirmed quorum, with a crash
// injected after EVERY boundary. Pure parts executable now: activateOutcome,
// settle, permitDecision (spend-ledger.test.ts).

describe('upload → spend saga, crash after each boundary', () => {
  it.todo('crash after prepare (before sign) → the reservation lease expires (PREPARED_LEASE_MS) → expire-leases releases pending; no POST');
  it.todo('crash after sign before durable signed → the ephemeral signature is dropped; resign_violation does NOT fire on an ephemeral signature');
  it.todo('crash after durable signed before activate → recovery activates (same {reward, revision}) and continues; a changed reward → remap under §5 checks');
  it.todo('crash between activate and permit-send → recovery asks permit-send first; under freeze it is refused and the record is kept (no release)');
  it.todo('crash after permit-send before POST → the same permit is returned and the same bytes are POSTed; one txId');
  it.todo('crash after POST before settle → status quorum confirmed → settle(spent) once; pending −= reward, spent(c) += reward, bucket + audit');
  it.todo('redrop: per-key CAS signed → redrop_pending → settle(old, released) → phase 2 with a new gen → permit-send(redrop2) → POST');
  it.todo('activate conflict (different activatedBy on active/settled) → 503 activate_conflict + incident metric, no POST');
});
