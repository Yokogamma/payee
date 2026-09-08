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
import { APP_NAME, SUPPORTED_VERSIONS } from './protocol';
import { classifyStatus, classifyThrow, type GatewayClass } from './gateway-class';

/** One Arweave chunk. A publication larger than this is not something this
 *  project creates, and multi-chunk `data_root` is not implemented. */
const RAW_CAP_BYTES = 262_144;

/** Per-request ceiling. Generous: this runs once per legacy record, and a
 *  premature abort costs a permanent 503 loop rather than a slow success. */
const FETCH_TIMEOUT_MS = 10_000;

/** Whole-operation ceiling across every origin, so a slow pool cannot hold a
 *  request open indefinitely. */
const DEADLINE_MS = 25_000;

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
  /**
   * Per-origin outcome hook (metrics). Never affects the verdict — the module
   * swallows anything it throws, so a broken telemetry adapter cannot turn a
   * completed proof into a 500.
   *
   * `stage` is reported separately because a miss on the header and a miss on
   * the bytes are different failures: the first says the pool never identified
   * the transaction, the second that it identified it and could not serve it.
   * `outcome` carries WHY (see OriginRead), not merely «not usable».
   */
  onOrigin?: (
    origin: string,
    stage: ReadStage,
    outcome: GatewayClass | 'oversize' | 'ok' | 'mismatch',
    elapsedMs: number,
  ) => void;
}

/** Which half of D9 a read belongs to: the signed header, or the bytes. */
export type ReadStage = 'header' | 'raw';

/**
 * Read at most `cap` bytes, refusing anything larger rather than truncating.
 *
 * STREAMED, and cancelled the moment the cap is crossed — never
 * `arrayBuffer()` followed by a length check. That order reads the WHOLE body
 * first, so a hostile or broken gateway could hand this isolate hundreds of
 * megabytes before the check ever ran. `Content-Length` is consulted as a
 * cheap early refusal only; it is advisory, and a gateway may omit it or lie.
 * Mirrors the client's reader in src/lib/arweave.ts.
 */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) > cap) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * One origin's answer, WITH the reason it is not usable.
 *
 * The reason used to be thrown away: every failure — a thrown fetch, a 404, a
 * 500, a body over the cap — collapsed into `null` and was reported as `miss`.
 * That is why a total outage (the runtime refusing the redirect mode on every
 * call) looked exactly like «the gateways are having a bad afternoon», and the
 * defect survived a full soak window undiagnosed.
 */
interface OriginRead {
  bytes: Uint8Array | null;
  /** Metrics label. `oversize` is ours: a 200 whose body crossed the cap. */
  outcome: GatewayClass | 'oversize';
  elapsedMs: number;
}

async function fetchFrom(
  origin: string,
  path: string,
  cap: number,
  deadline: AbortSignal,
  deps: AuthDeps,
): Promise<OriginRead> {
  const doFetch = deps.fetchImpl ?? fetch;
  const started = performance.now();
  const since = () => performance.now() - started;
  try {
    const response = await doFetch(`${origin}${path}`, {
      // NO REDIRECTS: a gateway answering 302 → another gateway would turn two
      // configured origins into one host's opinion. The verification is
      // cryptographic so this cannot forge a proof, but it can quietly shrink
      // the pool that a 503 is reported over.
      //
      // `'error'` is NOT usable here, however tempting: workerd refuses the
      // VALUE with a TypeError while parsing init, before any I/O ("won't be
      // implemented since it does not make sense at the edge; use manual and
      // check the response status code"). It shipped, and every gateway read
      // became an instant miss — D9 could never complete, so every legacy
      // record answered 503 `legacy_unproven` forever. `'manual'` hands the
      // 3xx back as an ordinary response, and the status check below refuses
      // it: same pool semantics, without the throw.
      redirect: 'manual',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (response.status !== 200) {
      // A 3xx lands here, which is the whole point of `manual`: refused by
      // status, not by an exception the runtime never let us take.
      return { bytes: null, outcome: classifyStatus(response.status), elapsedMs: since() };
    }
    const bytes = await readCapped(response, cap);
    return bytes === null
      ? { bytes: null, outcome: 'oversize', elapsedMs: since() }
      : { bytes, outcome: '2xx', elapsedMs: since() };
  } catch (e) {
    return { bytes: null, outcome: classifyThrow(e), elapsedMs: since() };
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

  /**
   * Report one origin's outcome, TOTALLY. A metric that can throw is a metric
   * that can turn a completed proof into a 500 — and this hook is supplied by
   * the caller, so «it obviously won't throw» is not this module's to assume.
   */
  const report = (
    origin: string,
    stage: ReadStage,
    outcome: GatewayClass | 'oversize' | 'ok' | 'mismatch',
    elapsedMs: number,
  ): void => {
    try { deps.onOrigin?.(origin, stage, outcome, elapsedMs); } catch { /* telemetry is never a verdict */ }
  };

  // ── Pass 1: a header that survives every body-independent D9 step ──
  let header: TxHeader | null = null;
  for (const origin of deps.origins) {
    if (deadline.aborted) break;
    const read = await fetchFrom(origin, `/tx/${txId}`, HEADER_CAP_BYTES, deadline, deps);
    if (read.bytes === null) { report(origin, 'header', read.outcome, read.elapsedMs); continue; }

    const parsed = parseTxHeader(new TextDecoder().decode(read.bytes));
    if (parsed === null) { report(origin, 'header', 'mismatch', read.elapsedMs); continue; }

    const rejection: Rejection | null = await verifyHeader(txId, parsed, deps.trustedOwners);
    if (rejection === null) { report(origin, 'header', 'ok', read.elapsedMs); header = parsed; break; }
    if (rejection.kind === 'skip') {
      // Sound, but not ours. No other gateway will disagree, so stop.
      report(origin, 'header', 'ok', read.elapsedMs);
      return { kind: 'not-ours', txId, reason: rejection.reason };
    }
    // A gateway that answered a request for X with a self-consistent header for
    // Y must not end the search at Y.
    report(origin, 'header', 'mismatch', read.elapsedMs);
  }
  if (header === null) {
    return { kind: 'unproven', txId, reason: 'no gateway produced a verifiable header' };
  }

  // ── The signed tags decide attribution — the caller's record does not ──
  const tags = readVerifiedTags(header, {
    appName: APP_NAME,
    supportedVersions: new Set<string>(SUPPORTED_VERSIONS),
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
    const read = await fetchFrom(origin, `/raw/${txId}`, RAW_CAP_BYTES, deadline, deps);
    if (read.bytes === null) { report(origin, 'raw', read.outcome, read.elapsedMs); continue; }
    const bytes = read.bytes;
    if ((await verifyBytes(header, bytes)) !== null) {
      // A 200 carrying corrupted, truncated or foreign bytes does not stop the
      // search: a later gateway's valid answer neutralizes this one.
      report(origin, 'raw', 'mismatch', read.elapsedMs);
      continue;
    }
    report(origin, 'raw', 'ok', read.elapsedMs);

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
