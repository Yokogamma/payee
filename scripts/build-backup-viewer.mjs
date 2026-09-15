// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Build the standalone backup viewer: one HTML file, no network, no WASM.
 *
 * It runs FIRST, before the PWA build, because the PWA compiles the viewer's
 * SHA-256 into itself (D19) — the app offers the file for download and checks
 * what it got against that constant. So the order is: build the viewer →
 * write its hash into a source module → build the PWA → copy the SAME bytes
 * into dist without rebuilding. Rebuilding at the end would risk a file whose
 * hash the app no longer recognises.
 *
 * The self-checks below are not decoration. This artifact is the last resort
 * in the recovery formula — the copy a user opens when the project is gone and
 * nothing else is left — so the build refuses to emit a file that:
 *
 *  - references any `http(s)://` URL: the page must work with no network at
 *    all, and a single stray reference is both a failure mode and a beacon;
 *  - carries WebAssembly: an artifact whose whole value is «anyone can read
 *    what this does» must not ship an opaque binary;
 *  - is missing the anti-autofill attributes on the seed field: a password
 *    manager that saves a seed phrase exports the entire vault;
 *  - has grown past the size ceiling, which is the practical proxy for «still
 *    auditable, still savable anywhere».
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = resolve(ROOT, 'viewer/index.html');
const STYLE = resolve(ROOT, 'viewer/style.css');
const ENTRY = resolve(ROOT, 'viewer/main.ts');
const OUT = resolve(ROOT, 'public/backup-viewer.html');
const HASH_MODULE = resolve(ROOT, 'src/lib/backup-viewer-hash.ts');

/** Practical ceiling, not a budget to spend: the file has to stay something a
 *  person can save anywhere and, in principle, read. */
export const VIEWER_MAX_BYTES = 300 * 1024;

const sha256 = (input) => createHash('sha256').update(input).digest('base64');
const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');

/** Every rule the emitted artifact must satisfy. Exported so the test can run
 *  them against crafted inputs as well as against the real build. */
export function checkViewerArtifact(html) {
  const problems = [];
  const bytes = Buffer.byteLength(html, 'utf8');

  if (/https?:\/\//i.test(html)) {
    problems.push('artifact references an http(s) URL — the viewer must work with no network at all');
  }
  if (/hash-wasm|WebAssembly/.test(html)) {
    problems.push('artifact carries WebAssembly — it must stay readable, and the PIN path is unreachable here');
  }
  if (bytes > VIEWER_MAX_BYTES) {
    problems.push(`artifact is ${bytes} bytes, over the ${VIEWER_MAX_BYTES} ceiling`);
  }
  // D20 names TWO groups of attributes on the seed field, and the check used to
  // know only the first. A password manager that saves a seed phrase exports
  // the whole vault; a spellchecker or an autocorrect dictionary that swallows
  // one leaks it to a cloud service the user never chose — and on mobile the
  // second path is the likelier one, because the keyboard is doing it by
  // default. Both groups are required, so both are checked.
  for (const attribute of [
    'data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type',
    'spellcheck', 'autocapitalize', 'autocorrect',
  ]) {
    if (!html.includes(attribute)) {
      problems.push(`seed field is missing ${attribute} — a seed phrase must not reach a manager, `
        + 'a dictionary or a cloud spellchecker');
    }
  }
  // D19(в): the page must ask for an INDEPENDENT copy of the checksum before a
  // seed phrase is typed into it. It is one paragraph of prose and nothing in
  // the build depended on it, so deleting it broke no test — while removing
  // precisely the sentence that stops a substituted viewer from being trusted.
  if (!/Сверьте хеш с независимой копией/.test(html)) {
    problems.push('artifact does not ask the user to check the hash against an independent copy (D19)');
  }
  if (!/Content-Security-Policy/.test(html) || !/default-src 'none'/.test(html)) {
    problems.push('artifact has no fail-closed Content-Security-Policy');
  }
  return problems;
}

export async function buildBackupViewer({ write = true } = {}) {
  const bundled = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    // Argon2 lives behind a dynamic import on the PIN path, which this page
    // cannot enter. Aliased to a throwing stub so no WASM is bundled and the
    // failure would be loud if that ever changed.
    alias: { 'hash-wasm': resolve(ROOT, 'viewer/stubs/hash-wasm.ts') },
    define: { 'import.meta.env.VITE_PROXY_URL': '""', 'import.meta.env.VITE_TRUSTED_OWNERS': '""' },
  });

  const js = bundled.outputFiles[0].text;
  const css = readFileSync(STYLE, 'utf8');

  // Hash-based CSP, so the page authorizes exactly its own two blobs and
  // nothing else — including nothing a later editor might inject.
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256(js)}'`,
    `style-src 'sha256-${sha256(css)}'`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const html = readFileSync(TEMPLATE, 'utf8')
    .replace('__CSP__', csp)
    .replace('__CSS__', () => css)
    .replace('__JS__', () => js);

  const problems = checkViewerArtifact(html);
  if (problems.length > 0) {
    throw new Error(`build-backup-viewer refused to emit:\n - ${problems.join('\n - ')}`);
  }

  const hash = sha256Hex(html);
  if (write) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html, 'utf8');
    writeFileSync(HASH_MODULE, renderHashModule(hash), 'utf8');
  }
  return { html, hash, bytes: Buffer.byteLength(html, 'utf8') };
}

/** The constant the PWA compiles in. Committed as a stub that is explicitly
 *  marked invalid, so a clean checkout imports something typed and obviously
 *  unusable rather than something plausible and stale. */
export function renderHashModule(hash) {
  return `/**
 * SHA-256 of \`public/backup-viewer.html\`, regenerated by
 * \`scripts/build-backup-viewer.mjs\` as the FIRST step of \`npm run build\`.
 *
 * The app compiles this in and checks the file it hands the user against it
 * (D19). That closes the DELIVERY channel — a download corrupted or swapped in
 * transit — and nothing more: an attacker who can rewrite the saved file can
 * rewrite a checksum stored beside it just as easily. Authenticity therefore
 * rests on the user keeping this value somewhere independent, and the app says
 * so in as many words.
 *
 * DO NOT EDIT BY HAND.
 */
export const BACKUP_VIEWER_SHA256 = '${hash}';

/** True when the constant above is the placeholder from a clean checkout
 *  rather than a real build output. Consumers must refuse to present the
 *  download as verified while this holds. */
export const BACKUP_VIEWER_HASH_IS_PLACEHOLDER = ${hash === PLACEHOLDER ? 'true' : 'false'};
`;
}

export const PLACEHOLDER = 'not-built-yet';

// CLI: `node scripts/build-backup-viewer.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildBackupViewer().then(
    ({ hash, bytes }) => console.log(`backup-viewer.html: ${bytes} bytes, sha256 ${hash}`),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); },
  );
}
