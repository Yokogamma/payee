import { useEffect, useState } from 'react';

/** Three-way theme preference (7.4): follow the OS by default, or force one. */
export type ThemePref = 'system' | 'dark' | 'light';

const THEME_KEY = 'theme';
const DARK_BG = '#0a0a0f';
const LIGHT_BG = '#f5f5f7';

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  // Legacy values from the 2-way toggle ('dark'/'light') stay valid choices;
  // anything else (or nothing) means "follow the system".
  return v === 'dark' || v === 'light' ? v : 'system';
}

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  // Keep the PWA chrome (status bar / task switcher) in sync with the shell.
  const dark = pref === 'dark'
    || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? DARK_BG : LIGHT_BG);
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
