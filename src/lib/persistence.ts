/**
 * Persistent-storage request (Storage Standard `navigator.storage.persist()`).
 *
 * Without it the origin's IndexedDB is BEST-EFFORT: the browser may evict the
 * whole database under storage pressure — and evicting it takes `meta.init` and
 * `meta.pin-seed` with it, so the app forgets the vault exists and asks for the
 * seed phrase again. Persistent storage is the only thing that turns that off.
 *
 * Policy (deliberate, see the plan's «принятые компромиссы»):
 *  - Chrome-first: `persist()` is CALLED, gated only on an already-'denied'
 *    permission. Chromium decides by its own engagement heuristics and does not
 *    prompt; gating the call on a 'granted' permission state instead risked
 *    never asking at all, which is the browser this fix exists for.
 *  - Only from EXPLICIT user actions (vault created / restored / unlocked by
 *    PIN) — never from a silent bootstrap resume: a request that a user cannot
 *    connect to something they just did is exactly what the standard warns
 *    against.
 *  - At most ONE request per page load (single-flight), and after a refusal not
 *    again in this tab at all (sessionStorage marker) — that is what keeps a
 *    prompting engine (Firefox) from re-asking on every reload.
 */

export type PersistenceState = 'persisted' | 'denied' | 'unsupported';

/** Per-TAB refusal marker: survives reloads, dies with the tab. */
const DENIED_KEY = 'matamata-notes-persist-denied';

/** Single-flight for one page load: concurrent callers share one attempt. */
let attempt: Promise<PersistenceState> | null = null;

export function ensurePersistentStorage(): Promise<PersistenceState> {
  attempt ??= run();
  return attempt;
}

/** Tests only: drop the in-memory attempt (simulates a fresh page load). */
export function resetPersistenceAttemptForTests(): void {
  attempt = null;
}

function readDeniedMarker(): boolean {
  try {
    return sessionStorage.getItem(DENIED_KEY) !== null;
  } catch {
    return false; // storage blocked (private mode) — just don't remember
  }
}

function writeDeniedMarker(): void {
  try {
    sessionStorage.setItem(DENIED_KEY, '1');
  } catch { /* storage blocked — the single-flight still holds for this load */ }
}

async function run(): Promise<PersistenceState> {
  try {
    const storage = navigator.storage as StorageManager | undefined;
    if (!storage?.persist || !storage.persisted) return 'unsupported';

    if (await storage.persisted()) return 'persisted';
    if (readDeniedMarker()) return 'denied';

    // Best-effort, ONLY to skip a request that cannot succeed. Any failure here
    // (an engine that does not know this permission name) is ignored on
    // purpose — it must never stop us from asking.
    try {
      const status = await navigator.permissions?.query(
        { name: 'persistent-storage' as PermissionName },
      );
      if (status?.state === 'denied') {
        writeDeniedMarker();
        return 'denied';
      }
    } catch { /* permission name unknown to this engine — ask anyway */ }

    const granted = await storage.persist();
    if (!granted) writeDeniedMarker();
    return granted ? 'persisted' : 'denied';
  } catch (err) {
    // Never throws: every caller fires this with `void` and must not be able to
    // break vault opening over a storage-policy probe.
    console.error('ensurePersistentStorage failed:', err);
    return 'unsupported';
  }
}
