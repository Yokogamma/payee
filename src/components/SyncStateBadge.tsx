import { InfinityMark } from './icons';
import type { SyncBadge } from './syncBadge';

/**
 * ONE rendering of a sync state — feed card and safebox card both.
 *
 * They were two copies of the same JSX, and they drifted the instant either
 * one moved: giving the retry button its own `--retry` class fixed the feed
 * and silently left the safebox's button with no rule, no pointer and no 44px
 * target, while its screen reader kept hearing a label that no longer
 * mentioned повтор at all. The safebox already carried a comment stating the
 * rule — the same badge on two lists must offer the same thing — so the rule
 * has one implementation now instead of two copies of one.
 *
 * `onRetry` is the whole switch: a state you can act on renders as a button,
 * everything else as a status. The CONDITION stays at the call site, because
 * the two lists really do disagree about when a retry is offered.
 */
export function SyncStateBadge({
  badge,
  onRetry,
}: {
  badge: SyncBadge;
  onRetry?: (() => void) | undefined;
}) {
  if (onRetry) {
    // The badge's own label is the FACT («Ошибка загрузки»); the OFFER is
    // added here, in the only branch that can actually honour it — see the
    // note on SYNC_BADGE.error.
    const label = `${badge.label} — повторить`;
    return (
      <button
        className={`state sync-state ${badge.className} sync-state--retry`}
        onClick={onRetry}
        title={label}
        aria-label={label}
      >
        {badge.word} · повторить
      </button>
    );
  }

  return (
    <span
      className={`state sync-state ${badge.className}`}
      title={badge.label}
      role="status"
      aria-label={badge.label}
    >
      {badge.permanent && <InfinityMark />}
      {badge.word}
    </span>
  );
}
