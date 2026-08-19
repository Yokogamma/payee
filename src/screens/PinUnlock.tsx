import { useState, useRef, useEffect } from 'react';
import { useNotes, PinLockedError, PinWipedError, VaultMismatchError } from '../lib/store';
import { PinUnlockUnavailableError } from '../lib/crypto';
import { SECRET_PASSWORD_FIELD_PROPS } from '../components/secretFieldProps';
import { InfinityMark } from '../components/icons';

export function PinUnlock() {
  const {
    unlockWithPin, getPinLockState, goToRestore,
    hasQuickUnlock, unlockWithQuickUnlock, refreshQuickUnlockCapability,
  } = useNotes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [lockedSeconds, setLockedSeconds] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [wiped, setWiped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Autofocus stays on the PIN field: the quick-unlock ceremony is NEVER
    // started automatically. iOS requires a user activation for
    // `navigator.credentials.get()` anyway, and a system sheet appearing by
    // itself on an unlock screen is a bad pattern regardless.
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (hasQuickUnlock) refreshQuickUnlockCapability();
  }, [hasQuickUnlock, refreshQuickUnlockCapability]);

  async function handleQuickUnlock() {
    setQuickBusy(true);
    setError('');
    try {
      await unlockWithQuickUnlock();
    } catch (err) {
      // Every quick-unlock class carries its own honest message, and none of
      // them is a wrong-PIN outcome: no attempt was spent, so the PIN counter
      // line below must not move either.
      setError(err instanceof Error ? err.message : 'Быстрый вход не выполнен.');
      inputRef.current?.focus();
    } finally {
      setQuickBusy(false);
    }
  }

  // A reload must not hide an active lockout — read persisted state on mount.
  useEffect(() => {
    let cancelled = false;
    void getPinLockState().then(st => {
      if (cancelled) return;
      setAttempts(st.attempts);
      if (st.lockedSeconds > 0) setLockedSeconds(st.lockedSeconds);
    }).catch(() => { /* storage unavailable — normal unlock flow still applies */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The guard lives HERE, not only on the button's `disabled`: Enter reaches
    // this function directly, so a disabled button alone would let a PIN
    // derivation start alongside a running quick-unlock ceremony. Two
    // concurrent unlocks would then race for openVault, the registration check
    // and the queue kick. The two contours' COUNTERS stay independent — this
    // is a UI interlock, not a shared limiter.
    if (loading || quickBusy) return;
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
        setWiped(true);
        setError('');
      } else if (err instanceof PinUnlockUnavailableError) {
        // Not a wrong PIN and not attempt-counted: the blob or the KDF runtime
        // failed (corrupt data, WASM/memory). Point at the seed path.
        setError('Не удалось открыть PIN-хранилище (ошибка данных или устройства). Войдите по seed-фразе — заметки не пострадали.');
      } else if (err instanceof VaultMismatchError) {
        setError(err.message);
      } else if (err instanceof Error && err.message === 'wrong_pin') {
        setError('Неверный PIN-код');
      } else {
        // Post-decrypt failure (session setup / IndexedDB): the PIN was CORRECT
        // and no attempt was spent — don't mislabel it as a wrong PIN.
        setError('PIN принят, но вход не удался (ошибка хранилища). Попробуйте ещё раз или войдите по seed-фразе.');
      }
      // Refresh the persisted attempt counter for the warning line.
      void getPinLockState().then(st => setAttempts(st.attempts)).catch(() => {});
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

  if (wiped) {
    return (
      <div className="screen-center">
        <div className="card onboarding">
          <div className="logo-icon"><InfinityMark /></div>
          <h1>PIN удалён</h1>
          <p className="subtitle">
            После 10 неудачных попыток PIN-код был удалён. Заметки не пострадали —
            войдите по seed-фразе и при желании установите новый PIN в настройках.
          </p>
          <button className="btn btn-primary" onClick={goToRestore}>
            Восстановить по seed-фразе
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon"><InfinityMark /></div>
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
          // Also disabled while EITHER attempt runs: an editable field next to
          // an inert button reads as «type here», and Enter must not start a
          // second unlock.
          disabled={isLocked || loading || quickBusy}
          // Back-applied anti-autofill set: a manager that silently saves the
          // master PIN to a third-party cloud breaks the E2E model.
          {...SECRET_PASSWORD_FIELD_PROPS}
        />

        {error && <div className="error-msg" role="alert">{error}</div>}

        {attempts >= 3 && !isLocked && (
          <div className="pin-attempts">
            Попытка {attempts} из 10 — после 10-й PIN будет удалён,
            вход останется только по seed-фразе.
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={handleUnlock}
          // Mutually exclusive with the quick-unlock attempt: two ceremonies at
          // once would race. The two contours' counters stay INDEPENDENT — this
          // is a UI interlock, not a shared limiter.
          disabled={loading || quickBusy || pin.length < 4 || isLocked}
        >
          {loading ? 'Разблокировка...' : 'Разблокировать'}
        </button>

        {/* Shown only when a valid record exists. The label deliberately names
            NO modality: the web cannot tell Windows Hello from Face ID from a
            device passcode, so «Отпечаток» or «Биометрия» on this button would
            be a lie. NOT disabled during a PIN lockout — the other contour has
            its own (hardware) rate limit. */}
        {hasQuickUnlock && (
          <button
            className="btn btn-outline"
            onClick={handleQuickUnlock}
            disabled={loading || quickBusy}
          >
            {quickBusy ? 'Проверка устройства...' : 'Быстрый вход'}
          </button>
        )}

        <button className="btn btn-ghost" onClick={goToRestore}>
          Ввести seed-фразу вручную
        </button>
      </div>
    </div>
  );
}
