import { useState } from 'react';
import { useNotes } from '../lib/store';
import { VaultMismatchError } from '../lib/store';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SeedEntryGrid } from '../components/SeedEntryGrid';
import { emptySeedWords, emptySeedFlags } from '../lib/seed-words';

export function Restore() {
  const { restoreFromMnemonic, goToOnboarding, resetApp, vaultError } = useNotes();
  const [words, setWords] = useState<string[]>(emptySeedWords);
  const [invalidWords, setInvalidWords] = useState<boolean[]>(emptySeedFlags);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Show vault error from bootstrap if present
  const displayError = error || vaultError;
  const displayShowReset = showReset || !!vaultError;

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

        <SeedEntryGrid
          words={words}
          onChange={setWords}
          invalidWords={invalidWords}
          onInvalidChange={setInvalidWords}
          onEdit={() => setError('')}
        />

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
