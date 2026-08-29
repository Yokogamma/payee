import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { requireDist } from './require-dist.mjs';
import { fileURLToPath } from 'node:url';

/**
 * The three pieces of edge configuration that put the viewer at its own URL.
 *
 * Each of them fails SILENTLY: a mis-ordered redirect answers with the app
 * shell, a missing CSP unset leaves a policy the page cannot run under, and a
 * service worker fallback intercepts the route before the server ever sees it.
 * None of that surfaces in a build log — it surfaces when someone opens the
 * file offline, years later, with nobody left to tell.
 */

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('the route', () => {
  const redirects = read('../public/_redirects');

  it('sends /backup-viewer to the artifact with a 200 rewrite', () => {
    expect(redirects).toMatch(/^\/backup-viewer\s+\/backup-viewer\.html\s+200$/m);
  });

  it('places that rule ABOVE the SPA fallback', () => {
    // The splat matches everything. Below it, the viewer request would be
    // answered with the app shell — an HTTP success that is useless to a
    // person holding a backup file.
    const viewer = redirects.indexOf('/backup-viewer ');
    const splat = redirects.indexOf('/* /index.html');
    expect(viewer).toBeGreaterThanOrEqual(0);
    expect(splat).toBeGreaterThan(viewer);
  });

  it('sends `/backup-viewer.html` to the canonical URL, and does so before the splat', () => {
    // The file existing in `dist` does not shield the path: Cloudflare follows
    // redirects «regardless of whether or not an asset matches the incoming
    // request», so without a rule of its own `.html` lands in the SPA fallback
    // — the app shell under a URL that looks like the viewer's.
    const lines = read('../public/_redirects')
      .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const html = lines.findIndex(line => line.startsWith('/backup-viewer.html '));
    const splat = lines.findIndex(line => line.startsWith('/* '));

    expect(html, '/backup-viewer.html has no rule of its own').toBeGreaterThanOrEqual(0);
    expect(lines[html]).toBe('/backup-viewer.html /backup-viewer 301');
    expect(splat).toBeGreaterThan(html);
  });
});

describe('the service worker', () => {
  const config = read('../vite.config.ts');

  it('excludes the viewer from the SPA navigation fallback', () => {
    // The `_redirects` rule governs the server; this governs the service
    // worker, which answers first for an installed PWA.
    expect(config).toMatch(/navigateFallbackDenylist:\s*\[\/\^\\\/backup-viewer/);
  });

  it('and does so for a query string too — Workbox matches path AND search', () => {
    // Not a copy of the pattern: the one in the config is lifted out and RUN,
    // because the defect this catches is a `$` in the wrong place, which any
    // re-typed regex in a test would reproduce and then bless.
    const source = /navigateFallbackDenylist:\s*\[\s*([^\]]+?)\s*,?\s*\]/.exec(config)?.[1];
    expect(source, 'the denylist is no longer a single regex literal').toBeDefined();
    const literal = /^\/(.*)\/([a-z]*)$/.exec(source.trim());
    expect(literal, `not a regex literal: ${source}`).not.toBeNull();
    const denylist = new RegExp(literal[1], literal[2]);

    // Workbox: `denylist.some(re => re.test(url.pathname + url.search))`.
    for (const path of ['/backup-viewer', '/backup-viewer.html', '/backup-viewer?utm=1',
      '/backup-viewer.html?x=1', '/backup-viewer?']) {
      expect(denylist.test(path), `${path} must be kept from the SPA fallback`).toBe(true);
    }
    for (const path of ['/', '/notes', '/backup-viewers', '/x/backup-viewer']) {
      expect(denylist.test(path), `${path} must NOT be denied the SPA fallback`).toBe(false);
    }
  });

  it('excludes the viewer from precache', () => {
    expect(config).toMatch(/globIgnores:.*backup-viewer\.html/);
  });
});

describe('the headers', () => {
  const postbuild = read('../scripts/postbuild.mjs');

  it('emits a per-path block for both viewer paths', () => {
    expect(postbuild).toContain("['/backup-viewer', '/backup-viewer.html']");
  });

  it('starts that block by UNSETTING the site policy', () => {
    // Cloudflare Pages inherits matched rules and COMBINES same-named values.
    // Without the `!`, the site CSP would be merged with the page's meta, the
    // two enforced as their intersection — and the site policy has no
    // `sha256-` allowance for the viewer's inlined script, so the page would
    // fail to run at all.
    expect(postbuild).toMatch(/!\s*Content-Security-Policy/);
  });

  it('the generated file carries the unset for both paths', () => {
    const headersPath = fileURLToPath(new URL('../dist/_headers', import.meta.url));
    if (!requireDist(headersPath, expect)) return;
    const headers = readFileSync(headersPath, 'utf8');
    for (const path of ['/backup-viewer', '/backup-viewer.html']) {
      const block = new RegExp(`^${path.replace('.', '\\.')}\\n\\s*! Content-Security-Policy`, 'm');
      expect(headers, path).toMatch(block);
    }
  });
});

describe('the post-deploy smoke check', () => {
  const smoke = read('../scripts/smoke-headers.mjs');

  it('asserts the viewer route returns 200 rather than a redirect', () => {
    expect(smoke).toContain("viewer.status !== 200");
    expect(smoke).toContain("redirect: 'manual'");
  });

  it('asserts exactly one effective policy, and that it is the meta', () => {
    expect(smoke).toContain('a CSP response header is still present');
    expect(smoke).toContain('expected exactly one meta CSP');
  });

  it('asserts the served document is the viewer and not the app shell', () => {
    expect(smoke).toContain('the SPA shell was served instead of the viewer');
  });
});
