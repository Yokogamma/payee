/**
 * Eternal Notes — the standalone backup viewer.
 *
 * This file becomes ONE self-contained HTML page with no network access of any
 * kind. It exists for the quadrant the app cannot reach: the project is gone,
 * the PWA is not installed, and all the user has left is a backup file, their
 * seed phrase, a browser, and this page saved beside the file.
 *
 * That is why it is deliberately small and boring. It cannot write to the
 * app's storage — a `file://` page has no access to the PWA's IndexedDB — so
 * it only ever reads. Restoring INTO the app is the app's import, offline.
 *
 * Rules that are not negotiable here:
 *  - no `http(s)://` anywhere in the artifact, and no WebAssembly: the build
 *    refuses to emit a file that has either;
 *  - all rendering goes through `textContent`, never `innerHTML`: the content
 *    is attacker-influenced in the honest sense — it is whatever was in the
 *    user's notes;
 *  - the plaintext export is split. A text file of notes carries no secrets;
 *    passwords and attachment bytes leave only through a separate action, with
 *    the warning said plainly and confirmed twice.
 */

import { decodeBackup, deriveBackupKey, type BackupBody } from '../src/lib/backup';
import {
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  base64ToBuffer,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
  type SafeboxAttachmentDescriptor,
} from '../src/lib/crypto';
import { deriveKey, deriveSafeboxMetaKey, deriveSafeboxSecretKey } from '../src/lib/crypto';
import { SECRET_FIELD_PROPS } from '../src/components/secretFieldProps';

// ─── Tiny DOM helpers (textContent only — never innerHTML) ───────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ─── State (dropped on pagehide, best effort) ────────────────────────

interface OpenedNote {
  id: string;
  createdAt: number;
  text: string;
}
interface OpenedEntry {
  id: string;
  title: string;
  login: string;
  url: string;
  note: string;
  password: string;
  files: Array<SafeboxAttachmentDescriptor & { bytes: Uint8Array }>;
}

let opened: { createdAt: number; notes: OpenedNote[]; entries: OpenedEntry[]; incomplete: boolean } | null = null;

// ─── Opening ─────────────────────────────────────────────────────────

async function open(file: File, mnemonic: string): Promise<void> {
  const containerKey = await deriveBackupKey(mnemonic);
  const { header, body } = await decodeBackup(await file.text(), containerKey);

  const noteKey = await deriveKey(mnemonic);
  const metaKey = await deriveSafeboxMetaKey(mnemonic);
  const secretKey = await deriveSafeboxSecretKey(mnemonic);

  const notes: OpenedNote[] = [];
  const entries: OpenedEntry[] = [];
  let unreadable = 0;

  for (const record of body.notes as unknown as EncryptedNote[]) {
    try {
      const { text, createdAt } = await decryptNote(noteKey, record);
      notes.push({ id: record.noteId, createdAt, text });
    } catch {
      unreadable++;
    }
  }

  for (const record of body.safebox as unknown as EncryptedSafeboxEntry[]) {
    try {
      const meta = await decryptSafeboxMeta(metaKey, record);
      const secret = await decryptSafeboxSecret(secretKey, record, meta.files);
      entries.push({
        id: record.entryId,
        title: meta.title,
        login: meta.login,
        url: meta.url,
        note: meta.note,
        password: secret.password,
        // The viewer EXTRACTS attachments (D22): in the «project gone, no PWA»
        // quadrant, a recovery that cannot return a file is not a recovery.
        files: meta.files.map((descriptor, i) => ({
          ...descriptor,
          bytes: base64ToBuffer(secret.files[i]?.data ?? ''),
        })),
      });
    } catch {
      unreadable++;
    }
  }

  notes.sort((a, b) => b.createdAt - a.createdAt);
  opened = { createdAt: header.createdAt, notes, entries, incomplete: body.incompleteRestore };
  render(unreadable, header.containsUnsupportedRecords, body);
}

// ─── Rendering ───────────────────────────────────────────────────────

function render(unreadable: number, headerFlag: boolean, body: BackupBody): void {
  if (!opened) return;
  byId('entry').hidden = true;
  byId('view').hidden = false;

  byId('summary').textContent =
    `Копия от ${new Date(opened.createdAt).toLocaleDateString()} · ` +
    `${body.counts.notes} заметок · ${body.counts.safebox} записей сейфа`;

  const warnings = byId('view-warnings');
  clear(warnings);
  if (opened.incomplete) {
    // Blocking and specific — only now, AFTER decryption, because the marker
    // lives inside the ciphertext and its value was unknowable before.
    warnings.appendChild(el('p', 'warn warn-block',
      'Эта копия заведомо неполна: устройство, которое её создало, само восстанавливалось не полностью. '
      + 'Не удаляйте исходные файлы, из которых восстанавливались.'));
  }
  if (unreadable > 0 || headerFlag) {
    warnings.appendChild(el('p', 'warn',
      `Часть записей (${unreadable}) не может быть показана этой версией просмотрщика. `
      + 'Не удаляйте файл копии.'));
  }

  const notes = byId('notes');
  clear(notes);
  for (const note of opened.notes) {
    const card = el('article', 'card');
    card.appendChild(el('div', 'card-date', new Date(note.createdAt).toLocaleString()));
    // `pre-wrap` + textContent: markdown is shown as its source, and nothing
    // in a note can become markup.
    card.appendChild(el('pre', 'card-text', note.text));
    notes.appendChild(card);
  }

  const safebox = byId('safebox');
  clear(safebox);
  for (const entry of opened.entries) safebox.appendChild(renderEntry(entry));
}

