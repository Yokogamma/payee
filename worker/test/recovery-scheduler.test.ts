import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { RateLimiter } from '../src/rate-limiter';
import {
  ALARM_BATCH, MONEY_STALE_BACKOFF_MS, MONEY_STALE_MS, RECOVERY_AGE_GUARD_MS, RECOVERY_BACKOFF_BASE_MS, RECOVERY_COUNT_KEY,
  backoffMs, casOf, parseSignedTx, signedAction, toPosted,
  type RecoveryRecord,
} from '../src/recovery';
import { ANCHOR_EXPIRY_BLOCKS, ANCHOR_EXPIRY_MARGIN_BLOCKS, SPEND_CODES } from '../src/spend-ledger';
import { spendKeyFor } from '../src/spend-saga';
import { setupOutboundMock, STATUS_ORIGINS, statusUrlRe } from './helpers/outbound-mock';
import {
  RATE_LIMITER,
  confirmedOnAll, deadOnAll, fpOf, guardCall, makeIdentity, opRecord, paidLegs, sagaEnv, statusBody, upload, uploadRequest,
} from './helpers/spend-saga';
import { getArweave } from '../src/arweave-transport';

// PR-3b reader release, step 4: the single-alarm scheduler over durable
// `signed` / `redrop_pending` records (plan §4.PR-3b «Single-alarm scheduler»,
// «Вердикты alarm-прогона», «Redrop — явно двухфазный», «Bounded backlog»)
// on the REAL per-key DO, with a stubbed gateway pool and an isolated funded
// SpendGuard. Records are seeded through `adoptRecovery` — the WRITER's
// primitive — because the reader never creates them from an upload.
//
// Two facts of the harness shape every test: (1) an alarm set in the PAST
// fires on its own at once, so records are seeded with a far-future `dueAt`
// and the run is driven explicitly with `runRecovery(now)`; (2) the DO sees
// the BINDING env, so the isolated guard and the signable wallet are handed
// to the instance through the `useEnvForTests` seam.

/** «Far enough»: records are due only when a test says so. */
const FAR = Date.now() + 1_000_000_000;

const { mockRoute } = setupOutboundMock();
const uuidV4 = () => crypto.randomUUID();
const ANCHOR = 'A'.repeat(64);
/** The anchor block's height in every test that needs the chain. */
const ANCHOR_HEIGHT = 1000;
/** The height at which the anchor has provably expired (the rule + margin). */
const EXPIRED_AT = ANCHOR_HEIGHT + ANCHOR_EXPIRY_BLOCKS + ANCHOR_EXPIRY_MARGIN_BLOCKS;
const originRe = (origin: string, path: string) => new RegExp('^' + origin.replace(/\./g, '\\.') + path.replace(/\//g, '\\/') + '$');
/** Both operators answer the two chain questions of the proof of expiry:
 *  the anchor block's height and the chain height. */
function chainAt(height: number, opts: { anchorHeight?: number; per?: Partial<Record<string, number>> } = {}) {
  for (const o of STATUS_ORIGINS) {
    mockRoute('GET', originRe(o, `/block/hash/${ANCHOR}`), 200, JSON.stringify({ indep_hash: ANCHOR, height: opts.anchorHeight ?? ANCHOR_HEIGHT }));
    mockRoute('GET', originRe(o, '/info'), 200, JSON.stringify({ height: opts.per?.[o] ?? height }));
  }
}

/** A REAL signed transaction (the writer's bytes) for `noteId`, so phase 2
 *  can rebuild the payload and tags from it and the resend can post it. */
async function signedBytes(jwk: string, noteId: string, extra: Record<string, unknown> = {}) {
  const arweave = getArweave();
  const wallet = JSON.parse(jwk);
  const data = JSON.stringify({ id: noteId, c: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ...extra });
  const tx = await arweave.createTransaction({ data, last_tx: ANCHOR, reward: '10' }, wallet);
  tx.addTag('App-Name', 'EternalNotes');
  tx.addTag('App-Version', '2');
  tx.addTag('Note-Id', noteId);
  await arweave.transactions.sign(tx, wallet);
  return { txId: tx.id, signedTx: JSON.stringify(tx.toJSON()), data };
}

async function seed(env: unknown, pkB64: string, noteId: string, record: RecoveryRecord) {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(pkB64));
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]);
    return (instance as unknown as RateLimiter).adoptRecovery(noteId, record);
  });
  return stub;
}

async function note(stub: DurableObjectStub, noteId: string) {
  return runInDurableObject(stub, (_i, state) => state.storage.get<RecoveryRecord & { status: string; postedAt?: number }>(`note:${noteId}`));
}
type MoneyRow = { txId: string; dueAt: number; attempts: number; postedAt: number; watching?: boolean };
type RecoveryStatus = { recoveryCount: number; alarm: number | null; due: Record<string, number>; money: Record<string, MoneyRow> };
async function recoveryStatus(stub: DurableObjectStub): Promise<RecoveryStatus> {
  const res = await stub.fetch('http://do/recovery-status', { method: 'POST', body: '{}' });
  return (await res.json()) as RecoveryStatus;
}
/** The money entries of one note (`money:<noteId>:<txId>` — a redrop keeps
 *  the dead txId under watch next to the new one, review #4 H2). */
function moneyRows(rs: RecoveryStatus, noteId: string): MoneyRow[] {
  return Object.entries(rs.money).filter(([k]) => k.startsWith(`${noteId}:`)).map(([, v]) => v);
}
/** The ONE money entry of a note (the test asserts there is exactly one). */
function moneyOf(rs: RecoveryStatus, noteId: string): MoneyRow {
  const rows = moneyRows(rs, noteId);
  expect(rows).toHaveLength(1);
  return rows[0];
}
async function runNow(stub: DurableObjectStub, now = Date.now()) {
  return runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).runRecovery(now));
}

/** A `signed` record as the writer leaves it: activated reservation in the
 *  guard, a permit already issued (the first POST's answer was lost). */
/** `sendDone: false` leaves the writer's send lease LIVE (a sender still in
 *  flight, or crashed before reporting); by default the send completed and
 *  reported — only its answer was lost. */
