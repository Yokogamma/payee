/* eslint-disable react-refresh/only-export-components */
/**
 * Eternal Notes — App Store (React Context)
 *
 * Manages: encryption key, notes, Arweave sync, registration, upload queue,
 * auto-lock. All persistence through IndexedDB (storage.ts). No localStorage.
 *
 * Auto-lock invariants (план v7):
 *  1. lockApp() is SYNCHRONOUS — it never awaits anything before the vault
 *     refs/state are gone.
 *  2. Sensitive state is published ONLY under the current vault epoch: every
 *     async flow captures the epoch up front and re-checks it before touching
 *     React state (prepare/commit split, epoch-aware helpers).
 *  3. The composer draft is encrypted at rest (draft.ts envelope).
 *  4. An upload past its point of no return is COMMITTED: it dispatches and
 *     persists its result unconditionally (upload-flow.ts); no processed
 *     branch leaves a record in 'uploading'.
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  generateMnemonic,
  isValidMnemonic,
  deriveKey,
  deriveOwnerHash,
  deriveSigningKeypair,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  signPayload,
  encrypt,
  encryptEnvelopeV3,
  encryptSafeboxEntry,
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  encryptWithPin,
  decryptWithPin,
  createSafeboxPinBlob,
  verifySafeboxPin,
  isValidSafeboxPin,
  isPinKdfLegacy,
  randomUuidV8,
  WrongPinError,
  SafeboxWrongPinError,
  PinUnlockUnavailableError,
  UnsupportedNoteVersionError,
  bufferToBase64,
  base64ToBuffer,
  type EncryptedSafeboxEntry,
  type NoteData,
  type NoteFormat,
  type PinEncryptedSeed,
  type SafeboxEntryData,
  type SafeboxEntryInput,
  type SafeboxSecretData,
} from './crypto';
import { groupChains, groupSafeboxChains, type NoteChain, type SafeboxChain } from './chains';
import { V3_WRITER_ENABLED, SAFEBOX_WRITER_ENABLED } from './flags';
import {
  isNoteTooLong,
  noteJsonByteLength,
  NoteTooLongError,
  safeboxUploadByteLength,
  MAX_UPLOAD_BODY_BYTES,
  SafeboxEntryTooLargeError,
} from './limits';
import {
  applySafeboxPatch,
  snapshotSafeboxVersion,
  matchesSafeboxQuery,
  type SafeboxEntryPatch,
} from './safebox';
import {
  isArweaveOnline,
  checkRegistration,
  registerWithProxy,
  uploadViaProxy,
  fetchAllNotes,
  getTxStatus,
  getWorkerCapabilities,
  UnsupportedSafeboxVersionError,
} from './arweave';
import {
  initStorage,
  getAllNotes,
  saveNote,
  mergeRestoredNote,
  getAllSafeboxEntries,
  getSafeboxEntryById,
  countSafeboxEntries,
  mergeRestoredSafeboxEntry,
  commitSafeboxEntry,
  readSafeboxPinConfig,
  hasSafeboxPinConfig,
  commitSafeboxPinFailure,
  commitSafeboxPinSuccess,
  commitSafeboxPinDelete,
  commitSafeboxPinWrite,
  safeboxLockSeconds,
  SafeboxConfigChangedError,
  StorageResetError,
  getAllSyncRecords,
  getRecordsByStatus,
  getSyncRecord,
  setSyncRecord,
  commitV3PausedFailure,
  commitV4PausedFailure,
  readV3PauseMeta,
  readV4PauseMeta,
  clearV3UploadsPaused,
  clearV4UploadsPaused,
  getMeta,
  setMeta,
  deleteMeta,
  getPinConfigMeta,
  clearPinConfigMeta,
  resetAll,
  recoverStorage,
  getDbGeneration,
  noteExternalReset,
  isDbVersionError,
  type SyncRecord,
} from './storage';
import { afterPoll, claimRestoredForUi } from './sync-transitions';
import { runUploadAttempt, uploadItemId, MalformedRecordError, type UploadItem } from './upload-flow';
import { DraftStore, dropLegacyPlaintextDraft, DRAFT_STORAGE_KEY } from './draft';
import {
  consumeHiddenMarker,
  markHidden,
  decideLockOnReturn,
  decideBootstrapLock,
  isValidAutoLockTimeout,
  type AutoLockTimeout,
  type BootstrapNavigationType,
} from './auto-lock';
import { userFacingUploadError, userFacingRegistrationError } from './errors';
import { copyTextToClipboard } from './clipboard';

// Re-exported for callers that only need the storage key (reset paths, tests).
export { DRAFT_STORAGE_KEY };
// Re-exported so UI code has ONE import surface for safebox errors (this one
// is raised inside storage.ts, but it reaches the user through store actions).
export { SafeboxConfigChangedError } from './storage';

// ─── Types ───────────────────────────────────────────────────────────

export type AppScreen = 'loading' | 'landing' | 'onboarding' | 'restore' | 'pin' | 'main' | 'error';

const SESSION_STORAGE_KEY = 'eternal-notes-session';

/** Per-note sync state for the card indicator: SyncRecord.status, or 'queued'
 *  when the note has no record yet (never attempted). */
export type NoteSyncStatus = 'queued' | 'uploading' | 'accepted' | 'confirmed' | 'error';

/** Card-level sync info: status + txId (for the "open TX" menu action). */
export interface NoteSyncInfo {
  status: NoteSyncStatus;
  txId?: string;
}

export interface ArweaveState {
  enabled: boolean;
  online: boolean;
  syncing: boolean;
  registered: boolean;
  unsyncedCount: number;
  /** False until the first refreshSyncCounts() has run. While false the per-note
   *  statuses are not yet populated and MUST NOT be used to claim anything is
   *  safe to delete. (Reset safety is derived in Main from notes+syncStatuses,
   *  which are always consistent with the visible UI — not from an aggregate.) */
  countsReady: boolean;
  errorCount: number;
  acceptedCount: number;
  confirmedCount: number;
  /** Permanently-quarantined records (SyncRecord.terminalError) — NOT part of
   *  errorCount: no retry can ever fix them (e.g. a record written by a newer
   *  app version). Settings shows a dedicated explainer instead of a lying
   *  «Ошибки: N — Повторить». */
  quarantinedCount: number;
  /** STORAGE-BACKED reset risk, SPLIT BY KIND: every stored record minus the
   *  confirmed ones. The reset dialog must use THIS, not the visible `notes` —
   *  an invisible quarantined/undecryptable record (or the whole safebox, which
   *  is invisible while locked) would otherwise let «всё подтверждено»
   *  greenlight deleting data a newer client could still read. */
  resetRisk: { notes: number; safebox: number };
  /** Safebox sync aggregates, kept SEPARATE from the notes ones: a shared
   *  counter makes «Синхронизировано X из N» go negative (the notes formula is
   *  allNotes − accepted − confirmed over the SAME record set). */
  safebox: {
    unsyncedCount: number;
    acceptedCount: number;
    confirmedCount: number;
    errorCount: number;
    quarantinedCount: number;
  };
  lastSync: number | null;
  lastError: string | null;
}

const INITIAL_ARWEAVE: ArweaveState = {
  enabled: false,
  online: false,
  syncing: false,
  registered: false,
  unsyncedCount: 0,
  countsReady: false,
  errorCount: 0,
  acceptedCount: 0,
  confirmedCount: 0,
  quarantinedCount: 0,
  resetRisk: { notes: 0, safebox: 0 },
  safebox: {
    unsyncedCount: 0,
    acceptedCount: 0,
    confirmedCount: 0,
    errorCount: 0,
    quarantinedCount: 0,
  },
  lastSync: null,
  lastError: null,
};

export class VaultMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultMismatchError';
  }
}

export class PinLockedError extends Error {
  secondsLeft: number;
  constructor(secondsLeft: number) {
    super(`PIN заблокирован на ${secondsLeft} сек`);
    this.name = 'PinLockedError';
    this.secondsLeft = secondsLeft;
  }
}

export class PinWipedError extends Error {
  constructor() {
    super('PIN удалён после 10 неудачных попыток. Введите seed-фразу.');
    this.name = 'PinWipedError';
  }
}

/** A save/edit is already in flight for this target. The UI must NOT treat
 *  this as success: keep the text/draft, keep the modal open, no toast. The
 *  disabled button is the primary guard — this error is the backstop against
 *  a double submit racing ahead of the re-render. */
export class OperationInFlightError extends Error {
  constructor() {
    super('Операция уже выполняется');
    this.name = 'OperationInFlightError';
  }
}

/** A writer action called while its build-time flag is false (R3 / R4). A
 *  silent no-op is forbidden — the calling modal would read it as a successful
 *  save. */
export class WriterDisabledError extends Error {
  constructor(message = 'Редактирование заметок недоступно в этой версии приложения.') {
    super(message);
    this.name = 'WriterDisabledError';
  }
}

// ─── Safebox errors ─────────────────────────────────────────────────

/** The safebox PIN is in its progressive lockout window. */
export class SafeboxPinLockedError extends Error {
  secondsLeft: number;
  constructor(secondsLeft: number) {
    super(`PIN сейфа заблокирован на ${secondsLeft} сек`);
    this.name = 'SafeboxPinLockedError';
    this.secondsLeft = secondsLeft;
  }
}

/** Ten wrong PINs removed the safebox PIN CONFIGURATION. The entries are
 *  untouched — access is restored by entering the full seed phrase. */
export class SafeboxPinWipedError extends Error {
  constructor() {
    super('PIN сейфа удалён после 10 неудачных попыток. Восстановите доступ по seed-фразе.');
    this.name = 'SafeboxPinWipedError';
  }
}

/** No safebox PIN is configured (fresh device, post-wipe, after deactivation). */
export class SafeboxNotConfiguredError extends Error {
  constructor() {
    super('PIN сейфа не установлен.');
    this.name = 'SafeboxNotConfiguredError';
  }
}

/** The safebox section is not unlocked (any more) — a lock, an app lock or a
 *  config replacement won the race. NOTHING is published. */
export class SafeboxLockedError extends Error {
  constructor() {
    super('Сейф заблокирован.');
    this.name = 'SafeboxLockedError';
  }
}

/** Setting a safebox PIN identical to the MAIN PIN defeats the whole gate. */
export class SafeboxSamePinError extends Error {
  constructor() {
    super('PIN сейфа должен отличаться от основного PIN-кода.');
    this.name = 'SafeboxSamePinError';
  }
}

/** The seed phrase entered for a safebox PIN reset is not this vault's. */
export class SafeboxSeedMismatchError extends Error {
  constructor() {
    super('Эта seed-фраза не подходит к хранилищу на устройстве.');
    this.name = 'SafeboxSeedMismatchError';
  }
}

/** Setting a PIN while safebox DATA exists but no config does — allowed only
 *  through full seed entry (or the one-shot post-restore window). */
export class SafeboxSeedRequiredError extends Error {
  constructor() {
    super('Введите полную seed-фразу, чтобы установить PIN для существующего сейфа.');
    this.name = 'SafeboxSeedRequiredError';
  }
}

/**
 * Manual «Проверить обновления» — the SAME Arweave sweep restore runs, reported
 * separately so it never borrows the restore banners («Восстанавливаем…»,
 * «Восстановлено N»), which belong to a different, seed-driven scenario.
 *
 * Counts are CHAINS, not versions: a note edited three times is one note.
 * `changedSafebox` counts safebox ROOTS that received at least one previously
 * unknown version — new and updated chains together, because a local root is
 * not knowable without decrypting the whole local safebox (the root lives
 * inside the encrypted meta envelope).
 *
 * `partial` = the sweep ran but some pages/payloads were unreachable. A total
 * failure is `error` instead — see ArweaveIndexUnavailableError.
 */
export type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking'; progress: { done: number; total: number } | null }
  | {
      status: 'done';
      at: number;
      addedNotes: number;
      updatedNotes: number;
      changedSafebox: number;
      partial: boolean;
    }
  | { status: 'error'; at: number };

interface NotesStore {
  screen: AppScreen;
  isReady: boolean;
  mnemonic: string | null;
  notes: NoteData[];
  isEncrypting: boolean;
  searchQuery: string;
  filteredNotes: NoteData[];
  /** Version chains — the READER view of `notes`. ALWAYS active regardless of
   *  V3_WRITER_ENABLED (after a W3→R3 rollback the store may hold v3 chains
   *  and R3 must render them as one card per chain, not one per version). */
  chains: NoteChain[];
  /** Chains filtered by the search query against the CURRENT version's text. */
  filteredChains: NoteChain[];
  /** v3 uploads are paused by the worker's kill switch (persisted marker).
   *  Shown as a standing banner with a manual resume button. */
  v3Paused: boolean;
  /** Same, for safebox (v4) uploads — an independent switch and marker. */
  v4Paused: boolean;

  // ── Safebox (§6) ──────────────────────────────────────────────────
  /** Per-tab, in memory only — never persisted. */
  safeboxUnlocked: boolean;
  /** Increments on EVERY section lock (including hidden/pagehide edges while
   *  the section is already locked). The UI keys the whole safebox subtree on
   *  it, so a lock discards every local secret state — the half-typed PIN and,
   *  critically, the seed-reset grid. */
  safeboxLockGeneration: number;
  /** A safebox PIN configuration exists on this device. */
  safeboxPinConfigured: boolean;
  /** At least one safebox entry is stored locally (known while LOCKED). */
  safeboxDataPresent: boolean;
  /** Stored entry VERSIONS — powers «Найден сейф: N записей». */
  safeboxEntryCount: number;
  /** Decrypted META of every version (empty while locked). */
  safeboxEntries: SafeboxEntryData[];
  /** Version chains over the authenticated envelope fields. */
  safeboxChains: SafeboxChain[];
  /** Chains filtered by the safebox-only search (non-secret fields). */
  filteredSafeboxChains: SafeboxChain[];
  safeboxSearchQuery: string;
  /** How many safebox entry versions the last restore recovered (null = none
   *  yet). Deliberately NOT merged into the notes «Восстановлено M» counter. */
  restoredSafeboxCount: number | null;
  arweave: ArweaveState;
  /** noteId → sync info, refreshed together with the aggregate counters. */
  syncStatuses: Record<string, NoteSyncInfo>;
  restoring: boolean;
  /** Live progress of the current restore sweep (payloads settled / total). */
  restoreProgress: { done: number; total: number } | null;
  restoreError: string | null;
  /** How many NEW chains (user-perceived notes) the last completed restore
   *  recovered (null = no restore yet). */
  restoredCount: number | null;
  /** How many EXISTING chains gained new versions in that restore. */
  restoredUpdatedCount: number | null;
  /** Outcome of the manual «Проверить обновления» run (see UpdateCheckState). */
  updateCheck: UpdateCheckState;
  vaultError: string | null;
  hasPin: boolean;
  /** Current auto-lock threshold (§1): null=never, 0=immediately, 300/1800 s. */
  autoLockTimeout: AutoLockTimeout;
  bootError: string | null;
  /** Another tab still holds the previous IndexedDB schema, so the upgrade
   *  cannot start — the user must close it (then this clears by itself). */
  storageBlocked: boolean;
  /** The stored database is NEWER than this build (a newer client migrated
   *  it). The error screen must offer RELOAD ONLY — the data is intact and the
   *  destructive reset would throw away everything unsynced. */
  storageOutdated: boolean;

  // Actions
  createNewWallet: () => Promise<string>;
  confirmMnemonic: (mnemonic: string) => Promise<void>;
  restoreFromMnemonic: (mnemonic: string) => Promise<void>;
  addNote: (text: string) => Promise<void>;
  /** Create a NEW version of the chain rooted at rootId (fresh UUIDv8 noteId,
   *  rev = current.rev+1). Regular edits pass fmt 'md' (default); «Восстановить
   *  версию» passes the SOURCE version's fmt so a plain note never silently
   *  turns into markdown. Throws WriterDisabledError under the OFF flag,
   *  OperationInFlightError on a concurrent edit of the same chain,
   *  NoteTooLongError over the byte limit. */
  editNote: (rootId: string, newText: string, opts?: { fmt?: NoteFormat }) => Promise<void>;
  /** Manual resume of paused v3 uploads (clears the marker unconditionally). */
  resumeV3Uploads: () => Promise<void>;
  /** Same, for the safebox queue. */
  resumeV4Uploads: () => Promise<void>;
  setSearchQuery: (query: string) => void;

