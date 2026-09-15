// NO SHEBANG here: this module is imported by tests, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * «Is there a build to check?» — and, when it matters, «there had better be».
 *
 * Several assertions in this suite are about the BUILT artifacts: the hash the
 * app compiles in equals the file in `dist`, the viewer is not in the precache
 * manifest, the CSP unset really reached `_headers`. On a clean checkout there
 * is no `dist`, and skipping is right — `npm test` runs before `npm run build`
 * and must not demand one.
 *
 * The trap is that this makes those three invariants provable only by
 * accident. CI ran the suite on a clean checkout, every dist assertion
 * returned early, and the run went green having verified none of them; nothing
 * ran them again after the build. So the skip is now OPT-OUT: the post-build
 * step sets `REQUIRE_DIST=1`, and there the absence of a build is a failure
 * rather than a shrug.
 */
import { existsSync } from 'node:fs';

export function requireDist(path, expect) {
  if (existsSync(path)) return true;
  if (process.env.REQUIRE_DIST === '1') {
    expect(existsSync(path), `${path} is missing and REQUIRE_DIST=1 — run the build first`).toBe(true);
  }
  return false;
}
