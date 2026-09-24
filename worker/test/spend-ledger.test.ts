import { describe, it, expect } from 'vitest';
import {
  ANCHOR_EXPIRY_BLOCKS, ANCHOR_EXPIRY_MARGIN_BLOCKS, MAX_STATUS_HEIGHT_SKEW, MIN_DEPOSIT_CONFIRMATIONS, PREPARED_LEASE_MS, SPEND_CODES, SPEND_WINDOW_MS, HOUR_MS,
  activateOutcome, addToBucket, anchorExpired, available, creditDeposit, initTransition, leaseOpen, moneyQuorum, permitDecision, prepareDecision,
  refusalBranch, reinit, resolveLegacy, settle, spentLast24h,
  type CycleLedger, type InitRecord, type FreezeState,
} from '../src/spend-ledger';

// D10 SpendGuard — the pure rules, executable now (spec rev. 10 §3–§7, §4.0–4.4).
// The DO + network cases of the §12 test map live as `it.todo` in the
// spend-guard.*.test.ts files beside this one until PR-3b opens its window.

const ledger = (over: Partial<CycleLedger> = {}): CycleLedger =>
  ({ cycle: 1, hInit: 100, deposits: 0n, spent: 0n, pending: 0n, ...over });
const init = (over: Partial<InitRecord> = {}): InitRecord => ({ state: 'none', cycle: 1, attempts: 0, ...over });
const thawed: FreezeState = { active: false, epoch: 1 };
const frozen: FreezeState = { active: true, epoch: 2, since: 1 };
const LIMITS = { walletFloor: 100n, windowCap: 1_000n, maxTxReward: 50n };

describe('§3 ledger — available = deposits − spent − pending, never a gateway balance', () => {
  it('arithmetic', () => {
    expect(available(ledger({ deposits: 1_000n, spent: 300n, pending: 200n }))).toBe(500n);
  });

  it('review #8 scenario: deposited 1000, spent 900, reinit, returned 100 → available = 100, not −800', () => {
    const c1 = ledger({ deposits: 1_000n, spent: 900n });
    const r = reinit(c1, 0n, true);
    expect('ok' in r).toBe(false);
    const { ledger: c2, archived } = r as Exclude<typeof r, { ok: false }>;
    expect(archived).toEqual(c1);                       // the whole cycle, as-is
    expect(c2).toMatchObject({ cycle: 2, hInit: null, deposits: 0n, spent: 0n, pending: 0n });
    const credited = creditDeposit({ ...c2, hInit: 200 }, new Set(), { txId: 'D', amount: 100n, depositHeight: 201 });
    expect(credited.ok && credited.credited).toBe(true);
    expect(available((credited as { ok: true; ledger: CycleLedger }).ledger)).toBe(100n);
  });

  it('reinit carries `held` into the new pending and refuses without freeze', () => {
    const r = reinit(ledger(), 70n, true) as { ledger: CycleLedger };
    expect(r.ledger.pending).toBe(70n);
    expect(reinit(ledger(), 0n, false)).toEqual({ ok: false, code: SPEND_CODES.initNotFrozen });
  });
});

