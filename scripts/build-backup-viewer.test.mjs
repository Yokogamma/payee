import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { requireDist } from './require-dist.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBackupViewer,
  checkViewerArtifact,
  renderHashModule,
  PLACEHOLDER,
  VIEWER_MAX_BYTES,
} from './build-backup-viewer.mjs';

/**
 * The viewer is the last resort in the recovery formula — the copy someone
 * opens when the project is gone and nothing else is left. So the build is
 * allowed to be slow and is not allowed to be lenient: every rule below is a
 * reason to REFUSE to emit a file, not a warning to read later.
 */

const clean = [
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
  '<textarea data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></textarea>',
].join('\n');

describe('what the build refuses to emit', () => {
  it('accepts an artifact that satisfies every rule', () => {
    expect(checkViewerArtifact(clean)).toEqual([]);
  });

  it('refuses any http(s) reference', () => {
    // The page must work with no network at all; one stray reference is both a
    // failure mode offline and a beacon online.
    expect(checkViewerArtifact(`${clean}\n<script>fetch("https://example.com")</script>`))
      .toContainEqual(expect.stringContaining('http(s) URL'));
  });

  it('refuses WebAssembly', () => {
    for (const marker of ['hash-wasm', 'WebAssembly.instantiate']) {
      expect(checkViewerArtifact(`${clean}\n${marker}`), marker)
        .toContainEqual(expect.stringContaining('WebAssembly'));
    }
  });

  it('refuses a seed field without the anti-autofill set', () => {
    // A password manager that «helpfully» saves a seed phrase has exported the
    // entire vault to a third party.
    const without = clean.replace('data-lpignore="true" ', '');
    expect(checkViewerArtifact(without)).toContainEqual(expect.stringContaining('data-lpignore'));
  });

  it('refuses a missing or open Content-Security-Policy', () => {
    expect(checkViewerArtifact('<html></html>'))
      .toContainEqual(expect.stringContaining('Content-Security-Policy'));
    expect(checkViewerArtifact(clean.replace("default-src 'none'", "default-src *")))
      .toContainEqual(expect.stringContaining('Content-Security-Policy'));
  });

  it('refuses an artifact past the size ceiling', () => {
    const huge = `${clean}\n${'x'.repeat(VIEWER_MAX_BYTES)}`;
    expect(checkViewerArtifact(huge)).toContainEqual(expect.stringContaining('over the'));
  });

  it('reports every violation at once, not the first', () => {
    expect(checkViewerArtifact('https://example.com WebAssembly').length).toBeGreaterThan(2);
  });
});

