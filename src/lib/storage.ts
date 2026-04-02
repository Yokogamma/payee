/**
 * Eternal Notes — IndexedDB Persistence Module
 *
 * Single source of truth for all persistent data.
 * Replaces localStorage for notes/sync/meta.
 *
 * Schema: DB "eternal-notes", version 1
 *   - notes: { noteId (PK), ciphertext, iv, createdAt } + index by-timestamp
 *   - sync:  { noteId (PK), txId?, status, transport, lastError?, updatedAt } + index by-status
 *   - meta:  { key (PK), value }
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { EncryptedNote } from './crypto';

// ─── Types ───────────────────────────────────────────────────────────

export interface SyncRecord {
  noteId: string;
  txId?: string;
  /** 'uploading' with updatedAt > 10 min = stale → retryable */
  status: 'uploading' | 'accepted' | 'error';
  transport: 'proxy';
  lastError?: string;
  updatedAt: number;
}

// ─── Database ────────────────────────────────────────────────────────

const DB_NAME = 'eternal-notes';
const DB_VERSION = 1;

let db: IDBPDatabase | null = null;

export async function initStorage(): Promise<void> {
  if (db) return;

  db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Notes store
      const notesStore = database.createObjectStore('notes', { keyPath: 'noteId' });
      notesStore.createIndex('by-timestamp', 'createdAt');

      // Sync state store
      const syncStore = database.createObjectStore('sync', { keyPath: 'noteId' });
      syncStore.createIndex('by-status', 'status');

      // Meta KV store
      database.createObjectStore('meta');
    },
  });

  // Run migration from localStorage (idempotent)
  await migrateFromLocalStorage();
}

export function closeStorage(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function getDB(): IDBPDatabase {
  if (!db) throw new Error('Storage not initialized. Call initStorage() first.');
  return db;
}

// ─── Notes ───────────────────────────────────────────────────────────

export async function saveNote(note: EncryptedNote): Promise<void> {
  await getDB().put('notes', note);
}

export async function saveNotes(notes: EncryptedNote[]): Promise<void> {
  const tx = getDB().transaction('notes', 'readwrite');
  for (const note of notes) {
    await tx.store.put(note);
  }
  await tx.done;
}

/** Get all notes sorted by createdAt DESC (newest first) */
export async function getAllNotes(): Promise<EncryptedNote[]> {
  const all = await getDB().getAllFromIndex('notes', 'by-timestamp');
  return all.reverse() as EncryptedNote[];
}

export async function getNoteById(noteId: string): Promise<EncryptedNote | undefined> {
  return getDB().get('notes', noteId) as Promise<EncryptedNote | undefined>;
}

export async function clearNotes(): Promise<void> {
  await getDB().clear('notes');
}

// ─── Sync Records ────────────────────────────────────────────────────

export async function getSyncRecord(noteId: string): Promise<SyncRecord | undefined> {
  return getDB().get('sync', noteId) as Promise<SyncRecord | undefined>;
}

export async function setSyncRecord(record: SyncRecord): Promise<void> {
  await getDB().put('sync', record);
}

export async function getRecordsByStatus(status: SyncRecord['status']): Promise<SyncRecord[]> {
  return getDB().getAllFromIndex('sync', 'by-status', status) as Promise<SyncRecord[]>;
}

export async function getAllSyncRecords(): Promise<SyncRecord[]> {
  return getDB().getAll('sync') as Promise<SyncRecord[]>;
}

export async function clearSyncRecords(): Promise<void> {
  await getDB().clear('sync');
}

// ─── Meta ────────────────────────────────────────────────────────────

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return getDB().get('meta', key) as Promise<T | undefined>;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await getDB().put('meta', value, key);
}

export async function deleteMeta(key: string): Promise<void> {
  await getDB().delete('meta', key);
}

// ─── Migration from localStorage ────────────────────────────────────

/**
 * One-time idempotent migration from localStorage to IndexedDB.
 *
 * Sync state is NOT migrated (see comments below for rationale).
 * All migrated notes get new noteIds (crypto.randomUUID).
 */
async function migrateFromLocalStorage(): Promise<{ notesMigrated: number }> {
  const database = getDB();

  // 1. Check migration marker
  const migrated = await database.get('meta', 'migration-v1-done');
  if (migrated) return { notesMigrated: 0 };

  // 2. Read from localStorage
  const raw = localStorage.getItem('eternal-notes-encrypted');
  if (!raw) {
    await database.put('meta', true, 'migration-v1-done');
    return { notesMigrated: 0 };
  }

  let oldNotes: Array<{
    ciphertext: string;
    iv: string;
    createdAt: number;
    hash?: string;
  }>;
  try {
    oldNotes = JSON.parse(raw);
  } catch {
    await database.put('meta', true, 'migration-v1-done');
    return { notesMigrated: 0 };
  }

  let count = 0;

  // 3. Write to IndexedDB in a single transaction
  const tx = database.transaction(['notes', 'meta'], 'readwrite');

  for (const n of oldNotes) {
    const noteId = crypto.randomUUID();
    // hash field is NOT migrated (R1). Only data needed for decrypt.
    const migratedNote: EncryptedNote = {
      noteId,
      ciphertext: n.ciphertext,
      iv: n.iv,
      createdAt: n.createdAt,
    };
    await tx.objectStore('notes').put(migratedNote);
    count++;
  }

  // 4. Migrate meta flags
  if (localStorage.getItem('eternal-notes-init') === 'true') {
    await tx.objectStore('meta').put(true, 'init');
  }
  if (localStorage.getItem('eternal-notes-ar-enabled') === 'true') {
    await tx.objectStore('meta').put(true, 'ar-enabled');
  }

  // 5. Sync state is NOT migrated.
  //    Reason: old notes were uploaded under old ownerHash = SHA-256(seed[32:64]),
  //    new ownerHash = SHA-256(Ed25519_publicKey). Old TX on chain are unreachable
  //    via new ownerHash (different GraphQL query).
  //    Leaving without SyncRecord = implicitly pending → will be re-uploaded via proxy.
  //    Cost: ~$0.001 per note. Old chain copies are harmless orphaned data.
  try {
    localStorage.removeItem('eternal-notes-ar-synced');
  } catch { /* skip */ }

  // 6. Write migration marker (same transaction)
  await tx.objectStore('meta').put(true, 'migration-v1-done');
  await tx.done;

  // 7. Clear localStorage ONLY after successful commit
  localStorage.removeItem('eternal-notes-encrypted');
  localStorage.removeItem('eternal-notes-init');
  localStorage.removeItem('eternal-notes-ar-enabled');
  localStorage.removeItem('eternal-notes-ar-synced');

  return { notesMigrated: count };
}

// ─── Reset ───────────────────────────────────────────────────────────

/** Clear ALL IndexedDB data (notes, sync, meta). Used for app reset. */
export async function resetAll(): Promise<void> {
  const database = getDB();
  const tx = database.transaction(['notes', 'sync', 'meta'], 'readwrite');
  await tx.objectStore('notes').clear();
  await tx.objectStore('sync').clear();
  await tx.objectStore('meta').clear();
  await tx.done;
}
