/**
 * Safebox — pure helpers (no React, no IndexedDB, no crypto side effects).
 *
 * The PATCH CONTRACT lives here (§6): editing an entry must never silently
 * erase a secret the user did not touch. The form submits explicit ACTIONS —
 * "keep this password", "replace that file" — and this module turns the
 * previous version's decrypted content plus those actions into the plaintext of
 * the NEW version. Absence of an action always means "carry the old value".
 */

import type {
  SafeboxAttachmentContent,
  SafeboxAttachmentDescriptor,
  SafeboxEntryData,
  SafeboxEntryInput,
  SafeboxSecretData,
} from './crypto';

/** One attachment as the form knows it before submission. */
export type SafeboxFileAction =
  /** Existing file, unchanged: carried over by fid (descriptor + content). */
  | { kind: 'keep'; fid: string }
  /** A NEW file (also how «заменить» is expressed — a replacement always mints
   *  a fresh fid, so a descriptor can never end up bound to another version's
   *  bytes). `data` is canonical base64 of the raw content. */
  | { kind: 'add'; fid: string; name: string; mime: string; size: number; data: string };

export interface SafeboxEntryPatch {
  title: string;
  login: string;
  url: string;
  note: string;
  /** Absent → keep the previous password verbatim. */
  password?: { kind: 'replace'; value: string };
  /** The COMPLETE new file list as actions. A previously-attached file that is
   *  simply missing from this array is removed. */
  files: SafeboxFileAction[];
}

export class SafeboxPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeboxPatchError';
  }
}

/**
 * Build the plaintext of the next version from the current one + the patch.
 * `rev`/`root`/`prev` are set by the caller from the chain head.
 */
export function applySafeboxPatch(
  current: { meta: SafeboxEntryData; secret: SafeboxSecretData },
  patch: SafeboxEntryPatch,
): Omit<SafeboxEntryInput, 'rev' | 'root' | 'prev'> {
  const oldDescriptors = new Map<string, SafeboxAttachmentDescriptor>(
    current.meta.files.map(f => [f.fid, f]),
  );
  const oldContents = new Map<string, SafeboxAttachmentContent>(
    current.secret.files.map(f => [f.fid, f]),
  );

  const files: SafeboxEntryInput['files'] = [];
  const seen = new Set<string>();
  for (const action of patch.files) {
    if (seen.has(action.fid)) throw new SafeboxPatchError('duplicate fid in patch');
    seen.add(action.fid);
    if (action.kind === 'keep') {
      const d = oldDescriptors.get(action.fid);
      const c = oldContents.get(action.fid);
      if (!d || !c) throw new SafeboxPatchError(`unknown fid kept: ${action.fid}`);
      files.push({ ...d, data: c.data });
    } else {
      files.push({
        fid: action.fid,
        name: action.name,
        mime: action.mime,
        size: action.size,
        data: action.data,
      });
    }
  }

  return {
    title: patch.title,
    login: patch.login,
    url: patch.url,
    note: patch.note,
    // NO explicit action ⇒ the previous secret is carried over. This is the
    // whole point of the patch contract: saving a form that never decrypted the
    // password must not wipe it.
    password: patch.password ? patch.password.value : current.secret.password,
    files,
  };
}

/** Turn a full version (meta + secret) into the plaintext of a NEW version with
 *  exactly the same content — «вернуть эту версию» restores the WHOLE entry
 *  (title/login/url/note/password/files), like a note version restore. */
export function snapshotSafeboxVersion(
  meta: SafeboxEntryData,
  secret: SafeboxSecretData,
): Omit<SafeboxEntryInput, 'rev' | 'root' | 'prev'> {
  const contents = new Map(secret.files.map(f => [f.fid, f.data]));
  return {
    title: meta.title,
    login: meta.login,
    url: meta.url,
    note: meta.note,
    password: secret.password,
    files: meta.files.map(d => {
      const data = contents.get(d.fid);
      if (data === undefined) throw new SafeboxPatchError(`missing content for ${d.fid}`);
      return { ...d, data };
    }),
  };
}

/** Search inside the unlocked safebox — NON-SECRET fields only. The password
 *  and attachment contents are not indexed, ever; attachment NAMES are not
 *  indexed either (the plan scopes search to title/login/url/note). */
export function matchesSafeboxQuery(entry: SafeboxEntryData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.title.toLowerCase().includes(q)
    || entry.login.toLowerCase().includes(q)
    || entry.url.toLowerCase().includes(q)
    || entry.note.toLowerCase().includes(q);
}
