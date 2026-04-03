import { useState, useRef, useEffect } from 'react';
import { useNotes, PinLockedError, PinWipedError } from '../lib/store';

export function PinUnlock() {
  const { unlockWithPin, goToRestore } = useNotes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockedSeconds, setLockedSeconds] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Countdown timer for lockout
  useEffect(() => {
    if (lockedSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockedSeconds(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedSeconds]);

  async function handleUnlock() {
    if (pin.length < 4) {
      setError('Минимум 4 цифры');
      return;
    }
    if (lockedSeconds > 0) return;

    setLoading(true);
    setError('');
    try {
      await unlockWithPin(pin);
    } catch (err) {
      if (err instanceof PinLockedError) {
        setLockedSeconds(err.secondsLeft);
        setError(`Слишком много попыток. Подождите ${formatLockTime(err.secondsLeft)}`);
      } else if (err instanceof PinWipedError) {
        setError(err.message);
        // Will redirect to restore after user clicks the button
      } else {
        setError('Неверный PIN-код');
      }
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

  function formatLockTime(seconds: number): string {
    if (seconds >= 60) return `${Math.ceil(seconds / 60)} мин`;
    return `${seconds} сек`;
  }

  const isLocked = lockedSeconds > 0;

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
          placeholder={isLocked ? `Заблокирован (${formatLockTime(lockedSeconds)})` : 'PIN-код'}
          value={pin}
          maxLength={8}
          onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          disabled={isLocked}
        />

        {error && <div className="error-msg">{error}</div>}

        <button
          className="btn btn-primary"
          onClick={handleUnlock}
          disabled={loading || pin.length < 4 || isLocked}
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
