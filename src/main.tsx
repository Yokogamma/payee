import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (no Google CDN → privacy + offline + CSP font-src 'self').
// Family names match those referenced in index.css ('Manrope', 'JetBrains Mono').
//
// PER-SUBSET IMPORTS, NOT PER-WEIGHT. `@fontsource/manrope/400.css` declares
// SIX @font-face — latin, latin-ext, cyrillic, cyrillic-ext, greek, vietnamese
// — so four weights would ship 24 woff2 for two alphabets nobody types here.
// Naming the subsets is the only way to choose; do not «simplify» this back.
//
// The four chosen subsets cover Russian, Ukrainian, Serbian and European
// diacritics. Note text is written by the USER, so narrowing further would drop
// a Ukrainian ї into the system font in the middle of a word.
//
// Weight 300 is gone: it was imported and used nowhere.
//
// Why Manrope at all: Outfit ships latin only, so every Cyrillic glyph in this
// Russian app was already a system fallback — the brand face drew two words.
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-ext-400.css'
import '@fontsource/manrope/cyrillic-400.css'
import '@fontsource/manrope/cyrillic-ext-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-ext-500.css'
import '@fontsource/manrope/cyrillic-500.css'
import '@fontsource/manrope/cyrillic-ext-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-ext-600.css'
import '@fontsource/manrope/cyrillic-600.css'
import '@fontsource/manrope/cyrillic-ext-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-ext-700.css'
import '@fontsource/manrope/cyrillic-700.css'
import '@fontsource/manrope/cyrillic-ext-700.css'
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
