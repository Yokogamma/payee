import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (no Google CDN → privacy + offline + CSP font-src 'self').
//
// The sixteen per-subset @fontsource imports that used to sit here are now
// twelve hand-written @font-face in fonts.css. That file explains why at
// length; the short version is that the choice they encoded — name the
// subsets, never take the per-weight entrypoint, never ship greek and
// vietnamese to a Russian notes app — cannot be expressed as an import for a
// VARIABLE family, because @fontsource-variable publishes no per-subset CSS.
//
// Family names match those referenced in index.css ('Literata Variable',
// 'PT Mono').
import './fonts.css'
import './index.css'
import App from './App.tsx'
import { initPwaUpdater } from './lib/pwa'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Workbox-generated SW (vite-plugin-pwa): precached hashed assets + a
// controlled update flow — the new version activates only after the user
// accepts the update toast (src/lib/pwa.ts).
initPwaUpdater()
