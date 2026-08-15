// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { parseHash, canonicalHash, navigate, useRoute, SECTIONS, DEFAULT_SECTION } from './route';

// jsdom, not node: `location` and `history` do not exist in the node
// environment, and stubbing them would test the stub.

let seen: { hash: string; section: string } | undefined;

function Probe() {
  const route = useRoute();
  // Written from an effect, not during render — read only after act() flushes.
  useEffect(() => { seen = route; });
  return null;
}

beforeEach(() => {
  window.history.replaceState(null, '', '#/notes');
  seen = undefined;
});
afterEach(cleanup);

describe('parseHash', () => {
  it('accepts every declared section', () => {
    for (const s of SECTIONS) expect(parseHash(`#/${s}`)).toBe(s);
  });

  it('degrades an unknown section to the default instead of rendering nothing', () => {
    // The rollback case: a newer build wrote a section this one does not have.
    // Falling back beats a blank screen.
    expect(parseHash('#/feed')).toBe(DEFAULT_SECTION);
    expect(parseHash('#/zzz')).toBe(DEFAULT_SECTION);
  });

  it('degrades an empty hash — an old build never wrote one', () => {
    expect(parseHash('')).toBe(DEFAULT_SECTION);
    expect(parseHash('#')).toBe(DEFAULT_SECTION);
  });

  it('tolerates a missing slash', () => {
    expect(parseHash('#safebox')).toBe('safebox');
  });

  it('does not accept a prefix of a real section', () => {
    expect(parseHash('#/safeboxes')).toBe(DEFAULT_SECTION);
    expect(parseHash('#/note')).toBe(DEFAULT_SECTION);
  });
});

describe('canonicalHash', () => {
  it('is the only shape the app writes', () => {
    expect(canonicalHash('safebox')).toBe('#/safebox');
    expect(parseHash(canonicalHash('safebox'))).toBe('safebox');
  });
});

describe('navigate', () => {
  it('pushes a history entry and marks it as ours', () => {
    const before = window.history.length;
    navigate('safebox');
    expect(window.location.hash).toBe('#/safebox');
    expect(window.history.state).toEqual({ enSection: true });
    expect(window.history.length).toBe(before + 1);
  });

  it('replace does not grow the stack and is NOT marked as ours', () => {
    const before = window.history.length;
    navigate('safebox', { replace: true });
    expect(window.location.hash).toBe('#/safebox');
    expect(window.history.state).toEqual({ enSection: false });
    expect(window.history.length).toBe(before);
  });

  it('ignores a repeat of the ACTIVE section — no stack to Back through', () => {
    navigate('safebox');
    const after = window.history.length;
    navigate('safebox');
    navigate('safebox');
    expect(window.history.length).toBe(after);
  });
});

describe('useRoute', () => {
  it('reports the section the address already carries', () => {
    window.history.replaceState(null, '', '#/safebox');
    render(<Probe />);
    expect(seen).toEqual({ hash: '#/safebox', section: 'safebox' });
  });

  it('re-renders on navigate — pushState fires no hashchange, so the emit is manual', () => {
    render(<Probe />);
    expect(seen?.section).toBe('notes');
    act(() => { navigate('safebox'); });
    expect(seen).toEqual({ hash: '#/safebox', section: 'safebox' });
  });

  it('notices a JUNK hash typed over an ACTIVE section', () => {
    // The regression the raw-hash snapshot exists for: both hashes parse to
    // 'notes', so a snapshot of the parsed section would be unchanged, React
    // would skip the render, and the canonicaliser would never run.
    render(<Probe />);
    expect(seen?.hash).toBe('#/notes');
    act(() => {
      window.history.replaceState(null, '', '#/zzz');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(seen?.hash).toBe('#/zzz');
    expect(seen?.section).toBe('notes'); // parsed value unchanged — the hash is what moved
  });

  it('follows Back/Forward (popstate), not just hashchange', () => {
    render(<Probe />);
    act(() => { navigate('safebox'); });
    expect(seen?.section).toBe('safebox');
    act(() => {
      window.history.replaceState(null, '', '#/notes');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(seen?.section).toBe('notes');
  });

  it('detaches its window listeners on unmount', () => {
    const { unmount } = render(<Probe />);
    act(() => { navigate('safebox'); });
    const last = seen;
    unmount();
    act(() => {
      window.history.replaceState(null, '', '#/notes');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(seen).toBe(last); // the unmounted probe stopped hearing
  });
});
