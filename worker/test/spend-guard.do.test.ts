import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { PREPARED_LEASE_MS, PRICE_QUOTE_TTL_MS, SPEND_CODES } from '../src/spend-ledger';

// D10 SpendGuard DO on REAL storage (spec rev. 10 §4.0–4.4, §5–§7): the pure
// rules of spend-ledger.ts through the DO routes, each in one storage
// transaction. Network-dependent rows of §12 (signing, POST, quorums, bytes)
// stay `it.todo` in the spend-guard.*.test.ts files — the worker brings those
// facts to this DO; here they are given.

const SPEND_GUARD = (env as unknown as { SPEND_GUARD: DurableObjectNamespace }).SPEND_GUARD;
const RUN = crypto.randomUUID().slice(0, 8);
const fresh = (name: string) => SPEND_GUARD.get(SPEND_GUARD.idFromName(`sg-${name}-${RUN}`));

const LIMITS = { walletFloor: '100', windowCap: '1000', maxTxReward: '50' };
const T0 = 1_800_000_000_000;

async function call(stub: DurableObjectStub, path: string, body: Record<string, unknown> = {}) {
  const res = await stub.fetch(`http://spend-guard${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { code?: string } };
}
async function status(stub: DurableObjectStub) {
  const res = await stub.fetch('http://spend-guard/status');
  return (await res.json()) as { available: string; ledger: { cycle: number; hInit: number | null; deposits: string; spent: string; pending: string }; freeze: { active: boolean; epoch: number }; init: { state: string; cycle: number; txId?: string }; spentLast24h: string };
}

/** Bring a fresh guard to `done` with a marker at height `h`: freeze → begin →
 *  signed → posted → done (quorum given), then thaw. */
async function initialized(stub: DurableObjectStub, h = 1000, now = T0) {
  expect((await call(stub, '/freeze', { active: true, now })).status).toBe(200);
  expect((await call(stub, '/init-begin', { token: 'tok', now })).status).toBe(200);
  expect((await call(stub, '/init-signed', { token: 'tok', txId: 'MARKER', signedTx: 'bytes', anchor: 'a', now })).status).toBe(200);
  expect((await call(stub, '/init-posted', { token: 'tok', txId: 'MARKER', now })).status).toBe(200);
  const done = await call(stub, '/init-done', { txId: 'MARKER', heights: [h, h + 1], confirmations: [60, 70], now });
  expect(done.status).toBe(200);
  expect((await call(stub, '/freeze', { active: false, now })).status).toBe(200);
  return stub;
}

async function credit(stub: DurableObjectStub, txId: string, amt: string, height: number) {
  return call(stub, '/credit-deposit', { txId, amount: amt, depositHeight: height });
}

async function quote(stub: DurableObjectStub, bytes: number, reward: string, now = T0) {
  const q = await call(stub, '/refresh-price', { bytes, reward, now });
  expect(q.status).toBe(200);
  return q.body.quoteId as string;
}

describe('freeze and the marker automaton on storage', () => {
  it('init is refused until frozen; thaw is refused until done; the whole path reaches done with h_init = max height', async () => {
    const sg = fresh('init');
    expect((await call(sg, '/init-begin', { token: 't' })).body.code).toBe(SPEND_CODES.initNotFrozen);
    expect((await call(sg, '/freeze', { active: true })).body).toMatchObject({ active: true, epoch: 1 });
    expect((await call(sg, '/freeze', { active: false })).body.code).toBe(SPEND_CODES.notInitialized);
    await initialized(sg, 1000);
    const s = await status(sg);
    expect(s.init).toMatchObject({ state: 'done', txId: 'MARKER' });
    expect(s.ledger).toMatchObject({ cycle: 1, hInit: 1001, deposits: '0', spent: '0', pending: '0' });
    expect(s.freeze.active).toBe(false);
  });

  it('two concurrent begins: the second gets 409 init_in_progress; a signed with the losing token → stale_token', async () => {
    const sg = fresh('race');
    await call(sg, '/freeze', { active: true });
    expect((await call(sg, '/init-begin', { token: 'A', now: T0 })).status).toBe(200);
    const second = await call(sg, '/init-begin', { token: 'B', now: T0 + 1 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe(SPEND_CODES.initInProgress);
    const losing = await call(sg, '/init-signed', { token: 'B', txId: 'X', signedTx: 'b', anchor: 'a', now: T0 + 2 });
    expect(losing.body.code).toBe(SPEND_CODES.staleToken);
    expect((await status(sg)).init.state).toBe('signing');
  });

  it('a dead marker returns the record to none and a new signature can start', async () => {
    const sg = fresh('dead');
    await call(sg, '/freeze', { active: true });
    await call(sg, '/init-begin', { token: 'A', now: T0 });
    await call(sg, '/init-signed', { token: 'A', txId: 'X', signedTx: 'b', anchor: 'a', now: T0 });
    expect((await call(sg, '/init-dead', { txId: 'X' })).status).toBe(200);
    expect((await status(sg)).init.state).toBe('none');
    expect((await call(sg, '/init-begin', { token: 'B', now: T0 + 5 })).status).toBe(200);
  });
});

describe('permit-send — the single path to the network', () => {
  it('under freeze only the current marker gets a permit; after done uploads get one; a repeat returns the same permit', async () => {
    const sg = fresh('permit');
    await call(sg, '/freeze', { active: true, now: T0 });
    await call(sg, '/init-begin', { token: 'tok', now: T0 });
    await call(sg, '/init-signed', { token: 'tok', txId: 'MARKER', signedTx: 'bytes', anchor: 'a', now: T0 });
    expect((await call(sg, '/permit-send', { txId: 'NOTE1', kind: 'upload', cycle: 1 })).body.code).toBe(SPEND_CODES.frozen);
    expect((await call(sg, '/permit-send', { txId: 'OTHER', kind: 'marker', cycle: 1 })).body.code).toBe(SPEND_CODES.frozen);
    const marker = await call(sg, '/permit-send', { txId: 'MARKER', kind: 'marker', cycle: 1, now: T0 });
    expect(marker.body).toMatchObject({ granted: true, existing: false });
    await call(sg, '/init-posted', { token: 'tok', txId: 'MARKER', now: T0 });
    await call(sg, '/init-done', { txId: 'MARKER', heights: [10, 10], confirmations: [60, 60], now: T0 });
    await call(sg, '/freeze', { active: false });
    const first = await call(sg, '/permit-send', { txId: 'NOTE1', kind: 'upload', cycle: 1, now: T0 + 1 });
    expect(first.body).toMatchObject({ granted: true, existing: false });
    const again = await call(sg, '/permit-send', { txId: 'NOTE1', kind: 'resend', cycle: 1, now: T0 + 2 });
    expect(again.body).toMatchObject({ granted: true, existing: true });
    expect((again.body.permit as { issuedAt: number }).issuedAt).toBe(T0 + 1);
    // The marker permit already issued is returned as-is (idempotent); a marker of a FOREIGN cycle is refused.
    expect((await call(sg, '/permit-send', { txId: 'MARKER', kind: 'marker', cycle: 1 })).body).toMatchObject({ granted: true, existing: true });
    expect((await call(sg, '/permit-send', { txId: 'MARKER2', kind: 'marker', cycle: 2 })).body.code).toBe(SPEND_CODES.notInitialized);
  });

  it('a freeze in the middle: a txId that never held a permit is refused; one that did keeps its permit (idempotent, no double accounting)', async () => {
    const sg = await initialized(fresh('midfreeze'));
    expect((await call(sg, '/permit-send', { txId: 'SENT', kind: 'upload', cycle: 1 })).body.granted).toBe(true);
    await call(sg, '/freeze', { active: true });
    expect((await call(sg, '/permit-send', { txId: 'PARKED', kind: 'upload', cycle: 1 })).body.code).toBe(SPEND_CODES.frozen);
    expect((await call(sg, '/permit-send', { txId: 'SENT', kind: 'resend', cycle: 1 })).body).toMatchObject({ granted: true, existing: true });
  });
});

describe('deposits, prepare, activate, settle — the ledger on storage', () => {
  it('review #6 counterexample: transfers at/below the marker are refused, one above is credited exactly once', async () => {
    const sg = await initialized(fresh('deposit'), 104); // h_init = 105
    expect((await credit(sg, 'D100', '500', 100)).status).toBe(409);
    expect((await credit(sg, 'D105', '500', 105)).body.code).toBe(SPEND_CODES.depositBeforeMarker);
    const ok = await credit(sg, 'D106', '500', 106);
    expect(ok.body).toMatchObject({ credited: true, deposits: '500', available: '500' });
    expect((await credit(sg, 'D106', '500', 106)).body).toMatchObject({ credited: false, available: '500' });
  });

  it('prepare before done → spend_not_initialized; quote must match size and reward and be fresh', async () => {
    const sg = fresh('prep-init');
    const q = await quote(sg, 1000, '10');
    expect((await call(sg, '/prepare', { spendKey: 'k1', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 })).body.code).toBe(SPEND_CODES.notInitialized);
    await initialized(sg);
    await credit(sg, 'D', '1000', 2000);
    expect((await call(sg, '/prepare', { spendKey: 'k1', reward: '11', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 })).body.code).toBe(SPEND_CODES.quoteMismatch);
    expect((await call(sg, '/prepare', { spendKey: 'k1', reward: '10', revision: 1, quoteId: q, bytes: 999, limits: LIMITS, now: T0 })).body.code).toBe(SPEND_CODES.quoteMismatch);
    expect((await call(sg, '/prepare', { spendKey: 'k1', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 + PRICE_QUOTE_TTL_MS })).body.code).toBe(SPEND_CODES.quoteMismatch);
    const ok = await call(sg, '/prepare', { spendKey: 'k1', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 });
    expect(ok.body).toMatchObject({ state: 'prepared', available: '990' });
  });

  it('the §3.4 detector: a gateway minimum below available refuses prepare until reinit; the floor and the window cap bite', async () => {
    const sg = await initialized(fresh('detector'));
    await credit(sg, 'D', '1000', 2000);
    const q = await quote(sg, 1000, '10');
    await call(sg, '/refresh-balance', { observedMin: '999', now: T0 });
    expect((await call(sg, '/prepare', { spendKey: 'k', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 })).body.code).toBe(SPEND_CODES.ledgerInconsistent);
    await call(sg, '/refresh-balance', { observedMin: '1000', now: T0 });
    expect((await call(sg, '/prepare', { spendKey: 'k', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: { ...LIMITS, walletFloor: '995' }, now: T0 })).body.code).toBe(SPEND_CODES.floor);
    expect((await call(sg, '/prepare', { spendKey: 'k', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: { ...LIMITS, windowCap: '9' }, now: T0 })).body.code).toBe(SPEND_CODES.windowCap);
  });

  it('prepare → activate → settle(spent): pending moves to spent, the bucket counts, a second settle is a no-op, released→spent dominates', async () => {
    const sg = await initialized(fresh('saga'));
    await credit(sg, 'D', '1000', 2000);
    const q = await quote(sg, 1000, '10');
    expect((await call(sg, '/prepare', { spendKey: 'k', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 })).status).toBe(200);
    expect((await call(sg, '/activate', { spendKey: 'k', reward: '10', revision: 1, activatedBy: 'w1', limits: LIMITS, now: T0 })).body).toMatchObject({ state: 'active', outcome: 'activate' });
    expect((await call(sg, '/activate', { spendKey: 'k', reward: '10', revision: 1, activatedBy: 'w2', limits: LIMITS, now: T0 })).body.code).toBe(SPEND_CODES.activateConflict);
    expect((await call(sg, '/settle', { spendKey: 'k', outcome: 'spent', now: T0 })).body).toMatchObject({ state: 'spent', conflict: false, available: '990' });
    expect((await call(sg, '/settle', { spendKey: 'k', outcome: 'spent', now: T0 })).body).toMatchObject({ state: 'spent', available: '990' });
    expect((await call(sg, '/settle', { spendKey: 'k', outcome: 'released', now: T0 })).status).toBe(409);
    const s = await status(sg);
    expect(s.ledger).toMatchObject({ spent: '10', pending: '0' });
    expect(s.spentLast24h).toBe('10');

    // released → spent dominates with a conflict flag (money left after all).
    const q2 = await quote(sg, 1000, '10');
    await call(sg, '/prepare', { spendKey: 'k2', reward: '10', revision: 1, quoteId: q2, bytes: 1000, limits: LIMITS, now: T0 });
    await call(sg, '/activate', { spendKey: 'k2', reward: '10', revision: 1, activatedBy: 'w1', limits: LIMITS, now: T0 });
    expect((await call(sg, '/settle', { spendKey: 'k2', outcome: 'released', now: T0 })).body).toMatchObject({ state: 'released', available: '990' });
    expect((await call(sg, '/settle', { spendKey: 'k2', outcome: 'spent', now: T0 })).body).toMatchObject({ state: 'spent', conflict: true, available: '980' });
  });

  it('activate remap: a changed reward is re-checked under §5 in one step; refusal rolls back', async () => {
    const sg = await initialized(fresh('remap'));
    await credit(sg, 'D', '200', 2000);
    const q = await quote(sg, 1000, '10');
    await call(sg, '/prepare', { spendKey: 'k', reward: '10', revision: 1, quoteId: q, bytes: 1000, limits: LIMITS, now: T0 });
    expect((await call(sg, '/activate', { spendKey: 'k', reward: '20', revision: 2, activatedBy: 'w1', limits: LIMITS, now: T0 })).body).toMatchObject({ state: 'active', outcome: 'remap' });
    expect((await status(sg)).ledger.pending).toBe('20');
    const q2 = await quote(sg, 1000, '10');
    await call(sg, '/prepare', { spendKey: 'k3', reward: '10', revision: 1, quoteId: q2, bytes: 1000, limits: LIMITS, now: T0 });
    const refused = await call(sg, '/activate', { spendKey: 'k3', reward: '500', revision: 2, activatedBy: 'w1', limits: { ...LIMITS, maxTxReward: '1000' }, now: T0 });
    expect(refused.body.code).toBe(SPEND_CODES.remapRefused);
    expect((await status(sg)).ledger.pending).toBe('30'); // 20 + the untouched prepared 10
  });

  it('expired prepared leases are released; active reservations never expire', async () => {
    const sg = await initialized(fresh('lease'));
    await credit(sg, 'D', '1000', 2000);
    const q1 = await quote(sg, 1000, '10'); const q2 = await quote(sg, 1000, '10');
    await call(sg, '/prepare', { spendKey: 'a', reward: '10', revision: 1, quoteId: q1, bytes: 1000, limits: LIMITS, now: T0 });
    await call(sg, '/prepare', { spendKey: 'b', reward: '10', revision: 1, quoteId: q2, bytes: 1000, limits: LIMITS, now: T0 });
    await call(sg, '/activate', { spendKey: 'b', reward: '10', revision: 1, activatedBy: 'w1', limits: LIMITS, now: T0 });
    expect((await call(sg, '/expire-leases', { now: T0 + PREPARED_LEASE_MS - 1 })).body.expired).toBe(0);
    expect((await call(sg, '/expire-leases', { now: T0 + PREPARED_LEASE_MS })).body).toMatchObject({ expired: 1, released: '10' });
    expect((await status(sg)).ledger.pending).toBe('10');
  });
});

describe('legacy holds and reinit — cycle ledger ≠ audit ≠ budget', () => {
  it('init-legacy holds are pending, resolved above the marker → spent, at/below → dropped; idempotent by txId', async () => {
    const sg = fresh('legacy');
    await call(sg, '/freeze', { active: true, now: T0 });
    expect((await call(sg, '/init-legacy', { items: [{ txId: 'L1', reward: '20', source: 'journal' }, { txId: 'L2', reward: '5', source: 'permit' }] })).body).toMatchObject({ held: 2, pending: '25' });
    expect((await call(sg, '/init-legacy', { items: [{ txId: 'L1', reward: '20', source: 'journal' }] })).body).toMatchObject({ held: 1, pending: '25' });
    await call(sg, '/init-begin', { token: 'tok', now: T0 });
    await call(sg, '/init-signed', { token: 'tok', txId: 'MARKER', signedTx: 'b', anchor: 'a', now: T0 });
    await call(sg, '/init-posted', { token: 'tok', txId: 'MARKER', now: T0 });
    await call(sg, '/init-done', { txId: 'MARKER', heights: [100, 100], confirmations: [60, 60], now: T0 });
    await call(sg, '/freeze', { active: false });
    expect((await status(sg)).ledger).toMatchObject({ hInit: 100, deposits: '0', spent: '0', pending: '25' });
    await credit(sg, 'D', '100', 200);
    expect((await status(sg)).available).toBe('75');
    expect((await call(sg, '/legacy-resolve', { txId: 'L1', outcome: 'spent', now: T0 })).body).toMatchObject({ state: 'spent', available: '75' });
    expect((await call(sg, '/legacy-resolve', { txId: 'L2', outcome: 'dropped', now: T0 })).body).toMatchObject({ state: 'dropped', available: '80' });
    expect((await status(sg)).ledger).toMatchObject({ spent: '20', pending: '0' });
    expect((await status(sg)).spentLast24h).toBe('20');
  });

  it('review #8 scenario through the DO: 1000 in, 900 spent, reinit, 100 back → available 100; the window cap still sees the 900', async () => {
    const sg = await initialized(fresh('reinit'), 1000);
    await credit(sg, 'D1', '1000', 2000);
    const q = await quote(sg, 1000, '900');
    const big = { ...LIMITS, maxTxReward: '1000', windowCap: '950', walletFloor: '0' };
    await call(sg, '/prepare', { spendKey: 'k', reward: '900', revision: 1, quoteId: q, bytes: 1000, limits: big, now: T0 });
    await call(sg, '/activate', { spendKey: 'k', reward: '900', revision: 1, activatedBy: 'w1', limits: big, now: T0 });
    await call(sg, '/settle', { spendKey: 'k', outcome: 'spent', now: T0 });
    expect((await status(sg)).available).toBe('100');
    expect((await call(sg, '/reinit', {})).body.code).toBe(SPEND_CODES.initNotFrozen);
    await call(sg, '/freeze', { active: true, now: T0 + 1 });
    expect((await call(sg, '/reinit', {})).body).toMatchObject({ archivedCycle: 1, cycle: 2 });
    let s = await status(sg);
    expect(s.ledger).toMatchObject({ cycle: 2, hInit: null, deposits: '0', spent: '0', pending: '0' });
    expect(s.init).toMatchObject({ state: 'none', cycle: 2 });
    // New marker for cycle 2, then the 100 returned above it.
    await call(sg, '/init-begin', { token: 't2', now: T0 + 2 });
    await call(sg, '/init-signed', { token: 't2', txId: 'MARKER2', signedTx: 'b', anchor: 'a', now: T0 + 2 });
    await call(sg, '/init-posted', { token: 't2', txId: 'MARKER2', now: T0 + 2 });
    await call(sg, '/init-done', { txId: 'MARKER2', heights: [3000, 3000], confirmations: [60, 60], now: T0 + 2 });
    await call(sg, '/freeze', { active: false });
    expect((await credit(sg, 'D2', '100', 3001)).body).toMatchObject({ credited: true, available: '100' });
    s = await status(sg);
    expect(s.available).toBe('100');          // not −800
    expect(s.spentLast24h).toBe('900');       // the budget is cross-cycle
    const q2 = await quote(sg, 1000, '10', T0 + 3);
    // 900 already in the window + 10 > a cap of 905: the old cycle's spending still counts.
    expect((await call(sg, '/prepare', { spendKey: 'k2', reward: '10', revision: 1, quoteId: q2, bytes: 1000, limits: { ...big, windowCap: '905' }, now: T0 + 3 })).body.code).toBe(SPEND_CODES.windowCap);
  });
});
