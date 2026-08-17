import { useState, type ReactNode } from 'react';
import { useNotes } from '../lib/store';
import type { AutoLockTimeout } from '../lib/auto-lock';
import type { ThemePref } from '../lib/theme';
import { SECRET_PASSWORD_FIELD_PROPS, SAFEBOX_SECRET_FIELD_CLASS } from '../components/secretFieldProps';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { navigate } from '../lib/route';
import { QUARANTINE_EXPLANATION } from '../lib/syncCounters';

/** Settings SECTION — a routed destination, not a dialog. Grouped into four
 *  groups («Доступ и замки», «Синхронизация», «Вид», «Опасная зона»), each
 *  holding collapsible blocks with a glanceable status chip.
 *
 *  Local UI state (seed reveal, PIN form, invite form) lives here and dies with
 *  the unmount when the user navigates away — strictly stronger than the old
 *  reset-on-close. The reset confirmation dialog lives HERE too now: the section
 *  is not aria-modal, so it is the only modal layer on screen and does not need
 *  to outlive anything. */
interface SettingsSectionProps {
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
}

/**
 * «Чернильная», not «Тёмная».
 *
 * The theme IDs stay `dark`/`light`/`warm` — they are what `localStorage`
 * holds and what an older build degrades from, so renaming them would break a
 * rollback. Only the words change, and they change because the palettes did:
 * this is no longer «light and its dimmed twin» but three papers, one of
 * which is inked. The mockup names them exactly this way.
 */
