// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { parseHash, parseParam, canonicalHash, navigate, useRoute, noteTarget, parseNoteTarget, SECTIONS, DEFAULT_SECTION } from './route';

// jsdom, not node: `location` and `history` do not exist in the node
// environment, and stubbing them would test the stub.

let seen: { hash: string; section: string; param: string | null } | undefined;

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
    // THE BACK-COMPAT PROOF for the item segment: the section is still matched
    // WHOLE, not by prefix, even though the hash is now split on the first
    // slash. Do not weaken these two.
    expect(parseHash('#/safeboxes')).toBe(DEFAULT_SECTION);
    expect(parseHash('#/note')).toBe(DEFAULT_SECTION);
  });

  it('reads the section off an addressed item', () => {
    expect(parseHash('#/notes/abc')).toBe('notes');
    expect(parseHash('#/settings/x')).toBe('settings');
  });
});

describe('parseParam', () => {
  it('reads the item a known section is addressing', () => {
    expect(parseParam('#/notes/abc-123')).toBe('abc-123');
  });

  it('is null when there is no item', () => {
    expect(parseParam('#/notes')).toBeNull();
    expect(parseParam('')).toBeNull();
    // An empty param is not an id — the canonicaliser rewrites it away.
    expect(parseParam('#/notes/')).toBeNull();
  });

  it('is null when the SECTION is unknown', () => {
    // Load-bearing: `#/zzz` degrades to the notes section, so reading a param
    // off it would make a junk address OPEN A NOTE.
    expect(parseParam('#/zzz/abc')).toBeNull();
  });
});

describe('canonicalHash', () => {
  it('is the only shape the app writes', () => {
    expect(canonicalHash('safebox')).toBe('#/safebox');
    expect(parseHash(canonicalHash('safebox'))).toBe('safebox');
  });

  it('round-trips an addressed item', () => {
    expect(canonicalHash('notes', 'abc')).toBe('#/notes/abc');
    expect(parseHash('#/notes/abc')).toBe('notes');
    expect(parseParam('#/notes/abc')).toBe('abc');
    // A null/absent param is the plain section, not a trailing slash.
    expect(canonicalHash('notes', null)).toBe('#/notes');
    expect(canonicalHash('notes')).toBe('#/notes');
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

  it('pushes an addressed item as a Back-able entry, marked as ours', () => {
    // The mark is what lets the reader tell «we pushed this» from «the user
    // arrived here directly», and therefore whether Back is safe to call.
    const before = window.history.length;
    navigate('notes', { param: 'abc' });
    expect(window.location.hash).toBe('#/notes/abc');
    expect(window.history.state).toEqual({ enSection: true });
    expect(window.history.length).toBe(before + 1);
  });

  it('ignores a repeat of the ACTIVE item too', () => {
    navigate('notes', { param: 'abc' });
    const after = window.history.length;
    navigate('notes', { param: 'abc' });
    expect(window.history.length).toBe(after);
  });

  it('replacing the item away leaves the plain section', () => {
    navigate('notes', { param: 'abc' });
    navigate('notes', { replace: true });
    expect(window.location.hash).toBe('#/notes');
  });
});

describe('useRoute', () => {
  it('reports the section the address already carries', () => {
    window.history.replaceState(null, '', '#/safebox');
    render(<Probe />);
    expect(seen).toEqual({ hash: '#/safebox', section: 'safebox', param: null });
  });

  it('re-renders on navigate — pushState fires no hashchange, so the emit is manual', () => {
    render(<Probe />);
    expect(seen?.section).toBe('notes');
    act(() => { navigate('safebox'); });
    expect(seen).toEqual({ hash: '#/safebox', section: 'safebox', param: null });
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

describe('parseNoteTarget — the chain and the version an address names', () => {
  it('a bare chain address carries no ordinal', () => {
    expect(parseNoteTarget('#/notes/abc')).toEqual({ root: 'abc', ordinal: null });
  });

  it('reads the ordinal of a version address', () => {
    expect(parseNoteTarget('#/notes/abc/v/1')).toEqual({ root: 'abc', ordinal: 1 });
    expect(parseNoteTarget('#/notes/abc/v/2')).toEqual({ root: 'abc', ordinal: 2 });
    // Three digits, to prove nothing is single-character about the parse.
    expect(parseNoteTarget('#/notes/abc/v/128')).toEqual({ root: 'abc', ordinal: 128 });
  });

  it.each([
    ['a zero', '#/notes/abc/v/0'],
    ['a negative', '#/notes/abc/v/-1'],
    ['a fraction', '#/notes/abc/v/2.5'],
    ['a leading zero', '#/notes/abc/v/02'],
    ['a word', '#/notes/abc/v/x'],
    ['an empty number', '#/notes/abc/v/'],
    ['a missing number', '#/notes/abc/v'],
    ['a fourth segment', '#/notes/abc/v/2/3'],
    ['an unknown marker', '#/notes/abc/zzz/2'],
  ])('degrades %s to the chain — the canonicaliser rewrites the address', (_label, hash) => {
    expect(parseNoteTarget(hash)).toEqual({ root: 'abc', ordinal: null });
  });

  it('a number too large to hold exactly is not an ordinal', () => {
    // The reason `isOrdinal` is not just a regex. Both assertions matter: the
    // first shows a digits-only check WOULD accept this, the second that the
    // parser does not.
    const huge = '9'.repeat(30);
    expect(/^[1-9][0-9]*$/.test(huge)).toBe(true);
    expect(Number.isSafeInteger(Number(huge))).toBe(false);
    expect(parseNoteTarget(`#/notes/abc/v/${huge}`)).toEqual({ root: 'abc', ordinal: null });
  });

  it('is null when the address names no chain at all', () => {
    expect(parseNoteTarget('#/notes')).toBeNull();
    expect(parseNoteTarget('#/notes/')).toBeNull();
    // Unknown section: degrading to «the notes section AND a note» would make a
    // junk address do something. Same rule as parseParam.
    expect(parseNoteTarget('#/zzz/abc')).toBeNull();
    expect(parseNoteTarget('#/zzz/abc/v/2')).toBeNull();
    // A param that starts with the separator has no root to name.
    expect(parseNoteTarget('#/notes//v/2')).toBeNull();
  });
});

describe('noteTarget — the address a version page is written to', () => {
  it('composes both shapes', () => {
    expect(noteTarget('abc')).toBe('abc');
    expect(noteTarget('abc', null)).toBe('abc');
    expect(noteTarget('abc', 2)).toBe('abc/v/2');
  });

  it.each([0, -1, 2.5, NaN, Infinity, 2 ** 60])(
    'drops an ordinal that is not one, rather than writing a junk address: %s',
    ordinal => {
      expect(noteTarget('abc', ordinal)).toBe('abc');
    },
  );

  it('round-trips with the parser — the canonicaliser compares these two', () => {
    // The canonicaliser rewrites whenever `hash !== canonicalHash(view, target)`.
    // If the builder and the parser disagreed on ANY shape, that comparison
    // would rewrite the address on every render.
    for (const ordinal of [null, 1, 2, 128]) {
      const target = noteTarget('abc', ordinal);
      expect(parseNoteTarget(canonicalHash('notes', target))).toEqual({ root: 'abc', ordinal });
    }
  });
});
