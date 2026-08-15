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

/**
 * The class that opts a field OUTSIDE the safebox section into the synchronous
 * BFCache scrub, and the selector the store runs on every lock.
 *
 * These are not styling — they are a security contract with a string literal.
 * The scrub in `lockSafeboxNow` wipes matching fields synchronously, before the
 * `pagehide` snapshot can capture a half-typed PIN. Kept here, next to the
 * anti-autofill props, because a field that needs one almost always needs the
 * other, and because a rename that reached only one side would silently unhook
 * a field with no test failing.
 *
 * `.safebox-section` covers everything inside the section (PIN pad, the
 * 12-word seed-reset grid, entry forms). The class is for the fields that live
 * OUTSIDE it — today the settings PIN-change and seed-gate inputs, which no
 * remount of the section would ever reach.
 */
export const SAFEBOX_SECRET_FIELD_CLASS = 'safebox-secret-field';

export const SAFEBOX_SCRUB_SELECTOR =
  `.safebox-section input, .safebox-section textarea, .${SAFEBOX_SECRET_FIELD_CLASS}`;
