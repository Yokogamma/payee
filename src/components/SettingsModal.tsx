import { useEffect, useState } from 'react';
import { useNotes } from '../lib/store';
import type { ThemePref } from '../lib/theme';
import { useModalA11y } from '../lib/useModalA11y';

/** Settings modal (7.3/L8) — extracted from the 500-line Main screen.
 *  Local UI state (seed reveal, PIN form, invite form) lives here; the reset
 *  confirmation dialog stays in Main (it must outlive the modal). */
interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
  onRequestReset: () => void;
}

const THEME_LABELS: Record<ThemePref, string> = {
  system: 'Системная',
  dark: 'Тёмная',
  light: 'Светлая',
};

export function SettingsModal({ open, onClose, theme, onThemeChange, onRequestReset }: SettingsModalProps) {
  const {
    notes,
    arweave,
    toggleArweave,
    retrySync,
    registerWithInvite,
    checkAccess,
    hasPin,
    setupPin,
    removePin,
    showMnemonic,
  } = useNotes();

  const [showSeed, setShowSeed] = useState(false);

  function close() {
    setShowSeed(false);
    onClose();
  }

  // Phase 7: Escape closes, Tab trapped inside, focus returned to the trigger.
  const containerRef = useModalA11y<HTMLDivElement>(open, close);
  useEffect(() => {
    if (open) containerRef.current?.focus();
    // The revealed seed must NEVER survive a close, however the modal was
    // closed — incl. the reset flow, where Main flips `open` directly and the
    // internal close() is bypassed (round-13 finding: Settings → показать seed
    // → Reset → отмена → Settings снова показывал фразу без запроса).
    else setShowSeed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const mnemonic = showSeed ? showMnemonic() : null;

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        ref={containerRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
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
                На время сессии фраза хранится в памяти вкладки (sessionStorage) и
                очищается при закрытии браузера.
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

        <PinSection hasPin={hasPin} setupPin={setupPin} removePin={removePin} />

        <div className="settings-section">
          <div className="theme-picker" role="group" aria-label="Тема оформления">
            {(Object.keys(THEME_LABELS) as ThemePref[]).map(t => (
              <button
                key={t}
                className={`theme-option ${theme === t ? 'theme-option--active' : ''}`}
                onClick={() => onThemeChange(t)}
                aria-pressed={theme === t}
              >
                {THEME_LABELS[t]}
              </button>
            ))}
          </div>
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
            <div>Статус: <strong className={arweave.online ? 'text-green' : 'text-red'}>
              {arweave.online ? '● Онлайн' : '○ Оффлайн'}
            </strong></div>
            <div>Синхронизировано: <strong>{arweave.acceptedCount + arweave.confirmedCount}</strong> из <strong>{notes.length}</strong></div>
            {arweave.confirmedCount > 0 && (
              <div className="text-green">✓ Подтверждено в блокчейне: <strong>{arweave.confirmedCount}</strong></div>
            )}
            {arweave.acceptedCount > 0 && (
              <div>⏳ Ожидают подтверждения: <strong>{arweave.acceptedCount}</strong></div>
            )}
            {arweave.unsyncedCount > 0 && (
              <div>⏳ Ожидают загрузки: <strong>{arweave.unsyncedCount}</strong></div>
            )}
            {arweave.errorCount > 0 && (
              <div className="text-red">⚠️ Ошибки: <strong>{arweave.errorCount}</strong></div>
            )}
            {arweave.lastSync && (
              <div>Последняя синхронизация: {new Date(arweave.lastSync).toLocaleString('ru')}</div>
            )}
          </div>

          {arweave.lastError && (
            <div className="error-msg">{arweave.lastError}</div>
          )}

          {arweave.enabled && (arweave.unsyncedCount > 0 || arweave.lastError) && (
            <button
              className="btn btn-outline full-width"
              onClick={retrySync}
              disabled={arweave.syncing}
            >
              {arweave.syncing ? '⏳ Загрузка...' : '↻ Повторить загрузку'}
            </button>
          )}

          {!arweave.registered && (
            <InviteSection registerWithInvite={registerWithInvite} checkAccess={checkAccess} />
          )}

          {arweave.registered && (
            <div className="settings-info">
              <div className="text-green">✓ Синхронизация доступна</div>
            </div>
          )}
        </div>

        <div className="settings-section">
          <button className="btn btn-danger full-width" onClick={onRequestReset}>
            Сбросить приложение
          </button>
        </div>

        <button className="btn btn-ghost full-width" onClick={close}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

function PinSection({ hasPin, setupPin, removePin }: {
  hasPin: boolean;
  setupPin: (pin: string) => Promise<void>;
  removePin: () => Promise<void>;
}) {
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [showPinSetup, setShowPinSetup] = useState(false);

  async function handleSetupPin() {
    if (pinInput.length < 6) { setPinError('Минимум 6 цифр'); return; }
    if (pinInput !== pinConfirm) { setPinError('PIN-коды не совпадают'); return; }
    try {
      await setupPin(pinInput);
    } catch (err) {
      // Keep the form open — closing it would imply the PIN was set.
      console.error('setupPin failed:', err);
      setPinError('Не удалось установить PIN. Попробуйте ещё раз.');
      return;
    }
    setPinInput(''); setPinConfirm(''); setPinError(''); setShowPinSetup(false);
  }

  async function handleRemovePin() {
    try {
      await removePin();
    } catch (err) {
      console.error('removePin failed:', err);
      setPinError('Не удалось удалить PIN. Попробуйте ещё раз.');
      return;
    }
    setPinError('');
    setShowPinSetup(false);
  }

  return (
    <div className="settings-section">
      <div className="seed-warning info">
        PIN — быстрый вход на этом устройстве. Мастер-ключ — seed-фраза:
        при физическом доступе к разблокированному устройству PIN не
        заменяет её надёжное хранение. После 10 неверных попыток PIN
        удаляется, вход — только по seed-фразе.
      </div>
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
              placeholder="PIN (мин. 6 цифр)"
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
        <>
          {pinError && <div className="error-msg">{pinError}</div>}
          <button className="btn btn-outline full-width" onClick={handleRemovePin}>
            Удалить PIN-код
          </button>
        </>
      )}
    </div>
  );
}

function InviteSection({ registerWithInvite, checkAccess }: {
  registerWithInvite: (code: string) => Promise<void>;
  checkAccess: () => Promise<void>;
}) {
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);

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

  return (
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
  );
}