async function writerSigned(ns: DurableObjectNamespace, pkB64: string, noteId: string, jwk: string, opts: { permitted?: boolean; sendDone?: boolean; ageMs?: number; signedTx?: string; txId?: string } = {}) {
  const bytes = await signedBytes(jwk, noteId);
  const txId = opts.txId ?? bytes.txId;
  const spendKey = await spendKeyFor(pkB64, noteId, 'g1');
  const q = await guardCall(ns, '/refresh-price', { bytes: 100, reward: '10' });
  expect((await guardCall(ns, '/prepare', { spendKey, reward: '10', revision: 0, quoteId: q.body.quoteId, bytes: 100, limits: { walletFloor: '0', windowCap: '1000000', maxTxReward: '1000' } })).status).toBe(200);
  expect((await guardCall(ns, '/activate', { spendKey, reward: '10', revision: 0, activatedBy: '10:0' })).status).toBe(200);
  if (opts.permitted !== false) {
    const p = await guardCall(ns, '/permit-send', { txId, kind: 'upload', cycle: 1, spendKey, anchor: ANCHOR });
    expect(p.status).toBe(200);
    if (opts.sendDone !== false) expect((await guardCall(ns, '/send-done', { txId, sendToken: p.body.sendToken })).body.cleared).toBe(true);
  }
  const now = Date.now() - (opts.ageMs ?? 0);
  const record: RecoveryRecord = {
    status: 'signed', token: uuidV4(), gen: 0, txId, signedTx: opts.signedTx ?? bytes.signedTx,
    signedAt: now, dueAt: FAR, attempts: 0, spendKey, reward: '10', spendRevision: 0, generation: 1,
    fp: await fpOf(noteId), reservedAt: now,
  };
  return { record, bytes, spendKey };
}

describe('pure rules', () => {
  it('backoff doubles from one minute and caps at an hour; the verdict table is the plan\'s', () => {
    expect(backoffMs(0)).toBe(RECOVERY_BACKOFF_BASE_MS);
    expect(backoffMs(3)).toBe(8 * RECOVERY_BACKOFF_BASE_MS);
    expect(backoffMs(40)).toBe(3_600_000);
    const r = { signedAt: 1000, postedAt: undefined };
    expect(signedAction({ kind: 'confirmed', confirmations: 1, blockHeight: 1 }, r, 2000)).toBe('advance_posted');
    expect(signedAction({ kind: 'pending' }, r, 2000)).toBe('reschedule');
    expect(signedAction({ kind: 'unavailable' }, r, 2000)).toBe('resend');
    expect(signedAction({ kind: 'dead' }, r, 1000 + RECOVERY_AGE_GUARD_MS)).toBe('resend');
    expect(signedAction({ kind: 'dead' }, r, 1001 + RECOVERY_AGE_GUARD_MS)).toBe('redrop');
    // The age guard counts from the LATEST durable event.
    expect(signedAction({ kind: 'dead' }, { signedAt: 1000, postedAt: 5000 }, 1001 + RECOVERY_AGE_GUARD_MS)).toBe('resend');
  });

  it('parseSignedTx accepts only bytes that carry the expected txId, data and tags', () => {
    const good = JSON.stringify({ id: 'T', data: 'AA', tags: [{ name: 'QQ', value: 'WW' }], reward: '1' });
    expect(parseSignedTx(good, 'T')).toMatchObject({ id: 'T', data: 'AA', reward: '1' });
    expect(parseSignedTx(good, 'OTHER')).toBeNull();
    expect(parseSignedTx('{not json', 'T')).toBeNull();
    expect(parseSignedTx(JSON.stringify({ id: 'T', data: 'AA', tags: [{ name: 1 }], reward: '1' }), 'T')).toBeNull();
    expect(parseSignedTx(JSON.stringify({ id: 'T', tags: [], reward: '1' }), 'T')).toBeNull();
  });
});

