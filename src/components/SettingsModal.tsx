import { useEffect, useState, type ReactNode } from 'react';
import { useNotes } from '../lib/store';
import type { AutoLockTimeout } from '../lib/auto-lock';
import type { ThemePref } from '../lib/theme';
import { useModalA11y } from '../lib/useModalA11y';

/** Settings modal (7.3/L8) — extracted from the 500-line Main screen.
 *  Reorganised into collapsible blocks (all collapsed by default); each block
 *  header shows a glanceable status chip. Local UI state (seed reveal, PIN form,
 *  invite form) lives here; the reset confirmation dialog stays in Main (it must
 *  outlive the modal). */
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

// ─── Inline SVG icons (self-hosted — the CSP forbids external icon fonts) ───
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const IconKey = () => <Svg><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 19 5" /><path d="m18 6 2 2" /><path d="m15 9 2 2" /></Svg>;
const IconLock = () => <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
const IconInfinity = () => <Svg><path d="M9.828 9.172a4 4 0 1 0 0 5.656 10 10 0 0 0 2.172 -2.828 10 10 0 0 1 2.172 -2.828 4 4 0 1 1 0 5.656 10 10 0 0 1 -2.172 -2.828 10 10 0 0 0 -2.172 -2.828z" /></Svg>;
const IconTheme = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></Svg>;
const IconTrash = () => <Svg><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7V4a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></Svg>;
const IconX = () => <Svg><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
const IconChevron = () => <Svg><path d="m6 9 6 6 6 -6" /></Svg>;
const IconNote = () => <Svg><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h4" /></Svg>;
const IconShield = () => <Svg><path d="M12 3l7 3v5c0 4 -3 7 -7 8 -4 -1 -7 -4 -7 -8V6z" /><circle cx="12" cy="11" r="1.4" /><path d="M12 12.4V15" /></Svg>;

/** One collapsible settings block. Collapsed by default; the header stays a
 *  button so keyboard + the modal focus-trap treat it as one stop. */
