import { useEffect, useState } from 'react';
import { useNotes } from '../lib/store';
import { SAFEBOX_WRITER_ENABLED } from '../lib/flags';
import { badgeFor } from './syncBadge';
import { SafeboxPinPad } from './SafeboxPinPad';
import { SafeboxActivation, SafeboxSeedReset } from './SafeboxActivation';
import { SafeboxEntryForm } from './SafeboxEntryForm';
import { SafeboxHistoryModal, SafeboxRestoreDialog } from './SafeboxHistoryModal';
import { Fab } from './Fab';
import type { SafeboxEntryData } from '../lib/crypto';
import type { SafeboxEntryPatch } from '../lib/safebox';
import type { SafeboxNewEntry } from '../lib/store';

/**
 * The safebox container: locked gate → activation → unlocked list.
 *
 * Reveal/copy/download all go through the store, which re-verifies the PIN
 * config against STORAGE before handing out any secret. A copied password
 * never enters the DOM (the store writes it to the clipboard directly from the
 * decrypted string).
 */

interface SafeboxSectionProps {
  formatDate: (ts: number) => string;
}

export function SafeboxSection({ formatDate }: SafeboxSectionProps) {
  const {
    safeboxUnlocked,
    safeboxPinConfigured,
    safeboxDataPresent,
    safeboxEntryCount,
    safeboxChains,
    filteredSafeboxChains,
    safeboxSearchQuery,
    setSafeboxSearchQuery,
    lockSafebox,
    touchSafebox,
    addSafeboxEntry,
    editSafeboxEntry,
    restoreSafeboxVersion,
    revealSafeboxSecret,
    copySafeboxPassword,
    downloadSafeboxAttachment,
    syncStatuses,
    arweave,
    isEncrypting,
  } = useNotes();

  const [seedReset, setSeedReset] = useState(false);
  const [formRoot, setFormRoot] = useState<string | null>(null);   // null + formOpen = create
  const [formOpen, setFormOpen] = useState(false);
  const [historyRoot, setHistoryRoot] = useState<string | null>(null);
  const [historyFocusId, setHistoryFocusId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ root: string; version: SafeboxEntryData } | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const syncActive = arweave.enabled && arweave.registered;

  // Reveal auto-hides after 20 s; a second look means a fresh decrypt.
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 20_000);
    return () => clearTimeout(t);
  }, [revealed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // A lock (idle timer, app lock, another tab) must clear every local surface
  // that could still be holding plaintext. Adjusted DURING render, not in an
  // effect: the revealed password must be gone from this component's state
  // before the very next paint, not one cascading render later.
  const [prevUnlocked, setPrevUnlocked] = useState(safeboxUnlocked);
  if (safeboxUnlocked !== prevUnlocked) {
    setPrevUnlocked(safeboxUnlocked);
    if (!safeboxUnlocked) {
      setRevealed(null);
      setFormOpen(false);
      setHistoryRoot(null);
      setRestoreTarget(null);
    }
  }

  if (seedReset) {
    return (
      <div className="safebox-section">
        <SafeboxSeedReset onDone={() => setSeedReset(false)} onCancel={() => setSeedReset(false)} />
      </div>
    );
  }

  if (!safeboxPinConfigured) {
    return (
      <div className="safebox-section">
        <SafeboxActivation
          dataPresent={safeboxDataPresent}
          entryCount={safeboxEntryCount}
          syncInactive={!syncActive}
        />
      </div>
    );
  }

  if (!safeboxUnlocked) {
    return (
      <div className="safebox-section">
        <SafeboxPinPad onRequestSeedReset={() => setSeedReset(true)} />
      </div>
    );
  }

  const historyChain = historyRoot ? safeboxChains.find(c => c.root === historyRoot) ?? null : null;
  const formChain = formRoot ? safeboxChains.find(c => c.root === formRoot) ?? null : null;

  async function withFeedback(action: () => Promise<void>) {
    try {
      await action();
    } catch (err) {
      setToast({ kind: 'err', text: err instanceof Error ? err.message : 'Действие не выполнено.' });
    }
  }

  async function handleReveal(entryId: string) {
    await withFeedback(async () => {
      setRevealed({ id: entryId, value: await revealSafeboxSecret(entryId) });
    });
  }

  async function handleCopy(entryId: string) {
    await withFeedback(async () => {
      const ok = await copySafeboxPassword(entryId);
      setToast(ok
        ? { kind: 'ok', text: 'Пароль скопирован. Буфер будет очищен при возврате во вкладку (~60 с).' }
        : { kind: 'err', text: 'Не удалось скопировать пароль.' });
    });
  }

  async function handleCopyLogin(login: string) {
    const ok = await navigator.clipboard.writeText(login).then(() => true).catch(() => false);
    setToast(ok
      ? { kind: 'ok', text: 'Логин скопирован' }
      : { kind: 'err', text: 'Не удалось скопировать логин' });
  }

  return (
    <div className="safebox-section" onPointerDown={touchSafebox} onKeyDown={touchSafebox}>
      {/* Три конкурирующих веса стояли в один ряд: заголовок, заливная «+ Запись»
          и «🔒 Закрыть сейф», который на 360px переносился в две строки. По
          мокапу состояние — это чип, выход — мелкая контурная кнопка, а
          создание записи уехало на круглую «+» внизу, как в заметках. */}
      <div className="safebox-topbar">
        <h2 className="section-title" tabIndex={-1}>Сейф</h2>
        <span className="section-chip section-chip--open">Открыт</span>
        <button className="btn-tiny" onClick={lockSafebox}>Запереть</button>
      </div>


      {!syncActive && (
        <div className="offline-banner" role="status">
          «Вечное хранилище» неактивно — записи сейфа хранятся только на этом
          устройстве и не восстановятся по seed-фразе.
        </div>
      )}

      <div className="search-bar">
        <input
          type="text"
          placeholder="Поиск по сейфу (название, логин, URL, заметка)"
          value={safeboxSearchQuery}
          onChange={e => setSafeboxSearchQuery(e.target.value)}
          aria-label="Поиск по сейфу"
        />
        {safeboxSearchQuery && (
          <span className="search-count">{filteredSafeboxChains.length} из {safeboxChains.length}</span>
        )}
      </div>

      <div className="safebox-list">
        {filteredSafeboxChains.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔐</div>
            <p>{safeboxChains.length === 0 ? 'В сейфе пока пусто.' : 'Ничего не найдено.'}</p>
          </div>
        ) : filteredSafeboxChains.map(chain => {
          const entry = chain.current;
          const info = syncStatuses[entry.id] ?? { status: 'queued' as const };
          const badge = badgeFor(info, syncActive);
          return (
            <div className="note-card safebox-card" key={chain.root}>
              <div className="safebox-card-head">
                <strong className="safebox-card-title">{entry.title}</strong>
                {chain.versions.length > 1 && (
                  <span className="note-rev-badge" aria-label={`Версий: ${chain.versions.length}`}>
                    v{chain.versions.length}
                  </span>
                )}
                <span className={`sync-badge ${badge.className}`} title={badge.label} role="status" aria-label={badge.label}>
                  {badge.icon}
                </span>
              </div>
              {entry.login && <div className="safebox-card-login">{entry.login}</div>}
              {entry.url && <div className="safebox-card-url">{entry.url}</div>}

              {/* Мелкие контурные токены вместо кнопок с эмодзи. Эмодзи здесь
                  были единственным цветным элементом на монохромном экране и
                  рисовались платформенным шрифтом — рядом с SVG-штрихом всего
                  остального интерфейса это читалось как два разных языка. */}
              <div className="safebox-card-actions">
                <button className="btn-tiny" onClick={() => void handleCopy(entry.id)}>
                  Копировать пароль
                </button>
                {entry.login && (
                  <button className="btn-tiny" onClick={() => void handleCopyLogin(entry.login)}>
                    Логин
                  </button>
                )}
                <button className="btn-tiny" onClick={() => void handleReveal(entry.id)}>
                  Показать
                </button>
                {SAFEBOX_WRITER_ENABLED && (
                  <button className="btn-tiny" onClick={() => { setFormRoot(chain.root); setFormOpen(true); }}>
                    Изменить
                  </button>
                )}
                {chain.versions.length > 1 && (
                  <button
                    className="btn-tiny"
                    onClick={() => { setHistoryFocusId(null); setHistoryRoot(chain.root); }}
                  >
                    История ({chain.versions.length})
                  </button>
                )}
              </div>

              {revealed?.id === entry.id && (
                <div className="safebox-revealed" role="status">
                  <code>{revealed.value}</code>
                  <span className="settings-hint"> (скроется автоматически)</span>
                </div>
              )}

              {entry.files.length > 0 && (
                <div className="safebox-card-files">
                  {entry.files.map(f => (
                    <button
                      key={f.fid}
                      className="btn btn-ghost"
                      onClick={() => void withFeedback(() => downloadSafeboxAttachment(entry.id, f.fid))}
                    >
                      📎 {f.name} ({f.size} Б)
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {SAFEBOX_WRITER_ENABLED && (
        <Fab label="Новая запись" onClick={() => { setFormRoot(null); setFormOpen(true); }} />
      )}

      {toast && (
        <div className={`toast ${toast.kind === 'ok' ? 'toast--success' : 'toast--error'}`} role="status">
          {toast.text}
        </div>
      )}

      <SafeboxEntryForm
        open={formOpen}
        current={formChain?.current ?? null}
        busy={isEncrypting}
        onClose={() => { setFormOpen(false); setFormRoot(null); }}
        onCreate={(entry: SafeboxNewEntry) => addSafeboxEntry(entry)}
        onSave={(patch: SafeboxEntryPatch) => editSafeboxEntry(formRoot!, patch)}
      />

      <SafeboxHistoryModal
        open={historyChain !== null && restoreTarget === null}
        chain={historyChain}
        syncStatuses={syncStatuses}
        syncActive={syncActive}
        canRestore={SAFEBOX_WRITER_ENABLED}
        onClose={() => { setHistoryRoot(null); setHistoryFocusId(null); }}
        onRequestRestore={version => {
          if (!historyRoot) return;
          // Modal-stack discipline: history closes BEFORE the confirm opens.
          setRestoreTarget({ root: historyRoot, version });
          setHistoryRoot(null);
        }}
        onRevealVersion={revealSafeboxSecret}
        focusVersionId={historyFocusId}
        formatDate={formatDate}
      />

      <SafeboxRestoreDialog
        open={restoreTarget !== null}
        version={restoreTarget?.version ?? null}
        onConfirm={async () => {
          if (!restoreTarget) return;
          await restoreSafeboxVersion(restoreTarget.root, restoreTarget.version.id);
          setRestoreTarget(null);
          setHistoryFocusId(null);
        }}
        onCancel={() => {
          if (!restoreTarget) return;
          setHistoryFocusId(restoreTarget.version.id);
          setHistoryRoot(restoreTarget.root);
          setRestoreTarget(null);
        }}
      />
    </div>
  );
}
