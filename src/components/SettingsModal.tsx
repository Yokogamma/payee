import { useEffect, useState, type ReactNode } from 'react';
import { useNotes } from '../lib/store';
import type { AutoLockTimeout } from '../lib/auto-lock';
import type { ThemePref } from '../lib/theme';
import { useModalA11y } from '../lib/useModalA11y';
import { SECRET_PASSWORD_FIELD_PROPS } from './secretFieldProps';

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
    chains,
    arweave,
    syncStatuses,
    updateCheck,
    checkForUpdates,
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
    safeboxPinConfigured,
    safeboxDataPresent,
    safeboxUnlocked,
    safeboxLockGeneration,
    unlockSafebox,
    changeSafeboxPin,
    deactivateSafebox,
  } = useNotes();

  const [showSeed, setShowSeed] = useState(false);
  // Seed gate (§2): with a safebox configured, the phrase is shown only after
  // the SAFEBOX PIN is entered here — otherwise the 10-strike wipe would make
  // reaching the seed EASIER than keeping the safebox.
  const [seedGatePin, setSeedGatePin] = useState('');
  const [seedGateError, setSeedGateError] = useState('');
  const [seedGateBusy, setSeedGateBusy] = useState(false);
  const [seedGatePassed, setSeedGatePassed] = useState(false);

  function close() {
    setShowSeed(false);
    setSeedGatePin('');
    setSeedGateError('');
    setSeedGatePassed(false);
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
    else { setShowSeed(false); setSeedGatePassed(false); setSeedGatePin(''); setSeedGateError(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A SECTION LOCK (idle timer, hidden/pagehide, app lock, another tab) must
  // clear this modal's own safebox secrets too — it sits OUTSIDE the subtree
  // Main remounts on `safeboxLockGeneration`. Adjusted during render, so the
  // typed PIN is gone before the next paint.
  const [prevLockGeneration, setPrevLockGeneration] = useState(safeboxLockGeneration);
  if (safeboxLockGeneration !== prevLockGeneration) {
    setPrevLockGeneration(safeboxLockGeneration);
    setSeedGatePassed(false);
    setSeedGatePin('');
    setSeedGateError('');
  }

  if (!open) return null;

  // Gate matrix (§2):
  //  - no safebox config, no safebox data → the seed is shown as before;
  //  - safebox configured                 → behind the SAFEBOX PIN;
  //  - safebox DATA but no config (wiped / new device / deactivated)
  //                                       → forbidden, with a pointer to the
  //                                         seed-based PIN reset (otherwise the
  //                                         wipe would be a shortcut TO the seed).
  const seedBlockedByMissingConfig = !safeboxPinConfigured && safeboxDataPresent;
  // The gate is LIVE, not a one-time flag: the phrase is shown only while the
  // safebox session that proved the PIN is still open. An idle lock, an app
  // lock, a hidden edge or a config replaced in another tab all close the
  // section — and with it this gate — on the very next render.
  const seedGateOpen = seedGatePassed && safeboxUnlocked;
  const seedNeedsSafeboxPin = safeboxPinConfigured && !seedGateOpen;
  const mnemonic = showSeed && !seedBlockedByMissingConfig && !seedNeedsSafeboxPin
    ? showMnemonic()
    : null;

  async function passSeedGate() {
    if (seedGatePin.length < 6) { setSeedGateError('Минимум 6 цифр'); return; }
    setSeedGateBusy(true);
    setSeedGateError('');
    try {
      // Unlocking the safebox IS the proof: it runs the metered PIN path and
      // RESOLVES ONLY on a fully published, still-live session (a lock during
      // the KDF makes it throw SafeboxLockedError instead of resolving).
      await unlockSafebox(seedGatePin);
      setSeedGatePassed(true);
      setSeedGatePin('');
    } catch (err) {
      setSeedGatePassed(false);
      setSeedGateError(err instanceof Error ? err.message : 'Неверный PIN сейфа');
    } finally {
      setSeedGateBusy(false);
    }
  }

  const arweaveChip = !arweave.enabled
    ? 'выключено'
    : arweave.online ? '● Онлайн' : '○ Оффлайн';
  const arweaveChipClass = arweave.enabled && arweave.online ? 'text-green' : '';

  // ─── Storage counters, per NOTE (chain) and per VERSION (transaction) ───
  //
  // «В блокчейне» is `confirmed`-ONLY, deliberately: the reset warning treats
  // exactly that status as recoverable, and a counter that called an `accepted`
  // note "saved" would contradict the dialog that is about to wipe it.
  //
  // A chain qualifies only when EVERY version does (`every`, not `some`) — a
  // half-uploaded note must not look finished. The two lines are disjoint by
  // construction, and a chain that still holds a queued/errored version falls
  // into NEITHER: it is neither stored nor fully transmitted, and its versions
  // are already visible in «Ожидают загрузки» / «Ошибки».
  const versionStatus = (id: string) => syncStatuses[id]?.status;
  const confirmedChains = chains.filter(
    c => c.versions.every(v => versionStatus(v.id) === 'confirmed'),
  ).length;
  const pendingChains = chains.filter(c =>
    c.versions.every(v => versionStatus(v.id) === 'confirmed' || versionStatus(v.id) === 'accepted')
    && c.versions.some(v => versionStatus(v.id) === 'accepted'),
  ).length;
  // Storage-backed, NOT notes.length: the aggregates count every stored record,
  // including versions this build cannot decrypt (invisible in chains/notes).
  const totalVersions = arweave.confirmedCount + arweave.acceptedCount + arweave.unsyncedCount;

  const checking = updateCheck.status === 'checking';
  const checkProgress = updateCheck.status === 'checking' ? updateCheck.progress : null;

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
          {/* Notes = chains (what the user perceives); записи = raw versions. */}
          <span>
            <IconNote /> Заметок: <strong>{chains.length}</strong>
            {notes.length !== chains.length && <> · записей: <strong>{notes.length}</strong></>}
          </span>
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

            {showSeed && seedBlockedByMissingConfig && (
              <div className="seed-warning" role="alert">
                На устройстве есть записи сейфа, но PIN сейфа не установлен.
                Просмотр seed-фразы закрыт — сначала восстановите PIN сейфа по
                seed-фразе в разделе «Защищённый сейф».
              </div>
            )}

            {showSeed && !seedBlockedByMissingConfig && seedNeedsSafeboxPin && (
              <div className="pin-setup">
                <div className="settings-hint">
                  Просмотр seed-фразы защищён PIN-кодом сейфа.
                </div>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="pin-input safebox-secret-field"
                  name="sbx-gate-seed"
                  id="sbx-gate-seed"
                  placeholder="PIN сейфа"
                  value={seedGatePin}
                  maxLength={8}
                  onChange={e => { setSeedGatePin(e.target.value.replace(/\D/g, '')); setSeedGateError(''); }}
                  {...SECRET_PASSWORD_FIELD_PROPS}
                />
                {seedGateError && <div className="error-msg" role="alert">{seedGateError}</div>}
                <button
                  className="btn btn-primary full-width"
                  disabled={seedGateBusy}
                  onClick={() => void passSeedGate()}
                >
                  {seedGateBusy ? 'Проверяем...' : 'Показать после ввода PIN'}
                </button>
              </div>
            )}

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

          {(safeboxPinConfigured || safeboxDataPresent) && (
            <SettingsBlock
              icon={<IconShield />}
              title="Защищённый сейф"
              chip={safeboxPinConfigured ? 'PIN установлен' : 'PIN не установлен'}
            >
              <SafeboxSettingsSection
                // Remounted on every section lock: its current/new PIN fields
                // would otherwise survive a hidden/pagehide round-trip.
                key={safeboxLockGeneration}
                configured={safeboxPinConfigured}
                changeSafeboxPin={changeSafeboxPin}
                deactivateSafebox={deactivateSafebox}
              />
            </SettingsBlock>
          )}

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
              {/* Per-NOTE headline (a note edited 3 times is one note), with the
                  per-VERSION truth right under it — every version is its own
                  transaction, and the two legitimately disagree. */}
              {!arweave.countsReady ? (
                // syncStatuses is still empty here, so the formulas would render
                // an honest-looking «0 из N» lie.
                <div>Синхронизировано: <strong>загружается…</strong></div>
              ) : (
                <>
                  <div className={confirmedChains === chains.length ? 'text-green' : undefined}>
                    Заметки в блокчейне: <strong>{confirmedChains}</strong> из <strong>{chains.length}</strong>
                  </div>
                  {pendingChains > 0 && (
                    <div>⏳ Передано, ждёт подтверждения: <strong>{pendingChains}</strong></div>
                  )}
                  <div className="settings-hint">
                    версий (транзакций): {arweave.confirmedCount} из {totalVersions}
                  </div>
                </>
              )}
              {arweave.acceptedCount > 0 && (
                <div>⏳ Ожидают подтверждения версий: <strong>{arweave.acceptedCount}</strong></div>
              )}
              {arweave.unsyncedCount > 0 && (
                <div>⏳ Ожидают загрузки версий: <strong>{arweave.unsyncedCount}</strong></div>
              )}
              {arweave.errorCount > 0 && (
                <div className="text-red">⚠️ Ошибки: <strong>{arweave.errorCount}</strong></div>
              )}
              {arweave.quarantinedCount > 0 && (
                // Permanent by design — deliberately NOT lumped into «Ошибки»:
                // no «Повторить» can ever fix a quarantined record.
                <div>
                  ⏸ Отложено записей: <strong>{arweave.quarantinedCount}</strong> — созданы
                  более новой версией приложения; обновите приложение, чтобы загрузить их.
                </div>
              )}
              {arweave.lastSync && (
                <div>Последняя синхронизация: {new Date(arweave.lastSync).toLocaleString('ru')}</div>
              )}
            </div>

            {arweave.lastError && (
              <div className="error-msg">{arweave.lastError}</div>
            )}

            {/* Reading Arweave needs neither the sync toggle nor a registered
                key — those gate UPLOADS. Gating this button on `enabled` would
                strand a read-only device with no way to see its own notes. */}
            <button
              className="btn btn-outline full-width"
              onClick={() => void checkForUpdates()}
              disabled={checking}
            >
              {checking
                ? (checkProgress ? `⏳ Проверяем… ${checkProgress.done}/${checkProgress.total}` : '⏳ Проверяем…')
                : '↻ Проверить обновления'}
            </button>
            <div className="settings-hint">
              Забирает заметки и записи сейфа, созданные на других устройствах.
            </div>

            {updateCheck.status === 'error' && (
              <div className="settings-info text-red">⚠ Не удалось проверить обновления</div>
            )}
            {updateCheck.status === 'done' && (
              <div className="settings-info">
                {updateCheck.addedNotes + updateCheck.updatedNotes + updateCheck.changedSafebox > 0 ? (
                  <div className="text-green">
                    ✓ Получено с других устройств: <strong>{updateCheck.addedNotes}</strong>
                    {updateCheck.updatedNotes > 0 && <> · обновлено: <strong>{updateCheck.updatedNotes}</strong></>}
                    {updateCheck.changedSafebox > 0 && <> · в сейфе: <strong>{updateCheck.changedSafebox}</strong></>}
                  </div>
                ) : (
                  <div>
                    ✓ Проверено в {new Date(updateCheck.at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                    {' '}— новых заметок нет
                  </div>
                )}
                {/* A partial sweep is NOT a failure: what arrived is merged. It
                    only means the next check may still bring something. */}
                {updateCheck.partial && (
                  <div className="text-red">
                    ⚠ Проверка прошла не полностью — часть данных недоступна, повторите позже
                  </div>
                )}
              </div>
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

/** Safebox PIN management. BOTH destructive-ish operations demand the CURRENT
 *  safebox PIN — an unlocked section is deliberately NOT sufficient, or
 *  «деактивировать → поставить свой PIN → открыть» would walk around the gate.
 *  The seed-based reset lives in the safebox section itself (it needs the
 *  12-word grid). */
function SafeboxSettingsSection({ configured, changeSafeboxPin, deactivateSafebox }: {
  configured: boolean;
  changeSafeboxPin: (currentPin: string, newPin: string) => Promise<void>;
  deactivateSafebox: (currentPin: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'idle' | 'change' | 'deactivate'>('idle');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  function reset() {
    setMode('idle'); setCurrentPin(''); setNewPin(''); setConfirmPin(''); setError('');
  }

  async function submit() {
    setError('');
    if (currentPin.length < 6) { setError('Введите текущий PIN сейфа'); return; }
    if (mode === 'change') {
      if (newPin.length < 6) { setError('Новый PIN: минимум 6 цифр'); return; }
      if (newPin !== confirmPin) { setError('PIN-коды не совпадают'); return; }
    }
    setBusy(true);
    try {
      if (mode === 'change') {
        await changeSafeboxPin(currentPin, newPin);
        setDone('PIN сейфа изменён.');
      } else {
        await deactivateSafebox(currentPin);
        setDone('Сейф деактивирован. Записи сохранены — чтобы снова открыть их, установите PIN по seed-фразе.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выполнить операцию.');
      return;
    } finally {
      setBusy(false);
    }
    reset();
  }

  if (!configured) {
    return (
      <div className="settings-hint">
        На устройстве есть записи сейфа, но PIN не установлен. Откройте раздел
        «🔐 Сейф» и восстановите доступ, введя полную seed-фразу — записи не
        пострадали.
      </div>
    );
  }

  return (
    <>
      <div className="settings-hint">
        PIN сейфа — отдельный код доступа к паролям. Он защищает от взгляда
        через плечо и короткого доступа к открытому экрану, но не является
        крипто-границей. Сброс возможен только полной seed-фразой; записи при
        этом сохраняются.
      </div>
      {done && <div className="settings-info text-green">{done}</div>}

      {mode === 'idle' ? (
        <div className="pin-actions">
          <button className="btn btn-outline full-width" onClick={() => { setDone(''); setMode('change'); }}>
            Сменить PIN сейфа
          </button>
          <button className="btn btn-ghost full-width" onClick={() => { setDone(''); setMode('deactivate'); }}>
            Деактивировать сейф (записи сохранятся)
          </button>
        </div>
      ) : (
        <div className="pin-setup">
          <input
            type="password" inputMode="numeric" pattern="[0-9]*"
            className="pin-input safebox-secret-field"
            name="sbx-cur-code" id="sbx-cur-code"
            placeholder="Текущий PIN сейфа" value={currentPin} maxLength={8}
            onChange={e => { setCurrentPin(e.target.value.replace(/\D/g, '')); setError(''); }}
            {...SECRET_PASSWORD_FIELD_PROPS}
          />
          {mode === 'change' && (
            <>
              <input
                type="password" inputMode="numeric" pattern="[0-9]*"
                className="pin-input safebox-secret-field"
                name="sbx-next-code" id="sbx-next-code"
                placeholder="Новый PIN (6–8 цифр)" value={newPin} maxLength={8}
                onChange={e => { setNewPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                {...SECRET_PASSWORD_FIELD_PROPS}
              />
              <input
                type="password" inputMode="numeric" pattern="[0-9]*"
                className="pin-input safebox-secret-field"
                name="sbx-next-code-2" id="sbx-next-code-2"
                placeholder="Повторите новый PIN" value={confirmPin} maxLength={8}
                onChange={e => { setConfirmPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                {...SECRET_PASSWORD_FIELD_PROPS}
              />
            </>
          )}
          {mode === 'deactivate' && (
            <div className="seed-warning">
              Записи сейфа НЕ удаляются. Чтобы открыть их снова, потребуется
              установить PIN, введя полную seed-фразу.
            </div>
          )}
          {error && <div className="error-msg" role="alert">{error}</div>}
          <button className="btn btn-primary full-width" onClick={() => void submit()} disabled={busy}>
            {busy ? '...' : mode === 'change' ? 'Сменить PIN' : 'Деактивировать'}
          </button>
          <button className="btn btn-ghost full-width" onClick={reset} disabled={busy}>Отмена</button>
        </div>
      )}
    </>
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
            name="app-code" id="app-code"
            placeholder={hasPin ? 'Новый PIN (мин. 6 цифр)' : 'PIN (мин. 6 цифр)'}
            value={pinInput}
            maxLength={8}
            onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }}
            {...SECRET_PASSWORD_FIELD_PROPS}
          />
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            className="pin-input"
            name="app-code-2" id="app-code-2"
            placeholder="Повторите PIN"
            value={pinConfirm}
            maxLength={8}
            onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, '')); setPinError(''); }}
            {...SECRET_PASSWORD_FIELD_PROPS}
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
