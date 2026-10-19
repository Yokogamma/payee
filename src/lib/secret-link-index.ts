/**
 * «Секрет по ссылке» (P1): the two maintenance writers of the index and the
 * coverage — the single-entry writer behind every vault-mode save and the
 * full rebuild (plan §1.3).
 *
 * Its own module because both the store and the backup adapter need the
 * rebuild, and the adapter cannot import the store. Everything here works the
 * same way: a RAW snapshot from one readonly transaction, every decision and
 * every WebCrypto call outside any transaction, then ONE readwrite commit that
 * re-checks the snapshot synchronously and aborts on any divergence.
 *
 * Neither writer is gated by SECRET_LINK_ENABLED or by the user setting: an
 * index that stops being maintained while the feature is off would serve a
 * stale head the day it is switched on.
 */

import { decryptSafeboxMeta, type EncryptedSafeboxEntry, type SafeboxEntryData } from './crypto';
import type { ChainVersion } from './chains';
import {
  chooseHead,
  classifyKey,
  encryptIndexBlob,
  indexHeadVersion,
  isIndexBlob,
  rawEquals,
  secretLinkHandle,
  tryDecryptIndexBlob,
  type CoverageRow,
  type IndexBlob,
  type IndexRecord,
  type KeyClassification,
  type KeyRole,
  type KeySlot,
  type RawComparable,
} from './secret-link';
import {
  commitSafeboxEntry,
  commitSecretLinkIndex,
  getDbGeneration,
  readSafeboxPinConfig,
  readSecretLinkSnapshot,
  safeboxRowsOf,
  SecretLinkConflictError,
  StorageResetError,
  SECRET_LINK_COVERAGE_KEY,
  SECRET_LINK_KEY_PREFIX,
  type ExpectVault,
  type IndexWrite,
  type KeyExpect,
  type MaintenanceOp,
  type SecretLinkSnapshot,
} from './storage';

/** Attempts per operation for `key`/`rows` conflicts (plan §1.3: ≤3). */
export const SECRET_LINK_MAX_ATTEMPTS = 3;

/** Only the error's NAME reaches the console: messages of crypto/storage
 *  errors are not ours to vouch for. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function slotOf(map: ReadonlyMap<string, unknown>, key: string): KeySlot {
  return map.has(key) ? { present: true, raw: map.get(key) } : { present: false };
}

function coverageSlotOf(snap: SecretLinkSnapshot): KeySlot {
  return snap.coveragePresent ? { present: true, raw: snap.coverage } : { present: false };
}

async function classifySlot<R extends KeyRole>(
  slot: KeySlot,
  role: R,
  metaKey: CryptoKey,
  now: number,
): Promise<KeyClassification<R>> {
  const decrypted = slot.present ? await tryDecryptIndexBlob(metaKey, slot.raw) : undefined;
  return classifyKey(slot, role, now, decrypted);
}

/** The `expect` that replaces or deletes whatever the snapshot held under a
 *  key — the rebuild's privilege. `null` = the value is outside
 *  `RawComparable` (Date, Map, cycle…): no expect can describe it, so the key
 *  is left alone (fail-closed). */
function replaceExpect(slot: KeySlot): KeyExpect | null {
  if (!slot.present) return { present: false };
  if (isIndexBlob(slot.raw)) return { present: true, ct: slot.raw.ct };
  return rawEquals(slot.raw, slot.raw) ? { present: true, raw: slot.raw as RawComparable } : null;
}

/** Code-unit order, the order `isCoverageRecord` checks. */
function sortRows(rows: CoverageRow[]): CoverageRow[] {
  return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sameRows(a: readonly CoverageRow[], b: readonly CoverageRow[]): boolean {
  return a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);
}

function indexRecordFor(head: ChainVersion, indexedAt: number): IndexRecord {
  return {
    v: 1,
    root: head.root,
    head: { id: head.id, rev: head.rev, createdAt: head.createdAt },
    indexedAt,
  };
}

/** The handle of a chain root, or `null` for a root `secretLinkHandle` refuses
 *  (not canonical lower-case — such a chain is simply not linkable). */
async function handleOrNull(kLink: CryptoKey, root: string): Promise<string | null> {
  try {
    return await secretLinkHandle(kLink, root);
  } catch {
    return null;
  }
}

