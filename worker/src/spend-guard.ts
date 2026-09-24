/**
 * `SpendGuard` Durable Object — D10, the ONE aggregate limit on what the
 * worker's hot wallet may spend and the ONLY source of permissions to POST a
 * transaction (spec rev. 10 §0, §4.0). `idFromName('global')`, SQLite-backed.
 *
 * Division of labour (deliberate): this DO holds STATE and DECISIONS; every
 * decision is a pure function of `spend-ledger.ts` applied inside ONE
 * `storage.transaction`, so there are no partial states (§4.4
 * «Конкурентность»). Everything that touches the network — signing the marker,
 * POSTing it, reading gateway balances, prices, transaction bytes and status
 * quorums — is the WORKER's job; it brings the verified numbers here
 * (`/refresh-balance`, `/refresh-price`, `/credit-deposit`, `/init-done`).
 * That keeps the guard testable on real DO storage without a gateway in the
 * loop, and keeps the trust boundary where the spec draws it: the DO never
 * believes a balance, it only remembers a detector input.
 *
 * Amounts are `bigint` Winston in memory and DECIMAL STRINGS in storage and on
 * the wire (§2). Heights are numbers.
 *
 * NOT a release: ships with the PR-3b reader worker in its own window.
 */

import {
  PREPARED_LEASE_MS, PRICE_QUOTE_TTL_MS, SEND_LEASE_MS, SPEND_CODES,
  activateOutcome, addToBucket, available, creditDeposit, initTransition, permitDecision, prepareDecision,
  reinit, settle, spentLast24h,
  type CycleLedger, type FreezeState, type InitEvent, type InitRecord, type PermitKind, type PermitRecord,
  type Reservation, type SpendCode, type SpendLimits,
} from './spend-ledger';

// ─── Storage shapes (strings for bigint) ────────────────────────────────

interface StoredLedger { cycle: number; hInit: number | null; deposits: string; spent: string; pending: string }
interface StoredReservation extends Omit<Reservation, 'reward'> {
  reward: string; quoteId?: string; leaseUntil?: number;
  /** The txId whose permit names this reservation (set at permit-send) — the
   *  reverse link `released` needs to see the send lease. */
  permitTxId?: string;
  /** Cycle the reservation was CREATED in. */
  cycle: number;
  /** Cycle whose ledger the spending was BOOKED into at `settle('spent')` —
   *  the only ledger a later reclassification may take it out of (review
   *  24.09 round 3: a spend booked before reinit lives in the archive, not in
   *  the new ledger, and must never be subtracted from it). */
  settledCycle?: number;
  settledHeight?: number;
  reclassified?: 'reserve';
}
interface StoredLegacy { reward: string; state: 'held' | 'spent' | 'dropped'; source: 'permit' | 'journal'; registeredAt?: number }
/** Operator-registered keys / acknowledgements for the legacy closure. */
interface StoredLegacyKeys { keys: string[]; acknowledgedInvites: number }
interface StoredQuote { quoteId: string; bytes: number; reward: string; expiresAt: number }
interface StoredBalance { observedMin: string | null; at: number }

const K = {
  freeze: 'freeze',
  init: 'init',
  ledger: 'ledger',
  buckets: 'buckets',
  balance: 'balance',
  audit: 'auditseq',
  permit: (txId: string) => `permit:${txId}`,
  legacy: (txId: string) => `legacy:${txId}`,
  legacyKeys: 'legacy-keys',
  deposit: (txId: string) => `deposit:${txId}`,
  res: (spendKey: string) => `res:${spendKey}`,
  quote: (id: string) => `quote:${id}`,
  archive: (cycle: number) => `cycle-archive:${cycle}`,
  auditRec: (seq: number) => `audit:${String(seq).padStart(12, '0')}`,
} as const;

const DEFAULT_FREEZE: FreezeState = { active: false, epoch: 0 };
const DEFAULT_INIT: InitRecord = { state: 'none', cycle: 1, attempts: 0 };
const DEFAULT_LEDGER: StoredLedger = { cycle: 1, hInit: null, deposits: '0', spent: '0', pending: '0' };

const toLedger = (s: StoredLedger): CycleLedger =>
  ({ cycle: s.cycle, hInit: s.hInit, deposits: BigInt(s.deposits), spent: BigInt(s.spent), pending: BigInt(s.pending) });
const fromLedger = (l: CycleLedger): StoredLedger =>
  ({ cycle: l.cycle, hInit: l.hInit, deposits: l.deposits.toString(), spent: l.spent.toString(), pending: l.pending.toString() });
const toBuckets = (raw: Record<string, string> | undefined): Map<number, bigint> =>
  new Map(Object.entries(raw ?? {}).map(([h, a]) => [Number(h), BigInt(a)]));
const fromBuckets = (b: ReadonlyMap<number, bigint>): Record<string, string> =>
  Object.fromEntries([...b].map(([h, a]) => [String(h), a.toString()]));

type Txn = DurableObjectTransaction;

function refuse(code: SpendCode, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, code, ...extra }, { status });
}
function okJson(data: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...data });
}

/** Parse a decimal Winston string; anything else is a caller bug → 400. */
function amount(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^\d{1,40}$/.test(raw)) return null;
  return BigInt(raw);
}

