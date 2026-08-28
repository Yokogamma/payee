/**
 * Post-deploy smoke test: fetch the deployed site and assert that the security
 * headers are actually applied (they are NOT on GitHub Pages — this verifies
 * the Cloudflare Pages cutover really took effect), and that the standalone
 * backup viewer is served as its own document under exactly one policy.
 *
 * The viewer half is not a formality. Its route is a 200 rewrite living above
 * a catch-all SPA fallback, and its policy is a per-path UNSET of the site CSP
 * — three pieces of edge configuration that fail silently and in ways nobody
 * notices until someone opens the file offline, years later, with no way to
 * report the problem. So each is checked against the live deployment rather
 * than assumed from the source that generated it.
 *
 * Usage: node scripts/smoke-headers.mjs https://your-app.pages.dev
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/smoke-headers.mjs <deployed-url>');
  process.exit(2);
}

const problems = [];
const fail = (what) => problems.push(what);

// ── The app itself ───────────────────────────────────────────────────

const required = {
  'content-security-policy': /default-src 'self'/,
  'x-frame-options': /DENY/i,
  'x-content-type-options': /nosniff/i,
  'referrer-policy': /strict-origin-when-cross-origin/i,
};

const res = await fetch(url, { redirect: 'manual' });
for (const [name, pattern] of Object.entries(required)) {
  const value = res.headers.get(name);
  if (!value) fail(`app: missing ${name}`);
  else if (!pattern.test(value)) fail(`app: ${name} = "${value}" (expected ${pattern})`);
}

// ── The standalone viewer ────────────────────────────────────────────

const viewerUrl = new URL('/backup-viewer', url).toString();
const viewer = await fetch(viewerUrl, { redirect: 'manual' });

// `redirect: 'manual'` on purpose: a 3xx here means the rewrite became a real
// redirect, which is one misconfiguration away from a loop and changes the
// path the header rules match against.
if (viewer.status !== 200) {
  fail(`viewer: expected 200, got ${viewer.status} (a 3xx means the rewrite turned into a redirect)`);
}
const contentType = viewer.headers.get('content-type') ?? '';
if (!/text\/html/i.test(contentType)) fail(`viewer: content-type = "${contentType}"`);
if (!/nosniff/i.test(viewer.headers.get('x-content-type-options') ?? '')) fail('viewer: missing nosniff');
if (!/DENY/i.test(viewer.headers.get('x-frame-options') ?? '')) fail('viewer: missing X-Frame-Options');

// EXACTLY ONE effective policy, and it is the page's own meta.
//
// Cloudflare Pages inherits matched rules and COMBINES same-named values, so
// without the per-path `! Content-Security-Policy` unset the site policy would
// be merged with the meta. Two policies are enforced as their INTERSECTION,
// and the site policy has no `sha256-` allowance for the viewer's inlined
// script — the page would fail to run at all, offline, in the exact situation
// it exists for.
const viewerCspHeader = viewer.headers.get('content-security-policy');
if (viewerCspHeader) {
  fail(`viewer: a CSP response header is still present ("${viewerCspHeader}") — the per-path unset did not apply`);
}

const body = await viewer.text();
const metas = body.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
if (metas.length !== 1) fail(`viewer: expected exactly one meta CSP, found ${metas.length}`);
else {
  const meta = metas[0];
  if (!/default-src 'none'/.test(meta)) fail('viewer: meta CSP is not fail-closed (no default-src \'none\')');
  if (!/script-src 'sha256-/.test(meta)) fail('viewer: meta CSP does not pin the script by hash');
}

// The signature check: the route must return the VIEWER, not the app shell.
// A catch-all fallback answering with `index.html` looks like success at the
// HTTP level and is useless to a person holding a backup file.
if (!body.includes('просмотр резервной копии')) fail('viewer: body is not the viewer document');
if (body.includes('id="root"')) fail('viewer: the SPA shell was served instead of the viewer');
if (/https?:\/\//i.test(body)) fail('viewer: the served artifact references an http(s) URL');

// ── `/backup-viewer.html`: exactly two acceptable answers ────────────
//
// `_redirects` sends this path to the canonical URL with a 301, because
// Cloudflare follows redirects «regardless of whether or not an asset matches
// the incoming request» — the file in `dist` does not shield it from the
// splat. If a future Pages behaviour serves the asset first instead, the
// answer is the viewer itself, which is equally fine.
//
// Everything else fails: the app shell under a viewer-looking URL is the
// failure mode this route exists to prevent, and «some redirect somewhere» is
// not an answer either — a 301 to `/`, to another origin, or back to itself
// would each look like success at the status-code level.
const altUrl = new URL('/backup-viewer.html', url);
const alt = await fetch(altUrl.toString(), { redirect: 'manual' });
if ([301, 302, 307, 308].includes(alt.status)) {
  const location = alt.headers.get('location') ?? '';
  const target = location === '' ? null : new URL(location, altUrl);
  if (target === null) fail('viewer: /backup-viewer.html redirected with no Location');
  else if (target.origin !== altUrl.origin) {
    fail(`viewer: /backup-viewer.html redirected off-origin to ${target.origin}`);
  } else if (target.pathname !== '/backup-viewer') {
    fail(`viewer: /backup-viewer.html redirected to ${target.pathname}, not /backup-viewer`);
  }
} else if (alt.status === 200) {
  // Served directly: then it must be the viewer AND carry the same guarantees
  // the canonical route was just checked for — a second URL under a weaker
  // policy is a second attack surface, not a convenience.
  const altBody = await alt.text();
  if (altBody.includes('id="root"') || !altBody.includes('просмотр резервной копии')) {
    fail('viewer: /backup-viewer.html answered 200 with something other than the viewer '
      + '(the app shell under a viewer URL is worse than a 404)');
  }
  if (alt.headers.get('content-security-policy')) {
    fail('viewer: /backup-viewer.html carries a CSP response header — the per-path unset did not apply there');
  }
  if (!/nosniff/i.test(alt.headers.get('x-content-type-options') ?? '')) {
    fail('viewer: /backup-viewer.html is missing nosniff');
  }
} else {
  fail(`viewer: /backup-viewer.html answered ${alt.status} — expected a redirect to /backup-viewer or the viewer itself`);
}

if (problems.length) {
  console.error(`smoke-headers FAILED for ${url}:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `smoke-headers OK for ${url}: app CSP + XFO + nosniff + Referrer-Policy, ` +
  'viewer served at /backup-viewer under exactly one (meta) policy',
);
