import { useEffect, useState } from 'react';

/**
 * Theme preference: follow the OS by default, or force one.
 *
 * «warm» has no OS equivalent — `prefers-color-scheme` only knows light and
 * dark — so it can only ever be an explicit choice, never a `system` outcome.
 */
export type ThemePref = 'system' | 'dark' | 'light' | 'warm';

const THEME_KEY = 'theme';

/**
 * Backgrounds for the `theme-color` meta, which drives the Android status bar
 * and task-switcher chrome in standalone mode.
 *
 * A map rather than two constants: with three explicit themes the old
 * `dark ? DARK : LIGHT` boolean would have silently painted warm as light.
 * This is the touchpoint most easily missed, because the symptom only appears
 * on a real device with the PWA installed.
 */
const THEME_BG: Record<Exclude<ThemePref, 'system'>, string> = {
  dark: '#0a0a0f',
  light: '#f5f5f7',
  warm: '#f3ebdf',
};

const EXPLICIT: readonly ThemePref[] = ['dark', 'light', 'warm'];

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  // Anything unrecognised — a legacy value, a corrupted entry, or a theme from
  // a NEWER build after a rollback — degrades to «follow the system» rather
  // than to a broken attribute. That degradation is what makes a rollback safe,
  // so keep it even when adding a theme.
  return EXPLICIT.includes(v as ThemePref) ? (v as ThemePref) : 'system';
}

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  const effective: Exclude<ThemePref, 'system'> = pref !== 'system'
    ? pref
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[effective]);
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadThemePref);

  useEffect(() => {
    applyTheme(pref);
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);

    if (pref !== 'system') return;
    // In system mode, live-follow OS theme changes (theme-color included).
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  return [pref, setPref];
}
