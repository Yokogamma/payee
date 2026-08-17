import { useMemo, useState } from 'react';
import { useNotes } from '../lib/store';
import { computeSyncCounters, QUARANTINE_EXPLANATION } from '../lib/syncCounters';
import { InfinityMark, IconRefresh, IconChevron, IconClose } from './icons';

/**
 * One line instead of five header icons and a stack of banners.
 *
 * WHAT IT REPLACES: the restore banners, the v3/v4 pause banners, the offline
 * banner, the header's Arweave badge and note count, the ↻ button, and the
 * «Получено с других устройств» toast. Up to three of those used to stack at
 * once and push the feed down.
 *
 * A PRIORITY LADDER, not a stack: the topmost matching condition owns the line.
 * Ambient state is one line, always in the same place, and never pushes content.
 *
 * TWO THINGS DELIBERATELY STAY OUTSIDE IT (both are dismissible one-off facts
 * about an action that already happened, not ongoing state):
 *  - the PWA «Доступна новая версия» prompt — a decision to make, which must
 *    not lose priority to «offline»;
 *  - `pinSetupNotice` — «the PIN you asked for was NOT set». A single line
 *    would let offline or a paused upload swallow it, and silence there leaves
 *    the user believing a PIN is set.
 *
 * SEVERITY IS NOT FLATTENED. Errors keep `role="alert"`; progress and results
 * are `role="status" aria-live="polite"` and only on the message span — a live
 * region wrapping the whole line would chatter on every sync tick.
 */

type Tone = 'ok' | 'busy' | 'warn' | 'error';

/* Icons moved to components/icons.tsx — StatusLine, AppNav and the settings
   rows were each drawing their own copy of the same chevron at a different
   stroke weight. */

interface Rung {
  tone: Tone;
  text: string;
  action?: { label: string; onClick: () => void };
  dismiss?: () => void;
}

/**
 * The leading indicator, decided SEPARATELY from severity.
 *
 * Tying ∞ to `tone === 'ok'` looked right and was wrong: `ok` means «nothing
 * is broken», and four different rungs claim it. Two of them contradict the
 * mark outright — «Синхронизация выключена — всё на устройстве» is the state
 * of NOT being permanent, and «Синхронизировано · 1 из 2 заметок» is half of
 * one. The interface would have promised eternity next to a sentence saying
 * the notes live on this device only.
 *
 * So severity picks the WORDS and storage state picks the MARK. ∞ appears
 * only when every chain is confirmed on-chain, and never while something is
 * wrong or in flight — a transient «Проверяем обновления…» has no business
 * carrying a permanence claim either.
 */
type Indicator = 'permanent' | 'dot';