describe('signed: reconciliation by the quorum, resend of the same bytes', () => {
  it('confirmed → posted (the money settles only under the guard\'s quorum); the record leaves the scheduler set, the alarm is cleared', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-confirmed', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    const rs0 = await recoveryStatus(stub);
    expect(rs0.recoveryCount).toBe(1);
    expect(rs0.alarm).toBe(FAR);
    expect((await status()).ledger.pending).toBe('10');
    // Not due yet: the alarm handler does nothing.
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).alarm());
    expect((await note(stub, noteId))?.status).toBe('signed');
    // A weak confirmation moves the RECORD (liveness), not the money.
    mockRoute('GET', statusUrlRe('https://arweave.net', record.txId), 200, statusBody(100, 0));
    mockRoute('GET', statusUrlRe('https://g2.test', record.txId), 503, 'down');
    expect(await runNow(stub, FAR)).toEqual({ processed: 1, remaining: 0, money: 0 });
    expect(await note(stub, noteId)).toMatchObject({ status: 'posted', txId: record.txId });
    expect((await status()).ledger).toMatchObject({ pending: '10', spent: '0' });
    const rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(0);
    expect(rs.due).toEqual({});
    // The MONEY of this txId is still pending in the guard: the note moved
    // to the money index, and the alarm follows it (review #2, H4).
    expect(moneyOf(rs, noteId)).toMatchObject({ txId: record.txId, attempts: 0 });
    expect(rs.alarm).toBe(moneyOf(rs, noteId).dueAt);
  });

  it('(H1) a run that lost the record to a concurrent phase 1 is stripped of the right to send: terminal activate → discarded, no POST; and the DO refuses the permit of a released reservation for everyone', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-stale', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    // While run A is between the quorum and the send (its `/activate` call is
    // the hook), phase 1 happens: the record becomes redrop_pending and the
    // old reservation is released.
    const { guardWithHook } = await import('./helpers/spend-saga');
    let fired = false;
    // The money effect of the concurrent phase 1 (the other run's second
    // call) lands while A is past its quorum and about to activate.
    const hooked = guardWithHook(ns, '/activate', async () => {
      if (fired) return; fired = true;
      await guardCall(ns, '/settle', { spendKey, outcome: 'released' });
    }, 'before');
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests({ ...env, SPEND_GUARD: hooked } as Parameters<RateLimiter['useEnvForTests']>[0]));
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down')); // → resend path
    const run = await runNow(stub, FAR); // no POST route: a send would throw → post_unknown
    expect(fired).toBe(true);
    expect(run.processed).toBe(1);
    // Discarded BEFORE the send: the terminal activate (released) stripped
    // this run of the right to send — no POST, no reschedule, record untouched.
    expect(await note(stub, noteId)).toMatchObject({ status: 'signed', txId: record.txId, attempts: 0 });
    expect((await status()).ledger.pending).toBe('0');
    // The durable lever: even a permit that was already issued is refused
    // once its reservation is released.
    const p = await guardCall(ns, '/permit-send', { txId: record.txId, kind: 'resend', cycle: 1, spendKey });
    expect(p.status).toBe(503);
    expect(p.body.code).toBe(SPEND_CODES.reservationReleased);
  });

  it('(H1, round 3) the send protocol: while a granted permit is in flight, a releaser is REFUSED (spend_send_in_flight) — the sender posts, reports, and only then can the money be released; phase 2 waits for a live lease instead of signing', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-lease', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey, bytes } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { permitted: false });
    const stub = await seed(env, id.pkB64, noteId, record);
    const { guardWithHook } = await import('./helpers/spend-saga');
    let releaseAnswer: { status: number; body: { code?: string } } | null = null;
    // Right AFTER the permit is granted (the lease is set), another party
    // tries to release the money — the reviewer's late race.
    const hooked = guardWithHook(ns, '/permit-send', async () => {
      if (releaseAnswer) return;
      releaseAnswer = await guardCall(ns, '/settle', { spendKey, outcome: 'released' });
    });
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests({ ...env, SPEND_GUARD: hooked } as Parameters<RateLimiter['useEnvForTests']>[0]));
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down')); // → resend path
    const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');
    await runNow(stub, FAR);
    expect(releaseAnswer).not.toBeNull();
    expect(releaseAnswer!.status).toBe(503);
    expect(releaseAnswer!.body.code).toBe(SPEND_CODES.sendInFlight);
    expect(post.calls).toBe(1);
    expect((JSON.parse(post.lastBody!) as { id: string }).id).toBe(bytes.txId);
    expect(await note(stub, noteId)).toMatchObject({ status: 'posted', txId: record.txId });
    // The money is still held (the release was refused, the send reported).
    expect((await status()).ledger.pending).toBe('10');
    // The lease was cleared by /send-done: a release AFTER the send is allowed.
    expect((await guardCall(ns, '/settle', { spendKey, outcome: 'released' })).body).toMatchObject({ state: 'released' });

    // Phase 2 under a live lease of the OLD permit: rescheduled, nothing signed.
    const noteB = uuidV4();
    const b = await writerSigned(ns, id.pkB64, noteB, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000, sendDone: false });
    await seed(env, id.pkB64, noteB, { ...b.record, status: 'redrop_pending', deadTxId: b.record.txId, dueAt: FAR });
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    // The writer's send of B never reported (sendDone: false): its lease is live.
    await runNow(stub, FAR); // no anchor/price routes: a signature attempt would throw
    expect(await note(stub, noteB)).toMatchObject({ status: 'redrop_pending', attempts: 1 });
    expect((await status()).ledger.pending).toBe('10'); // B's 10 still held
  });

  it('(H2, round 3) a temporary refusal of the guard keeps the money entry: unavailable and spend_send_in_flight → retry with backoff; only a confirmed final state removes it', async () => {
    const { env, ns, status } = await sagaEnv('rec-money-retry', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status).toBe(200);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    // The guard is DOWN during the reconciliation step.
    const down = { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error('guard down'); } }) } as unknown as DurableObjectNamespace;
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests({ ...env, SPEND_GUARD: down } as Parameters<RateLimiter['useEnvForTests']>[0]));
    let entry = moneyOf(await recoveryStatus(stub), noteId);
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, entry.dueAt);
    entry = moneyOf(await recoveryStatus(stub), noteId);
    expect(entry).toMatchObject({ txId: r.body.txId, attempts: 1 });
    expect((await status()).ledger.pending).toBe('10');
    // The guard answers 503 spend_send_in_flight (a live lease on the permit).
    const busy = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: false, code: SPEND_CODES.sendInFlight }), { status: 503 }) }) } as unknown as DurableObjectNamespace;
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests({ ...env, SPEND_GUARD: busy } as Parameters<RateLimiter['useEnvForTests']>[0]));
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, entry.dueAt);
    entry = moneyOf(await recoveryStatus(stub), noteId);
    expect(entry.attempts).toBe(2);
    // The real guard: settled → the entry leaves.
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, entry.dueAt);
    expect((await recoveryStatus(stub)).money).toEqual({});
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    void ns;
  });

  it('(H3, round 3) reserved → committed (mark-posted lost three times) enters the money index too — the reservation is reconciled without any client request', async () => {
    const { env, status } = await sagaEnv('rec-commit', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    // A namespace whose /mark-posted never lands; everything else is real.
    const flaky = {
      idFromName: (n: string) => RATE_LIMITER.idFromName(n),
      get: (did: DurableObjectId) => {
        const real = RATE_LIMITER.get(did);
        return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url).pathname === '/mark-posted') throw new Error('mark-posted lost');
          return real.fetch(input as string, init);
        } } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), { ...env, RATE_LIMITER: flaky });
    expect(r.status).toBe(200);
    expect(r.body.committed).toBe(true);
    expect((await note(stub, noteId))?.status).toBe('committed');
    const rs = await recoveryStatus(stub);
    expect(moneyOf(rs, noteId)).toMatchObject({ txId: r.body.txId, attempts: 0 });
    expect(rs.alarm).toBe(moneyOf(rs, noteId).dueAt);
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, moneyOf(rs, noteId).dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    expect((await recoveryStatus(stub)).money).toEqual({});
  });

  it('(H4) the money index: a fresh upload schedules the reconciliation of its reservation independently of the client; the alarm settles it as spent under a money quorum, or released after a dead verdict past the age guard, and leaves a pre-D10 txId alone', async () => {
    const { env, status } = await sagaEnv('rec-money-idx', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status).toBe(200);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    let rs = await recoveryStatus(stub);
    expect(moneyOf(rs, noteId)).toMatchObject({ txId: r.body.txId, attempts: 0 });
    expect(rs.alarm).toBe(moneyOf(rs, noteId).dueAt);
    expect((await status()).ledger.pending).toBe('10');
    // Not yet mined: pending on both → backoff, entry kept.
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, r.body.txId!), 202, 'Pending'));
    let due = moneyOf(rs, noteId).dueAt;
    expect(await runNow(stub, due)).toEqual({ processed: 0, remaining: 0, money: 1 });
    rs = await recoveryStatus(stub);
    expect(moneyOf(rs, noteId).attempts).toBe(1);
    expect(moneyOf(rs, noteId).dueAt).toBe(due + backoffMs(1));
    // A weak 200 is not money: still pending.
    mockRoute('GET', statusUrlRe('https://arweave.net', r.body.txId!), 200, statusBody(5000, 1));
    mockRoute('GET', statusUrlRe('https://g2.test', r.body.txId!), 503, 'down');
    due = moneyOf(rs, noteId).dueAt;
    await runNow(stub, due);
    expect((await status()).ledger.pending).toBe('10');
    // The money quorum → spent, entry gone, alarm gone (nothing else scheduled).
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    due = moneyOf(await recoveryStatus(stub), noteId).dueAt;
    await runNow(stub, due);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    rs = await recoveryStatus(stub);
    expect(rs.money).toEqual({});
    expect(rs.alarm).toBeNull();

    // A second note: dead past the age guard → released.
    const noteB = uuidV4();
    paidLegs(mockRoute, { price: '7' });
    const rb = await upload(await uploadRequest(id, noteB), env);
    expect(rb.status).toBe(200);
    expect((await status()).ledger.pending).toBe('7');
    deadOnAll(mockRoute, rb.body.txId!);
    const entry = moneyOf(await recoveryStatus(stub), noteB);
    await runNow(stub, entry.postedAt + RECOVERY_AGE_GUARD_MS + 1);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    // Released — but NOT gone: the txId had a permit, and a dead verdict is a
    // snapshot. The entry stays under watch until the CHAIN says the bytes
    // can no longer be accepted (review #4 H2, #5 H1); then, still dead, it
    // leaves. The clock is not an argument: five days with the anchor still
    // inside its window keep the watch.
    const watch = moneyOf(await recoveryStatus(stub), noteB);
    expect(watch).toMatchObject({ txId: rb.body.txId, watching: true, anchor: ANCHOR });
    deadOnAll(mockRoute, rb.body.txId!);
    chainAt(EXPIRED_AT - 1); // dead, but the anchor is still valid → kept
    await runNow(stub, watch.dueAt + 5 * 24 * 3_600_000);
    expect(moneyOf(await recoveryStatus(stub), noteB)).toMatchObject({ watching: true, attempts: 2 });
    deadOnAll(mockRoute, rb.body.txId!);
    chainAt(EXPIRED_AT); // dead, the anchor provably expired, and dead AGAIN after the proof → gone
    deadOnAll(mockRoute, rb.body.txId!);
    await runNow(stub, moneyOf(await recoveryStatus(stub), noteB).dueAt);
    expect((await recoveryStatus(stub)).money).toEqual({});
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });

    // A pre-D10 posted record (no permit): unknown to the guard → the entry
    // is dropped without touching the ledger.
    const noteC = uuidV4();
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put(`note:${noteC}`, { status: 'reserved', token: 'tk', gen: 0, reservedAt: Date.now(), fp: await fpOf(noteC) });
    });
    expect((await (await stub.fetch('http://do/mark-posted', { method: 'POST', body: JSON.stringify({ noteId: noteC, txId: 'OLD'.padEnd(43, 'o'), token: 'tk' }) })).json() as { ok: boolean }).ok).toBe(true);
    const entryC = moneyOf(await recoveryStatus(stub), noteC);
    expect(entryC).toMatchObject({ txId: 'OLD'.padEnd(43, 'o') });
    confirmedOnAll(mockRoute, 'OLD'.padEnd(43, 'o'), 100, 60);
    await runNow(stub, entryC.dueAt);
    expect((await recoveryStatus(stub)).money).toEqual({});
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
  });

  it('confirmed with a MONEY quorum → posted AND spent at the max agreed height', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-money', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    confirmedOnAll(mockRoute, record.txId, 7000, 60);
    await runNow(stub, FAR);
    expect((await note(stub, noteId))?.status).toBe('posted');
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
  });

  it('pending → reschedule with backoff, no POST; unavailable → the SAME bytes are resent under permit-send(resend) and the record becomes posted on 200', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-resend', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, bytes } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    // pending on both → reschedule only.
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 202, 'Pending'));
    const t0 = FAR;
    await runNow(stub, t0);
    let r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'signed', attempts: 1 });
    expect(r!.dueAt).toBe(t0 + backoffMs(1));
    expect((await recoveryStatus(stub)).alarm).toBe(t0 + backoffMs(1));
    // unavailable → resend: the permit is the one already issued (same txId).
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down'));
    const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');
    await runNow(stub, r!.dueAt);
    expect(post.calls).toBe(1);
    expect((JSON.parse(post.lastBody!) as { id: string }).id).toBe(bytes.txId);
    expect(post.lastBody).toBe(bytes.signedTx);
    r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'posted', txId: bytes.txId });
    expect((await recoveryStatus(stub)).recoveryCount).toBe(0);
  });

  it('a signed whose bytes do not match its txId is neither resent nor re-signed: the quorum still moves it (confirmed → posted); otherwise it is rescheduled', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-corrupt', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const other = await signedBytes(wallet.jwk, uuidV4());
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { signedTx: other.signedTx });
    const stub = await seed(env, id.pkB64, noteId, record);
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down'));
    await runNow(stub, FAR); // no POST route: a resend would throw → post_unknown; corrupt bytes are never sent
    expect(await note(stub, noteId)).toMatchObject({ status: 'signed', attempts: 1 });
    confirmedOnAll(mockRoute, record.txId, 100, 1);
    await runNow(stub, FAR + backoffMs(1) + 1);
    expect((await note(stub, noteId))?.status).toBe('posted');
  });

  it('a frozen guard refuses the resend permit: the record is kept (signed, bytes, hold) and rescheduled — no release, no abort', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-frozen', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    await guardCall(ns, '/freeze', { active: true });
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down'));
    await runNow(stub, FAR);
    expect(await note(stub, noteId)).toMatchObject({ status: 'signed', txId: record.txId, signedTx: record.signedTx, attempts: 1 });
    expect((await status()).ledger.pending).toBe('10');
    expect((await recoveryStatus(stub)).recoveryCount).toBe(1);
  });
});

