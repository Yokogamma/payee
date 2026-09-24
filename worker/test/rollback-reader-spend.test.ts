import { describe, it, expect } from 'vitest';
import { setupOutboundMock } from './helpers/outbound-mock';
import { makeIdentity, sagaEnv, upload, uploadRequest } from './helpers/spend-saga';

// D10 §12 — «откат writer → reader с деньгами» (plan «Rollback floor —
// reader-before-writer», PR #206 v21: the reader carries SpendGuard whole).
// Spec §0, §9. The rows that need writer-created records wait for the
// scheduler step; the configuration row is executable now.

setupOutboundMock(); // no routes: any Arweave call would fail the test

describe('writer → reader rollback keeps the limits', () => {
  // A writer-created `signed` is resent by the reader through the same
  // permit; a writer-created `redrop_pending` gets phase 2 under
  // permit-send(redrop2) with the old reservation released first:
  // test/recovery-scheduler.test.ts (records are seeded through the writer's
  // primitive `adoptRecovery`).

  it('the reader with SpendGuard unconfigured (any limit missing while UPLOADS_ENABLED="true") → 503 spend_guard_unconfigured BEFORE admission on every paid path, and no POST', async () => {
    const { env } = await sagaEnv('unconfigured');
    const id = await makeIdentity();
    for (const missing of ['WALLET_FLOOR_WINSTON', 'SPEND_WINDOW_CAP_WINSTON', 'MAX_TX_REWARD_WINSTON'] as const) {
      const r = await upload(await uploadRequest(id, crypto.randomUUID()), { ...env, [missing]: undefined });
      expect(r.status, missing).toBe(503);
      expect(r.body.code).toBe('spend_guard_unconfigured');
      expect(r.opId).toBeNull(); // pre-admission: no journal record, no echo
      expect(r.body.operationId).toBeUndefined();
    }
    const garbage = await upload(await uploadRequest(id, crypto.randomUUID(), { recheck: true }), { ...env, MAX_TX_REWARD_WINSTON: '12abc' });
    expect(garbage.body.code).toBe('spend_guard_unconfigured');
  });

  // «the reader does not create new recovery records» —
  // test/recovery-scheduler.test.ts «the reader never creates a recovery record».
});
