import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { parseTrustedOwners } from "./src/lib/trusted-owners";

export default defineConfig(({ command, mode }) => {
  // Fail-closed at build time (C2): production must pin a valid trusted wallet
  // set, otherwise restore would trust arbitrary on-chain transactions.
  // loadEnv reads .env files + process.env the same way the client build does,
  // and parseTrustedOwners is the SAME validator the runtime uses (format-checked).
  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "");
    const owners = parseTrustedOwners(env.VITE_TRUSTED_OWNERS ?? "");
    if (owners.length === 0) {
      throw new Error(
        "VITE_TRUSTED_OWNERS is empty. Set the proxy wallet address(es) before building — " +
          "restore requires a pinned root of trust.",
      );
    }
  }

  // Default '/' — the Cloudflare Pages layout. The old '/payee/' default was
  // the base of the retired GitHub Pages target (unpublished 2026-08-20): a
  // build without the variable used to produce artifacts for a target that no
  // longer exists. Both deploy paths still pass VITE_BASE explicitly.
  const base = process.env.VITE_BASE || "/";

  return {
    plugins: [
      react(),
      // Phase 8 (M10): build-generated precache of the hashed assets replaces
      // the old hand-written shell-only sw.js (whose first offline open could
      // fail because JS/CSS were never precached).
      VitePWA({
        // 'prompt': NO unconditional skipWaiting — the new SW waits until the
        // user accepts the «Доступна новая версия» toast (src/lib/pwa.ts),
        // which calls updateSW(true) → SKIP_WAITING + reload.
        registerType: "prompt",
        // NOTE: no includeAssets — public/ svg+png are already matched by the
        // workbox globPatterns below; listing them twice duplicated precache
        // manifest entries (round-15 LOW).
        manifest: {
          name: "Eternal Notes",
          short_name: "EternalNotes",
          description: "Вечные зашифрованные заметки в блокчейне",
          // start_url/scope default to the Vite base — correct for both targets.
          display: "standalone",
          // Both track the DARK palette's --bg: the OS paints the splash from
          // the manifest before any JS runs, so it cannot know the user's
          // preference and must match what :root renders unstyled.
          background_color: "#191612",
          theme_color: "#191612",
          orientation: "portrait-primary",
          categories: ["productivity", "utilities"],
          lang: "ru",
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            // Separate maskable with a safe-zone glyph — never 'any maskable'
            // on one file (platform masks would crop the any-variant corners).
            { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          // The manifest icons are auto-added by the plugin — excluding them
          // from the glob keeps every precache URL unique (round-15 LOW).
          //
          // The standalone backup viewer is excluded for a different reason: it
          // is an ARTIFACT the app hands the user and then verifies against a
          // compiled-in SHA-256 (D19), not a page the app navigates to. A
          // precached copy could be served in place of the freshly built one,
          // and the check would then be comparing the app's own stale cache
          // against its own constant — passing while telling the user nothing.
          globIgnores: ["**/icon-*.png", "backup-viewer.html"],
          // SPA offline navigation falls back to the precached shell.
          navigateFallback: `${base}index.html`,
          // ...but never for the viewer. It is a separate document, not a
          // route of this app, and answering its URL with the app shell would
          // hand the user a page that cannot open a backup and does not say
          // why. Belt to the `_redirects` rule's braces: that one governs the
          // server, this one governs the service worker.
          navigateFallbackDenylist: [/\/backup-viewer(\.html)?$/],
          // No runtimeCaching entries: proxy/Arweave requests stay network-only.
        },
      }),
    ],
    base,
    build: {
      outDir: "dist",
      sourcemap: false,
      // NEVER inline fonts as data: URIs. The CSP pins `font-src 'self'`
      // deliberately — allowing `data:` there would have to be a blanket
      // permission — so an inlined font is simply BLOCKED at runtime and that
      // glyph range silently falls back to a system font. Small @fontsource
      // subsets sit under the default 4 KB threshold, which is exactly how 9
      // of them ended up inlined and blocked in production.
      // `false` = never inline this file; `undefined` = keep the default rule
      // for everything else (images, etc.).
      assetsInlineLimit: (filePath: string) =>
        /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    },
  };
});
