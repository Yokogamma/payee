/* eslint-disable react-refresh/only-export-components */
/**
 * Eternal Notes — App Store (React Context)
 *
 * Manages: encryption key, notes, Arweave sync, registration, upload queue.
 * All persistence through IndexedDB (storage.ts). No localStorage.
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
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
  buildUploadPayload,
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
  resetAll,
  recoverStorage,
} from './storage';
import { toUploading, toAccepted, afterInProgress, afterFailure, afterPoll, claimRestoredForUi } from './sync-transitions';
import { userFacingUploadError } from './errors';

// ─── Types ───────────────────────────────────────────────────────────

export type AppScreen = 'loading' | 'landing' | 'onboarding' | 'restore' | 'pin' | 'main' | 'error';

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

  // Crypto refs (not React state — needed synchronously in async flows)
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  const ownerHashRef = useRef<string | null>(null);
  const signingKeyRef = useRef<Uint8Array | null>(null);
  const publicKeyRef = useRef<Uint8Array | null>(null);

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

      // 3. Check for PIN-encrypted seed
      const pinData = await getMeta<PinEncryptedSeed>('pin-seed');
      if (pinData) setHasPin(true);

      // 4. Check session (survives tab refresh but not browser close)
      const sessionMn = sessionStorage.getItem('eternal-notes-session');
      if (!sessionMn) {
        // No active session — show PIN screen if PIN is set, otherwise restore
        setScreen(pinData ? 'pin' : 'restore');
        return;
      }

      // 4. Restore session
      try {
        await setupFromMnemonic(sessionMn);

        // 5. Check registration
        await checkAndSetRegistration();
        setScreen('main');

        // 6. Auto-recover stale uploads (non-blocking, gated on enabled)
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

  // ─── Setup from mnemonic (shared for confirm/restore/session) ──────

  async function setupFromMnemonic(mn: string) {
    const key = await deriveKey(mn);
    const { privateKey, publicKey } = await deriveSigningKeypair(mn);
    const oh = await deriveOwnerHash(publicKey);
    const pkB64 = bufferToBase64(publicKey);

    // VAULT IDENTITY GUARD
    const savedVaultPK = await getMeta<string>('vault-public-key');
    if (savedVaultPK && savedVaultPK !== pkB64) {
      throw new VaultMismatchError(
        'На устройстве уже есть данные другого хранилища. ' +
        'Выполните «Сбросить приложение» перед восстановлением другого seed.'
      );
    }

    // Set refs
    cryptoKeyRef.current = key;
    setArweave(prev => ({ ...prev, registered: false }));
    setMnemonic(mn);
    ownerHashRef.current = oh;
    signingKeyRef.current = privateKey;
    publicKeyRef.current = publicKey;

    // Decrypt all notes, returns count of successfully decrypted
    const decryptedCount = await decryptAllNotes(key);

    // Legacy binding: if vault-public-key absent but notes exist,
    // only bind if at least one note decrypted successfully (proves ownership)
    const existingNotes = await getAllNotes();
    if (!savedVaultPK && existingNotes.length > 0 && decryptedCount === 0) {
      throw new VaultMismatchError(
        'Seed-фраза не подходит к существующим заметкам на устройстве. ' +
        'Введите правильный seed или выполните «Сбросить приложение».'
      );
    }
    await setMeta('vault-public-key', pkB64);

    // Restore persisted sync toggle
    const savedEnabled = !!(await getMeta<boolean>('ar-enabled'));
    setArweave({ enabled: savedEnabled });

    // Background: check Arweave + count sync state
    void initArweaveState().catch(err => console.error('initArweaveState:', err));
  }

  async function decryptAllNotes(key: CryptoKey): Promise<number> {
    const encrypted = await getAllNotes();
    const decrypted: NoteData[] = [];
    let count = 0;

    for (const enc of encrypted) {
      try {
        const text = await decrypt(key, enc);
        decrypted.push({
          id: enc.noteId,
          text,
          createdAt: enc.createdAt,
        });
        count++;
      } catch {
        // Skip notes that can't be decrypted (wrong key or corrupted)
      }
    }

    decrypted.sort((a, b) => b.createdAt - a.createdAt);
    setNotes(decrypted);
    // Mirror synchronously: a restore may start before React flushes the state
    // update above, and its visibility decisions must see THIS list.
    notesRef.current = decrypted;
    return count;
  }

  // ─── Arweave State ──────────────────────────────────────────────────

  async function initArweaveState() {
    const online = await isArweaveOnline();
    await refreshSyncCounts();
    setArweave(prev => ({ ...prev, online }));

    // If online + enabled + items queued → trigger queue
    if (online && arweaveRef.current.enabled && uploadQueueRef.current.length > 0) {
      kickQueue();
    }
  }

  async function refreshSyncCounts() {
    const allNotes = await getAllNotes();
    const allSync = await getAllSyncRecords();

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
      errorCount: errors,
    }));
  }

  // ─── Registration ───────────────────────────────────────────────────

  async function checkAndSetRegistration() {
    const publicKey = publicKeyRef.current;
    const signingKey = signingKeyRef.current;
    if (!publicKey || !signingKey) return;

    const publicKeyB64 = bufferToBase64(publicKey);
    const localRegistered = await getMeta<boolean>(`registered:${publicKeyB64}`);

    if (localRegistered) {
      setArweave(prev => ({ ...prev, registered: true }));
    } else {
      const checkPayload = JSON.stringify({ publicKey: publicKeyB64, timestamp: Date.now() });
      const checkSig = await signPayload(signingKey, checkPayload);
      const status = await checkRegistration(publicKeyB64, checkSig, checkPayload);

      if (status === 'allowed') {
        await setMeta(`registered:${publicKeyB64}`, true);
        setArweave(prev => ({ ...prev, registered: true }));
      } else if (status === 'invalid_request') {
        console.error('checkRegistration returned invalid_request — possible client bug');
      }
      // 'denied' → registered = false → show invite UI
      // 'unavailable' → don't change registered, user can retry
    }
  }

  // ─── Upload Queue ───────────────────────────────────────────────────

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

    isProcessingRef.current = true;
    setArweave(prev => ({ ...prev, syncing: true }));

    try {
      while (uploadQueueRef.current.length > 0) {
        if (!arweaveRef.current.enabled || !arweaveRef.current.online) break;

        const note = uploadQueueRef.current[0];
        const result = await uploadSingleNote(note);

        if (result === 'rate_limited') {
          setArweave(prev => ({ ...prev, lastError: userFacingUploadError('rate_limited') }));
          break;
        }
        if (result === 'not_registered') {
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
      isProcessingRef.current = false;
      setArweave(prev => ({ ...prev, syncing: false }));
    }
  }

  async function uploadSingleNote(note: EncryptedNote): Promise<string> {
    if (!ownerHashRef.current || !signingKeyRef.current || !publicKeyRef.current) return 'error';

    // A dropped/timed-out TX asks the server to re-verify + re-post (C1).
    const prev = await getSyncRecord(note.noteId);
    const recheck = prev?.needsRecheck === true;

    // All SyncRecord transitions are pure functions (sync-transitions.ts) so
    // the recovery-protocol invariants stay unit-tested.
    await setSyncRecord(toUploading(note.noteId, prev, Date.now()));

    // Build payload — serialized per the note's own version (v1 or v2), so a
    // restored v2 ciphertext can never be re-published under v1 tags. Recheck
    // reconciliation is server-authoritative; the only client-echoed value is a
    // server-SIGNED recovery hint (if any) from a prior triple-failure.
    const payload = buildUploadPayload(note, ownerHashRef.current, Date.now(), recheck, prev?.recovery);

    const bodyText = JSON.stringify(payload);
    const signature = await signPayload(signingKeyRef.current, bodyText);
    const publicKeyB64 = bufferToBase64(publicKeyRef.current);

    const result = await uploadViaProxy(bodyText, publicKeyB64, signature);

    if (result.kind === 'accepted') {
      await setSyncRecord(toAccepted(note.noteId, prev, result, Date.now()));
      // Auto-discovery
      const pkB64 = bufferToBase64(publicKeyRef.current!);
      if (!(await getMeta<boolean>(`registered:${pkB64}`))) {
        await setMeta(`registered:${pkB64}`, true);
        setArweave(prev => ({ ...prev, registered: true }));
      }
      setArweave(prev => ({ ...prev, lastSync: Date.now() }));
      await refreshSyncCounts();
      return 'accepted';
    }

    if (result.kind === 'in_progress') {
      // 409: a reservation is alive on the server (e.g. the pre-triple-failure
      // reserved slot still within its TTL). Restore the prior accepted state —
      // leaving the record 'uploading' would strand txId/recovery if the app
      // closes before the next attempt.
      const restored = afterInProgress(note.noteId, prev, Date.now());
      if (restored) await setSyncRecord(restored);
      await refreshSyncCounts();
      return 'in_progress';
    }

    // Any non-definitive outcome (unavailable/rate_limited/not_registered/error).
    // An already-accepted note keeps 'accepted' + txId + recovery and stays in
    // the recheck loop; only a never-accepted note becomes a hard 'error'.
    const errText = 'error' in result ? result.error : undefined;
    // L13: a clock-skew rejection looks like a permanent mystery to the user —
    // surface the actionable «проверьте время» toast instead of staying silent.
    if (errText && /timestamp|clock|skew/i.test(errText)) {
      setArweave(prev2 => ({ ...prev2, lastError: userFacingUploadError(result.kind, errText) }));
    }
    await setSyncRecord(afterFailure(note.noteId, prev, recheck, errText, Date.now()));
    await refreshSyncCounts();
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
    if (!arweaveRef.current.enabled || !arweaveRef.current.online) return;

    const accepted = await getRecordsByStatus('accepted');

    const now = Date.now();
    let changed = false;

    for (const record of accepted) {
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

    if (changed) await refreshSyncCounts();
    // Drain any ready work each cycle (recheck notes past their backoff).
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
    await setupFromMnemonic(mn);
    sessionStorage.setItem('eternal-notes-session', mn);
    await setMeta('init', true);
    await checkAndSetRegistration();
    setScreen('main');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restoreFromMnemonic = useCallback(async (mn: string) => {
    if (!isValidMnemonic(mn)) throw new Error('Invalid mnemonic');

    await setupFromMnemonic(mn);
    sessionStorage.setItem('eternal-notes-session', mn);
    await setMeta('init', true);

    await checkAndSetRegistration();
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

    // Auto-recover stale uploads (gated on enabled)
    if (arweaveRef.current.enabled) {
      void retryAllPending().catch(err => console.error('retryAllPending after restore:', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function restoreFromArweaveInternal() {
    const key = cryptoKeyRef.current;
    if (!key || !ownerHashRef.current) return;

    setRestoreError(null);
    setRestoredCount(null);
    setRestoreProgress(null);
    try {
      // fetchAllNotes decrypts + validates (v1/v2) and drops any TX not signed
      // by a trusted owner or that fails to decrypt.
      const { notes: remoteNotes, incomplete } = await fetchAllNotes(
        ownerHashRef.current,
        key,
        (done, total) => setRestoreProgress({ done, total }),
      );
      let restoredCount = 0;

      // Snapshot of what the user can currently SEE (decrypted notes; the DB
      // may hold corrupted-invisible ones). A LOCAL set — extended as we add —
      // keeps restoredCount exact even though notesRef only catches up after a
      // render, and «Восстановлено N» never counts an already-visible note.
      const visibleIds = new Set(notesRef.current.map(n => n.id));
      for (const remote of remoteNotes) {
        // Upsert the note payload + confirmed sync state atomically. The
        // payload write matters even for an already-confirmed note: the local
        // ciphertext may be corrupted while the on-chain copy just decrypted.
        await mergeRestoredNote(remote.encrypted, remote.txId, Date.now());

        if (!claimRestoredForUi(visibleIds, remote.encrypted.noteId)) continue;
        setNotes(prev =>
          prev.some(n => n.id === remote.encrypted.noteId)
            ? prev
            : [...prev, { id: remote.encrypted.noteId, text: remote.text, createdAt: remote.encrypted.createdAt }]
                .sort((a, b) => b.createdAt - a.createdAt)
        );
        restoredCount++;
      }

      if (remoteNotes.length > 0) {
        await refreshSyncCounts();
      }
      setRestoredCount(restoredCount);
      if (incomplete) {
        // Some pages/payloads were unreachable — a "quiet partial restore" must
        // not look like a full one (the user could believe notes are lost).
        setRestoreError('Восстановление прошло не полностью — часть заметок могла не загрузиться.');
      }
    } catch (err) {
      console.error('restoreFromArweave failed:', err);
      setRestoreError('Не удалось восстановить заметки из Arweave.');
    } finally {
      setRestoreProgress(null);
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

      // Enqueue upload if sync enabled
      if (arweaveRef.current.enabled) {
        enqueueUpload(encrypted);
      }

      await refreshSyncCounts();
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
      throw new Error(result.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAccessAction = useCallback(async () => {
    await checkAndSetRegistration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToRestore = useCallback(() => setScreen('restore'), []);
  const goToOnboarding = useCallback(() => setScreen('onboarding'), []);
  const goToLanding = useCallback(() => setScreen('landing'), []);
  const showMnemonic = useCallback(() => mnemonic, [mnemonic]);

  const resetApp = useCallback(async () => {
    // 1. IndexedDB — all stores
    await resetAll();

    // 2. sessionStorage — prevent bootstrap mnemonic loop
    sessionStorage.removeItem('eternal-notes-session');

    // 3. In-memory refs and state
    cryptoKeyRef.current = null;
    ownerHashRef.current = null;
    signingKeyRef.current = null;
    publicKeyRef.current = null;
    setArweave(INITIAL_ARWEAVE);
    setNotes([]);
    setMnemonic(null);
    setVaultError(null);
    setHasPin(false);

    // 4. Upload queue
    uploadQueueRef.current = [];
    queuedIdsRef.current.clear();
    isProcessingRef.current = false;

    // 5. Redirect
    setScreen('landing');
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
    // Success: clean boot from scratch.
    sessionStorage.removeItem('eternal-notes-session');
    window.location.reload();
  }, []);

  // ─── PIN Actions ────────────────────────────────────────────────────

  const setupPinAction = useCallback(async (pin: string) => {
    if (!mnemonic) return;
    const encrypted = await encryptWithPin(mnemonic, pin);
    await setMeta('pin-seed', encrypted);
    setHasPin(true);
  }, [mnemonic]);

  const removePinAction = useCallback(async () => {
    await deleteMeta('pin-seed');
    setHasPin(false);
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
        // Wipe PIN — require seed
        await deleteMeta('pin-seed');
        await deleteMeta('pin-attempts');
        await deleteMeta('pin-locked-until');
        setHasPin(false);
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

    await setupFromMnemonic(mn);
    sessionStorage.setItem('eternal-notes-session', mn);

    await checkAndSetRegistration();
    setScreen('main');

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

  // ─── Search ─────────────────────────────────────────────────────────

  const filteredNotes = searchQuery.trim()
    ? notes.filter(n =>
        n.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : notes;

  // ─── Context Value ──────────────────────────────────────────────────

  const value: NotesStore = {
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
    resetBrokenStorage,
    retryRestore,
    clearRestoreStatus,
    dismissError,
  };

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
