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
  PREPARED_LEASE_MS, PRICE_QUOTE_TTL_MS, SPEND_CODES,
  activateOutcome, addToBucket, available, creditDeposit, initTransition, permitDecision, prepareDecision,
  reinit, settle, spentLast24h,
  type CycleLedger, type FreezeState, type InitEvent, type InitRecord, type PermitKind, type PermitRecord,
  type Reservation, type SpendCode, type SpendLimits,
} from './spend-ledger';

// ─── Storage shapes (strings for bigint) ────────────────────────────────

interface StoredLedger { cycle: number; hInit: number | null; deposits: string; spent: string; pending: string }
interface StoredReservation extends Omit<Reservation, 'reward'> { reward: string; quoteId?: string; leaseUntil?: number; cycle: number }
interface StoredLegacy { reward: string; state: 'held' | 'spent' | 'dropped'; source: 'permit' | 'journal' }
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

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/status') return this.status();
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; } catch { return new Response('bad json', { status: 400 }); }
    const now = typeof body.now === 'number' ? body.now : Date.now();
    switch (path) {
      case '/permit-send': return this.permitSend(body, now);
      case '/freeze': return this.freeze(body, now);
      case '/init-legacy': return this.initLegacy(body);
      case '/init-begin': return this.initStep({ kind: 'begin', token: String(body.token ?? ''), now, frozen: (await this.getFreeze()).active, legacyOpen: body.legacyOpen === true, rewardUnknown: body.rewardUnknown === true });
      case '/init-signed': return this.initStep({ kind: 'signed', token: String(body.token ?? ''), txId: String(body.txId ?? ''), signedTx: String(body.signedTx ?? ''), anchor: String(body.anchor ?? ''), now });
      case '/init-posted': return this.initStep({ kind: 'posted', token: String(body.token ?? ''), txId: String(body.txId ?? ''), now });
      case '/init-done': return this.initStep({ kind: 'done', txId: String(body.txId ?? ''), heights: (body.heights as number[]) ?? [], confirmations: (body.confirmations as number[]) ?? [], now });
      case '/init-dead': return this.initStep({ kind: 'dead', txId: String(body.txId ?? ''), now });
      case '/legacy-resolve': return this.legacyResolve(body, now);
      case '/reinit': return this.reinit();
      case '/credit-deposit': return this.creditDeposit(body);
      case '/refresh-balance': return this.refreshBalance(body, now);
      case '/refresh-price': return this.refreshPrice(body, now);
      case '/prepare': return this.prepare(body, now);
      case '/activate': return this.activate(body, now);
      case '/settle': return this.settle(body, now);
      case '/expire-leases': return this.expireLeases(now);
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
      const decision = permitDecision(
        { freeze: await this.getFreeze(txn), init: await this.getInit(txn), existing: await txn.get<PermitRecord>(K.permit(txId)), now },
        { txId, kind, cycle, spendKey: typeof body.spendKey === 'string' ? body.spendKey : undefined },
      );
      if (!decision.granted) return refuse(decision.code, 503);
      if (!decision.existing) {
        await txn.put<PermitRecord>(K.permit(txId), decision.permit);
        await this.audit(txn, 'permit', { txId, kind, cycle });
      }
      return okJson({ granted: true, existing: decision.existing, permit: decision.permit });
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

  private async initLegacy(body: Record<string, unknown>): Promise<Response> {
    const items = Array.isArray(body.items) ? (body.items as Array<{ txId?: unknown; reward?: unknown; source?: unknown }>) : null;
    if (!items) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      if (!(await this.getFreeze(txn)).active) return refuse(SPEND_CODES.initNotFrozen, 503);
      const ledger = await this.getLedger(txn);
      let added = 0n; let held = 0;
      for (const item of items) {
        const txId = String(item.txId ?? ''); const reward = amount(item.reward);
        const source = item.source === 'permit' ? 'permit' : 'journal';
        if (!txId || reward === null) return new Response('bad item', { status: 400 });
        if (await txn.get(K.legacy(txId))) { held++; continue; } // idempotent by txId
        await txn.put<StoredLegacy>(K.legacy(txId), { reward: reward.toString(), state: 'held', source });
        added += reward; held++;
      }
      const next = { ...ledger, pending: ledger.pending + added };
      await this.putLedger(txn, next);
      await this.audit(txn, 'init-legacy', { held, added: added.toString() });
      return okJson({ held, pending: next.pending.toString() });
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
        // `done` opens the cycle ledger: deposits 0, spent 0, pending = Σ held.
        // Held legacy sums already sit in `pending` since `/init-legacy`; a
        // reservation pending from before the freeze (there should be none —
        // uploads are off during init) is carried, never dropped.
        const ledger = await this.getLedger(txn);
        await this.putLedger(txn, { cycle: t.record.cycle, hInit: t.record.hInit, deposits: 0n, spent: 0n, pending: ledger.pending });
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
      const r = reinit(ledger, await this.heldTotal(txn), (await this.getFreeze(txn)).active);
      if ('ok' in r) return refuse(r.code, 503);
      await txn.put(K.archive(ledger.cycle), { ...fromLedger(r.archived), init: await this.getInit(txn), archivedAt: Date.now() });
      await this.putLedger(txn, r.ledger);
      await txn.put<InitRecord>(K.init, { state: 'none', cycle: r.ledger.cycle, attempts: 0 });
      // Deposits of the old cycle belong to its archive; the per-txId markers
      // stay so a transfer can never be credited twice across cycles.
      await this.audit(txn, 'reinit', { archivedCycle: ledger.cycle, newCycle: r.ledger.cycle });
      return okJson({ archivedCycle: ledger.cycle, cycle: r.ledger.cycle });
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
      const existing = await txn.get<StoredReservation>(K.res(spendKey));
      if (existing && existing.state === 'prepared' && existing.revision === revision && existing.reward === reward.toString()) {
        return okJson({ state: 'prepared', idempotent: true });
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
      return okJson({ state: 'prepared', available: available(next).toString(), leaseUntil: now + PREPARED_LEASE_MS });
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
      if (outcome === 'noop' || outcome === 'terminal-noop') return okJson({ state: existing!.state, outcome });
      if (outcome === 'remap') {
        // Re-run the §5 checks for the NEW reward in one step (the old pending,
        // if any, is replaced, never added); refusal rolls everything back.
        const limits = this.readLimits(body.limits);
        if (limits === null) return refuse(SPEND_CODES.guardUnconfigured, 503);
        const ledger = await this.getLedger(txn);
        const oldPending = existing && existing.state === 'prepared' ? BigInt(existing.reward) : 0n;
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
        return okJson({ state: 'active', outcome });
      }
      await txn.put<StoredReservation>(K.res(spendKey), { ...existing!, state: 'active', activatedBy, leaseUntil: undefined });
      await this.audit(txn, 'activate', { spendKey, reward: reward.toString(), revision });
      return okJson({ state: 'active', outcome });
    });
  }

  // ─── §7 settle ──────────────────────────────────────────────────────────

  private async settle(body: Record<string, unknown>, now: number): Promise<Response> {
    const spendKey = String(body.spendKey ?? ''); const outcome = body.outcome;
    if (!spendKey || (outcome !== 'spent' && outcome !== 'released')) return new Response('bad request', { status: 400 });
    return this.state.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredReservation>(K.res(spendKey));
      if (!existing) return new Response('unknown reservation', { status: 404 });
      const r = settle({ state: existing.state, reward: BigInt(existing.reward), revision: existing.revision, activatedBy: existing.activatedBy }, outcome);
      if (!r.ok) return refuse(SPEND_CODES.activateConflict, 409, { reason: r.reason, state: existing.state });
      const ledger = await this.getLedger(txn);
      const next: CycleLedger = { ...ledger, spent: ledger.spent + r.spentDelta, pending: ledger.pending + r.pendingDelta };
      await this.putLedger(txn, next);
      if (r.spentDelta > 0n) await txn.put(K.buckets, fromBuckets(addToBucket(toBuckets(await txn.get(K.buckets)), now, r.spentDelta)));
      await txn.put<StoredReservation>(K.res(spendKey), { ...existing, state: r.state });
      await this.audit(txn, 'settle', { spendKey, outcome, conflict: r.conflict, reward: existing.reward });
      return okJson({ state: r.state, conflict: r.conflict, available: available(next).toString() });
    });
  }

  // ─── leases ─────────────────────────────────────────────────────────────

  private async expireLeases(now: number): Promise<Response> {
    return this.state.storage.transaction(async (txn) => {
      const all = await txn.list<StoredReservation>({ prefix: 'res:' });
      let released = 0n; let count = 0;
      for (const [key, res] of all) {
        if (res.state !== 'prepared' || (res.leaseUntil ?? 0) > now) continue;
        await txn.put<StoredReservation>(key, { ...res, state: 'released' });
        released += BigInt(res.reward); count++;
      }
      if (count > 0) {
        const ledger = await this.getLedger(txn);
        await this.putLedger(txn, { ...ledger, pending: ledger.pending - released });
        await this.audit(txn, 'expire-leases', { count, released: released.toString() });
      }
      return okJson({ expired: count, released: released.toString() });
    });
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
