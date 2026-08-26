import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
});

describe('the service worker', () => {
  const config = read('../vite.config.ts');

  it('excludes the viewer from the SPA navigation fallback', () => {
    // The `_redirects` rule governs the server; this governs the service
    // worker, which answers first for an installed PWA.
    expect(config).toMatch(/navigateFallbackDenylist:\s*\[\/\\\/backup-viewer/);
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
    if (!existsSync(headersPath)) return; // nothing built in this checkout
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
