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

/**
 * Safebox (v4) writer gate (release W4 flips this to true in a dedicated
 * commit/tag).
 *
 * Contract (enforced in the store, not just hidden UI):
 * - false (R4): `addSafeboxEntry` / `editSafeboxEntry` / `restoreSafeboxVersion`
 *   throw WriterDisabledError; their UI (composer, edit, «Вернуть эту версию»)
 *   is hidden. EVERYTHING ELSE WORKS: the section is visible when data or a PIN
 *   config exists, unlocking, viewing, copying, downloading, version history,
 *   activation (including the post-restore seed path — a restored user must not
 *   be cut off from their passwords), PIN change/deactivation and the seed
 *   reset are all writer-INDEPENDENT.
 * - true (W4): all three writer actions work and the entry point is offered to
 *   everyone (otherwise flipping the flag would not reveal the safebox to new
 *   users).
 *
 * Entry-point visibility: `SAFEBOX_WRITER_ENABLED || safeboxDataPresent ||
 * safeboxPinConfigured`.
 *
 * Typed as `boolean` (not the literal) so OFF/ON test matrices don't turn one
 * branch into unreachable dead code under TS narrowing.
 */
export const SAFEBOX_WRITER_ENABLED: boolean = true;

/**
 * «Быстрый вход» — unlocking the vault with a WebAuthn PRF key instead of
 * typing the PIN (release `client-qu2` flips this in a dedicated commit/tag).
 *
 * Contract PER OPERATION, not per screen:
 * - `setupQuickUnlock` / `unlockWithQuickUnlock` are GATED: with the flag off
 *   they refuse (QuickUnlockUnavailableError) instead of running a ceremony.
 * - Reading the record and REMOVING it are NEVER gated. The settings block is
 *   visible when `QUICK_UNLOCK_ENABLED || hasQuickUnlock`, and with the flag
 *   off over a live record it offers removal ONLY: rolling the flag back must
 *   never strand a user with a working record and no control for it.
 *
 * Typed as `boolean` (not the literal) so OFF/ON test matrices don't turn one
 * branch into unreachable dead code under TS narrowing.
 */
export const QUICK_UNLOCK_ENABLED: boolean = true;

/**
 * Backup EXPORT gate — «Скачать резервную копию» and «Скачать просмотрщик».
 *
 * Two flags rather than one, and three releases rather than two, because the
 * first DB3 release is irreversible. Raising `DB_VERSION` to 3 (D2b) forbids
 * rolling back to the proven DBv2 client; if import — the riskiest mutating
 * operation there is — were already on at that moment, no safe DB3 artifact
 * without import would exist, and a defect in import could only be cured by an
 * urgent forward fix.
 *
 * So: release 1 is the client floor with BOTH flags off (this is the tag
 * declared as the minimum safe rollback target on DB3), release 2 turns import
 * and file verification on, release 3 turns export on.
 *
 * Contract (enforced in the store, not just hidden UI): with the flag off the
 * export action refuses with a typed error rather than producing a file.
 *
 * Typed as `boolean` (not the literal) so OFF/ON test matrices don't turn one
 * branch into unreachable dead code under TS narrowing.
 */
export const BACKUP_EXPORT_ENABLED: boolean = false;

/**
 * Backup IMPORT gate — «Импортировать из файла» AND «Проверить файл копии».
 *
 * Verification is gated together with import even though it is a pure dry-run
 * that mutates nothing: release 1 exists to be the smallest possible surface
 * on DB3, and a file picker plus a full decrypt pass is surface.
 *
 * EXPORT ON while IMPORT is OFF is FORBIDDEN and rejected by a build-time
 * check (`scripts/check-backup-flags.mjs`). That combination would hand users
 * copies they can neither verify nor restore — a backup they have no way to
 * find out is worthless until the day they need it.
 *
 * Typed as `boolean` (not the literal) so OFF/ON test matrices don't turn one
 * branch into unreachable dead code under TS narrowing.
 */
export const BACKUP_IMPORT_ENABLED: boolean = false;