describe('§3/§4.4 the 24 h window is cross-cycle', () => {
  it('counts the bucket straddling the window start IN FULL (conservative), drops older ones', () => {
    // Review 24.09 (high): a spend at 10:59 must still count at 10:01 the
    // next day (23 h 02 min later); hour buckets cannot locate it inside the
    // hour, so the whole boundary bucket counts.
    const now = 100 * HOUR_MS + 60_000;                                        // «10:01»
    let b = addToBucket(new Map(), now - SPEND_WINDOW_MS + 58 * 60_000, 500n); // «10:59» the day before: 23 h 02 min ago → boundary bucket, COUNTS
    b = addToBucket(b, now - SPEND_WINDOW_MS - 2 * 60_000, 900n);              // «09:59» the day before: 24 h 02 min ago → one bucket older → dropped
    b = addToBucket(b, now, 200n);
    expect(spentLast24h(b, now)).toBe(700n);
  });

  it('survives reinit by construction: the cap still bites after a fresh cycle', () => {
    const now = 100 * HOUR_MS;
    let b = addToBucket(new Map(), now - SPEND_WINDOW_MS - 2 * HOUR_MS, 500n); // outside even conservatively
    b = addToBucket(b, now - SPEND_WINDOW_MS + HOUR_MS, 300n);                // inside
    b = addToBucket(b, now, 200n);
    expect(spentLast24h(b, now)).toBe(500n);
    // A fresh cycle changes nothing about the buckets: the cap still bites.
    const fresh = (reinit(ledger({ spent: 900n }), 0n, true) as { ledger: CycleLedger }).ledger;
    expect(prepareDecision({
      ledger: { ...fresh, hInit: 1, deposits: 10_000n }, initDone: true, frozen: false, limits: { ...LIMITS, windowCap: 505n },
      reward: 10n, spentLast24h: spentLast24h(b, now), observedMin: null,
    })).toEqual({ ok: false, code: SPEND_CODES.windowCap });
  });
});

describe('§4.1 marker automaton', () => {
  const begin = (rec: InitRecord, over: Partial<Extract<Parameters<typeof initTransition>[1], { kind: 'begin' }>> = {}) =>
    initTransition(rec, { kind: 'begin', token: 't1', now: 1_000, frozen: true, legacyOpen: false, rewardUnknown: false, ...over });

  it('begin is refused without freeze, with an open legacy set, with unknown legacy rewards, when done, when in progress', () => {
    expect(begin(init(), { frozen: false })).toEqual({ ok: false, code: SPEND_CODES.initNotFrozen });
    expect(begin(init(), { legacyOpen: true })).toEqual({ ok: false, code: SPEND_CODES.initLegacyOpen });
    expect(begin(init(), { rewardUnknown: true })).toEqual({ ok: false, code: SPEND_CODES.initLegacyRewardUnknown });
    expect(begin(init({ state: 'done' }))).toEqual({ ok: false, code: SPEND_CODES.alreadyInitialized });
    expect(begin(init({ state: 'signing', token: 't0', dueAt: 5_000 }))).toEqual({ ok: false, code: SPEND_CODES.initInProgress });
    expect(begin(init({ state: 'signed', token: 't0', txId: 'X' }))).toEqual({ ok: false, code: SPEND_CODES.initInProgress });
  });

  it('two concurrent begins: one token owns the record; an expired signing lease can be taken over', () => {
    const first = begin(init()) as { ok: true; record: InitRecord };
    expect(first.record).toMatchObject({ state: 'signing', token: 't1', attempts: 1, dueAt: 1_000 + PREPARED_LEASE_MS });
    expect(initTransition(first.record, { kind: 'begin', token: 't2', now: 1_001, frozen: true, legacyOpen: false, rewardUnknown: false }))
      .toEqual({ ok: false, code: SPEND_CODES.initInProgress });
    const takeover = initTransition(first.record, { kind: 'begin', token: 't2', now: 1_000 + PREPARED_LEASE_MS + 1, frozen: true, legacyOpen: false, rewardUnknown: false });
    expect(takeover.ok && takeover.record.token).toBe('t2');
  });

  it('signed: only the owning token, only inside the lease; the losing signature is dropped', () => {
    const signing = init({ state: 'signing', token: 't1', dueAt: 5_000, attempts: 1 });
    expect(initTransition(signing, { kind: 'signed', token: 'other', txId: 'X', signedTx: 'bytes', anchor: 'a', now: 2_000 }))
      .toEqual({ ok: false, code: SPEND_CODES.staleToken });
    expect(initTransition(signing, { kind: 'signed', token: 't1', txId: 'X', signedTx: 'bytes', anchor: 'a', now: 5_000 }))
      .toEqual({ ok: false, code: SPEND_CODES.staleToken });
    const ok = initTransition(signing, { kind: 'signed', token: 't1', txId: 'X', signedTx: 'bytes', anchor: 'a', now: 2_000 });
    expect(ok.ok && ok.record).toMatchObject({ state: 'signed', txId: 'X', signedTx: 'bytes' });
  });

  it('posted: CAS on {txId, token}, idempotent once posted', () => {
    const signed = init({ state: 'signed', token: 't1', txId: 'X', signedTx: 'b', attempts: 1 });
    expect(initTransition(signed, { kind: 'posted', token: 't1', txId: 'Y', now: 1 })).toEqual({ ok: false, code: SPEND_CODES.staleToken });
    const posted = initTransition(signed, { kind: 'posted', token: 't1', txId: 'X', now: 1 }) as { ok: true; record: InitRecord };
    expect(posted.record.state).toBe('posted');
    expect(initTransition(posted.record, { kind: 'posted', token: 't1', txId: 'X', now: 2 })).toEqual({ ok: true, record: posted.record });
  });

  it('done: ≥2 agreeing operators past MIN_DEPOSIT_CONFIRMATIONS within the skew; h_init = max height', () => {
    const posted = init({ state: 'posted', token: 't1', txId: 'X', signedTx: 'b', attempts: 1 });
    const done = (heights: number[], confirmations: number[]) =>
      initTransition(posted, { kind: 'done', txId: 'X', heights, confirmations, now: 9 });
    expect(done([1000], [100])).toEqual({ ok: false, code: SPEND_CODES.balanceQuorum });
    expect(done([1000, 1001], [100, MIN_DEPOSIT_CONFIRMATIONS - 1])).toEqual({ ok: false, code: SPEND_CODES.balanceQuorum });
    expect(done([1000, 1000 + MAX_STATUS_HEIGHT_SKEW + 1], [100, 100])).toEqual({ ok: false, code: SPEND_CODES.balanceQuorum });
    const ok = done([1000, 1000 + MAX_STATUS_HEIGHT_SKEW], [100, 100]);
    expect(ok.ok && ok.record).toMatchObject({ state: 'done', hInit: 1000 + MAX_STATUS_HEIGHT_SKEW });
    expect(ok.ok && ok.opensCycle).toBe(1);
  });

  it('dead + age guard returns the record to none from signed/posted only', () => {
    const dead = initTransition(init({ state: 'signed', token: 't1', txId: 'X', attempts: 2 }), { kind: 'dead', txId: 'X', now: 1 });
    expect(dead.ok && dead.record).toEqual({ state: 'none', cycle: 1, attempts: 2 });
    expect(initTransition(init({ state: 'done', txId: 'X' }), { kind: 'dead', txId: 'X', now: 1 })).toEqual({ ok: false, code: SPEND_CODES.staleToken });
  });
});

