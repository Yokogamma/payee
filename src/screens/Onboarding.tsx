import { useState } from 'react';
import { useNotes, VaultMismatchError } from '../lib/store';

type Step = 'start' | 'seed' | 'verify' | 'pin';

const VERIFY_WORDS = 3;

export function Onboarding() {
  const { createNewWallet, confirmMnemonic, setupPin, removePin, goToRestore, goToLanding, resetApp } = useNotes();
  const [step, setStep] = useState<Step>('start');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [seedRevealed, setSeedRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [verifyIdx, setVerifyIdx] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>([]);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [finishing, setFinishing] = useState(false);

  async function handleGenerate() {
    const mn = await createNewWallet();
    setMnemonic(mn);
    setSeedRevealed(false);
    setConfirmed(false);
    setStep('seed');
  }

  function handleCopy() {
    if (mnemonic) {
      navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
    if (!mnemonic || finishing) return;
    if (withPin) {
      if (pinInput.length < 6) { setError('PIN — минимум 6 цифр'); return; }
      if (pinInput !== pinConfirm) { setError('PIN-коды не совпадают'); return; }
    }
    setFinishing(true);
    setError('');

    // PIN FIRST: after confirmMnemonic the app leaves this screen, so a PIN
    // failure there would be invisible and the user would believe a PIN is set.
    // Here a failure keeps the user on the PIN step with an explicit choice:
    // retry or continue without PIN.
    if (withPin) {
      try {
        await setupPin(pinInput);
      } catch (err) {
        console.error('PIN setup failed:', err);
        setError('Не удалось установить PIN. Попробуйте ещё раз или нажмите «Пропустить», чтобы войти без PIN.');
        setFinishing(false);
        return;
      }
    }

    try {
      await confirmMnemonic(mnemonic);
    } catch (err) {
      // Don't leave a pin-seed for a vault that failed to initialize.
      if (withPin) {
        try { await removePin(); } catch { /* best effort */ }
      }
      if (err instanceof VaultMismatchError) {
        setError(err.message);
        setShowReset(true);
      } else {
        console.error('confirmMnemonic failed:', err);
        setError('Не удалось создать хранилище. Попробуйте ещё раз.');
      }
      setFinishing(false);
    }
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon">∞</div>

        {step === 'start' && (
          <>
            <h1>Eternal Notes</h1>
            <p className="subtitle">
              Заметки, которые живут вечно. Зашифрованы. Неудаляемы.
            </p>
            <button className="btn btn-primary" onClick={handleGenerate}>
              Создать хранилище
            </button>
            <button className="btn btn-ghost" onClick={goToRestore}>
              У меня есть seed-фраза
            </button>
            <button className="btn btn-ghost" onClick={goToLanding}>
              ← Назад
            </button>
          </>
        )}

        {step === 'seed' && mnemonic && (
          <>
            <h1>Ваша seed-фраза</h1>
            <div className="seed-warning">
              ⚠️ Запишите эти 12 слов. Это единственный способ восстановить ваши заметки.
              Никому не показывайте.
            </div>

            {!seedRevealed ? (
              <button className="seed-cover" onClick={() => setSeedRevealed(true)}>
                <span className="seed-cover-icon">👁</span>
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

                <button className="btn btn-outline" onClick={handleCopy}>
                  {copied ? '✓ Скопировано' : 'Копировать'}
                </button>

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
                  Продолжить →
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
              Проверить →
            </button>
            <button className="btn btn-ghost" onClick={() => { setError(''); setStep('seed'); }}>
              ← Посмотреть фразу ещё раз
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

            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              className="pin-input"
              placeholder="PIN (мин. 6 цифр)"
              value={pinInput}
              maxLength={8}
              onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setError(''); }}
            />
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              className="pin-input"
              placeholder="Повторите PIN"
              value={pinConfirm}
              maxLength={8}
              onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, '')); setError(''); }}
            />

            {error && <div className="error-msg">{error}</div>}

            {showReset && (
              <button
                className="btn btn-danger full-width"
                onClick={() => { if (confirm('Удалить все локальные данные? Это действие необратимо.')) resetApp(); }}
              >
                Сбросить приложение
              </button>
            )}

            <button
              className="btn btn-primary"
              disabled={finishing || pinInput.length < 6 || pinInput !== pinConfirm}
              onClick={() => handleFinish(true)}
            >
              {finishing ? 'Создание...' : 'Установить PIN и начать →'}
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