export function StatusLine() {
  const {
    arweave, chains, syncStatuses,
    restoring, restoreProgress, restoreError, restoredCount, restoredUpdatedCount,
    retryRestore, clearRestoreStatus,
    updateCheck, checkForUpdates,
    v3Paused, resumeV3Uploads, v4Paused, resumeV4Uploads,
    retrySync, dismissError,
  } = useNotes();

  const [expanded, setExpanded] = useState(false);
  const counters = useMemo(
    () => computeSyncCounters(chains, syncStatuses, arweave),
    [chains, syncStatuses, arweave],
  );

  const checking = updateCheck.status === 'checking';
  // Also blocked during a restore: both drive the SAME sweep behind one
  // `restoringRef`, so a second press was silently ignored while the button
  // still looked live.
  const checkBusy = checking || restoring;

  const rung = pickRung();

  // Every chain confirmed on-chain, and the counts are real rather than the
  // empty pre-hydration state that would read as «0 of 0 — all done».
  const allPermanent =
    arweave.enabled &&
    arweave.registered &&
    arweave.countsReady &&
    chains.length > 0 &&
    counters.confirmedChains === chains.length;

  const indicator: Indicator = rung.tone === 'ok' && allPermanent ? 'permanent' : 'dot';

  function pickRung(): Rung {
    if (restoring) {
      return {
        tone: 'busy',
        text: restoreProgress
          ? `Восстанавливаем… ${restoreProgress.done}/${restoreProgress.total}`
          : 'Восстанавливаем…',
      };
    }
    if (checking) {
      const p = updateCheck.status === 'checking' ? updateCheck.progress : null;
      return { tone: 'busy', text: p ? `Проверяем обновления… ${p.done}/${p.total}` : 'Проверяем обновления…' };
    }
    if (restoreError) {
      return {
        tone: 'error',
        text: restoreError,
        action: { label: 'Повторить', onClick: () => void retryRestore() },
        dismiss: clearRestoreStatus,
      };
    }
    if (arweave.enabled && arweave.lastError) {
      return {
        tone: 'error',
        text: arweave.lastError,
        action: { label: 'Повторить', onClick: () => void retrySync() },
        dismiss: dismissError,
      };
    }
    // Standing, not a toast: the pause marker is persisted, so it survives a
    // reload and the line must survive with it.
    if (arweave.enabled && v3Paused) {
      return {
        tone: 'warn',
        text: 'Загрузка новых версий приостановлена — всё сохраняется локально',
        action: { label: 'Возобновить', onClick: () => void resumeV3Uploads() },
      };
    }
    if (arweave.enabled && v4Paused) {
      return {
        tone: 'warn',
        text: 'Загрузка записей сейфа приостановлена — всё сохраняется локально',
        action: { label: 'Возобновить', onClick: () => void resumeV4Uploads() },
      };
    }
    if (arweave.enabled && !arweave.online) {
      return { tone: 'warn', text: 'Оффлайн — заметки сохраняются на устройстве' };
    }
    if (restoredCount !== null) {
      const updated = restoredUpdatedCount ?? 0;
      return {
        tone: 'ok',
        text: `Восстановлено заметок: ${restoredCount}, обновлено: ${updated}`,
        dismiss: clearRestoreStatus,
      };
    }
    if (updateCheck.status === 'done') {
      const { addedNotes, updatedNotes, changedSafebox, at, partial } = updateCheck;
      const time = new Date(at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      // Phrased as a durable FACT, not an announcement: `UpdateCheckState` has
      // no acknowledged transition, so a line that read «получено N» would sit
      // there forever. «Проверено в 14:32 · …» stays true indefinitely and
      // needs neither a timer nor new state.
      const total = addedNotes + updatedNotes + changedSafebox;
      const detail = total > 0
        ? `получено ${addedNotes}` +
          (updatedNotes > 0 ? ` · обновлено ${updatedNotes}` : '') +
          // Shown even with the safebox LOCKED: the count comes from the sweep,
          // not from the section, and it explains why the data changed without
          // revealing anything about it.
          (changedSafebox > 0 ? ` · в сейфе ${changedSafebox}` : '')
        : 'новых записей нет';
      return {
        // `partial` is a WARNING, not a failure: what arrived was merged.
        tone: partial ? 'warn' : 'ok',
        text: `Проверено в ${time} · ${detail}` + (partial ? ' · часть данных недоступна' : ''),
      };
    }
    if (updateCheck.status === 'error') {
      return { tone: 'error', text: 'Не удалось проверить обновления' };
    }
    if (!arweave.enabled) return { tone: 'ok', text: 'Синхронизация выключена — всё на устройстве' };
    return {
      tone: 'ok',
      // «в блокчейне» is what the details panel is FOR. Spelling it out here
      // overflowed the row and truncated the sentence mid-word, so the one
      // place the number was visible showed «2 из 2 заметок в блокч…».
      text: arweave.countsReady
        ? `Синхронизировано · ${counters.confirmedChains} из ${chains.length} заметок`
        : 'Синхронизировано',
    };
  }

  return (
    <div className={`status-line status-line--${rung.tone}`}>
      {/* See the Indicator type: the mark answers «is everything permanent»,
          not «is anything broken». */}
      {indicator === 'permanent'
        ? <InfinityMark className="status-mark" />
        : <span className="status-dot" aria-hidden="true" />}
      {/* An explicit aria-live OVERRIDES the implicit `assertive` that comes
          with role="alert", so setting both would announce errors politely —
          the exact flattening this ladder must not do. Only the non-error
          rungs get the polite hint. */}
      <span
        className="status-text"
        role={rung.tone === 'error' ? 'alert' : 'status'}
        aria-live={rung.tone === 'error' ? undefined : 'polite'}
      >
        {rung.text}
      </span>
      {rung.action && (
        <button className="banner-btn" onClick={rung.action.onClick}>{rung.action.label}</button>
      )}
      {rung.dismiss && (
        <button className="banner-btn banner-close" onClick={rung.dismiss} title="Скрыть" aria-label="Скрыть сообщение">
          <IconClose />
        </button>
      )}
      {/* Reading Arweave needs neither the sync toggle nor a registered key —
          those gate UPLOADS — so this is available on a read-only device. */}
      <button
        className="status-btn"
        onClick={() => void checkForUpdates()}
        disabled={checkBusy}
        title="Проверить обновления"
        aria-label="Проверить обновления"
      >
        <IconRefresh />
      </button>
      <button
        className="status-btn status-btn--plain"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Скрыть подробности' : 'Показать подробности'}
        title="Подробности"
      >
        <IconChevron />
      </button>

      {expanded && (
        <div className="status-details">
          {!arweave.countsReady ? (
            // syncStatuses is still empty here, so the formulas would render an
            // honest-looking «0 из N» lie.
            <div>Синхронизировано: <strong>загружается…</strong></div>
          ) : (
            <>
              {/* NOT «Заметки в блокчейне: N из M» — the collapsed row already
                  carries that number, and printing it again directly under
                  itself was the panel's first line. What the row cannot fit is
                  the breakdown, so the panel starts there. */}
              {counters.pendingChains > 0 && (
                <div>Передано, ждёт подтверждения: <strong>{counters.pendingChains}</strong></div>
              )}
              <div className="status-hint">в блокчейне · версий (транзакций): {arweave.confirmedCount} из {counters.totalVersions}</div>
            </>
          )}
          {arweave.unsyncedCount > 0 && <div>Ожидают загрузки версий: <strong>{arweave.unsyncedCount}</strong></div>}
          {arweave.errorCount > 0 && <div className="text-red">Ошибки: <strong>{arweave.errorCount}</strong></div>}
          {arweave.quarantinedCount > 0 && (
            <div className="status-hint">
              Отложено: {arweave.quarantinedCount} — {QUARANTINE_EXPLANATION}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