describe('§4.0 permit barrier and the freeze exception', () => {
  const done = init({ state: 'done', txId: 'M', hInit: 100 });
  const permit = (freeze: FreezeState, rec: InitRecord, kind: 'upload' | 'resend' | 'redrop2' | 'marker', txId = 'T', cycle = 1) =>
    permitDecision({ freeze, init: rec, existing: undefined, now: 5 }, { txId, kind, cycle });

  it('frozen: every kind refused except the durable marker of the current cycle', () => {
    for (const kind of ['upload', 'resend', 'redrop2'] as const) {
      expect(permit(frozen, done, kind)).toEqual({ granted: false, code: SPEND_CODES.frozen });
    }
    const signedMarker = init({ state: 'signed', txId: 'M', token: 't', attempts: 1 });
    expect(permit(frozen, signedMarker, 'marker', 'M').granted).toBe(true);
    expect(permit(frozen, signedMarker, 'marker', 'NOT-M')).toEqual({ granted: false, code: SPEND_CODES.frozen });
    expect(permit(frozen, signedMarker, 'marker', 'M', 2)).toEqual({ granted: false, code: SPEND_CODES.frozen });
    expect(permit(frozen, signedMarker, 'upload', 'M')).toEqual({ granted: false, code: SPEND_CODES.frozen });
  });

  it('thawed: uploads need init done; a marker of a foreign cycle is refused', () => {
    expect(permit(thawed, init(), 'upload')).toEqual({ granted: false, code: SPEND_CODES.notInitialized });
    expect(permit(thawed, done, 'upload').granted).toBe(true);
    expect(permit(thawed, done, 'marker', 'M', 2)).toEqual({ granted: false, code: SPEND_CODES.notInitialized });
  });

  it('an existing permit is returned as-is when thawed: resend never double-counts', () => {
    const existing = { txId: 'T', kind: 'upload' as const, cycle: 1, issuedAt: 1 };
    const out = permitDecision({ freeze: thawed, init: done, existing, now: 9 }, { txId: 'T', kind: 'resend', cycle: 1 });
    expect(out).toEqual({ granted: true, permit: existing, existing: true });
  });

  it('review 24.09 (high): an existing permit does NOT bypass the freeze — sent, answer lost, freeze, resend → refused; the permit itself is not the decision', () => {
    const existing = { txId: 'T', kind: 'upload' as const, cycle: 1, issuedAt: 1 };
    expect(permitDecision({ freeze: frozen, init: done, existing, now: 9 }, { txId: 'T', kind: 'resend', cycle: 1 }))
      .toEqual({ granted: false, code: SPEND_CODES.frozen });
    // The one exception survives: the current cycle's durable marker, even on a repeat.
    const signedMarker = init({ state: 'signed', txId: 'M', token: 't', attempts: 1 });
    const markerPermit = { txId: 'M', kind: 'marker' as const, cycle: 1, issuedAt: 1 };
    expect(permitDecision({ freeze: frozen, init: signedMarker, existing: markerPermit, now: 9 }, { txId: 'M', kind: 'marker', cycle: 1 }))
      .toEqual({ granted: true, permit: markerPermit, existing: true });
  });

  it('refusal branch (review #9 H3): abort only for a provably unsent operation', () => {
    expect(refusalBranch({ hadPermit: false, durableRecovery: false })).toBe('abort-before-send');
    expect(refusalBranch({ hadPermit: true, durableRecovery: false })).toBe('keep-and-reconcile');
    expect(refusalBranch({ hadPermit: false, durableRecovery: true })).toBe('keep-and-reconcile');
  });
});

