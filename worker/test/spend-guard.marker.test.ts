import { describe, it } from 'vitest';

// D10 §12 — «маркер — durable-автомат» (ревью #7 H2): crash at every boundary
// of the init automaton on REAL DO storage. The transition table itself is
// executable now (spend-ledger.test.ts §4.1). Spec §4.1.

describe('D10 marker automaton on durable storage', () => {
  it.todo('crash in `signing` before the signature → the lease expires → a new begin takes over; the ephemeral signature (if any) is never POSTed');
  it.todo('crash after the signature but before `signed` is durable → the signature is dropped; a new attempt signs again; ONE txId ends up durable');
  it.todo('crash after `signed` before the POST → the alarm resends the SAME bytes; same txId; 208 counts as accepted');
  it.todo('crash after the POST before `posted` → resend of the same bytes is idempotent on the network; the record reaches posted');
  it.todo('crash after `posted` before `done` → reconciliation by the status quorum; done sets h_init = max agreed height and opens the cycle ledger (deposits 0, spent 0, pending = Σ held)');
  it.todo('two concurrent /admin/spend/init → exactly one marker signed; the loser gets 409 init_in_progress; a late `signed` with the losing token → stale_token');
  it.todo('dead marker (quorum dead + age guard) → record back to none (init-archive:<txId>); a new signature only from there');
  it.todo('under freeze only permit-send(kind: marker, txId = init.txId, cycle = current) is granted; the marker is ≤ MARKER_MAX_BYTES with quantity 0 and reward ≤ MAX_TX_REWARD');
});