describe('the two-phase redrop', () => {
  it('dead past the age guard → phase 1 (redrop_pending, old reservation released, capacity kept) → phase 2 signs from the STORED data and tags under a new generation, posts under permit-send(redrop2) → posted', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-redrop', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, bytes, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    const stub = await seed(env, id.pkB64, noteId, record);
    // Phase 1 (the age guard is measured against the run's `now`).
    deadOnAll(mockRoute, record.txId);
    await runNow(stub, FAR);
    let r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'redrop_pending', deadTxId: record.txId, txId: record.txId, signedTx: bytes.signedTx, attempts: 0 });
    const rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(1); // capacity is NOT released
    // Due now: phase 2 on the next pass — and the dead txId is under watch in
    // the money index (review #4 H2); the alarm is the earlier of the two.
    expect(moneyOf(rs, noteId)).toMatchObject({ txId: record.txId, attempts: 0 });
    expect(rs.alarm).toBe(Math.min(r!.dueAt, moneyOf(rs, noteId).dueAt));
    expect((await status()).ledger.pending).toBe('0'); // the old reservation was released
    const gstub = ns.get(ns.idFromName('global'));
    expect(await runInDurableObject(gstub, (_i, s) => s.storage.get<{ state: string }>(`res:${spendKey}`))).toMatchObject({ state: 'released' });
    // Phase 2.
    const { post } = paidLegs(mockRoute, { price: '12' });
    await runNow(stub, r!.dueAt);
    r = await note(stub, noteId);
    expect(r!.status).toBe('posted');
    expect(r!.txId).not.toBe(record.txId);
    expect(post!.calls).toBe(1);
    const sent = JSON.parse(post!.lastBody!) as { id: string; data: string; tags: unknown[]; reward: string };
    const old = JSON.parse(bytes.signedTx) as { data: string; tags: unknown[] };
    expect(sent.id).toBe(r!.txId);
    expect(sent.data).toBe(old.data);     // the payload travelled UNCHANGED
    expect(sent.tags).toEqual(old.tags);  // …and so did the tags
    expect(sent.reward).toBe('12');
    const permit = await runInDurableObject(gstub, (_i, s) => s.storage.get<{ kind: string; spendKey: string }>(`permit:${r!.txId}`));
    expect(permit).toMatchObject({ kind: 'redrop2', spendKey: `${spendKey.slice(0, spendKey.lastIndexOf(':'))}:g2` });
    expect((await status()).ledger.pending).toBe('12');
    expect((await recoveryStatus(stub)).recoveryCount).toBe(0);
  });

  it('phase 2 whose network fails after the CAS leaves a NEW signed (resent on the next pass, ONE new txId); a corrupt redrop source never signs', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-phase2fail', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    const stub = await seed(env, id.pkB64, noteId, record);
    deadOnAll(mockRoute, record.txId);
    await runNow(stub, FAR);
    // Phase 2: anchor + price ok, POST fails → the new signed stays, rescheduled.
    paidLegs(mockRoute, { price: '12', post: 500 });
    let r = await note(stub, noteId);
    await runNow(stub, r!.dueAt);
    r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'signed', generation: 2, deadTxId: record.txId, attempts: 1 });
    const newTx = r!.txId;
    expect(newTx).not.toBe(record.txId);
    // Next pass: unavailable → resend of the SAME new bytes, no second signature.
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, newTx), 503, 'down'));
    const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');
    await runNow(stub, r!.dueAt);
    expect((JSON.parse(post.lastBody!) as { id: string }).id).toBe(newTx);
    expect((await note(stub, noteId))).toMatchObject({ status: 'posted', txId: newTx });

    // Corrupt source: redrop_pending whose bytes are not the dead txId.
    const noteB = uuidV4();
    const other = await signedBytes(wallet.jwk, uuidV4());
    const b = await writerSigned(ns, id.pkB64, noteB, wallet.jwk, { signedTx: other.signedTx, ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    await seed(env, id.pkB64, noteB, { ...b.record, status: 'redrop_pending', deadTxId: b.record.txId, dueAt: FAR });
    await runNow(stub, FAR); // no anchor/price/post routes: any signing attempt would throw
    expect(await note(stub, noteB)).toMatchObject({ status: 'redrop_pending', attempts: 1, signedTx: other.signedTx });
  });
});

