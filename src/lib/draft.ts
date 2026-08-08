/**
 * Eternal Notes — encrypted-at-rest composer draft (§2 auto-lock plan).
 *
 * The draft used to be PLAINTEXT in sessionStorage — an auto-lock that wipes
 * the vault but leaves the draft readable would leak exactly the text the user
 * was last typing. Now the draft is stored as an AES-256-GCM envelope
 * `{v:1, vaultId, iv, ct}` encrypted with the vault key; `vaultId` (= the
 * base64 public key, non-secret) scopes it so another vault opened in the same
 * tab can never decrypt — or accidentally hydrate — someone else's draft.
 *
 * Write races are resolved by a GENERATION counter: every persist/clear bumps
 * it, and an encrypt that finishes late (its generation superseded) is
 * discarded instead of resurrecting stale text over a newer draft or a clear.
 *
 * Deletion policy (§2): only an explicit reset/recovery removes the ciphertext.
 * A vault mismatch or a failed decrypt KEEPS it — the rightful vault may come
 * back. Legacy plaintext drafts are ignored on read, removed by
 * dropLegacyPlaintextDraft() on lock, and naturally overwritten by the first
 * envelope persist.
 */

import { bufferToBase64, base64ToBuffer } from './crypto';

export const DRAFT_STORAGE_KEY = 'eternal-notes-draft';

/** Minimal Storage surface — the app passes sessionStorage, tests a Map fake. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftEnvelope {
  v: 1;
  /** base64 vault public key — NON-secret, identifies which vault may read. */
  vaultId: string;
  iv: string; // base64, 12 bytes
  ct: string; // base64 AES-GCM ciphertext (includes auth tag)
}

/** What the store hands the draft layer: the vault AES key + its identity. */
export interface DraftContext {
  key: CryptoKey;
  vaultId: string;
}

/** Parse a raw stored value as an envelope. Returns null for legacy plaintext
 *  or any malformed value — the caller decides whether to ignore or drop. */
export function parseDraftEnvelope(raw: string): DraftEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // legacy plaintext draft (pre-envelope format)
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (e.v !== 1) return null;
  if (typeof e.vaultId !== 'string' || e.vaultId.length === 0) return null;
  if (typeof e.iv !== 'string' || typeof e.ct !== 'string') return null;
  return parsed as DraftEnvelope;
}

/** Remove a LEGACY plaintext draft, keeping an envelope untouched. Called on
 *  lock: plaintext must never survive a locked vault, while the encrypted
 *  envelope is exactly what at-rest protection is for. */
export function dropLegacyPlaintextDraft(storage: DraftStorage): void {
  const raw = storage.getItem(DRAFT_STORAGE_KEY);
  if (raw !== null && parseDraftEnvelope(raw) === null) {
    storage.removeItem(DRAFT_STORAGE_KEY);
  }
}

export class DraftStore {
  /** Bumped by every persist/clear; an async persist only writes if its own
   *  generation is still current when the encryption finishes. */
  private generation = 0;
  private storage: DraftStorage;

  constructor(storage: DraftStorage) {
    this.storage = storage;
  }

  /**
   * Encrypt + store the draft. Empty text clears instead (an empty envelope
   * would hydrate an empty string over nothing — pure noise).
   * A persist that loses the race to a newer persist/clear writes NOTHING.
   */
  async persist(text: string, ctx: DraftContext): Promise<void> {
    if (!text) {
      this.clear();
      return;
    }
    const myGen = ++this.generation;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      ctx.key,
      new TextEncoder().encode(text),
    );
    if (myGen !== this.generation) return; // superseded — discard silently
    const envelope: DraftEnvelope = {
      v: 1,
      vaultId: ctx.vaultId,
      iv: bufferToBase64(iv),
      ct: bufferToBase64(ct),
    };
    this.storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(envelope));
  }

  /** Drop the stored draft AND invalidate every in-flight persist. */
  clear(): void {
    this.generation++;
    this.storage.removeItem(DRAFT_STORAGE_KEY);
  }

  /**
   * Decrypt the stored draft for hydration. Returns null when there is nothing
   * usable; never deletes on failure (§2): a foreign vaultId or a decrypt
   * error keeps the ciphertext in place for the vault that owns it.
   */
  async read(ctx: DraftContext): Promise<string | null> {
    const raw = this.storage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return null;
    const envelope = parseDraftEnvelope(raw);
    if (!envelope) return null;                    // legacy plaintext — ignore
    if (envelope.vaultId !== ctx.vaultId) return null; // foreign vault — ignore
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(envelope.iv) as BufferSource },
        ctx.key,
        base64ToBuffer(envelope.ct) as BufferSource,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return null; // wrong key / tampered — keep the ciphertext, hydrate nothing
    }
  }
}
