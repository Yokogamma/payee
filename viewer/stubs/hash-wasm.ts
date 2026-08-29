/**
 * Build-time stub for `hash-wasm`, aliased in only for the standalone viewer.
 *
 * `crypto.ts` reaches for Argon2id through a dynamic import, and only on the
 * PIN path — which the viewer has no way to enter: it opens a container with a
 * seed phrase, never with a PIN. Bundling the real package would drag a
 * WebAssembly module into a file that must stay a single, auditable,
 * offline-openable HTML page, and `WebAssembly` in an artifact whose entire
 * value is «anyone can check what this does» is a poor trade for code that can
 * never run.
 *
 * It throws rather than returning a plausible value: if some future change
 * ever does route the viewer through Argon2, the failure must be loud and
 * immediate, not a silently wrong key.
 */

const unreachable = (name: string) => (): never => {
  throw new Error(`hash-wasm.${name} is not available in the standalone viewer`);
};

export const argon2id = unreachable('argon2id');
export const argon2i = unreachable('argon2i');
export const argon2d = unreachable('argon2d');
