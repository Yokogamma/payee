/**
 * Authenticating a PUBLICATION before its `txId` may be bound to a payload
 * fingerprint (D2/D9).
 *
 * ── Why a gateway's answer is not evidence ───────────────────────────
 *
 * The worker's existing liveness probe decides by the HTTP code alone: a 200
 * from `/tx/<id>/status` means «something is there», not «the bytes under this
 * id are the ones we think». That is enough to decide whether to spend money on
 * a re-post, and nowhere near enough to record «this transaction IS this
 * payload» — which is exactly what writing `observedFp` claims, permanently.
 *
 * One faulty or hostile gateway would otherwise produce one of two lies, and
 * both are worse than an outage:
 *   - a false `id_payload_conflict`, quarantining a healthy record forever;
 *   - a false proof, i.e. the pair «payload B ↔ transaction A» that the two
 *     irreversible floors exist to make impossible.
 *
 * So the answer is cryptographic, not statistical: D9. The SAME module the
 * client compiles in (`src/lib/tx-verify.ts`) — imported, not reimplemented,
 * because two implementations of a proof drift, and a drifted proof is a proof
 * of nothing. Precedent: the quorum formula and the gateway parser are already
 * imported the same way.
 *
 * ── What this can and cannot establish ───────────────────────────────
 *
 * It establishes: the transaction is a real, signed, format-2 Arweave
 * transaction; its id is the hash of its own signature; the signature covers
 * these exact tags and this exact `data_root`; the signer is one of the
 * project's historical wallets; and the bytes in hand hash to that `data_root`.
 *
 * It does NOT establish that the envelope inside decrypts — the worker has no
 * seed and never will. That check stays the client's, and this file must never
 * grow a weaker imitation of it.
 *
 * ── Unproven is 503, never a verdict ─────────────────────────────────
 *
 * Every outcome that is not a completed proof is `unproven`, and the caller
 * answers 503 without writing anything. Absence of evidence from a pool of
 * gateways is a transport failure, and turning it into a conflict would let a
 * bad afternoon on the gateway network permanently damage records.
 */

import {
  HEADER_CAP_BYTES,
  TXID_RE,
  isRejection,
  parseTxHeader,
  readVerifiedTags,
  verifyBytes,
  verifyHeader,
  type Rejection,
  type TxHeader,
} from '../../src/lib/tx-verify';
import { computePublicationFp, decodePublicationData } from './publication-fp';

/** One Arweave chunk. A publication larger than this is not something this
 *  project creates, and multi-chunk `data_root` is not implemented. */
const RAW_CAP_BYTES = 262_144;

/** Per-request ceiling. Generous: this runs once per legacy record, and a
 *  premature abort costs a permanent 503 loop rather than a slow success. */
const FETCH_TIMEOUT_MS = 10_000;

/** Whole-operation ceiling across every origin, so a slow pool cannot hold a
 *  request open indefinitely. */
const DEADLINE_MS = 25_000;

/** The tag canon this project's writer emits — the same set the upload path
 *  validates. Kept here so «what our publications look like» is stated once. */
export const APP_NAME = 'EternalNotes';
export const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(['1', '2', '3', '4']);

export type PublicationAuth =
  /** A completed D9 proof. `observedFp` may be written. */
  | {
      kind: 'authenticated';
      txId: string;
      noteId: string;
      appVersion: string;
      /** The outer `data` string exactly as published — the fingerprint input. */
      data: string;
      observedFp: string;
    }
  /**
   * Cryptographically sound, and NOT ours: a foreign wallet, foreign tags, or
   * an `Owner-Hash` from another vault. Every honest gateway would say the
   * same, so retrying is waste — and the caller must never return this txId as
   * a success, whatever its own record claims.
   */
  | { kind: 'not-ours'; txId: string; reason: string }
  /**
   * No proof was completed. Includes «the pool was unreachable», «no gateway
   * had it», and «a gateway answered something that failed verification». The
   * caller answers 503 and writes NOTHING.
   */
  | { kind: 'unproven'; txId: string; reason: string };

export interface AuthDeps {
  /** Payload origins, in the pinned order. */
  origins: readonly string[];
  /** Every wallet address the project has ever posted under (D2). */
  trustedOwners: readonly string[];
  /** The vault whose record this is — bound into the signed tags. */
  ownerHash: string;
  /**
   * The record this publication is supposed to belong to.
   *
   * Without it a record for note X could be resolved against a transaction
   * publishing note Y — same vault, same wallet, so every other D9 step passes.
   * The fingerprint of Y's bytes would then be written onto X's record, and
   * every later request for X would compare against it and conflict: a healthy
   * note quarantined permanently by a mismatched pointer.
   */
  expectedNoteId: string;
  /** Injected so tests describe gateway behaviour without a network. */
  fetchImpl?: typeof fetch;
  /** Per-origin outcome hook (metrics). Never affects the verdict. */
  onOrigin?: (origin: string, outcome: 'ok' | 'miss' | 'mismatch' | 'error') => void;
}

