/**
 * Post-build patcher. Runs after `vite build`.
 *
 * - Injects the deploy base path (VITE_BASE, default '/payee/') into the static
 *   assets Vite copies verbatim from public/: sw.js (BASE) and manifest.json
 *   (start_url/scope). index.html is already base-aware via Vite.
 * - Stamps the service worker cache name with the build SHA.
 * - Writes dist/_headers with a strict CSP whose connect-src is pinned to the
 *   validated VITE_PROXY_URL origin (only its .origin; non-localhost must be
 *   https; empty/invalid fails the build).
 *
 * For Cloudflare Pages set VITE_BASE=/ ; for GitHub Pages leave the default.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.env.VITE_BASE || '/payee/';
const sha = process.env.BUILD_SHA || 'dev';
const rawProxy = process.env.VITE_PROXY_URL || '';

let origin;
try {
  const u = new URL(rawProxy);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!local && u.protocol !== 'https:') throw new Error('a non-localhost proxy origin must use https');
  origin = u.origin;
} catch (e) {
  throw new Error(`postbuild: invalid VITE_PROXY_URL "${rawProxy}": ${e.message}`);
}

// ── Patch service worker (base + cache-busting build hash) ──
let sw = readFileSync('dist/sw.js', 'utf8');
sw = sw.replaceAll('__BASE__', base).replaceAll('__BUILD_HASH__', sha);
writeFileSync('dist/sw.js', sw);

// ── Patch manifest (base into start_url/scope) ──
let manifest = readFileSync('dist/manifest.json', 'utf8');
manifest = manifest.replaceAll('__BASE__', base);
writeFileSync('dist/manifest.json', manifest);

// ── Write _headers with CSP ──
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // wasm-unsafe-eval: Argon2 (hash-wasm)
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' https://arweave.net ${origin}`,
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

writeFileSync('dist/_headers', `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);

console.log(`postbuild: base=${base} sha=${sha} connect-src proxy=${origin}`);
