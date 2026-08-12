import { NotesProvider, useNotes } from './lib/store';
import { Landing } from './screens/Landing';
import { Onboarding } from './screens/Onboarding';
import { Restore } from './screens/Restore';
import { PinUnlock } from './screens/PinUnlock';
import { Main } from './screens/Main';
import { ErrorScreen } from './screens/ErrorScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

function AppRouter() {
  const { screen, storageBlocked } = useNotes();
  switch (screen) {
    case 'loading':
      return (
        <div className="screen-center">
          {/* An old tab holding the previous IndexedDB schema blocks the
              upgrade: without this the first R4 tab spins here forever. The
              upgrade resumes automatically once that tab closes. */}
          {storageBlocked ? (
            <div className="card onboarding">
              <div className="logo-icon">∞</div>
              <h1>Закройте другие вкладки</h1>
              <p className="subtitle">
                Приложение обновляет локальное хранилище, но оно открыто в
                другой вкладке Eternal Notes. Закройте остальные вкладки и
                обновите страницу — обновление продолжится автоматически.
              </p>
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                Обновить страницу
              </button>
            </div>
          ) : (
            <div className="loader" role="status" aria-label="Загрузка" />
          )}
        </div>
      );
    case 'landing':
      return <Landing />;
    case 'onboarding':
      return <Onboarding />;
    case 'restore':
      return <Restore />;
    case 'pin':
      return <PinUnlock />;
    case 'main':
      return <Main />;
    case 'error':
      return <ErrorScreen />;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <NotesProvider>
        <div className="app">
          <AppRouter />
        </div>
      </NotesProvider>
    </ErrorBoundary>
  );
}