describe('§4.2 credit-deposit (DO side of a verified transfer)', () => {
  it('strictly above the marker, once per txId, positive', () => {
    const l = ledger({ hInit: 105 });
    expect(creditDeposit(l, new Set(), { txId: 'A', amount: 10n, depositHeight: 100 })).toEqual({ ok: false, code: SPEND_CODES.depositBeforeMarker });
    expect(creditDeposit(l, new Set(), { txId: 'A', amount: 10n, depositHeight: 105 })).toEqual({ ok: false, code: SPEND_CODES.depositBeforeMarker });
    const ok = creditDeposit(l, new Set(), { txId: 'B', amount: 10n, depositHeight: 106 });
    expect(ok).toMatchObject({ ok: true, credited: true });
    expect((ok as { ledger: CycleLedger }).ledger.deposits).toBe(10n);
    expect(creditDeposit(l, new Set(['B']), { txId: 'B', amount: 10n, depositHeight: 106 })).toEqual({ ok: true, credited: false, ledger: l });
    expect(creditDeposit(ledger({ hInit: null }), new Set(), { txId: 'C', amount: 1n, depositHeight: 1 })).toEqual({ ok: false, code: SPEND_CODES.notInitialized });
  });
});

describe('§5 prepare — every clause fail-closed', () => {
  const base = { ledger: ledger({ deposits: 1_000n, spent: 100n, pending: 100n }), initDone: true, frozen: false, limits: LIMITS, reward: 10n, spentLast24h: 0n, observedMin: null as bigint | null };
  it('passes when everything holds', () => expect(prepareDecision(base)).toEqual({ ok: true }));
  it('not initialized / frozen / reward above the ceiling', () => {
    expect(prepareDecision({ ...base, initDone: false })).toEqual({ ok: false, code: SPEND_CODES.notInitialized });
    expect(prepareDecision({ ...base, frozen: true })).toEqual({ ok: false, code: SPEND_CODES.frozen });
    expect(prepareDecision({ ...base, reward: 51n })).toEqual({ ok: false, code: SPEND_CODES.quoteMismatch });
  });
  it('detector §3.4: a gateway minimum below available is inconsistent; it can never raise available', () => {
    expect(prepareDecision({ ...base, observedMin: 799n })).toEqual({ ok: false, code: SPEND_CODES.ledgerInconsistent });
    expect(prepareDecision({ ...base, observedMin: 800n })).toEqual({ ok: true });
    expect(prepareDecision({ ...base, observedMin: 1_000_000n, reward: 750n, limits: { ...LIMITS, maxTxReward: 1_000n } })).toEqual({ ok: false, code: SPEND_CODES.floor });
  });
  it('floor and window cap', () => {
    expect(prepareDecision({ ...base, reward: 701n, limits: { ...LIMITS, maxTxReward: 1_000n } })).toEqual({ ok: false, code: SPEND_CODES.floor });
    expect(prepareDecision({ ...base, spentLast24h: 891n })).toEqual({ ok: false, code: SPEND_CODES.windowCap });
    expect(prepareDecision({ ...base, spentLast24h: 890n })).toEqual({ ok: true });
  });
});