describe('the send protocol, review 24.09 #4 — three counterexamples closed', () => {
  it('(H1) one executor per txId: a writer\'s send that never reported keeps the resend OUT — permit refused spend_send_in_flight, no POST, rescheduled; after the report the resend goes through under its own lease', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r4-h1', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    // permitted, NOT reported: the writer's executor is (or crashed) mid-POST.
    const { record, bytes } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { sendDone: false });
    const stub = await seed(env, id.pkB64, noteId, record);
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down')); // → resend path
    const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK');
    await runNow(stub, FAR);
    expect(post.calls).toBe(0);
    expect(await note(stub, noteId)).toMatchObject({ status: 'signed', txId: record.txId, attempts: 1 });
    expect((await status()).ledger.pending).toBe('10');
    // The writer's executor reports at last (its token never expires).
    const permit = await runInDurableObject(ns.get(ns.idFromName('global')), (_i, s) => s.storage.get<{ sending?: { token: string } }>(`permit:${record.txId}`));
    expect((await guardCall(ns, '/send-done', { txId: record.txId, sendToken: permit!.sending!.token })).body.cleared).toBe(true);
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down'));
    await runNow(stub, FAR + backoffMs(1));
    expect(post.calls).toBe(1);
    expect((JSON.parse(post.lastBody!) as { id: string }).id).toBe(bytes.txId);
    expect(await note(stub, noteId)).toMatchObject({ status: 'posted', txId: record.txId });
  });

  it('(H2) a late landing after the release is re-booked: phase 1 puts the dead txId under WATCH in the money index next to the new one; when the old transaction confirms after all, the lattice books `released → spent` — spent = 10, not 0', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r4-h2', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    const stub = await seed(env, id.pkB64, noteId, record);
    // Phase 1: dead → redrop_pending, the old reservation released, and the
    // dead txId enters the money index in the SAME transaction.
    deadOnAll(mockRoute, record.txId);
    await runNow(stub, FAR);
    let r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'redrop_pending', deadTxId: record.txId });
    expect(moneyOf(await recoveryStatus(stub), noteId)).toMatchObject({ txId: record.txId, attempts: 0 });
    expect((await status()).ledger.pending).toBe('0');
    // Next pass: the money step sees dead + age guard → `released` (a no-op,
    // phase 1 did it) → the entry turns into a watch; phase 2 signs the new
    // generation and posts it → a SECOND entry for the new txId.
    deadOnAll(mockRoute, record.txId);
    const { post } = paidLegs(mockRoute, { price: '12' });
    await runNow(stub, Math.max(r!.dueAt, moneyOf(await recoveryStatus(stub), noteId).dueAt));
    r = await note(stub, noteId);
    expect(r!.status).toBe('posted');
    expect(r!.txId).not.toBe(record.txId);
    expect(post!.calls).toBe(1);
    const rows = moneyRows(await recoveryStatus(stub), noteId);
    expect(rows.map(x => [x.txId, x.watching === true]).sort()).toEqual([[r!.txId, false], [record.txId, true]].sort());
    expect((await status()).ledger).toMatchObject({ pending: '12', spent: '0' });
    // The reviewer's counterexample: the OLD bytes land after all (a late
    // POST, a slow gateway). The watch catches the money quorum and the
    // lattice books the conflict: spent += 10, the old entry leaves.
    const oldWatch = rows.find(x => x.txId === record.txId)!;
    confirmedOnAll(mockRoute, record.txId, 5000, 60);
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, r!.txId), 202, 'Pending'));
    await runNow(stub, oldWatch.dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '12', spent: '10' });
    const gstub = ns.get(ns.idFromName('global'));
    expect(await runInDurableObject(gstub, (_i, s) => s.storage.get<{ state: string }>(`res:${spendKey}`))).toMatchObject({ state: 'spent' });
    const left = moneyRows(await recoveryStatus(stub), noteId);
    expect(left.map(x => x.txId)).toEqual([r!.txId]);
  });

  it('(H3, phase 2) `spent_is_final` is not «released»: a redrop_pending whose old money was BOOKED by a concurrent confirmation signs nothing and posts nothing — the record becomes posted with the OLD txId', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r4-h3', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    // Phase 1 already ran; meanwhile a recheck confirmed the old transaction
    // and settled its reservation `spent` (the reviewer's interleaving).
    await seed(env, id.pkB64, noteId, { ...record, status: 'redrop_pending', deadTxId: record.txId, dueAt: FAR });
    expect((await guardCall(ns, '/settle', { spendKey, outcome: 'spent', height: 5000 })).body).toMatchObject({ state: 'spent' });
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    // No anchor / price / POST routes: a phase 2 that went ahead would throw
    // at the anchor and leave the record `redrop_pending`, rescheduled.
    await runNow(stub, FAR);
    expect(await note(stub, noteId)).toMatchObject({ status: 'posted', txId: record.txId });
    const rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(0);
    expect(rs.due).toEqual({});
    // No second reservation, no new pending: the old publication stands.
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    const gstub = ns.get(ns.idFromName('global'));
    expect(await runInDurableObject(gstub, (_i, s) => s.storage.get(`res:${spendKey.slice(0, spendKey.lastIndexOf(':'))}:g2`))).toBeUndefined();
    // The money entry of the old txId reconciles to a no-op and leaves.
    confirmedOnAll(mockRoute, record.txId, 5000, 60);
    await runNow(stub, moneyOf(rs, noteId).dueAt);
    expect((await recoveryStatus(stub)).money).toEqual({});
  });

  it('(H3, phase 1) the same at phase 1: dead by the status quorum but SPENT in the guard → no redrop_pending, the record becomes posted with the old txId', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r4-h3a', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000 });
    const stub = await seed(env, id.pkB64, noteId, record);
    expect((await guardCall(ns, '/settle', { spendKey, outcome: 'spent', height: 5000 })).body).toMatchObject({ state: 'spent' });
    deadOnAll(mockRoute, record.txId); // the pool lags behind the guard's quorum
    await runNow(stub, FAR);
    expect(await note(stub, noteId)).toMatchObject({ status: 'posted', txId: record.txId });
    expect((await recoveryStatus(stub)).recoveryCount).toBe(0);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
  });
});

