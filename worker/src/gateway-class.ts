/**
 * How one gateway answer is LABELLED for metrics — the single vocabulary both
 * halves of the worker report in.
 *
 * Extracted from `arweave-transport.ts` so the D9 reader can share it without
 * importing the transport (and with it the whole `arweave` library) into a
 * module that is deliberately dependency-light. The transport re-exports these
 * names, so every existing import keeps working: one implementation, because a
 * second one drifts and then two dashboards disagree about the same outage.
 */

export type GatewayClass = '2xx' | '404' | '4xx' | '5xx' | 'network' | 'timeout';

export function classifyStatus(status: number): '2xx' | '404' | '4xx' | '5xx' | 'network' {
  if (status >= 200 && status < 300) return '2xx';
  if (status === 404) return '404';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'network'; // 1xx/3xx leftovers are not a valid gateway answer here
}

export function classifyThrow(e: unknown): 'timeout' | 'network' {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    ? 'timeout'
    : 'network';
}
