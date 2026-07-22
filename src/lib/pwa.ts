/**
 * PWA update flow (Phase 8 / M10) — controlled, never silent.
 *
 * vite-plugin-pwa runs with registerType:'prompt': a freshly-installed service
 * worker WAITS instead of skipWaiting-ing over the running app. When an update
 * is ready, subscribers (the Main screen's toast «Доступна новая версия») are
 * notified; applyPwaUpdate() then tells the new SW to take over and reloads.
 *
 * The 'virtual:pwa-register' module is imported DYNAMICALLY so this file stays
 * importable under vitest (the virtual module only exists in Vite builds).
 */

type Listener = (updateReady: boolean) => void;

let updateReady = false;
let doUpdate: (() => void) | null = null;
const listeners = new Set<Listener>();

export function initPwaUpdater(): void {
  if (!import.meta.env.PROD) return;
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      const updateSW = registerSW({
        onNeedRefresh() {
          updateReady = true;
          doUpdate = () => { void updateSW(true); }; // SKIP_WAITING + reload
          listeners.forEach(l => l(true));
        },
      });
    })
    .catch(err => console.error('SW registration failed:', err));
}

/** Subscribe to «update ready» state; called immediately with the current value. */
export function subscribeToPwaUpdate(listener: Listener): () => void {
  listeners.add(listener);
  listener(updateReady);
  return () => { listeners.delete(listener); };
}

/** User accepted the update toast → activate the waiting SW and reload. */
export function applyPwaUpdate(): void {
  doUpdate?.();
}
