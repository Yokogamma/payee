/**
 * Anti-autofill attribute set for EVERY field that carries a secret (safebox
 * PIN pad, the main PIN, entry passwords, the generator output, seed words).
 *
 * Why this matters more than it looks: a browser or cloud password manager that
 * "helpfully" saves a master PIN or a vault password silently exports the
 * user's secrets to a third party — which breaks the app's end-to-end model
 * completely. `autocomplete="off"` alone is widely ignored for
 * password-shaped inputs, so the vendor-specific opt-outs are all included.
 *
 * The other half of the rule lives at the call sites: field `name`/`id`
 * attributes must NOT match manager heuristics — never `name="password"`,
 * `name="username"`, `id="login"` and friends.
 */
export const SECRET_FIELD_PROPS = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

/** Same, for inputs the browser is most eager to treat as a login password —
 *  `new-password` suppresses the "save this password?" prompt more reliably
 *  than `off` in Chromium. */
export const SECRET_PASSWORD_FIELD_PROPS = {
  ...SECRET_FIELD_PROPS,
  autoComplete: 'new-password',
} as const;
