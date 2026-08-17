import { useRef, useState } from 'react';
import { useNotes } from '../lib/store';
import { VaultMismatchError } from '../lib/store';
import { isValidMnemonic } from '../lib/crypto';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SeedEntryGrid } from '../components/SeedEntryGrid';
import { SECRET_PASSWORD_FIELD_PROPS } from '../components/secretFieldProps';
import { emptySeedWords, emptySeedFlags } from '../lib/seed-words';
import { InfinityMark } from '../components/icons';

/**
 * Two steps, mirroring onboarding: the phrase, then an OFFER to set a PIN.
 *
 * Without the second step everyone who enters this device «by seed phrase» —
 * a second device, a reinstall, any local data loss — stays without a PIN
 * forever, and since the session lives in sessionStorage that means retyping 12
 * words after every browser restart. The PIN itself is set INSIDE
 * restoreFromMnemonic, after the vault-identity check: this screen never writes
 * one and therefore never has to take one back.
 */
type Step = 'seed' | 'pin';

export function Restore() {
  const { restoreFromMnemonic, goToOnboarding, resetApp, vaultError, hasPin } = useNotes();
  const [step, setStep] = useState<Step>('seed');
  const [words, setWords] = useState<string[]>(emptySeedWords);
  const [invalidWords, setInvalidWords] = useState<boolean[]>(emptySeedFlags);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Synchronous, unlike the `loading` state: two fast clicks land in the same
  // React batch and would otherwise start two restores.
  const inFlightRef = useRef(false);

  // Show vault error from bootstrap if present
  const displayError = error || vaultError;
  const displayShowReset = showReset || !!vaultError;

  /** Step 1 → step 2. The checksum is verified HERE so nobody types a PIN for a
   *  phrase with a typo in it. */
  function handleContinue() {
    if (words.some(w => !w)) {
      setError('Заполните все 12 слов');
      return;
    }
    if (!isValidMnemonic(words.join(' ').trim())) {
      setError('Неверная seed-фраза. Проверьте слова.');
      return;
    }
    setError('');
    setStep('pin');
  }

  async function handleFinish(withPin: boolean) {
    if (inFlightRef.current) return;
    const mnemonic = words.join(' ').trim();
    if (words.some(w => !w)) {
      setError('Заполните все 12 слов');
      return;
    }
    if (withPin) {
      if (pinInput.length < 6) { setError('PIN — минимум 6 цифр'); return; }
      if (pinInput !== pinConfirm) { setError('PIN-коды не совпадают'); return; }
    }

    inFlightRef.current = true;
    setLoading(true);
    setError('');
    try {
      await restoreFromMnemonic(mnemonic, withPin ? { pin: pinInput } : undefined);
    } catch (err) {
      // Back to the phrase: whatever failed, the words are what needs fixing.
      setStep('seed');
      if (err instanceof VaultMismatchError) {
        setError(err.message);
        setShowReset(true);
      } else {
        setError('Неверная seed-фраза. Проверьте слова.');
      }
    } finally {
      inFlightRef.current = false;
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
        <div className="logo-icon"><InfinityMark /></div>

        {step === 'seed' && (
          <>
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
              disabled={loading}
            />

            {displayError && <div className="error-msg" role="alert">{displayError}</div>}

            {displayShowReset && (
              <button
                className="btn btn-danger full-width"
                disabled={loading}
                onClick={() => setConfirmReset(true)}
              >
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

            {/* With a PIN already configured on this device there is nothing to
                offer — this screen is then just the «войти по seed» path. */}
            {hasPin ? (
              <button
                className="btn btn-primary"
                onClick={() => handleFinish(false)}
                disabled={loading}
              >
                {loading ? 'Восстановление...' : 'Восстановить заметки →'}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleContinue}
                disabled={loading}
              >
                Далее →
              </button>
            )}

            <button className="btn btn-ghost" onClick={goToOnboarding} disabled={loading}>
              ← Создать новое хранилище
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
              name="restore-code" id="restore-code"
              placeholder="PIN (мин. 6 цифр)"
              value={pinInput}
              maxLength={8}
              disabled={loading}
              onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setError(''); }}
              {...SECRET_PASSWORD_FIELD_PROPS}
            />
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              className="pin-input"
              name="restore-code-2" id="restore-code-2"
              placeholder="Повторите PIN"
              value={pinConfirm}
              maxLength={8}
              disabled={loading}
              onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, '')); setError(''); }}
              {...SECRET_PASSWORD_FIELD_PROPS}
            />

            {error && <div className="error-msg" role="alert">{error}</div>}

            <button
              className="btn btn-primary"
              disabled={loading || pinInput.length < 6 || pinInput !== pinConfirm}
              onClick={() => handleFinish(true)}
            >
              {loading ? 'Восстановление...' : 'Установить PIN и восстановить →'}
            </button>
            <button
              className="btn btn-ghost"
              disabled={loading}
              onClick={() => handleFinish(false)}
            >
              Пропустить — войти без PIN
            </button>
            <button
              className="btn btn-ghost"
              disabled={loading}
              onClick={() => { setError(''); setStep('seed'); }}
            >
              ← Назад к seed-фразе
            </button>
          </>
        )}
      </div>
    </div>
  );
}
