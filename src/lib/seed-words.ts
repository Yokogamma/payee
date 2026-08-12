/** Shared constants for the 12-word seed grid (kept out of the component file
 *  so fast-refresh stays intact). */
export const SEED_WORD_COUNT = 12;

export function emptySeedWords(): string[] {
  return Array(SEED_WORD_COUNT).fill('');
}

export function emptySeedFlags(): boolean[] {
  return Array(SEED_WORD_COUNT).fill(false);
}