  // ── Safebox actions (§6) ──────────────────────────────────────────
  /** First activation, or re-activation on a device that already holds safebox
   *  DATA. In the latter case the caller MUST pass the full seed phrase
   *  (proof-by-decrypt) — the only exception is the one-shot post-restore
   *  window in the same session. Writer-INDEPENDENT (works on R4). */
  activateSafebox: (pin: string, opts?: { mnemonic?: string }) => Promise<void>;
  /** Argon2id → verifier decrypt → metering → derive the meta key → decrypt all
   *  metas → publish under BOTH epochs. */
  unlockSafebox: (pin: string) => Promise<void>;
  /** Synchronous: bumps the section epoch, drops the meta key and every
   *  decrypted meta. Safe to call at any time. */
  lockSafebox: () => void;
  /** Re-arm the 5-minute idle lock (called on any safebox interaction). */
  touchSafebox: () => void;
  changeSafeboxPin: (currentPin: string, newPin: string) => Promise<void>;
  deactivateSafebox: (currentPin: string) => Promise<void>;
  /** Reset the PIN with the full seed phrase — WITHOUT touching the data. */
  resetSafeboxPinWithSeed: (mnemonic: string, newPin: string) => Promise<void>;
  getSafeboxPinLockState: () => Promise<{ lockedSeconds: number; attempts: number; configured: boolean }>;
  /** Writer-gated (SAFEBOX_WRITER_ENABLED). */
  addSafeboxEntry: (input: SafeboxNewEntry) => Promise<void>;
  /** Writer-gated. Patch contract: anything not explicitly changed is carried
   *  over from the previous version (§6). */
  editSafeboxEntry: (rootId: string, patch: SafeboxEntryPatch) => Promise<void>;
  /** Writer-gated. Creates a NEW version at the chain head holding the FULL
   *  content of `versionId` (title/login/url/note/password/files). */
  restoreSafeboxVersion: (rootId: string, versionId: string) => Promise<void>;
  /** Decrypt one entry's password for a bounded on-screen reveal. */
  revealSafeboxSecret: (entryId: string) => Promise<string>;
  /** Copy straight from the decrypted string — the plaintext NEVER enters the
   *  DOM. Resolves false when the clipboard write was refused. */
  copySafeboxPassword: (entryId: string) => Promise<boolean>;
  /** Decrypt one attachment and hand it to the browser as a download. */
  downloadSafeboxAttachment: (entryId: string, fid: string) => Promise<void>;
  setSafeboxSearchQuery: (query: string) => void;
  goToRestore: () => void;
  goToOnboarding: () => void;
  goToLanding: () => void;
  showMnemonic: () => string | null;
  resetApp: () => Promise<void>;
  toggleArweave: () => Promise<void>;
  retrySync: () => Promise<void>;
  registerWithInvite: (inviteCode: string) => Promise<void>;
  checkAccess: () => Promise<void>;
  setupPin: (pin: string) => Promise<void>;
  removePin: () => Promise<void>;
  unlockWithPin: (pin: string) => Promise<void>;
  /** Current PIN lockout/attempt state — read on PinUnlock mount so a reload
   *  doesn't bypass the visible lockout timer. */
  getPinLockState: () => Promise<{ lockedSeconds: number; attempts: number }>;
  /** Persist-first (§6): rejects when the meta write fails — the UI keeps the
   *  old value and shows the error. */
  setAutoLockTimeout: (t: AutoLockTimeout) => Promise<void>;
  /** Synchronous lock: wipes vault refs/state + session, keeps the encrypted
   *  draft, shows the PIN screen. */
  lockApp: () => void;
  /** Encrypted-at-rest draft (§2). All three are safe to call while locked
   *  (persist/read become no-ops without a vault key). */
  persistDraft: (text: string) => Promise<void>;
  readDraft: () => Promise<string | null>;
  clearDraft: () => void;
  resetBrokenStorage: () => Promise<void>;
  retryRestore: () => Promise<void>;
  /** Manual «Проверить обновления»: pulls whatever other devices published,
   *  merging it into this vault. No seed entry, no upload — read-only, so it
   *  works with sync disabled and with an unregistered key. */
  checkForUpdates: () => Promise<void>;
  clearRestoreStatus: () => void;
  dismissError: () => void;
}

/** What the entry form submits for a brand-new safebox entry. */
export interface SafeboxNewEntry {
  title: string;
  login: string;
  url: string;
  note: string;
  password: string;
  files: Array<{ name: string; mime: string; size: number; data: string }>;
}

const StoreContext = createContext<NotesStore | null>(null);

// ─── Stale uploading threshold ───────────────────────────────────────

const STALE_UPLOADING_MS = 10 * 60 * 1000; // 10 minutes (matches server reservation timeout)
const RECHECK_BACKOFF_MS = 5 * 60 * 1000;  // min gap between recheck re-attempts (503 backoff)
const TX_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TX_CONFIRM_THRESHOLD = 25;            // Arweave confirmations needed
const TX_TIMEOUT_MS = 60 * 60 * 1000;      // 1 hour — mark pending TX as error

// ─── Vault snapshot (prepare/commit split, §4) ──────────────────────

/** Everything commitVaultSnapshot publishes — built entirely in locals so a
 *  lock during preparation discards it without a trace. */
export interface VaultSnapshot {
  mnemonic: string;
  key: CryptoKey;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  pkB64: string;
  ownerHash: string;
  notes: NoteData[];
  savedEnabled: boolean;
}

/**
 * Pure preparation: derive keys, run the vault-identity guards, decrypt all
 * notes — WITHOUT touching React state or refs. Throws VaultMismatchError on
 * a foreign vault; throws AbortError if the caller's signal fires (lock).
 */
export async function prepareVaultSnapshot(
  mn: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VaultSnapshot> {
  const { signal } = opts;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Vault preparation aborted', 'AbortError');
  };

  const key = await deriveKey(mn);
  throwIfAborted();
  const { privateKey, publicKey } = await deriveSigningKeypair(mn);
  const ownerHash = await deriveOwnerHash(publicKey);
  const pkB64 = bufferToBase64(publicKey);
  throwIfAborted();

  // VAULT IDENTITY GUARD
  const savedVaultPK = await getMeta<string>('vault-public-key');
  if (savedVaultPK && savedVaultPK !== pkB64) {
    throw new VaultMismatchError(
      'На устройстве уже есть данные другого хранилища. ' +
      'Выполните «Сбросить приложение» перед восстановлением другого seed.'
    );
  }

  // Decrypt all notes into LOCALS (never state — commit publishes them).
  const encrypted = await getAllNotes();
  const decrypted: NoteData[] = [];
  let decryptedCount = 0;
  for (const enc of encrypted) {
    throwIfAborted();
    try {
      const decoded = await decryptNote(key, enc);
      decrypted.push({ id: enc.noteId, text: decoded.text, createdAt: decoded.createdAt, ...decoded.meta });
      decryptedCount++;
    } catch {
      // Skip notes that can't be decrypted (wrong key, corrupted, or an
      // unsupported version written by a NEWER client — fail-closed dispatch).
      // Invisible records still count in the storage-backed resetRiskCount.
    }
  }
  decrypted.sort((a, b) => b.createdAt - a.createdAt);

  // Legacy binding: if vault-public-key absent but notes exist,
  // only bind if at least one note decrypted successfully (proves ownership)
  if (!savedVaultPK && encrypted.length > 0 && decryptedCount === 0) {
    throw new VaultMismatchError(
      'Seed-фраза не подходит к существующим заметкам на устройстве. ' +
      'Введите правильный seed или выполните «Сбросить приложение».'
    );
  }

  const savedEnabled = !!(await getMeta<boolean>('ar-enabled'));
  return { mnemonic: mn, key, privateKey, publicKey, pkB64, ownerHash, notes: decrypted, savedEnabled };
}

/** PerformanceNavigationTiming.type mapped to the §5 matrix. */
function currentNavigationType(): BootstrapNavigationType {
  try {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    const t = entries[0]?.type;
    if (t === 'reload' || t === 'back_forward') return t;
    if (t === 'navigate' || t === 'prerender') return 'navigate';
    return 'none';
  } catch {
    return 'none';
  }
}

// ─── Provider ────────────────────────────────────────────────────────

