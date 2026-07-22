import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (no Google CDN → privacy + offline + CSP font-src 'self').
// Family names match those referenced in index.css ('Outfit', 'JetBrains Mono').
import '@fontsource/outfit/300.css'
import '@fontsource/outfit/400.css'
import '@fontsource/outfit/500.css'
import '@fontsource/outfit/600.css'
import '@fontsource/outfit/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
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
