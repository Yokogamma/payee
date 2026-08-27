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
 *    passwords and attachment bytes leave only through an explicit action,
 *    with the warning said plainly and confirmed twice — and «attachment
 *    bytes» means each individual save, not only the bulk export;
 *  - leaving the page tears the vault down SYNCHRONOUSLY, DOM included, and
 *    an open that was still running does not get to undo that;
 *  - what is shown is the CURRENT version of each note and entry, decided by
 *    the app's own rule — not every stored version side by side. In the
 *    quadrant this page exists for there is nothing to cross-check against, so
 *    a superseded password shown as a peer of the current one is a trap.
 */

import {
  BACKUP_CAP_BYTES,
  BackupError,
  decodeBackup,
  deriveBackupKey,
  isOpaqueEntry,
  isOpaqueNote,
} from '../src/lib/backup';
import { groupChains, groupSafeboxChains } from '../src/lib/chains';
import {
  decryptNote,
  decryptSafeboxMeta,
  decryptSafeboxSecret,
  base64ToBuffer,
  deriveKey,
  deriveSafeboxMetaKey,
  deriveSafeboxSecretKey,
  isValidMnemonic,
  normalizeMnemonic,
  type EncryptedNote,
  type EncryptedSafeboxEntry,
  type NoteData,
  type SafeboxAttachmentDescriptor,
  type SafeboxEntryData,
} from '../src/lib/crypto';
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

// ─── State ───────────────────────────────────────────────────────────

/** One safebox entry, decrypted: its authenticated metadata, its password and
 *  its attachments with the bytes already extracted. */
interface OpenedEntry extends SafeboxEntryData {
  password: string;
  attachments: Array<SafeboxAttachmentDescriptor & { bytes: Uint8Array }>;
}

interface Opened {
  createdAt: number;
  /** Current versions only, feed-ordered. */
  notes: NoteData[];
  entries: OpenedEntry[];
  incomplete: boolean;
}

let opened: Opened | null = null;

/**
 * Bumped by every teardown.
 *
 * Opening a container is a long chain of awaits — reading up to 32 MB,
 * authenticating it, then one decryption per record. The page can be left in
 * the middle of that, and BFCache freezes the pending continuation rather than
 * discarding it: it resumes when the user comes back, AFTER the teardown has
 * run. Without this the resumed continuation would re-assign `opened` and
 * repaint the whole vault onto a page that had just been closed — with no seed
 * phrase asked for, and with every export path live again.
 */
let epoch = 0;

/** Not a failure of the file or of the phrase — the page simply stopped being
 *  the one that asked. Callers say nothing about it: there is no one looking. */
class PageClosed extends Error {
  constructor() {
    super('The page was closed while the container was being opened');
    this.name = 'PageClosed';
  }
}

/** What this viewer made of the container, in the two counts that lead to
 *  DIFFERENT advice: «a newer viewer can show these» versus «these bytes are
 *  gone». Collapsing them into one number would tell the user to go looking
 *  for a build that cannot help. */
interface OpenTally {
  unsupported: number;
  damaged: number;
  /** Versions in the file, including the superseded ones that are not shown. */
  versions: number;
}

// ─── Opening ─────────────────────────────────────────────────────────

