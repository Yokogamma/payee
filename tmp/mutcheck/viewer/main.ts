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
 *  - one card per chain, never every stored version side by side: in the
 *    quadrant this page exists for there is nothing to cross-check against, so
 *    a superseded password shown as a peer of the current one is a trap. That
 *    card is the CURRENT version only when the collection was read in full,
 *    its links hold up and the file does not declare itself incomplete;
 *    otherwise it is the latest READABLE version, and the page says so — on
 *    screen, in the confirmations, and inside the text files it writes. An
 *    attachment is the one exception: those bytes are the user's own file and
 *    are written unchanged, so its caveat lives in the confirmation alone.
 */

import {
  BACKUP_CAP_BYTES,
  BackupError,
  decodeBackup,
  deriveBackupKey,
  isOpaqueEntry,
  isOpaqueNote,
} from '../../../src/lib/backup';
import { validateChains, type ChainNode } from '../../../src/lib/backup-chains';
import { groupChains, groupSafeboxChains } from '../../../src/lib/chains';
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
} from '../../../src/lib/crypto';
import { SECRET_FIELD_PROPS } from '../../../src/components/secretFieldProps';

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
  /** The newest READABLE version of each chain, feed-ordered. Whether
   *  «newest readable» is also «current» is `currentness` below. */
  notes: NoteData[];
  entries: OpenedEntry[];
  incomplete: boolean;
  /** Per collection: every reason «current» cannot be claimed, empty when it
   *  can. Carried on the state because the export paths have to say it too —
   *  a warning on screen does not travel into a file being written to disk. */
  currentness: { notes: CurrentnessDoubt[]; safebox: CurrentnessDoubt[] };
}

let opened: Opened | null = null;

/**
 * Bumped by every teardown AND by every new open. One counter, two jobs, and
 * they are the same job: only the newest request owns the page.
 *
 * Opening a container is a long chain of awaits — reading up to 32 MB,
 * authenticating it, then one decryption per record. The page can be left in
 * the middle of that, and BFCache freezes the pending continuation rather than
 * discarding it: it resumes when the user comes back, AFTER the teardown has
 * run. Without a generation the resumed continuation would re-assign `opened`
 * and repaint the whole vault onto a page that had just been closed — with no
 * seed phrase asked for, and with every export path live again.
 *
 * The second job is ordering. Two clicks — a mistyped phrase corrected, a
 * different file chosen — start two opens, and the FIRST one can finish last:
 * key derivation is the slow part and it does not run at a fixed speed. The
 * older result would then land on top of the newer one, showing one file's
 * contents under the impression of having opened the other. Bumping on entry
 * makes every superseded open disown itself at its next checkpoint.
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

/**
 * What this viewer made of ONE collection.
 *
 * The two counts lead to DIFFERENT advice — «a newer viewer can show these»
 * versus «these bytes are gone» — so they are never collapsed into one number.
 * They are also kept per collection because an unreadable NOTE says nothing
 * about the safebox, and the conclusion drawn from them below is heavy enough
 * that it must not spill across.
 */
interface CollectionTally {
  unsupported: number;
  damaged: number;
  /** Chain links that do not hold up. Only ever set for a collection this
   *  viewer read in full — with records missing, a broken link is expected
   *  rather than evidence. */
  brokenGraph: boolean;
}

interface OpenTally {
  notes: CollectionTally;
  safebox: CollectionTally;
  /** Versions in the file, including the superseded ones that are not shown. */
  versions: number;
}

const emptyCollection = (): CollectionTally =>
  ({ unsupported: 0, damaged: 0, brokenGraph: false });

const unreadable = (c: CollectionTally): number => c.unsupported + c.damaged;

/**
 * Every reason the page may have to refuse the word «current».
 *
 * A SET rather than a choice, because they co-occur and they send the user to
 * DIFFERENT places — and the difference is the whole value of saying it:
 *
 *  - `unsupported`: a record written by a newer build. Its topology is inside
 *    the ciphertext, so nothing can say which chain it belonged to; a safebox
 *    entry whose rev 2 is opaque leaves rev 1 as the only version there is,
 *    and grouping will call it current. A NEWER VIEWER opens it.
 *  - `damaged`: bytes that no longer authenticate. Same blindness, but no
 *    viewer will ever help — those versions are gone.
 *  - `broken_graph`: everything was read and the links still do not line up,
 *    so `chains.ts` picking «newest by timestamp and revision» is only as
 *    trustworthy as the links behind it.
 *  - `source_incomplete`: the container itself says it was made from an
 *    incomplete restore (D11a). The missing record is not merely unreadable —
 *    it is not in the file at all, which is LESS determinable, not more: there
 *    is not even a count. Only the original file that device restored from can
 *    settle it.
 *
 * An empty list is the only state in which «current» may be said.
 */