describe('the real artifact', () => {
  it('builds, passes its own rules, and stays well under the ceiling', async () => {
    const { html, bytes, hash } = await buildBackupViewer({ write: false });

    expect(checkViewerArtifact(html)).toEqual([]);
    expect(bytes).toBeLessThan(VIEWER_MAX_BYTES);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('is deterministic — the same sources give the same bytes', async () => {
    // The app compiles the hash in and checks the download against it, so a
    // build that varied run to run would make that check meaningless.
    const first = await buildBackupViewer({ write: false });
    const second = await buildBackupViewer({ write: false });
    expect(second.hash).toBe(first.hash);
  }, 60_000);

  it('pins its own script and style by hash in the CSP', async () => {
    const { html } = await buildBackupViewer({ write: false });
    expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
  }, 60_000);
});

describe('the committed hash module', () => {
  const modulePath = fileURLToPath(new URL('../src/lib/backup-viewer-hash.ts', import.meta.url));
  const distPath = fileURLToPath(new URL('../dist/backup-viewer.html', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');
  const declared = /BACKUP_VIEWER_SHA256 = '([^']*)'/.exec(source)?.[1];

  it('exports a typed constant and an explicit placeholder flag', () => {
    expect(declared).toBeDefined();
    expect(source).toMatch(/BACKUP_VIEWER_HASH_IS_PLACEHOLDER = (true|false);/);
  });

  it('is either the honest placeholder, or the real hash of the built artifact', () => {
    // Two self-consistent states. The COMMITTED one is the placeholder, so a
    // clean checkout compiles and a consumer can refuse to present the
    // download as verified. After a build the module carries the real hash of
    // the file in dist — a stale value that merely LOOKED like a hash would be
    // worse than no check at all.
    //
    // The branch is chosen by the MODULE, not by whether dist happens to
    // exist: a leftover dist from an earlier build says nothing about the
    // committed source, and keying off it would make `npm test` red after any
    // local build — pressure to commit the built hash, which is the one thing
    // this arrangement exists to prevent.
    if (declared === PLACEHOLDER) {
      // Post-build, the placeholder is itself the defect: the build rewrites
      // this module as its first step, so still seeing it means the assertion
      // below — the whole point of running here — was never reached.
      if (process.env.REQUIRE_DIST === '1') {
        expect(declared, 'REQUIRE_DIST=1 but the module still holds the placeholder — the build did not run')
          .not.toBe(PLACEHOLDER);
      }
      expect(source).toContain('BACKUP_VIEWER_HASH_IS_PLACEHOLDER = true;');
      return;
    }
    expect(declared).toMatch(/^[0-9a-f]{64}$/);
    expect(source).toContain('BACKUP_VIEWER_HASH_IS_PLACEHOLDER = false;');
    if (!requireDist(distPath, expect)) return;
    expect(declared).toBe(createHash('sha256').update(readFileSync(distPath)).digest('hex'));
  });

  it('the artifact is NOT precached by the service worker', () => {
    // It is a file the app HANDS the user and then verifies against its
    // compiled-in hash, not a page the app navigates to. A precached copy
    // could be served in place of the freshly built one, and the check would
    // then compare the app's own stale cache against its own constant —
    // passing while telling the user nothing.
    const swPath = fileURLToPath(new URL('../dist/sw.js', import.meta.url));
    if (!requireDist(swPath, expect)) return;
    const sw = readFileSync(swPath, 'utf8');
    // The PRECACHE MANIFEST specifically, not any mention of the name: the
    // navigation-fallback denylist legitimately carries the same string as a
    // pattern, and a bare substring check would call that a precache entry.
    const precached = [...sw.matchAll(/url:"([^"]+)"/g)].map(m => m[1]);
    expect(precached.length).toBeGreaterThan(0); // the scan really found the manifest
    expect(precached).not.toContain('backup-viewer.html');
  });

  it('the value in the COMMIT is the placeholder, whatever the working tree holds', () => {
    // The test above is deliberately tolerant of a local build having rewritten
    // this file — otherwise `npm test` would go red after every build, and the
    // pressure would be to commit the generated value, which is the one outcome
    // this arrangement exists to prevent. So: tolerant of the working tree,
    // intolerant of the commit. Only git can tell those apart.
    //
    // Without this the tolerance has no floor: a hash generated on someone's
    // machine could be committed and CI would never notice, because the test
    // job runs on a clean checkout where the working tree IS the commit.
    let committed;
    try {
      committed = execFileSync('git', ['show', 'HEAD:src/lib/backup-viewer-hash.ts'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return; // not a git checkout (a tarball) — there is no commit to judge
    }

    expect(committed).toContain(`BACKUP_VIEWER_SHA256 = '${PLACEHOLDER}'`);
    expect(committed).toContain('BACKUP_VIEWER_HASH_IS_PLACEHOLDER = true;');
  });

  it('the placeholder renders as invalid and a real hash renders as valid', () => {
    expect(renderHashModule(PLACEHOLDER)).toContain('BACKUP_VIEWER_HASH_IS_PLACEHOLDER = true;');
    expect(renderHashModule('a'.repeat(64))).toContain('BACKUP_VIEWER_HASH_IS_PLACEHOLDER = false;');
  });
});
