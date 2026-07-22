// Vitest stand-in for the Vite-only 'virtual:pwa-register' module (aliased in
// vitest.config.ts). Tests never exercise real SW registration.
export function registerSW(): (reload?: boolean) => Promise<void> {
  return async () => {};
}
