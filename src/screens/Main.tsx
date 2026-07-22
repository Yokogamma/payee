import { useState, useRef, useEffect } from 'react';
import { useNotes, type NoteSyncStatus } from '../lib/store';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SettingsModal } from '../components/SettingsModal';
import { useTheme } from '../lib/theme';
import { copyTextToClipboard } from '../lib/clipboard';

// Draft survives an accidental tab close / PWA eviction (same lifetime model as
// the session seed: sessionStorage, never persisted to disk unencrypted forever).
const DRAFT_KEY = 'eternal-notes-draft';

const SYNC_BADGE: Record<NoteSyncStatus, { icon: string; label: string; className: string }> = {
  queued:    { icon: '○',  label: 'Ожидает загрузки',            className: 'sync-badge--queued' },
  uploading: { icon: '⏳', label: 'Загружается...',              className: 'sync-badge--uploading' },
  accepted:  { icon: '⏳', label: 'Ожидает подтверждения в сети', className: 'sync-badge--accepted' },
  confirmed: { icon: '✓',  label: 'Сохранена в блокчейне',       className: 'sync-badge--confirmed' },
  error:     { icon: '⚠️', label: 'Ошибка загрузки — повторить', className: 'sync-badge--error' },
};

export function Main() {
  const {
    filteredNotes,
    isEncrypting,
    searchQuery,
    addNote,
    setSearchQuery,
    resetApp,
    notes,
    arweave,
    retrySync,
    restoring,
    restoreProgress,
    restoreError,
    restoredCount,
    retryRestore,
    clearRestoreStatus,
    syncStatuses,
    dismissError,
  } = useNotes();

  const [text, setText] = useState(() => sessionStorage.getItem(DRAFT_KEY) ?? '');
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<'ok' | 'fail' | null>(null);
  const [theme, setTheme] = useTheme();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Global search hotkey (8.1): Ctrl/Cmd+K toggles the search bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (showSearch) closeSearch();
        else setShowSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSearch]);

  // Mirror the draft to sessionStorage (debounced) so it survives a reload.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text) sessionStorage.setItem(DRAFT_KEY, text);
      else sessionStorage.removeItem(DRAFT_KEY);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);

  async function handleSave() {
    if (!text.trim() || isEncrypting) return;
    setSaveError('');
    try {
      await addNote(text);
    } catch (err) {
      // Persistence failed (quota/broken DB) — the note is still in the input,
      // never let it silently vanish.
      console.error('save failed:', err);
      setSaveError('Не удалось сохранить заметку. Попробуйте ещё раз.');
      return;
    }
    setText('');
    sessionStorage.removeItem(DRAFT_KEY); // don't wait out the debounce
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Ctrl/Cmd+Enter to save
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }

  function formatDate(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();

    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;

    const isThisYear = d.getFullYear() === now.getFullYear();
    const day = d.getDate().toString().padStart(2, '0');
    const month = d.toLocaleString('ru', { month: 'short' });

    if (isThisYear) return `${day} ${month}`;
    return `${day} ${month} ${d.getFullYear()}`;
  }

  function closeSearch() {
    setShowSearch(false);
    setSearchQuery('');
  }

  /** Clipboard write with visible success/error feedback — a rejected promise
   *  must not look identical to a successful copy. On failure the menu stays
   *  open so the text can still be selected manually. */
  async function handleCopyNote(noteText: string) {
    if (await copyTextToClipboard(noteText)) {
      setOpenMenuId(null);
      setCopyFeedback('ok');
    } else {
      setCopyFeedback('fail');
    }
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  /** Wrap query matches in <mark> (8.1) — case-insensitive, plain text only. */
  function highlight(noteText: string, query: string): React.ReactNode {
    const q = query.trim();
    if (!q) return noteText;
    const lower = noteText.toLowerCase();
    const ql = q.toLowerCase();
    const parts: React.ReactNode[] = [];
    let i = 0;
    let idx: number;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) parts.push(noteText.slice(i, idx));
      parts.push(<mark key={idx}>{noteText.slice(idx, idx + q.length)}</mark>);
      i = idx + q.length;
    }
    parts.push(noteText.slice(i));
    return parts;
  }

  return (
    <div className="main-screen">
      {/* Restoring Banner */}
      {restoring && (
        <div className="restoring-banner" role="status" aria-live="polite">
          ⏳ Восстанавливаем заметки из Arweave...
          {restoreProgress && restoreProgress.total > 0 && ` ${restoreProgress.done}/${restoreProgress.total}`}
        </div>
      )}

      {/* Restore failed / partial (M1): distinguish "error" from "nothing to restore" */}
      {!restoring && restoreError && (
        <div className="error-banner" role="alert">
          <span>⚠️ {restoreError}</span>
          <button className="banner-btn" onClick={retryRestore}>Повторить</button>
          <button className="banner-btn banner-close" onClick={clearRestoreStatus} title="Скрыть">✕</button>
        </div>
      )}

      {/* Restore succeeded — show what actually came back */}
      {!restoring && !restoreError && restoredCount !== null && restoredCount > 0 && (
        <div className="success-banner" role="status">
          <span>✓ Восстановлено заметок: {restoredCount}</span>
          <button className="banner-btn banner-close" onClick={clearRestoreStatus} title="Скрыть">✕</button>
        </div>
      )}

      {/* Offline Banner */}
      {arweave.enabled && !arweave.online && (
        <div className="offline-banner">
          Оффлайн — заметки сохраняются локально
        </div>
      )}

      {/* Header */}
      <header className="main-header">
        <div className="header-left">
          <span className="logo-small">∞</span>
          <span className="app-title">Eternal Notes</span>
          <span className="note-count">{notes.length}</span>
          {arweave.enabled && (
            <span
              className={`ar-badge ${arweave.online ? 'text-green' : 'text-red'}`}
              title={arweave.online ? 'Arweave: онлайн' : 'Arweave: оффлайн'}
              role="status"
              aria-label={arweave.syncing ? 'Arweave: синхронизация' : arweave.online ? 'Arweave: онлайн' : 'Arweave: оффлайн'}
            >
              {arweave.syncing ? '⏳' : arweave.online ? '♾️' : '⚠️'}
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            className={`icon-btn ${showSearch ? 'icon-btn--active' : ''}`}
            onClick={() => { if (showSearch) closeSearch(); else setShowSearch(true); }}
            title="Поиск (Ctrl+K)"
            aria-label="Поиск"
            aria-pressed={showSearch}
            aria-keyshortcuts="Control+K"
          >
            🔍
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            title="Настройки"
            aria-label="Настройки"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* Search */}
      {showSearch && (
        <div className="search-bar">
          <input
            type="text"
            placeholder="Найти заметку..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
            autoFocus
          />
          {searchQuery && (
            <>
              <span className="search-count">
                {filteredNotes.length} из {notes.length}
              </span>
              <button className="search-clear" onClick={() => setSearchQuery('')} title="Очистить" aria-label="Очистить поиск">
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {/* Input */}
      <div className="note-input-wrap">
        <textarea
          ref={inputRef}
          className="note-input"
          placeholder="Быстрая заметка..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={Math.min(text.split('\n').length + 1, 8)}
        />
        {saveError && <div className="error-msg">{saveError}</div>}
        <div className="input-footer">
          <span className="input-hint">
            {justSaved
              ? '✓ Сохранено и зашифровано'
              : <span className="kbd-hint">Ctrl+Enter — сохранить</span>}
          </span>
          <button
            className="btn btn-save"
            onClick={handleSave}
            disabled={!text.trim() || isEncrypting}
          >
            {isEncrypting ? '🔐...' : '🔐 Сохранить'}
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="notes-feed">
        {filteredNotes.length === 0 && !searchQuery ? (
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <p>Первая заметка — самая важная.</p>
            <p className="empty-sub">Просто начните печатать.</p>
          </div>
        ) : filteredNotes.length === 0 && searchQuery ? (
          <div className="empty-state">
            <p>Ничего не найдено по «{searchQuery}»</p>
          </div>
        ) : (
          filteredNotes.map(note => {
            // Sync info is derived UNCONDITIONALLY — a confirmed TX stays
            // linkable from the menu even with auto-sync switched off; the
            // enabled flag gates only the live status badge.
            const info = syncStatuses[note.id] ?? { status: 'queued' as const };
            const badge = arweave.enabled ? SYNC_BADGE[info.status] : null;
            return (
              <div className="note-card" key={note.id + note.createdAt}>
                <div className="note-text">{highlight(note.text, searchQuery)}</div>
                <div className="note-meta">
                  <span className="note-time">{formatDate(note.createdAt)}</span>
                  {badge && info && (
                    info.status === 'error' ? (
                      <button
                        className={`sync-badge ${badge.className}`}
                        onClick={retrySync}
                        title={badge.label}
                        aria-label={badge.label}
                      >
                        {badge.icon} повторить
                      </button>
                    ) : (
                      <span
                        className={`sync-badge ${badge.className}`}
                        title={badge.label}
                        role="status"
                        aria-label={badge.label}
                      >
                        {badge.icon}
                      </span>
                    )
                  )}
                  <span className="note-lock" aria-hidden="true">🔒</span>
                  <button
                    className="icon-btn note-menu-btn"
                    onClick={() => setOpenMenuId(openMenuId === note.id ? null : note.id)}
                    title="Меню заметки"
                    aria-label="Меню заметки"
                    aria-expanded={openMenuId === note.id}
                  >
                    ⋯
                  </button>
                </div>
                {openMenuId === note.id && (
                  <div className="note-menu">
                    <button
                      className="note-menu-item"
                      onClick={() => void handleCopyNote(note.text)}
                    >
                      📋 Копировать текст
                    </button>
                    {info?.status === 'confirmed' && info.txId && (
                      <a
                        className="note-menu-item"
                        href={`https://viewblock.io/arweave/tx/${info.txId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpenMenuId(null)}
                      >
                        🔗 Транзакция в блокчейне
                      </a>
                    )}
                    <div className="note-menu-hint">
                      Опубликованная в блокчейне копия неизменяема: её нельзя
                      отредактировать или удалить.
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Prominent save confirmation (2.5) */}
      {justSaved && (
        <div className="toast toast--success" role="status">
          ✓ Сохранено и зашифровано
        </div>
      )}

      {/* Clipboard feedback — success and failure must look different */}
      {copyFeedback === 'ok' && (
        <div className="toast toast--success" role="status">✓ Скопировано</div>
      )}
      {copyFeedback === 'fail' && (
        <div className="toast toast--error" role="alert">
          Не удалось скопировать — выделите текст вручную
        </div>
      )}

      {/* Global sync-error toast (visible outside the settings modal) */}
      {arweave.enabled && arweave.lastError && !showSettings && (
        <div className="toast toast--error" role="alert">
          <span>⚠️ {arweave.lastError}</span>
          <button className="banner-btn" onClick={retrySync} disabled={arweave.syncing}>
            {arweave.syncing ? '...' : 'Повторить'}
          </button>
          <button className="banner-btn banner-close" onClick={dismissError} title="Скрыть">✕</button>
        </div>
      )}

      {/* Settings Modal (extracted — 7.3) */}
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        theme={theme}
        onThemeChange={setTheme}
        onRequestReset={() => {
          // Never two aria-modal dialogs at once: their Escape handlers and
          // focus traps would compete. Settings closes before the confirm opens.
          setShowSettings(false);
          setShowResetConfirm(true);
        }}
      />

      <ConfirmDialog
        open={showResetConfirm}
        title="Сбросить приложение?"
        message={arweave.unsyncedCount > 0
          ? `⚠️ ${arweave.unsyncedCount} заметок ещё НЕ синхронизированы и будут потеряны безвозвратно.\nЗаметки, сохранённые в блокчейне, можно вернуть по seed-фразе.`
          : 'Все локальные данные будут удалены. Заметки, сохранённые в блокчейне, можно вернуть по seed-фразе.'}
        confirmLabel="Удалить всё"
        danger
        onConfirm={() => { setShowResetConfirm(false); resetApp(); }}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  );
}
