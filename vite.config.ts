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

  // '/payee/' for GitHub Pages (default); set VITE_BASE=/ for Cloudflare Pages.
  const base = process.env.VITE_BASE || "/payee/";

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
          background_color: "#0a0a0f",
          theme_color: "#0a0a0f",
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
          globIgnores: ["**/icon-*.png"],
          // SPA offline navigation falls back to the precached shell.
          navigateFallback: `${base}index.html`,
          // No runtimeCaching entries: proxy/Arweave requests stay network-only.
        },
      }),
    ],
    base,
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