// ─── Single-entry writer (vault mode) ───────────────────────────────

/** `indexed` — entry, index and coverage landed in one transaction;
 *  `entry-only` — the entry landed WITHOUT index writes (malformed
 *  index/coverage, three `key` conflicts, or the index could not be planned).
 *  The save itself succeeded either way. */
export type EntryIndexOutcome = 'indexed' | 'entry-only';

export interface EntryIndexInput {
  entry: EncryptedSafeboxEntry;
  /** The authenticated meta of `entry` (its `t`/`rev`/`id`/`root`). */
  meta: SafeboxEntryData;
  kLink: CryptoKey;
  metaKey: CryptoKey;
  configId: string;
  dbGeneration: number;
  /** Liveness of the writing session; checked synchronously right before
   *  EVERY commit attempt — a dead session must write nothing at all. */
  mop: MaintenanceOp;
  /** The error a dead session raises (the caller's own type). */
  deadError: () => Error;
  now?: () => number;
}

/** Index + coverage writes for ONE own entry, or `null` when either key is
 *  malformed (the entry is then saved without them, and the damaged key is
 *  NOT overwritten — only a rebuild may replace it). */
async function planEntryWrites(
  snap: SecretLinkSnapshot,
  handle: string | null,
  input: EntryIndexInput,
  now: number,
): Promise<IndexWrite[] | null> {
  const { entry, meta, metaKey } = input;
  // Receipts come first in §1.3 — but only the drop writer (light mode, P3)
  // owns one. A vault-mode save has no receipt to classify.
  const indexKey = handle === null ? null : SECRET_LINK_KEY_PREFIX + handle;
  const indexSlot: KeySlot = indexKey === null ? { present: false } : slotOf(snap.index, indexKey);
  const index = indexKey === null ? null : await classifySlot(indexSlot, 'index', metaKey, now);
  const coverageSlot = coverageSlotOf(snap);
  const coverage = await classifySlot(coverageSlot, 'coverage', metaKey, now);

  // A record under OUR handle that names another root is not ours to trust.
  if (index !== null && index.kind !== 'absent'
      && (index.kind !== 'live' || index.record.root !== meta.root)) return null;
  if (coverage.kind !== 'absent' && coverage.kind !== 'live') return null;

  const writes: IndexWrite[] = [];
  if (indexKey !== null && index !== null) {
    const own: ChainVersion = { id: meta.id, rev: meta.rev, createdAt: meta.createdAt, root: meta.root };
    if (index.kind === 'absent') {
      writes.push({
        key: indexKey,
        expect: { present: false },
        blob: await encryptIndexBlob(metaKey, indexRecordFor(own, now)),
      });
    } else if (index.kind === 'live') {
      // Never downgrade the head: the stored one stays unless ours is more
      // current by the feed's own rule. Kept or replaced, the key is part of
      // the CAS — an unchanged record is rewritten byte for byte.
      const head = chooseHead([indexHeadVersion(index.record), own]);
      const ours = head === own && index.record.head.id !== own.id;
      const stored = (indexSlot as { present: true; raw: unknown }).raw as IndexBlob; // live ⇒ present
      writes.push({
        key: indexKey,
        expect: { present: true, ct: index.ct },
        blob: ours ? await encryptIndexBlob(metaKey, indexRecordFor(own, now)) : stored,
      });
    }
  }

  // ONLY our own processed row joins the coverage (5-H1): rows nobody
  // processed stay in the resolver's delta, where they belong.
  const base = coverage.kind === 'live' ? coverage.record.rows : [];
  const rows = sortRows([
    ...base.filter(r => r[0] !== entry.entryId).map(r => [r[0], r[1]] as CoverageRow),
    [entry.entryId, entry.metaIv],
  ]);
  writes.push({
    key: SECRET_LINK_COVERAGE_KEY,
    expect: coverage.kind === 'live' ? { present: true, ct: coverage.ct } : { present: false },
    blob: await encryptIndexBlob(metaKey, { v: 1, rows }),
  });
  return writes;
}

/**
 * Persist ONE new safebox version together with its index record and its
 * coverage row (plan §1.3 «одна запись», vault mode).
 *
 * Error contract: a `key` conflict re-reads the snapshot (≤3 attempts) and
 * then saves the entry alone; `config`/`lock` conflicts, a reset and every
 * other storage error propagate — NOTHING was written in that case. An index
 * that cannot even be planned never costs the user the save: the entry goes
 * through the original commit contract instead.
 */
