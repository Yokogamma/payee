/**
 * `publicationEquivalent` — «would these two records go on-chain as the very
 * same publication?»
 *
 * Backup import rule 2 (plan §4): when the LOCAL payload is readable, an
 * incoming record that is publication-equivalent is a no-op, and one that
 * differs is a conflict the import refuses to resolve. Both outcomes leave the
 * store untouched, so this predicate must be cheap, synchronous and total.
 *
 * WHAT is compared: the `(data, tags)` pair produced by the REAL upload
 * builders — exactly what leaves for the blockchain, nothing else. Reusing the
 * builders (rather than diffing record fields) is the point: version-specific
 * serialization already lives there, so a v1 record and a v3 record with the
 * same ciphertext are correctly NOT equivalent, and for v1 the on-chain
 * `createdAt` (outer `t` plus the Timestamp tag) counts, because v1 really does
 * publish it (arweave.ts §buildUploadPayload).
 *
 * The per-call transport fields are neutralized with FIXED stubs: `ownerHash`
 * is a per-device value that would otherwise leak into the Owner-Hash tag, and
 * `now` only feeds `payload.timestamp`, which is not part of the pair at all.
 *
 * NEVER throws (plan §5). The builders fail closed on a version this build
 * cannot serialize (`UnsupportedNoteVersionError` /
 * `UnsupportedSafeboxVersionError`), and a record read back from an untrusted
 * backup file can be malformed in ways no type says. Every such case is
 * «not equivalent» — never an exception into the merge loop, and never a
 * silent «equal». Opaque records are decided by the quarantine table (D5a)
 * before this predicate is consulted, so answering «not equivalent» for them
 * costs nothing.
 */

import type { EncryptedNote, EncryptedSafeboxEntry } from './crypto';
import { buildUploadPayload, buildSafeboxUploadPayload } from './arweave';

/** A record together with the store it came from. The kind is passed
 *  EXPLICITLY rather than sniffed from the shape: the caller always knows
 *  which store it is walking, and guessing would turn a corrupted row into a
 *  cross-space comparison (D10 forbids the id spaces from overlapping). */
export type PublicationSubject =
  | { kind: 'note'; record: EncryptedNote }
  | { kind: 'safebox'; record: EncryptedSafeboxEntry };

/** Fixed stubs — see the module header. Any constant works; these are named so
 *  a value that leaked into a real upload would be obvious. */
const STUB_OWNER_HASH = 'publication-equivalent-stub-owner-hash';
const STUB_NOW = 0;

type Tag = { name: string; value: string };

function buildPair(subject: PublicationSubject): { data: string; tags: Tag[] } {
  const { data, tags } =
    subject.kind === 'note'
      ? buildUploadPayload(subject.record, STUB_OWNER_HASH, STUB_NOW)
      : buildSafeboxUploadPayload(subject.record, STUB_OWNER_HASH, STUB_NOW);
  return { data, tags };
}

export function publicationEquivalent(a: PublicationSubject, b: PublicationSubject): boolean {
  if (a.kind !== b.kind) return false;

  let pa: { data: string; tags: Tag[] };
  let pb: { data: string; tags: Tag[] };
  try {
    pa = buildPair(a);
    pb = buildPair(b);
  } catch {
    return false; // unsupported version or a malformed row — not equivalent
  }

  if (pa.data !== pb.data) return false;
  if (pa.tags.length !== pb.tags.length) return false;
  for (let i = 0; i < pa.tags.length; i++) {
    if (pa.tags[i].name !== pb.tags[i].name) return false;
    if (pa.tags[i].value !== pb.tags[i].value) return false;
  }
  return true;
}
