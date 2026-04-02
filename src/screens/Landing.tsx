import { useNotes } from '../lib/store';

export function Landing() {
  const { goToOnboarding, goToRestore } = useNotes();

  return (
    <div className="screen-center">
      <div className="card landing-card">
        <div className="landing-hero">
          <div className="logo-icon landing-logo">∞</div>
          <h1>Eternal Notes</h1>
          <p className="subtitle">
            Заметки, которые живут вечно. Зашифрованы на устройстве. Хранятся в блокчейне.
          </p>
        </div>

        <div className="landing-features">
          <div className="feature">
            <span className="feature-icon">🔐</span>
            <div>
              <div className="feature-title">Шифрование на устройстве</div>
              <div className="feature-desc">AES-256-GCM. Только вы можете прочитать свои заметки.</div>
            </div>
          </div>

          <div className="feature">
            <span className="feature-icon">♾️</span>
            <div>
              <div className="feature-title">Вечное хранение</div>
              <div className="feature-desc">Arweave blockchain. Заметки невозможно удалить или потерять.</div>
            </div>
          </div>

          <div className="feature">
            <span className="feature-icon">🌱</span>
            <div>
              <div className="feature-title">12 слов = полный доступ</div>
              <div className="feature-desc">Seed-фраза — единственный ключ. Никаких паролей и аккаунтов.</div>
            </div>
          </div>
        </div>

        <div className="landing-actions">
          <button className="btn btn-primary" onClick={goToOnboarding}>
            Создать хранилище
          </button>
          <button className="btn btn-ghost" onClick={goToRestore}>
            У меня есть seed-фраза
          </button>
        </div>
      </div>
    </div>
  );
}
