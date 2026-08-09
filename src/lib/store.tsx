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
  signPayload,
  encrypt,
  encryptEnvelopeV3,
  decryptNote,
  encryptWithPin,
  decryptWithPin,
  isPinKdfLegacy,
  WrongPinError,
  UnsupportedNoteVersionError,
  bufferToBase64,
  type EncryptedNote,
  type NoteData,
  type NoteFormat,
  type PinEncryptedSeed,
} from './crypto';
import { groupChains, type NoteChain } from './chains';
import { V3_WRITER_ENABLED } from './flags';
import { isNoteTooLong, noteJsonByteLength, NoteTooLongError } from './limits';
import {
  isArweaveOnline,
  checkRegistration,
  registerWithProxy,
  uploadViaProxy,
  fetchAllNotes,
  getTxStatus,
  getWorkerCapabilities,
} from './arweave';
import {
  initStorage,
  getAllNotes,
  saveNote,
  mergeRestoredNote,
  getAllSyncRecords,
  getRecordsByStatus,
  getSyncRecord,
  setSyncRecord,
  commitV3PausedFailure,
  readV3PauseMeta,
  clearV3UploadsPaused,
  getMeta,
  setMeta,
  deleteMeta,
  getPinConfigMeta,
  clearPinConfigMeta,
  resetAll,
  recoverStorage,
  type SyncRecord,
} from './storage';
import { afterPoll, claimRestoredForUi } from './sync-transitions';
import { runUploadAttempt } from './upload-flow';
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

// Re-exported for callers that only need the storage key (reset paths, tests).
export { DRAFT_STORAGE_KEY };

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
  /** STORAGE-BACKED reset risk: all EncryptedNote records minus confirmed ones.
   *  The reset dialog must use THIS, not the visible `notes` — an invisible
   *  quarantined/undecryptable record would otherwise let «всё подтверждено»
   *  greenlight deleting data a newer client could still read. */
  resetRiskCount: number;
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
  resetRiskCount: 0,
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

/** editNote called while V3_WRITER_ENABLED=false (R3). A silent no-op is
 *  forbidden — the edit modal would read it as a successful save. */
