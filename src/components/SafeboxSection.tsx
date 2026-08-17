import { useEffect, useState } from 'react';
import { useNotes } from '../lib/store';
import { SAFEBOX_WRITER_ENABLED } from '../lib/flags';
import { badgeFor } from './syncBadge';
import { CardMenu } from './CardMenu';
import { IconCopy, IconEdit, IconHistory, IconLock, IconDownload, IconVault, InfinityMark } from './icons';
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

/* No props. It used to take `formatDate` — a closure defined in Main and
   threaded down through here into the history modal, so that three components
   could call one pure function of a timestamp. It lives in lib/format-date
   now and each caller imports it. */
export function SafeboxSection() {
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
    retrySync,
    syncStatuses,
    arweave,
    isEncrypting,
  } = useNotes();

  const [seedReset, setSeedReset] = useState(false);
  const [formRoot, setFormRoot] = useState<string | null>(null);   // null + formOpen = create
  const [formOpen, setFormOpen] = useState(false);
  const [historyRoot, setHistoryRoot] = useState<string | null>(null);
  const [historyFocusId, setHistoryFocusId] = useState<string | null>(null);
  // Одно открытое меню на раздел: правило принадлежит секции, потому что
  // только она видит остальные карточки.
  const [openMenuRoot, setOpenMenuRoot] = useState<string | null>(null);
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
      setOpenMenuRoot(null);
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
      {/* Состояние — ТЕКСТ, выход — КНОПКА. Прежний чип был обведённой
          капсулой, то есть выглядел ровно как то, на что нажимают, а нажать на
          него было нельзя; рядом стояла «Запереть» контурной кнопкой того же
          веса. Два одинаковых по виду элемента, из которых работает один, —
          это и есть правило «кнопка vs информация», нарушенное в одной
          строке. */}
      <div className="safebox-topbar">
        <h2 className="section-title" tabIndex={-1}>Сейф</h2>
        <span className="state state--quiet" role="status">
          <span className="state-dot" aria-hidden="true" />
          открыт
        </span>
        <button className="btn btn-outline safebox-lock-btn" onClick={lockSafebox}>
          <IconLock />
          Запереть
        </button>
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
          placeholder="Поиск по сейфу"
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
            <div className="empty-icon"><IconVault /></div>
            <p>{safeboxChains.length === 0 ? 'В сейфе пока пусто.' : 'Ничего не найдено.'}</p>
          </div>
        ) : filteredSafeboxChains.map(chain => {
          const entry = chain.current;
          const info = syncStatuses[entry.id] ?? { status: 'queued' as const };
          const badge = badgeFor(info, syncActive);
          return (
            <div className="note-card safebox-card" key={chain.root}>
              {/* Название и логин НА ОДНОЙ строке, статус — у правого края.
                  Логин стоял отдельной строкой под заголовком, и запись
                  занимала три строки там, где по макету занимает одну. */}
              <div className="safebox-card-head">
                <strong className="safebox-card-title">{entry.title}</strong>
                {entry.login && <span className="safebox-card-login">{entry.login}</span>}
                {chain.versions.length > 1 && (
                  <span className="state state--quiet">{chain.versions.length}-я версия</span>
                )}
                <span className="note-meta-gap" />
                {/* Ошибка — единственный статус, на который можно нажать, и в
                    сейфе она этого не предлагала: строка говорила «ошибка» и
                    оставляла пользователя без действия, тогда как в ленте
                    ровно то же состояние — кнопка «повторить». Один и тот же
                    syncBadge на двух списках должен давать и одинаковые
                    возможности, а не только одинаковые слова. */}
                {info.status === 'error' && syncActive ? (
                  <button
                    className={`state sync-state ${badge.className}`}
                    onClick={retrySync}
                    title={badge.label}
                    aria-label={badge.label}
                  >
                    {badge.word} · повторить
                  </button>
                ) : (
                  <span className={`state sync-state ${badge.className}`} title={badge.label} role="status" aria-label={badge.label}>
                    {badge.permanent && <InfinityMark />}
                    {badge.word}
                  </span>
                )}
              </div>
              {entry.url && <div className="safebox-card-url">{entry.url}</div>}

              {/* TWO buttons, and the rest behind ⋯.
                  Five outline tokens in a row gave «скопировать пароль» — the
                  thing done every single time — the same weight as «история
                  версий», and on 360px they wrapped onto three lines. What
                  stays out is what the row is FOR: copy the password, look at
                  it. Everything else is occasional and lives in the menu. */}
              <div className="safebox-card-actions">
                <button className="btn btn-primary safebox-action" onClick={() => void handleCopy(entry.id)}>
                  <IconCopy />
                  Пароль
                </button>
                <button className="btn btn-outline safebox-action" onClick={() => void handleReveal(entry.id)}>
                  Показать
                </button>
                <span className="note-meta-gap" />
                <CardMenu
                  open={openMenuRoot === chain.root}
                  onOpenChange={(next, reason) => {
                    setOpenMenuRoot(next ? chain.root : null);
                    if (!next && reason === 'escape') return; // CardMenu already restored focus
                  }}
                  label={`Меню записи «${entry.title}»`}
                  id={`safebox-menu-${chain.root}`}
                  items={[
                    ...(entry.login
                      ? [{
                          key: 'login',
                          icon: <IconCopy />,
                          label: 'Копировать логин',
                          onSelect: () => void handleCopyLogin(entry.login),
                        }]
                      : []),
                    ...(SAFEBOX_WRITER_ENABLED
                      ? [{
                          key: 'edit',
                          icon: <IconEdit />,
                          label: 'Изменить',
                          onSelect: () => { setFormRoot(chain.root); setFormOpen(true); },
                        }]
                      : []),
                    ...(chain.versions.length > 1
                      ? [{
                          key: 'history',
                          icon: <IconHistory />,
                          label: `История версий (${chain.versions.length})`,
                          onSelect: () => { setHistoryFocusId(null); setHistoryRoot(chain.root); },
                        }]
                      : []),
                    // The attachment list is variable-length and belongs here
                    // for the same reason as the rest: it is per-entry data,
                    // not a per-row action.
                    ...entry.files.map(f => ({
                      key: `file-${f.fid}`,
                      icon: <IconDownload />,
                      label: `${f.name} (${f.size} Б)`,
                      onSelect: () => void withFeedback(() => downloadSafeboxAttachment(entry.id, f.fid)),
                    })),
                  ]}
                />
              </div>

              {revealed?.id === entry.id && (
                <div className="safebox-revealed" role="status">
                  <code>{revealed.value}</code>
                  <span className="settings-hint"> (скроется автоматически)</span>
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
