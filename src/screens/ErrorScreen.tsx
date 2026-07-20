import { useState } from 'react';
import { useNotes } from '../lib/store';

export function ErrorScreen() {
  const { bootError, resetBrokenStorage } = useNotes();
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  async function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    await resetBrokenStorage();
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon">∞</div>
        <h1>Не удалось запустить</h1>
        <p className="subtitle">
          Хранилище на устройстве не открывается. Обычно помогает перезагрузка;
          если ошибка повторяется — сбросьте локальные данные.
        </p>

        {bootError && <div className="error-msg">{bootError}</div>}

        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Перезагрузить
        </button>

        {confirmReset && (
          <div className="seed-warning">
            ⚠️ Все локальные данные будут удалены. Заметки, сохранённые в
            блокчейне, можно вернуть по seed-фразе. Нажмите ещё раз для
            подтверждения.
          </div>
        )}

        <button className="btn btn-danger" onClick={handleReset} disabled={resetting}>
          {resetting ? 'Сброс...' : confirmReset ? 'Да, сбросить данные' : 'Сбросить данные'}
        </button>
      </div>
    </div>
  );
}
