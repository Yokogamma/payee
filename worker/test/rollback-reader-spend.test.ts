import { describe, it } from 'vitest';

// D10 §12 — «откат writer → reader с деньгами» (plan «Rollback floor —
// reader-before-writer», PR #206 v21: the reader carries SpendGuard whole).
// Spec §0, §9.

describe('writer → reader rollback keeps the limits', () => {
  it.todo('writer created a durable `signed` → rollback to the reader → the reader resends the same bytes through the saga and permit-send; spent(c) accounts it once');
  it.todo('writer created `redrop_pending` → the reader runs phase 2 (new gen) only through permit-send(kind: redrop2); the old reservation is released before the new one is prepared');
  it.todo('the reader with SpendGuard unconfigured (any limit missing while UPLOADS_ENABLED="true") → 503 spend_guard_unconfigured on every paid path, and no POST');
  it.todo('the reader does not create new recovery records (no new `signed`); only the writer does');
});