export async function commitEntryWithSecretLink(input: EntryIndexInput): Promise<EntryIndexOutcome> {
  const { entry, mop } = input;
  const now = input.now ?? Date.now;
  const ensureLive = () => {
    if (!mop.stillValid()) throw input.deadError();
  };
  const handle = await handleOrNull(input.kLink, input.meta.root);
  let lastExpect: ExpectVault | null = null;

  for (let attempt = 1; attempt <= SECRET_LINK_MAX_ATTEMPTS; attempt++) {
    ensureLive();
    let snap: SecretLinkSnapshot;
    let writes: IndexWrite[] | null;
    try {
      snap = await readSecretLinkSnapshot();
      writes = await planEntryWrites(snap, handle, input, now());
    } catch (err) {
      console.warn('secret link: index not updated for this save:', errorName(err));
      ensureLive();
      await commitSafeboxEntry(entry, input.configId, input.dbGeneration);
      return 'entry-only';
    }
    const expect: ExpectVault = {
      mode: 'vault',
      configId: input.configId,
      dbGeneration: input.dbGeneration,
      lockGeneration: snap.lockGeneration,
    };
    if (writes === null) {
      console.warn('secret link: index or coverage is damaged — saved without updating them');
      ensureLive();
      await commitSafeboxEntry(entry, expect);
      return 'entry-only';
    }
    ensureLive();
    try {
      await commitSafeboxEntry(entry, expect, writes);
      return 'indexed';
    } catch (err) {
      if (!(err instanceof SecretLinkConflictError) || err.kind !== 'key') throw err;
      lastExpect = expect;
    }
  }

  console.warn('secret link: index kept changing under this save — saved without updating it');
  ensureLive();
  await commitSafeboxEntry(entry, lastExpect!);
  return 'entry-only';
}

// ─── Rebuild ────────────────────────────────────────────────────────

/** `rebuilt` — one commit replaced what differed; `unchanged` — the stored
 *  index and coverage already matched; `skipped` — no usable safebox PIN
 *  config (nothing a link could be resolved against); `stopped` — the
 *  operation died, a `lock`/`config` conflict or a reset; `gave-up` — three
 *  `rows`/`key` conflicts; `failed` — anything else (logged). */
export type RebuildOutcome = 'rebuilt' | 'unchanged' | 'skipped' | 'stopped' | 'gave-up' | 'failed';

function sameIndexRecord(a: IndexRecord, b: IndexRecord): boolean {
  return a.root === b.root
    && a.head.id === b.head.id
    && a.head.rev === b.head.rev
    && a.head.createdAt === b.head.createdAt;
}

/** Everything the rebuild writes, from ONE raw snapshot. Unchanged keys are
 *  not rewritten: a fresh ciphertext for the same record would only make
 *  every pending resolver confirmation stale. */