async function open(file: File, mnemonic: string): Promise<void> {
  const myEpoch = epoch;
  /** Throws if the page was torn down under us. Checked after every await
   *  that can span a navigation, and — the load-bearing one — immediately
   *  before anything is published to the page. */
  const stillOpen = (): void => { if (epoch !== myEpoch) throw new PageClosed(); };

  // D17, and BEFORE anything else: the size is a fact about the file, so it is
  // read from the file rather than discovered halfway through parsing it. A
  // container past the cap would otherwise be pulled into memory in full —
  // and on the phone that is the tab dying instead of an error message.
  if (file.size > BACKUP_CAP_BYTES) {
    throw new BackupError('too_large', `File is ${file.size} bytes, over the ${BACKUP_CAP_BYTES} cap`);
  }

  const containerKey = await deriveBackupKey(mnemonic);
  const { header, body } = await decodeBackup(await file.text(), containerKey);
  stillOpen();

  const noteKey = await deriveKey(mnemonic);
  const metaKey = await deriveSafeboxMetaKey(mnemonic);
  const secretKey = await deriveSafeboxSecretKey(mnemonic);
  stillOpen();

  const noteVersions: NoteData[] = [];
  const entryVersions: SafeboxEntryData[] = [];
  const entryById = new Map<string, OpenedEntry>();
  const tally: OpenTally = {
    unsupported: 0,
    damaged: 0,
    versions: body.counts.notes + body.counts.safebox,
  };

  for (const record of body.notes as unknown as EncryptedNote[]) {
    stillOpen();
    // Decided by the declared VERSION, never by which error a decrypt threw:
    // «too new for this viewer» and «these bytes are damaged» lead to opposite
    // advice, and the exception types do not separate them.
    if (isOpaqueNote(record)) { tally.unsupported++; continue; }
    try {
      const { text, createdAt, meta } = await decryptNote(noteKey, record);
      noteVersions.push({ id: record.noteId, text, createdAt, ...meta });
    } catch {
      tally.damaged++;
    }
  }

  for (const record of body.safebox as unknown as EncryptedSafeboxEntry[]) {
    stillOpen();
    if (isOpaqueEntry(record)) { tally.unsupported++; continue; }
    try {
      const meta = await decryptSafeboxMeta(metaKey, record);
      const secret = await decryptSafeboxSecret(secretKey, record, meta.files);
      entryVersions.push(meta);
      entryById.set(meta.id, {
        ...meta,
        password: secret.password,
        attachments: pairAttachments(meta.files, secret.files),
      });
    } catch {
      tally.damaged++;
    }
  }

  // The asymmetric header check (D11a), the same way the app does it: the
  // header is the WRITER's claim. `false` while unreadable records are in fact
  // present means the writer lied or the file was altered — fail closed. The
  // other direction is normal forward compatibility and simply drops the
  // warning, which is why strict equality is wrong here: it would reject a
  // valid backup at precisely the reader able to show it.
  if (tally.unsupported > 0 && !header.containsUnsupportedRecords) {
    throw new BackupError('corrupt', 'Header claims every record is supported, but some are not');
  }

  // A container carries every VERSION the store held, and the app shows one
  // card per chain — its current version (`chains.ts`, the same `byCurrentness`
  // rule). Rendering versions flat would put a superseded password next to the
  // current one with nothing to tell them apart, in the one place where there
  // is nothing else to check against.
  const notes = groupChains(noteVersions).map(chain => chain.current);
  const entries = groupSafeboxChains(entryVersions)
    .map(chain => entryById.get(chain.current.id))
    .filter((entry): entry is OpenedEntry => entry !== undefined);

  stillOpen();
  opened = { createdAt: header.createdAt, notes, entries, incomplete: body.incompleteRestore };
  render(tally);
}

/**
 * Bind each attachment descriptor to ITS content, BY FID.
 *
 * The envelope contract says the two halves correspond one to one by `fid`
 * (crypto.ts) — and says nothing at all about their ORDER, which is exactly
 * why order must not be used. The app's own download path looks contents up by
 * fid; a viewer pairing by index would, the first time a writer emitted the
 * halves in a different order, hand the user one file's bytes under another
 * file's name. In this page that is not a display bug: it is the copy of the
 * secret they are saving to disk.
 *
 * The viewer EXTRACTS attachments at all because of D22: in the «project gone,
 * no PWA» quadrant, a recovery that cannot return a file is not a recovery.
 */
export function pairAttachments(
  descriptors: readonly SafeboxAttachmentDescriptor[],
  contents: readonly { fid: string; data: string }[],
): Array<SafeboxAttachmentDescriptor & { bytes: Uint8Array }> {
  const byFid = new Map(contents.map(content => [content.fid, content.data]));
  return descriptors.map(descriptor => ({
    ...descriptor,
    bytes: base64ToBuffer(byFid.get(descriptor.fid) ?? ''),
  }));
}

// ─── Rendering ───────────────────────────────────────────────────────