export function NotesProvider({ children }: { children: ReactNode }) {
  // UI state
  const [screen, setScreen] = useState<AppScreen>('loading');
  const [isReady, setReady] = useState(false);
  const readyRef = useRef(false);

  // Core state
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteData[]>([]);
  // Mirror of `notes` for async flows (restore, editNote freshness) that
  // outlive the closure they were created in — state captured there is stale.
  // The ref is mirrored SYNCHRONOUSLY at every publication site
  // (commitVaultSnapshot / clearVaultState / publishNotes) — deliberately NO
  // passive-effect sync here: a pending effect from an older render could
  // flush at the start of a discrete event and roll the ref back past a
  // publishNotes update, handing editNote a stale current (chain fork).
  const notesRef = useRef<NoteData[]>([]);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState<number | null>(null);
  const [restoredUpdatedCount, setRestoredUpdatedCount] = useState<number | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({ status: 'idle' });
  // v3 uploads paused by the worker kill switch. Authoritative state lives in
  // the shared IndexedDB marker (readV3PauseMeta) — this mirrors it for the UI.
  const [v3Paused, setV3Paused] = useState(false);
  const [v4Paused, setV4Paused] = useState(false);
  const [restoredSafeboxCount, setRestoredSafeboxCount] = useState<number | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // A tab holding the old schema is blocking the v1→v2 upgrade.
  const [storageBlocked, setStorageBlocked] = useState(false);
  // This build is OLDER than the stored database (a newer client migrated it).
  const [storageOutdated, setStorageOutdated] = useState(false);
  const [autoLockTimeout, setAutoLockTimeoutState] = useState<AutoLockTimeout>(null);
  // Opaque privacy gate (review rounds 2–3): raised SYNCHRONOUSLY on the
  // hidden edge — or when a vault COMMITS into a hidden tab — and dropped only
  // by the lifecycle cycle that owns it, so no frame painted after a return
  // can show plaintext that the verdict then locks away.
  //
  // IMPERATIVE ON PURPOSE (review): the gate element is ALWAYS mounted and its
  // `hidden`/`inert` attributes are flipped straight on the DOM nodes. React
  // state would only reach the DOM on the next commit, which is NOT guaranteed
  // to happen before the browser takes the BFCache snapshot inside `pagehide`
  // — exactly the moment the gate exists for.
  const gateElRef = useRef<HTMLDivElement | null>(null);
  const gateContentRef = useRef<HTMLDivElement | null>(null);
  const lockGateRef = useRef(false);
  function setLockGate(up: boolean): void {
    lockGateRef.current = up;
    // ATTRIBUTES, not properties: attribute reflection is universal, whereas
    // the `inert` IDL property is missing in some engines (and in jsdom), where
    // the assignment would silently do nothing.
    const gate = gateElRef.current;
    const content = gateContentRef.current;
    if (gate) {
      if (up) gate.removeAttribute('hidden');
      else gate.setAttribute('hidden', '');
    }
    if (content) {
      if (up) content.setAttribute('inert', '');
      else content.removeAttribute('inert');
    }
  }
  // Ownership of the pending return-verdict (review round 3): bumped on every
  // hidden edge, lock and vault commit. A verdict may apply itself — lock or
  // drop the gate — only if its generation (and vault epoch) is still current;
  // a superseded verdict must neither unlock a NEW away-interval's gate nor
  // lock a vault the user has re-opened since.
  const lockCheckGenerationRef = useRef(0);
  const lockCheckPendingRef = useRef(false);
  // Orders every CONFIG publication (reconcile / return-verdict): last caller
  // wins, an older in-flight read can never overwrite newer refs (round 4).
  const reconcileGenerationRef = useRef(0);

  // Crypto refs (not React state — needed synchronously in async flows)
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const ownerHashRef = useRef<string | null>(null);
  const signingKeyRef = useRef<Uint8Array | null>(null);
  const publicKeyRef = useRef<Uint8Array | null>(null);
  // Synchronous mirror of the `mnemonic` state: the safebox derives its keys
  // from the seed inside async flows that outlive their closure.
  const mnemonicRef = useRef<string | null>(null);

  // ─── Safebox slice (§3/§6) ────────────────────────────────────────
  const [safeboxUnlocked, setSafeboxUnlocked] = useState(false);
  const [safeboxPinConfigured, setSafeboxPinConfigured] = useState(false);
  const [safeboxEntryCount, setSafeboxEntryCount] = useState(0);
  const [safeboxEntries, setSafeboxEntries] = useState<SafeboxEntryData[]>([]);
  const [safeboxSearchQuery, setSafeboxSearchQuery] = useState('');
  /** Mirrors the section epoch for the UI: every lock bumps it, and the
   *  safebox subtree is keyed on it so ALL local secret state is discarded. */
  const [safeboxLockGeneration, setSafeboxLockGeneration] = useState(0);
  // Mirror for async flows (edit/restore-version read the chain head from it).
  const safeboxEntriesRef = useRef<SafeboxEntryData[]>([]);
  /** META key — held ONLY while the section is unlocked. The SECRET key is
   *  never stored anywhere: it is derived on demand and dropped. */
  const safeboxMetaKeyRef = useRef<CryptoKey | null>(null);
  /** The PIN configuration this unlocked session belongs to. Every secret
   *  publication re-reads the config from IndexedDB and compares against it —
   *  BroadcastChannel is a fast path, never the guarantee (§2). */
  const safeboxConfigIdRef = useRef<string | null>(null);
  /** Bumped by EVERY section lock — and by every vault lifecycle
   *  invalidation. Async safebox flows capture BOTH this and vaultEpochRef and
   *  re-check both before publishing anything. */
  const safeboxSectionEpochRef = useRef(0);
  const safeboxIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One-shot permission to activate the safebox WITHOUT re-entering the seed,
   *  valid only in the session that just performed a manual restore. Bound to
   *  the vault epoch; consumed on use and dropped on lock/reset/failure. */
  const freshRestoreRef = useRef<number | null>(null);
  const safeboxAddInFlightRef = useRef(false);
  const safeboxEditInFlightRef = useRef(new Set<string>());
  /** Synchronous mirror of `safeboxUnlocked` for the lifecycle listeners (a
   *  React state read inside an event handler would be stale). */
  const safeboxUnlockedRef = useRef(false);

  /** Fixed 5-minute idle lock (no setting in v1). */
  const SAFEBOX_IDLE_MS = 5 * 60 * 1000;

  // ── Clipboard auto-clear (honest semantics, §6) ────────────────────
  // Best-effort: a clipboard write only works while the document has focus, so
  // a background tab defers the attempt to the next focus/visible edge. The
  // timer lives OUTSIDE every epoch gate — clearing is not a secret
  // publication, and it must survive a safebox lock.
  const CLIPBOARD_CLEAR_MS = 60_000;
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardClearPendingRef = useRef(false);

  function tryClearClipboard(): void {
    if (!document.hasFocus()) {
      clipboardClearPendingRef.current = true; // retry on the next focus edge
      return;
    }
    clipboardClearPendingRef.current = false;
    // Silent on failure: nagging about a clipboard we cannot touch helps nobody.
    void navigator.clipboard?.writeText('').catch(() => {});
  }

  function armClipboardClear(): void {
    if (clipboardClearTimerRef.current !== null) clearTimeout(clipboardClearTimerRef.current);
    clipboardClearPendingRef.current = false;
    clipboardClearTimerRef.current = setTimeout(() => {
      clipboardClearTimerRef.current = null;
      tryClearClipboard();
    }, CLIPBOARD_CLEAR_MS);
  }

  function publishSafeboxEntries(apply: (prev: SafeboxEntryData[]) => SafeboxEntryData[]): void {
    safeboxEntriesRef.current = apply(safeboxEntriesRef.current);
    setSafeboxEntries(apply);
  }

  // Auto-lock machinery. The epoch is the vault's identity in time: bumped by
  // every lock/reset, captured by every async flow, checked before every
  // publication of sensitive state.
  const vaultEpochRef = useRef(0);
  // Aborts the in-flight vault operation (prepare or restore sweep) on lock.
  const vaultOpAbortRef = useRef<AbortController | null>(null);
  // Ref mirrors for values the lifecycle handlers need SYNCHRONOUSLY (a React
  // state read inside an event listener would be stale).
  const hasPinRef = useRef(false);
  const autoLockTimeoutRef = useRef<AutoLockTimeout>(null);

  const applyHasPin = (v: boolean) => { hasPinRef.current = v; setHasPin(v); };
  const applyAutoLockTimeout = (t: AutoLockTimeout) => { autoLockTimeoutRef.current = t; setAutoLockTimeoutState(t); };

  // Encrypted-at-rest draft (§2) + multi-tab identity (§8)
  const draftStoreRef = useRef<DraftStore | null>(null);
  if (draftStoreRef.current === null) draftStoreRef.current = new DraftStore(sessionStorage);
  const tabIdRef = useRef<string | null>(null);
  if (tabIdRef.current === null) tabIdRef.current = crypto.randomUUID();
  const channelRef = useRef<BroadcastChannel | null>(null);
  // §8 dedup: messageIds already handled, so a replayed/duplicated delivery
  // never re-runs a handler (a stale re-lock would abort a NEWER unlock).
  const seenMessageIdsRef = useRef(new Set<string>());

  // Arweave state with ref-first pattern
  const [arweaveState, setArweaveReactState] = useState<ArweaveState>(INITIAL_ARWEAVE);
  const arweaveRef = useRef<ArweaveState>(INITIAL_ARWEAVE);

  // ref-first wrapper: update ref synchronously, then React state
  function setArweave(updater: Partial<ArweaveState> | ((prev: ArweaveState) => ArweaveState)) {
    const prev = arweaveRef.current;
    const next = typeof updater === 'function'
      ? updater(prev)
      : { ...prev, ...updater };
    arweaveRef.current = next;
    setArweaveReactState(next);
  }

  // Per-note sync info (joined notes + syncRecords) for the card indicators
  const [syncStatuses, setSyncStatuses] = useState<Record<string, NoteSyncInfo>>({});

  // Upload queue refs. The queue is TYPED by kind (notes and safebox entries
  // share one pipeline, one quota and one id space) — the kind travels WITH the
  // item, so no downstream step has to shape-sniff a record read from
  // IndexedDB to decide how to serialize it.
  const uploadQueueRef = useRef<UploadItem[]>([]);
  const queuedIdsRef = useRef(new Set<string>());
  const isProcessingRef = useRef(false);
  // Bumped on lock/reset: the running processor stops taking iterations and
  // never mutates the NEW generation's queue (§7).
  const queueGenerationRef = useRef(0);

  // Single-flight guards (synchronous check-and-claim BEFORE the first await —
  // React state is not a mutex; a double click can outrun the re-render that
  // disables the button). addNote: one at a time at BOTH flag values (the v1
  // path is just as double-click-vulnerable); editNote: per-root, so edits of
  // DIFFERENT chains may proceed concurrently.
  const addInFlightRef = useRef(false);
  const editInFlightRef = useRef(new Set<string>());

  /** Publish a note-list transformation to BOTH the synchronous ref and React
   *  state with the SAME functional update. The ref must be fresh IMMEDIATELY:
   *  a second sequential editNote reads current rev/prev from it before React
   *  re-renders (a useEffect-synced ref would hand it stale data and fork the
   *  chain unintentionally). */
  function publishNotes(apply: (prev: NoteData[]) => NoteData[]): void {
    notesRef.current = apply(notesRef.current);
    setNotes(apply);
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── TX Status Polling Effect ──────────────────────────────────────
  useEffect(() => {
    if (!isReady) return;
    const intervalId = setInterval(() => {
      void pollTxStatuses().catch(err => console.error('pollTxStatuses:', err));
    }, TX_POLL_INTERVAL_MS);
    void pollTxStatuses().catch(err => console.error('pollTxStatuses:', err));
    function onVisible() {
      if (document.visibilityState === 'visible')
        void pollTxStatuses().catch(err => console.error('pollTxStatuses visibility:', err));
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(intervalId); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // ─── Online/Offline Auto-Reconnect ────────────────────────────────
  useEffect(() => {
    if (!isReady) return;
    async function handleOnline() {
      const online = await isArweaveOnline();
      setArweave(prev => ({ ...prev, online }));
      if (online && arweaveRef.current.enabled)
        void retryAllPending().catch(err => console.error('auto-reconnect:', err));
    }
    function handleOffline() {
      setArweave(prev => ({ ...prev, online: false }));
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // ─── Auto-lock lifecycle (§5) ──────────────────────────────────────
  useEffect(() => {
    // A page that LOADS hidden never fires a hidden transition — re-arm the
    // marker so the eventual return still measures the away-time, and
    // pre-gate anything a hidden bootstrap may still publish (session seed).
    if (document.visibilityState === 'hidden') {
      markHidden(sessionStorage, Date.now());
      if (vaultPresentInTab()) setLockGate(true);
    }

    // Hidden edge: record the marker, supersede any pending verdict, and
    // raise the opaque gate over anything that IS or MAY BECOME an open vault
    // (committed key, pending openVault, session seed — review round 3).
    // Nothing paints while hidden, so the FIRST frame after the return
    // already carries the gate — plaintext can never flash before the
    // verdict below lands.
    const onHiddenEdge = () => {
      markHidden(sessionStorage, Date.now());
      lockCheckGenerationRef.current++;
      lockCheckPendingRef.current = false;
      // The safebox locks on EVERY hidden edge, with no grace period: a
      // navigation/BFCache freeze can bypass the visibility edge and later
      // restore the saved heap. Raise the opaque privacy gate BEFORE the
      // section is torn down — a plain setState from `pagehide` is not
      // guaranteed to remove already-painted plaintext before the BFCache
      // snapshot; the gate (`lock-gate` + `inert`) is what actually covers it.
      if (vaultPresentInTab() || safeboxUnlockedRef.current) setLockGate(true);
      lockSafeboxNow();
    };

    const evaluateReturn = () => {
      const now = Date.now();
      const myGen = lockCheckGenerationRef.current;
      const myEpoch = vaultEpochRef.current;
      const marker = consumeHiddenMarker(sessionStorage, now);
      // Fast path: current refs already demand a lock — do it synchronously.
      // lockApp drops the gate and reconciles its target screen itself.
      if (decideLockOnReturn(autoLockTimeoutRef.current, hasPinRef.current, marker, now)) {
        lockApp();
        return;
      }
      if (marker.kind === 'none') {
        // Nothing to judge — but never drop a gate an in-flight verdict owns
        // (visibilitychange and pageshow can both fire for one return).
        if (!lockCheckPendingRef.current) setLockGate(false);
        return;
      }
      // The refs may be STALE (a frozen tab misses config broadcasts, §8).
      // "No lock" becomes FINAL only when the AUTHORITATIVE IndexedDB config
      // confirms it — the gate stays up (Main is mounted but cannot paint
      // anything sensitive) until the verdict on the SAME consumed marker.
      // An unreadable config fails CLOSED: a vault we cannot vouch for locks.
      lockCheckPendingRef.current = true;
      void (async () => {
        // The verdict must reflect the LATEST authoritative config. If a newer
        // reconcile — or a local config write — lands while we read, our
        // snapshot cannot be trusted in EITHER direction: completing a stale
        // "no lock" would drop the gate with the marker already consumed
        // (round 5 high). So a superseded snapshot never completes the
        // verdict — gate and pending stay, and we re-decide against the
        // newest state with the SAME consumed marker.
        for (let attempt = 0; attempt < 5; attempt++) {
          const myReconcile = ++reconcileGenerationRef.current;
          let lock = true;
          let freshHasPin = false;
          let freshTimeout: AutoLockTimeout = null;
          let readOk = false;
          try {
            const { pinSeed, autoLockTimeout: rawTimeout } = await getPinConfigMeta();
            freshHasPin = !!pinSeed;
            freshTimeout = isValidAutoLockTimeout(rawTimeout) ? rawTimeout : null;
            readOk = true;
            lock = decideLockOnReturn(freshTimeout, freshHasPin, marker, now);
          } catch (err) {
            console.error('auto-lock config re-read failed — locking fail-closed:', err);
          }
          // A newer hidden/lock/commit owns the gate — this return is over
          // (rounds 3–4). Nothing to complete, nothing to publish.
          if (lockCheckGenerationRef.current !== myGen || vaultEpochRef.current !== myEpoch) return;
          // Superseded snapshot → decide again. An unreadable config (readOk
          // false) skips the retry and locks fail-closed below instead.
          if (readOk && reconcileGenerationRef.current !== myReconcile) continue;
          lockCheckPendingRef.current = false;
          if (readOk) {
            applyHasPin(freshHasPin);
            applyAutoLockTimeout(freshTimeout);
          }
          if (lock) lockApp();
          else setLockGate(false);
          return;
        }
        // A reconcile storm superseded every attempt — an UNVERIFIABLE config
        // is treated exactly like an unreadable one: fail-closed.
        if (lockCheckGenerationRef.current !== myGen || vaultEpochRef.current !== myEpoch) return;
        lockCheckPendingRef.current = false;
        lockApp();
      })();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHiddenEdge();
      else evaluateReturn();
    };
    // pagehide refines the marker (earliest wins) — it also fires on
    // navigation away, where visibilitychange:hidden may not.
    const onPageHide = () => onHiddenEdge();
    const onPageShow = (e: PageTransitionEvent) => {
      // BFCache restore resumes the app exactly where it was — same decision
      // as a visibility return. A non-persisted pageshow accompanies a normal
      // load, where bootstrap already decided.
      if (e.persisted) {
        // Fail-closed control check: whatever the heap was restored to, the
        // safebox section must be CLOSED after a BFCache return.
        lockSafeboxNow();
        evaluateReturn();
      }
    };
    // Chrome freezes background tabs without necessarily firing pagehide.
    const onFreeze = () => onHiddenEdge();

    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', onFreeze);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', onFreeze);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Safebox config recheck on focus / pageshow (§2) ───────────────
  // BroadcastChannel may be absent or lossy, so a returning tab re-reads the
  // authoritative config the moment it becomes interactive again — before the
  // user can touch anything — instead of waiting for the next secret action.
  useEffect(() => {
    const recheck = () => { void reconcileSafeboxConfig(); };
    const onPageShow = () => recheck();
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('focus', recheck);
      window.removeEventListener('pageshow', onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Deferred clipboard clear (retry on the next focus/visible edge) ──
  useEffect(() => {
    const retry = () => {
      if (clipboardClearPendingRef.current) tryClearClipboard();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', onVisible);
      if (clipboardClearTimerRef.current !== null) clearTimeout(clipboardClearTimerRef.current);
      // The safebox idle lock must not outlive the provider either.
      if (safeboxIdleTimerRef.current !== null) clearTimeout(safeboxIdleTimerRef.current);
    };
  }, []);

  // ─── Multi-tab vault channel (§8) ──────────────────────────────────
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return; // older Safari — per-tab only
    const channel = new BroadcastChannel('eternal-notes-vault');
    channelRef.current = channel;
    channel.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: unknown; originId?: unknown; messageId?: unknown } | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.originId === tabIdRef.current) return; // never act on our own echo
      if (typeof msg.messageId === 'string') {
        const seen = seenMessageIdsRef.current;
        if (seen.has(msg.messageId)) return; // duplicate delivery — already handled
        if (seen.size >= 256) seen.clear();  // bounded; handlers stay idempotent as backstop
        seen.add(msg.messageId);
      }
      if (msg.type === 'lock') {
        lockApp({ broadcast: false }); // re-broadcasting would ping-pong forever
      } else if (msg.type === 'config') {
        void reconcileLockScreen();
        // The `config` message covers BOTH PIN contours. The safebox half
        // re-reads its own record and locks this tab whenever the config
        // CHANGED OWNER (different configId) or disappeared — a plain
        // attempts/lockout mutation keeps the same configId and needs no lock.
        void reconcileSafeboxConfig();
      } else if (msg.type === 'reset') {
        // Another tab is DESTROYING the shared DB. Invalidate every write this
        // tab might still commit for the doomed vault (reset-exclusivity, P1),
        // drop the per-tab draft ciphertext (it belonged to that vault), and
        // lock. reconcileLockScreen (explicit — lockApp early-returns without
        // a vault) downgrades a now-seedless PIN screen to seed entry.
        noteExternalReset();
        draftStoreRef.current?.clear();
        lockApp({ broadcast: false });
        void reconcileLockScreen();
      }
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function postVaultMessage(type: 'lock' | 'config' | 'reset') {
    try {
      channelRef.current?.postMessage({ type, originId: tabIdRef.current, messageId: crypto.randomUUID() });
    } catch (err) {
      console.error('postVaultMessage failed:', err); // channel closed — per-tab behavior stays correct
    }
  }

  /** True when this tab holds ANYTHING that is — or may still become — an
   *  open vault: a committed key, a vault op in flight (openVault/restore
   *  preparing), or a session seed a hidden bootstrap could still publish.
   *  Shared by lockApp and the privacy-gate logic (review round 3). */
  function vaultPresentInTab(): boolean {
    return cryptoKeyRef.current !== null
      || vaultOpAbortRef.current !== null
      || sessionStorage.getItem(SESSION_STORAGE_KEY) !== null;
  }

  /** Re-read the authoritative PIN/auto-lock config from meta (shared
   *  IndexedDB) and fix a stale LOCK TARGET screen: a PIN wiped in another tab
   *  must not strand the user on a PIN screen with no pin-seed behind it
   *  (§8, review round 3). Only ever downgrades pin→restore — the restore
   *  screen always works, so a late reconcile can never yank a user off a
   *  screen they navigated to deliberately. Last-caller-wins (round 4): two
   *  racing reconciles apply in call order, never read order. Never throws:
   *  on a storage hiccup the stale screen stays, and PinUnlock still offers
   *  manual seed entry. */
  async function reconcileLockScreen(): Promise<void> {
    const myReconcile = ++reconcileGenerationRef.current;
    try {
      const { pinSeed, autoLockTimeout: rawTimeout } = await getPinConfigMeta();
      if (reconcileGenerationRef.current !== myReconcile) return; // a newer read/write owns the refs
      const pinData = pinSeed as PinEncryptedSeed | undefined;
      applyHasPin(!!pinData);
      applyAutoLockTimeout(isValidAutoLockTimeout(rawTimeout) ? rawTimeout : null);
      if (!pinData) setScreen(prev => (prev === 'pin' ? 'restore' : prev));
    } catch {
      // storage not ready / broken — the periodic paths will retry
    }
  }

  /**
   * Cross-tab safebox reaction. The broadcast is only the FAST path — the
   * guarantee is the per-publication storage recheck (§2) — but reacting
   * promptly keeps a stale unlocked section from lingering on screen.
   *
   * Locks when the config record vanished or its `configId` changed. An
   * unreadable/malformed record fails CLOSED (lock): we cannot vouch for the
   * session behind it.
   */
  async function reconcileSafeboxConfig(): Promise<void> {
    let configured = false;
    let currentId: string | null = null;
    try {
      const cfg = await readSafeboxPinConfig();
      configured = cfg !== null;
      currentId = cfg?.configId ?? null;
    } catch {
      configured = true;  // malformed record: present, but unusable
      currentId = null;   // → treat as a foreign config and lock
    }
    setSafeboxPinConfigured(configured);
    if (safeboxUnlockedRef.current && currentId !== safeboxConfigIdRef.current) {
      lockSafeboxNow();
    }
    // A wipe/deactivation in another tab also invalidates the one-shot
    // post-restore activation window.
    if (!configured) freshRestoreRef.current = null;
  }

  /** Everything a lock must invalidate, in one place (round 4): vault epoch,
   *  upload-queue generation, the lifecycle cycle that owns the privacy gate
   *  (pending return-verdict), the gate itself and the in-flight vault op.
   *  Shared by lockApp and resetApp — a reset that skipped any of these could
   *  leave an orphaned gate over the landing screen forever. */
  /**
   * SYNCHRONOUS section lock. Bumps the section epoch (every in-flight safebox
   * flow re-checks it before publishing), drops the meta key, the captured
   * configId and every decrypted meta, and cancels the idle timer.
   *
   * Deliberately does NOT touch notes state: locking the safebox is not
   * locking the app.
   */
  function lockSafeboxNow(): void {
    safeboxSectionEpochRef.current++;
    // SYNCHRONOUS scrub of any secret still sitting in a safebox input — the
    // activation PIN, the PIN pad, and above all the 12-word SEED-RESET grid.
    // Those forms live OUTSIDE the unlocked session, so nothing else would
    // clear them, and a BFCache snapshot taken inside `pagehide` captures the
    // DOM as-is. React state is dropped separately, by the remount keyed on
    // `safeboxLockGeneration` below.
    // `.safebox-secret-field` additionally covers the safebox inputs that live
    // OUTSIDE the section — the Settings PIN change/deactivation form and the
    // seed-gate PIN — which no remount of the section would ever reach.
    try {
      const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '.safebox-section input, .safebox-section textarea, .safebox-secret-field',
      );
      for (const field of fields) field.value = '';
    } catch { /* no DOM (SSR/test) — the remount below is the real guarantee */ }
    safeboxMetaKeyRef.current = null;
    safeboxConfigIdRef.current = null;
    safeboxEntriesRef.current = [];
    safeboxAddInFlightRef.current = false;
    safeboxEditInFlightRef.current.clear();
    // The post-restore activation window must not survive a lock (§2).
    freshRestoreRef.current = null;
    if (safeboxIdleTimerRef.current !== null) {
      clearTimeout(safeboxIdleTimerRef.current);
      safeboxIdleTimerRef.current = null;
    }
    safeboxUnlockedRef.current = false;
    setSafeboxUnlocked(false);
    setSafeboxEntries([]);
    setSafeboxSearchQuery('');
    // Published so the UI can REMOUNT the whole safebox subtree on every lock.
    // Clearing only on `unlocked: true → false` is not enough: the activation,
    // PIN-pad and seed-reset forms run while the section is LOCKED, so their
    // local state (including a fully typed seed phrase) would otherwise
    // survive a hidden/pagehide round-trip.
    setSafeboxLockGeneration(safeboxSectionEpochRef.current);
  }

  /** (Re)arm the fixed 5-minute idle lock. Called on unlock and on every
   *  safebox interaction. */
  function armSafeboxIdleTimer(): void {
    if (safeboxIdleTimerRef.current !== null) clearTimeout(safeboxIdleTimerRef.current);
    safeboxIdleTimerRef.current = setTimeout(() => {
      safeboxIdleTimerRef.current = null;
      lockSafeboxNow();
    }, SAFEBOX_IDLE_MS);
  }

  function invalidateVaultLifecycle(): void {
    vaultEpochRef.current++;
    queueGenerationRef.current++;
    // An app lock ALWAYS locks the safebox: the section epoch must move too, or
    // an in-flight reveal captured before the lock could still publish
    // plaintext behind the PIN screen.
    lockSafeboxNow();
    lockCheckGenerationRef.current++;
    lockCheckPendingRef.current = false;
    // An in-flight reconcile read predates this invalidation — its snapshot
    // must never resurrect the old config (e.g. hasPin=true on a clean
    // landing after reset, round 5).
    reconcileGenerationRef.current++;
    setLockGate(false);
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = null;
  }

  async function bootstrap() {
    try {
      // 1. Init storage (IndexedDB + migrate localStorage). A tab still holding
      //    the OLD schema blocks the v1→v2 upgrade: surface it instead of
      //    spinning on 'loading' forever (the upgrade resumes by itself once
      //    that tab closes).
      await initStorage({
        onBlocked: () => setStorageBlocked(true),
        // THIS tab is in the way of a newer build's upgrade: our connection
        // was just closed, so every later read here would throw. Drop the live
        // vault (keys, decrypted notes, any open safebox — they can do nothing
        // useful without a database, and this tab is now a dead end) and show
        // the non-destructive «reload» screen instead of failing obscurely.
        onBlocking: () => {
          lockApp({ broadcast: false }); // no ping-pong: the other tab is fine
          setStorageOutdated(true);
          setScreen('error');            // AFTER lockApp — it sets its own screen
        },
      });
      setStorageBlocked(false);

      // 2. Check init
      const isInit = await getMeta('init');
      if (!isInit) {
        setScreen('landing');
        return;
      }

      // 3. Check for PIN-encrypted seed + auto-lock config — ONE consistent
      //    snapshot: a concurrent wipe in another tab must not be seen
      //    half-applied (round 5 gap).
      const { pinSeed, autoLockTimeout: rawTimeout } = await getPinConfigMeta();
      const pinData = pinSeed as PinEncryptedSeed | undefined;
      if (pinData) applyHasPin(true);
      const timeout = isValidAutoLockTimeout(rawTimeout) ? rawTimeout : null;
      applyAutoLockTimeout(timeout);

      // 4. Check session (survives tab refresh but not browser close)
      const sessionMn = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!sessionMn) {
        // No active session — show PIN screen if PIN is set, otherwise restore
        setScreen(pinData ? 'pin' : 'restore');
        return;
      }

      // 5. §5: bootstrap lock decision — BEFORE any key derivation. The marker
      // is consumed atomically either way (one away-interval, one evaluation).
      const marker = consumeHiddenMarker(sessionStorage, Date.now());
      const doc = document as Document & { wasDiscarded?: boolean };
      if (decideBootstrapLock({
        hasPin: !!pinData,
        timeoutSeconds: timeout,
        wasDiscarded: doc.wasDiscarded === true,
        navigationType: currentNavigationType(),
        marker,
        nowMs: Date.now(),
      })) {
        // Locked at boot: the plaintext seed must not survive in this tab.
        // The encrypted draft envelope stays (§2).
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        dropLegacyPlaintextDraft(sessionStorage);
        setScreen('pin');
        // A page that WOKE UP HIDDEN raised the gate on mount (the session seed
        // made vaultPresentInTab() true). This branch just took that seed away,
        // so nothing can lower the gate afterwards: lockApp() returns on its
        // first line without a vault. Lower it here — a locked app holds no
        // plaintext, so no gate may cover it. Without this the user meets a
        // blank page with a lone padlock and only a full restart clears it.
        setLockGate(false);
        return;
      }

      // The pre-load marker (if any) was consumed by the decision above. A
      // page still HIDDEN re-arms it now: the post-load background time must
      // count against the timeout when the user finally returns.
      if (document.visibilityState === 'hidden') markHidden(sessionStorage, Date.now());

      // 6. Restore session
      try {
        const epoch = await openVault(sessionMn);
        if (epoch === null) return; // a lock won the race — nothing was published

        // 7. Check registration
        await checkAndSetRegistration(epoch);
        if (vaultEpochRef.current === epoch) setScreen('main');

        // 8. Auto-recover stale uploads (non-blocking, gated on enabled)
        if (arweaveRef.current.enabled) {
          void retryAllPending().catch(err => console.error('bootstrap retryAllPending:', err));
        }
      } catch (err) {
        if (err instanceof VaultMismatchError) {
          setVaultError(err.message);
        }
        setScreen('restore');
      }
    } catch (err) {
      // A NEWER client already migrated this database (R4+ ran in another tab
      // or before a rollback). The data is intact and fully readable by that
      // build — the ONLY correct action is «reload / update», never the
      // destructive storage reset the generic error screen offers in two
      // clicks (it would delete every unsynced record).
      if (isDbVersionError(err)) {
        console.error('bootstrap: database is newer than this build', err);
        setStorageOutdated(true);
        setScreen('error');
        return;
      }
      // Storage init/read failed (corrupted IndexedDB, quota, private-mode
      // restrictions). Without this catch the app would spin forever.
      console.error('bootstrap failed:', err);
      setBootError(err instanceof Error ? err.message : String(err));
      setScreen('error');
    } finally {
      readyRef.current = true;
      setReady(true);
    }
  }

  // ─── Vault open (prepare → commit → side-effects, §4) ──────────────

  /** Synchronous publication of a prepared snapshot. NO draft hydration here —
   *  that is Main's mount-time, dirty-guarded job. */
  function commitVaultSnapshot(snap: VaultSnapshot) {
    // A commit supersedes any pending return-verdict (review round 3): an old
    // check must never lock the vault being published right now.
    lockCheckGenerationRef.current++;
    lockCheckPendingRef.current = false;
    // Publishing into a HIDDEN tab pre-raises the opaque gate — the eventual
    // return must paint gated, exactly like a vault that was open at the
    // hidden edge. A visible commit is the user interactively unlocking:
    // clear any stale gate instead.
    setLockGate(document.visibilityState === 'hidden');

    cryptoKeyRef.current = snap.key;
    ownerHashRef.current = snap.ownerHash;
    signingKeyRef.current = snap.privateKey;
    publicKeyRef.current = snap.publicKey;
    mnemonicRef.current = snap.mnemonic;
    setMnemonic(snap.mnemonic);
    setNotes(snap.notes);
    // Mirror synchronously: a restore may start before React flushes the state
    // update above, and its visibility decisions must see THIS list.
    notesRef.current = snap.notes;
    setArweave(prev => ({ ...prev, registered: false, enabled: snap.savedEnabled }));
  }

  /**
   * Shared open path (bootstrap/confirm/restore/PIN-unlock): prepare → epoch
   * check → commit → persistent side-effects. Returns the epoch the vault was
   * published under, or null when a lock superseded the attempt (nothing was
   * published, the caller must go quiet). Throws VaultMismatchError from
   * preparation.
   */
  async function openVault(mn: string): Promise<number | null> {
    const myEpoch = vaultEpochRef.current;
    const abort = new AbortController();
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = abort;

    let snap: VaultSnapshot;
    try {
      snap = await prepareVaultSnapshot(mn, { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return null; // lock during prepare — stand down silently
      throw err;
    } finally {
      if (vaultOpAbortRef.current === abort) vaultOpAbortRef.current = null;
    }
    if (vaultEpochRef.current !== myEpoch) return null; // locked between prepare and commit

    commitVaultSnapshot(snap);
    sessionStorage.setItem(SESSION_STORAGE_KEY, mn);

    // Persistent (non-React) side-effects may complete even if a lock lands
    // now — they publish nothing sensitive to the UI (§4).
    await setMeta('vault-public-key', snap.pkB64);

    // Sync counts + per-note statuses come from local IndexedDB and are CHEAP —
    // populate them (and flip countsReady) before the UI is interactive, so the
    // destructive-reset dialog never renders against empty placeholder state
    // (round-21 P1).
    await refreshSyncCounts(myEpoch);

    // Surface a persisted v3-upload pause immediately: a transient toast died
    // with the lock/reload, but the fail-closed pause itself must never look
    // like silently-stuck sync. Malformed marker = paused (fail closed).
    try {
      const [pause3, pause4] = await Promise.all([readV3PauseMeta(), readV4PauseMeta()]);
      if (vaultEpochRef.current === myEpoch) {
        setV3Paused(pause3 !== null);
        setV4Paused(pause4 !== null);
      }
    } catch (err) {
      console.error('readV3PauseMeta at unlock failed:', err);
    }

    // Safebox presence (§3 hydration): the PIN-config record + the encrypted
    // entry COUNT. Both readable with the section locked — they drive the entry
    // point, the «Найден сейф: N» banner and reset-safety.
    await refreshSafeboxPresence(myEpoch);

    // Background: network-dependent parts only (online probe + queue kick).
    void initArweaveState(myEpoch).catch(err => console.error('initArweaveState:', err));

    return myEpoch;
  }

  /** Re-read the two locked-safe safebox facts (config presence + entry count)
   *  and publish them under the caller's epoch. */
  async function refreshSafeboxPresence(epoch: number): Promise<void> {
    try {
      const [configured, count] = await Promise.all([hasSafeboxPinConfig(), countSafeboxEntries()]);
      if (vaultEpochRef.current !== epoch) return;
      setSafeboxPinConfigured(configured);
      setSafeboxEntryCount(count);
    } catch (err) {
      console.error('safebox presence hydration failed:', err);
    }
  }

  // ─── Lock (§3) ─────────────────────────────────────────────────────

  /** Synchronous wipe of every live vault reference. Shared by lockApp and
   *  resetApp. NO byte zero-fill (round-5 med): an in-flight signer may share
   *  the buffer, and JS cannot guarantee zeroing anyway — the guarantee is the
   *  synchronous removal of refs + plaintext from UI/storage. */
  function clearVaultState() {
    cryptoKeyRef.current = null;
    ownerHashRef.current = null;
    signingKeyRef.current = null;
    publicKeyRef.current = null;
    mnemonicRef.current = null;
    // The safebox lives inside the vault's lifetime — never outlives it.
    lockSafeboxNow();
    setSafeboxPinConfigured(false);
    setSafeboxEntryCount(0);
    setRestoredSafeboxCount(null);
    setV4Paused(false);
    setMnemonic(null);
    setNotes([]);
    notesRef.current = [];
    setSyncStatuses({});
    setSearchQuery('');
    setArweave(INITIAL_ARWEAVE);
    setVaultError(null);
    // Transient restore banners must not leak into the next unlock.
    setRestoreError(null);
    setRestoredCount(null);
    setRestoredUpdatedCount(null);
    setRestoreProgress(null);
    // Same for the manual update check — and a sweep KILLED by this very lock
    // would otherwise leave 'checking' pinned forever (its own state writes are
    // gated on the epoch it no longer owns).
    setUpdateCheck({ status: 'idle' });
    // The persisted marker survives; the mirror re-reads on next unlock.
    setV3Paused(false);

    // Upload queue: drop queued work; the RUNNING processor (if any) exits on
    // its own via the generation check and must keep ownership of
    // isProcessingRef until it really finishes (§7).
    uploadQueueRef.current = [];
    queuedIdsRef.current.clear();
    addInFlightRef.current = false;
    editInFlightRef.current.clear();

    // Session seed + any LEGACY plaintext draft go now; the encrypted draft
    // envelope is exactly what at-rest protection is for — it stays (§2).
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    dropLegacyPlaintextDraft(sessionStorage);
  }

  /** Lock the vault NOW. Fully synchronous (§3): epoch bump → abort in-flight
   *  vault op → wipe state → PIN screen → (optionally) tell the other tabs. */
  const lockApp = useCallback((opts: { broadcast?: boolean } = {}) => {
    // Nothing to lock without vault STATE in this tab — a foreign 'lock'
    // broadcast may arrive while we sit on landing/restore. A vault op still
    // in flight (PIN unlock / restore preparing, not yet committed) COUNTS:
    // ignoring the lock would let the open complete right after it, publishing
    // a vault the user just ordered locked everywhere.
    if (!vaultPresentInTab()) {
      // Nothing to lock — but the gate may still be UP from a hidden edge
      // whose vault has since gone away. Every caller in evaluateReturn
      // delegates the gate to this function, so returning silently here
      // strands the user behind an opaque overlay that only a full restart
      // clears. Close the section first (defensive — an unlocked safebox
      // without a vault should be impossible), then uncover.
      if (safeboxUnlockedRef.current) lockSafeboxNow();
      setLockGate(false);
      return;
    }

    // Supersedes any pending return-verdict and owns the gate: the locked UI
    // is non-sensitive, so no gate may be left covering it.
    invalidateVaultLifecycle();
    clearVaultState();
    // Without a PIN there is nothing to unlock against — seed re-entry it is.
    setScreen(hasPinRef.current ? 'pin' : 'restore');
    if (opts.broadcast !== false) postVaultMessage('lock');
    // The target screen above used possibly-stale hasPin — reconcile it
    // against the authoritative pin-seed (review round 3): a PIN wiped in
    // another tab must not dead-end the user on a seedless PIN screen.
    void reconcileLockScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Arweave State ──────────────────────────────────────────────────

  async function initArweaveState(epoch: number) {
    // Counts were already loaded synchronously during vault open; refresh them
    // again after the (slow) probe so a queue kick sees fresh numbers.
    const online = await isArweaveOnline();
    await refreshSyncCounts(epoch);
    if (vaultEpochRef.current !== epoch) return; // locked meanwhile
    setArweave(prev => ({ ...prev, online }));

    // If online + enabled + items queued → trigger queue
    if (online && arweaveRef.current.enabled && uploadQueueRef.current.length > 0) {
      kickQueue();
    }
  }

  /** Epoch-aware (§4): reads storage first, then publishes to React state only
   *  if the vault the caller saw is still the vault on screen.
   *
   *  Aggregates are computed PER KIND: the notes formula is
   *  `allNotes − accepted − confirmed` over the SAME record set, so counting a
   *  safebox record in the numerator drives «Синхронизировано X из N»
   *  negative. `syncStatuses` stays ONE map (the ids share a namespace, and
   *  `badgeFor` is keyed by NoteSyncInfo — safebox cards get badges for free).
   *
   *  The safebox contribution to reset-safety is computed from the ENCRYPTED
   *  rows, so it is correct while the section is LOCKED — the normal case when
   *  a user hits «Сбросить приложение». */
  async function refreshSyncCounts(epoch: number) {
    const allNotes = await getAllNotes();
    const allSafebox = await getAllSafeboxEntries();
    const allSync = await getAllSyncRecords();
    if (vaultEpochRef.current !== epoch) return; // stale — never touch the UI

    // terminalError (permanent quarantine) is counted SEPARATELY from errors:
    // «Ошибки: N» implies «Повторить» can fix it, but the retry paths skip
    // quarantined records by design — showing them as retryable errors would
    // be a lie the user can never resolve. They still count in the reset risk.
    const byId = new Map(allSync.map(r => [r.noteId, r]));

    // Tally over the ACTUAL STORED RECORDS, looking their sync state up by id —
    // never over `allSync` itself. Two things follow, both load-bearing:
    //  - a sync row is attributed by which STORE its id lives in, so a `kind`
    //    field corrupted to 'note' cannot subtract a safebox row from the notes
    //    total and drive «Синхронизировано X из N» negative;
    //  - an ORPHAN sync row (an id in neither store — a leftover from a partial
    //    reset or a foreign writer) is IGNORED. Counting one would be actively
    //    dangerous: an orphan `confirmed` row cancels out a real unsynced note
    //    in `resetRisk` and makes the reset dialog claim everything is safely
    //    on chain right before wiping it.
    const zero = () => ({ accepted: 0, confirmed: 0, errors: 0, quarantined: 0 });
    const tallyFor = (ids: string[]) => {
      const t = zero();
      for (const id of ids) {
        const r = byId.get(id);
        if (!r) continue; // no record yet = queued; counted by the formulas below
        // `confirmed` is terminal SUCCESS and outranks everything. Quarantine
        // outranks `accepted`: a record that can never be re-dispatched must
        // not sit in «ожидают подтверждения» forever pretending progress.
        if (r.status === 'confirmed') t.confirmed++;
        else if (r.terminalError !== undefined) t.quarantined++;
        else if (r.status === 'accepted') t.accepted++;
        else if (r.status === 'error') t.errors++;
      }
      return t;
    };
    const tally = {
      note: tallyFor(allNotes.map(n => n.noteId)),
      safebox: tallyFor(allSafebox.map(e => e.entryId)),
    };

    // Join records ↔ sync state for the per-card indicator (+ txId for menus).
    const statuses: Record<string, NoteSyncInfo> = {};
    for (const id of [...allNotes.map(n => n.noteId), ...allSafebox.map(e => e.entryId)]) {
      const rec = byId.get(id);
      statuses[id] = rec ? { status: rec.status, txId: rec.txId } : { status: 'queued' };
    }
    setSyncStatuses(statuses);

    setArweave(prev => ({
      ...prev,
      acceptedCount: tally.note.accepted,
      confirmedCount: tally.note.confirmed,
      unsyncedCount: allNotes.length - tally.note.accepted - tally.note.confirmed,
      countsReady: true,
      errorCount: tally.note.errors,
      quarantinedCount: tally.note.quarantined,
      // Storage-backed: EVERY stored record that is not confirmed is at risk on
      // a reset — including versions invisible in the UI (historical,
      // quarantined, undecryptable, or locked away in the safebox).
      resetRisk: {
        notes: allNotes.length - tally.note.confirmed,
        safebox: allSafebox.length - tally.safebox.confirmed,
      },
      safebox: {
        acceptedCount: tally.safebox.accepted,
        confirmedCount: tally.safebox.confirmed,
        unsyncedCount: allSafebox.length - tally.safebox.accepted - tally.safebox.confirmed,
        errorCount: tally.safebox.errors,
        quarantinedCount: tally.safebox.quarantined,
      },
    }));
  }

  // ─── Registration ───────────────────────────────────────────────────

  /** @param force skip the local marker and always ask the server — used by the
   *  manual «Проверить доступ», which must be able to DISCOVER a revocation. */
  async function checkAndSetRegistration(epoch: number, force = false) {
    // Captured ONCE — post-lock the refs are null, but the network round-trip
    // below may already be in flight with these locals. Every React mutation
    // is epoch-gated instead.
    const publicKey = publicKeyRef.current;
    const signingKey = signingKeyRef.current;
    if (!publicKey || !signingKey) return;

    const publicKeyB64 = bufferToBase64(publicKey);
    const localRegistered = force ? false : await getMeta<boolean>(`registered:${publicKeyB64}`);

    if (localRegistered) {
      if (vaultEpochRef.current === epoch) setArweave(prev => ({ ...prev, registered: true }));
    } else {
      const checkPayload = JSON.stringify({ publicKey: publicKeyB64, timestamp: Date.now() });
      const checkSig = await signPayload(signingKey, checkPayload);
      const { status, message } = await checkRegistration(publicKeyB64, checkSig, checkPayload);

      if (status === 'allowed') {
        await setMeta(`registered:${publicKeyB64}`, true);
        if (vaultEpochRef.current === epoch) setArweave(prev => ({ ...prev, registered: true }));
      } else if (status === 'invalid_request') {
        console.error('checkRegistration returned invalid_request:', message);
        // L13: a clock-skew 401 is user-actionable — surface the hint instead
        // of failing silently on a freshly-restored device.
        if (message && /timestamp|clock|skew/i.test(message) && vaultEpochRef.current === epoch) {
          setArweave(prev => ({ ...prev, lastError: userFacingUploadError('error', message) }));
        }
      } else if (status === 'denied') {
        // Access was revoked (or never granted): drop the local marker so the
        // invite form comes back instead of a permanently "registered" client
        // that only ever gets 403s.
        await deleteMeta(`registered:${publicKeyB64}`);
        if (vaultEpochRef.current === epoch) setArweave(prev => ({ ...prev, registered: false }));
      }
      // 'unavailable' → don't change registered, user can retry
    }
  }

  /** Server said 403 for this key — the local `registered` marker is stale
   *  (revoked server-side). Clear it so the UI offers a new invite. */
  async function markUnregistered() {
    const publicKey = publicKeyRef.current;
    if (publicKey) await deleteMeta(`registered:${bufferToBase64(publicKey)}`);
    setArweave(prev => ({ ...prev, registered: false }));
  }

  // ─── Upload Queue (§7) ─────────────────────────────────────────────

  function kickQueue() {
    void processQueue().catch(err => console.error('processQueue error:', err));
  }

  function enqueueUpload(item: UploadItem) {
    const id = uploadItemId(item);
    if (queuedIdsRef.current.has(id)) return;
    queuedIdsRef.current.add(id);
    uploadQueueRef.current.push(item);
    kickQueue();
  }

  async function processQueue() {
    if (isProcessingRef.current) return;
    if (!arweaveRef.current.enabled || !arweaveRef.current.online) return;

    const myGen = queueGenerationRef.current;
    isProcessingRef.current = true;
    setArweave(prev => ({ ...prev, syncing: true }));

    try {
      while (uploadQueueRef.current.length > 0) {
        // A lock bumped the generation: stop taking iterations. The in-flight
        // upload (if any) already landed via runUploadAttempt's commit rules.
        if (queueGenerationRef.current !== myGen) break;
        if (!arweaveRef.current.enabled || !arweaveRef.current.online) break;

        const item = uploadQueueRef.current[0];
        const itemId = uploadItemId(item);

        // A pause marker is authoritative SHARED state: re-read it right before
        // every gated dispatch (another tab may have set it; our per-tab refs
        // know nothing). At most one initial 503 per already-open tab — after
        // that the marker short-circuits here without HTTP. The two versions
        // have INDEPENDENT markers: a v4 pause must not stall notes.
        const gatedVersion = item.kind === 'safebox' ? 4 : (item.record.v === 3 ? 3 : null);
        if (gatedVersion !== null) {
          let paused = false;
          try {
            const marker = gatedVersion === 3 ? await readV3PauseMeta() : await readV4PauseMeta();
            paused = marker !== null;
          } catch (err) {
            console.error(`pause marker read failed — treating v${gatedVersion} as paused:`, err);
            paused = true; // fail closed
          }
          if (queueGenerationRef.current !== myGen) break;
          if (paused) {
            // Drop from BOTH queue structures — a skipped id left in
            // queuedIdsRef would block its re-enqueue forever after resume.
            uploadQueueRef.current.shift();
            queuedIdsRef.current.delete(itemId);
            if (gatedVersion === 3) setV3Paused(true);
            else setV4Paused(true);
            continue; // other versions behind it keep uploading
          }
        }

        const result = await uploadSingleItem(item);

        // Superseded mid-upload: the queue we see now belongs to the NEXT
        // generation (unlock refilled it) — it is not ours to shift.
        if (queueGenerationRef.current !== myGen) break;

        if (result === 'cancelled') break; // lock before the point of no return
        if (result === 'rate_limited') {
          setArweave(prev => ({ ...prev, lastError: userFacingUploadError('rate_limited') }));
          break;
        }
        if (result === 'not_registered') {
          // 403 = the server no longer allows this key (revoked / never
          // registered). Invalidate the local marker so the invite form
          // reappears; otherwise every future upload silently 403s.
          await markUnregistered();
          setArweave(prev => ({ ...prev, lastError: userFacingUploadError('not_registered') }));
          break;
        }

        // success or recoverable error → remove from queue
        uploadQueueRef.current.shift();
        queuedIdsRef.current.delete(itemId);

        // Throttle: 200ms between uploads
        if (uploadQueueRef.current.length > 0) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } finally {
      // Released only on REAL completion — the generation check never
      // force-clears a running processor's flag (§7).
      isProcessingRef.current = false;
      setArweave(prev => ({ ...prev, syncing: false }));
      // Superseded processor hands off: work enqueued for the new generation
      // (unlock → retryAllPending) would otherwise wait for an external kick
      // that already came and saw isProcessing=true.
      if (queueGenerationRef.current !== myGen && uploadQueueRef.current.length > 0) {
        kickQueue();
      }
    }
  }

  /** One upload attempt. Returns the UploadResult kind, or 'cancelled' when a
   *  lock preempted the attempt before its point of no return. The state
   *  machine itself lives in upload-flow.ts; here we only capture the refs
   *  ONCE and gate the React/meta side-effects on the epoch (§7 step 5). */
  async function uploadSingleItem(item: UploadItem): Promise<string> {
    const id = uploadItemId(item);
    const sk = signingKeyRef.current;
    const oh = ownerHashRef.current;
    const pk = publicKeyRef.current;
    const myEpoch = vaultEpochRef.current;
    // Reset-exclusivity token (P1): a LOCK must still persist the committed
    // result (epoch changes, generation doesn't), but a RESET must not let a
    // post-point-of-no-return persist resurrect data in the wiped DB. The
    // checks are synchronous right before each write — see storage.ts.
    const myDbGen = getDbGeneration();
    if (!sk || !oh || !pk) return 'error';

    let outcome;
    try {
      outcome = await runUploadAttempt(
        item,
        { signingKey: sk, ownerHash: oh, publicKey: pk },
        myEpoch,
        {
          now: () => Date.now(),
          currentEpoch: () => vaultEpochRef.current,
          getSyncRecord,
          setSyncRecord: async record => {
            if (getDbGeneration() !== myDbGen) return; // reset won — refuse
            await setSyncRecord(record);
          },
          commitV3PausedFailure: async (record, pausedAt) => {
            if (getDbGeneration() !== myDbGen) return; // reset won — refuse
            await commitV3PausedFailure(record, pausedAt);
          },
          commitV4PausedFailure: async (record, pausedAt) => {
            if (getDbGeneration() !== myDbGen) return; // reset won — refuse
            await commitV4PausedFailure(record, pausedAt);
          },
          signPayload,
          uploadViaProxy,
        },
      );
    } catch (err) {
      const terminal =
        err instanceof UnsupportedNoteVersionError || err instanceof UnsupportedSafeboxVersionError
          ? 'unsupported_version'
          : err instanceof MalformedRecordError
            ? 'malformed_record'
            : null;
      if (terminal !== null) {
        // Either the stored record carries a version this build cannot
        // serialize (written by a newer client), or it failed runtime shape
        // validation. PERMANENT local quarantine: terminalError keeps it out of
        // every future queue pass (a plain 'error' would retry forever), no
        // HTTP was made, and the reset risk still counts it.
        const prev = await getSyncRecord(id);
        const quarantined: SyncRecord = {
          noteId: id,
          kind: item.kind,
          txId: prev?.txId,
          status: 'error',
          transport: 'proxy',
          lastError: terminal,
          updatedAt: Date.now(),
          recovery: prev?.recovery,
          terminalError: terminal,
        };
        if (getDbGeneration() !== myDbGen) return 'quarantined'; // reset won
        await setSyncRecord(quarantined);
        if (vaultEpochRef.current === myEpoch) await refreshSyncCounts(myEpoch);
        return 'quarantined'; // processQueue treats it as recoverable: shift + continue
      }
      throw err;
    }
    if (outcome.kind === 'cancelled') return 'cancelled';
    const result = outcome.result;

    // React state + registration meta — ONLY under the current epoch. The
    // sync record itself was already persisted unconditionally above.
    if (vaultEpochRef.current === myEpoch) {
      if (result.kind === 'accepted') {
        // Auto-discovery. The meta reads/writes above may straddle a lock —
        // re-check the epoch before EVERY publication (invariant #2: sensitive
        // state publishes only under the current epoch; a stale continuation
        // must not write registered/lastSync into the locked INITIAL state).
        const pkB64 = bufferToBase64(pk);
        if (!(await getMeta<boolean>(`registered:${pkB64}`))) {
          await setMeta(`registered:${pkB64}`, true);
          if (vaultEpochRef.current === myEpoch) {
            setArweave(prev => ({ ...prev, registered: true }));
          }
        }
        if (vaultEpochRef.current === myEpoch) {
          setArweave(prev => ({ ...prev, lastSync: Date.now() }));
        }
      } else if (result.kind === 'v3_disabled' || result.kind === 'v4_disabled') {
        // The worker's kill switch answered: the pause marker is already
        // persisted (atomically with the failure record, in upload-flow).
        // The STANDING pause banner is the only UI surface — deliberately NOT
        // lastError: that toast's «Повторить» (retrySync) cannot lift the
        // pause, so it would sit next to the banner's working «Возобновить» as
        // a contradicting dead control. NEVER markUnregistered.
        if (result.kind === 'v3_disabled') setV3Paused(true);
        else setV4Paused(true);
      } else {
        // L13: a clock-skew rejection looks like a permanent mystery to the
        // user — surface the actionable «проверьте время» toast.
        const errText = 'error' in result ? result.error : undefined;
        if (errText && /timestamp|clock|skew/i.test(errText)) {
          setArweave(prev => ({ ...prev, lastError: userFacingUploadError(result.kind, errText) }));
        }
      }
      await refreshSyncCounts(myEpoch);
    }

    return result.kind;
  }

  async function syncPendingRecords() {
    const allNotes = await getAllNotes();
    // Safebox entries MUST be enumerated here too: without this, a pending
    // entry never returns to the queue after a reload/unlock/poll cycle.
    const allSafebox = await getAllSafeboxEntries();
    const allSync = await getAllSyncRecords();
    const now = Date.now();

    // Pause markers: don't even enqueue a gated record while its shared marker
    // stands — the per-dispatch check in processQueue is the backstop, this
    // avoids the churn. An unreadable marker counts as paused (fail closed).
    let v3PausedNow = false;
    try {
      v3PausedNow = (await readV3PauseMeta()) !== null;
    } catch {
      v3PausedNow = true;
    }
    let v4PausedNow = false;
    try {
      v4PausedNow = (await readV4PauseMeta()) !== null;
    } catch {
      v4PausedNow = true;
    }

    // Skip: accepted-and-not-flagged + confirmed + fresh uploading (< 10 min) +
    //       recheck notes still within their backoff window + PERMANENT
    //       quarantine (terminalError — retrying can never succeed and risks
    //       committing garbage; reload/poll/manual retry must not resurrect it).
    // Enqueue: error, accepted+needsRecheck past backoff, stale uploading, no record
    const skipIds = new Set(
      allSync.filter(r =>
        r.terminalError !== undefined ||
        (r.status === 'accepted' && !r.needsRecheck) ||
        (r.status === 'accepted' && r.needsRecheck && (now - r.updatedAt) < RECHECK_BACKOFF_MS) ||
        r.status === 'confirmed' ||
        (r.status === 'uploading' && (now - r.updatedAt) < STALE_UPLOADING_MS)
      ).map(r => r.noteId)
    );
    for (const note of allNotes) {
      if (skipIds.has(note.noteId)) continue;
      if (v3PausedNow && note.v === 3) continue;
      enqueueUpload({ kind: 'note', record: note });
    }
    if (!v4PausedNow) {
      for (const entry of allSafebox) {
        if (skipIds.has(entry.entryId)) continue;
        enqueueUpload({ kind: 'safebox', record: entry });
      }
    }
  }

  async function retryAllPending() {
    setArweave(prev => ({ ...prev, lastError: null }));
    await syncPendingRecords();
    kickQueue();
  }

  // ─── TX Status Polling ──────────────────────────────────────────────

  async function pollTxStatuses() {
    if (document.visibilityState !== 'visible') return;
    if (!cryptoKeyRef.current) return; // locked — nothing to poll for
    if (!arweaveRef.current.enabled || !arweaveRef.current.online) return;
    const myEpoch = vaultEpochRef.current;
    const myDbGen = getDbGeneration(); // reset-exclusivity token (P1)

    // Resume channel (а): while the v3 pause stands, each poll cycle probes the
    // strictly-validated /health. The marker is lifted ONLY via compare-and-
    // delete on the pausedAt we read BEFORE the probe — a stale success can
    // never erase a newer pause. A malformed marker is not auto-lifted at all
    // (manual retry only). 'disabled'/'unknown' verdicts leave everything as is.
    try {
      const [pause3, pause4] = await Promise.all([readV3PauseMeta(), readV4PauseMeta()]);
      if (vaultEpochRef.current !== myEpoch) return; // locked during the read
      // Mirror both markers first (another tab may have set one since our last
      // read); a marker that is GONE must clear the local banner too, or it
      // would claim a pause forever while uploads actually work.
      setV3Paused(pause3 !== null);
      setV4Paused(pause4 !== null);

      // ONE /health probe answers for both. Each version is lifted ONLY on the
      // full condition (ok && versions∋N && vNUploads===true) via
      // compare-and-delete on the pausedAt read BEFORE the probe — a stale
      // success can never erase a newer pause. A malformed marker is never
      // auto-lifted (manual retry only).
      const liftable = (pause3 !== null && pause3 !== 'malformed')
        || (pause4 !== null && pause4 !== 'malformed');
      if (liftable) {
        const capability = await getWorkerCapabilities();
        let resumed = false;
        if (pause3 !== null && pause3 !== 'malformed' && capability.v3 === 'enabled'
            && await clearV3UploadsPaused(pause3.pausedAt)) {
          if (vaultEpochRef.current !== myEpoch) return;
          setV3Paused(false);
          resumed = true;
        }
        if (pause4 !== null && pause4 !== 'malformed' && capability.v4 === 'enabled'
            && await clearV4UploadsPaused(pause4.pausedAt)) {
          if (vaultEpochRef.current !== myEpoch) return;
          setV4Paused(false);
          resumed = true;
        }
        if (resumed) {
          await syncPendingRecords(); // re-enqueue the backlog
          kickQueue();
        }
      }
    } catch (err) {
      console.error('upload pause resume probe failed:', err);
    }
    if (vaultEpochRef.current !== myEpoch) return;

    const accepted = await getRecordsByStatus('accepted');

    const now = Date.now();
    let changed = false;

    for (const record of accepted) {
      if (vaultEpochRef.current !== myEpoch) return; // locked mid-poll — stop
      if (!record.txId) continue;

      const status = await getTxStatus(record.txId);

      // Pure transition (sync-transitions.ts): confirm only after server
      // reconciliation; dropped/invalid/timed-out pending → needsRecheck;
      // unavailable → unchanged (gateway degradation).
      const next = afterPoll(record, status, now, TX_CONFIRM_THRESHOLD, TX_TIMEOUT_MS);
      if (next) {
        if (getDbGeneration() !== myDbGen) return; // reset won — refuse the write
        await setSyncRecord(next);
        changed = true;
      }
    }

    if (changed) await refreshSyncCounts(myEpoch);
    // Drain any ready work each cycle (recheck notes past their backoff).
    if (vaultEpochRef.current !== myEpoch) return;
    if (arweaveRef.current.enabled && arweaveRef.current.online) {
      await syncPendingRecords();
      kickQueue();
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────

  const createNewWallet = useCallback(async (): Promise<string> => {
    const mn = generateMnemonic();
    setMnemonic(mn);
    return mn;
  }, []);

  const confirmMnemonic = useCallback(async (mn: string) => {
    const epoch = await openVault(mn);
    if (epoch === null) return;
    await setMeta('init', true);
    await checkAndSetRegistration(epoch);
    if (vaultEpochRef.current === epoch) setScreen('main');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restoreFromMnemonic = useCallback(async (mn: string) => {
    if (!isValidMnemonic(mn)) throw new Error('Invalid mnemonic');

    const epoch = await openVault(mn);
    if (epoch === null) return;
    await setMeta('init', true);

    await checkAndSetRegistration(epoch);
    if (vaultEpochRef.current !== epoch) return;
    setScreen('main');

    // Auto-restore from Arweave
    restoringRef.current = true;
    setRestoring(true);
    try {
      await restoreFromArweaveInternal();
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }

    // ONE-SHOT post-restore window (§2): the user proved possession of the seed
    // seconds ago, so re-typing all 12 words to set a safebox PIN would be
    // theatre. Bound to THIS vault epoch and consumed on first use; a lock,
    // pagehide, reset or failed activation drops it.
    if (vaultEpochRef.current === epoch) freshRestoreRef.current = epoch;

    // Auto-recover stale uploads (gated on enabled; post-lock enabled=false)
    if (arweaveRef.current.enabled) {
      void retryAllPending().catch(err => console.error('retryAllPending after restore:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ONE sweep, two reports. Both modes run the SAME fetch → decrypt → merge
   * pipeline — there is deliberately no second restore path — and differ only
   * in where the outcome lands:
   *   'restore' — the seed-driven scenario; owns the restore banners.
   *   'check'   — manual «Проверить обновления»; owns `updateCheck` and must
   *               never touch a restore banner (a different screen shows it).
   * Both are serialized by the SAME `restoringRef`: two concurrent sweeps would
   * double-fetch and race each other's merges.
   */
  async function runArweaveSweep(mode: 'restore' | 'check') {
    const key = cryptoKeyRef.current;
    const mn = mnemonicRef.current;
    if (!key || !ownerHashRef.current || !mn) return;
    const myEpoch = vaultEpochRef.current;
    const mySection = safeboxSectionEpochRef.current;
    const myDbGen = getDbGeneration(); // reset-exclusivity token (P1)

    // The sweep is abortable: lockApp() cancels every in-flight page/payload
    // fetch instead of letting them settle against a locked vault.
    const abort = new AbortController();
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = abort;

    if (mode === 'restore') {
      setRestoreError(null);
      setRestoredCount(null);
      setRestoredUpdatedCount(null);
      setRestoredSafeboxCount(null);
      setRestoreProgress(null);
    } else {
      setUpdateCheck({ status: 'checking', progress: null });
    }
    try {
      // The safebox keys are derived HERE, on demand, straight from the
      // mnemonic: restore must work with the section locked and NO PIN (the
      // PIN is an access gate, not a crypto boundary). The secret key only
      // proves a v4 candidate decrypts in both halves — its plaintext never
      // leaves fetchAllNotes.
      const [safeboxMeta, safeboxSecret] = await Promise.all([
        deriveSafeboxMetaKey(mn),
        deriveSafeboxSecretKey(mn),
      ]);
      if (vaultEpochRef.current !== myEpoch) return;

      // fetchAllNotes decrypts + validates (v1–v4) and drops any TX not signed
      // by a trusted owner or that fails to decrypt.
      const { notes: remoteNotes, safeboxEntries: remoteSafebox, incomplete } = await fetchAllNotes(
        ownerHashRef.current,
        { note: key, safeboxMeta, safeboxSecret },
        (done, total) => {
          if (vaultEpochRef.current !== myEpoch) return;
          if (mode === 'restore') setRestoreProgress({ done, total });
          else setUpdateCheck({ status: 'checking', progress: { done, total } });
        },
        { signal: abort.signal },
      );
      if (vaultEpochRef.current !== myEpoch) return; // locked mid-sweep — publish nothing

      // Snapshot of what the user can currently SEE (decrypted notes; the DB
      // may hold corrupted-invisible ones). A LOCAL set — extended as we add —
      // keeps the counters exact even though notesRef only catches up after a
      // render, and the summary never counts an already-visible version.
      const visibleIds = new Set(notesRef.current.map(n => n.id));
      // Counter algorithm (snapshot-based): roots existing in the UI BEFORE the
      // sweep. A chain whose root is new counts once in M («восстановлено»)
      // however many versions arrive; an existing chain gaining >=1 new version
      // counts once in K («обновлено»). EVERY new version is published to state
      // either way — history is complete without a re-unlock.
      const initialRoots = new Set(groupChains(notesRef.current).map(c => c.root));
      const newRoots = new Set<string>();
      const updatedRoots = new Set<string>();
      for (const remote of remoteNotes) {
        if (vaultEpochRef.current !== myEpoch) return; // locked — stop merging
        // A reset destroyed the vault this sweep belongs to: writing the merge
        // would resurrect a note in the freshly-wiped DB (P1). The epoch check
        // above catches it too (reset bumps both), but the generation check is
        // the one whose synchronous placement right before the write closes
        // the interleaving with resetAll's clear transaction.
        if (getDbGeneration() !== myDbGen) return;
        // Upsert the note payload + confirmed sync state atomically. The
        // payload write matters even for an already-confirmed note: the local
        // ciphertext may be corrupted while the on-chain copy just decrypted.
        await mergeRestoredNote(remote.encrypted, remote.txId, Date.now(), myDbGen);

        if (!claimRestoredForUi(visibleIds, remote.encrypted.noteId)) continue;
        if (vaultEpochRef.current !== myEpoch) return;
        const restoredNote: NoteData = {
          id: remote.encrypted.noteId,
          text: remote.text,
          createdAt: remote.encrypted.createdAt,
          ...remote.meta,
        };
        publishNotes(prev =>
          prev.some(n => n.id === restoredNote.id)
            ? prev
            : [...prev, restoredNote].sort((a, b) => b.createdAt - a.createdAt)
        );
        if (initialRoots.has(remote.meta.root)) updatedRoots.add(remote.meta.root);
        else newRoots.add(remote.meta.root);
      }

      // ── Safebox half. Counted SEPARATELY from the notes counters («Найден
      //    сейф: N записей» vs «Восстановлено M, обновлено K»). Merging is
      //    upsert-repair, exactly like notes, and needs no PIN.
      //
      // TWO different counts, deliberately:
      //  - `safeboxMerged` — every remote version seen, what restore reports
      //    («Найден сейф: N записей»);
      //  - `changedSafeboxRoots` — roots that received at least one version we
      //    did NOT already hold, what the update check reports. Without the
      //    known-id snapshot the check would re-announce the entire safebox
      //    history on EVERY run, since the merge is an idempotent upsert.
      // The snapshot is taken from STORAGE, not from state: the section may be
      // locked, and then no decrypted entry is in memory at all.
      const knownSafeboxIds = new Set(
        remoteSafebox.length > 0 ? (await getAllSafeboxEntries()).map(e => e.entryId) : [],
      );
      const changedSafeboxRoots = new Set<string>();
      let safeboxMerged = 0;
      for (const remote of remoteSafebox) {
        if (vaultEpochRef.current !== myEpoch) return;
        if (getDbGeneration() !== myDbGen) return;
        await mergeRestoredSafeboxEntry(remote.encrypted, remote.txId, Date.now(), myDbGen);
        safeboxMerged++;
        // Claim BEFORE the id joins the known set, so several new versions of
        // one root still count their root exactly once.
        if (!knownSafeboxIds.has(remote.encrypted.entryId)) {
          changedSafeboxRoots.add(remote.meta.root);
          knownSafeboxIds.add(remote.encrypted.entryId);
        }
        // If the section happens to be unlocked RIGHT NOW, publish the freshly
        // decrypted meta so the list is complete without a re-unlock. Both
        // epochs are re-checked: a lock mid-sweep must publish nothing.
        if (safeboxUnlockedRef.current
            && vaultEpochRef.current === myEpoch
            && safeboxSectionEpochRef.current === mySection) {
          const meta = remote.meta;
          publishSafeboxEntries(prev =>
            prev.some(e => e.id === meta.id) ? prev : [...prev, meta]);
        }
      }

      if (remoteNotes.length > 0 || safeboxMerged > 0) {
        await refreshSyncCounts(myEpoch);
        await refreshSafeboxPresence(myEpoch);
      }
      if (vaultEpochRef.current !== myEpoch) return;
      if (mode === 'restore') {
        setRestoredCount(newRoots.size);
        setRestoredUpdatedCount(updatedRoots.size);
        setRestoredSafeboxCount(safeboxMerged);
        if (incomplete) {
          // Some pages/payloads were unreachable — a "quiet partial restore" must
          // not look like a full one (the user could believe notes are lost).
          setRestoreError('Восстановление прошло не полностью — часть заметок могла не загрузиться.');
        }
      } else {
        // `partial` is NOT an error: the sweep ran and merged what it reached.
        // A total failure never gets here — fetchAllNotes throws instead.
        setUpdateCheck({
          status: 'done',
          at: Date.now(),
          addedNotes: newRoots.size,
          updatedNotes: updatedRoots.size,
          changedSafebox: changedSafeboxRoots.size,
          partial: incomplete,
        });
      }
    } catch (err) {
      // A wipe is not a failed sweep: the merge refused to write because the
      // database this run belonged to no longer exists. Stand down silently,
      // exactly like an aborted sweep — reporting an error here would blame the
      // network for the user's own «Удалить всё».
      if (err instanceof StorageResetError) return;
      // A lock does NOT land here either: fetchAllNotes stays silent when the
      // caller's signal aborted, and every state write below is epoch-gated.
      console.error(mode === 'restore' ? 'restoreFromArweave failed:' : 'checkForUpdates failed:', err);
      if (vaultEpochRef.current !== myEpoch) return;
      if (mode === 'restore') setRestoreError('Не удалось восстановить заметки из Arweave.');
      else setUpdateCheck({ status: 'error', at: Date.now() });
    } finally {
      if (vaultOpAbortRef.current === abort) vaultOpAbortRef.current = null;
      if (mode === 'restore' && vaultEpochRef.current === myEpoch) setRestoreProgress(null);
    }
  }

  /** Restore-mode sweep — the seed-entry and «Повторить» paths. */
  function restoreFromArweaveInternal() {
    return runArweaveSweep('restore');
  }

  /** Re-run the Arweave restore sweep (banner button after an error/partial). */
  const retryRestore = useCallback(async () => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    try {
      await restoreFromArweaveInternal();
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Manual «Проверить обновления» — pull whatever other devices published.
   *
   * Requires an OPEN vault and nothing else: the sweep only READS Arweave
   * (arweave.net/graphql directly), so neither the sync toggle nor a registered
   * key is involved — those gate uploads. Shares `restoringRef` with restore,
   * but never sets `setRestoring`: that flag owns the restore banner.
   */
  const checkForUpdates = useCallback(async () => {
    if (!cryptoKeyRef.current || !ownerHashRef.current || !mnemonicRef.current) return;
    if (restoringRef.current) return; // a sweep is already running
    restoringRef.current = true;
    try {
      await runArweaveSweep('check');
    } finally {
      restoringRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearRestoreStatus = useCallback(() => {
    setRestoreError(null);
    setRestoredCount(null);
    setRestoredUpdatedCount(null);
    setRestoredSafeboxCount(null);
  }, []);

  const dismissError = useCallback(() => {
    setArweave(prev => ({ ...prev, lastError: null }));
  }, []);

  const addNote = useCallback(async (text: string) => {
    // Key + epoch captured ONCE, before the first await (§4): a lock during
    // encrypt()/saveNote() nulls the refs and bumps the epoch — the encrypted
    // persist below may still complete, but the PLAINTEXT must never be
    // re-published to React state behind the PIN screen.
    const key = cryptoKeyRef.current;
    const myEpoch = vaultEpochRef.current;
    const myDbGen = getDbGeneration(); // reset-exclusivity token (P1)
    if (!readyRef.current || !key || !text.trim()) return;
    // Byte limit BEFORE anything is persisted: an over-limit note saved locally
    // would be permanently unsyncable (the worker body cap would 413 it).
    if (isNoteTooLong(text)) throw new NoteTooLongError(noteJsonByteLength(text));
    // Single-flight (both flag values): claim synchronously before the first
    // await. A second call must NOT resolve successfully — handleSave clears
    // the composer on resolve, and the first save may still fail.
    if (addInFlightRef.current) throw new OperationInFlightError();
    addInFlightRef.current = true;

    setIsEncrypting(true);
    try {
      // W3 writes v3 (markdown, rev-1 chain root, RAW text — markdown
      // indentation is significant); R3 keeps the exact legacy v1 behavior.
      const encrypted = V3_WRITER_ENABLED
        ? await encryptEnvelopeV3(key, text, { fmt: 'md', rev: 1 })
        : await encrypt(key, text.trim());
      // A LOCK mid-save may proceed (ciphertext at rest is the point) — a
      // RESET may not: the vault this note belongs to is being destroyed, and
      // the save would resurrect data in the wiped DB. Throw (not return):
      // a silent resolve would flash «Сохранено» for a destroyed note.
      if (getDbGeneration() !== myDbGen) {
        throw new Error('Приложение было сброшено — заметка не сохранена.');
      }
      await saveNote(encrypted);

      // Locked mid-save: the note is safe on disk (ciphertext at rest) and the
      // next unlock decrypts it from storage — but this vault is gone from the
      // screen, so no UI publication and no queue work for the new generation.
      if (vaultEpochRef.current !== myEpoch) return;

      const note: NoteData = {
        id: encrypted.noteId,
        text: V3_WRITER_ENABLED ? text : text.trim(),
        createdAt: encrypted.createdAt,
        fmt: V3_WRITER_ENABLED ? 'md' : 'plain',
        rev: 1,
        root: encrypted.noteId,
      };
      publishNotes(prev => [note, ...prev]);

      // ── The note is SAVED from here on. Nothing below may reject: a failing
      //    secondary read would otherwise make the UI report «не удалось
      //    сохранить» for a note that is already on disk, and a retry would
      //    create a duplicate.
      try {
        if (arweaveRef.current.enabled) {
          enqueueUpload({ kind: 'note', record: encrypted }); // best-effort; the note is safe
        }
        await refreshSyncCounts(myEpoch);
      } catch (err) {
        console.error('post-save bookkeeping failed (note IS saved):', err);
      }
    } finally {
      addInFlightRef.current = false;
      setIsEncrypting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** New version of an existing chain. Same commit discipline as addNote
   *  (capture key+epoch → encrypt → save → epoch check → publish → swallowed
   *  bookkeeping), plus: writer flag gate, per-root single-flight, and a
   *  SYNCHRONOUSLY fresh `current` via notesRef/publishNotes — a stale ref
   *  would base rev/prev on the pre-edit version and fork the chain. */
  const editNote = useCallback(async (rootId: string, newText: string, opts?: { fmt?: NoteFormat }) => {
    if (!V3_WRITER_ENABLED) throw new WriterDisabledError();
    const key = cryptoKeyRef.current;
    const myEpoch = vaultEpochRef.current;
    const myDbGen = getDbGeneration(); // reset-exclusivity token (P1)
    if (!readyRef.current || !key || !newText.trim()) return;
    if (isNoteTooLong(newText)) throw new NoteTooLongError(noteJsonByteLength(newText));

    const chain = groupChains(notesRef.current).find(c => c.root === rootId);
    if (!chain) throw new Error('Заметка не найдена.');
    const current = chain.current;
    if (current.rev >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Достигнут предел числа версий этой заметки.');
    }

    // Per-root single-flight — synchronous claim before the first await.
    if (editInFlightRef.current.has(rootId)) throw new OperationInFlightError();
    editInFlightRef.current.add(rootId);

    setIsEncrypting(true);
    try {
      const fmt = opts?.fmt ?? 'md';
      const encrypted = await encryptEnvelopeV3(key, newText, {
        fmt,
        rev: current.rev + 1,
        root: rootId,
        prev: current.id,
      });
      // Same reset gate as addNote: never write a version into a wiped DB.
      if (getDbGeneration() !== myDbGen) {
        throw new Error('Приложение было сброшено — версия не сохранена.');
      }
      await saveNote(encrypted);

      if (vaultEpochRef.current !== myEpoch) return;

      const note: NoteData = {
        id: encrypted.noteId,
        text: newText,
        createdAt: encrypted.createdAt,
        fmt,
        rev: current.rev + 1,
        root: rootId,
        prev: current.id,
      };
      publishNotes(prev => [note, ...prev]);

      // Saved from here on — bookkeeping must not reject (same as addNote).
      try {
        if (arweaveRef.current.enabled) {
          enqueueUpload({ kind: 'note', record: encrypted });
        }
        await refreshSyncCounts(myEpoch);
      } catch (err) {
        console.error('post-edit bookkeeping failed (version IS saved):', err);
      }
    } finally {
      editInFlightRef.current.delete(rootId);
      setIsEncrypting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Manual resume (channel б): clears the pause marker UNCONDITIONALLY
   *  (including a malformed one) and immediately re-enqueues the v3 backlog.
   *  Only ever called from the explicit banner button — automatic paths must
   *  go through the /health-validated probe instead. */
  const resumeV3Uploads = useCallback(async () => {
    const myEpoch = vaultEpochRef.current;
    await clearV3UploadsPaused('any');
    if (vaultEpochRef.current !== myEpoch) return;
    setV3Paused(false);
    setArweave(prev => ({ ...prev, lastError: null }));
    await syncPendingRecords();
    kickQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Manual resume of the SAFEBOX queue — same unconditional contract. */
  const resumeV4Uploads = useCallback(async () => {
    const myEpoch = vaultEpochRef.current;
    await clearV4UploadsPaused('any');
    if (vaultEpochRef.current !== myEpoch) return;
    setV4Paused(false);
    setArweave(prev => ({ ...prev, lastError: null }));
    await syncPendingRecords();
    kickQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleArweave = useCallback(async () => {
    const newEnabled = !arweaveRef.current.enabled;
    await setMeta('ar-enabled', newEnabled);
    setArweave({ enabled: newEnabled });

    if (newEnabled) {
      void retryAllPending().catch(err => console.error('toggleArweave retryAllPending:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retrySync = useCallback(async () => {
    const online = await isArweaveOnline();
    setArweave({ online });
    if (online && arweaveRef.current.enabled) {
      void retryAllPending().catch(err => console.error('retry:', err));
    } else if (!online) {
      setArweave(prev => ({ ...prev, lastError: 'Нет связи с Arweave. Проверьте соединение.' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerWithInviteAction = useCallback(async (inviteCode: string) => {
    if (!publicKeyRef.current || !signingKeyRef.current) return;
    const publicKeyB64 = bufferToBase64(publicKeyRef.current);

    const payload = JSON.stringify({ inviteCode, publicKey: publicKeyB64, timestamp: Date.now() });
    const signature = await signPayload(signingKeyRef.current, payload);

    const result = await registerWithProxy(payload, publicKeyB64, signature);

    if ('ok' in result) {
      await setMeta(`registered:${publicKeyB64}`, true);
      setArweave(prev => ({ ...prev, registered: true }));

      // Auto-resume uploads after successful registration
      void retryAllPending().catch(err => console.error('post-register retryAllPending:', err));
    } else {
      // The raw server text is English/technical — surface the RU mapping
      // (invalid invite / rate limit / clock skew) in the invite form.
      throw new Error(userFacingRegistrationError(result.error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAccessAction = useCallback(async () => {
    await checkAndSetRegistration(vaultEpochRef.current, true); // manual check must reach the server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToRestore = useCallback(() => setScreen('restore'), []);
  const goToOnboarding = useCallback(() => setScreen('onboarding'), []);
  const goToLanding = useCallback(() => setScreen('landing'), []);
  const showMnemonic = useCallback(() => mnemonic, [mnemonic]);

  const resetApp = useCallback(async () => {
    // EXCLUSIVE RESET (P1 review). Order matters:
    // 1. Invalidate every in-flight flow exactly like a lock would — INCLUDING
    //    the lifecycle generation and the privacy gate (round 4): a return-
    //    verdict pending across the reset would otherwise abandon itself via
    //    the epoch check and leave its gate covering the landing screen forever.
    invalidateVaultLifecycle();

    // 2. In-memory refs/state + session FIRST (shared with lockApp): empties
    //    the upload queue so the processor stops after its current item.
    clearVaultState();

    // 3. Tell the OTHER tabs before wiping: each receiver bumps its own DB
    //    generation (noteExternalReset) so its in-flight persists — including
    //    a post-point-of-no-return upload result or a v3 pause marker —
    //    refuse to write into the DB we are about to destroy. Residual
    //    cross-tab window = broadcast delivery latency (ms), not a whole HTTP
    //    round-trip.
    postVaultMessage('reset');

    // 4. IndexedDB — all stores. resetAll() bumps THIS tab's DB generation
    //    first, so every local generation-guarded write (upload results,
    //    restore merges, poll transitions, note saves) is either refused
    //    (checked after the bump) or wiped (its transaction was created
    //    before the clear — IndexedDB serializes readwrite tx per store in
    //    creation order). Nothing can reappear after «Удалить всё».
    await resetAll();

    // 5. Unlike a lock, a RESET destroys the draft ciphertext too (§2): it
    //    belonged to the vault being destroyed and would otherwise resurface
    //    inside the NEXT vault opened in this tab.
    draftStoreRef.current!.clear();

    applyHasPin(false);
    applyAutoLockTimeout(null);

    // 6. Redirect
    setScreen('landing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Recovery from a database that cannot even be OPENED: deletes the DB via
   * idb's deleteDB (no open handle required, unlike resetAll) and reloads the
   * app for a guaranteed-clean boot. Destroys local data — the error screen
   * warns before calling this.
   */
  const resetBrokenStorage = useCallback(async () => {
    try {
      // A blocked deletion cannot be cancelled — it fires whenever the last
      // other tab closes. So we WAIT for real completion (telling the user what
      // to do) instead of pretending the reset was aborted; the page reloads
      // only after the database is truly gone and re-initialized.
      await recoverStorage({
        onBlocked: () => setBootError(
          'Хранилище открыто в другой вкладке приложения. Закройте остальные ' +
          'вкладки — сброс продолжится и завершится автоматически.'
        ),
      });
    } catch (err) {
      // Do NOT reload on failure — the user would land on the same error screen
      // with no idea the reset never happened. Show what to do instead.
      console.error('recoverStorage failed:', err);
      setBootError(`Сброс не удался: ${err instanceof Error ? err.message : String(err)}. Попробуйте ещё раз или перезагрузите страницу.`);
      throw err;
    }
    // Success: clean boot from scratch. Explicit recovery destroys the draft
    // ciphertext too (§2) — it belonged to the destroyed vault.
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    draftStoreRef.current!.clear();
    window.location.reload();
  }, []);

  // ─── Draft actions (§2) ────────────────────────────────────────────

  const persistDraftAction = useCallback(async (text: string) => {
    const key = cryptoKeyRef.current;
    const pk = publicKeyRef.current;
    // Locked: there is no key to encrypt with — and plaintext must NEVER be
    // written as a fallback. The composer is unmounted by then anyway.
    if (!key || !pk) return;
    await draftStoreRef.current!.persist(text, { key, vaultId: bufferToBase64(pk) });
  }, []);

  const readDraftAction = useCallback(async (): Promise<string | null> => {
    const key = cryptoKeyRef.current;
    const pk = publicKeyRef.current;
    if (!key || !pk) return null;
    return draftStoreRef.current!.read({ key, vaultId: bufferToBase64(pk) });
  }, []);

  const clearDraftAction = useCallback(() => {
    draftStoreRef.current!.clear();
  }, []);

  // ─── PIN Actions ────────────────────────────────────────────────────

  const setupPinAction = useCallback(async (pin: string) => {
    if (!mnemonic) return;
    const encrypted = await encryptWithPin(mnemonic, pin);
    await setMeta('pin-seed', encrypted);
    // A local authoritative write wins over any in-flight reconcile read
    // (round 5): the bump makes an older snapshot discard itself instead of
    // reverting this state moments later.
    reconcileGenerationRef.current++;
    applyHasPin(true);
    postVaultMessage('config'); // other tabs re-read pin-seed/timeout
  }, [mnemonic]);

  /** Shared by manual PIN removal AND the 10-strike wipe (§8): ONE atomic meta
   *  transaction (pin-seed + attempts + lockout + auto-lock-timeout→null);
   *  React state and the config broadcast follow ONLY after the commit — an
   *  error mid-cleanup leaves the configuration fully intact, never partial. */
  async function clearPinConfiguration(): Promise<void> {
    await clearPinConfigMeta();
    // Local write wins over any in-flight reconcile read (round 5).
    reconcileGenerationRef.current++;
    applyHasPin(false);
    applyAutoLockTimeout(null);
    postVaultMessage('config');
  }

  const removePinAction = useCallback(async () => {
    await clearPinConfiguration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlockWithPinAction = useCallback(async (pin: string) => {
    // 1. Check lockout
    const lockedUntil = await getMeta<number>('pin-locked-until');
    if (lockedUntil && Date.now() < lockedUntil) {
      const secsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
      throw new PinLockedError(secsLeft);
    }

    const pinData = await getMeta<PinEncryptedSeed>('pin-seed');
    if (!pinData) throw new Error('No PIN set');

    // 2. Try decrypt
    let mn: string;
    try {
      mn = await decryptWithPin(pinData, pin);
    } catch (err) {
      if (!(err instanceof WrongPinError)) {
        // Blob/KDF/runtime failure (PinUnlockUnavailableError) — the PIN was
        // never actually checked. Spending attempts here would wipe a CORRECT
        // PIN after 10 environment hiccups. Surface it without metering.
        throw err;
      }
      // Wrong PIN — increment attempts
      const attempts = ((await getMeta<number>('pin-attempts')) ?? 0) + 1;
      await setMeta('pin-attempts', attempts);

      if (attempts >= 10) {
        // Wipe PIN — require seed. Atomic (§8): also resets the auto-lock
        // timeout and tells the other tabs, or changes nothing on failure.
        await clearPinConfiguration();
        throw new PinWipedError();
      }

      // Progressive lockout
      const lockSeconds =
        attempts <= 3 ? 0 :
        attempts <= 5 ? 30 :
        attempts <= 7 ? 300 :
        1800;

      if (lockSeconds > 0) {
        await setMeta('pin-locked-until', Date.now() + lockSeconds * 1000);
        throw new PinLockedError(lockSeconds);
      }

      throw new Error('wrong_pin');
    }

    // 3. Success — reset attempts
    await deleteMeta('pin-attempts');
    await deleteMeta('pin-locked-until');

    // Transparently upgrade a legacy PBKDF2 blob to Argon2id. If the rewrap
    // fails, keep the working legacy blob and continue — don't block login.
    if (isPinKdfLegacy(pinData)) {
      try {
        await setMeta('pin-seed', await encryptWithPin(mn, pin));
      } catch (err) {
        console.error('PIN rewrap to Argon2id failed (keeping legacy blob):', err);
      }
    }

    const epoch = await openVault(mn);
    if (epoch === null) return;

    await checkAndSetRegistration(epoch);
    if (vaultEpochRef.current === epoch) setScreen('main');

    if (arweaveRef.current.enabled) {
      void retryAllPending().catch(err => console.error('pin unlock retryAllPending:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getPinLockState = useCallback(async (): Promise<{ lockedSeconds: number; attempts: number }> => {
    const lockedUntil = await getMeta<number>('pin-locked-until');
    const attempts = (await getMeta<number>('pin-attempts')) ?? 0;
    const lockedSeconds = lockedUntil && Date.now() < lockedUntil
      ? Math.ceil((lockedUntil - Date.now()) / 1000)
      : 0;
    return { lockedSeconds, attempts };
  }, []);

  // ─── Safebox actions (§6) ──────────────────────────────────────────

  /** Everything an async safebox flow must capture BEFORE its first await. */
  interface SafeboxSession {
    epoch: number;    // vault epoch
    section: number;  // safebox section epoch
    configId: string; // the PIN configuration this session belongs to
    mnemonic: string;
  }

  function captureSafeboxSession(): SafeboxSession {
    const configId = safeboxConfigIdRef.current;
    const mn = mnemonicRef.current;
    if (!safeboxUnlockedRef.current || !configId || !mn || !safeboxMetaKeyRef.current) {
      throw new SafeboxLockedError();
    }
    return {
      epoch: vaultEpochRef.current,
      section: safeboxSectionEpochRef.current,
      configId,
      mnemonic: mn,
    };
  }

  /**
   * The guarantee behind every secret publication (§2). BroadcastChannel is a
   * fast path and may be absent or lossy, so STORAGE is the source of truth:
   * re-read the PIN config and compare `configId` immediately before handing
   * out a secret — plus the two epochs, which catch an app lock or a section
   * lock that happened during the (slow) decrypt.
   */
  async function assertSafeboxSessionLive(session: SafeboxSession): Promise<void> {
    let live = false;
    try {
      const cfg = await readSafeboxPinConfig();
      live = cfg !== null && cfg.configId === session.configId;
    } catch {
      live = false; // malformed config → fail closed
    }
    if (!live) {
      lockSafeboxNow();
      throw new SafeboxConfigChangedError();
    }
    if (vaultEpochRef.current !== session.epoch
        || safeboxSectionEpochRef.current !== session.section) {
      throw new SafeboxLockedError();
    }
  }

  /** Decrypt BOTH halves of one entry. The secret key is derived here and
   *  dropped when this function returns — it is never stored in a ref. */
  async function openSafeboxEntry(session: SafeboxSession, entryId: string): Promise<{
    entry: EncryptedSafeboxEntry;
    meta: SafeboxEntryData;
    secret: SafeboxSecretData;
  }> {
    const entry = await getSafeboxEntryById(entryId);
    if (!entry) throw new Error('Запись сейфа не найдена.');
    const metaKey = safeboxMetaKeyRef.current;
    if (!metaKey || safeboxSectionEpochRef.current !== session.section) throw new SafeboxLockedError();
    const meta = await decryptSafeboxMeta(metaKey, entry);
    const secretKey = await deriveSafeboxSecretKey(session.mnemonic);
    const secret = await decryptSafeboxSecret(secretKey, entry, meta.files);
    return { entry, meta, secret };
  }

  /**
   * Publish an unlocked section: meta key + decrypted metas, under BOTH epochs
   * AND a final storage recheck of the `configId`.
   *
   * Opening the section IS a secret publication (the decrypted metas reach the
   * UI, and a resolved unlock is what the Settings seed gate accepts as proof
   * of the PIN), so it obeys the same rule as reveal/copy/download: STORAGE is
   * the source of truth, checked immediately before anything is written.
   * Decrypting N entries takes real time, and without BroadcastChannel another
   * tab can replace the configuration inside that window.
   *
   * Returns false when a LOCK won the race (nothing published); throws
   * SafeboxConfigChangedError when the configuration moved under us.
   */
  async function publishUnlockedSafebox(
    epoch: number,
    section: number,
    configId: string,
    metaKey: CryptoKey,
  ): Promise<boolean> {
    const stored = await getAllSafeboxEntries();
    const metas: SafeboxEntryData[] = [];
    for (const e of stored) {
      try {
        metas.push(await decryptSafeboxMeta(metaKey, e));
      } catch {
        // A row that cannot be decrypted/validated is skipped individually —
        // it stays counted in the storage-backed reset risk.
      }
    }
    if (vaultEpochRef.current !== epoch || safeboxSectionEpochRef.current !== section) return false;

    // FINAL storage recheck — the same guarantee assertSafeboxSessionLive gives
    // every other secret path, applied to the session's own birth.
    let stillOurs = false;
    try {
      const current = await readSafeboxPinConfig();
      stillOurs = current !== null && current.configId === configId;
    } catch {
      stillOurs = false; // malformed config → fail closed
    }
    if (vaultEpochRef.current !== epoch || safeboxSectionEpochRef.current !== section) return false;
    if (!stillOurs) {
      lockSafeboxNow();
      throw new SafeboxConfigChangedError();
    }
    safeboxMetaKeyRef.current = metaKey;
    safeboxConfigIdRef.current = configId;
    safeboxEntriesRef.current = metas;
    safeboxUnlockedRef.current = true;
    setSafeboxEntries(metas);
    setSafeboxUnlocked(true);
    setSafeboxEntryCount(stored.length);
    setSafeboxPinConfigured(true);
    armSafeboxIdleTimer();
    return true;
  }

  /**
   * Verify a safebox PIN through the METERED path (lockout + attempts + the
   * 10-strike wipe). ONLY SafeboxWrongPinError counts; every environment
   * failure passes through untouched.
   */
  async function meteredVerifySafeboxPin(
    config: { blob: PinEncryptedSeed; configId: string; lockedUntil: number | null },
    pin: string,
    now: number,
    myDbGen: number,
  ): Promise<void> {
    if (config.lockedUntil !== null && now < config.lockedUntil) {
      throw new SafeboxPinLockedError(Math.ceil((config.lockedUntil - now) / 1000));
    }
    try {
      await verifySafeboxPin(config.blob, pin);
    } catch (err) {
      if (!(err instanceof SafeboxWrongPinError)) throw err; // never meter env failures
      const outcome = await commitSafeboxPinFailure(config.configId, now, myDbGen);
      if (outcome.wiped) {
        // The CONFIGURATION is gone; the entries are untouched.
        lockSafeboxNow();
        setSafeboxPinConfigured(false);
        postVaultMessage('config');
        throw new SafeboxPinWipedError();
      }
      if (outcome.lockedUntil !== null) throw new SafeboxPinLockedError(safeboxLockSeconds(outcome.attempts));
      throw err;
    }
    // Also re-verifies the configId INSIDE its transaction: a config replaced
    // during the (slow) KDF must not be unlocked by a proof for the old one.
    await commitSafeboxPinSuccess(config.configId, myDbGen);
  }

  /**
   * «Not the same as the main PIN» — a hygiene check, NOT a security boundary.
   * Exactly ONE raw `decryptWithPin` against pin-seed, deliberately OUTSIDE the
   * metered path: it must never read or write pin-attempts / pin-locked-until,
   * or ten safebox PIN setups would wipe a perfectly good main PIN.
   * WrongPinError is the EXPECTED, allowed outcome; "cannot verify" allows too.
   */
  async function assertDifferentFromMainPin(pin: string): Promise<void> {
    let pinSeed: unknown;
    try {
      ({ pinSeed } = await getPinConfigMeta());
    } catch {
      return; // cannot read → cannot check → allow
    }
    if (!pinSeed) return; // no main PIN configured — nothing to collide with
    try {
      await decryptWithPin(pinSeed as PinEncryptedSeed, pin);
    } catch (err) {
      if (err instanceof WrongPinError) return;             // different → allow
      if (err instanceof PinUnlockUnavailableError) return; // unverifiable → allow
      return;                                               // any other failure → allow
    }
    throw new SafeboxSamePinError(); // it decrypted ⇒ the PINs are identical
  }

  /**
   * Proof-by-decrypt for the seed paths (activation over existing data, PIN
   * reset). PRIMARY check: the derived Ed25519 public key must equal this
   * vault's identity. ADDITIONAL integrity check when entries exist: the meta
   * key derived from the phrase must actually decrypt one of them.
   */
  async function verifySafeboxSeed(mn: string): Promise<void> {
    if (!isValidMnemonic(mn)) throw new SafeboxSeedMismatchError();
    const { publicKey } = await deriveSigningKeypair(mn);
    const candidate = bufferToBase64(publicKey);
    const current = publicKeyRef.current
      ? bufferToBase64(publicKeyRef.current)
      : await getMeta<string>('vault-public-key');
    if (!current || current !== candidate) throw new SafeboxSeedMismatchError();

    const stored = await getAllSafeboxEntries();
    if (stored.length === 0) return; // pubkey check alone (nothing to decrypt)
    const metaKey = await deriveSafeboxMetaKey(mn);
    for (const e of stored) {
      try {
        await decryptSafeboxMeta(metaKey, e);
        return;
      } catch { /* try the next row — some may be genuinely corrupted */ }
    }
    throw new SafeboxSeedMismatchError();
  }

  function assertSafeboxPinFormat(pin: string): void {
    if (!isValidSafeboxPin(pin)) {
      throw new Error('PIN сейфа: только цифры, от 6 до 8 знаков.');
    }
  }

  const activateSafebox = useCallback(async (pin: string, opts?: { mnemonic?: string }) => {
    // Writer-INDEPENDENT on purpose: a user who just restored on a new device
    // must be able to reach their passwords on R4.
    assertSafeboxPinFormat(pin);
    // BOTH epochs captured BEFORE the first await. The section epoch matters
    // even though no section is open yet: a hidden/pagehide edge during the
    // ~1 s Argon2 bumps it, and re-reading it afterwards would let a cancelled
    // activation set a PIN and open the section inside a HIDDEN tab.
    const myEpoch = vaultEpochRef.current;
    const mySection = safeboxSectionEpochRef.current;
    const myDbGen = getDbGeneration(); // reset-exclusivity token (P1)
    const mn = mnemonicRef.current;
    if (!mn) throw new SafeboxLockedError();
    if (await hasSafeboxPinConfig()) {
      throw new Error('PIN сейфа уже установлен — используйте смену PIN.');
    }

    const dataPresent = (await countSafeboxEntries()) > 0;
    if (dataPresent) {
      // Existing data + no config (new device, post-wipe, after deactivation):
      // full seed entry is the ONLY way in — otherwise «деактивировать → свой
      // PIN → открыть» would walk straight around the gate.
      const freshRestore = freshRestoreRef.current === myEpoch;
      try {
        if (opts?.mnemonic !== undefined) await verifySafeboxSeed(opts.mnemonic);
        else if (!freshRestore) throw new SafeboxSeedRequiredError();
      } catch (err) {
        freshRestoreRef.current = null; // a failed attempt burns the window
        throw err;
      }
      freshRestoreRef.current = null;   // one-shot, consumed either way
    }

    await assertDifferentFromMainPin(pin);

    const blob = await createSafeboxPinBlob(pin);
    // A lock during the KDF CANCELS the activation outright: nothing is
    // written, so the user is not left with a PIN they never finished setting.
    if (vaultEpochRef.current !== myEpoch || safeboxSectionEpochRef.current !== mySection) {
      throw new SafeboxLockedError();
    }
    // CREATE-IF-ABSENT inside one transaction: Argon2id takes ~1 s, and a
    // racing activation in another tab must not be silently overwritten.
    const configId = await commitSafeboxPinWrite(blob, 'absent', myDbGen);
    setSafeboxPinConfigured(true);
    postVaultMessage('config');

    // Activation opens the section immediately — the user just proved the PIN.
    // Published under the epochs captured UP FRONT, so a lock that landed
    // after the write leaves the PIN configured but the section CLOSED.
    const metaKey = await deriveSafeboxMetaKey(mn);
    if (!await publishUnlockedSafebox(myEpoch, mySection, configId, metaKey)) {
      throw new SafeboxLockedError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Unlock the section. RESOLVES ONLY on a fully published, live session —
   * a lock (app or section) at ANY point makes it throw SafeboxLockedError.
   * Callers treat a resolved promise as proof that the PIN was verified AND is
   * still valid right now (the Settings seed gate depends on exactly that).
   */
  const unlockSafebox = useCallback(async (pin: string) => {
    const myEpoch = vaultEpochRef.current;
    const section = safeboxSectionEpochRef.current;
    const myDbGen = getDbGeneration();
    const mn = mnemonicRef.current;
    if (!mn) throw new SafeboxLockedError();

    const config = await readSafeboxPinConfig(); // throws Unavailable on malformed
    if (!config) throw new SafeboxNotConfiguredError();

    await meteredVerifySafeboxPin(config, pin, Date.now(), myDbGen);
    if (vaultEpochRef.current !== myEpoch || safeboxSectionEpochRef.current !== section) {
      // A lock won the race during the KDF. Resolving here would let a caller
      // read «the PIN was accepted» as «the session is open».
      throw new SafeboxLockedError();
    }

    const metaKey = await deriveSafeboxMetaKey(mn);
    if (!await publishUnlockedSafebox(myEpoch, section, config.configId, metaKey)) {
      throw new SafeboxLockedError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockSafeboxAction = useCallback(() => lockSafeboxNow(), []);

  const touchSafebox = useCallback(() => {
    if (safeboxUnlockedRef.current) armSafeboxIdleTimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeSafeboxPin = useCallback(async (currentPin: string, newPin: string) => {
    // The unlocked section is NOT sufficient — changing the PIN requires the
    // current one (otherwise an open screen is a free PIN reset).
    assertSafeboxPinFormat(newPin);
    const myDbGen = getDbGeneration();
    const config = await readSafeboxPinConfig();
    if (!config) throw new SafeboxNotConfiguredError();
    await meteredVerifySafeboxPin(config, currentPin, Date.now(), myDbGen);
    await assertDifferentFromMainPin(newPin);

    const blob = await createSafeboxPinBlob(newPin);
    // REPLACE-IF-STILL-OURS: between the verification above and this write
    // (two Argon2id runs apart) another tab may have installed its own config.
    const configId = await commitSafeboxPinWrite(blob, { configId: config.configId }, myDbGen);
    // OUR session survives its own change (we just re-authenticated); every
    // other tab sees a different configId and locks.
    if (safeboxUnlockedRef.current) safeboxConfigIdRef.current = configId;
    setSafeboxPinConfigured(true);
    postVaultMessage('config');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deactivateSafebox = useCallback(async (currentPin: string) => {
    const myDbGen = getDbGeneration();
    const config = await readSafeboxPinConfig();
    if (!config) throw new SafeboxNotConfiguredError();
    await meteredVerifySafeboxPin(config, currentPin, Date.now(), myDbGen);
    await commitSafeboxPinDelete(config.configId, myDbGen);
    lockSafeboxNow();
    setSafeboxPinConfigured(false);
    postVaultMessage('config');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetSafeboxPinWithSeed = useCallback(async (mn: string, newPin: string) => {
    // The ONLY way back in after a wipe / on a new device. DATA IS NOT TOUCHED.
    assertSafeboxPinFormat(newPin);
    const myDbGen = getDbGeneration();
    await verifySafeboxSeed(mn);
    await assertDifferentFromMainPin(newPin);
    const blob = await createSafeboxPinBlob(newPin);
    // Unconditional by design — proof of the seed outranks any existing
    // configuration — but still refused if the vault was reset meanwhile.
    await commitSafeboxPinWrite(blob, 'seed-authorized', myDbGen);
    // Any session under the OLD config is over — including this tab's: the new
    // PIN was proven by the SEED, not by unlocking, so the user re-enters it.
    lockSafeboxNow();
    safeboxConfigIdRef.current = null;
    setSafeboxPinConfigured(true);
    postVaultMessage('config');
  }, []);

  const getSafeboxPinLockState = useCallback(async () => {
    try {
      const config = await readSafeboxPinConfig();
      if (!config) return { lockedSeconds: 0, attempts: 0, configured: false };
      const lockedSeconds = config.lockedUntil !== null && Date.now() < config.lockedUntil
        ? Math.ceil((config.lockedUntil - Date.now()) / 1000)
        : 0;
      return { lockedSeconds, attempts: config.attempts, configured: true };
    } catch {
      // Malformed config: present but unusable — report it as configured with
      // no lockout so the UI offers the seed-reset path.
      return { lockedSeconds: 0, attempts: 0, configured: true };
    }
  }, []);

  // ── Writer actions (all three gated by SAFEBOX_WRITER_ENABLED) ──────

  /** Encrypt + size-check + persist ONE new version. The configId recheck and
   *  the write happen in ONE readwrite transaction (§6) — between a separate
   *  `getMeta()` and a separate write another tab could replace the config. */
  async function commitSafeboxVersion(
    session: SafeboxSession,
    myDbGen: number,
    input: SafeboxEntryInput,
  ): Promise<EncryptedSafeboxEntry> {
    const metaKey = safeboxMetaKeyRef.current;
    if (!metaKey) throw new SafeboxLockedError();
    const secretKey = await deriveSafeboxSecretKey(session.mnemonic);
    const entry = await encryptSafeboxEntry(metaKey, secretKey, input);

    // Measure the WHOLE worst-case signed body BEFORE persisting: an
    // over-limit entry would pass locally and then be stuck on the recheck
    // path forever (the retry body is strictly larger).
    const bytes = safeboxUploadByteLength(entry, ownerHashRef.current ?? undefined);
    if (bytes > MAX_UPLOAD_BODY_BYTES) throw new SafeboxEntryTooLargeError(bytes);

    // BOTH epochs, synchronously, right before the write. A lock changes
    // neither the config nor the dbGeneration, so without this check a version
    // encrypted before the lock would still land on disk — invisible to the
    // user whose form was torn down, and later dispatched as a paid upload.
    // (Notes deliberately DO persist across a lock; the safebox does not —
    // its form is destroyed by the lock instead of being saved.)
    if (vaultEpochRef.current !== session.epoch
        || safeboxSectionEpochRef.current !== session.section) {
      throw new SafeboxLockedError();
    }
    await commitSafeboxEntry(entry, session.configId, myDbGen);
    return entry;
  }

  function metaFromInput(entry: EncryptedSafeboxEntry, input: SafeboxEntryInput): SafeboxEntryData {
    return {
      id: entry.entryId,
      createdAt: entry.createdAt,
      title: input.title,
      login: input.login,
      url: input.url,
      note: input.note,
      files: input.files.map(f => ({ fid: f.fid, name: f.name, mime: f.mime, size: f.size })),
      rev: input.rev,
      root: input.root ?? entry.entryId,
      ...(input.prev !== undefined ? { prev: input.prev } : {}),
    };
  }

  /** Post-write bookkeeping shared by all three writer actions. Must not
   *  reject: the version is already on disk. */
  async function afterSafeboxWrite(
    session: SafeboxSession,
    entry: EncryptedSafeboxEntry,
    meta: SafeboxEntryData,
  ): Promise<void> {
    if (vaultEpochRef.current !== session.epoch
        || safeboxSectionEpochRef.current !== session.section) return;
    publishSafeboxEntries(prev => [meta, ...prev.filter(e => e.id !== meta.id)]);
    try {
      if (arweaveRef.current.enabled) enqueueUpload({ kind: 'safebox', record: entry });
      await refreshSyncCounts(session.epoch);
      await refreshSafeboxPresence(session.epoch);
      armSafeboxIdleTimer();
    } catch (err) {
      console.error('post-save safebox bookkeeping failed (entry IS saved):', err);
    }
  }

  const addSafeboxEntry = useCallback(async (input: SafeboxNewEntry) => {
    if (!SAFEBOX_WRITER_ENABLED) {
      throw new WriterDisabledError('Добавление записей в сейф недоступно в этой версии приложения.');
    }
    const session = captureSafeboxSession();
    const myDbGen = getDbGeneration();
    if (safeboxAddInFlightRef.current) throw new OperationInFlightError();
    safeboxAddInFlightRef.current = true;
    setIsEncrypting(true);
    try {
      const entryInput: SafeboxEntryInput = {
        title: input.title,
        login: input.login,
        url: input.url,
        note: input.note,
        password: input.password,
        files: input.files.map(f => ({ ...f, fid: randomUuidV8() })),
        rev: 1,
      };
      const entry = await commitSafeboxVersion(session, myDbGen, entryInput);
      await afterSafeboxWrite(session, entry, metaFromInput(entry, entryInput));
    } finally {
      safeboxAddInFlightRef.current = false;
      setIsEncrypting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Resolve the chain head for a writer action (fresh, from the ref). */
  function safeboxChainHead(rootId: string): SafeboxEntryData {
    const chain = groupSafeboxChains(safeboxEntriesRef.current).find(c => c.root === rootId);
    if (!chain) throw new Error('Запись сейфа не найдена.');
    if (chain.current.rev >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Достигнут предел числа версий этой записи.');
    }
    return chain.current;
  }

  const editSafeboxEntry = useCallback(async (rootId: string, patch: SafeboxEntryPatch) => {
    if (!SAFEBOX_WRITER_ENABLED) {
      throw new WriterDisabledError('Редактирование записей сейфа недоступно в этой версии приложения.');
    }
    const session = captureSafeboxSession();
    const myDbGen = getDbGeneration();
    const head = safeboxChainHead(rootId);
    if (safeboxEditInFlightRef.current.has(rootId)) throw new OperationInFlightError();
    safeboxEditInFlightRef.current.add(rootId);
    setIsEncrypting(true);
    try {
      // The CURRENT secret is decrypted only NOW, on submit — never when the
      // form opens (it must not sit in memory or the DOM while typing).
      const current = await openSafeboxEntry(session, head.id);
      const patched = applySafeboxPatch({ meta: current.meta, secret: current.secret }, patch);
      const entryInput: SafeboxEntryInput = {
        ...patched,
        rev: head.rev + 1,
        root: rootId,
        prev: head.id,
      };
      const entry = await commitSafeboxVersion(session, myDbGen, entryInput);
      await afterSafeboxWrite(session, entry, metaFromInput(entry, entryInput));
    } finally {
      safeboxEditInFlightRef.current.delete(rootId);
      setIsEncrypting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restoreSafeboxVersion = useCallback(async (rootId: string, versionId: string) => {
    // A FULL writer action, not a read: same gate, single-flight, epochs,
    // configId recheck, size limit and dbGeneration discipline as add/edit.
    if (!SAFEBOX_WRITER_ENABLED) {
      throw new WriterDisabledError('Возврат версий сейфа недоступен в этой версии приложения.');
    }
    const session = captureSafeboxSession();
    const myDbGen = getDbGeneration();
    const head = safeboxChainHead(rootId);
    if (safeboxEditInFlightRef.current.has(rootId)) throw new OperationInFlightError();
    safeboxEditInFlightRef.current.add(rootId);
    setIsEncrypting(true);
    try {
      const source = await openSafeboxEntry(session, versionId);
      if (source.meta.root !== rootId) throw new Error('Версия не принадлежит этой записи.');
      // A version is a FULL snapshot: title/login/url/note/password/files.
      const snapshot = snapshotSafeboxVersion(source.meta, source.secret);
      const entryInput: SafeboxEntryInput = {
        ...snapshot,
        rev: head.rev + 1,
        root: rootId,
        prev: head.id,
      };
      const entry = await commitSafeboxVersion(session, myDbGen, entryInput);
      await afterSafeboxWrite(session, entry, metaFromInput(entry, entryInput));
    } finally {
      safeboxEditInFlightRef.current.delete(rootId);
      setIsEncrypting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reveal / copy / download (secret publication paths) ─────────────

  const revealSafeboxSecret = useCallback(async (entryId: string): Promise<string> => {
    const session = captureSafeboxSession();
    const { secret } = await openSafeboxEntry(session, entryId);
    // Storage-backed recheck IMMEDIATELY before the secret leaves this call.
    await assertSafeboxSessionLive(session);
    armSafeboxIdleTimer();
    return secret.password;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copySafeboxPassword = useCallback(async (entryId: string): Promise<boolean> => {
    const session = captureSafeboxSession();
    const { secret } = await openSafeboxEntry(session, entryId);
    await assertSafeboxSessionLive(session);
    armSafeboxIdleTimer();
    // Straight from the string — the plaintext NEVER enters the DOM.
    const ok = await copyTextToClipboard(secret.password);
    if (ok) armClipboardClear();
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadSafeboxAttachment = useCallback(async (entryId: string, fid: string) => {
    const session = captureSafeboxSession();
    const { meta, secret } = await openSafeboxEntry(session, entryId);
    const descriptor = meta.files.find(f => f.fid === fid);
    const content = secret.files.find(f => f.fid === fid);
    if (!descriptor || !content) throw new Error('Вложение не найдено.');
    await assertSafeboxSessionLive(session);
    armSafeboxIdleTimer();

    const bytes = base64ToBuffer(content.data);
    const blob = new Blob([bytes as BlobPart], { type: descriptor.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = descriptor.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Revoke on the NEXT task: a synchronous revoke aborts the download in
      // several browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Auto-lock timeout setting (§6) ────────────────────────────────

  const setAutoLockTimeoutAction = useCallback(async (t: AutoLockTimeout) => {
    // Whitelist even against our own callers — a bad value persisted here
    // would fail-secure into «Никогда» on next boot, silently disabling the
    // protection the user thinks is on.
    if (!isValidAutoLockTimeout(t)) {
      throw new Error(`Invalid auto-lock timeout: ${String(t)}`);
    }
    await setMeta('auto-lock-timeout', t); // persist-first: reject → state untouched
    // Local write wins over any in-flight reconcile read (round 5).
    reconcileGenerationRef.current++;
    applyAutoLockTimeout(t);
    postVaultMessage('config');
  }, []);

  const lockAppAction = useCallback(() => lockApp(), [lockApp]);

  // ─── Search / chains ───────────────────────────────────────────────

  // Memoized like filteredChains: an inline computation would mint a fresh
  // array identity on every provider render while a query is active,
  // invalidating the L4 context-value memo below on renders that changed
  // nothing else.
  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(n => n.text.toLowerCase().includes(q));
  }, [notes, searchQuery]);

  // Reader view: ALWAYS derived, at both flag values (see NotesStore.chains).
  const chains = useMemo(() => groupChains(notes), [notes]);
  // Search matches the CURRENT version only — what the user actually sees on
  // the card; historical versions are reachable through the history modal.
  const filteredChains = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chains;
    return chains.filter(c => c.current.text.toLowerCase().includes(q));
  }, [chains, searchQuery]);

  // Safebox chains, grouped over the AUTHENTICATED envelope fields. Search is
  // scoped to the safebox and to NON-SECRET fields only — this code path never
  // holds the secret key, so a password can never be indexed by construction.
  const safeboxChains = useMemo(() => groupSafeboxChains(safeboxEntries), [safeboxEntries]);
  const filteredSafeboxChains = useMemo(() => {
    const q = safeboxSearchQuery.trim();
    if (!q) return safeboxChains;
    return safeboxChains.filter(c => matchesSafeboxQuery(c.current, q));
  }, [safeboxChains, safeboxSearchQuery]);

  // ─── Context Value ──────────────────────────────────────────────────

  // L4: memoized — otherwise every provider render handed consumers a fresh
  // object and re-rendered the whole tree. All actions are useCallback'd, so
  // the deps below are the actual invalidation set.
  const value: NotesStore = useMemo(() => ({
    screen,
    isReady,
    mnemonic,
    notes,
    isEncrypting,
    searchQuery,
    filteredNotes,
    chains,
    filteredChains,
    v3Paused,
    v4Paused,
    safeboxUnlocked,
    safeboxLockGeneration,
    safeboxPinConfigured,
    safeboxDataPresent: safeboxEntryCount > 0,
    safeboxEntryCount,
    safeboxEntries,
    safeboxChains,
    filteredSafeboxChains,
    safeboxSearchQuery,
    restoredSafeboxCount,
    arweave: arweaveState,
    syncStatuses,
    restoring,
    restoreProgress,
    restoreError,
    restoredCount,
    restoredUpdatedCount,
    updateCheck,
    vaultError,
    hasPin,
    autoLockTimeout,
    bootError,
    storageBlocked,
    storageOutdated,

    createNewWallet,
    confirmMnemonic,
    restoreFromMnemonic,
    addNote,
    editNote,
    resumeV3Uploads,
    resumeV4Uploads,
    setSearchQuery,
    activateSafebox,
    unlockSafebox,
    lockSafebox: lockSafeboxAction,
    touchSafebox,
    changeSafeboxPin,
    deactivateSafebox,
    resetSafeboxPinWithSeed,
    getSafeboxPinLockState,
    addSafeboxEntry,
    editSafeboxEntry,
    restoreSafeboxVersion,
    revealSafeboxSecret,
    copySafeboxPassword,
    downloadSafeboxAttachment,
    setSafeboxSearchQuery,
    goToRestore,
    goToOnboarding,
    goToLanding,
    showMnemonic,
    resetApp,
    toggleArweave,
    retrySync,
    registerWithInvite: registerWithInviteAction,
    checkAccess: checkAccessAction,
    setupPin: setupPinAction,
    removePin: removePinAction,
    unlockWithPin: unlockWithPinAction,
    getPinLockState,
    setAutoLockTimeout: setAutoLockTimeoutAction,
    lockApp: lockAppAction,
    persistDraft: persistDraftAction,
    readDraft: readDraftAction,
    clearDraft: clearDraftAction,
    resetBrokenStorage,
    retryRestore,
    checkForUpdates,
    clearRestoreStatus,
    dismissError,
  }), [
    screen, isReady, mnemonic, notes, isEncrypting, searchQuery, filteredNotes,
    chains, filteredChains, v3Paused, v4Paused,
    safeboxUnlocked, safeboxLockGeneration, safeboxPinConfigured, safeboxEntryCount, safeboxEntries,
    safeboxChains, filteredSafeboxChains, safeboxSearchQuery, restoredSafeboxCount,
    arweaveState, syncStatuses, restoring, restoreProgress, restoreError,
    restoredCount, restoredUpdatedCount, updateCheck, vaultError, hasPin, autoLockTimeout, bootError,
    storageBlocked, storageOutdated,
    createNewWallet, confirmMnemonic, restoreFromMnemonic, addNote,
    editNote, resumeV3Uploads, resumeV4Uploads,
    activateSafebox, unlockSafebox, lockSafeboxAction, touchSafebox,
    changeSafeboxPin, deactivateSafebox, resetSafeboxPinWithSeed,
    getSafeboxPinLockState, addSafeboxEntry, editSafeboxEntry, restoreSafeboxVersion,
    revealSafeboxSecret, copySafeboxPassword, downloadSafeboxAttachment,
    goToRestore, goToOnboarding, goToLanding, showMnemonic, resetApp,
    toggleArweave, retrySync, registerWithInviteAction, checkAccessAction,
    setupPinAction, removePinAction, unlockWithPinAction, getPinLockState,
    setAutoLockTimeoutAction, lockAppAction, persistDraftAction,
    readDraftAction, clearDraftAction,
    resetBrokenStorage, retryRestore, checkForUpdates, clearRestoreStatus, dismissError,
  ]);

  return (
    <StoreContext.Provider value={value}>
      {/* display:contents keeps the wrapper layout-neutral; `inert` while the
          gate is up removes the underlying UI from focus, pointer events and
          the accessibility tree — the visual overlay alone would leave
          keyboard/AT access to the plaintext behind it.
          NOTE: `inert`/`hidden` here are driven IMPERATIVELY via the refs (see
          setLockGate), never as React props — a React commit is not guaranteed
          to land before the BFCache snapshot is taken on `pagehide`. */}
      <div ref={gateContentRef} style={{ display: 'contents' }}>
        {children}
      </div>
      {/* Rendered by the PROVIDER (never a screen) and ALWAYS MOUNTED, so
          raising it is a synchronous attribute flip rather than a render. */}
      <div
        ref={gateElRef}
        className="lock-gate"
        role="status"
        aria-live="polite"
        aria-label="Проверка авто-блокировки"
        hidden
      >
        <span className="lock-gate-icon" aria-hidden="true">🔒</span>
      </div>
    </StoreContext.Provider>
  );
}

export function useNotes(): NotesStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useNotes must be inside NotesProvider');
  return ctx;
}
