import { describe, it } from 'vitest';

// D10 §12 — «покой и унаследованные» (ревью #7 H1, #8 H1, #9 H1/H2/M): closing
// the set L of transactions that may still be mined after the marker, their
// rewards from SIGNED bytes only, and their resolution once the cycle is done.
// Pure part already executable: resolveLegacy, initTransition(begin) refusals
// (spend-ledger.test.ts). Spec §4.0 п. 1–6.

describe('D10 legacy set L and init preconditions', () => {
  it.todo('(1) recoveryCount = 0 but the per-key journal holds a `posting` without confirmation and no registration → init-begin = 503 spend_init_legacy_open');
  it.todo('(2) after /init-legacy registration init passes; available is reduced by the held sum');
  it.todo('(3) an OLD reward of 20 above the NEW MAX_TX_REWARD of 10 → the hold is exactly 20, read from the signed bytes (the ceiling covers new transactions only)');
  it.todo('(4) bytes unavailable at every source → 503 spend_init_legacy_reward_unknown; once bytes appear at any ONE source init passes');
  it.todo('(4б) review #9 H1: no bytes, but an arbitrarily old confirmed block dated before postingAt → init STILL refused (no «anchor expiry» without signed bytes)');
  it.todo('(5) signature does not verify, or owner is not the worker wallet → the bytes are rejected, next source is tried');
  it.todo('(5б) review #9 H2: request A (reward 20), the source answers with correctly signed B of the same wallet (reward 1) → rejected by verified.id !== txId; the hold for A is not understated');
  it.todo('(7) old-format `committed` without a confirmed quorum, and `paidResult: unknown` → members of L₂');
  it.todo('(8) review #9 M: POST with unknown outcome → key revoked → the key and its operation are still in L₂ (from invite:* with publicKey, revoked: true); an old-format invite record without publicKey → 503 spend_init_keys_unknown until /init-legacy-keys');
  it.todo('(9) resolution after done: confirmed above h_init → spent(c); at/below → dropped; dead + age guard → dropped; otherwise held without TTL');
});