export class WriterDisabledError extends Error {
  constructor() {
    super('Редактирование заметок недоступно в этой версии приложения.');
    this.name = 'WriterDisabledError';
  }
}

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
  vaultError: string | null;
  hasPin: boolean;
  /** Current auto-lock threshold (§1): null=never, 0=immediately, 300/1800 s. */
  autoLockTimeout: AutoLockTimeout;
  bootError: string | null;

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
  setSearchQuery: (query: string) => void;
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
  clearRestoreStatus: () => void;
  dismissError: () => void;
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
  // v3 uploads paused by the worker kill switch. Authoritative state lives in
  // the shared IndexedDB marker (readV3PauseMeta) — this mirrors it for the UI.
  const [v3Paused, setV3Paused] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [autoLockTimeout, setAutoLockTimeoutState] = useState<AutoLockTimeout>(null);
  // Opaque privacy gate (review rounds 2–3): raised SYNCHRONOUSLY on the
  // hidden edge — or when a vault COMMITS into a hidden tab — and dropped only
  // by the lifecycle cycle that owns it, so no frame painted after a return
  // can show plaintext that the verdict then locks away.
  const [lockGate, setLockGate] = useState(false);
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

  // Upload queue refs
  const uploadQueueRef = useRef<EncryptedNote[]>([]);
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
      if (vaultPresentInTab()) setLockGate(true);
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
      if (e.persisted) evaluateReturn();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      }
    };
    return () => {
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function postVaultMessage(type: 'lock' | 'config') {
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

  /** Everything a lock must invalidate, in one place (round 4): vault epoch,
   *  upload-queue generation, the lifecycle cycle that owns the privacy gate
   *  (pending return-verdict), the gate itself and the in-flight vault op.
   *  Shared by lockApp and resetApp — a reset that skipped any of these could
   *  leave an orphaned gate over the landing screen forever. */
  function invalidateVaultLifecycle(): void {
    vaultEpochRef.current++;
    queueGenerationRef.current++;
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
      // 1. Init storage (IndexedDB + migrate localStorage)
      await initStorage();

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
      const pause = await readV3PauseMeta();
      if (vaultEpochRef.current === myEpoch) setV3Paused(pause !== null);
    } catch (err) {
      console.error('readV3PauseMeta at unlock failed:', err);
    }

    // Background: network-dependent parts only (online probe + queue kick).
    void initArweaveState(myEpoch).catch(err => console.error('initArweaveState:', err));

    return myEpoch;
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
    if (!vaultPresentInTab()) return;

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
   *  if the vault the caller saw is still the vault on screen. */
  async function refreshSyncCounts(epoch: number) {
    const allNotes = await getAllNotes();
    const allSync = await getAllSyncRecords();
    if (vaultEpochRef.current !== epoch) return; // stale — never touch the UI

    // terminalError (permanent quarantine) is counted SEPARATELY from errors:
    // «Ошибки: N» implies «Повторить» can fix it, but the retry paths skip
    // quarantined records by design — showing them as retryable errors would
    // be a lie the user can never resolve. They still count in resetRiskCount.
    let accepted = 0, confirmed = 0, errors = 0, quarantined = 0;
    for (const r of allSync) {
      if (r.status === 'accepted') accepted++;
      else if (r.status === 'confirmed') confirmed++;
      else if (r.terminalError !== undefined) quarantined++;
      else if (r.status === 'error') errors++;
    }

    const unsynced = allNotes.length - accepted - confirmed;
    // Storage-backed: EVERY stored record that is not confirmed is at risk on a
    // reset — including versions invisible in the UI (historical, quarantined,
    // undecryptable). Never derived from the visible `notes`.
    const resetRisk = allNotes.length - confirmed;

    // Join notes ↔ sync records for the per-card indicator (+ txId for menus).
    const byId = new Map(allSync.map(r => [r.noteId, r]));
    const statuses: Record<string, NoteSyncInfo> = {};
    for (const n of allNotes) {
      const rec = byId.get(n.noteId);
      statuses[n.noteId] = rec ? { status: rec.status, txId: rec.txId } : { status: 'queued' };
    }
    setSyncStatuses(statuses);

    setArweave(prev => ({
      ...prev,
      acceptedCount: accepted,
      confirmedCount: confirmed,
      unsyncedCount: unsynced,
      countsReady: true,
      errorCount: errors,
      quarantinedCount: quarantined,
      resetRiskCount: resetRisk,
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

  function enqueueUpload(note: EncryptedNote) {
    if (queuedIdsRef.current.has(note.noteId)) return;
    queuedIdsRef.current.add(note.noteId);
    uploadQueueRef.current.push(note);
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

        const note = uploadQueueRef.current[0];

        // v3 pause is authoritative SHARED state: re-read the marker right
        // before every v3 dispatch (another tab may have set it; our per-tab
        // refs know nothing). At most one initial 503 per already-open tab —
        // after that the marker short-circuits here without HTTP.
        if (note.v === 3) {
          let paused = false;
          try {
            paused = (await readV3PauseMeta()) !== null;
          } catch (err) {
            console.error('readV3PauseMeta failed — treating v3 as paused:', err);
            paused = true; // fail closed
          }
          if (queueGenerationRef.current !== myGen) break;
          if (paused) {
            // Drop from BOTH queue structures — a skipped id left in
            // queuedIdsRef would block its re-enqueue forever after resume.
            uploadQueueRef.current.shift();
            queuedIdsRef.current.delete(note.noteId);
            setV3Paused(true);
            continue; // v1/v2 behind it keep uploading
          }
        }

        const result = await uploadSingleNote(note);

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
        queuedIdsRef.current.delete(note.noteId);

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
  async function uploadSingleNote(note: EncryptedNote): Promise<string> {
    const sk = signingKeyRef.current;
    const oh = ownerHashRef.current;
    const pk = publicKeyRef.current;
    const myEpoch = vaultEpochRef.current;
    if (!sk || !oh || !pk) return 'error';

    let outcome;
    try {
      outcome = await runUploadAttempt(
        note,
        { signingKey: sk, ownerHash: oh, publicKey: pk },
        myEpoch,
        {
          now: () => Date.now(),
          currentEpoch: () => vaultEpochRef.current,
          getSyncRecord,
          setSyncRecord,
          commitV3PausedFailure,
          signPayload,
          uploadViaProxy,
        },
      );
    } catch (err) {
      if (err instanceof UnsupportedNoteVersionError) {
        // The stored record carries a version this build cannot serialize
        // (written by a newer client). PERMANENT local quarantine: terminalError
        // keeps it out of every future queue pass (a plain 'error' would retry
        // forever), no HTTP was made, and resetRiskCount still counts it.
        const prev = await getSyncRecord(note.noteId);
        const quarantined: SyncRecord = {
          noteId: note.noteId,
          txId: prev?.txId,
          status: 'error',
          transport: 'proxy',
          lastError: 'unsupported_version',
          updatedAt: Date.now(),
          recovery: prev?.recovery,
          terminalError: 'unsupported_version',
        };
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
      } else if (result.kind === 'v3_disabled') {
        // The worker's kill switch answered: the pause marker is already
        // persisted (atomically with the failure record, in upload-flow).
        // The STANDING pause banner (v3Paused) is the only UI surface —
        // deliberately NOT lastError: that toast's «Повторить» (retrySync)
        // cannot lift the pause, so it would sit next to the banner's working
        // «Возобновить» as a contradicting dead control. NEVER markUnregistered.
        setV3Paused(true);
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

  async function syncPendingNotes() {
    const allNotes = await getAllNotes();
    const allSync = await getAllSyncRecords();
    const now = Date.now();

    // v3 pause: don't even enqueue v3 records while the shared marker stands —
    // the per-dispatch check in processQueue is the backstop, this avoids the
    // churn. An unreadable marker counts as paused (fail closed).
    let v3PausedNow = false;
    try {
      v3PausedNow = (await readV3PauseMeta()) !== null;
    } catch {
      v3PausedNow = true;
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
    const pending = allNotes.filter(n => !skipIds.has(n.noteId) && !(v3PausedNow && n.v === 3));
    for (const note of pending) {
      enqueueUpload(note);
    }
  }

  async function retryAllPending() {
    setArweave(prev => ({ ...prev, lastError: null }));
    await syncPendingNotes();
    kickQueue();
  }

  // ─── TX Status Polling ──────────────────────────────────────────────

  async function pollTxStatuses() {
    if (document.visibilityState !== 'visible') return;
    if (!cryptoKeyRef.current) return; // locked — nothing to poll for
    if (!arweaveRef.current.enabled || !arweaveRef.current.online) return;
    const myEpoch = vaultEpochRef.current;

    // Resume channel (а): while the v3 pause stands, each poll cycle probes the
    // strictly-validated /health. The marker is lifted ONLY via compare-and-
    // delete on the pausedAt we read BEFORE the probe — a stale success can
    // never erase a newer pause. A malformed marker is not auto-lifted at all
    // (manual retry only). 'disabled'/'unknown' verdicts leave everything as is.
    try {
      const pause = await readV3PauseMeta();
      if (vaultEpochRef.current !== myEpoch) return; // locked during the read
      if (pause !== null) {
        setV3Paused(true); // another tab may have set it since our last read
        if (pause !== 'malformed') {
          const capability = await getWorkerCapabilities();
          if (capability === 'enabled' && await clearV3UploadsPaused(pause.pausedAt)) {
            if (vaultEpochRef.current !== myEpoch) return;
            setV3Paused(false);
            await syncPendingNotes(); // re-enqueue the v3 backlog
            kickQueue();
          }
        }
      } else {
        // The marker is GONE (another tab's /health probe or manual resume
        // lifted it). Without this branch the local banner would claim a
        // pause forever while this tab's uploads actually work.
        setV3Paused(false);
      }
    } catch (err) {
      console.error('v3 pause resume probe failed:', err);
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
        await setSyncRecord(next);
        changed = true;
      }
    }

    if (changed) await refreshSyncCounts(myEpoch);
    // Drain any ready work each cycle (recheck notes past their backoff).
    if (vaultEpochRef.current !== myEpoch) return;
    if (arweaveRef.current.enabled && arweaveRef.current.online) {
      await syncPendingNotes();
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

    // Auto-recover stale uploads (gated on enabled; post-lock enabled=false)
    if (arweaveRef.current.enabled) {
      void retryAllPending().catch(err => console.error('retryAllPending after restore:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restoreFromArweaveInternal() {
    const key = cryptoKeyRef.current;
    if (!key || !ownerHashRef.current) return;
    const myEpoch = vaultEpochRef.current;

    // The sweep is abortable: lockApp() cancels every in-flight page/payload
    // fetch instead of letting them settle against a locked vault.
    const abort = new AbortController();
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = abort;

    setRestoreError(null);
    setRestoredCount(null);
    setRestoredUpdatedCount(null);
    setRestoreProgress(null);
    try {
      // fetchAllNotes decrypts + validates (v1/v2/v3) and drops any TX not
      // signed by a trusted owner or that fails to decrypt.
      const { notes: remoteNotes, incomplete } = await fetchAllNotes(
        ownerHashRef.current,
        key,
        (done, total) => {
          if (vaultEpochRef.current === myEpoch) setRestoreProgress({ done, total });
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
        // Upsert the note payload + confirmed sync state atomically. The
        // payload write matters even for an already-confirmed note: the local
        // ciphertext may be corrupted while the on-chain copy just decrypted.
        await mergeRestoredNote(remote.encrypted, remote.txId, Date.now());

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

      if (remoteNotes.length > 0) {
        await refreshSyncCounts(myEpoch);
      }
      if (vaultEpochRef.current !== myEpoch) return;
      setRestoredCount(newRoots.size);
      setRestoredUpdatedCount(updatedRoots.size);
      if (incomplete) {
        // Some pages/payloads were unreachable — a "quiet partial restore" must
        // not look like a full one (the user could believe notes are lost).
        setRestoreError('Восстановление прошло не полностью — часть заметок могла не загрузиться.');
      }
    } catch (err) {
      console.error('restoreFromArweave failed:', err);
      if (vaultEpochRef.current === myEpoch) {
        setRestoreError('Не удалось восстановить заметки из Arweave.');
      }
    } finally {
      if (vaultOpAbortRef.current === abort) vaultOpAbortRef.current = null;
      if (vaultEpochRef.current === myEpoch) setRestoreProgress(null);
    }
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

  const clearRestoreStatus = useCallback(() => {
    setRestoreError(null);
    setRestoredCount(null);
    setRestoredUpdatedCount(null);
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
          enqueueUpload(encrypted); // sync is best-effort; the note is safe
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
          enqueueUpload(encrypted);
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
    await syncPendingNotes();
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
    // 1. Invalidate every in-flight flow exactly like a lock would — INCLUDING
    //    the lifecycle generation and the privacy gate (round 4): a return-
    //    verdict pending across the reset would otherwise abandon itself via
    //    the epoch check and leave its gate covering the landing screen forever.
    //    BEFORE the wipe (re-review): with the old order an upload could still
    //    pass its point of no return DURING resetAll() and then persist its
    //    result — e.g. a v3_disabled pause marker — into the freshly-emptied
    //    DB, haunting the NEXT vault. The bump cancels every pre-PONR attempt;
    //    the residual window (an attempt already past its PONR when reset is
    //    confirmed) is the same pre-existing one every post-PONR persist has.
    invalidateVaultLifecycle();

    // 2. IndexedDB — all stores
    await resetAll();

    // 3. In-memory refs/state + session (shared with lockApp)
    clearVaultState();

    // 4. Unlike a lock, a RESET destroys the draft ciphertext too (§2): it
    //    belonged to the vault being destroyed and would otherwise resurface
    //    inside the NEXT vault opened in this tab.
    draftStoreRef.current!.clear();

    applyHasPin(false);
    applyAutoLockTimeout(null);

    // 5. Redirect
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
    arweave: arweaveState,
    syncStatuses,
    restoring,
    restoreProgress,
    restoreError,
    restoredCount,
    restoredUpdatedCount,
    vaultError,
    hasPin,
    autoLockTimeout,
    bootError,

    createNewWallet,
    confirmMnemonic,
    restoreFromMnemonic,
    addNote,
    editNote,
    resumeV3Uploads,
    setSearchQuery,
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
    clearRestoreStatus,
    dismissError,
  }), [
    screen, isReady, mnemonic, notes, isEncrypting, searchQuery, filteredNotes,
    chains, filteredChains, v3Paused,
    arweaveState, syncStatuses, restoring, restoreProgress, restoreError,
    restoredCount, restoredUpdatedCount, vaultError, hasPin, autoLockTimeout, bootError,
    createNewWallet, confirmMnemonic, restoreFromMnemonic, addNote,
    editNote, resumeV3Uploads,
    goToRestore, goToOnboarding, goToLanding, showMnemonic, resetApp,
    toggleArweave, retrySync, registerWithInviteAction, checkAccessAction,
    setupPinAction, removePinAction, unlockWithPinAction, getPinLockState,
    setAutoLockTimeoutAction, lockAppAction, persistDraftAction,
    readDraftAction, clearDraftAction,
    resetBrokenStorage, retryRestore, clearRestoreStatus, dismissError,
  ]);

  return (
    <StoreContext.Provider value={value}>
      {/* display:contents keeps the wrapper layout-neutral; `inert` while the
          gate is up removes the underlying UI from focus, pointer events and
          the accessibility tree — the visual overlay alone would leave
          keyboard/AT access to the plaintext behind it. */}
      <div style={{ display: 'contents' }} inert={lockGate || undefined}>
        {children}
      </div>
      {/* Rendered by the PROVIDER, not a screen: the gate must exist wherever
          the vault state does and can never be forgotten by a route. Fully
          opaque and above every modal. */}
      {lockGate && (
        <div className="lock-gate" role="status" aria-live="polite" aria-label="Проверка авто-блокировки">
          <span className="lock-gate-icon" aria-hidden="true">🔒</span>
        </div>
      )}
    </StoreContext.Provider>
  );
}

export function useNotes(): NotesStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useNotes must be inside NotesProvider');
  return ctx;
}