describe('§6 activate table', () => {
  const req = { reward: 10n, revision: 3, activatedBy: 'w1' };
  it('prepared: same {reward, revision} → activate, otherwise remap; missing → remap', () => {
    expect(activateOutcome({ state: 'prepared', reward: 10n, revision: 3 }, req)).toBe('activate');
    expect(activateOutcome({ state: 'prepared', reward: 11n, revision: 3 }, req)).toBe('remap');
    expect(activateOutcome(undefined, req)).toBe('remap');
  });
  it('active/settled: same activator → no-op / terminal no-op; other → conflict', () => {
    expect(activateOutcome({ state: 'active', reward: 10n, revision: 3, activatedBy: 'w1' }, req)).toBe('noop');
    expect(activateOutcome({ state: 'spent', reward: 10n, revision: 3, activatedBy: 'w1' }, req)).toBe('terminal-noop');
    expect(activateOutcome({ state: 'active', reward: 10n, revision: 3, activatedBy: 'w2' }, req)).toBe('conflict');
    expect(activateOutcome({ state: 'released', reward: 10n, revision: 3, activatedBy: 'w2' }, req)).toBe('conflict');
  });

  it('review 24.09 (medium): a released reservation that was NEVER activated (expired lease) is remapped, not a conflict', () => {
    expect(activateOutcome({ state: 'released', reward: 10n, revision: 3 }, req)).toBe('remap');
    expect(activateOutcome({ state: 'released', reward: 10n, revision: 3, activatedBy: 'w1' }, req)).toBe('terminal-noop');
  });
});

describe('§7 settle lattice', () => {
  const active = { state: 'active' as const, reward: 10n, revision: 1 };
  it('active → spent / released; same outcome twice is a no-op', () => {
    expect(settle(active, 'spent')).toEqual({ ok: true, state: 'spent', spentDelta: 10n, pendingDelta: -10n, conflict: false });
    expect(settle(active, 'released')).toEqual({ ok: true, state: 'released', spentDelta: 0n, pendingDelta: -10n, conflict: false });
    expect(settle({ ...active, state: 'spent' }, 'spent')).toEqual({ ok: true, state: 'spent', spentDelta: 0n, pendingDelta: 0n, conflict: false });
  });
  it('prepared cannot settle; spent is final; released → spent dominates with a conflict', () => {
    expect(settle({ ...active, state: 'prepared' }, 'spent')).toEqual({ ok: false, reason: 'prepared_cannot_settle' });
    expect(settle({ ...active, state: 'spent' }, 'released')).toEqual({ ok: false, reason: 'spent_is_final' });
    expect(settle({ ...active, state: 'released', activatedBy: 'w1' }, 'spent')).toEqual({ ok: true, state: 'spent', spentDelta: 10n, pendingDelta: 0n, conflict: true });
    // …but only for a reservation that WAS activated: an expired/reinit-released one never reached the network.
    expect(settle({ ...active, state: 'released' }, 'spent')).toEqual({ ok: false, reason: 'never_activated' });
  });
});

