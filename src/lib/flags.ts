/**
 * Build-time feature flags. Source-controlled constants ONLY — no env vars:
 * the R3/W3 release artifacts must be immutable commits whose behavior is
 * fully determined by the code (see docs/ROLLBACK.md, "v3 release").
 */

/**
 * v3 writer gate (release W3 flips this to true in a dedicated commit/tag).
 *
 * Contract (enforced in the store, not just hidden UI):
 * - false (R3): `addNote` keeps writing v1; `editNote` throws WriterDisabledError;
 *   edit/history controls and the Markdown composer are hidden.
 * - true (W3): `addNote` writes v3 (rev 1, fmt 'md'); `editNote` works.
 *
 * READERS ARE NEVER GATED: chain grouping, current-version selection and
 * fmt-aware rendering stay active at both values — after a W3→R3 rollback the
 * store may already hold v3 chains and R3 must display them correctly.
 *
 * Typed as `boolean` (not the literal) so OFF/ON test matrices don't turn one
 * branch into unreachable dead code under TS narrowing.
 */
export const V3_WRITER_ENABLED: boolean = true;
