// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadThemePref } from './theme';

// jsdom: `localStorage`, `matchMedia` and the document are the whole subsystem.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('loadThemePref', () => {
  it('accepts every explicit theme, warm included', () => {
    for (const t of ['dark', 'light', 'warm']) {
      localStorage.setItem('theme', t);
      expect(loadThemePref()).toBe(t);
    }
  });

  it('nothing stored means «follow the system»', () => {
    expect(loadThemePref()).toBe('system');
  });

  it('an UNKNOWN value degrades to system — this is what makes a rollback safe', () => {
    // A user picks a theme a newer build has, then loads an older build. The
    // old parser must produce «system», not a data-theme nobody styles.
    localStorage.setItem('theme', 'midnight');
    expect(loadThemePref()).toBe('system');
  });

  it('a corrupted entry degrades too, rather than throwing', () => {
    localStorage.setItem('theme', '{"nope":1}');
    expect(loadThemePref()).toBe('system');
  });

  it('«system» is never stored as a value — it is the absence of one', () => {
    localStorage.setItem('theme', 'system');
    expect(loadThemePref()).toBe('system');
  });
});