function renderEntry(entry: OpenedEntry): HTMLElement {
  const card = el('article', 'card');
  card.appendChild(el('h3', 'card-title', entry.title));
  for (const [label, value] of [['Логин', entry.login], ['Адрес', entry.url], ['Заметка', entry.note]]) {
    if (!value) continue;
    const row = el('div', 'row');
    row.appendChild(el('span', 'label', label));
    row.appendChild(el('span', 'value', value));
    card.appendChild(row);
  }

  const passwordRow = el('div', 'row');
  passwordRow.appendChild(el('span', 'label', 'Пароль'));
  const masked = el('span', 'value', '••••••');
  passwordRow.appendChild(masked);
  const reveal = el('button', 'link', 'показать');
  reveal.type = 'button';
  let shown = false;
  reveal.addEventListener('click', () => {
    shown = !shown;
    masked.textContent = shown ? entry.password : '••••••';
    reveal.textContent = shown ? 'скрыть' : 'показать';
  });
  passwordRow.appendChild(reveal);
  card.appendChild(passwordRow);

  for (const file of entry.files) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'label', file.name));
    const save = el('button', 'link', 'сохранить файл');
    save.type = 'button';
    save.addEventListener('click', () => download(file.name, file.mime, file.bytes));
    row.appendChild(save);
    card.appendChild(row);
  }
  return card;
}

// ─── Exports (D22: the split is the point) ───────────────────────────

function download(name: string, mime: string, bytes: Uint8Array | string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = name;
  link.click();
  // Best effort, and named as such: this drops the reference, it does not
  // scrub memory.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportNotesText(): void {
  if (!opened) return;
  const text = opened.notes
    .map(note => `${new Date(note.createdAt).toLocaleString()}\n${note.text}`)
    .join('\n\n----\n\n');
  download('eternal-notes.txt', 'text/plain;charset=utf-8', text);
}

function exportSecrets(): void {
  if (!opened) return;
  // Two confirmations, and the warning says what actually happens rather than
  // «are you sure»: the file leaving this page is UNENCRYPTED.
  const first = confirm(
    'Файл будет НЕЗАШИФРОВАН: в нём окажутся пароли и содержимое вложений в открытом виде.\n\n'
    + 'Продолжить?');
  if (!first) return;
  const second = confirm('Подтвердите ещё раз: сохранить незашифрованные секреты на диск?');
  if (!second) return;

  const text = opened.entries
    .map(entry => [
      entry.title,
      entry.login && `логин: ${entry.login}`,
      entry.url && `адрес: ${entry.url}`,
      `пароль: ${entry.password}`,
      entry.note && `заметка: ${entry.note}`,
      ...entry.files.map(f => `вложение: ${f.name} (${f.size} байт) — сохраните отдельной кнопкой`),
    ].filter(Boolean).join('\n'))
    .join('\n\n----\n\n');
  download('eternal-notes-secrets.txt', 'text/plain;charset=utf-8', text);
}

// ─── Wiring ──────────────────────────────────────────────────────────

export function start(): void {
  const seed = byId<HTMLTextAreaElement>('seed');
  // D20: the full anti-autofill set, applied from the SAME constant the app
  // uses. A password manager that «helpfully» saves a seed phrase has exported
  // the entire vault to a third party.
  for (const [key, value] of Object.entries(SECRET_FIELD_PROPS)) {
    seed.setAttribute(key === 'autoComplete' ? 'autocomplete' : key, String(value));
  }
  seed.setAttribute('spellcheck', 'false');
  seed.setAttribute('autocapitalize', 'none');
  seed.setAttribute('autocorrect', 'off');

  byId('open').addEventListener('click', () => {
    void (async () => {
      const status = byId('status');
      const file = byId<HTMLInputElement>('file').files?.[0];
      if (!file) { status.textContent = 'Выберите файл копии.'; return; }
      status.textContent = 'Открываем…';
      try {
        await open(file, seed.value.trim());
        status.textContent = '';
      } catch {
        // One honest message: GCM cannot tell a wrong seed from damaged bytes,
        // and pretending otherwise would be a guess dressed as a diagnosis.
        status.textContent = 'Не удалось открыть: файл повреждён или создан с другой seed-фразой.';
      }
    })();
  });

  byId('export-notes').addEventListener('click', exportNotesText);
  byId('export-secrets').addEventListener('click', exportSecrets);

  window.addEventListener('pagehide', () => {
    opened = null;
    seed.value = '';
  });
}

start();
