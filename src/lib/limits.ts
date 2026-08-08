/**
 * Note size limit — shared by the store (hard reject) and the UI (counter,
 * disabled save button).
 *
 * The worker caps the whole /upload body at 51 200 bytes (MAX_BODY_BYTES).
 * The dominant term is the base64 ciphertext = 4/3 × (escaped text + envelope
 * overhead + GCM tag). We meter the text as the byte length of its
 * JSON-STRING-ESCAPED UTF-8 form — exactly how it ships inside the envelope —
 * so multi-byte scripts (Cyrillic = 2 B/char, emoji = 4 B/char) and
 * escape-heavy text (newlines, quotes → 2 B each) are counted honestly.
 * 30 000 escaped bytes → ≈40.3 KB base64 + ~1 KB wrapper: ~10 KB of slack.
 */
export const MAX_NOTE_JSON_BYTES = 30_000;

const encoder = new TextEncoder();

/** Byte size of the text as it will actually be serialized inside the
 *  encrypted JSON envelope (UTF-8 of the JSON-escaped form, minus the two
 *  surrounding quotes). */
export function noteJsonByteLength(text: string): number {
  return encoder.encode(JSON.stringify(text)).length - 2;
}

export function isNoteTooLong(text: string): boolean {
  return noteJsonByteLength(text) > MAX_NOTE_JSON_BYTES;
}

/** Typed store-level rejection — the UI must show the dedicated size message
 *  (and keep the draft) instead of the generic "save failed". */
export class NoteTooLongError extends Error {
  readonly byteLength: number;
  constructor(byteLength: number) {
    super(`Note too long: ${byteLength} > ${MAX_NOTE_JSON_BYTES} bytes`);
    this.name = 'NoteTooLongError';
    this.byteLength = byteLength;
  }
}
