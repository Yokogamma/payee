import { useState, useRef, useEffect } from 'react';
import {
  useNotes,
  SafeboxPinLockedError,
  SafeboxPinWipedError,
  SafeboxNotConfiguredError,
  SafeboxConfigChangedError,
} from '../lib/store';
import { SafeboxPinUnavailableError } from '../lib/crypto';
import { SECRET_PASSWORD_FIELD_PROPS } from './secretFieldProps';

/**
 * Safebox unlock pad — the PinUnlock screen's shape, but for the SECOND PIN
 * contour. Same honest error taxonomy: only a genuinely wrong PIN is reported
 * as such; an unavailable KDF/blob and a config replaced in another tab get
 * their own messages and never look like a user mistake.
 */

interface SafeboxPinPadProps {
  /** «Сбросить PIN по seed-фразе» — opens the seed-reset modal. */
  onRequestSeedReset: () => void;
}

export function SafeboxPinPad({ onRequestSeedReset }: SafeboxPinPadProps) {
  const { unlockSafebox, getSafeboxPinLockState } = useNotes();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockedSeconds, setLockedSeconds] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [wiped, setWiped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // A reload must not hide an active lockout — read the persisted state.
  useEffect(() => {
    let cancelled = false;
    void getSafeboxPinLockState().then(st => {
      if (cancelled) return;
      setAttempts(st.attempts);
      if (st.lockedSeconds > 0) setLockedSeconds(st.lockedSeconds);
    }).catch(() => { /* storage hiccup — the normal unlock flow still applies */ });
    return () => { cancelled = true; };
  }, [getSafeboxPinLockState]);

  useEffect(() => {
    if (lockedSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockedSeconds(prev => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedSeconds]);

  function formatLockTime(seconds: number): string {
    return seconds >= 60 ? `${Math.ceil(seconds / 60)} мин` : `${seconds} сек`;
  }

  async function handleUnlock() {
    if (pin.length < 6 || lockedSeconds > 0) return;
    setLoading(true);
    setError('');
    try {
      await unlockSafebox(pin);
    } catch (err) {
      if (err instanceof SafeboxPinLockedError) {
        setLockedSeconds(err.secondsLeft);
        setError(`Слишком много попыток. Подождите ${formatLockTime(err.secondsLeft)}`);
      } else if (err instanceof SafeboxPinWipedError) {
        setWiped(true);
        setError('');
      } else if (err instanceof SafeboxPinUnavailableError) {
        setError('Не удалось проверить PIN сейфа (ошибка данных или устройства). '
          + 'Записи не пострадали — сбросьте PIN по seed-фразе.');
      } else if (err instanceof SafeboxConfigChangedError) {
        setError('PIN сейфа изменили в другой вкладке. Обновите страницу и попробуйте снова.');
      } else if (err instanceof SafeboxNotConfiguredError) {
        setError('PIN сейфа не установлен на этом устройстве.');
      } else {
        setError('Неверный PIN сейфа');
      }
      void getSafeboxPinLockState().then(st => setAttempts(st.attempts)).catch(() => {});
      setPin('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  if (wiped) {
    return (
      <div className="safebox-gate">
        <div className="logo-icon">🔐</div>
        <h2>PIN сейфа удалён</h2>
        <p className="subtitle">
          После 10 неудачных попыток PIN-код сейфа удалён. <strong>Записи не
          пострадали</strong> — восстановите доступ, введя полную seed-фразу.
        </p>
        <button className="btn btn-primary" onClick={onRequestSeedReset}>
          Восстановить по seed-фразе
        </button>
      </div>
    );
  }

  const isLocked = lockedSeconds > 0;

  return (
    <div className="safebox-gate">
      <div className="logo-icon">🔐</div>
      <h2>Сейф заблокирован</h2>
      <p className="subtitle">Введите PIN сейфа</p>

      <input
        ref={inputRef}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        className="pin-input"
        // Deliberately NON-heuristic name/id: `password`/`pin` would invite
        // browser and cloud managers to save it.
        name="sbx-gate-code"
        id="sbx-gate-code"
        placeholder={isLocked ? `Заблокирован (${formatLockTime(lockedSeconds)})` : 'PIN сейфа'}
        value={pin}
        maxLength={8}
        onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleUnlock(); } }}
        disabled={isLocked}
        {...SECRET_PASSWORD_FIELD_PROPS}
      />

      {error && <div className="error-msg" role="alert">{error}</div>}

      {attempts >= 3 && !isLocked && (
        <div className="pin-attempts">
          Попытка {attempts} из 10 — после 10-й PIN сейфа будет удалён,
          доступ останется только по seed-фразе. Записи при этом сохранятся.
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={() => void handleUnlock()}
        disabled={loading || pin.length < 6 || isLocked}
      >
        {loading ? 'Открываем...' : 'Открыть сейф'}
      </button>

      <button className="btn btn-ghost" onClick={onRequestSeedReset}>
        Сбросить PIN сейфа по seed-фразе
      </button>
      <p className="settings-hint">
        PIN сейфа можно сбросить только вводом полной seed-фразы. Записи при
        этом не удаляются.
      </p>
    </div>
  );
}
