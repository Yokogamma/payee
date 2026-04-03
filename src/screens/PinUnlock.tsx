import { useState, useRef, useEffect } from 'react';
import { useNotes } from '../lib/store';

export function PinUnlock() {
  const { unlockWithPin, goToRestore } = useNotes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleUnlock() {
    if (pin.length < 4) {
      setError('Минимум 4 цифры');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await unlockWithPin(pin);
    } catch {
      setError('Неверный PIN-код');
      setPin('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUnlock();
    }
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon">∞</div>
        <h1>Eternal Notes</h1>
        <p className="subtitle">Введите PIN для разблокировки</p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          className="pin-input"
          placeholder="PIN-код"
          value={pin}
          maxLength={8}
          onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />

        {error && <div className="error-msg">{error}</div>}

        <button
          className="btn btn-primary"
          onClick={handleUnlock}
          disabled={loading || pin.length < 4}
        >
          {loading ? 'Разблокировка...' : 'Разблокировать'}
        </button>

        <button className="btn btn-ghost" onClick={goToRestore}>
          Ввести seed-фразу вручную
        </button>
      </div>
    </div>
  );
}
