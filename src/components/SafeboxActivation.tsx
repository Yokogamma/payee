import { useState } from 'react';
import { useNotes, SafeboxSamePinError, SafeboxSeedRequiredError, SafeboxSeedMismatchError } from '../lib/store';
import { SECRET_PASSWORD_FIELD_PROPS } from './secretFieldProps';
import { SeedEntryGrid } from './SeedEntryGrid';
import { emptySeedWords, emptySeedFlags } from '../lib/seed-words';
import { IconVault } from './icons';

/**
 * First activation of the safebox — and the ONLY honest place to say what the
 * PIN does and does not protect.
 *
 * When safebox DATA already exists but no PIN config does (new device, the
 * 10-strike wipe, a previous deactivation), the store demands the FULL seed
 * phrase, so this form shows the grid. The one exception — the session that
 * just restored from seed — is handled inside the store as a one-shot flag, and
 * the caller passes `dataPresent` so we can still offer the grid voluntarily.
 */

interface SafeboxActivationProps {
  /** Encrypted entries are already on this device. */
  dataPresent: boolean;
  entryCount: number;
  /** «Вечное хранилище» is off / the key is not registered → entries stay local
   *  and are NOT recoverable by seed. */
  syncInactive: boolean;
}

export function SafeboxActivation({ dataPresent, entryCount, syncInactive }: SafeboxActivationProps) {
  const { activateSafebox } = useNotes();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [words, setWords] = useState<string[]>(emptySeedWords);
  const [invalidWords, setInvalidWords] = useState<boolean[]>(emptySeedFlags);

  async function submit(withSeed: boolean) {
    if (pin.length < 6) { setError('Минимум 6 цифр'); return; }
    if (pin !== confirm) { setError('PIN-коды не совпадают'); return; }
    if (withSeed && words.some(w => !w)) { setError('Заполните все 12 слов'); return; }
    setBusy(true);
    setError('');
    try {
      await activateSafebox(pin, withSeed ? { mnemonic: words.join(' ').trim() } : undefined);
    } catch (err) {
      if (err instanceof SafeboxSeedRequiredError) {
        // Data exists and the one-shot post-restore window is gone: the seed is
        // the only way in. Reveal the grid instead of a dead end.
        setShowSeed(true);
        setError(err.message);
      } else if (err instanceof SafeboxSeedMismatchError) {
        setError('Эта seed-фраза не подходит к хранилищу на устройстве.');
      } else if (err instanceof SafeboxSamePinError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось установить PIN сейфа.');
      }
      return;
    } finally {
      setBusy(false);
    }
    setPin(''); setConfirm(''); setWords(emptySeedWords()); setInvalidWords(emptySeedFlags());
  }

  return (
    <div className="safebox-activation">
      <div className="logo-icon"><IconVault /></div>
      <h2>Защищённый сейф</h2>

      {dataPresent && (
        <div className="success-banner" role="status">
          Найден сейф: {entryCount} записей. Установите PIN, чтобы открыть.
        </div>
      )}

      <ul className="safebox-facts">
        <li>
          Пароли и небольшие файлы шифруются <strong>тем же seed</strong>, что и
          заметки, и хранятся в блокчейне навсегда — их можно восстановить на
          любом устройстве по seed-фразе.
        </li>
        <li>
          PIN сейфа — <strong>гейт доступа, а не крипто-граница</strong>: он
          защищает от взгляда через плечо и короткого доступа к открытому
          экрану. От того, у кого есть devtools или долгий доступ к открытой
          сессии, он не защищает.
        </li>
        <li>
          Старые версии паролей навсегда остаются в зашифрованной истории:
          удалить опубликованные данные из блокчейна невозможно.
        </li>
      </ul>

      <div className="seed-warning">
        <strong>Запишите seed-фразу сейчас.</strong> После активации сейфа
        просмотр seed-фразы в настройках будет закрыт PIN-кодом сейфа. Если
        забыть PIN и не иметь записанной фразы, доступ к сейфу не восстановить.
      </div>

      {syncInactive && (
        <div className="error-banner" role="alert">
          «Вечное хранилище» выключено или ключ не зарегистрирован — записи
          сейфа останутся только на этом устройстве и НЕ будут восстановимы по
          seed-фразе.
        </div>
      )}

      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        className="pin-input"
        name="sbx-new-code"
        id="sbx-new-code"
        placeholder="PIN сейфа (6–8 цифр)"
        value={pin}
        maxLength={8}
        onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
        {...SECRET_PASSWORD_FIELD_PROPS}
      />
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        className="pin-input"
        name="sbx-new-code-2"
        id="sbx-new-code-2"
        placeholder="Повторите PIN"
        value={confirm}
        maxLength={8}
        onChange={e => { setConfirm(e.target.value.replace(/\D/g, '')); setError(''); }}
        {...SECRET_PASSWORD_FIELD_PROPS}
      />

      {(showSeed || dataPresent) && (
        <>
          <p className="settings-hint">
            На этом устройстве уже есть записи сейфа. Чтобы установить новый PIN,
            введите полную seed-фразу — это подтверждает, что сейф ваш.
          </p>
          <SeedEntryGrid
            words={words}
            onChange={setWords}
            invalidWords={invalidWords}
            onInvalidChange={setInvalidWords}
            onEdit={() => setError('')}
            disabled={busy}
          />
        </>
      )}

      {error && <div className="error-msg" role="alert">{error}</div>}

      <button
        className="btn btn-primary full-width"
        disabled={busy}
        onClick={() => void submit((showSeed || dataPresent) && words.some(w => !!w))}
      >
        {busy ? 'Создаём сейф...' : 'Установить PIN и открыть сейф'}
      </button>
    </div>
  );
}

