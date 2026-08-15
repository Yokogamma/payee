/**
 * What users actually download: the Workbox precache manifest, broken down.
 *
 * The bundle budget deliberately measures gzipped JS only, so CSS and fonts are
 * invisible to it. That was fine while the font set was static; the Manrope
 * swap moved it from 28 files to 34, and updates here are prompt-gated, so a
 * user feels every accepted one.
 *
 * REPORT ONLY — no threshold, no exit code. A baseline has to exist before a
 * gate can be honest, and inventing one now would either be so loose it never
 * fires or so tight it fires on the next legitimate change. Print the number,
 * watch it across a few releases, then decide.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';

/** Every URL Workbox will precache, from the generated service worker. */
function manifestEntries() {
  const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
  // The plugin emits `precacheAndRoute([{url:"…",revision:"…"}, …])` — keys
  // UNQUOTED after minification, so accept both shapes.
  return [...sw.matchAll(/["']?url["']?:\s*"([^"]+)"/g)].map(m => m[1].replace(/^\//, ''));
}

function classify(url) {
  if (url.endsWith('.woff2') || url.endsWith('.woff')) {
    const family = url.split('/').pop().replace(/^(.*?)-(latin|cyrillic|greek|vietnamese).*/, '$1');
    return { group: 'fonts', detail: family };
  }
  if (url.endsWith('.js')) return { group: 'js', detail: 'js' };
  if (url.endsWith('.css')) return { group: 'css', detail: 'css' };
  if (/\.(png|svg|ico|webmanifest)$/.test(url)) return { group: 'assets', detail: 'assets' };
  return { group: 'other', detail: 'other' };
}

function kb(n) { return (n / 1024).toFixed(1).padStart(7) + ' KB'; }

function main() {
  if (!existsSync(join(DIST, 'sw.js'))) {
    console.error('dist/sw.js not found — run `npm run build` first.');
    process.exit(1);
  }
  const buckets = new Map();
  let totalRaw = 0, totalGz = 0, counted = 0, missing = 0;

  for (const url of manifestEntries()) {
    const path = join(DIST, url);
    if (!existsSync(path)) { missing++; continue; }
    const raw = statSync(path).size;
    // Fonts are already compressed; gzipping them again reports ~the same size,
    // which is the honest number for what goes over the wire.
    const gz = gzipSync(readFileSync(path), { level: 9 }).length;
    const { group, detail } = classify(url);
    const key = `${group}/${detail}`;
    const b = buckets.get(key) ?? { count: 0, raw: 0, gz: 0 };
    buckets.set(key, { count: b.count + 1, raw: b.raw + raw, gz: b.gz + gz });
    totalRaw += raw; totalGz += gz; counted++;
  }

  console.log(`Precache manifest: ${counted} entries${missing ? ` (${missing} unresolved)` : ''}\n`);
  for (const [key, b] of [...buckets].sort((a, b) => b[1].gz - a[1].gz)) {
    console.log(`  ${key.padEnd(28)} ${String(b.count).padStart(3)} files  ${kb(b.raw)} raw  ${kb(b.gz)} gz`);
  }
  console.log(`\n  ${'TOTAL'.padEnd(28)} ${String(counted).padStart(3)} files  ${kb(totalRaw)} raw  ${kb(totalGz)} gz`);
  console.log('\nReport only — no threshold yet. See the header comment.');
}

const invoked = process.argv[1]?.replace(/\\/g, '/');
if (invoked && import.meta.url === `file://${invoked.startsWith('/') ? '' : '/'}${invoked}`) {
  main();
}

export { classify, manifestEntries };