export class SpendGuard implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * The lease alarm: a `prepared` reservation whose signature never came
   * back (crash after prepare, before sign — upload saga) is released when
   * its lease ends. `prepare` arms the alarm for its lease end when none
   * earlier is set; the alarm re-arms itself for the earliest lease still
   * open. `active` has no TTL (§7) and is never touched here.
   */
  async alarm(): Promise<void> {
    const res = await this.expireLeases(Date.now());
    const body = (await res.json()) as { nextDueAt?: number | null };
    if (typeof body.nextDueAt === 'number') await this.state.storage.setAlarm(body.nextDueAt);
  }

  private async armLeaseAlarm(dueAt: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > dueAt) await this.state.storage.setAlarm(dueAt);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/status') return this.status();
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; } catch { return new Response('bad json', { status: 400 }); }
    const now = typeof body.now === 'number' ? body.now : Date.now();
    switch (path) {
      case '/permit-send': return this.permitSend(body, now);
      case '/send-done': return this.sendDone(body);
      case '/freeze': return this.freeze(body, now);
      case '/init-legacy': return this.initLegacy(body, now);
      // The two questions the closure of the legacy set asks the DO (§4.0
      // п. 1, 4): permits without a terminal outcome, and what is registered.
      case '/open-permits': return this.openPermits();
      case '/legacy-list': return this.legacyList();
      case '/legacy-keys': return okJson({ ...(await this.getLegacyKeys()) });
      case '/legacy-keys-set': return this.setLegacyKeys(body);
      case '/init-begin': return this.initStep({ kind: 'begin', token: String(body.token ?? ''), now, frozen: (await this.getFreeze()).active, legacyOpen: body.legacyOpen === true, rewardUnknown: body.rewardUnknown === true });
      case '/init-signed': return this.initStep({ kind: 'signed', token: String(body.token ?? ''), txId: String(body.txId ?? ''), signedTx: String(body.signedTx ?? ''), anchor: String(body.anchor ?? ''), now });
      case '/init-posted': return this.initStep({ kind: 'posted', token: String(body.token ?? ''), txId: String(body.txId ?? ''), now });
      case '/init-done': return this.initStep({ kind: 'done', txId: String(body.txId ?? ''), heights: (body.heights as number[]) ?? [], confirmations: (body.confirmations as number[]) ?? [], now });
      case '/init-dead': return this.initStep({ kind: 'dead', txId: String(body.txId ?? ''), now });
      // The FULL marker record, signed bytes included — for the worker that
      // resends them (§4.1: POST only ever resends what is durable). Internal
      // only; `/status` masks the bytes.
      case '/init-read': return okJson({ init: await this.getInit(), freeze: await this.getFreeze(), ledger: fromLedger(await this.getLedger()) });
      case '/legacy-resolve': return this.legacyResolve(body, now);
      case '/reinit': return this.reinit();
      case '/credit-deposit': return this.creditDeposit(body);
      case '/refresh-balance': return this.refreshBalance(body, now);
      case '/refresh-price': return this.refreshPrice(body, now);
      case '/prepare': return this.prepare(body, now);
      case '/activate': return this.activate(body, now);
      case '/settle': return this.settle(body, now);
      case '/expire-leases': return this.expireLeases(now);
      // §7 by the txId the permit named — the recheck path knows the txId,
      // not the spendKey (upload saga).
      case '/settle-by-tx': return this.settleByTx(body, now);
      default: return new Response('Not found', { status: 404 });
    }
  }

  // ─── readers ───────────────────────────────────────────────────────────

  private async getFreeze(txn: Txn | DurableObjectStorage = this.state.storage): Promise<FreezeState> {
    return (await txn.get<FreezeState>(K.freeze)) ?? DEFAULT_FREEZE;
  }
  private async getInit(txn: Txn | DurableObjectStorage = this.state.storage): Promise<InitRecord> {
    return (await txn.get<InitRecord>(K.init)) ?? DEFAULT_INIT;
  }
  private async getLedger(txn: Txn | DurableObjectStorage = this.state.storage): Promise<CycleLedger> {
    return toLedger((await txn.get<StoredLedger>(K.ledger)) ?? DEFAULT_LEDGER);
  }
  private async putLedger(txn: Txn, ledger: CycleLedger): Promise<void> {
    await txn.put<StoredLedger>(K.ledger, fromLedger(ledger));
  }
  private async audit(txn: Txn, event: string, data: Record<string, unknown>): Promise<void> {
    const seq = ((await txn.get<number>(K.audit)) ?? 0) + 1;
    await txn.put(K.audit, seq);
    await txn.put(K.auditRec(seq), { seq, at: Date.now(), event, ...data });
  }
  private async heldTotal(txn: Txn): Promise<bigint> {
    const held = await txn.list<StoredLegacy>({ prefix: 'legacy:' });
    let sum = 0n;
    for (const rec of held.values()) if (rec.state === 'held') sum += BigInt(rec.reward);
    return sum;
  }

  // ─── §4.0 permit-send ──────────────────────────────────────────────────

  private async permitSend(body: Record<string, unknown>, now: number): Promise<Response> {
    const txId = String(body.txId ?? '');
    const kind = body.kind as PermitKind;
    const cycle = Number(body.cycle);
    if (!txId || !['upload', 'resend', 'redrop2', 'marker'].includes(kind) || !Number.isInteger(cycle)) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const existing = await txn.get<PermitRecord>(K.permit(txId));
      // A repeat for a txId whose reservation was RELEASED (phase 1 of a
      // redrop decided it is dead): the right to send is gone for every
      // executor, however stale — a durable lever, not a race (review, H1).
      if (existing?.spendKey) {
        const res = await txn.get<StoredReservation>(K.res(existing.spendKey));
        if (res?.state === 'released') return refuse(SPEND_CODES.reservationReleased, 503, { txId });
      }
      const decision = permitDecision(
        { freeze: await this.getFreeze(txn), init: await this.getInit(txn), existing, now },
        { txId, kind, cycle, spendKey: typeof body.spendKey === 'string' ? body.spendKey : undefined },
      );
      if (!decision.granted) return refuse(decision.code, 503);
      // The permit is a LEASE on the money: from here until `/send-done` (or
      // SEND_LEASE_MS) the reservation cannot be released — a sender whose
      // answer is slow and a releaser deciding the redrop cannot both win.
      const sending = decision.existing && decision.permit.sending && now - decision.permit.sending.since < SEND_LEASE_MS
        ? decision.permit.sending
        : { token: crypto.randomUUID(), since: now };
      const permit: PermitRecord = { ...decision.permit, sending };
      await txn.put<PermitRecord>(K.permit(txId), permit);
      if (decision.permit.spendKey) {
        const res = await txn.get<StoredReservation>(K.res(decision.permit.spendKey));
        if (res && res.permitTxId !== txId) await txn.put<StoredReservation>(K.res(decision.permit.spendKey), { ...res, permitTxId: txId });
      }
      if (!decision.existing) await this.audit(txn, 'permit', { txId, kind, cycle });
      return okJson({ granted: true, existing: decision.existing, permit, sendToken: sending.token });
    });
  }

  /** The sender reports the end of its POST (any outcome): the lease is
   *  cleared under the token it was handed. Idempotent. */
  private async sendDone(body: Record<string, unknown>): Promise<Response> {
    const txId = String(body.txId ?? ''); const token = String(body.sendToken ?? '');
    if (!txId || !token) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const permit = await txn.get<PermitRecord>(K.permit(txId));
      if (!permit) return new Response('unknown permit', { status: 404 });
      if (!permit.sending || permit.sending.token !== token) return okJson({ cleared: false });
      const { sending: _s, ...rest } = permit; void _s;
      await txn.put<PermitRecord>(K.permit(txId), rest);
      return okJson({ cleared: true });
    });
  }

  // ─── §4.0 freeze ───────────────────────────────────────────────────────

  private async freeze(body: Record<string, unknown>, now: number): Promise<Response> {
    const active = body.active === true;
    return this.state.storage.transaction(async (txn) => {
      const current = await this.getFreeze(txn);
      if (!active) {
        const init = await this.getInit(txn);
        if (init.state !== 'done') return refuse(SPEND_CODES.notInitialized, 503, { initState: init.state });
      }
      const next: FreezeState = active
        ? { active: true, epoch: current.epoch + 1, since: now }
        : { active: false, epoch: current.epoch };
      await txn.put<FreezeState>(K.freeze, next);
      await this.audit(txn, 'freeze', { active, epoch: next.epoch });
      return okJson({ active: next.active, epoch: next.epoch });
    });
  }

  // ─── §4.0 п. 4 init-legacy ──────────────────────────────────────────────

  private async initLegacy(body: Record<string, unknown>, now: number): Promise<Response> {
    const items = Array.isArray(body.items) ? (body.items as Array<{ txId?: unknown; reward?: unknown; source?: unknown }>) : null;
    if (!items) return new Response('bad request', { status: 400 });
    // Validate the WHOLE batch before the first write (review 24.09, high): a
    // 400 returned from inside the transaction callback commits what was
    // written before it — a hold without its pending would have been left
    // behind, and a retry would skip the «already registered» item.
    const parsed: Array<{ txId: string; reward: bigint; source: 'permit' | 'journal' }> = [];
    for (const item of items) {
      const txId = String(item.txId ?? ''); const reward = amount(item.reward);
      if (!txId || reward === null) return new Response('bad item', { status: 400 });
      parsed.push({ txId, reward, source: item.source === 'permit' ? 'permit' : 'journal' });
    }
    return this.state.storage.transaction(async (txn) => {
      if (!(await this.getFreeze(txn)).active) return refuse(SPEND_CODES.initNotFrozen, 503);
      const ledger = await this.getLedger(txn);
      let added = 0n; let held = 0;
      for (const { txId, reward, source } of parsed) {
        if (await txn.get(K.legacy(txId))) { held++; continue; } // idempotent by txId
        await txn.put<StoredLegacy>(K.legacy(txId), { reward: reward.toString(), state: 'held', source, registeredAt: now });
        added += reward; held++;
      }
      const next = { ...ledger, pending: ledger.pending + added };
      await this.putLedger(txn, next);
      await this.audit(txn, 'init-legacy', { held, added: added.toString() });
      return okJson({ held, pending: next.pending.toString() });
    });
  }

  /** L₁: permits (all cycles, never the marker) whose reservation has no
   *  terminal outcome and which are not registered as legacy yet. The reward
   *  is the reservation's — what the transaction was signed with. */
  private async openPermits(): Promise<Response> {
    const items: Array<{ txId: string; reward: string | null; spendKey: string; state: string | null }> = [];
    for (const [key, permit] of await this.state.storage.list<PermitRecord>({ prefix: 'permit:' })) {
      if (permit.kind === 'marker' || !permit.spendKey) continue;
      const txId = key.slice('permit:'.length);
      if (await this.state.storage.get(K.legacy(txId))) continue;
      const res = await this.state.storage.get<StoredReservation>(K.res(permit.spendKey));
      if (res && (res.state === 'spent' || res.state === 'released')) continue;
      items.push({ txId, reward: res?.reward ?? null, spendKey: permit.spendKey, state: res?.state ?? null });
    }
    return okJson({ items });
  }

  private async legacyList(): Promise<Response> {
    const items: Array<{ txId: string } & StoredLegacy> = [];
    for (const [key, rec] of await this.state.storage.list<StoredLegacy>({ prefix: 'legacy:' })) {
      items.push({ txId: key.slice('legacy:'.length), ...rec });
    }
    return okJson({ items });
  }

  private async getLegacyKeys(): Promise<StoredLegacyKeys> {
    return (await this.state.storage.get<StoredLegacyKeys>(K.legacyKeys)) ?? { keys: [], acknowledgedInvites: 0 };
  }

  /** The operator's explicit registration (§4.0 п. 2): keys recovered from
   *  KV / backups, and the count of old-format invites acknowledged as
   *  covered. Monotone: keys are added, the acknowledgement never shrinks. */
  private async setLegacyKeys(body: Record<string, unknown>): Promise<Response> {
    const keys = Array.isArray(body.keys) ? (body.keys as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 64) : [];
    const ack = typeof body.acknowledgeLegacyInvites === 'number' && Number.isInteger(body.acknowledgeLegacyInvites) && body.acknowledgeLegacyInvites >= 0 ? body.acknowledgeLegacyInvites : 0;
    return this.state.storage.transaction(async (txn) => {
      const current = (await txn.get<StoredLegacyKeys>(K.legacyKeys)) ?? { keys: [], acknowledgedInvites: 0 };
      const next: StoredLegacyKeys = { keys: [...new Set([...current.keys, ...keys])], acknowledgedInvites: Math.max(current.acknowledgedInvites, ack) };
      await txn.put<StoredLegacyKeys>(K.legacyKeys, next);
      await this.audit(txn, 'legacy-keys', { added: keys.length, acknowledgedInvites: next.acknowledgedInvites });
      return okJson({ ...next });
    });
  }

  // ─── §4.1 marker automaton ──────────────────────────────────────────────

  private async initStep(event: InitEvent): Promise<Response> {
    return this.state.storage.transaction(async (txn) => {
      const record = await this.getInit(txn);
      const t = initTransition(record, event);
      if (!t.ok) return refuse(t.code, t.code === SPEND_CODES.initInProgress ? 409 : 503, { initState: record.state });
      await txn.put<InitRecord>(K.init, t.record);
      if (t.opensCycle !== undefined && t.record.hInit !== undefined) {
        // `done` fixes the marker height on the CURRENT ledger — it never
        // resets it (review 24.09 #1): the cycle ledger was opened at reinit
        // (or is the fresh default), and anything settled between reinit and
        // done — a carried reservation whose transaction confirmed while the
        // marker was still `posted` — is already in `spent`. Deposits are 0 by
        // construction (crediting needs h_init).
        const ledger = await this.getLedger(txn);
        let spent = ledger.spent;
        // Classification once the boundary is known (§4.0 п. 6 applied to
        // carried reservations): a carried transaction confirmed AT OR BELOW
        // h_init was mined before the marker — it belongs to the pre-marker
        // reserve, not to this cycle's spending. Only a reservation that
        // recorded its confirmed height can be moved; without a height it
        // stays `spent` (the conservative side).
        for (const [key, res] of await txn.list<StoredReservation>({ prefix: 'res:' })) {
          // Only spending BOOKED INTO THIS ledger (settledCycle = this cycle)
          // by a reservation carried from an older one (created earlier) can
          // be moved to the reserve; a spend booked before reinit sits in the
          // archived ledger and is not here to subtract.
          if (res.state !== 'spent' || res.reclassified) continue;
          if (res.settledCycle !== t.record.cycle || res.cycle >= t.record.cycle) continue;
          if (res.settledHeight === undefined) continue;
          if (res.settledHeight <= t.record.hInit) {
            spent -= BigInt(res.reward);
            await txn.put<StoredReservation>(key, { ...res, reclassified: 'reserve' });
            await this.audit(txn, 'carried-reclassified-reserve', { spendKey: key.slice(4), reward: res.reward, settledHeight: res.settledHeight, hInit: t.record.hInit });
          }
        }
        await this.putLedger(txn, { ...ledger, cycle: t.record.cycle, hInit: t.record.hInit, spent });
      }
      await this.audit(txn, `init-${event.kind}`, { state: t.record.state, txId: t.record.txId ?? null, cycle: t.record.cycle });
      return okJson({ init: t.record });
    });
  }

  // ─── §4.0 п. 6 legacy-resolve ───────────────────────────────────────────

  private async legacyResolve(body: Record<string, unknown>, now: number): Promise<Response> {
    const txId = String(body.txId ?? ''); const outcome = body.outcome;
    if (!txId || (outcome !== 'spent' && outcome !== 'dropped')) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const rec = await txn.get<StoredLegacy>(K.legacy(txId));
      if (!rec) return new Response('unknown legacy txId', { status: 404 });
      if (rec.state !== 'held') return okJson({ state: rec.state, noop: true });
      const reward = BigInt(rec.reward);
      const ledger = await this.getLedger(txn);
      const next: CycleLedger = { ...ledger, pending: ledger.pending - reward, spent: outcome === 'spent' ? ledger.spent + reward : ledger.spent };
      await this.putLedger(txn, next);
      if (outcome === 'spent') await txn.put(K.buckets, fromBuckets(addToBucket(toBuckets(await txn.get(K.buckets)), now, reward)));
      await txn.put<StoredLegacy>(K.legacy(txId), { ...rec, state: outcome });
      await this.audit(txn, 'legacy-resolve', { txId, outcome, reward: rec.reward });
      return okJson({ state: outcome, available: available(next).toString() });
    });
  }

  // ─── §4.4 reinit ────────────────────────────────────────────────────────

  private async reinit(): Promise<Response> {
    return this.state.storage.transaction(async (txn) => {
      const ledger = await this.getLedger(txn);
      if (!(await this.getFreeze(txn)).active) return refuse(SPEND_CODES.initNotFrozen, 503);
      // Reservations of the closing cycle are part of the closed set (§4.4):
      // a `prepared` one never reached the network — released with the cycle,
      // its money stays with the archive; an `active` one may have been POSTed
      // — its reward is CARRIED into the new pending (like a legacy hold) and
      // settles later against the new cycle. Neither may ever be released
      // against the new cycle's pending (review 24.09, high: an old lease
      // expiring after reinit made available = deposits + reward).
      let carried = 0n; let releasedOld = 0;
      for (const [key, res] of await txn.list<StoredReservation>({ prefix: 'res:' })) {
        if (res.state === 'prepared') { await txn.put<StoredReservation>(key, { ...res, state: 'released', leaseUntil: undefined }); releasedOld++; }
        else if (res.state === 'active') carried += BigInt(res.reward);
      }
      const r = reinit(ledger, (await this.heldTotal(txn)) + carried, true);
      if ('ok' in r) return refuse(r.code, 503);
      await txn.put(K.archive(ledger.cycle), { ...fromLedger(r.archived), init: await this.getInit(txn), archivedAt: Date.now(), releasedPrepared: releasedOld, carriedActive: carried.toString() });
      await this.putLedger(txn, r.ledger);
      await txn.put<InitRecord>(K.init, { state: 'none', cycle: r.ledger.cycle, attempts: 0 });
      // Deposits of the old cycle belong to its archive; the per-txId markers
      // stay so a transfer can never be credited twice across cycles.
      await this.audit(txn, 'reinit', { archivedCycle: ledger.cycle, newCycle: r.ledger.cycle, releasedPrepared: releasedOld, carriedActive: carried.toString() });
      return okJson({ archivedCycle: ledger.cycle, cycle: r.ledger.cycle, releasedPrepared: releasedOld, carriedActive: carried.toString() });
    });
  }

  // ─── §4.2 credit-deposit ────────────────────────────────────────────────

  private async creditDeposit(body: Record<string, unknown>): Promise<Response> {
    const txId = String(body.txId ?? ''); const amt = amount(body.amount); const height = Number(body.depositHeight);
    if (!txId || amt === null || !Number.isInteger(height)) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const ledger = await this.getLedger(txn);
      const credited = new Set<string>((await txn.get<string[]>('deposits-index')) ?? []);
      const d = creditDeposit(ledger, credited, { txId, amount: amt, depositHeight: height });
      if (!d.ok) return refuse(d.code, d.code === SPEND_CODES.depositBeforeMarker ? 409 : 503);
      if (d.credited) {
        await this.putLedger(txn, d.ledger);
        await txn.put(K.deposit(txId), { amount: amt.toString(), depositHeight: height, cycle: ledger.cycle });
        await txn.put('deposits-index', [...credited, txId]);
        await this.audit(txn, 'deposit', { txId, amount: amt.toString(), depositHeight: height, cycle: ledger.cycle });
      }
      return okJson({ credited: d.credited, deposits: d.ledger.deposits.toString(), available: available(d.ledger).toString() });
    });
  }

  // ─── §3.4 / §5 inputs from the worker ───────────────────────────────────

  private async refreshBalance(body: Record<string, unknown>, now: number): Promise<Response> {
    const observedMin = body.observedMin === null ? null : amount(body.observedMin);
    if (observedMin === undefined) return new Response('bad request', { status: 400 });
    await this.state.storage.put<StoredBalance>(K.balance, { observedMin: observedMin === null ? null : observedMin.toString(), at: now });
    return okJson({ observedMin: observedMin === null ? null : observedMin.toString() });
  }

  private async refreshPrice(body: Record<string, unknown>, now: number): Promise<Response> {
    const bytes = Number(body.bytes); const reward = amount(body.reward);
    if (!Number.isInteger(bytes) || bytes <= 0 || reward === null) return new Response('bad request', { status: 400 });
    const quoteId = crypto.randomUUID();
    await this.state.storage.put<StoredQuote>(K.quote(quoteId), { quoteId, bytes, reward: reward.toString(), expiresAt: now + PRICE_QUOTE_TTL_MS });
    return okJson({ quoteId, bytes, reward: reward.toString(), expiresAt: now + PRICE_QUOTE_TTL_MS });
  }

  // ─── §5 prepare ─────────────────────────────────────────────────────────

  private readLimits(raw: unknown): SpendLimits | null {
    const l = raw as { walletFloor?: unknown; windowCap?: unknown; maxTxReward?: unknown } | undefined;
    const walletFloor = amount(l?.walletFloor); const windowCap = amount(l?.windowCap); const maxTxReward = amount(l?.maxTxReward);
    if (walletFloor === null || windowCap === null || maxTxReward === null) return null;
    return { walletFloor, windowCap, maxTxReward };
  }

  private async prepare(body: Record<string, unknown>, now: number): Promise<Response> {
    const spendKey = String(body.spendKey ?? ''); const reward = amount(body.reward); const revision = Number(body.revision);
    const quoteId = String(body.quoteId ?? ''); const bytes = Number(body.bytes); const limits = this.readLimits(body.limits);
    if (!spendKey || reward === null || !Number.isInteger(revision) || !quoteId || !Number.isInteger(bytes)) return new Response('bad request', { status: 400 });
    if (limits === null) return refuse(SPEND_CODES.guardUnconfigured, 503);
    return this.state.storage.transaction(async (txn) => {
      // Ended leases first — they hold nothing (§ leases), and a lost alarm
      // must not make them hold the budget against this request.
      await this.expireLeasesInTxn(txn, now);
      const existing = await txn.get<StoredReservation>(K.res(spendKey));
      const ledgerNow = await this.getLedger(txn);
      if (existing && existing.state === 'prepared' && existing.cycle === ledgerNow.cycle && existing.revision === revision && existing.reward === reward.toString()) {
        return okJson({ state: 'prepared', idempotent: true, cycle: ledgerNow.cycle, revision, leaseUntil: existing.leaseUntil ?? null });
      }
      if (existing && existing.state !== 'released') return refuse(SPEND_CODES.activateConflict, 503, { state: existing.state });
      // The quote binds the price to the SIZE (§5, quoteId): unknown, expired
      // or a different reward → mismatch.
      const quote = await txn.get<StoredQuote>(K.quote(quoteId));
      if (!quote || quote.expiresAt <= now || quote.bytes !== bytes || quote.reward !== reward.toString()) return refuse(SPEND_CODES.quoteMismatch, 503);
      const ledger = await this.getLedger(txn);
      const init = await this.getInit(txn);
      const balance = await txn.get<StoredBalance>(K.balance);
      const d = prepareDecision({
        ledger, initDone: init.state === 'done', frozen: (await this.getFreeze(txn)).active, limits, reward,
        spentLast24h: spentLast24h(toBuckets(await txn.get(K.buckets)), now),
        observedMin: balance?.observedMin == null ? null : BigInt(balance.observedMin),
      });
      if (!d.ok) return refuse(d.code, 503, { available: available(ledger).toString() });
      await txn.put<StoredReservation>(K.res(spendKey), { state: 'prepared', reward: reward.toString(), revision, quoteId, leaseUntil: now + PREPARED_LEASE_MS, cycle: ledger.cycle });
      const next = { ...ledger, pending: ledger.pending + reward };
      await this.putLedger(txn, next);
      await this.audit(txn, 'prepare', { spendKey, reward: reward.toString(), revision, cycle: ledger.cycle });
      return okJson({ state: 'prepared', available: available(next).toString(), leaseUntil: now + PREPARED_LEASE_MS, cycle: ledger.cycle, revision });
    }).then(async (res) => {
      // Outside the transaction: the alarm is a scheduling fact, not ledger
      // state, and a failed setAlarm must not undo a prepared reservation
      // (the next prepare, or the next alarm run, re-arms it).
      if (res.ok) {
        const body = (await res.clone().json()) as { leaseUntil?: number | null };
        if (typeof body.leaseUntil === 'number') { try { await this.armLeaseAlarm(body.leaseUntil); } catch (e) { console.error('SPEND_GUARD_ALARM_NOT_ARMED', e); } }
      }
      return res;
    });
  }

  // ─── §6 activate ────────────────────────────────────────────────────────

  private async activate(body: Record<string, unknown>, now: number): Promise<Response> {
    const spendKey = String(body.spendKey ?? ''); const reward = amount(body.reward); const revision = Number(body.revision);
    const activatedBy = String(body.activatedBy ?? '');
    if (!spendKey || reward === null || !Number.isInteger(revision) || !activatedBy) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredReservation>(K.res(spendKey));
      const res: Reservation | undefined = existing ? { state: existing.state, reward: BigInt(existing.reward), revision: existing.revision, activatedBy: existing.activatedBy } : undefined;
      const outcome = activateOutcome(res, { reward, revision, activatedBy });
      if (outcome === 'conflict') return refuse(SPEND_CODES.activateConflict, 503, { state: existing?.state });
      if (outcome === 'noop' || outcome === 'terminal-noop') return okJson({ state: existing!.state, outcome, cycle: existing!.cycle });
      if (outcome === 'remap') {
        // Re-run the §5 checks for the NEW reward in one step (the old pending,
        // if any, is replaced, never added); refusal rolls everything back.
        // A prepared reservation of an OLDER cycle holds nothing in this
        // pending (reinit released it), so nothing is replaced for it.
        const limits = this.readLimits(body.limits);
        if (limits === null) return refuse(SPEND_CODES.guardUnconfigured, 503);
        // Ended leases of OTHER keys first (same reason as in prepare); this
        // key's own expired lease is what the remap replaces below.
        await this.expireLeasesInTxn(txn, now);
        const refreshed = await txn.get<StoredReservation>(K.res(spendKey));
        const ledger = await this.getLedger(txn);
        const oldPending = refreshed && refreshed.state === 'prepared' && refreshed.cycle === ledger.cycle ? BigInt(refreshed.reward) : 0n;
        const base = { ...ledger, pending: ledger.pending - oldPending };
        const init = await this.getInit(txn);
        const balance = await txn.get<StoredBalance>(K.balance);
        const d = prepareDecision({
          ledger: base, initDone: init.state === 'done', frozen: (await this.getFreeze(txn)).active, limits, reward,
          spentLast24h: spentLast24h(toBuckets(await txn.get(K.buckets)), now),
          observedMin: balance?.observedMin == null ? null : BigInt(balance.observedMin),
        });
        if (!d.ok) return refuse(SPEND_CODES.remapRefused, 503, { reason: d.code });
        await this.putLedger(txn, { ...base, pending: base.pending + reward });
        await txn.put<StoredReservation>(K.res(spendKey), { state: 'active', reward: reward.toString(), revision, activatedBy, cycle: ledger.cycle });
        await this.audit(txn, 'activate-remap', { spendKey, reward: reward.toString(), revision });
        return okJson({ state: 'active', outcome, cycle: ledger.cycle });
      }
      await txn.put<StoredReservation>(K.res(spendKey), { ...existing!, state: 'active', activatedBy, leaseUntil: undefined });
      await this.audit(txn, 'activate', { spendKey, reward: reward.toString(), revision });
      return okJson({ state: 'active', outcome, cycle: existing!.cycle });
    });
  }

  // ─── §7 settle ──────────────────────────────────────────────────────────

  private async settle(body: Record<string, unknown>, now: number): Promise<Response> {
    const spendKey = String(body.spendKey ?? ''); const outcome = body.outcome;
    if (!spendKey || (outcome !== 'spent' && outcome !== 'released')) return new Response('bad request', { status: 400 });
    // The confirmed block height from the status quorum (optional): a carried
    // reservation settled while the marker is not yet `done` is classified
    // against h_init later (see initStep); without it, `spent` is final.
    const settledHeight = typeof body.height === 'number' && Number.isInteger(body.height) ? body.height : undefined;
    return this.state.storage.transaction(async (txn) => this.settleInTxn(txn, spendKey, outcome, settledHeight, now));
  }

  /** `settle` addressed by the txId a permit named (`permit:<txId>` →
   *  `spendKey`). 404 when no permit exists for the txId (a pre-D10
   *  publication — not an error for the caller); 400 for a marker permit
   *  (its money is not a reservation). */
  private async settleByTx(body: Record<string, unknown>, now: number): Promise<Response> {
    const txId = String(body.txId ?? ''); const outcome = body.outcome;
    if (!txId || (outcome !== 'spent' && outcome !== 'released')) return new Response('bad request', { status: 400 });
    const settledHeight = typeof body.height === 'number' && Number.isInteger(body.height) ? body.height : undefined;
    return this.state.storage.transaction(async (txn) => {
      const permit = await txn.get<PermitRecord>(K.permit(txId));
      if (!permit) return new Response('unknown permit', { status: 404 });
      if (permit.kind === 'marker' || !permit.spendKey) return new Response('not a reservation', { status: 400 });
      return this.settleInTxn(txn, permit.spendKey, outcome, settledHeight, now);
    });
  }

  private async settleInTxn(txn: Txn, spendKey: string, outcome: 'spent' | 'released', settledHeight: number | undefined, now: number): Promise<Response> {
    {
      const existing = await txn.get<StoredReservation>(K.res(spendKey));
      if (!existing) return new Response('unknown reservation', { status: 404 });
      // `released` under a live send lease is refused: the bytes may be on
      // their way to the network right now (review 24.09 #3, high 1).
      if (outcome === 'released' && existing.state === 'active' && existing.permitTxId) {
        const permit = await txn.get<PermitRecord>(K.permit(existing.permitTxId));
        if (permit?.sending && now - permit.sending.since < SEND_LEASE_MS) {
          return refuse(SPEND_CODES.sendInFlight, 503, { txId: existing.permitTxId, since: permit.sending.since });
        }
      }
      const r = settle({ state: existing.state, reward: BigInt(existing.reward), revision: existing.revision, activatedBy: existing.activatedBy }, outcome);
      if (!r.ok) return refuse(SPEND_CODES.activateConflict, 409, { reason: r.reason, state: existing.state });
      const ledger = await this.getLedger(txn);
      // An active reservation carried across reinit settles against the NEW
      // cycle: its reward already sits in this pending (carried), so the same
      // deltas apply; a stale prepared one of an old cycle cannot get here
      // (released at reinit → prepared_cannot_settle / spent_is_final above).
      if (existing.cycle !== ledger.cycle && existing.state !== 'active' && existing.state !== 'spent' && existing.state !== 'released') {
        return refuse(SPEND_CODES.activateConflict, 409, { reason: 'foreign_cycle', state: existing.state });
      }
      const next: CycleLedger = { ...ledger, spent: ledger.spent + r.spentDelta, pending: ledger.pending + r.pendingDelta };
      await this.putLedger(txn, next);
      if (r.spentDelta > 0n) await txn.put(K.buckets, fromBuckets(addToBucket(toBuckets(await txn.get(K.buckets)), now, r.spentDelta)));
      // The height and the cycle are recorded by the settle that BOOKED the
      // spend; a later confirmed recheck (a no-op on the lattice) must not
      // move them — the classification at `done` reads the first one.
      await txn.put<StoredReservation>(K.res(spendKey), {
        ...existing,
        state: r.state,
        ...(r.spentDelta > 0n ? { settledCycle: ledger.cycle } : {}),
        ...(r.spentDelta > 0n && settledHeight !== undefined ? { settledHeight } : {}),
      });
      const noop = r.spentDelta === 0n && r.pendingDelta === 0n && r.state === existing.state;
      if (!noop) await this.audit(txn, 'settle', { spendKey, outcome, conflict: r.conflict, reward: existing.reward, settledHeight: settledHeight ?? null });
      return okJson({ state: r.state, conflict: r.conflict, noop, available: available(next).toString() });
    }
  }

  // ─── leases ─────────────────────────────────────────────────────────────

  private async expireLeases(now: number): Promise<Response> {
    return this.state.storage.transaction(async (txn) => {
      const r = await this.expireLeasesInTxn(txn, now);
      return okJson({ expired: r.count, released: r.released.toString(), nextDueAt: r.nextDueAt });
    });
  }

  /**
   * Release every `prepared` lease of the current cycle that has ended.
   * Called by the alarm AND, before the budget checks, by `prepare` and by
   * an `activate` remap (review 24.09, medium): the alarm is only an
   * accelerator — a lost `setAlarm` must never let an ended lease hold the
   * budget against the next request, which is exactly when the request is
   * refused `spend_floor` and could not arm an alarm itself.
   */
  private async expireLeasesInTxn(txn: Txn, now: number): Promise<{ count: number; released: bigint; nextDueAt: number | null }> {
    const all = await txn.list<StoredReservation>({ prefix: 'res:' });
    const current = (await this.getLedger(txn)).cycle;
    let released = 0n; let count = 0;
    for (const [key, res] of all) {
      // A prepared lease of an older cycle was released by reinit; anything
      // still tagged with an older cycle is never charged to this one.
      if (res.state !== 'prepared' || res.cycle !== current || (res.leaseUntil ?? 0) > now) continue;
      await txn.put<StoredReservation>(key, { ...res, state: 'released' });
      released += BigInt(res.reward); count++;
    }
    if (count > 0) {
      const ledger = await this.getLedger(txn);
      await this.putLedger(txn, { ...ledger, pending: ledger.pending - released });
      await this.audit(txn, 'expire-leases', { count, released: released.toString() });
    }
    // The earliest lease still open (for the alarm to re-arm on).
    let nextDueAt: number | null = null;
    for (const res of all.values()) {
      if (res.state !== 'prepared' || res.cycle !== current || (res.leaseUntil ?? 0) <= now) continue;
      if (nextDueAt === null || res.leaseUntil! < nextDueAt) nextDueAt = res.leaseUntil!;
    }
    return { count, released, nextDueAt };
  }

  // ─── status ─────────────────────────────────────────────────────────────

  private async status(): Promise<Response> {
    const [freeze, init, ledger, buckets, balance] = await Promise.all([
      this.getFreeze(), this.getInit(), this.getLedger(), this.state.storage.get<Record<string, string>>(K.buckets), this.state.storage.get<StoredBalance>(K.balance),
    ]);
    const now = Date.now();
    return okJson({
      freeze,
      init: { ...init, signedTx: init.signedTx === undefined ? undefined : `<${init.signedTx.length} bytes>` },
      ledger: fromLedger(ledger),
      available: available(ledger).toString(),
      spentLast24h: spentLast24h(toBuckets(buckets), now).toString(),
      observedMin: balance?.observedMin ?? null,
      observedAt: balance?.at ?? null,
    });
  }
}