async function planRebuild(
  snap: SecretLinkSnapshot,
  kLink: CryptoKey,
  metaKey: CryptoKey,
  now: number,
): Promise<IndexWrite[]> {
  const writes: IndexWrite[] = [];

  // 1. Meta halves from THIS snapshot's bytes. A row that does not decrypt is
  //    skipped and stays outside the coverage.
  const decrypted: Array<{ entry: EncryptedSafeboxEntry; meta: SafeboxEntryData }> = [];
  for (const entry of snap.entries) {
    try {
      decrypted.push({ entry, meta: await decryptSafeboxMeta(metaKey, entry) });
    } catch { /* skipped */ }
  }

  // 2. The head of every chain, by the feed's rule.
  const byRoot = new Map<string, SafeboxEntryData[]>();
  for (const { meta } of decrypted) {
    const bucket = byRoot.get(meta.root);
    if (bucket) bucket.push(meta);
    else byRoot.set(meta.root, [meta]);
  }
  const desired = new Map<string, IndexRecord>();
  for (const [root, versions] of byRoot) {
    const handle = await handleOrNull(kLink, root);
    const head = chooseHead(versions);
    if (handle === null || head === null) continue;
    desired.set(SECRET_LINK_KEY_PREFIX + handle, indexRecordFor(head, now));
  }

  // 3. Index records: write what differs, delete what no chain owns.
  for (const [key, record] of desired) {
    const slot = slotOf(snap.index, key);
    if (slot.present) {
      const current = await classifySlot(slot, 'index', metaKey, now);
      if (current.kind === 'live' && sameIndexRecord(current.record, record)) continue;
    }
    const expect = replaceExpect(slot);
    if (expect === null) {
      console.warn('secret link: an index key holds a value outside the comparable domain — left as is');
      continue;
    }
    writes.push({ key, expect, blob: await encryptIndexBlob(metaKey, record) });
  }
  for (const [key, raw] of snap.index) {
    if (desired.has(key)) continue;
    const expect = replaceExpect({ present: true, raw });
    if (expect === null) {
      console.warn('secret link: an index key holds a value outside the comparable domain — left as is');
      continue;
    }
    writes.push({ key, expect, blob: null });
  }

  // 4. Coverage = every row that decrypted, and only those.
  const rows = sortRows(decrypted.map(({ entry }) => [entry.entryId, entry.metaIv] as CoverageRow));
  const coverageSlot = coverageSlotOf(snap);
  let coverageCurrent = false;
  if (coverageSlot.present) {
    const current = await classifySlot(coverageSlot, 'coverage', metaKey, now);
    coverageCurrent = current.kind === 'live' && sameRows(current.record.rows, rows);
  }
  if (!coverageCurrent) {
    const expect = replaceExpect(coverageSlot);
    if (expect === null) {
      console.warn('secret link: the coverage holds a value outside the comparable domain — left as is');
    } else {
      writes.push({ key: SECRET_LINK_COVERAGE_KEY, expect, blob: await encryptIndexBlob(metaKey, { v: 1, rows }) });
    }
  }

  // 5. Expired receipts are collected; live and damaged ones are not ours.
  for (const [key, raw] of snap.receipts) {
    const receipt = await classifySlot({ present: true, raw }, 'receipt', metaKey, now);
    if (receipt.kind === 'expired') writes.push({ key, expect: { present: true, ct: receipt.ct }, blob: null });
  }
  return writes;
}

/**
 * Rebuild the whole index and coverage from this tab's OWN raw snapshot
 * (plan §1.3 «Пересборка», vault mode only). No factor, no setting, no flag.
 *
 * NEVER throws: whatever happens here must not change the outcome of the
 * operation that triggered it (open, import, sweep). A `rows`/`key` conflict
 * retries from a fresh snapshot (≤3), `lock`/`config` and a reset stop.
 */
export async function rebuildSecretLinkIndex(
  kLink: CryptoKey,
  metaKey: CryptoKey,
  mop: MaintenanceOp,
  opts: { now?: () => number } = {},
): Promise<RebuildOutcome> {
  const now = opts.now ?? Date.now;
  try {
    for (let attempt = 1; attempt <= SECRET_LINK_MAX_ATTEMPTS; attempt++) {
      if (!mop.stillValid()) return 'stopped';
      // Read synchronously right after the liveness check: the caller's op
      // guards its own generation, so this IS that generation.
      const dbGeneration = getDbGeneration();
      let configId: string;
      try {
        const config = await readSafeboxPinConfig();
        if (config === null) return 'skipped';
        configId = config.configId;
      } catch {
        return 'skipped'; // malformed config — fail closed, nothing to index against
      }
      const snap = await readSecretLinkSnapshot();
      const writes = await planRebuild(snap, kLink, metaKey, now());
      if (!mop.stillValid()) return 'stopped';
      if (writes.length === 0) return 'unchanged';
      try {
        await commitSecretLinkIndex(writes, {
          mode: 'vault',
          configId,
          dbGeneration,
          lockGeneration: snap.lockGeneration,
          safeboxRows: safeboxRowsOf(snap.entries),
        });
        return 'rebuilt';
      } catch (err) {
        if (err instanceof SecretLinkConflictError) {
          if (err.kind === 'rows' || err.kind === 'key') continue;
          return 'stopped';
        }
        if (err instanceof StorageResetError) return 'stopped';
        throw err;
      }
    }
    console.warn('secret link: index rebuild gave up after repeated conflicts — the previous index stays');
    return 'gave-up';
  } catch (err) {
    console.warn('secret link: index rebuild failed — the previous index stays:', errorName(err));
    return 'failed';
  }
}
