import { useState } from 'react';
import { useNotes, VaultMismatchError } from '../lib/store';

export function Onboarding() {
  const { createNewWallet, confirmMnemonic, goToRestore, goToLanding, resetApp } = useNotes();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [showReset, setShowReset] = useState(false);

  async function handleGenerate() {
    const mn = await createNewWallet();
    setMnemonic(mn);
  }

  async function handleConfirm() {
    if (!mnemonic) return;
    setError('');
    try {
      await confirmMnemonic(mnemonic);
    } catch (err) {
      // Without this catch a failure here (device already bound to another
      // vault, broken storage) left the user stuck with a dead button.
      if (err instanceof VaultMismatchError) {
        setError(err.message);
        setShowReset(true);
      } else {
        console.error('confirmMnemonic failed:', err);
        setError('Не удалось создать хранилище. Попробуйте ещё раз.');
      }
    }
  }

  function handleCopy() {
    if (mnemonic) {
      navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon">∞</div>
        <h1>Eternal Notes</h1>
        <p className="subtitle">
          Заметки, которые живут вечно. Зашифрованы. Неудаляемы.
        </p>

        {!mnemonic ? (
          <>
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
        ) : (
          <>
            <div className="seed-warning">
              ⚠️ Запишите эти 12 слов. Это единственный способ восстановить ваши заметки.
              Никому не показывайте.
            </div>

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
              disabled={!confirmed}
              onClick={handleConfirm}
            >
              Начать →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
