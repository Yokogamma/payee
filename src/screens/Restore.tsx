import { useState } from 'react';
import { useNotes } from '../lib/store';

export function Restore() {
  const { restoreFromMnemonic, goToOnboarding } = useNotes();
  const [words, setWords] = useState<string[]>(Array(12).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleWordChange(index: number, value: string) {
    const updated = [...words];
    // Handle paste of full mnemonic
    const trimmed = value.trim();
    if (trimmed.includes(' ')) {
      const pasted = trimmed.split(/\s+/);
      if (pasted.length === 12) {
        setWords(pasted);
        setError('');
        return;
      }
    }
    updated[index] = trimmed.toLowerCase();
    setWords(updated);
    setError('');
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
    } catch {
      setError('Неверная seed-фраза. Проверьте слова.');
    } finally {
      setLoading(false);
    }
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
                value={word}
                onChange={e => handleWordChange(i, e.target.value)}
                placeholder="..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ))}
        </div>

        {error && <div className="error-msg">{error}</div>}

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
