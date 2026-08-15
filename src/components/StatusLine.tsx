import { useMemo, useState } from 'react';
import { useNotes } from '../lib/store';
import { computeSyncCounters } from '../lib/syncCounters';

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

interface Rung {
  tone: Tone;
  text: string;
  action?: { label: string; onClick: () => void };
  dismiss?: () => void;
}

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
      text: arweave.countsReady
        ? `Синхронизировано · ${counters.confirmedChains} из ${chains.length} заметок в блокчейне`
        : 'Синхронизировано',
    };
  }

  return (
    <div className={`status-line status-line--${rung.tone}`}>
      <span className="status-dot" aria-hidden="true" />
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
          ✕
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
        {checkBusy ? '⏳' : '↻'}
      </button>
      <button
        className="status-btn"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Скрыть подробности' : 'Показать подробности'}
        title="Подробности"
      >
        {expanded ? '⌃' : '⌄'}
      </button>

      {expanded && (
        <div className="status-details">
          {!arweave.countsReady ? (
            // syncStatuses is still empty here, so the formulas would render an
            // honest-looking «0 из N» lie.
            <div>Синхронизировано: <strong>загружается…</strong></div>
          ) : (
            <>
              <div>Заметки в блокчейне: <strong>{counters.confirmedChains}</strong> из <strong>{chains.length}</strong></div>
              {counters.pendingChains > 0 && (
                <div>Передано, ждёт подтверждения: <strong>{counters.pendingChains}</strong></div>
              )}
              <div className="status-hint">версий (транзакций): {arweave.confirmedCount} из {counters.totalVersions}</div>
            </>
          )}
          {arweave.unsyncedCount > 0 && <div>Ожидают загрузки версий: <strong>{arweave.unsyncedCount}</strong></div>}
          {arweave.errorCount > 0 && <div className="text-red">Ошибки: <strong>{arweave.errorCount}</strong></div>}
          {arweave.quarantinedCount > 0 && (
            // `terminalError` is 'unsupported_version' | 'malformed_record':
            // a record this build cannot process, not a queue problem. The
            // previous wording blamed «created before registration», which is
            // a different situation and would send the user down the wrong
            // recovery path.
            <div className="status-hint">
              Отложено: {arweave.quarantinedCount} — эта версия приложения не может обработать такие записи; повтор не поможет
            </div>
          )}
        </div>
      )}
    </div>
  );
}
