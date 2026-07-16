/**
 * Generate dist/_headers with a strict CSP whose connect-src is pinned to the
 * real proxy origin (from VITE_PROXY_URL). Runs after `vite build`.
 *
 * The URL is validated: parsed via new URL(), only its .origin is used, and a
 * non-localhost origin MUST be https. An empty/invalid value fails the build so
 * a broken CSP can never ship.
 */
import { writeFileSync } from 'node:fs';

const raw = process.env.VITE_PROXY_URL ?? '';

let origin;
try {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!local && u.protocol !== 'https:') {
    throw new Error('a non-localhost proxy origin must use https');
  }
  origin = u.origin;
} catch (e) {
  throw new Error(`gen-headers: invalid VITE_PROXY_URL "${raw}": ${e.message}`);
}

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

const content = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

writeFileSync('dist/_headers', content);
console.log(`gen-headers: wrote dist/_headers (connect-src proxy = ${origin})`);
