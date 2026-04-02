import { NotesProvider, useNotes } from './lib/store';
import { Landing } from './screens/Landing';
import { Onboarding } from './screens/Onboarding';
import { Restore } from './screens/Restore';
import { Main } from './screens/Main';
import './index.css';

function AppRouter() {
  const { screen } = useNotes();
  switch (screen) {
    case 'loading':
      return <div className="screen-center"><div className="loader" /></div>;
    case 'landing':
      return <Landing />;
    case 'onboarding':
      return <Onboarding />;
    case 'restore':
      return <Restore />;
    case 'main':
      return <Main />;
  }
}

export default function App() {
  return (
    <NotesProvider>
      <div className="app">
        <AppRouter />
      </div>
    </NotesProvider>
  );
}