describe('review 24.09 #5 — the proof of expiry comes from the chain; age never ends an obligation', () => {
  it('(H1) an UNREPORTED writer lease: phase 1 cannot release; the money step holds through 5 days of clock and a chain that has not moved past the anchor; only the chain proof (anchor height + min chain height at 2 operators) frees the money, and the same proof ends the watch', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r5-h1', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record, spendKey } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk, { ageMs: RECOVERY_AGE_GUARD_MS + 1000, sendDone: false });
    const stub = await seed(env, id.pkB64, noteId, record);
    // Phase 1: dead → redrop_pending; the release is REFUSED (the lease is
    // open) and the dead txId enters the money index with its anchor.
    deadOnAll(mockRoute, record.txId);
    await runNow(stub, FAR);
    let r = await note(stub, noteId);
    expect(r).toMatchObject({ status: 'redrop_pending', deadTxId: record.txId });
    expect((await status()).ledger.pending).toBe('10');
    expect(moneyOf(await recoveryStatus(stub), noteId)).toMatchObject({ txId: record.txId, anchor: ANCHOR });
    // Five days later, chain 20 blocks past the anchor (inside the window):
    // dead → `released` → in_flight → the proof is read → `valid` → held.
    // Phase 2 meets the same refusal and waits; nothing is signed.
    let t = Math.max(r!.dueAt, moneyOf(await recoveryStatus(stub), noteId).dueAt) + 5 * 24 * 3_600_000;
    deadOnAll(mockRoute, record.txId);
    chainAt(ANCHOR_HEIGHT + 20);
    await runNow(stub, t);
    expect((await status()).ledger.pending).toBe('10');
    expect(await note(stub, noteId)).toMatchObject({ status: 'redrop_pending' });
    expect(moneyOf(await recoveryStatus(stub), noteId).watching).toBeUndefined();
    // One operator ahead, the other behind: the MINIMUM decides → still valid.
    t = Math.max((await note(stub, noteId))!.dueAt, moneyOf(await recoveryStatus(stub), noteId).dueAt);
    deadOnAll(mockRoute, record.txId);
    chainAt(EXPIRED_AT, { per: { 'https://g2.test': EXPIRED_AT - 1 } });
    await runNow(stub, t);
    expect((await status()).ledger.pending).toBe('10');
    // Operators DISAGREE on the anchor's height: no proof → held.
    t = Math.max((await note(stub, noteId))!.dueAt, moneyOf(await recoveryStatus(stub), noteId).dueAt);
    deadOnAll(mockRoute, record.txId);
    mockRoute('GET', originRe('https://arweave.net', `/block/hash/${ANCHOR}`), 200, JSON.stringify({ indep_hash: ANCHOR, height: ANCHOR_HEIGHT }));
    mockRoute('GET', originRe('https://g2.test', `/block/hash/${ANCHOR}`), 200, JSON.stringify({ indep_hash: ANCHOR, height: ANCHOR_HEIGHT + 1 }));
    STATUS_ORIGINS.forEach(o => mockRoute('GET', originRe(o, '/info'), 200, JSON.stringify({ height: 9999 })));
    await runNow(stub, t);
    expect((await status()).ledger.pending).toBe('10');
    // The chain has moved past the window at BOTH operators: the proof is
    // accepted by the guard, the lease ends, `released` goes through, the
    // entry turns into a watch; phase 2 signs and posts the new generation.
    t = Math.max((await note(stub, noteId))!.dueAt, moneyOf(await recoveryStatus(stub), noteId).dueAt);
    deadOnAll(mockRoute, record.txId);
    chainAt(EXPIRED_AT);
    const { post } = paidLegs(mockRoute, { price: '12' });
    await runNow(stub, t);
    r = await note(stub, noteId);
    expect(r!.status).toBe('posted');
    expect(r!.txId).not.toBe(record.txId);
    expect(post!.calls).toBe(1);
    expect((await status()).ledger).toMatchObject({ pending: '12', spent: '0' });
    const gstub = ns.get(ns.idFromName('global'));
    expect(await runInDurableObject(gstub, (_i, s) => s.storage.get<{ state: string }>(`res:${spendKey}`))).toMatchObject({ state: 'released' });
    const oldPermit = await runInDurableObject(gstub, (_i, s) => s.storage.get<{ sending?: unknown; anchorExpired?: { chainHeight: number } }>(`permit:${record.txId}`));
    expect(oldPermit!.sending).toBeUndefined();
    expect(oldPermit!.anchorExpired).toMatchObject({ anchorHeight: ANCHOR_HEIGHT, chainHeight: EXPIRED_AT });
    const rows = moneyRows(await recoveryStatus(stub), noteId);
    expect(rows.find(x => x.txId === record.txId)).toMatchObject({ watching: true });
    // The watch of the dead txId ends with the same proof (already on the
    // permit: a no-op there) while the pool still says dead.
    const oldWatch = rows.find(x => x.txId === record.txId)!;
    deadOnAll(mockRoute, record.txId);
    chainAt(EXPIRED_AT + 3);
    deadOnAll(mockRoute, record.txId); // the re-check after the proof
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, r!.txId), 202, 'Pending'));
    await runNow(stub, Math.max(oldWatch.dueAt, rows.find(x => x.txId === r!.txId)!.dueAt));
    expect(moneyRows(await recoveryStatus(stub), noteId).map(x => x.txId)).toEqual([r!.txId]);
  });

  it('(H2) age never deletes an unresolved obligation: a watched txId with 49 confirmations on the 8th day stays (stale — slower, escalated), and when the 60th confirmation arrives it is booked spent', async () => {
    const { env, status } = await sagaEnv('rec-r5-h2', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status).toBe(200);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    const entry = moneyOf(await recoveryStatus(stub), noteId);
    expect(entry.anchor).toBe(ANCHOR);
    // Dead past the age guard → released → watch.
    deadOnAll(mockRoute, r.body.txId!);
    await runNow(stub, entry.postedAt + RECOVERY_AGE_GUARD_MS + 1);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '0' });
    let w = moneyOf(await recoveryStatus(stub), noteId);
    expect(w.watching).toBe(true);
    // The reviewer's counterexample: the 8th day, both gateways confirmed
    // with 49 — one short of the money quorum. The entry is NOT deleted: it
    // is stale (escalated, slowed to MONEY_STALE_BACKOFF_MS), still there,
    // and the alarm still follows it.
    const day8 = entry.postedAt + MONEY_STALE_MS + 1;
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 49);
    await runNow(stub, day8);
    let rs = await recoveryStatus(stub);
    w = moneyOf(rs, noteId);
    expect(w).toMatchObject({ txId: r.body.txId, watching: true });
    expect(w.dueAt).toBeGreaterThanOrEqual(day8 + MONEY_STALE_BACKOFF_MS);
    expect(rs.alarm).toBe(w.dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '0' });
    // The 60th confirmation: a money quorum → `released → spent` (the
    // lattice's conflict), the obligation is booked, the entry leaves.
    confirmedOnAll(mockRoute, r.body.txId!, 5000, 60);
    await runNow(stub, w.dueAt);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    rs = await recoveryStatus(stub);
    expect(rs.money).toEqual({});
    expect(rs.alarm).toBeNull();
  });
});