function render(tally: OpenTally): void {
  if (!opened) return;
  byId('entry').hidden = true;
  byId('view').hidden = false;

  const shown = opened.notes.length + opened.entries.length;
  byId('summary').textContent =
    `Копия от ${new Date(opened.createdAt).toLocaleDateString()} · `
    + `${opened.notes.length} заметок · ${opened.entries.length} записей сейфа`
    // The container's own record count, which is what «is this copy whole?»
    // is answered from — and it is NOT the number of cards above, because
    // every edit left a version behind. Saying only one of the two numbers
    // would have the user compare it against the other and find a
    // disagreement neither line explains.
    + (tally.versions > shown ? ` · всего версий в файле: ${tally.versions}` : '');

  const warnings = byId('view-warnings');
  clear(warnings);
  if (opened.incomplete) {
    // Blocking and specific — only now, AFTER decryption, because the marker
    // lives inside the ciphertext and its value was unknowable before.
    const blocking = el('p', 'warn warn-block',
      'Эта копия заведомо неполна: устройство, которое её создало, само восстанавливалось не полностью. '
      + 'Не удаляйте исходные файлы, из которых восстанавливались.');
    // A warning nobody is shown is not blocking. `alert` makes assistive
    // technology announce it on insertion; the scroll below puts it in front
    // of eyes that were left further down the entry screen.
    blocking.setAttribute('role', 'alert');
    warnings.appendChild(blocking);
  }
  // Driven by what this viewer actually SAW, never by the header flag: a
  // header saying «there are records you may not understand» over a file this
  // viewer understands in full must not produce «часть записей (0)».
  if (tally.unsupported > 0) {
    warnings.appendChild(el('p', 'warn',
      `Часть записей (${tally.unsupported}) создана более новой версией приложения и не может быть показана. `
      + 'Нужен более новый просмотрщик. Не удаляйте файл копии.'));
  }
  if (tally.damaged > 0) {
    // Different problem, different advice: a newer viewer will not help.
    warnings.appendChild(el('p', 'warn',
      `Повреждённых записей: ${tally.damaged}. Они не расшифровываются этой seed-фразой. `
      + 'Не удаляйте файл копии — возможно, есть более ранняя.'));
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

  // The user was somewhere down the entry screen when they pressed the button.
  // Revealing a section above them is not the same as showing it to them.
  const top = warnings.firstElementChild ?? byId('summary');
  if (typeof top.scrollIntoView === 'function') top.scrollIntoView({ block: 'start' });
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

  for (const file of entry.attachments) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'label', file.name));
    const save = el('button', 'link', 'сохранить файл');
    save.type = 'button';
    // The SAME two-step confirmation the bulk export uses (D22). Attachment
    // bytes are secrets: saving one puts an unencrypted copy on disk, and a
    // single click is not a decision the user can be assumed to have made.
    save.addEventListener('click', () => {
      if (!confirmPlaintextExport(`вложение «${file.name}»`)) return;
      download(file.name, file.mime, file.bytes);
    });
    row.appendChild(save);
    card.appendChild(row);
  }
  return card;
}

// ─── Exports (D22: the split is the point) ───────────────────────────

/** The warning says what actually happens rather than «are you sure», and it
 *  is confirmed twice. One helper for every path that puts a secret on disk —
 *  a second wording would eventually become a weaker one. */
function confirmPlaintextExport(what: string): boolean {
  const first = confirm(
    `Файл будет НЕЗАШИФРОВАН: ${what} сохранится на диск в открытом виде.\n\n`
    + 'Продолжить?');
  if (!first) return false;
  return confirm('Подтвердите ещё раз: сохранить незашифрованные данные на диск?');
}

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
  if (!confirmPlaintextExport('пароли и содержимое вложений')) return;

  const text = opened.entries
    .map(entry => [
      entry.title,
      entry.login && `логин: ${entry.login}`,
      entry.url && `адрес: ${entry.url}`,
      `пароль: ${entry.password}`,
      entry.note && `заметка: ${entry.note}`,
      ...entry.attachments.map(f => `вложение: ${f.name} (${f.size} байт) — сохраните отдельной кнопкой`),
    ].filter(Boolean).join('\n'))
    .join('\n\n----\n\n');
  download('eternal-notes-secrets.txt', 'text/plain;charset=utf-8', text);
}

// ─── Failure messages ────────────────────────────────────────────────

const DAMAGED_OR_WRONG_SEED =
  'Не удалось открыть: файл повреждён или создан с другой seed-фразой.';