// ─── Seed reset (PIN forgotten / wiped) ─────────────────────────────

interface SafeboxSeedResetProps {
  onDone: () => void;
  onCancel: () => void;
}

/** «Сброс PIN сейфа»: full seed entry + a new PIN. DATA IS NEVER TOUCHED. */
export function SafeboxSeedReset({ onDone, onCancel }: SafeboxSeedResetProps) {
  const { resetSafeboxPinWithSeed } = useNotes();
  const [words, setWords] = useState<string[]>(emptySeedWords);
  const [invalidWords, setInvalidWords] = useState<boolean[]>(emptySeedFlags);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (words.some(w => !w)) { setError('Заполните все 12 слов'); return; }
    if (pin.length < 6) { setError('Минимум 6 цифр'); return; }
    if (pin !== confirm) { setError('PIN-коды не совпадают'); return; }
    setBusy(true);
    setError('');
    try {
      await resetSafeboxPinWithSeed(words.join(' ').trim(), pin);
    } catch (err) {
      if (err instanceof SafeboxSeedMismatchError) setError(err.message);
      else if (err instanceof SafeboxSamePinError) setError(err.message);
      else setError(err instanceof Error ? err.message : 'Не удалось сбросить PIN сейфа.');
      return;
    } finally {
      setBusy(false);
    }
    // Drop the ephemeral phrase before handing control back.
    setWords(emptySeedWords());
    setInvalidWords(emptySeedFlags());
    setPin(''); setConfirm('');
    onDone();
  }

  return (
    <div className="safebox-seed-reset">
      <h2>Сброс PIN сейфа</h2>
      <p className="subtitle">
        Введите полную seed-фразу и новый PIN. <strong>Записи сейфа
        сохранятся</strong> — сбрасывается только код доступа.
      </p>

      <SeedEntryGrid
        words={words}
        onChange={setWords}
        invalidWords={invalidWords}
        onInvalidChange={setInvalidWords}
        onEdit={() => setError('')}
        disabled={busy}
      />

      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        className="pin-input"
        name="sbx-reset-code"
        id="sbx-reset-code"
        placeholder="Новый PIN сейфа (6–8 цифр)"
        value={pin}
        maxLength={8}
        onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
        {...SECRET_PASSWORD_FIELD_PROPS}
      />
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        className="pin-input"
        name="sbx-reset-code-2"
        id="sbx-reset-code-2"
        placeholder="Повторите PIN"
        value={confirm}
        maxLength={8}
        onChange={e => { setConfirm(e.target.value.replace(/\D/g, '')); setError(''); }}
        {...SECRET_PASSWORD_FIELD_PROPS}
      />

      {error && <div className="error-msg" role="alert">{error}</div>}

      <button className="btn btn-primary full-width" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Сбрасываем...' : 'Сбросить PIN сейфа'}
      </button>
      <button className="btn btn-ghost full-width" disabled={busy} onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}