/** Read at most `cap` bytes, refusing anything larger rather than truncating:
 *  a truncated body would fail `data_size` anyway, with a worse message. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) > cap) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > cap) return null;
  return new Uint8Array(buffer);
}

async function fetchFrom(
  origin: string,
  path: string,
  cap: number,
  deadline: AbortSignal,
  deps: AuthDeps,
): Promise<Uint8Array | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${origin}${path}`, {
      // NO REDIRECTS: a gateway answering 302 → another gateway would turn two
      // configured origins into one host's opinion. The verification is
      // cryptographic so this cannot forge a proof, but it can quietly shrink
      // the pool that a 503 is reported over.
      redirect: 'error',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (response.status !== 200) return null;
    return await readCapped(response, cap);
  } catch {
    return null;
  }
}

/**
 * Run D9 for one `txId` against the pool.
 *
 * Two passes, and they may be served by DIFFERENT gateways: the header is bound
 * to the id by the signature, and the bytes are bound to the header by
 * `data_root`, so mixing sources is safe by construction.
 */
export async function authenticatePublication(
  txId: string,
  deps: AuthDeps,
): Promise<PublicationAuth> {
  // Decided without a request: an id that is not 43 base64url characters cannot
  // name an Arweave transaction, so asking is pure waste. It is also not a
  // transport problem, which is why it is not `unproven`.
  if (!TXID_RE.test(txId)) {
    return { kind: 'not-ours', txId, reason: 'txId is not a canonical 43-char base64url id' };
  }
  if (deps.trustedOwners.length === 0) {
    // Never reachable through /upload (the config guard refuses first), and
    // stated anyway: an empty set would make verifyHeader's owner step vacuous.
    return { kind: 'unproven', txId, reason: 'no trusted owners configured' };
  }

  const deadline = AbortSignal.timeout(DEADLINE_MS);

  // ── Pass 1: a header that survives every body-independent D9 step ──
  let header: TxHeader | null = null;
  for (const origin of deps.origins) {
    if (deadline.aborted) break;
    const body = await fetchFrom(origin, `/tx/${txId}`, HEADER_CAP_BYTES, deadline, deps);
    if (body === null) { deps.onOrigin?.(origin, 'miss'); continue; }

    const parsed = parseTxHeader(new TextDecoder().decode(body));
    if (parsed === null) { deps.onOrigin?.(origin, 'mismatch'); continue; }

    const rejection: Rejection | null = await verifyHeader(txId, parsed, deps.trustedOwners);
    if (rejection === null) { deps.onOrigin?.(origin, 'ok'); header = parsed; break; }
    if (rejection.kind === 'skip') {
      // Sound, but not ours. No other gateway will disagree, so stop.
      deps.onOrigin?.(origin, 'ok');
      return { kind: 'not-ours', txId, reason: rejection.reason };
    }
    // A gateway that answered a request for X with a self-consistent header for
    // Y must not end the search at Y.
    deps.onOrigin?.(origin, 'mismatch');
  }
  if (header === null) {
    return { kind: 'unproven', txId, reason: 'no gateway produced a verifiable header' };
  }

  // ── The signed tags decide attribution — the caller's record does not ──
  const tags = readVerifiedTags(header, {
    appName: APP_NAME,
    supportedVersions: SUPPORTED_VERSIONS,
    ownerHash: deps.ownerHash,
  });
  if (isRejection(tags)) return { kind: 'not-ours', txId, reason: tags.reason };
  if (tags.noteId !== deps.expectedNoteId) {
    // A real publication of OURS, for a different note. Proven, so not
    // retryable — and nothing may be written against the record that pointed
    // here.
    return {
      kind: 'not-ours',
      txId,
      reason: `publication is for Note-Id ${tags.noteId}, not ${deps.expectedNoteId}`,
    };
  }

  // ── Pass 2: bytes that hash to this header's data_root ──
  for (const origin of deps.origins) {
    if (deadline.aborted) break;
    const bytes = await fetchFrom(origin, `/raw/${txId}`, RAW_CAP_BYTES, deadline, deps);
    if (bytes === null) { deps.onOrigin?.(origin, 'miss'); continue; }
    if ((await verifyBytes(header, bytes)) !== null) {
      // A 200 carrying corrupted, truncated or foreign bytes does not stop the
      // search: a later gateway's valid answer neutralizes this one.
      deps.onOrigin?.(origin, 'mismatch');
      continue;
    }
    deps.onOrigin?.(origin, 'ok');

    let data: string;
    try {
      data = decodePublicationData(bytes);
    } catch {
      // The bytes are PROVEN to be this transaction's, so this is not a gateway
      // fault — it is a publication whose body is not what the current
      // canonicalization reads. Not ours to fingerprint.
      return { kind: 'not-ours', txId, reason: 'publication body is not decodable as UTF-8' };
    }

    // The INNER id must agree with the signed tag, exactly as the upload path
    // requires of anything it accepts. A publication whose envelope names a
    // different note is not a fingerprintable answer about this record.
    try {
      const inner = JSON.parse(data) as { id?: unknown };
      if (inner?.id !== tags.noteId) {
        return { kind: 'not-ours', txId, reason: 'inner id does not match the signed Note-Id' };
      }
    } catch {
      return { kind: 'not-ours', txId, reason: 'publication body is not JSON' };
    }

    let observedFp: string;
    try {
      observedFp = await computePublicationFp(tags.version, data);
    } catch (e) {
      return {
        kind: 'not-ours',
        txId,
        reason: `publication does not pass the current canonicalization: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      kind: 'authenticated',
      txId,
      noteId: tags.noteId,
      appVersion: tags.version,
      data,
      observedFp,
    };
  }

  return { kind: 'unproven', txId, reason: 'no gateway produced bytes matching the header' };
}
