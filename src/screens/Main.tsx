import { useState, useRef, useEffect } from 'react';
import { useNotes } from '../lib/store';

export function Main() {
  const {
    filteredNotes,
    isEncrypting,
    searchQuery,
    addNote,
    setSearchQuery,
    showMnemonic,
    resetApp,
    notes,
    arweave,
    toggleArweave,
    retrySync,
    restoring,
    registerWithInvite,
    checkAccess,
    hasPin,
    setupPin,
    removePin,
  } = useNotes();

  const [text, setText] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark';
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSave() {
    if (!text.trim() || isEncrypting) return;
    await addNote(text);
    setText('');
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Ctrl/Cmd+Enter to save
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }

  async function handleInvite() {
    if (!inviteCode.trim()) return;
    setInviteLoading(true);
    setInviteError('');
    try {
      await registerWithInvite(inviteCode.trim());
      setInviteCode('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Ошибка регистрации');
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleCheckAccess() {
    setCheckingAccess(true);
    try {
      await checkAccess();
    } finally {
      setCheckingAccess(false);
    }
  }

  async function handleSetupPin() {
    if (pinInput.length < 4) { setPinError('Минимум 4 цифры'); return; }
    if (pinInput !== pinConfirm) { setPinError('PIN-коды не совпадают'); return; }
    await setupPin(pinInput);
    setPinInput(''); setPinConfirm(''); setPinError(''); setShowPinSetup(false);
  }

  async function handleRemovePin() {
    await removePin();
    setShowPinSetup(false);
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

  const mnemonic = showSeed ? showMnemonic() : null;

  return (
    <div className="main-screen">
      {/* Restoring Banner */}
      {restoring && (
        <div className="restoring-banner">
          ⏳ Восстанавливаем заметки из Arweave...
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
              className="ar-badge"
              title={arweave.online ? 'Arweave: онлайн' : 'Arweave: оффлайн'}
              style={{color: arweave.online ? '#2dd4a8' : '#f05365'}}
            >
              {arweave.syncing ? '⏳' : arweave.online ? '♾️' : '⚠️'}
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            className="icon-btn"
            onClick={() => { setShowSearch(!showSearch); setSearchQuery(''); }}
            title="Поиск"
          >
            🔍
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Настройки"
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
            autoFocus
          />
          {searchQuery && (
            <span className="search-count">
              {filteredNotes.length} из {notes.length}
            </span>
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
        <div className="input-footer">
          <span className="input-hint">
            {justSaved ? '✓ Сохранено и зашифровано' : 'Ctrl+Enter — сохранить'}
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
          filteredNotes.map(note => (
            <div className="note-card" key={note.id + note.createdAt}>
              <div className="note-text">{note.text}</div>
              <div className="note-meta">
                <span className="note-time">{formatDate(note.createdAt)}</span>
                <span className="note-lock">🔒</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => { setShowSettings(false); setShowSeed(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Настройки</h2>

            <div className="settings-section">
              <button
                className="btn btn-outline full-width"
                onClick={() => setShowSeed(!showSeed)}
              >
                {showSeed ? 'Скрыть seed-фразу' : 'Показать seed-фразу'}
              </button>

              {mnemonic && (
                <div className="seed-reveal">
                  <div className="seed-warning">
                    ⚠️ Никому не показывайте! Кто знает фразу — имеет доступ ко всем заметкам.
                  </div>
                  <div className="seed-grid compact">
                    {mnemonic.split(' ').map((word, i) => (
                      <div className="seed-word" key={i}>
                        <span className="seed-num">{i + 1}</span>
                        <span className="seed-text">{word}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="settings-section">
              <div className="settings-info">
                <div>📝 Заметок: <strong>{notes.length}</strong></div>
                <div>🔐 Шифрование: <strong>AES-256-GCM</strong></div>
                <div>🔑 PIN-код: <strong>{hasPin ? 'установлен' : 'не установлен'}</strong></div>
              </div>
            </div>

            {/* PIN Section */}
            <div className="settings-section">
              {!hasPin ? (
                !showPinSetup ? (
                  <button
                    className="btn btn-outline full-width"
                    onClick={() => setShowPinSetup(true)}
                  >
                    Установить PIN-код
                  </button>
                ) : (
                  <div className="pin-setup">
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className="pin-input"
                      placeholder="PIN (мин. 4 цифры)"
                      value={pinInput}
                      maxLength={8}
                      onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }}
                    />
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className="pin-input"
                      placeholder="Повторите PIN"
                      value={pinConfirm}
                      maxLength={8}
                      onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, '')); setPinError(''); }}
                    />
                    {pinError && <div className="error-msg">{pinError}</div>}
                    <button className="btn btn-primary full-width" onClick={handleSetupPin}>
                      Сохранить PIN
                    </button>
                    <button className="btn btn-ghost full-width" onClick={() => { setShowPinSetup(false); setPinError(''); }}>
                      Отмена
                    </button>
                  </div>
                )
              ) : (
                <button className="btn btn-outline full-width" onClick={handleRemovePin}>
                  Удалить PIN-код
                </button>
              )}
            </div>

            <div className="settings-section">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={theme === 'light'}
                  onChange={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                />
                <span>Светлая тема</span>
              </label>
            </div>

            {/* Arweave Section */}
            <div className="settings-section">
              <h3 className="settings-heading">♾️ Вечное хранилище (Arweave)</h3>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={arweave.enabled}
                  onChange={toggleArweave}
                />
                <span>Автоматическая синхронизация</span>
              </label>

              <div className="settings-info">
                <div>Статус: <strong style={{color: arweave.online ? '#2dd4a8' : '#f05365'}}>
                  {arweave.online ? '● Онлайн' : '○ Оффлайн'}
                </strong></div>
                <div>Синхронизировано: <strong>{arweave.acceptedCount + arweave.confirmedCount}</strong> из <strong>{notes.length}</strong></div>
                {arweave.confirmedCount > 0 && (
                  <div style={{color: 'var(--green)'}}>✓ Подтверждено в блокчейне: <strong>{arweave.confirmedCount}</strong></div>
                )}
                {arweave.acceptedCount > 0 && (
                  <div>⏳ Ожидают подтверждения: <strong>{arweave.acceptedCount}</strong></div>
                )}
                {arweave.unsyncedCount > 0 && (
                  <div>⏳ Ожидают загрузки: <strong>{arweave.unsyncedCount}</strong></div>
                )}
                {arweave.errorCount > 0 && (
                  <div style={{color: 'var(--red)'}}>⚠️ Ошибки: <strong>{arweave.errorCount}</strong></div>
                )}
                {arweave.lastSync && (
                  <div>Последняя синхронизация: {new Date(arweave.lastSync).toLocaleString('ru')}</div>
                )}
              </div>

              {arweave.lastError && (
                <div className="error-msg">{arweave.lastError}</div>
              )}

              {/* Retry button */}
              {arweave.enabled && (arweave.unsyncedCount > 0 || arweave.lastError) && (
                <button
                  className="btn btn-outline full-width"
                  onClick={retrySync}
                  disabled={arweave.syncing}
                >
                  {arweave.syncing ? '⏳ Загрузка...' : '↻ Повторить загрузку'}
                </button>
              )}

              {/* Invite / Registration section */}
              {!arweave.registered && (
                <div className="invite-section">
                  <div className="settings-info">
                    <div>Для синхронизации введите invite code</div>
                  </div>
                  <div className="invite-row">
                    <input
                      type="text"
                      className="invite-input"
                      placeholder="Invite code..."
                      value={inviteCode}
                      onChange={e => { setInviteCode(e.target.value); setInviteError(''); }}
                    />
                    <button
                      className="btn btn-primary invite-btn"
                      onClick={handleInvite}
                      disabled={inviteLoading || !inviteCode.trim()}
                    >
                      {inviteLoading ? '...' : 'Активировать'}
                    </button>
                  </div>
                  {inviteError && <div className="error-msg">{inviteError}</div>}
                  <button
                    className="btn btn-ghost full-width"
                    onClick={handleCheckAccess}
                    disabled={checkingAccess}
                  >
                    {checkingAccess ? 'Проверяю...' : 'Проверить доступ к синхронизации'}
                  </button>
                </div>
              )}

              {arweave.registered && (
                <div className="settings-info">
                  <div style={{color: 'var(--green)'}}>✓ Синхронизация доступна</div>
                </div>
              )}
            </div>

            <div className="settings-section">
              <button className="btn btn-danger full-width" onClick={() => {
                const hasUnsynced = arweave.unsyncedCount > 0;
                const msg = hasUnsynced
                  ? `⚠️ ${arweave.unsyncedCount} заметок НЕ синхронизированы и будут потеряны!\n\nУдалить все локальные данные?`
                  : 'Удалить все локальные данные? Заметки в блокчейне сохранятся.';
                if (confirm(msg)) resetApp();
              }}>
                Сбросить приложение
              </button>
            </div>

            <button
              className="btn btn-ghost full-width"
              onClick={() => { setShowSettings(false); setShowSeed(false); }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
