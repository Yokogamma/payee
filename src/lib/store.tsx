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
  decrypt,
  encryptWithPin,
  decryptWithPin,
  isPinKdfLegacy,
  WrongPinError,
  bufferToBase64,
  type EncryptedNote,
  type NoteData,
  type PinEncryptedSeed,
} from './crypto';
import {
  isArweaveOnline,
  checkRegistration,
  registerWithProxy,
  uploadViaProxy,
  fetchAllNotes,
  getTxStatus,
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
  getMeta,
  setMeta,
  deleteMeta,
  clearPinConfigMeta,
  resetAll,
  recoverStorage,
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

interface NotesStore {
  screen: AppScreen;
  isReady: boolean;
  mnemonic: string | null;
  notes: NoteData[];
  isEncrypting: boolean;
  searchQuery: string;
  filteredNotes: NoteData[];
  arweave: ArweaveState;
  /** noteId → sync info, refreshed together with the aggregate counters. */
  syncStatuses: Record<string, NoteSyncInfo>;
  restoring: boolean;
  /** Live progress of the current restore sweep (payloads settled / total). */
  restoreProgress: { done: number; total: number } | null;
  restoreError: string | null;
  /** How many notes the last completed restore recovered (null = no restore yet). */
  restoredCount: number | null;
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
      const text = await decrypt(key, enc);
      decrypted.push({ id: enc.noteId, text, createdAt: enc.createdAt });
      decryptedCount++;
    } catch {
      // Skip notes that can't be decrypted (wrong key or corrupted)
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
  // Mirror of `notes` for async flows (restore) that outlive the closure they
  // were created in — state captured there is stale.
  const notesRef = useRef<NoteData[]>([]);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const [restoreProgress, setRestoreProgress] = useState<{ done: number; total: number } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState<number | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [autoLockTimeout, setAutoLockTimeoutState] = useState<AutoLockTimeout>(null);

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
    // marker so the eventual return still measures the away-time.
    if (document.visibilityState === 'hidden') markHidden(sessionStorage, Date.now());

    const evaluateReturn = () => {
      const now = Date.now();
      const marker = consumeHiddenMarker(sessionStorage, now);
      if (decideLockOnReturn(autoLockTimeoutRef.current, hasPinRef.current, marker, now)) {
        lockApp();
      } else {
        // §8 self-heal: another tab may have changed the PIN/timeout while we
        // were hidden and frozen (missed broadcast).
        void selfHealPinConfig();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') markHidden(sessionStorage, Date.now());
      else evaluateReturn();
    };
    // pagehide refines the marker (earliest wins) — it also fires on
    // navigation away, where visibilitychange:hidden may not.
    const onPageHide = () => markHidden(sessionStorage, Date.now());
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
      const msg = e.data as { type?: unknown; originId?: unknown } | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.originId === tabIdRef.current) return; // never act on our own echo
      if (msg.type === 'lock') {
        lockApp({ broadcast: false }); // re-broadcasting would ping-pong forever
      } else if (msg.type === 'config') {
        void selfHealPinConfig();
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

  /** Re-read the PIN/auto-lock configuration from meta (shared IndexedDB) —
   *  the authoritative source after a 'config' broadcast or a return from
   *  background. Never throws: a storage hiccup keeps the current state. */
  async function selfHealPinConfig() {
    try {
      const pinData = await getMeta<PinEncryptedSeed>('pin-seed');
      applyHasPin(!!pinData);
      const rawTimeout = await getMeta<unknown>('auto-lock-timeout');
      applyAutoLockTimeout(isValidAutoLockTimeout(rawTimeout) ? rawTimeout : null);
    } catch {
      // storage not ready / broken — the periodic paths will retry
    }
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

      // 3. Check for PIN-encrypted seed + auto-lock config
      const pinData = await getMeta<PinEncryptedSeed>('pin-seed');
      if (pinData) applyHasPin(true);
      const rawTimeout = await getMeta<unknown>('auto-lock-timeout');
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
    setRestoreProgress(null);

    // Upload queue: drop queued work; the RUNNING processor (if any) exits on
    // its own via the generation check and must keep ownership of
    // isProcessingRef until it really finishes (§7).
    uploadQueueRef.current = [];
    queuedIdsRef.current.clear();

    // Session seed + any LEGACY plaintext draft go now; the encrypted draft
    // envelope is exactly what at-rest protection is for — it stays (§2).
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    dropLegacyPlaintextDraft(sessionStorage);
  }

  /** Lock the vault NOW. Fully synchronous (§3): epoch bump → abort in-flight
   *  vault op → wipe state → PIN screen → (optionally) tell the other tabs. */
  const lockApp = useCallback((opts: { broadcast?: boolean } = {}) => {
    // Nothing to lock without an open vault or a live session in this tab —
    // a foreign 'lock' broadcast may arrive while we sit on landing/restore.
    const hasVault = cryptoKeyRef.current !== null
      || sessionStorage.getItem(SESSION_STORAGE_KEY) !== null;
    if (!hasVault) return;

    vaultEpochRef.current++;
    queueGenerationRef.current++;
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = null;
    clearVaultState();
    // Without a PIN there is nothing to unlock against — seed re-entry it is.
    setScreen(hasPinRef.current ? 'pin' : 'restore');
    if (opts.broadcast !== false) postVaultMessage('lock');
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

    let accepted = 0, confirmed = 0, errors = 0;
    for (const r of allSync) {
      if (r.status === 'accepted') accepted++;
      else if (r.status === 'confirmed') confirmed++;
      else if (r.status === 'error') errors++;
    }

    const unsynced = allNotes.length - accepted - confirmed;

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

    const outcome = await runUploadAttempt(
      note,
      { signingKey: sk, ownerHash: oh, publicKey: pk },
      myEpoch,
      {
        now: () => Date.now(),
        currentEpoch: () => vaultEpochRef.current,
        getSyncRecord,
        setSyncRecord,
        signPayload,
        uploadViaProxy,
      },
    );
    if (outcome.kind === 'cancelled') return 'cancelled';
    const result = outcome.result;

    // React state + registration meta — ONLY under the current epoch. The
    // sync record itself was already persisted unconditionally above.
    if (vaultEpochRef.current === myEpoch) {
      if (result.kind === 'accepted') {
        // Auto-discovery
        const pkB64 = bufferToBase64(pk);
        if (!(await getMeta<boolean>(`registered:${pkB64}`))) {
          await setMeta(`registered:${pkB64}`, true);
          setArweave(prev => ({ ...prev, registered: true }));
        }
        setArweave(prev => ({ ...prev, lastSync: Date.now() }));
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

    // Skip: accepted-and-not-flagged + confirmed + fresh uploading (< 10 min) +
    //       recheck notes still within their backoff window.
    // Enqueue: error, accepted+needsRecheck past backoff, stale uploading, no record
    const skipIds = new Set(
      allSync.filter(r =>
        (r.status === 'accepted' && !r.needsRecheck) ||
        (r.status === 'accepted' && r.needsRecheck && (now - r.updatedAt) < RECHECK_BACKOFF_MS) ||
        r.status === 'confirmed' ||
        (r.status === 'uploading' && (now - r.updatedAt) < STALE_UPLOADING_MS)
      ).map(r => r.noteId)
    );
    const pending = allNotes.filter(n => !skipIds.has(n.noteId));
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
    setRestoreProgress(null);
    try {
      // fetchAllNotes decrypts + validates (v1/v2) and drops any TX not signed
      // by a trusted owner or that fails to decrypt.
      const { notes: remoteNotes, incomplete } = await fetchAllNotes(
        ownerHashRef.current,
        key,
        (done, total) => {
          if (vaultEpochRef.current === myEpoch) setRestoreProgress({ done, total });
        },
        { signal: abort.signal },
      );
      if (vaultEpochRef.current !== myEpoch) return; // locked mid-sweep — publish nothing
      let restoredCount = 0;

      // Snapshot of what the user can currently SEE (decrypted notes; the DB
      // may hold corrupted-invisible ones). A LOCAL set — extended as we add —
      // keeps restoredCount exact even though notesRef only catches up after a
      // render, and «Восстановлено N» never counts an already-visible note.
      const visibleIds = new Set(notesRef.current.map(n => n.id));
      for (const remote of remoteNotes) {
        if (vaultEpochRef.current !== myEpoch) return; // locked — stop merging
        // Upsert the note payload + confirmed sync state atomically. The
        // payload write matters even for an already-confirmed note: the local
        // ciphertext may be corrupted while the on-chain copy just decrypted.
        await mergeRestoredNote(remote.encrypted, remote.txId, Date.now());

        if (!claimRestoredForUi(visibleIds, remote.encrypted.noteId)) continue;
        if (vaultEpochRef.current !== myEpoch) return;
        setNotes(prev =>
          prev.some(n => n.id === remote.encrypted.noteId)
            ? prev
            : [...prev, { id: remote.encrypted.noteId, text: remote.text, createdAt: remote.encrypted.createdAt }]
                .sort((a, b) => b.createdAt - a.createdAt)
        );
        restoredCount++;
      }

      if (remoteNotes.length > 0) {
        await refreshSyncCounts(myEpoch);
      }
      if (vaultEpochRef.current !== myEpoch) return;
      setRestoredCount(restoredCount);
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
  }, []);

  const dismissError = useCallback(() => {
    setArweave(prev => ({ ...prev, lastError: null }));
  }, []);

  const addNote = useCallback(async (text: string) => {
    if (!readyRef.current || !cryptoKeyRef.current || !text.trim()) return;

    setIsEncrypting(true);
    try {
      const encrypted = await encrypt(cryptoKeyRef.current, text.trim());
      await saveNote(encrypted);

      const note: NoteData = {
        id: encrypted.noteId,
        text: text.trim(),
        createdAt: encrypted.createdAt,
      };
      setNotes(prev => [note, ...prev]);

      // ── The note is SAVED from here on. Nothing below may reject: a failing
      //    secondary read would otherwise make the UI report «не удалось
      //    сохранить» for a note that is already on disk, and a retry would
      //    create a duplicate.
      try {
        if (arweaveRef.current.enabled) {
          enqueueUpload(encrypted); // sync is best-effort; the note is safe
        }
        await refreshSyncCounts(vaultEpochRef.current);
      } catch (err) {
        console.error('post-save bookkeeping failed (note IS saved):', err);
      }
    } finally {
      setIsEncrypting(false);
    }
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
    // 1. IndexedDB — all stores
    await resetAll();

    // 2. Invalidate every in-flight flow exactly like a lock would.
    vaultEpochRef.current++;
    queueGenerationRef.current++;
    vaultOpAbortRef.current?.abort();
    vaultOpAbortRef.current = null;

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
    applyHasPin(true);
    postVaultMessage('config'); // other tabs re-read pin-seed/timeout
  }, [mnemonic]);

  /** Shared by manual PIN removal AND the 10-strike wipe (§8): ONE atomic meta
   *  transaction (pin-seed + attempts + lockout + auto-lock-timeout→null);
   *  React state and the config broadcast follow ONLY after the commit — an
   *  error mid-cleanup leaves the configuration fully intact, never partial. */
  async function clearPinConfiguration(): Promise<void> {
    await clearPinConfigMeta();
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
    applyAutoLockTimeout(t);
    postVaultMessage('config');
  }, []);

  const lockAppAction = useCallback(() => lockApp(), [lockApp]);

  // ─── Search ─────────────────────────────────────────────────────────

  const filteredNotes = searchQuery.trim()
    ? notes.filter(n =>
        n.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : notes;

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
    arweave: arweaveState,
    syncStatuses,
    restoring,
    restoreProgress,
    restoreError,
    restoredCount,
    vaultError,
    hasPin,
    autoLockTimeout,
    bootError,

    createNewWallet,
    confirmMnemonic,
    restoreFromMnemonic,
    addNote,
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
    arweaveState, syncStatuses, restoring, restoreProgress, restoreError,
    restoredCount, vaultError, hasPin, autoLockTimeout, bootError,
    createNewWallet, confirmMnemonic, restoreFromMnemonic, addNote,
    goToRestore, goToOnboarding, goToLanding, showMnemonic, resetApp,
    toggleArweave, retrySync, registerWithInviteAction, checkAccessAction,
    setupPinAction, removePinAction, unlockWithPinAction, getPinLockState,
    setAutoLockTimeoutAction, lockAppAction, persistDraftAction,
    readDraftAction, clearDraftAction,
    resetBrokenStorage, retryRestore, clearRestoreStatus, dismissError,
  ]);

  return (
    <StoreContext.Provider value={value}>
      {children}
    </StoreContext.Provider>
  );
}

export function useNotes(): NotesStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useNotes must be inside NotesProvider');
  return ctx;
}
