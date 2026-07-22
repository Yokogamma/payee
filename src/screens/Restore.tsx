import { useState } from 'react';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useNotes } from '../lib/store';
import { VaultMismatchError } from '../lib/store';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function Restore() {
  const { restoreFromMnemonic, goToOnboarding, resetApp, vaultError } = useNotes();
  const [words, setWords] = useState<string[]>(Array(12).fill(''));
  const [invalidWords, setInvalidWords] = useState<boolean[]>(Array(12).fill(false));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Show vault error from bootstrap if present
  const displayError = error || vaultError;
  const displayShowReset = showReset || !!vaultError;

  function handleWordChange(index: number, value: string) {
    const updated = [...words];
    // Handle paste of full mnemonic (L2: normalize case — wallets often export
    // capitalized words, BIP39 wordlist is lowercase-only)
    const trimmed = value.trim();
    if (trimmed.includes(' ')) {
      const pasted = trimmed.split(/\s+/).map(w => w.toLowerCase());
      if (pasted.length === 12) {
        setWords(pasted);
        setInvalidWords(pasted.map(w => !wordlist.includes(w)));
        setError('');
        return;
      }
    }
    updated[index] = trimmed.toLowerCase();
    setWords(updated);
    setInvalidWords(prev => { const next = [...prev]; next[index] = false; return next; });
    setError('');
  }

  /** UX-1.6: flag a word that is not in the BIP39 wordlist as soon as the
   *  field loses focus — before the full-phrase check on submit. */
  function handleWordBlur(index: number) {
    const w = words[index];
    setInvalidWords(prev => {
      const next = [...prev];
      next[index] = !!w && !wordlist.includes(w);
      return next;
    });
  }

  async function handleRestore() {
    const mnemonic = words.join(' ').trim();
    if (words.some(w => !w)) {
      setError('Заполните все 12 слов');
      return;
    }
    setLoading(true);
    try {
      await restoreFromMnemonic(mnemonic);
    } catch (err) {
      if (err instanceof VaultMismatchError) {
        setError(err.message);
        setShowReset(true);
      } else {
        setError('Неверная seed-фраза. Проверьте слова.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    setConfirmReset(false);
    await resetApp();
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon">∞</div>
        <h1>Восстановление</h1>
        <p className="subtitle">
          Введите 12 слов вашей seed-фразы
        </p>

        <div className="seed-grid input-grid">
          {words.map((word, i) => (
            <div className="seed-word-input" key={i}>
              <span className="seed-num">{i + 1}</span>
              <input
                type="text"
                className={invalidWords[i] ? 'invalid' : undefined}
                value={word}
                onChange={e => handleWordChange(i, e.target.value)}
                onBlur={() => handleWordBlur(i)}
                placeholder="..."
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-label={`Слово ${i + 1} из 12`}
                aria-invalid={invalidWords[i] || undefined}
              />
            </div>
          ))}
        </div>

        {displayError && <div className="error-msg" role="alert">{displayError}</div>}

        {displayShowReset && (
          <button className="btn btn-danger full-width" onClick={() => setConfirmReset(true)}>
            Сбросить приложение
          </button>
        )}

        <ConfirmDialog
          open={confirmReset}
          title="Сбросить приложение?"
          message="Все локальные данные будут удалены. Это действие необратимо; заметки из блокчейна можно будет восстановить по seed-фразе."
          confirmLabel="Удалить всё"
          danger
          onConfirm={handleReset}
          onCancel={() => setConfirmReset(false)}
        />


        <button
          className="btn btn-primary"
          onClick={handleRestore}
          disabled={loading}
        >
          {loading ? 'Восстановление...' : 'Восстановить заметки →'}
        </button>

        <button className="btn btn-ghost" onClick={goToOnboarding}>
          ← Создать новое хранилище
        </button>
      </div>
    </div>
  );
}