function SettingsBlock({ icon, title, chip, chipClass, danger, children }: {
  icon: ReactNode;
  title: string;
  chip?: string;
  chipClass?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`settings-block${danger ? ' settings-block--danger' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="settings-block-header"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="settings-block-icon">{icon}</span>
        <span className="settings-block-title">{title}</span>
        {chip && <span className={`settings-block-chip${chipClass ? ' ' + chipClass : ''}`}>{chip}</span>}
        <span className="settings-block-chev"><IconChevron /></span>
      </button>
      {open && <div className="settings-block-body">{children}</div>}
    </div>
  );
}

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
    autoLockTimeout,
    setAutoLockTimeout,
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

  const arweaveChip = !arweave.enabled
    ? 'выключено'
    : arweave.online ? '● Онлайн' : '○ Оффлайн';
  const arweaveChipClass = arweave.enabled && arweave.online ? 'text-green' : '';

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
        <div className="settings-topbar">
          <h2>Настройки</h2>
          <button type="button" className="settings-close" onClick={close} aria-label="Закрыть настройки">
            <IconX />
          </button>
        </div>

        <div className="settings-statusbar">
          <span><IconNote /> Заметок: <strong>{notes.length}</strong></span>
          <span><IconShield /> AES-256-GCM</span>
        </div>

        <div className="settings-blocks">
          <SettingsBlock icon={<IconKey />} title="Seed-фраза">
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
          </SettingsBlock>

          <SettingsBlock
            icon={<IconLock />}
            title="PIN-код"
            chip={hasPin ? 'установлен' : 'не установлен'}
          >
            <PinSection hasPin={hasPin} setupPin={setupPin} removePin={removePin} />
            {hasPin && (
              <AutoLockSection
                autoLockTimeout={autoLockTimeout}
                setAutoLockTimeout={setAutoLockTimeout}
              />
            )}
          </SettingsBlock>

          <SettingsBlock
            icon={<IconInfinity />}
            title="Вечное хранилище"
            chip={arweaveChip}
            chipClass={arweaveChipClass}
          >
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
          </SettingsBlock>

          <SettingsBlock icon={<IconTheme />} title="Тема" chip={THEME_LABELS[theme]}>
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
          </SettingsBlock>

          <SettingsBlock icon={<IconTrash />} title="Сброс приложения" danger>
            <div className="settings-hint">
              Удаляет все локальные данные с этого устройства. Заметки, сохранённые
              в блокчейне, останутся — восстановишь по seed-фразе.
            </div>
            <button className="btn btn-danger full-width" onClick={onRequestReset}>
              Сбросить приложение
            </button>
          </SettingsBlock>
        </div>
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
  const [formOpen, setFormOpen] = useState(false);

  // Set (no PIN yet) and change (PIN exists) share one path: you are already in
  // an unlocked session, so both just re-wrap the seed with the new PIN. No
  // current-PIN prompt (an unlocked device is already trusted per the model).
  async function handleSave() {
    if (pinInput.length < 6) { setPinError('Минимум 6 цифр'); return; }
    if (pinInput !== pinConfirm) { setPinError('PIN-коды не совпадают'); return; }
    try {
      await setupPin(pinInput);
    } catch (err) {
      // Keep the form open — closing it would imply the PIN was saved.
      console.error('setupPin failed:', err);
      setPinError('Не удалось сохранить PIN. Попробуйте ещё раз.');
      return;
    }
    setPinInput(''); setPinConfirm(''); setPinError(''); setFormOpen(false);
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
    setFormOpen(false);
  }

  function cancel() {
    setFormOpen(false); setPinInput(''); setPinConfirm(''); setPinError('');
  }

  return (
    <>
      <div className="settings-hint">
        PIN — быстрый вход на этом устройстве. Мастер-ключ — seed-фраза:
        при физическом доступе к разблокированному устройству PIN не
        заменяет её надёжное хранение. После 10 неверных попыток PIN
        удаляется, вход — только по seed-фразе.
      </div>

      {formOpen ? (
        <div className="pin-setup">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            className="pin-input"
            placeholder={hasPin ? 'Новый PIN (мин. 6 цифр)' : 'PIN (мин. 6 цифр)'}
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
          <button className="btn btn-primary full-width" onClick={handleSave}>
            Сохранить PIN
          </button>
          <button className="btn btn-ghost full-width" onClick={cancel}>
            Отмена
          </button>
        </div>
      ) : (
        <div className="pin-actions">
          {pinError && <div className="error-msg">{pinError}</div>}
          <button
            className="btn btn-outline full-width"
            onClick={() => { setFormOpen(true); setPinError(''); }}
          >
            {hasPin ? 'Сменить PIN-код' : 'Установить PIN-код'}
          </button>
          {hasPin && (
            <button className="btn btn-ghost full-width" onClick={handleRemovePin}>
              Удалить PIN-код
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Auto-lock threshold (§9): shown only with a PIN set — without one there is
 *  nothing to unlock against. Persist-first: the highlighted option changes
 *  only after the meta write commits; a failed write shows an error and keeps
 *  the previous value. */
const AUTO_LOCK_OPTIONS: { value: AutoLockTimeout; label: string }[] = [
  { value: null, label: 'Никогда' },
  { value: 0, label: 'Сразу' },
  { value: 300, label: 'Через 5 мин' },
  { value: 1800, label: 'Через 30 мин' },
];

function AutoLockSection({ autoLockTimeout, setAutoLockTimeout }: {
  autoLockTimeout: AutoLockTimeout;
  setAutoLockTimeout: (t: AutoLockTimeout) => Promise<void>;
}) {
  const [saveError, setSaveError] = useState('');

  async function choose(value: AutoLockTimeout) {
    setSaveError('');
    try {
      await setAutoLockTimeout(value);
    } catch (err) {
      console.error('setAutoLockTimeout failed:', err);
      setSaveError('Не удалось сохранить настройку. Попробуйте ещё раз.');
    }
  }

  return (
    <div className="autolock-section">
      <div className="settings-hint">
        Авто-блокировка: запрашивать PIN после ухода приложения в фон.
      </div>
      <div className="autolock-grid" role="group" aria-label="Авто-блокировка при уходе в фон">
        {AUTO_LOCK_OPTIONS.map(opt => (
          <button
            key={String(opt.value)}
            type="button"
            className={`autolock-option ${autoLockTimeout === opt.value ? 'autolock-option--active' : ''}`}
            aria-pressed={autoLockTimeout === opt.value}
            onClick={() => void choose(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {saveError && <div className="error-msg" role="alert">{saveError}</div>}
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