describe('review 24.09 #6 — a dead read BEFORE the proof is not evidence for the deletion', () => {
  it('(H) the watch re-reads the full status set AFTER the proof: mined in between → booked spent (10, not 0); pending or short of the quorum → kept; only dead again → ended', async () => {
    const { env, status } = await sagaEnv('rec-r6-h', { deposit: '1000' });
    const id = await makeIdentity();
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).useEnvForTests(env as Parameters<RateLimiter['useEnvForTests']>[0]));
    // Three watched notes, one per interleaving.
    const notes: Array<{ noteId: string; txId: string; postedAt: number }> = [];
    for (let i = 0; i < 3; i++) {
      const noteId = uuidV4();
      paidLegs(mockRoute, { price: '10' });
      const r = await upload(await uploadRequest(id, noteId), env);
      expect(r.status).toBe(200);
      const e = moneyOf(await recoveryStatus(stub), noteId);
      deadOnAll(mockRoute, r.body.txId!);
      await runNow(stub, e.postedAt + RECOVERY_AGE_GUARD_MS + 1 + i); // released → watch
      expect(moneyOf(await recoveryStatus(stub), noteId).watching).toBe(true);
      notes.push({ noteId, txId: r.body.txId!, postedAt: e.postedAt });
    }
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '0' });
    const [mined, pending, short] = notes;
    const dueOf = async (noteId: string) => moneyOf(await recoveryStatus(stub), noteId).dueAt;

    // (a) The reviewer's counterexample: dead at the first read, the proof
    // says expired — and the transaction was mined in between. The second
    // read finds the money quorum: `released → spent`, the entry leaves.
    deadOnAll(mockRoute, mined.txId);
    chainAt(EXPIRED_AT);
    confirmedOnAll(mockRoute, mined.txId, 5000, 60);
    await runNow(stub, await dueOf(mined.noteId));
    expect(moneyRows(await recoveryStatus(stub), mined.noteId)).toEqual([]);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });

    // (b) Dead, expired — and PENDING at the second read: the obligation stays.
    deadOnAll(mockRoute, pending.txId);
    chainAt(EXPIRED_AT);
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, pending.txId), 202, 'Pending'));
    await runNow(stub, await dueOf(pending.noteId));
    expect(moneyOf(await recoveryStatus(stub), pending.noteId)).toMatchObject({ watching: true });

    // (c) Dead, expired — and confirmed with 49 at the second read: not a
    // money quorum, not dead either → kept; the 60th confirmation books it.
    deadOnAll(mockRoute, short.txId);
    chainAt(EXPIRED_AT);
    confirmedOnAll(mockRoute, short.txId, 5000, 49);
    await runNow(stub, await dueOf(short.noteId));
    expect(moneyOf(await recoveryStatus(stub), short.noteId)).toMatchObject({ watching: true });
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '10' });
    confirmedOnAll(mockRoute, short.txId, 5000, 60);
    await runNow(stub, await dueOf(short.noteId));
    expect(moneyRows(await recoveryStatus(stub), short.noteId)).toEqual([]);
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '20' });

    // (d) Dead, expired, and dead AGAIN: only now the watch ends, with the
    // ledger untouched.
    deadOnAll(mockRoute, pending.txId);
    chainAt(EXPIRED_AT);
    deadOnAll(mockRoute, pending.txId);
    await runNow(stub, await dueOf(pending.noteId));
    expect((await recoveryStatus(stub)).money).toEqual({});
    expect((await status()).ledger).toMatchObject({ pending: '0', spent: '20' });
  });

  it('(M) proven-expired bytes get no new lease: the resend permit is refused spend_anchor_expired, nothing is posted, the record is rescheduled (dead → redrop is the way)', async () => {
    const { env, ns, status, wallet } = await sagaEnv('rec-r6-m', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk); // permitted and reported
    const stub = await seed(env, id.pkB64, noteId, record);
    expect((await guardCall(ns, '/anchor-expired', { txId: record.txId, anchor: ANCHOR, anchorHeight: ANCHOR_HEIGHT, chainHeight: EXPIRED_AT })).body).toMatchObject({ expired: true });
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, record.txId), 503, 'down')); // → resend path
    const post = mockRoute('POST', /^https:\/\/arweave\.net(?::443)?\/tx$/, 200, 'OK', 0);
    await runNow(stub, FAR);
    expect(post.calls).toBe(0);
    expect(await note(stub, noteId)).toMatchObject({ status: 'signed', txId: record.txId, attempts: 1 });
    expect((await status()).ledger.pending).toBe('10'); // the reservation is untouched until the quorum decides
  });
});

