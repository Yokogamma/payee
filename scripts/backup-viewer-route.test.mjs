import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { requireDist } from './require-dist.mjs';
import { fileURLToPath } from 'node:url';

/**
 * The pieces of edge configuration that put the viewer at its own URL.
 *
 * Each of them fails SILENTLY: a redirect rule answers with the app shell or
 * loops, a missing CSP unset leaves a policy the page cannot run under, and a
 * service worker fallback intercepts the route before the server ever sees it.
 * None of that surfaces in a build log — it surfaces when someone opens the
 * file offline, years later, with nobody left to tell. The route itself is
 * served by Cloudflare Pages natively (HTML asset at its extensionless path);
 * the tree can only check that nothing here fights that.
 */

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('the route', () => {
  // What a unit test CAN say about the edge: that nobody re-added a rule that
  // is known to break on Pages, and that the two things the native behaviour
  // relies on are in place. What it CANNOT say is whether Pages serves the
  // route — the first real release proved that the tree's reading of the
  // docs was wrong (a 200 rewrite to `.html` became a 308 loop). Only
  // `scripts/smoke-headers.mjs` against a real deployment answers that, and
  // every release runs it after publishing.
  const redirects = read('../public/_redirects');
  const rules = redirects.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

  it('has NO _redirects rules — the viewer route and the SPA fallback are native', () => {
    // A rewrite to `/backup-viewer.html` is the loop (Pages redirects
    // `.html` to the extensionless path, which the rewrite sends back);
    // a `/* /index.html 200` splat is what the 200 rewrite existed to
    // outrank. Neither is needed: Pages serves an HTML asset at its
    // extensionless URL and falls back to index.html when there is no 404.html.
    expect(rules, `unexpected _redirects rules: ${rules.join(' | ')}`).toEqual([]);
  });

  it('keeps the viewer as a top-level .html asset, so /backup-viewer resolves natively', () => {
    const viewerPath = fileURLToPath(new URL('../public/backup-viewer.html', import.meta.url));
    expect(existsSync(viewerPath), 'public/backup-viewer.html is missing').toBe(true);
  });

  it('ships no 404.html — that is what keeps the native SPA fallback on', () => {
    // With a top-level 404.html Pages stops assuming a single-page app and
    // answers unknown paths with it instead of index.html; every deep link
    // of the app (/notes, /settings, …) would 404 on a cold load.
    expect(existsSync(fileURLToPath(new URL('../public/404.html', import.meta.url)))).toBe(false);
    const distNotFound = fileURLToPath(new URL('../dist/404.html', import.meta.url));
    expect(existsSync(distNotFound), 'dist/404.html would switch the SPA fallback off').toBe(false);
  });
});

describe('the service worker', () => {
  const config = read('../vite.config.ts');

  it('excludes the viewer from the SPA navigation fallback', () => {
    // Pages serves the route natively on the server; this governs the service
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