type CurrentnessDoubt = 'source_incomplete' | 'unsupported' | 'damaged' | 'broken_graph';

/**
 * `sourceIncomplete` applies to BOTH collections and cannot be narrowed: the
 * marker is one authenticated boolean about the whole container and names
 * neither a collection nor a count. Guessing otherwise would be the same
 * over-reach the per-collection split exists to prevent, only in the
 * direction that costs the user something.
 */
const doubtsOf = (c: CollectionTally, sourceIncomplete: boolean): CurrentnessDoubt[] => {
  const doubts: CurrentnessDoubt[] = [];
  if (sourceIncomplete) doubts.push('source_incomplete');
  if (c.unsupported > 0) doubts.push('unsupported');
  if (c.damaged > 0) doubts.push('damaged');
  // NOT suppressed when the source is incomplete, unlike the unreadable case:
  // there the gap in the node list is our own doing (the record IS in the file,
  // we just could not read it), while here the version is genuinely absent from
  // the container — a fact about the file, and the most concrete evidence of
  // what is missing that the page can offer.
  if (c.brokenGraph) doubts.push('broken_graph');
  return doubts;
};

// ─── Opening ─────────────────────────────────────────────────────────

async function open(file: File, mnemonic: string, myEpoch: number): Promise<void> {
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
  stillOpen();
  const text = await file.text();
  stillOpen();
  const { header, body } = await decodeBackup(text, containerKey);
  stillOpen();

  const noteKey = await deriveKey(mnemonic);
  stillOpen();
  const metaKey = await deriveSafeboxMetaKey(mnemonic);
  stillOpen();
  const secretKey = await deriveSafeboxSecretKey(mnemonic);
  stillOpen();

  const noteVersions: NoteData[] = [];
  const entryVersions: SafeboxEntryData[] = [];
  const entryById = new Map<string, OpenedEntry>();
  const tally: OpenTally = {
    notes: emptyCollection(),
    safebox: emptyCollection(),
    versions: body.counts.notes + body.counts.safebox,
  };

  for (const record of body.notes as unknown as EncryptedNote[]) {
    stillOpen();
    // Decided by the declared VERSION, never by which error a decrypt threw:
    // «too new for this viewer» and «these bytes are damaged» lead to opposite
    // advice, and the exception types do not separate them.
    if (isOpaqueNote(record)) { tally.notes.unsupported++; continue; }
    try {
      const { text: noteText, createdAt, meta } = await decryptNote(noteKey, record);
      stillOpen();
      noteVersions.push({ id: record.noteId, text: noteText, createdAt, ...meta });
    } catch (error) {
      // A closed page is not a damaged record. Without this the checkpoint
      // above would be swallowed by the handler it sits inside, the loop would
      // carry on decrypting for a page nobody is looking at, and the count of
      // damaged records would be a lie about the file.
      if (error instanceof PageClosed) throw error;
      tally.notes.damaged++;
    }
  }

  for (const record of body.safebox as unknown as EncryptedSafeboxEntry[]) {
    stillOpen();
    if (isOpaqueEntry(record)) { tally.safebox.unsupported++; continue; }
    try {
      const meta = await decryptSafeboxMeta(metaKey, record);
      // Between the halves, not only around the pair: the secret half is the
      // password and the attachment bytes, and there is no reason to
      // materialize them for a page that has already been left.
      stillOpen();
      const secret = await decryptSafeboxSecret(secretKey, record, meta.files);
      stillOpen();
      entryVersions.push(meta);
      entryById.set(meta.id, {
        ...meta,
        password: secret.password,
        attachments: pairAttachments(meta.files, secret.files),
      });
    } catch (error) {
      if (error instanceof PageClosed) throw error;
      tally.safebox.damaged++;
    }
  }

  // The asymmetric header check (D11a), the same way the app does it: the
  // header is the WRITER's claim. `false` while unreadable records are in fact
  // present means the writer lied or the file was altered — fail closed. The
  // other direction is normal forward compatibility and simply drops the
  // warning, which is why strict equality is wrong here: it would reject a
  // valid backup at precisely the reader able to show it.
  if (tally.notes.unsupported + tally.safebox.unsupported > 0 && !header.containsUnsupportedRecords) {
    throw new BackupError('corrupt', 'Header claims every record is supported, but some are not');
  }

  // The same graph check the app's dry-run runs (`backup-chains.ts`), and for
  // the same reason: grouping deliberately ignores `prev`, so it will happily
  // pick a «current» version out of a chain whose links do not hold up.
  //
  // Only for a collection read IN FULL. With records missing, a broken link is
  // the expected consequence of the gap rather than evidence about the file —
  // and the conclusion is already the stronger one below.
  const nodes: ChainNode[] = [
    ...noteVersions.map(note => toChainNode('note', note)),
    ...entryVersions.map(entry => toChainNode('safebox', entry)),
  ];
  const issues = validateChains(nodes);
  tally.notes.brokenGraph =
    unreadable(tally.notes) === 0 && issues.some(issue => issue.kind === 'note');
  tally.safebox.brokenGraph =
    unreadable(tally.safebox) === 0 && issues.some(issue => issue.kind === 'safebox');

  // A container carries every VERSION the store held, and the app shows one
  // card per chain — its current version (`chains.ts`, the same `byCurrentness`
  // rule). Rendering versions flat would put a superseded password next to the
  // current one with nothing to tell them apart, in the one place where there
  // is nothing else to check against. What «current» is worth when something is
  // missing is settled by `doubtsOf`, and said out loud in `render`.
  const notes = groupChains(noteVersions).map(chain => chain.current);
  const entries = groupSafeboxChains(entryVersions)
    .map(chain => entryById.get(chain.current.id))
    .filter((entry): entry is OpenedEntry => entry !== undefined);

  stillOpen();
  opened = {
    createdAt: header.createdAt,
    notes,
    entries,
    incomplete: body.incompleteRestore,
    currentness: {
      notes: doubtsOf(tally.notes, body.incompleteRestore),
      safebox: doubtsOf(tally.safebox, body.incompleteRestore),
    },
  };
  render(tally);
}

