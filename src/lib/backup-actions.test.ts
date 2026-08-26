// Node environment: pure crypto + JSON, no DOM. IndexedDB is not touched —
// the snapshot arrives through an injected dep, which is the point of the
// split.
import { describe, it, expect, vi } from 'vitest';
import {
  exportBackup,
  verifyBackupFile,
  BackupStoreTooLargeError,
  type BackupActionDeps,
  type BackupFileLike,
} from './backup-actions';
import { BACKUP_CAP_BYTES, decodeBackup, deriveBackupKey } from './backup';
import {
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  encryptEnvelopeV3,
  encryptSafeboxEntry,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
} from './crypto';
import type { BackupSnapshotResult } from './storage';

/**
 * The two read-only actions, against REAL crypto.
 *
 * The property this file exists to defend, beyond «does it work»: the dry-run
 * decrypts every secret the vault holds, and none of it may appear in what the
 * dry-run returns. That is asserted by searching the report for the actual
 * secret VALUES — not by checking which fields exist, because a leak arrives
 * through a helpful new diagnostic field, and a field-name check would wave it
 * through.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_756_000_000_000;

// Distinctive enough to find anywhere in a serialized report.
const SECRETS = {
  noteText: 'SENTINEL-NOTE-TEXT-9f3a',
  title: 'SENTINEL-TITLE-4b21',
  login: 'SENTINEL-LOGIN-7c88',
  password: 'SENTINEL-PASSWORD-1d55',
  entryNote: 'SENTINEL-ENTRY-NOTE-6e02',
  attachment: 'SENTINEL-ATTACHMENT-BYTES-3a77',
};

async function vaultKeys() {
  return {
    note: await deriveKey(MNEMONIC),
    safeboxMeta: await deriveSafeboxMetaKey(MNEMONIC),
    safeboxSecret: await deriveSafeboxSecretKey(MNEMONIC),
    container: await deriveBackupKey(MNEMONIC),
  };
}

async function makeNote(text = SECRETS.noteText): Promise<EncryptedNote> {
  const key = await deriveKey(MNEMONIC);
  return encryptEnvelopeV3(key, text, { fmt: 'plain', rev: 1 });
}

async function makeEntry(): Promise<EncryptedSafeboxEntry> {
  const metaKey = await deriveSafeboxMetaKey(MNEMONIC);
  const secretKey = await deriveSafeboxSecretKey(MNEMONIC);
  return encryptSafeboxEntry(metaKey, secretKey, {
    title: SECRETS.title,
    login: SECRETS.login,
    url: 'https://example.invalid',
    note: SECRETS.entryNote,
    password: SECRETS.password,
    files: [{
      fid: 'cccccccc-dddd-4eee-8fff-000000000001',
      name: 'a.txt',
      mime: 'text/plain',
      size: SECRETS.attachment.length,
      data: btoa(SECRETS.attachment),
    }],
    rev: 1,
  });
}

async function makeDeps(over: Partial<BackupActionDeps> = {}): Promise<BackupActionDeps> {
  return {
    now: () => NOW,
    keys: await vaultKeys(),
    readSnapshot: async () => ({
      ok: true,
      snapshot: { notes: [], safebox: [], incompleteRestore: false },
    }) satisfies BackupSnapshotResult,
    sha256Hex: async (text: string) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    },
    assertAlive: () => {},
    ...over,
  };
}

const asFile = (text: string): BackupFileLike =>
  ({ size: new TextEncoder().encode(text).byteLength, text: async () => text });

describe('exportBackup', () => {
  it('produces a container the verifier accepts, with a dated name and a SHA', async () => {
    const note = await makeNote();
    const entry = await makeEntry();
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [note], safebox: [entry], incompleteRestore: false } }),
    });

    const exported = await exportBackup(deps);

    expect(exported.fileName).toMatch(/^eternal-notes-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(exported.artifact.createdAt).toBe(NOW);
    expect(exported.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    const report = await verifyBackupFile(deps, asFile(exported.text));
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ notes: 1, safebox: 1 });
  });

  it('never decrypts anything — the ciphertext is copied as it lies', async () => {
    // Which is also why an export needs no PIN and no unlocked safebox. If a
    // key were ever used here, this spy would see it.
    const digest = vi.spyOn(crypto.subtle, 'decrypt');
    const note = await makeNote();
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [note], safebox: [], incompleteRestore: false } }),
    });

    await exportBackup(deps);

    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  it('marks the container when a record is of a version this build cannot read', async () => {
    const opaque = { ...(await makeNote()), v: 9 } as unknown as EncryptedNote;
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [opaque], safebox: [], incompleteRestore: false } }),
    });

    const exported = await exportBackup(deps);

    const { header } = await decodeBackup(exported.text, deps.keys.container);
    expect(header.containsUnsupportedRecords).toBe(true);
  });

  it('carries the incompleteRestore marker through into the body', async () => {
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [], safebox: [], incompleteRestore: true } }),
    });

    const exported = await exportBackup(deps);

    const { body } = await decodeBackup(exported.text, deps.keys.container);
    expect(body.incompleteRestore).toBe(true);
  });

  it('a store past the cap fails as a fact about the DEVICE, not about a file', async () => {
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: false, reason: 'over_cap', readBytes: 99_000_000 }),
    });

    await expect(exportBackup(deps)).rejects.toBeInstanceOf(BackupStoreTooLargeError);
  });

  it('a cancelled vault stops the export', async () => {
    const boom = new Error('locked');
    const deps = await makeDeps({ assertAlive: () => { throw boom; } });
    await expect(exportBackup(deps)).rejects.toBe(boom);
  });
});

describe('verifyBackupFile — the verdict', () => {
  async function exportOf(notes: EncryptedNote[], safebox: EncryptedSafeboxEntry[], incompleteRestore = false) {
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes, safebox, incompleteRestore } }),
    });
    return { deps, exported: await exportBackup(deps) };
  }

  it('decrypts BOTH halves of a safebox entry, not just the meta', async () => {
    // A container whose meta opens and whose secret does not restores an entry
    // with no password in it — and the user finds out at the worst moment.
    const entry = await makeEntry();
    const { deps, exported } = await exportOf([], [entry]);
    const parsed = JSON.parse(exported.text) as Record<string, unknown>;

    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    await verifyBackupFile(deps, asFile(JSON.stringify(parsed)));
    // container + meta half + secret half + the attachment's own blob
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    spy.mockRestore();
  });

  it('a damaged record is reported as undecryptable, and the file is not green', async () => {
    const note = await makeNote();
    const damaged = { ...note, ciphertext: `${note.ciphertext.slice(0, -4)}AAAA` };
    const { deps, exported } = await exportOf([damaged], []);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([{ kind: 'note', id: damaged.noteId, problem: 'undecryptable' }]);
  });

  it('a version this build cannot read is «unsupported», never «damaged»', async () => {
    // The two lead to opposite advice — keep the file vs replace it — so they
    // are decided by the declared version, not by which error a decrypt threw.
    const opaque = { ...(await makeNote()), v: 9 } as unknown as EncryptedNote;
    const { deps, exported } = await exportOf([opaque], []);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    expect(report.issues).toEqual([{ kind: 'note', id: opaque.noteId, problem: 'unsupported_version' }]);
    expect(report.containsUnsupportedRecords).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('«intact» and «complete» are separate: an incomplete file is never green', async () => {
    const note = await makeNote();
    const { deps, exported } = await exportOf([note], [], true);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    expect(report.issues).toEqual([]);        // nothing is wrong with the bytes
    expect(report.incompleteRestore).toBe(true);
    expect(report.ok).toBe(false);            // ...and it still is not a backup
  });

  it('a broken chain is reported without a single record being unreadable', async () => {
    const key = await deriveKey(MNEMONIC);
    const orphan = await encryptEnvelopeV3(key, 'v2 of a chain whose v1 is absent', {
      fmt: 'plain', rev: 2, root: 'aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee', prev: 'aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee',
    });
    const { deps, exported } = await exportOf([orphan], []);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    expect(report.ok).toBe(false);
    expect(report.issues.every(i => i.problem === 'chain')).toBe(true);
  });

  it('refuses a file past the cap BEFORE reading its contents', async () => {
    const deps = await makeDeps();
    const read = vi.fn(async () => '{}');

    await expect(verifyBackupFile(deps, { size: BACKUP_CAP_BYTES + 1, text: read }))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(read).not.toHaveBeenCalled();
  });

  it('a file made with a different seed is undecryptable, not «corrupt»', async () => {
    const { exported } = await exportOf([await makeNote()], []);
    const stranger = await makeDeps({
      keys: { ...(await vaultKeys()), container: await deriveBackupKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong') },
    });

    await expect(verifyBackupFile(stranger, asFile(exported.text)))
      .rejects.toMatchObject({ code: 'undecryptable' });
  });

  it('a header claiming everything is supported while it is not fails CLOSED', async () => {
    // The asymmetric check (D11a). The other direction — header `true`, reader
    // sees none — is normal and must NOT fail; that is the case below.
    const opaque = { ...(await makeNote()), v: 9 } as unknown as EncryptedNote;
    const deps = await makeDeps();
    const honest = await exportBackup(await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [opaque], safebox: [], incompleteRestore: false } }),
    }));
    // Re-encode with the flag flipped to false, authenticated properly.
    const forged = await forgeHeaderFlag(honest.text, deps.keys.container, false);

    await expect(verifyBackupFile(deps, asFile(forged))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('a header claiming unsupported records while this reader sees none is FINE', async () => {
    const deps = await makeDeps();
    const honest = await exportBackup(await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [await makeNote()], safebox: [], incompleteRestore: false } }),
    }));
    const forged = await forgeHeaderFlag(honest.text, deps.keys.container, true);

    const report = await verifyBackupFile(deps, asFile(forged));
    expect(report.ok).toBe(true); // a newer reader, and the warning simply drops
  });
});

describe('verifyBackupFile — no secret leaves the dry-run (D11)', () => {
  it('the report contains no plaintext, no password and no attachment bytes', async () => {
    const note = await makeNote();
    const entry = await makeEntry();
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [note], safebox: [entry], incompleteRestore: false } }),
    });
    const exported = await exportBackup(deps);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    // Serialize the WHOLE report and hunt for the actual values. A field-name
    // check would wave through the way a leak really arrives: a helpful new
    // diagnostic field.
    const serialized = JSON.stringify(report);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked into the report`).not.toContain(secret);
    }
    // The topology it IS allowed to carry proves the decryption really ran.
    expect(report.counts).toEqual({ notes: 1, safebox: 1 });
    expect(report.ok).toBe(true);
  });

  it('an error raised while decrypting carries no content either', async () => {
    const note = await makeNote();
    const damaged = { ...note, ciphertext: `${note.ciphertext.slice(0, -4)}AAAA` };
    const deps = await makeDeps({
      readSnapshot: async () => ({ ok: true, snapshot: { notes: [damaged], safebox: [], incompleteRestore: false } }),
    });
    const exported = await exportBackup(deps);

    const report = await verifyBackupFile(deps, asFile(exported.text));

    expect(JSON.stringify(report)).not.toContain(SECRETS.noteText);
    expect(report.issues[0]).toEqual({ kind: 'note', id: damaged.noteId, problem: 'undecryptable' });
  });
});

/** Re-encode a container with `containsUnsupportedRecords` flipped, keeping the
 *  AEAD honest — so the test exercises the reader's own check rather than a
 *  broken tag. */
async function forgeHeaderFlag(text: string, key: CryptoKey, flag: boolean): Promise<string> {
  const { body } = await decodeBackup(text, key);
  const original = JSON.parse(text) as { createdAt: number };
  const { encodeBackup } = await import('./backup');
  return encodeBackup({
    notes: body.notes,
    safebox: body.safebox,
    incompleteRestore: body.incompleteRestore,
    containsUnsupportedRecords: flag,
    createdAt: original.createdAt,
  }, key);
}
