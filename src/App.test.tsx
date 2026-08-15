// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The store is never reached in these tests — the failure happens before the
// provider renders — but the module still gets imported, so keep it cheap.
vi.mock('./lib/store', () => ({
  NotesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useNotes: () => ({ screen: 'loading', storageBlocked: false }),
}));

import App from './App';

// jsdom has no matchMedia; `applyTheme` needs it to resolve «system».
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App — the crash guard is mounted before anything reads storage', () => {
  it('падающий localStorage даёт экран ошибки, а не белую страницу', () => {
    // `useTheme` reads localStorage synchronously. Called in App's own body it
    // would run BEFORE the ErrorBoundary that App returns has mounted, and a
    // throw there produces a blank page instead of the guard. That is why the
    // hook lives in a CHILD of the boundary.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    // The boundary logs the caught error; keep the run quiet.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    // Something is on screen, and it is not an empty document.
    expect(document.body.textContent?.trim()).not.toBe('');
    expect(screen.getAllByText(/Перезагрузить/i).length).toBeGreaterThan(0);
  });

  it('без сбоя хранилища приложение рендерится обычным образом', () => {
    render(<App />);
    expect(document.querySelector('.app')).toBeTruthy();
  });
});