describe('§4.0 п. 6 legacy resolution after done', () => {
  it('confirmed above h_init → spent; at/below → dropped; dead+age → dropped; else held', () => {
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'confirmed', height: 101 } })).toBe('spent');
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'confirmed', height: 100 } })).toBe('dropped');
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'dead', ageGuardPassed: true } })).toBe('dropped');
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'dead', ageGuardPassed: false } })).toBe('held');
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'pending' } })).toBe('held');
    expect(resolveLegacy({ hInit: 100, verdict: { kind: 'unavailable' } })).toBe('held');
  });
});

describe('the money quorum counts OPERATORS, not origins (D11 M4 / operator map, review 25.09)', () => {
  const vote = (origin: string, confirmations = 60, blockHeight = 1000) => ({ origin, kind: 'confirmed' as const, confirmations, blockHeight });
  it('two origins of ONE operator are one voice — no quorum; two operators — a quorum; the height is the maximum agreed', () => {
    const same = () => 'op';
    expect(moneyQuorum([vote('https://a'), vote('https://b')], same)).toEqual({ ok: false, operators: 1 });
    const two = (o: string) => (o === 'https://a' ? 'op-a' : 'op-b');
    expect(moneyQuorum([vote('https://a', 60, 1000), vote('https://b', 61, 1002)], two)).toMatchObject({ ok: true, height: 1002, operators: 2 });
  });
  it('an origin the map does not know casts NO vote (fail-closed): it neither forms a quorum nor becomes a voice of its own', () => {
    const partial = (o: string) => (o === 'https://a' ? 'op-a' : null);
    expect(moneyQuorum([vote('https://a'), vote('https://b')], partial)).toEqual({ ok: false, operators: 1 });
    expect(moneyQuorum([vote('https://b'), vote('https://c')], () => null)).toEqual({ ok: false, operators: 0 });
    // …and never lends its height to the agreed set.
    const three = (o: string) => (o === 'https://c' ? null : o);
    expect(moneyQuorum([vote('https://a', 60, 1000), vote('https://b', 60, 1001), vote('https://c', 60, 5000)], three)).toMatchObject({ ok: true, height: 1001, operators: 2 });
  });
});

describe('the anchor rule (review 24.09 #5, high 1) — the ONE proof that permitted bytes cannot land', () => {
  it('expires exactly at anchorHeight + ANCHOR_EXPIRY_BLOCKS + margin; never on bad numbers; the lease is open while set, whatever the clock says', () => {
    const edge = 1000 + ANCHOR_EXPIRY_BLOCKS + ANCHOR_EXPIRY_MARGIN_BLOCKS;
    expect(anchorExpired(1000, edge - 1)).toBe(false);
    expect(anchorExpired(1000, edge)).toBe(true);
    expect(anchorExpired(1000, 999_999)).toBe(true);
    expect(anchorExpired(1000, 1000)).toBe(false);
    expect(anchorExpired(1000, 900)).toBe(false);
    expect(anchorExpired(1.5, 5000)).toBe(false);
    expect(anchorExpired(-1, 5000)).toBe(false);
    expect(anchorExpired(1000, Number.NaN)).toBe(false);
    expect(leaseOpen(undefined)).toBe(false);
    expect(leaseOpen({ sending: undefined })).toBe(false);
    expect(leaseOpen({ sending: { token: 't', since: 0 } })).toBe(true);
    expect(leaseOpen({ sending: { token: 't', since: -365 * 24 * 3_600_000 } })).toBe(true);
    // A proven expiry binds nothing, whatever `sending` says (review #6, medium).
    expect(leaseOpen({ sending: { token: 't', since: 0 }, anchorExpired: { anchorHeight: 1, chainHeight: 999, at: 0 } })).toBe(false);
  });
});