const CHECK_THE_PHRASE =
  'Проверьте seed-фразу: это не похоже на корректную фразу BIP-39 (12 слов из словаря). '
  + 'Файл при этом прочитать не удалось — скорее всего, с ним всё в порядке.';

/**
 * One typed message per typed failure.
 *
 * Two mistakes this replaces, and both were made in the one place where the
 * user has no second opinion:
 *
 *  - a container from a NEWER app was called damaged. It is not: it is intact
 *    and needs a newer viewer, and «damaged» sends the user hunting for a
 *    corrupted file that does not exist;
 *  - a mistyped or oddly-spaced PHRASE was called a verdict about the file.
 *    BIP-39 rejects a wrong word count outright, so the page had not read a
 *    single byte of the container before announcing it might be corrupt.
 *
 * The phrase is only ever CLASSIFIED here, never quoted (D11).
 */
function openFailure(error: unknown, phrase: string): string {
  const phraseIsSound = isValidMnemonic(phrase);
  if (!(error instanceof BackupError)) {
    // Includes BIP-39's own «Invalid mnemonic» throw, which happens before the
    // file is touched at all.
    return phraseIsSound ? DAMAGED_OR_WRONG_SEED : CHECK_THE_PHRASE;
  }
  switch (error.code) {
    case 'too_large':
      return 'Файл больше 32 МБ — такие копии этот просмотрщик не открывает.';
    case 'too_new':
      return 'Копия создана более новой версией приложения. Нужен более новый просмотрщик — '
        + 'файл при этом цел, не удаляйте его.';
    case 'not_a_container':
      return 'Это не похоже на файл резервной копии Eternal Notes.';
    case 'corrupt':
      return 'Файл повреждён: его содержимое не согласуется с заголовком.';
    case 'undecryptable':
    case 'unsupported_value':
      // GCM cannot tell a wrong key from damaged bytes — but it can be asked
      // whether the phrase was a phrase at all before the file is blamed.
      return phraseIsSound ? DAMAGED_OR_WRONG_SEED : CHECK_THE_PHRASE;
  }
}

// ─── Teardown ────────────────────────────────────────────────────────

/**
 * Put the page back to «nothing is open», synchronously.
 *
 * Dropping the state variable is the easy half. The decrypted notes, logins
 * and any revealed password are in the DOM, and BFCache restores a document
 * with its nodes intact — so a page that only nulled its state would come back
 * showing the whole vault, with no seed phrase asked for. The file input is
 * reset too: a restored page with a file still selected invites a second
 * «Открыть» that is not the deliberate act the first one was.
 *
 * Bumping the epoch is the other half: an open still in flight is disowned
 * here, so it cannot publish its result into the page afterwards.
 *
 * Best effort, and not called zeroization: strings already handed to the DOM
 * or to a Blob may survive in memory. What is promised is that nothing is left
 * on screen.
 */
function teardown(): void {
  epoch++;
  opened = null;
  byId<HTMLTextAreaElement>('seed').value = '';
  byId<HTMLInputElement>('file').value = '';
  for (const id of ['notes', 'safebox', 'view-warnings']) clear(byId(id));
  byId('summary').textContent = '';
  byId('status').textContent = '';
  byId('view').hidden = true;
  byId('entry').hidden = false;
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
      // The SAME normalization the app applies at its seed grid: lower-case,
      // single-spaced. Without it a phrase pasted the way wallets and printed
      // cards spell it derives a different key in silence, and a phrase
      // wrapped over two lines does not derive one at all.
      const phrase = normalizeMnemonic(seed.value);
      status.textContent = 'Открываем…';
      try {
        await open(file, phrase);
        status.textContent = '';
      } catch (error) {
        // The page was closed under us: there is nobody to tell, and writing
        // to a torn-down page would put text back on it.
        if (error instanceof PageClosed) return;
        status.textContent = openFailure(error, phrase);
      }
    })();
  });

  byId('export-notes').addEventListener('click', exportNotesText);
  byId('export-secrets').addEventListener('click', exportSecrets);

  window.addEventListener('pagehide', teardown);
  // Belt and braces for the case the teardown above did not run — a snapshot
  // taken before it, a browser that skips the handler. `persisted` is the only
  // interesting case: a normal load has nothing to tear down.
  window.addEventListener('pageshow', event => { if (event.persisted) teardown(); });
}

start();
