import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { getArweave } from '../src/arweave-transport';
import { SPEND_CODES } from '../src/spend-ledger';
import { spendKeyFor } from '../src/spend-saga';
import { setupOutboundMock, STATUS_ORIGINS, statusUrlRe } from './helpers/outbound-mock';
import {
  LIMITS_ENV,
  confirmedAll, deadAll, freshWallet, guardCall, guardStatus, handlerWith, isolatedGuard, isolatedNs, markerMocks, pendingAll,
  spendEnv, txUrlRe, viaHandler, viaWorker, type Wallet,
} from './helpers/spend-admin';

// D10 §12 — «покой и унаследованные» (ревью #7 H1, #8 H1, #9 H1/H2/M): the
// closure of the legacy set (legacy-closure.ts) through the PRODUCTION
// `/admin/spend/init` — historical keys from an isolated InviteManager, the
// per-key journals, permits without a terminal outcome, rewards ONLY from a
// verified header at a payload origin, and the resolution of held items
// after `done`. Spec §4.0 п. 2–6.

const { mockRoute } = setupOutboundMock();
const RATE_LIMITER = (env as unknown as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER;
const INVITE_MANAGER = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;
const PAYLOAD = 'https://arweave.net,https://g2.test';
const ANCHOR = 'A'.repeat(64);
const uuidV4 = () => crypto.randomUUID();
const pk = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/** A signed pre-D10 transaction of `wallet` (its header is what a payload
 *  origin answers for `/tx/<id>`). */
async function legacyTx(wallet: Wallet, reward: string) {
  const arweave = getArweave();
  const tx = await arweave.createTransaction({ data: JSON.stringify({ id: uuidV4(), c: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA' }), last_tx: ANCHOR, reward }, JSON.parse(wallet.jwk));
  tx.addTag('App-Name', 'EternalNotes');
  await arweave.transactions.sign(tx, JSON.parse(wallet.jwk));
  return { txId: tx.id, header: JSON.stringify(tx.toJSON()) };
}

function headerAt(origin: string, txId: string, status: number, body: string) {
  return mockRoute('GET', txUrlRe(origin, txId), status, body);
}

/** A key registered through an invite in the isolated InviteManager. */
async function registeredKey(inviteNs: DurableObjectNamespace, opts: { revoke?: boolean } = {}) {
  const key = pk();
  const stub = inviteNs.get(inviteNs.idFromName('global'));
  const code = `code-${uuidV4().slice(0, 8)}`;
  expect((await stub.fetch('http://internal/seed-invite', { method: 'POST', body: JSON.stringify({ codes: [code] }) })).status).toBe(200);
  expect((await stub.fetch('http://internal/register', { method: 'POST', body: JSON.stringify({ inviteCode: code, publicKey: key, clientIP: '203.0.113.7' }) })).status).toBe(200);
  if (opts.revoke) expect((await stub.fetch('http://internal/revoke', { method: 'POST', body: JSON.stringify({ publicKey: key }) })).status).toBe(200);
  return key;
}

/** One journaled operation of `key`, left in the given state. */
async function journal(key: string, txId: string, state: 'posting' | 'unknown' | 'accepted' | 'rejected') {
  const stub = RATE_LIMITER.get(RATE_LIMITER.idFromName(key));
  const id = uuidV4();
  const noteId = uuidV4();
  const r = await stub.fetch('http://internal/check-and-reserve', {
    method: 'POST',
    body: JSON.stringify({ noteId, limit: 20, fp: 'a'.repeat(64), op: { id, mode: 'plain', declaredVersion: '2', releaseSha: null, workerVersionId: null, idOrigin: 'client' } }),
  });
  const { token } = (await r.json()) as { token: string };
  expect((await (await stub.fetch('http://internal/op-posting', { method: 'POST', body: JSON.stringify({ id, token, txId, decision: 'new' }) })).json() as { ok: boolean }).ok).toBe(true);
  if (state === 'posting') return;
  const paidResult = state === 'unknown' ? 'unknown' : state === 'accepted' ? 'accepted' : 'rejected';
  const fin = await (await stub.fetch('http://internal/op-finish', {
    method: 'POST', body: JSON.stringify({ id, outcome: state, httpStatus: state === 'accepted' ? 200 : 502, txId, paidResult, attests: [] }),
  })).json() as { ok: boolean; reason?: string };
  expect(fin.ok, fin.reason).toBe(true);
}

async function legacyEnv(name: string, wallet: Wallet, extra: Record<string, unknown> = {}) {
  const guard = isolatedGuard(name);
  const invites = isolatedNs(INVITE_MANAGER, name);
  const e = spendEnv(guard, wallet, { INVITE_MANAGER: invites, PAYLOAD_GATEWAYS: PAYLOAD, ...extra });
  expect((await viaWorker('freeze', e, { active: true })).status).toBe(200);
  return { env: e, guard, invites };
}

describe('D10 legacy set L and init preconditions', () => {
  it('(1)(2) a `posting` record without confirmation and an active permit → both are held from the CLOSURE (journal reward from the verified header, permit reward from the reservation); init passes; available is reduced by the holds', async () => {
    const wallet = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l12', wallet);
    const key = await registeredKey(invites);
    const tx = await legacyTx(wallet, '20');
    await journal(key, tx.txId, 'posting');
    // L₁: a permit of an OLDER cycle whose reservation is still active —
    // seeded as that cycle's ledger left it (a fresh guard has no `done` to
    // prepare under). Its reward is the reservation's.
    const spendKey = await spendKeyFor(key, uuidV4(), 'g1');
    const permitTx = 'P'.repeat(43);
    await runInDurableObject(guard.get(guard.idFromName('global')), async (_i, s) => {
      await s.storage.put(`res:${spendKey}`, { state: 'active', reward: '5', revision: 0, activatedBy: '5:0', cycle: 0 });
      await s.storage.put(`permit:${permitTx}`, { txId: permitTx, kind: 'upload', cycle: 0, issuedAt: 1, spendKey });
    });
    headerAt('https://arweave.net', tx.txId, 200, tx.header);
    markerMocks(mockRoute, { price: '3' });
    const r = await viaWorker('init', e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.init).toMatchObject({ state: 'posted' });
    const list = await guardCall(guard, '/legacy-list');
    expect((list.body.items as Array<{ txId: string; reward: string; source: string; state: string }>).sort((a, b) => a.txId.localeCompare(b.txId))).toEqual([
      { txId: permitTx, reward: '5', source: 'permit', state: 'held', registeredAt: expect.any(Number) },
      { txId: tx.txId, reward: '20', source: 'journal', state: 'held', registeredAt: expect.any(Number) },
    ].sort((a, b) => a.txId.localeCompare(b.txId)));
    expect((await guardStatus(guard)).ledger.pending).toBe('25'); // 20 (journal) + 5 (permit) held
  });

  it('(3) an OLD reward of 20 above the NEW MAX_TX_REWARD of 10 is held at exactly 20 — the ceiling covers new transactions only', async () => {
    const wallet = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l3', wallet, { MAX_TX_REWARD_WINSTON: '10' });
    const key = await registeredKey(invites);
    const tx = await legacyTx(wallet, '20');
    await journal(key, tx.txId, 'unknown');
    headerAt('https://arweave.net', tx.txId, 200, tx.header);
    markerMocks(mockRoute, { price: '3' });
    expect((await viaWorker('init', e)).status).toBe(200);
    expect((await guardCall(guard, '/legacy-list')).body.items).toEqual([{ txId: tx.txId, reward: '20', source: 'journal', state: 'held', registeredAt: expect.any(Number) }]);
    expect((await guardStatus(guard)).ledger.pending).toBe('20');
  });

  it('(4)(4б) bytes unavailable at every payload origin → spend_init_legacy_reward_unknown, no marker; an old confirmed block changes nothing; once ONE origin serves the verified header, init passes', async () => {
    const wallet = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l4', wallet);
    const key = await registeredKey(invites);
    const tx = await legacyTx(wallet, '7');
    await journal(key, tx.txId, 'posting');
    headerAt('https://arweave.net', tx.txId, 404, 'nf');
    headerAt('https://g2.test', tx.txId, 503, 'down');
    const r = await viaWorker('init', e);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.initLegacyRewardUnknown);
    expect(r.body.txId).toBe(tx.txId);
    expect((await guardStatus(guard)).init.state).toBe('none');
    // (4б): a `posting` candidate is never asked for its status — no anchor
    // expiry shortcut exists; the answer is the same.
    headerAt('https://arweave.net', tx.txId, 404, 'nf');
    headerAt('https://g2.test', tx.txId, 404, 'nf');
    expect((await viaWorker('init', e)).body.code).toBe(SPEND_CODES.initLegacyRewardUnknown);
    // The second origin serves the header → passes; the first is tried first.
    headerAt('https://arweave.net', tx.txId, 404, 'nf');
    headerAt('https://g2.test', tx.txId, 200, tx.header);
    markerMocks(mockRoute, { price: '3' });
    expect((await viaWorker('init', e)).status).toBe(200);
    expect((await guardStatus(guard)).ledger.pending).toBe('7');
  });

  it('(5)(5б) a header that does not verify is rejected and the next origin tried: a correctly signed DIFFERENT transaction of the same wallet (id ≠ requested), a foreign wallet, garbage; all rejected → reward unknown', async () => {
    const wallet = await freshWallet();
    const other = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l5', wallet);
    const key = await registeredKey(invites);
    const a = await legacyTx(wallet, '20');
    const b = await legacyTx(wallet, '1');       // same wallet, cheaper
    const foreign = await legacyTx(other, '20'); // not a trusted owner
    await journal(key, a.txId, 'posting');
    // (5б) arweave.net answers B for a request of A → id ≠ txId → rejected;
    // g2 answers A → held at A's 20, never B's 1.
    headerAt('https://arweave.net', a.txId, 200, b.header);
    headerAt('https://g2.test', a.txId, 200, a.header);
    markerMocks(mockRoute, { price: '3' });
    expect((await viaWorker('init', e)).status).toBe(200);
    expect((await guardCall(guard, '/legacy-list')).body.items).toEqual([{ txId: a.txId, reward: '20', source: 'journal', state: 'held', registeredAt: expect.any(Number) }]);
    // (5) a second key, foreign owner and garbage at the two origins → unknown.
    const { env: e2, invites: inv2 } = await legacyEnv('l5b', wallet);
    const key2 = await registeredKey(inv2);
    const c = await legacyTx(wallet, '9');
    await journal(key2, c.txId, 'posting');
    headerAt('https://arweave.net', c.txId, 200, foreign.header.replace(foreign.txId, c.txId)); // id patched, signature does not verify
    headerAt('https://g2.test', c.txId, 200, '{"format":2,"id":"x"}');
    const r = await viaWorker('init', e2);
    expect(r.body.code).toBe(SPEND_CODES.initLegacyRewardUnknown);
  });

  it('(7) journal membership: `unknown` → in L; `accepted` with a money quorum → NOT in L (no header read); `accepted` without a quorum → in L; `rejected` → not in L', async () => {
    const wallet = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l7', wallet);
    const key = await registeredKey(invites);
    const unknown = await legacyTx(wallet, '11');
    const confirmed = await legacyTx(wallet, '12');
    const unconfirmed = await legacyTx(wallet, '13');
    const rejected = await legacyTx(wallet, '14');
    await journal(key, unknown.txId, 'unknown');
    await journal(key, confirmed.txId, 'accepted');
    await journal(key, unconfirmed.txId, 'accepted');
    await journal(key, rejected.txId, 'rejected');
    confirmedAll(mockRoute, confirmed.txId, [500, 501]);                  // a money quorum → excluded
    STATUS_ORIGINS.forEach(o => mockRoute('GET', statusUrlRe(o, unconfirmed.txId), 503, 'down')); // no quorum → included
    headerAt('https://arweave.net', unknown.txId, 200, unknown.header);
    headerAt('https://arweave.net', unconfirmed.txId, 200, unconfirmed.header);
    markerMocks(mockRoute, { price: '3' });
    expect((await viaWorker('init', e)).status).toBe(200);
    const items = (await guardCall(guard, '/legacy-list')).body.items as Array<{ txId: string; reward: string }>;
    expect(items.map(i => [i.txId, i.reward]).sort()).toEqual([[unknown.txId, '11'], [unconfirmed.txId, '13']].sort());
  });

  it('(8) a revoked key is still enumerated (invite:* keeps publicKey); an old-format invite without a key → spend_init_keys_unknown until the operator acknowledges it through init-legacy-keys', async () => {
    const wallet = await freshWallet();
    const { env: e, guard, invites } = await legacyEnv('l8', wallet);
    const key = await registeredKey(invites, { revoke: true });
    const tx = await legacyTx(wallet, '6');
    await journal(key, tx.txId, 'posting');
    await runInDurableObject(invites.get(invites.idFromName('global')), (_i, s) => s.storage.put('invite:old-format', true));
    const r = await viaWorker('init', e);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(SPEND_CODES.initKeysUnknown);
    expect(r.body).toMatchObject({ unknownLegacyInvites: 1, acknowledged: 0 });
    const ack = await viaWorker('init-legacy-keys', e, { acknowledgeLegacyInvites: 1 });
    expect(ack.status).toBe(200);
    expect(ack.body.legacyKeys).toMatchObject({ acknowledgedInvites: 1 });
    headerAt('https://arweave.net', tx.txId, 200, tx.header);
    markerMocks(mockRoute, { price: '3' });
    expect((await viaWorker('init', e)).status).toBe(200);
    expect((await guardCall(guard, '/legacy-list')).body.items).toEqual([{ txId: tx.txId, reward: '6', source: 'journal', state: 'held', registeredAt: expect.any(Number) }]);
  });

  it('(9) resolution after done (each init in `done`): a money quorum above h_init → spent; at/below → dropped; unanimous dead past the age guard → dropped; pending → held without TTL', async () => {
    const wallet = await freshWallet();
    const { env: e, guard } = await legacyEnv('l9', wallet);
    const handler = handlerWith({ closeLegacySet: async () => ({ kind: 'closed', items: [
      { txId: 'A'.repeat(43), reward: '10', source: 'journal' }, { txId: 'B'.repeat(43), reward: '20', source: 'journal' },
      { txId: 'C'.repeat(43), reward: '30', source: 'journal' }, { txId: 'D'.repeat(43), reward: '40', source: 'journal' },
    ] }) });
    markerMocks(mockRoute, { price: '3' });
    const first = await viaHandler(handler, 'init', e);
    expect(first.body.init?.state).toBe('posted');
    const marker = first.body.init!.txId!;
    confirmedAll(mockRoute, marker, [1000, 1001]); // h_init = 1001
    // Same call: done → resolution of the four held items.
    confirmedAll(mockRoute, 'A'.repeat(43), [1002, 1003], 60); // above → spent
    confirmedAll(mockRoute, 'B'.repeat(43), [900, 901], 60);   // at/below → dropped (reserve)
    deadAll(mockRoute, 'C'.repeat(43));                         // dead, but young → kept
    pendingAll(mockRoute, 'D'.repeat(43));                      // held
    const done = await viaHandler(handler, 'init', e);
    expect(done.body.step).toBe('done');
    expect(done.body.legacy).toMatchObject({ held: 4, spent: 1, dropped: 1, kept: 2 });
    let s = await guardStatus(guard);
    expect(s.ledger).toMatchObject({ hInit: 1001, spent: '10', pending: '70' }); // C 30 + D 40 still held
    // Past the age guard the dead one is dropped; the pending one stays.
    const aged = handlerWith({ closeLegacySet: async () => ({ kind: 'closed', items: [] }), now: () => Date.now() + 31 * 60_000 });
    deadAll(mockRoute, 'C'.repeat(43));
    pendingAll(mockRoute, 'D'.repeat(43));
    const again = await viaHandler(aged, 'init', e);
    expect(again.body.legacy).toMatchObject({ held: 2, spent: 0, dropped: 1, kept: 1 });
    s = await guardStatus(guard);
    expect(s.ledger).toMatchObject({ spent: '10', pending: '40' });
    expect(LIMITS_ENV.MAX_TX_REWARD_WINSTON).toBe('1000');
  });
});