/** Topology only — the shape `backup-chains.ts` judges. No plaintext crosses
 *  into it: `text`, `title` and the rest stay where they were decrypted. */
function toChainNode(
  kind: 'note' | 'safebox',
  version: { id: string; rev: number; root: string; prev?: string },
): ChainNode {
  return { kind, id: version.id, rev: version.rev, root: version.root, prev: version.prev };
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
  const unsupportedCount = tally.notes.unsupported + tally.safebox.unsupported;
  const damagedCount = tally.notes.damaged + tally.safebox.damaged;
  if (unsupportedCount > 0) {
    warnings.appendChild(el('p', 'warn',
      `Часть записей (${unsupportedCount}) создана более новой версией приложения и не может быть показана. `
      + 'Нужен более новый просмотрщик. Не удаляйте файл копии.'));
  }
  if (damagedCount > 0) {
    // Different problem, different advice: a newer viewer will not help.
    warnings.appendChild(el('p', 'warn',
      `Повреждённых записей: ${damagedCount}. Они не расшифровываются этой seed-фразой. `
      + 'Не удаляйте файл копии — возможно, есть более ранняя.'));
  }

  // The heaviest sentence on the page, and the one it would be easiest to
  // leave unsaid: a missing record may have been the NEWER version of
  // something shown below. Blocking, because the alternative is the user
  // acting on a password that was replaced.
  const caveat = currentnessCaveat(opened.currentness);  // '' when nothing is in doubt
  if (caveat !== '') {
    const node = el('p', 'warn warn-block', caveat);
    node.setAttribute('role', 'alert');
    warnings.appendChild(node);
  }

  const notes = byId('notes');
  clear(notes);
  // Repeated at the list itself: the warnings block is above the fold on the
  // way in, and a user who scrolled to a card is no longer looking at it.
  if (opened.currentness.notes.length > 0) {
    notes.appendChild(el('p', 'warn',
      'Показана последняя ЧИТАЕМАЯ версия каждой заметки — не обязательно самая новая.'));
  }
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
  if (opened.currentness.safebox.length > 0) {
    safebox.appendChild(el('p', 'warn',
      'Показана последняя ЧИТАЕМАЯ версия каждой записи — пароль ниже мог быть уже заменён.'));
  }
  for (const entry of opened.entries) safebox.appendChild(renderEntry(entry));

  // The user was somewhere down the entry screen when they pressed the button.
  // Revealing a section above them is not the same as showing it to them.
  const top = warnings.firstElementChild ?? byId('summary');
  if (typeof top.scrollIntoView === 'function') top.scrollIntoView({ block: 'start' });
}

/** Why «current» cannot be claimed — one sentence per reason, and each says
 *  what would actually help. */
const REASON: Record<CurrentnessDoubt, string> = {
  source_incomplete: 'сам файл заведомо неполон — записи, которой в нём нет, могла быть более '
    + 'новая версия, и вернуть её может только исходный файл, из которого восстанавливались',
  unsupported: 'часть записей создана более новой версией приложения и не прочитана — их покажет '
    + 'более новый просмотрщик',
  damaged: 'часть записей не расшифровывается — этих версий уже не вернуть',
  broken_graph: 'связи между версиями в файле не сходятся',
};

