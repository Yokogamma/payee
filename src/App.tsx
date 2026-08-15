import { NotesProvider, useNotes } from './lib/store';
import { Landing } from './screens/Landing';
import { Onboarding } from './screens/Onboarding';
import { Restore } from './screens/Restore';
import { PinUnlock } from './screens/PinUnlock';
import { Main } from './screens/Main';
import { ErrorScreen } from './screens/ErrorScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useTheme, type ThemePref } from './lib/theme';
import './index.css';

interface RouterProps {
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
}

function AppRouter({ theme, onThemeChange }: RouterProps) {
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
      return <Main theme={theme} onThemeChange={onThemeChange} />;
    case 'error':
      return <ErrorScreen />;
  }
}

/**
 * Applies the theme and owns the provider.
 *
 * A SEPARATE COMPONENT, not App's own body: `useTheme` reads localStorage
 * synchronously, and a hook called in App would run BEFORE the ErrorBoundary
 * it returns has mounted. A storage failure (private mode, blocked storage,
 * quota) would then produce a blank page instead of the crash guard.
 */
function ThemedApp() {
  const [theme, setTheme] = useTheme();
  return (
    <NotesProvider>
      <div className="app">
        <AppRouter theme={theme} onThemeChange={setTheme} />
      </div>
    </NotesProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemedApp />
    </ErrorBoundary>
  );
}
