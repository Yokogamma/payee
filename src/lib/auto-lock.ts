/**
 * Matamata Notes — pure auto-lock decision logic.
 *
 * No DOM, no React: everything here is a total function over explicit inputs so
 * the lock/no-lock matrix stays unit-testable. The store wires these decisions
 * to the real lifecycle events (visibilitychange / pagehide / pageshow) and to
 * bootstrap.
 *
 * Threat model note: the hidden-at marker lives in sessionStorage (per-tab,
 * survives reload and tab discard). It is NOT secret — it only decides WHEN to
 * lock; the lock itself removes the session seed and vault refs synchronously.
 */

// ─── Timeout values ──────────────────────────────────────────────────

/** Seconds the app may stay hidden before locking.
 *  null = never (default), 0 = immediately, 300 = 5 min, 1800 = 30 min. */
export type AutoLockTimeout = null | 0 | 300 | 1800;

/** Whitelist for the meta value — anything else read from storage is treated
 *  as corrupted and falls back to null («Никогда»), and the setter refuses to
 *  persist it. */
export const AUTO_LOCK_TIMEOUT_OPTIONS: readonly AutoLockTimeout[] = [null, 0, 300, 1800];

export function isValidAutoLockTimeout(v: unknown): v is AutoLockTimeout {
  return (AUTO_LOCK_TIMEOUT_OPTIONS as readonly unknown[]).includes(v);
}

// ─── Hidden-at marker ────────────────────────────────────────────────

export const HIDDEN_AT_KEY = 'matamata-notes-hidden-at';

/** The subset of the Storage interface the marker helpers need — tests pass a
 *  Map-backed fake, the app passes sessionStorage. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A validated marker: 'none' = the tab never went hidden; 'invalid' = a
 *  marker exists but is garbage (non-numeric, ≤0, or in the future) — treated
 *  fail-secure by every decision below; 'at' = a trusted hidden timestamp. */
export type ParsedMarker =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'at'; hiddenAt: number };

/** Validate a raw marker string (§6): finite, > 0, ≤ nowMs — else invalid. */
export function parseHiddenMarker(raw: string | null, nowMs: number): ParsedMarker {
  if (raw === null) return { kind: 'none' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > nowMs) return { kind: 'invalid' };
  return { kind: 'at', hiddenAt: n };
}

/**
 * Record that the tab went hidden. The EARLIEST valid timestamp wins:
 * visibilitychange:hidden writes first, pagehide "refines" — it must never
 * push the marker later (that would shrink the measured away-time and unlock
 * a tab that should have locked).
 */
export function markHidden(storage: MarkerStorage, nowMs: number): void {
  const existing = parseHiddenMarker(storage.getItem(HIDDEN_AT_KEY), nowMs);
  if (existing.kind === 'at' && existing.hiddenAt <= nowMs) return; // earlier marker stands
  storage.setItem(HIDDEN_AT_KEY, String(nowMs));
}

/** Atomically consume the marker: read + clear in one step, so a second
 *  return-event (visible AND pageshow both firing) can never double-evaluate
 *  the same away-interval. */
export function consumeHiddenMarker(storage: MarkerStorage, nowMs: number): ParsedMarker {
  const raw = storage.getItem(HIDDEN_AT_KEY);
  storage.removeItem(HIDDEN_AT_KEY);
  return parseHiddenMarker(raw, nowMs);
}

// ─── Decisions ───────────────────────────────────────────────────────

/** Common core: given a CONSUMED marker, should the vault lock?
 *  Fail-secure: an invalid marker locks. `missingLocks` differs by context —
 *  a live tab with no marker simply never went hidden (no lock), while a
 *  bootstrap after leaving the page with no marker is an unknown away-time
 *  (lock). */
function lockPerMarker(
  timeoutSeconds: Exclude<AutoLockTimeout, null>,
  marker: ParsedMarker,
  nowMs: number,
  missingLocks: boolean,
): boolean {
  if (marker.kind === 'none') return missingLocks;
  if (marker.kind === 'invalid') return true; // fail-secure (§6)
  if (timeoutSeconds === 0) return true;      // «Сразу» — any valid marker locks
  return nowMs - marker.hiddenAt >= timeoutSeconds * 1000;
}

/**
 * The tab returned to the foreground (visibilitychange:visible or pageshow /
 * BFCache restore) while the app kept running. Marker must already be consumed
 * (consumeHiddenMarker) by the caller.
 */
export function decideLockOnReturn(
  timeoutSeconds: AutoLockTimeout,
  hasPin: boolean,
  marker: ParsedMarker,
  nowMs: number,
): boolean {
  if (!hasPin || timeoutSeconds === null) return false;
  // No marker on a live tab = it never actually went hidden — nothing to lock.
  return lockPerMarker(timeoutSeconds, marker, nowMs, false);
}

/** How this page load was reached, per PerformanceNavigationTiming.type.
 *  'none' = no navigation entry available (degraded browser). */
export type BootstrapNavigationType = 'reload' | 'back_forward' | 'navigate' | 'none';

export interface BootstrapLockInput {
  hasPin: boolean;
  timeoutSeconds: AutoLockTimeout;
  /** document.wasDiscarded — Chrome reactivates a discarded tab as a 'reload',
   *  so this flag must take PRIORITY over the reload rule. */
  wasDiscarded: boolean;
  navigationType: BootstrapNavigationType;
  /** Already consumed via consumeHiddenMarker(). */
  marker: ParsedMarker;
  nowMs: number;
}

/**
 * Bootstrap decision — runs BEFORE prepareVaultSnapshot, only when a session
 * seed exists in this tab. Navigation matrix (§5), in priority order:
 *  1. wasDiscarded → the tab was hidden then discarded; the marker measures the
 *     away-time (missing/invalid marker → fail-secure lock).
 *  2. reload (and not discarded) → never locks: the user stayed on the app.
 *  3. back_forward → the user left the app and came back through history;
 *     pagehide recorded the marker (missing → fail-secure lock).
 *  4. navigate / no entry → same as (3): a load with a live session but unknown
 *     provenance (incl. a duplicated tab, which copies sessionStorage without
 *     its away-history) locks unless the marker proves the time away was short.
 */
export function decideBootstrapLock(i: BootstrapLockInput): boolean {
  if (!i.hasPin || i.timeoutSeconds === null) return false;
  if (i.wasDiscarded) return lockPerMarker(i.timeoutSeconds, i.marker, i.nowMs, true);
  if (i.navigationType === 'reload') return false;
  return lockPerMarker(i.timeoutSeconds, i.marker, i.nowMs, true);
}