/** What each collection loses by it — the safebox sentence is the sharp one
 *  and must not be said about a safebox that was read in full. */
const STAKE = {
  notes: 'показана последняя ЧИТАЕМАЯ версия каждой заметки',
  safebox: 'показана последняя ЧИТАЕМАЯ версия каждой записи, и пароль среди них мог быть уже заменён',
} as const;

/**
 * The blocking caveat, built PER COLLECTION.
 *
 * An unreadable note proves nothing about the safebox — they are disjoint id
 * spaces — so a doubt raised by one must not be spoken about the other. Saying
 * «your password may have been replaced» over a safebox this viewer read in
 * full is a false alarm in the one place where the user has no way to check.
 *
 * Empty string when there is nothing to say.
 */
function currentnessCaveat(currentness: Opened['currentness']): string {
  const parts: string[] = [];
  for (const collection of ['notes', 'safebox'] as const) {
    const doubts = currentness[collection];
    if (doubts.length === 0) continue;
    parts.push(`${STAKE[collection]} — ${reasons(doubts)}`);
  }
  if (parts.length === 0) return '';
  return `Показанное нельзя считать самой новой версией: ${parts.join('; ')}.`;
}

/** Every reason there actually is, not the first one found: an opaque record
 *  and a damaged one in the same collection are two different pieces of advice,
 *  and dropping either leaves the user acting on half the picture. */
const reasons = (doubts: readonly CurrentnessDoubt[]): string =>
  doubts.map(doubt => REASON[doubt]).join('; ');

/** The same doubt, compressed for a file that will be read somewhere else
 *  entirely, with none of the page around it. */
function currentnessNote(doubts: readonly CurrentnessDoubt[]): string {
  if (doubts.length === 0) return '';
  return `ВНИМАНИЕ: ${reasons(doubts)}. Поэтому сохранённое ниже может быть НЕ самой новой версией.`;
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
      // The one export the caveat cannot travel INSIDE: these are the original
      // bytes of the user's own file, and this page does not alter them. The
      // confirmation is where it is said, and that is stated as the exception
      // it is (D22).
      if (!confirmPlaintextExport(`вложение «${file.name}»`, opened?.currentness.safebox ?? [])) return;
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
function confirmPlaintextExport(what: string, doubts: readonly CurrentnessDoubt[] = []): boolean {
  // The caveat travels INTO the confirmation as well as into the text files
  // themselves: the dialog is gone the moment it is dismissed, and for an
  // attachment — bytes this page writes unchanged — the dialog is the only
  // place it can be said at all.
  const note = currentnessNote(doubts);
  const caveat = note === '' ? '' : `\n\n${note}`;
  const first = confirm(
    `Файл будет НЕЗАШИФРОВАН: ${what} сохранится на диск в открытом виде.${caveat}\n\n`
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
  // A header line rather than a dialog: this file carries no secrets, so it
  // needs no confirmation — but it does need to be honest about what it is
  // once it is somewhere else entirely.
  const note = currentnessNote(opened.currentness.notes);
  const header = note === '' ? '' : `${note}\n\n====\n\n`;
  const text = header + opened.notes
    .map(note => `${new Date(note.createdAt).toLocaleString()}\n${note.text}`)
    .join('\n\n----\n\n');
  download('eternal-notes.txt', 'text/plain;charset=utf-8', text);
}

function exportSecrets(): void {
  if (!opened) return;
  if (!confirmPlaintextExport('пароли и содержимое вложений', opened.currentness.safebox)) return;

  // ...and into the file, not only into the dialog nobody keeps. In six months
  // this text file is all there is, and an old password in it looks exactly as
  // authoritative as a current one.
  const note = currentnessNote(opened.currentness.safebox);
  const header = note === '' ? '' : `${note}\n\n====\n\n`;
  const text = header + opened.entries
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
      // The generation belongs to the REQUEST, and the request is this click.
      // Held here rather than inside `open` because the FAILURE paths need it
      // too: a read that rejects after the page was closed, or after another
      // click superseded this one, would otherwise write its verdict onto a
      // page it no longer owns — a message on a torn-down page, or one file's
      // error over another file's result.
      const myEpoch = ++epoch;
      status.textContent = 'Открываем…';
      try {
        await open(file, phrase, myEpoch);
      } catch (error) {
        if (epoch !== myEpoch) return; // superseded or closed: nobody to tell
        if (error instanceof PageClosed) return;
        status.textContent = openFailure(error, phrase);
        return;
      }
      if (epoch !== myEpoch) return;
      status.textContent = '';
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
