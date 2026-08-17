import { useRef, useState } from 'react';
import { useNotes, VaultMismatchError } from '../lib/store';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SECRET_PASSWORD_FIELD_PROPS } from '../components/secretFieldProps';
import { copyTextToClipboard } from '../lib/clipboard';
import { InfinityMark, IconEye } from '../components/icons';

type Step = 'start' | 'seed' | 'verify' | 'pin';

const VERIFY_WORDS = 3;

export function Onboarding() {
  const { createNewWallet, confirmMnemonic, goToRestore, goToLanding, resetApp } = useNotes();
  const [step, setStep] = useState<Step>('start');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [seedRevealed, setSeedRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [verifyIdx, setVerifyIdx] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>([]);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const inFlightRef = useRef(false);

  async function handleGenerate() {
    const mn = await createNewWallet();
    setMnemonic(mn);
    setSeedRevealed(false);
    setConfirmed(false);
    setStep('seed');
  }

  async function handleCopy() {
    if (!mnemonic) return;
    setCopyError('');
    // For the SEED a false «copied» is dangerous: the user may believe a
    // backup exists that was never made. Only a resolved write counts.
    if (await copyTextToClipboard(mnemonic)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyError('Не удалось скопировать. Запишите фразу вручную или выделите слова и скопируйте сами.');
    }
  }

  function startVerify() {
    // Ask back 3 random distinct positions — typing them proves the phrase was
    // actually written down, not just clicked through.
    const idx: number[] = [];
    while (idx.length < VERIFY_WORDS) {
      const i = Math.floor(Math.random() * 12);
      if (!idx.includes(i)) idx.push(i);
    }
    idx.sort((a, b) => a - b);
    setVerifyIdx(idx);
    setVerifyInputs(Array(VERIFY_WORDS).fill(''));
    setError('');
    setStep('verify');
  }

  function handleVerify() {
    if (!mnemonic) return;
    const words = mnemonic.split(' ');
    const allOk = verifyIdx.every(
      (wordIndex, i) => verifyInputs[i].trim().toLowerCase() === words[wordIndex],
    );
    if (!allOk) {
      setError('Слова не совпадают с записанной фразой. Сверьтесь с записью.');
      return;
    }
    setError('');
    setStep('pin');
  }

  async function handleFinish(withPin: boolean) {
    // Synchronous, unlike `finishing`: two clicks in one React batch would both
    // pass a state-only guard and start two vault opens.
    if (!mnemonic || inFlightRef.current) return;
    if (withPin) {
      if (pinInput.length < 6) { setError('PIN — минимум 6 цифр'); return; }
      if (pinInput !== pinConfirm) { setError('PIN-коды не совпадают'); return; }
    }
    inFlightRef.current = true;
    setFinishing(true);
    setError('');

    // ONE identity-checked operation — never «write the PIN, then check the
    // vault, then take the PIN back». A tab that loses the identity race would
    // otherwise leave a PIN for a vault this device does not have, or delete
    // the PIN of the vault that won. The store writes it only after the
    // binding, and reports a PIN that did not make it via pinSetupNotice.
    try {
      await confirmMnemonic(mnemonic, withPin ? { pin: pinInput } : undefined);
    } catch (err) {
      if (err instanceof VaultMismatchError) {
        setError(err.message);
        setShowReset(true);
      } else {
        console.error('confirmMnemonic failed:', err);
        setError('Не удалось создать хранилище. Попробуйте ещё раз.');
      }
      inFlightRef.current = false;
      setFinishing(false);
    }
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon"><InfinityMark /></div>

        {step === 'start' && (
          <>
            <h1>Eternal Notes</h1>
            <p className="subtitle">
              Зашифрованы на устройстве. По желанию — навсегда в блокчейне
              (синхронизация включается позже по invite-коду).
            </p>
            <button className="btn btn-primary" onClick={handleGenerate}>
              Создать хранилище
            </button>
            <button className="btn btn-ghost" onClick={goToRestore}>
              У меня есть seed-фраза
            </button>
            <button className="btn btn-ghost" onClick={goToLanding}>
              Назад
            </button>
          </>
        )}

        {step === 'seed' && mnemonic && (
          <>
            <h1>Ваша seed-фраза</h1>
            <div className="seed-warning">
              Запишите эти 12 слов. Это единственный способ восстановить ваши заметки.
              Никому не показывайте.
            </div>

            {!seedRevealed ? (
              <button className="seed-cover" onClick={() => setSeedRevealed(true)}>
                <span className="seed-cover-icon"><IconEye /></span>
                <span>Нажмите, чтобы показать фразу</span>
                <span className="seed-cover-hint">Убедитесь, что никто не смотрит на экран</span>
              </button>
            ) : (
              <>
                <div className="seed-grid">
                  {mnemonic.split(' ').map((word, i) => (
                    <div className="seed-word" key={i}>
                      <span className="seed-num">{i + 1}</span>
                      <span className="seed-text">{word}</span>
                    </div>
                  ))}
                </div>

                {/* The risk must be visible BEFORE the copy happens — clipboard
                    history / cloud clipboard sync may retain the master key. */}
                <div className="seed-warning info">
                  Копирование поместит мастер-ключ в системный буфер обмена: он
                  может сохраниться в истории буфера и в облачной синхронизации.
                  Надёжнее записать фразу на бумаге; если копируете — после
                  вставки очистите историю буфера средствами ОС.
                </div>
                <button className="btn btn-outline" onClick={handleCopy}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
                {copyError && <div className="error-msg" role="alert">{copyError}</div>}

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={e => setConfirmed(e.target.checked)}
                  />
                  <span>Я записал(а) seed-фразу в надёжное место</span>
                </label>

                <button
                  className="btn btn-primary"
                  disabled={!confirmed}
                  onClick={startVerify}
                >
                  Продолжить
                </button>
              </>
            )}
          </>
        )}

        {step === 'verify' && mnemonic && (
          <>
            <h1>Проверка записи</h1>
            <p className="subtitle">
              Введите слова из вашей записи, чтобы убедиться, что фраза сохранена.
            </p>

            <div className="verify-words">
              {verifyIdx.map((wordIndex, i) => (
                <label className="verify-word-row" key={wordIndex}>
                  <span className="seed-num">Слово №{wordIndex + 1}</span>
                  <input
                    type="text"
                    value={verifyInputs[i]}
                    onChange={e => {
                      const next = [...verifyInputs];
                      next[i] = e.target.value;
                      setVerifyInputs(next);
                      setError('');
                    }}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>

            {error && <div className="error-msg">{error}</div>}

            <button
              className="btn btn-primary"
              disabled={verifyInputs.some(w => !w.trim())}
              onClick={handleVerify}
            >
              Проверить
            </button>
            <button className="btn btn-ghost" onClick={() => { setError(''); setStep('seed'); }}>
              Посмотреть фразу ещё раз
            </button>
          </>
        )}

        {step === 'pin' && (
          <>
            <h1>Быстрый вход по PIN</h1>
            <p className="subtitle">
              PIN разблокирует заметки на этом устройстве без ввода seed-фразы.
            </p>
            <div className="seed-warning info">
              Seed-фраза остаётся мастер-ключом. PIN — только удобство: при полном
              физическом доступе к устройству он не заменяет надёжное хранение фразы.
            </div>

            {/* Anti-autofill set + neutral name/id, like every other secret
                field: a manager that saves the master PIN to a third-party
                cloud breaks the end-to-end model. Locked while the vault is
                being created — the KDF already took the value on screen. */}
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              className="pin-input"
              name="setup-code" id="setup-code"
              placeholder="PIN (мин. 6 цифр)"
              value={pinInput}
              maxLength={8}
              disabled={finishing}
              onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setError(''); }}
              {...SECRET_PASSWORD_FIELD_PROPS}
            />
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              className="pin-input"
              name="setup-code-2" id="setup-code-2"
              placeholder="Повторите PIN"
              value={pinConfirm}
              maxLength={8}
              disabled={finishing}
              onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, '')); setError(''); }}
              {...SECRET_PASSWORD_FIELD_PROPS}
            />

            {error && <div className="error-msg">{error}</div>}

            {showReset && (
              <button
                className="btn btn-danger full-width"
                onClick={() => setConfirmReset(true)}
              >
                Сбросить приложение
              </button>
            )}

            <ConfirmDialog
              open={confirmReset}
              title="Сбросить приложение?"
              message="Все локальные данные будут удалены. Это действие необратимо."
              confirmLabel="Удалить всё"
              danger
              onConfirm={() => { setConfirmReset(false); resetApp(); }}
              onCancel={() => setConfirmReset(false)}
            />


            <button
              className="btn btn-primary"
              disabled={finishing || pinInput.length < 6 || pinInput !== pinConfirm}
              onClick={() => handleFinish(true)}
            >
              {finishing ? 'Создание...' : 'Установить PIN и начать'}
            </button>
            <button
              className="btn btn-ghost"
              disabled={finishing}
              onClick={() => handleFinish(false)}
            >
              Пропустить — войти без PIN
            </button>
          </>
        )}
      </div>
    </div>
  );
}
