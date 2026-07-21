import { env } from 'cloudflare:test';

// vitest-pool-workers re-imports src/index.ts around test-file boundaries; a
// Durable Object instance that SURVIVES the boundary (the global InviteManager)
// then fails its next ensureInstance check once with "index.ts changed,
// invalidating this Durable Object. Please retry". Call this in beforeAll of
// every file that touches the global InviteManager (directly or via SELF) so
// the one-shot invalidation is absorbed here, deterministically, instead of
// blowing up an arbitrary request mid-test.
export async function warmUpInviteManager(): Promise<void> {
  const ns = (env as unknown as { INVITE_MANAGER: DurableObjectNamespace }).INVITE_MANAGER;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ns.get(ns.idFromName('global')).fetch('http://internal/check-allowed', {
        method: 'POST',
        body: JSON.stringify({ publicKey: 'warmup-probe' }),
      });
      return;
    } catch (e) {
      if (!(e instanceof Error && /invalidating this Durable Object/i.test(e.message))) throw e;
      // stale wrapper absorbed — a fresh stub on the next loop will instantiate cleanly
    }
  }
}
