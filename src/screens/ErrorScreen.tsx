import { useState } from 'react';
import { useNotes } from '../lib/store';
import { InfinityMark } from '../components/icons';

export function ErrorScreen() {
  const { bootError, storageOutdated, resetBrokenStorage } = useNotes();
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  async function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    try {
      await resetBrokenStorage(); // reloads the page on success
    } catch {
      // Failure details are already surfaced via bootError by the store —
      // re-enable the button so the user can retry after closing other tabs.
      setResetting(false);
      setConfirmReset(false);
    }
  }

  // A NEWER client already migrated this database. The data is intact and
  // fully readable by that build, so the ONLY offer here is «reload»: the
  // destructive reset below would delete every unsynced note and safebox
  // entry, and it is reachable in two clicks on the generic screen.
  if (storageOutdated) {
    return (
      <div className="screen-center">
        <div className="card onboarding">
          <div className="logo-icon"><InfinityMark /></div>
          <h1>Приложение обновилось</h1>
          <p className="subtitle">
            Данные на устройстве уже обновлены более новой версией приложения —
            возможно, в другой вкладке. <strong>Ничего не потеряно.</strong>
            Перезагрузите страницу, чтобы продолжить в новой версии; если
            открыта старая вкладка, закройте её и обновите установленное
            приложение.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-center">
      <div className="card onboarding">
        <div className="logo-icon"><InfinityMark /></div>
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
            Все локальные данные будут удалены. Заметки, сохранённые в
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