describe('scheduler mechanics', () => {
  it('two records with different dueAt: the alarm is the minimum; advancing one does not cancel the other; ALARM_BATCH bounds a run and the remainder gets an immediate alarm', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-batch', { deposit: '100000' });
    const id = await makeIdentity();
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    const t0 = FAR;
    const records: Array<{ noteId: string; txId: string }> = [];
    for (let i = 0; i < ALARM_BATCH + 1; i++) {
      const noteId = uuidV4();
      const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
      await seed(env, id.pkB64, noteId, { ...record, dueAt: t0 - 100 + i });
      records.push({ noteId, txId: record.txId });
    }
    const far = uuidV4();
    const farRec = await writerSigned(ns, id.pkB64, far, wallet.jwk);
    await seed(env, id.pkB64, far, { ...farRec.record, dueAt: t0 + 10_000_000 });
    let rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(ALARM_BATCH + 2);
    expect(rs.alarm).toBe(t0 - 100);
    // Everything due answers confirmed: five advance, one remains due → alarm now.
    for (const { txId } of records) confirmedOnAll(mockRoute, txId, 100, 1);
    const run = await runNow(stub, t0);
    expect(run).toEqual({ processed: ALARM_BATCH, remaining: 1, money: 0 });
    rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(2);
    // The remainder got an IMMEDIATE alarm (`setAlarm(now)` in the finally);
    // in the harness it fires at once, so the observable trace is the run
    // that follows, not the alarm value (null while the handler runs).
    expect(Object.keys(rs.due).sort()).toEqual([records[ALARM_BATCH].noteId, far].sort());
    // The far record's schedule survived; one more run drains the remainder.
    const run2 = await runNow(stub, t0);
    expect(run2).toEqual({ processed: 1, remaining: 0, money: 0 });
    rs = await recoveryStatus(stub);
    expect(rs.recoveryCount).toBe(1);
    // The alarm is now the earliest of the far record and the six money entries.
    expect(rs.alarm).toBeLessThanOrEqual(t0 + 10_000_000);
    expect(Object.keys(rs.money)).toHaveLength(ALARM_BATCH + 1);
  });

  it('self-healing: a backlog without an alarm gets it back on the next /check-and-reserve; a note in recovery answers `recovering`', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-heal', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm());
    expect((await recoveryStatus(stub)).alarm).toBeNull();
    const res = await stub.fetch('http://do/check-and-reserve', { method: 'POST', body: JSON.stringify({ noteId, limit: 20 }) });
    expect(await res.json()).toMatchObject({ status: 'recovering', txId: record.txId, recoveryStatus: 'signed' });
    expect((await recoveryStatus(stub)).alarm).toBe(record.dueAt);
  });

  it('crash atomicity: a fault after ANY write inside the recovery transaction rolls the whole transition back', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-atomic', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    const before = { note: await note(stub, noteId), rs: await recoveryStatus(stub) };
    for (const fault of ['note', 'index', 'count', 'alarm'] as const) {
      // The transition that would leave the scheduler set (every write of
      // the transaction is exercised: note, index, counter, alarm).
      const outcome = await runInDurableObject(stub, async (instance) => {
        const rl = instance as unknown as RateLimiter;
        rl.recoveryFaultAfter = fault;
        try {
          await rl.casRecovery(noteId, casOf(record), toPosted(record, FAR));
          return 'no throw';
        } catch (e) {
          return String((e as Error).message);
        } finally {
          rl.recoveryFaultAfter = undefined;
        }
      });
      expect(outcome, fault).toBe(`fault injected after ${fault}`);
      expect(await note(stub, noteId), fault).toEqual(before.note);
      const rs = await recoveryStatus(stub);
      expect(rs, fault).toEqual(before.rs);
    }
    // Without the fault the same transition lands whole (and hands the
    // money over to the money index).
    await runInDurableObject(stub, (instance) => (instance as unknown as RateLimiter).casRecovery(noteId, casOf(record), toPosted(record, FAR)));
    expect((await note(stub, noteId))?.status).toBe('posted');
    const after = await recoveryStatus(stub);
    expect(after).toMatchObject({ recoveryCount: 0, due: {} });
    expect(moneyOf(after, noteId)).toMatchObject({ txId: record.txId });
    expect(after.alarm).toBe(moneyOf(after, noteId).dueAt);
  });

  it('the recovery cap: recoveryCount = quota → a NEW upload is refused 503 recovery_capacity before anything is signed; a recheck of a recovering note nudges one step and answers 503 recovery_in_progress', async () => {
    const { env, ns, wallet } = await sagaEnv('rec-cap', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    const { record } = await writerSigned(ns, id.pkB64, noteId, wallet.jwk);
    const stub = await seed(env, id.pkB64, noteId, record);
    // Push the counter to the quota (20) without more real records.
    await runInDurableObject(stub, (_i, state) => state.storage.put(RECOVERY_COUNT_KEY, 20));
    const fresh = await upload(await uploadRequest(id, uuidV4()), env); // no paid legs mocked: refused before them
    expect(fresh.status).toBe(503);
    expect(fresh.body.code).toBe('recovery_capacity');
    expect(await opRecord(id.pkB64, fresh.opId!)).toMatchObject({ status: 'finished', code: 'recovery_capacity', paidResult: 'none' });
    await runInDurableObject(stub, (_i, state) => state.storage.put(RECOVERY_COUNT_KEY, 1));
    // The recheck nudges the step (regardless of dueAt): confirmed → posted,
    // then answers 503.
    confirmedOnAll(mockRoute, record.txId, 100, 1);
    const rc = await upload(await uploadRequest(id, noteId, { recheck: true }), env);
    expect(rc.status).toBe(503);
    expect(rc.body.code).toBe('recovery_in_progress');
    expect(rc.body.txId).toBe(record.txId);
    expect((await note(stub, noteId))?.status).toBe('posted');
    expect((await recoveryStatus(stub)).recoveryCount).toBe(0);
    // …and the very next recheck commits it through the ordinary posted path.
    confirmedOnAll(mockRoute, record.txId, 101, 2);
    const rc2 = await upload(await uploadRequest(id, noteId, { recheck: true }), env);
    expect(rc2.status).toBe(200);
    expect(rc2.body).toMatchObject({ txId: record.txId, deduped: true });
  });

  it('the reader never creates a recovery record: after a fresh upload the note is posted/committed, never signed', async () => {
    const { env, ns } = await sagaEnv('rec-reader', { deposit: '1000' });
    const id = await makeIdentity();
    const noteId = uuidV4();
    paidLegs(mockRoute, { price: '10' });
    const r = await upload(await uploadRequest(id, noteId), env);
    expect(r.status).toBe(200);
    const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(id.pkB64));
    expect((await note(stub, noteId))?.status).toBe('committed');
    expect((await recoveryStatus(stub)).recoveryCount).toBe(0);
    void ns; void SPEND_CODES;
  });
});
