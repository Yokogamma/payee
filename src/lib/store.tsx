/**
 * Eternal Notes — App Store (React Context)
 *
 * Управляет: ключ шифрования, список заметок, Arweave sync
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  generateMnemonic,
  isValidMnemonic,
  deriveKey,
  deriveOwnerHash,
  encrypt,
  decrypt,
  saveToLocal,
  loadFromLocal,
  isInitialized,
  markInitialized,
  clearLocal,
  type EncryptedNote,
  type NoteData,
} from './crypto';
import {
  getWalletFromSeed,
  getWalletAddress,
  getWalletBalance,
  uploadNote as arweaveUpload,
  fetchNotes as arweaveFetch,
  isArweaveOnline,
} from './arweave';

// ─── Types ───────────────────────────────────────────────────────────

type AppScreen = 'loading' | 'onboarding' | 'restore' | 'main';

interface ArweaveState {
  enabled: boolean;
  online: boolean;
  syncing: boolean;
  walletAddress: string | null;
  balance: string | null;
  pendingUploads: number;
  lastSync: number | null;
  error: string | null;
}

interface NotesStore {
  screen: AppScreen;
  mnemonic: string | null;
  notes: NoteData[];
  isEncrypting: boolean;
  searchQuery: string;
  filteredNotes: NoteData[];
  arweave: ArweaveState;

  // Actions
  createNewWallet: () => Promise<string>;
  confirmMnemonic: (mnemonic: string) => Promise<void>;
  restoreFromMnemonic: (mnemonic: string) => Promise<void>;
  addNote: (text: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  goToRestore: () => void;
  goToOnboarding: () => void;
  showMnemonic: () => string | null;
  resetApp: () => void;
  syncToArweave: () => Promise<void>;
  restoreFromArweave: () => Promise<void>;
  toggleArweave: () => void;
}

const StoreContext = createContext<NotesStore | null>(null);

// ─── Local storage for Arweave config ────────────────────────────────

const AR_ENABLED_KEY = 'eternal-notes-ar-enabled';
const AR_SYNCED_HASHES_KEY = 'eternal-notes-ar-synced';

function getArweaveEnabled(): boolean {
  return localStorage.getItem(AR_ENABLED_KEY) === 'true';
}

function setArweaveEnabled(v: boolean): void {
  localStorage.setItem(AR_ENABLED_KEY, v ? 'true' : 'false');
}

function getSyncedHashes(): Set<string> {
  try {
    const data = localStorage.getItem(AR_SYNCED_HASHES_KEY);
    return data ? new Set(JSON.parse(data)) : new Set();
  } catch { return new Set(); }
}

function addSyncedHash(hash: string): void {
  const hashes = getSyncedHashes();
  hashes.add(hash);
  localStorage.setItem(AR_SYNCED_HASHES_KEY, JSON.stringify([...hashes]));
}

// ─── Provider ────────────────────────────────────────────────────────

export function NotesProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<AppScreen>('loading');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [encryptedNotes, setEncryptedNotes] = useState<EncryptedNote[]>([]);
  const [notes, setNotes] = useState<NoteData[]>([]);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [arweave, setArweave] = useState<ArweaveState>({
    enabled: getArweaveEnabled(),
    online: false,
    syncing: false,
    walletAddress: null,
    balance: null,
    pendingUploads: 0,
    lastSync: null,
    error: null,
  });

  const ownerHashRef = useRef<string | null>(null);

  // ─── Init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (isInitialized()) {
      const storedMnemonic = sessionStorage.getItem('eternal-notes-session');
      if (storedMnemonic) {
        restoreSession(storedMnemonic);
      } else {
        setScreen('restore');
      }
    } else {
      setScreen('onboarding');
    }
  }, []);

  async function restoreSession(mn: string) {
    try {
      const key = await deriveKey(mn);
      setCryptoKey(key);
      setMnemonic(mn);
      ownerHashRef.current = await deriveOwnerHash(mn);
      await decryptAllNotes(key);
      setScreen('main');
      // Init Arweave in background
      initArweave(mn);
    } catch {
      setScreen('restore');
    }
  }

  async function initArweave(mn: string) {
    try {
      const online = await isArweaveOnline();
      const wallet = await getWalletFromSeed(mn);
      const address = await getWalletAddress(wallet);
      let balance: string | null = null;

      if (online) {
        try {
          balance = await getWalletBalance(wallet);
        } catch { /* ignore */ }
      }

      // Count pending uploads
      const synced = getSyncedHashes();
      const local = loadFromLocal();
      const pending = local.filter(n => !synced.has(n.hash)).length;

      setArweave(prev => ({
        ...prev,
        online,
        walletAddress: address,
        balance,
        pendingUploads: pending,
      }));
    } catch (err) {
      console.warn('Arweave init failed:', err);
    }
  }

  async function decryptAllNotes(key: CryptoKey) {
    const encrypted = loadFromLocal();
    setEncryptedNotes(encrypted);

    const decrypted: NoteData[] = [];
    for (const enc of encrypted) {
      try {
        const text = await decrypt(key, enc);
        decrypted.push({
          id: enc.hash,
          text,
          createdAt: enc.createdAt,
        });
      } catch {
        console.warn('Failed to decrypt note, skipping');
      }
    }
    decrypted.sort((a, b) => b.createdAt - a.createdAt);
    setNotes(decrypted);
  }

  // ─── Actions ─────────────────────────────────────────────────────

  const createNewWallet = useCallback(async (): Promise<string> => {
    const mn = generateMnemonic();
    setMnemonic(mn);
    return mn;
  }, []);

  const confirmMnemonic = useCallback(async (mn: string) => {
    const key = await deriveKey(mn);
    setCryptoKey(key);
    setMnemonic(mn);
    ownerHashRef.current = await deriveOwnerHash(mn);
    sessionStorage.setItem('eternal-notes-session', mn);
    markInitialized();
    setScreen('main');
    initArweave(mn);
  }, []);

  const restoreFromMnemonic = useCallback(async (mn: string) => {
    if (!isValidMnemonic(mn)) {
      throw new Error('Invalid mnemonic phrase');
    }
    const key = await deriveKey(mn);
    setCryptoKey(key);
    setMnemonic(mn);
    ownerHashRef.current = await deriveOwnerHash(mn);
    sessionStorage.setItem('eternal-notes-session', mn);
    markInitialized();
    await decryptAllNotes(key);
    setScreen('main');
    initArweave(mn);
  }, []);

  const addNote = useCallback(async (text: string) => {
    if (!cryptoKey || !text.trim()) return;

    setIsEncrypting(true);
    try {
      const encrypted = await encrypt(cryptoKey, text.trim());

      // Save locally
      const updated = [encrypted, ...encryptedNotes];
      setEncryptedNotes(updated);
      saveToLocal(updated);

      // Add to decrypted list
      const note: NoteData = {
        id: encrypted.hash,
        text: text.trim(),
        createdAt: encrypted.createdAt,
      };
      setNotes(prev => [note, ...prev]);

      // Upload to Arweave in background if enabled
      if (arweave.enabled && mnemonic && ownerHashRef.current) {
        setArweave(prev => ({ ...prev, pendingUploads: prev.pendingUploads + 1 }));
        uploadInBackground(encrypted);
      }
    } finally {
      setIsEncrypting(false);
    }
  }, [cryptoKey, encryptedNotes, arweave.enabled, mnemonic]);

  async function uploadInBackground(note: EncryptedNote) {
    if (!mnemonic || !ownerHashRef.current) return;
    try {
      const wallet = await getWalletFromSeed(mnemonic);
      const result = await arweaveUpload(wallet, ownerHashRef.current, note);
      if (result.status === 'uploaded') {
        addSyncedHash(note.hash);
        setArweave(prev => ({
          ...prev,
          pendingUploads: Math.max(0, prev.pendingUploads - 1),
          lastSync: Date.now(),
          error: null,
        }));
      } else {
        setArweave(prev => ({
          ...prev,
          error: result.error || 'Upload failed',
        }));
      }
    } catch (err) {
      setArweave(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Upload error',
      }));
    }
  }

  // ─── Arweave Sync ───────────────────────────────────────────────

  const syncToArweave = useCallback(async () => {
    if (!mnemonic || !ownerHashRef.current) return;

    setArweave(prev => ({ ...prev, syncing: true, error: null }));

    try {
      const wallet = await getWalletFromSeed(mnemonic);
      const synced = getSyncedHashes();
      const unsynced = encryptedNotes.filter(n => !synced.has(n.hash));

      let uploaded = 0;
      for (const note of unsynced) {
        const result = await arweaveUpload(wallet, ownerHashRef.current!, note);
        if (result.status === 'uploaded') {
          addSyncedHash(note.hash);
          uploaded++;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Refresh balance
      try {
        const balance = await getWalletBalance(wallet);
        setArweave(prev => ({
          ...prev,
          balance,
          pendingUploads: 0,
          lastSync: Date.now(),
          syncing: false,
          error: uploaded < unsynced.length
            ? `Загружено ${uploaded} из ${unsynced.length}. Проверьте баланс.`
            : null,
        }));
      } catch {
        setArweave(prev => ({ ...prev, syncing: false }));
      }
    } catch (err) {
      setArweave(prev => ({
        ...prev,
        syncing: false,
        error: err instanceof Error ? err.message : 'Sync error',
      }));
    }
  }, [mnemonic, encryptedNotes]);

  const restoreFromArweave = useCallback(async () => {
    if (!mnemonic || !cryptoKey) return;

    setArweave(prev => ({ ...prev, syncing: true, error: null }));

    try {
      const oh = await deriveOwnerHash(mnemonic);
      const remoteNotes = await arweaveFetch(oh);

      if (remoteNotes.length === 0) {
        setArweave(prev => ({
          ...prev,
          syncing: false,
          error: 'Заметки не найдены в Arweave',
        }));
        return;
      }

      // Merge with local (dedup by hash)
      const localHashes = new Set(encryptedNotes.map(n => n.hash));
      const newNotes = remoteNotes.filter(n => !localHashes.has(n.hash));

      if (newNotes.length > 0) {
        const merged = [...encryptedNotes, ...newNotes];
        setEncryptedNotes(merged);
        saveToLocal(merged);

        // Decrypt new notes
        for (const enc of newNotes) {
          try {
            const text = await decrypt(cryptoKey, enc);
            setNotes(prev => [...prev, { id: enc.hash, text, createdAt: enc.createdAt }]
              .sort((a, b) => b.createdAt - a.createdAt));
          } catch { /* skip */ }
        }

        // Mark as synced
        newNotes.forEach(n => addSyncedHash(n.hash));
      }

      setArweave(prev => ({
        ...prev,
        syncing: false,
        lastSync: Date.now(),
        error: null,
      }));
    } catch (err) {
      setArweave(prev => ({
        ...prev,
        syncing: false,
        error: err instanceof Error ? err.message : 'Restore error',
      }));
    }
  }, [mnemonic, cryptoKey, encryptedNotes]);

  const toggleArweave = useCallback(() => {
    setArweave(prev => {
      const next = !prev.enabled;
      setArweaveEnabled(next);
      return { ...prev, enabled: next };
    });
  }, []);

  const goToRestore = useCallback(() => setScreen('restore'), []);
  const goToOnboarding = useCallback(() => setScreen('onboarding'), []);
  const showMnemonic = useCallback(() => mnemonic, [mnemonic]);

  const resetApp = useCallback(() => {
    clearLocal();
    sessionStorage.removeItem('eternal-notes-session');
    localStorage.removeItem(AR_ENABLED_KEY);
    localStorage.removeItem(AR_SYNCED_HASHES_KEY);
    setMnemonic(null);
    setCryptoKey(null);
    setNotes([]);
    setEncryptedNotes([]);
    setScreen('onboarding');
  }, []);

  // ─── Search ──────────────────────────────────────────────────────

  const filteredNotes = searchQuery.trim()
    ? notes.filter(n =>
        n.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : notes;

  // ─── Value ───────────────────────────────────────────────────────

  const value: NotesStore = {
    screen,
    mnemonic,
    notes,
    isEncrypting,
    searchQuery,
    filteredNotes,
    arweave,
    createNewWallet,
    confirmMnemonic,
    restoreFromMnemonic,
    addNote,
    setSearchQuery,
    goToRestore,
    goToOnboarding,
    showMnemonic,
    resetApp,
    syncToArweave,
    restoreFromArweave,
    toggleArweave,
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
