import { env } from 'cloudflare:test';
import { primeSpendBalanceCache } from '../../src/spend-saga';

/**
 * D10 fixture for the suites that reach the paid path of /upload: the saga
 * (spend-saga.ts) asks the GLOBAL SpendGuard for a quote, a reservation, an
 * activation and a permit on every paid POST, and refuses with 503 until the
 * guard is initialised (`init.state === 'done'`) and funded. This brings the
 * guard the worker binding addresses (`idFromName('global')` of the test
 * namespace) to `done` with a marker at height 2 and one credited deposit —
 * idempotently, so every file may call it in `beforeAll` and the isolate's
 * shared storage ends up in the same state whichever file runs first.
 *
 * No network: the marker automaton is driven through the DO routes directly
 * (the worker-side signing and quorum are what spend-guard.marker.test.ts
 * exercises).
 */

const SPEND_GUARD = (env as unknown as { SPEND_GUARD: DurableObjectNamespace }).SPEND_GUARD;

/** The three limits every paid-path suite runs under (also in the vitest
 *  bindings): no floor, a cap and a ceiling far above any mocked price. */
export const SPEND_LIMITS_ENV = {
  WALLET_FLOOR_WINSTON: '0',
  SPEND_WINDOW_CAP_WINSTON: '1000000000000000',
  MAX_TX_REWARD_WINSTON: '1000000000000',
} as const;

export const FIXTURE_MARKER_TX = 'FIXTUREMARKER'.padEnd(43, 'M');
export const FIXTURE_DEPOSIT_TX = 'FIXTUREDEPOSIT'.padEnd(43, 'D');
export const FIXTURE_DEPOSIT = '1000000000000000';

async function call(stub: DurableObjectStub, path: string, body: Record<string, unknown> = {}) {
  const res = await stub.fetch(`http://spend-guard${path}`, { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> & { code?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed };
}

export async function spendGuardStatus(ns: DurableObjectNamespace = SPEND_GUARD) {
  const res = await ns.get(ns.idFromName('global')).fetch('http://spend-guard/status');
  return (await res.json()) as {
    available: string; spentLast24h: string; observedMin: string | null;
    ledger: { cycle: number; hInit: number | null; deposits: string; spent: string; pending: string };
    freeze: { active: boolean; epoch: number };
    init: { state: string; cycle: number; txId?: string };
  };
}

/**
 * Initialise (once) and fund the guard `ns` addresses as `global`.
 * `walletAddress`, when given, primes the §3.4 balance cache for that wallet
 * so the suite's outbound-call counts see no detector reads.
 */
export async function spendGuardReady(
  opts: { ns?: DurableObjectNamespace; walletAddress?: string; deposit?: string } = {},
): Promise<void> {
  const ns = opts.ns ?? SPEND_GUARD;
  const stub = ns.get(ns.idFromName('global'));
  const s = await spendGuardStatus(ns);
  if (s.init.state !== 'done') {
    if (!s.freeze.active) await call(stub, '/freeze', { active: true });
    if (s.init.state === 'none') {
      await call(stub, '/init-begin', { token: 'fixture' });
      await call(stub, '/init-signed', { token: 'fixture', txId: FIXTURE_MARKER_TX, signedTx: 'fixture', anchor: 'a' });
      await call(stub, '/init-posted', { token: 'fixture', txId: FIXTURE_MARKER_TX });
    }
    const st = await spendGuardStatus(ns);
    if (st.init.state === 'posted') {
      const done = await call(stub, '/init-done', { txId: st.init.txId, heights: [1, 2], confirmations: [60, 60] });
      if (done.status !== 200) throw new Error(`spendGuardReady: init-done refused: ${JSON.stringify(done.body)}`);
    } else {
      throw new Error(`spendGuardReady: unexpected init state ${st.init.state}`);
    }
    await call(stub, '/freeze', { active: false });
  } else if (s.freeze.active) {
    await call(stub, '/freeze', { active: false });
  }
  const credit = await call(stub, '/credit-deposit', { txId: FIXTURE_DEPOSIT_TX, amount: opts.deposit ?? FIXTURE_DEPOSIT, depositHeight: 3 });
  if (credit.status !== 200) throw new Error(`spendGuardReady: credit refused: ${JSON.stringify(credit.body)}`);
  if (opts.walletAddress) primeSpendBalanceCache(opts.walletAddress);
}
