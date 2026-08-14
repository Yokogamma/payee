/**
 * Reset the section route between tests.
 *
 * The section now lives in `location.hash`, and jsdom keeps one `location` for
 * the whole file — so a test that switches to the safebox leaves `#/safebox`
 * behind, and the NEXT test starts there. That is invisible until an assertion
 * happens to depend on the starting section, at which point it looks like a
 * bug in the code under test rather than in the harness.
 *
 * `replaceState`, not `pushState`: the reset must not add history entries that
 * a Back-navigation test would then have to walk through.
 *
 * Call from `beforeEach` in every jsdom suite that renders the shell.
 */
export function resetRoute(): void {
  window.history.replaceState(null, '', '#/notes');
}