const THEME_LABELS: Record<ThemePref, string> = {
  system: 'Системная',
  light: 'Светлая',
  dark: 'Чернильная',
  warm: 'Тёплая',
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
const IconChevron = () => <Svg><path d="m6 9 6 6 6 -6" /></Svg>;

/** One settings row. Collapsed by default; the header stays a button so the
 *  keyboard treats it as one stop.
 *
 *  NO LEADING ICON, deliberately. Each row used to carry a 20px accent glyph,
 *  which is 31px of the row's width spent on decoration that repeats the label
 *  it sits next to. The approved mockup has none, and on a 360px phone that
 *  width is the difference between «Авто-блокировка · Через 5 мин» fitting and
 *  wrapping. Icons stay where they disambiguate — the three nav items. */
function SettingsBlock({ title, chip, chipClass, danger, children }: {
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
        <span className="settings-block-title">{title}</span>
        {chip && <span className={`settings-block-chip${chipClass ? ' ' + chipClass : ''}`}>{chip}</span>}
        <span className="settings-block-chev"><IconChevron /></span>
      </button>
      {open && <div className="settings-block-body">{children}</div>}
    </div>
  );
}

export function SettingsSection({ theme, onThemeChange }: SettingsSectionProps) {
  const {
    notes,
    chains,
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
    safeboxPinConfigured,
    safeboxDataPresent,
    safeboxUnlocked,
    safeboxLockGeneration,
    unlockSafebox,
    changeSafeboxPin,
    deactivateSafebox,
    resetApp,
  } = useNotes();

  const [showSeed, setShowSeed] = useState(false);
  // Seed gate (§2): with a safebox configured, the phrase is shown only after
  // the SAFEBOX PIN is entered here — otherwise the 10-strike wipe would make
  // reaching the seed EASIER than keeping the safebox.
  const [seedGatePin, setSeedGatePin] = useState('');
  const [seedGateError, setSeedGateError] = useState('');
  const [seedGateBusy, setSeedGateBusy] = useState(false);
  const [seedGatePassed, setSeedGatePassed] = useState(false);

  // No `open` prop and no close(): navigating away UNMOUNTS this section, which
  // is strictly stronger than the old reset-on-close — nothing can survive it.
  //
  // Escape is deliberately NOT bound. A section-level «Escape → к заметкам»
  // would fight the nested dialogs' own stopPropagation and would yank the user
  // out mid-form. Leaving is the nav, or the Back gesture — which now works.
  function clearSeedState() {
    setShowSeed(false);
    setSeedGatePin('');
    setSeedGateError('');
    setSeedGatePassed(false);
  }

  // ROUND-13 REGRESSION GUARD, in its new shape. The old modal cleared the
  // revealed phrase whenever `open` went false, which the reset flow relied on:
  // «Settings → показать seed → Сброс → отмена → Settings снова показывал фразу
  // без запроса». In a section the user never leaves during that flow, nothing
  // unmounts, and the phrase would sit there behind the confirm dialog — so the
  // clearing has to be explicit here.
  function requestReset() {
    clearSeedState();
    setShowResetConfirm(true);
  }

  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Reset-safety is STORAGE-backed (arweave.resetRiskCount): every stored
  // record that is not confirmed — visible or not (historical versions,
  // quarantined/undecryptable records) — is unrecoverable after a wipe. The
  // visible `notes` list undercounts exactly the records most at risk.
  // The safebox contribution is derived from the ENCRYPTED rows, so the
  // warning is correct with the section LOCKED — the normal case here.
  const resetRiskTotal = arweave.resetRisk.notes + arweave.resetRisk.safebox;
  const resetWarningMessage = !arweave.countsReady
    // Until the first sync-count read completes we cannot know what is safe.
    ? '⚠️ Состояние синхронизации ещё загружается — сейчас нельзя определить, '
      + 'какие заметки уже подтверждены в блокчейне.\nВсе локальные данные будут '
      + 'удалены; неподтверждённые заметки пропадут безвозвратно.'
    : resetRiskTotal > 0
      // Only CONFIRMED records are recoverable: an `accepted` transaction can
      // still be dropped, and after a wipe there is no local ciphertext left.
      ? `⚠️ ${resetRiskTotal} записей ещё НЕ подтверждены в блокчейне и будут потеряны безвозвратно `
        + '(включая версии в истории заметок и записи, ожидающие подтверждения — такая транзакция ещё может не дойти).\n'
        + (arweave.resetRisk.safebox > 0
          ? `Из них в защищённом сейфе: ${arweave.resetRisk.safebox} — пароли и вложения.\n`
          : '')
        + 'Дождитесь статуса «Сохранена в блокчейне», если они вам нужны.'
      : 'Все локальные данные будут удалены. Все записи подтверждены в блокчейне — их можно вернуть по seed-фразе.';

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



  return (
    <section className="settings-section" aria-labelledby="settings-title">
      {/* The scroller. The section itself is a two-row grid now, so the
          footnote below can sit on its own row instead of trailing the
          content — see `.settings-section` in index.css. */}
      <div className="settings-scroll">
        <div className="settings-topbar">
          {/* tabIndex={-1}: the shell moves focus here on every section change,
              which is the a11y invariant that replaces the modal focus trap —
              without it a keyboard user lands at the top of the document with
              no announcement. */}
          <h2 id="settings-title" className="section-title" tabIndex={-1}>Настройки</h2>
        </div>

        <div className="settings-blocks">
          {/* Four groups instead of six loose blocks. The point is the first
              one: three things about locks used to sit interleaved with the
              theme picker and the reset button, so nothing told the user that
              the app PIN and the safebox PIN are DIFFERENT contours. */}
          <div className="settings-group">
            <h3 className="settings-group-title">Доступ и замки</h3>
            <div className="settings-rows">
          <SettingsBlock title="Seed-фраза">
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
                  className={`pin-input ${SAFEBOX_SECRET_FIELD_CLASS}`}
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

          {/* Unconditional, like the nav item: the same appear/disappear
              formula lived here too. Nothing configured yet is a STATE, shown
              in the chip, not a reason to hide the only route to it. */}
          <SettingsBlock
            title="Защищённый сейф"
            chip={safeboxPinConfigured ? 'PIN установлен' : 'не настроен'}
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

          </div>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Синхронизация</h3>
            <div className="settings-rows">
          <SettingsBlock
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
              {/* The per-note and per-version counters now live in the status
                  line's expandable panel — one place, one computation. A copy
                  here meant two answers to «how much is safely on chain», and
                  the user would have had to reconcile them. */}
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
                  ⏸ Отложено записей: <strong>{arweave.quarantinedCount}</strong> — {QUARANTINE_EXPLANATION}
                </div>
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

          </div>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Вид</h3>
            <div className="settings-rows">
          <SettingsBlock title="Тема" chip={THEME_LABELS[theme]}>
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

          </div>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title settings-group-title--danger">Опасная зона</h3>
            <div className="settings-rows">
          <SettingsBlock title="Сброс приложения" danger>
            <div className="settings-hint">
              Удаляет все локальные данные с этого устройства. Заметки, сохранённые
              в блокчейне, останутся — восстановишь по seed-фразе.
            </div>
            <button className="btn btn-danger full-width" onClick={requestReset}>
              Сбросить приложение
            </button>
          </SettingsBlock>
          </div>
          </div>
        </div>

      </div>

      {/* OUT OF THE SCROLL, sitting on the section's own last row, right above
          the tab bar — where the mockup puts it.
          It used to be the last child of the scrolling column, which meant the
          one line that describes the whole vault was visible only to someone
          who had already scrolled past everything else. It is not a control
          and not urgent; it is a footer, and a footer that scrolls away is
          just a paragraph. */}
      <p className="settings-footnote">
        Заметок: {chains.length}
        {notes.length !== chains.length && <> · записей: {notes.length}</>}
        {' · '}AES-256-GCM
      </p>

      {/* The reset confirm lives HERE now. Settings is no longer aria-modal, so
          the old «close settings before opening the confirm» dance is
          unnecessary: this dialog is the only modal layer on screen. */}
      <ConfirmDialog
        open={showResetConfirm}
        title="Сбросить приложение?"
        message={resetWarningMessage}
        confirmLabel="Сбросить"
        danger
        onConfirm={() => { setShowResetConfirm(false); navigate('notes', { replace: true }); void resetApp(); }}
        onCancel={() => setShowResetConfirm(false)}
      />
    </section>
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
            className={`pin-input ${SAFEBOX_SECRET_FIELD_CLASS}`}
            name="sbx-cur-code" id="sbx-cur-code"
            placeholder="Текущий PIN сейфа" value={currentPin} maxLength={8}
            onChange={e => { setCurrentPin(e.target.value.replace(/\D/g, '')); setError(''); }}
            {...SECRET_PASSWORD_FIELD_PROPS}
          />
          {mode === 'change' && (
            <>
              <input
                type="password" inputMode="numeric" pattern="[0-9]*"
                className={`pin-input ${SAFEBOX_SECRET_FIELD_CLASS}`}
                name="sbx-next-code" id="sbx-next-code"
                placeholder="Новый PIN (6–8 цифр)" value={newPin} maxLength={8}
                onChange={e => { setNewPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                {...SECRET_PASSWORD_FIELD_PROPS}
              />
              <input
                type="password" inputMode="numeric" pattern="[0-9]*"
                className={`pin-input ${SAFEBOX_SECRET_FIELD_CLASS}`}
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
