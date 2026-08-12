import { useEffect, useMemo, useRef, useState } from 'react';
import { PasswordGenerator } from './PasswordGenerator';
import { SECRET_PASSWORD_FIELD_PROPS, SECRET_FIELD_PROPS } from './secretFieldProps';
import { useModalA11y } from '../lib/useModalA11y';
import {
  estimateSafeboxUploadByteLength,
  MAX_UPLOAD_BODY_BYTES,
  MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES,
} from '../lib/limits';
import {
  MAX_SAFEBOX_FILES,
  MAX_SAFEBOX_FILENAME_CHARS,
  MAX_SAFEBOX_MIME_CHARS,
  bufferToBase64,
  randomUuidV8,
  type SafeboxEntryData,
} from '../lib/crypto';
import type { SafeboxEntryPatch, SafeboxFileAction } from '../lib/safebox';
import type { SafeboxNewEntry } from '../lib/store';

/**
 * Create / edit form for one safebox entry.
 *
 * PATCH CONTRACT (§6) — the reason this form looks the way it does: in EDIT
 * mode the current secret is NOT decrypted when the form opens. The password
 * field shows a neutral «без изменений» placeholder and the attachment list is
 * built from the META descriptors. Only an explicit action (typing a new
 * password, removing/replacing a file) changes anything; everything else is
 * carried over by the store when it decrypts the previous version ON SUBMIT.
 */

interface DraftFile {
  fid: string;
  name: string;
  mime: string;
  size: number;
  /** Present for NEW files only; existing ones are carried over by fid. */
  data?: string;
  existing: boolean;
}

interface SafeboxEntryFormProps {
  open: boolean;
  /** Present in EDIT mode: the CURRENT version's meta (never its secret). */
  current: SafeboxEntryData | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (entry: SafeboxNewEntry) => Promise<void>;
  onSave: (patch: SafeboxEntryPatch) => Promise<void>;
}

export function SafeboxEntryForm({ open, current, busy, onClose, onCreate, onSave }: SafeboxEntryFormProps) {
  const editing = current !== null;
  const containerRef = useModalA11y<HTMLDivElement>(open, onClose);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Bumped by an unmount (which a section lock causes — Main remounts the
   *  safebox subtree on `safeboxLockGeneration`) and by every (re)open.
   *  An in-flight intake compares against it after every read and bails. */
  const intakeGenRef = useRef(0);
  /** Synchronously reserved attachment budget — see handleFiles. */
  const reservedBytesRef = useRef(0);
  const reservedFileCountRef = useRef(0);

  const [title, setTitle] = useState('');
  const [login, setLogin] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  /** EDIT mode only: false until the user actually types/generates a password. */
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Fresh lifecycle per opening — adjusted during render, not in an effect.
  const [prevOpenKey, setPrevOpenKey] = useState<string | null>(null);
  const openKey = open ? (current?.id ?? 'new') : null;
  if (openKey !== prevOpenKey) {
    setPrevOpenKey(openKey);
    setTitle(current?.title ?? '');
    setLogin(current?.login ?? '');
    setUrl(current?.url ?? '');
    setNote(current?.note ?? '');
    setPassword('');
    setPasswordTouched(false);
    setShowPassword(false);
    setShowGenerator(false);
    setFiles((current?.files ?? []).map(f => ({ ...f, existing: true })));
    setError('');
    setDirty(false);
    setConfirmClose(false);
  }

  // Lifecycle bookkeeping for the intake refs. In an EFFECT, not in render:
  // refs must not be mutated during render, and an intake can only start from
  // a user event, which always happens after this has run. The cleanup fires
  // both on unmount (a section lock remounts the subtree) and before the next
  // lifecycle, so an in-flight read is abandoned either way.
  useEffect(() => {
    intakeGenRef.current++;
    reservedBytesRef.current = (current?.files ?? []).reduce((sum, f) => sum + f.size, 0);
    reservedFileCountRef.current = (current?.files ?? []).length;
    // Deliberately bumps whatever the CURRENT value is: this is a monotonic
    // generation counter, not a handle to a DOM node, so capturing a snapshot
    // (what the lint rule suggests) would defeat the invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { intakeGenRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  const estimatedBytes = useMemo(() => estimateSafeboxUploadByteLength({
    title, login, url, note,
    // In edit mode the real password is unknown here; assume the longest
    // plausible carry-over so the counter never under-reports.
    password: passwordTouched || !editing ? password : 'x'.repeat(128),
    files: files.map(f => ({ fid: f.fid, name: f.name, mime: f.mime, size: f.size })),
  }), [title, login, url, note, password, passwordTouched, editing, files]);

  const overLimit = estimatedBytes > MAX_UPLOAD_BODY_BYTES;

  function markDirty() { setDirty(true); setError(''); }

  /**
   * Attachment intake. Everything cheap is validated BEFORE `arrayBuffer()` —
   * count, name/MIME length and the raw byte budget — so a multi-gigabyte
   * `File` is rejected without ever being read into memory. Reading is
   * sequential for the same reason.
   *
   * Two races this has to survive:
   *  - CONCURRENT picks. `files`/`rawAttachmentBytes` are a render snapshot, so
   *    two intakes started before either finished would both validate against
   *    the SAME stale total and could jointly blow the cap. The budget is
   *    therefore RESERVED synchronously in a ref (from `File.size`, which needs
   *    no await) before the first read, and released if the intake aborts.
   *  - A LOCK / unmount mid-read. `intakeGenRef` is bumped by both; the loop
   *    re-checks it after every `arrayBuffer()` and drops everything it has
   *    read, so a locked safebox never keeps ingesting files.
   */
  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError('');
    const incoming = Array.from(list);

    if (reservedFileCountRef.current + incoming.length > MAX_SAFEBOX_FILES) {
      setError(`Слишком много вложений: максимум ${MAX_SAFEBOX_FILES}.`);
      return;
    }
    let reserved = 0;
    for (const f of incoming) {
      if (f.name.length > MAX_SAFEBOX_FILENAME_CHARS) {
        setError('Слишком длинное имя файла.');
        return;
      }
      if (f.type.length > MAX_SAFEBOX_MIME_CHARS) {
        setError('Некорректный тип файла.');
        return;
      }
      reserved += f.size;
      if (reservedBytesRef.current + reserved > MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES) {
        setError(`Суммарный размер вложений не должен превышать ${Math.floor(MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES / 1024)} КБ.`);
        return;
      }
    }
    // Claim the budget BEFORE the first await — this is what makes two
    // concurrent intakes add up instead of overwriting each other's view.
    reservedBytesRef.current += reserved;
    reservedFileCountRef.current += incoming.length;
    const release = () => {
      reservedBytesRef.current -= reserved;
      reservedFileCountRef.current -= incoming.length;
    };

    const myGen = intakeGenRef.current;
    const added: DraftFile[] = [];
    for (const f of incoming) {
      let buf: ArrayBuffer;
      try {
        buf = await f.arrayBuffer();
      } catch {
        release();
        setError('Не удалось прочитать файл.');
        return;
      }
      // A lock (or an unmount) happened while we were reading: stop NOW —
      // do not read the remaining files and do not publish what we have.
      if (intakeGenRef.current !== myGen) return; // reservation dies with the form
      if (buf.byteLength !== f.size) {
        // The file changed on disk between the size check and the read: the
        // reservation no longer describes it. Refuse rather than silently
        // exceed the budget.
        release();
        setError('Файл изменился во время чтения — попробуйте ещё раз.');
        return;
      }
      added.push({
        // A NEW fid every time — including for a "replacement" — so a
        // descriptor can never be bound to another version's bytes.
        fid: randomUuidV8(),
        name: f.name,
        mime: f.type || 'application/octet-stream',
        size: buf.byteLength,
        data: bufferToBase64(buf),
        existing: false,
      });
    }
    setFiles(prev => [...prev, ...added]);
    markDirty();
  }

  function removeFile(fid: string) {
    setFiles(prev => {
      const gone = prev.find(f => f.fid === fid);
      if (gone) {
        // Give the budget back synchronously, so a re-add right after a remove
        // is measured against the truth and not against the stale reservation.
        reservedBytesRef.current -= gone.size;
        reservedFileCountRef.current -= 1;
      }
      return prev.filter(f => f.fid !== fid);
    });
    markDirty();
  }

  async function submit() {
    if (busy) return;
    if (!title.trim()) { setError('Укажите название'); return; }
    if (!editing && !password) { setError('Укажите или сгенерируйте пароль'); return; }
    if (overLimit) { setError('Запись слишком большая — уменьшите вложения или заметку.'); return; }

    try {
      if (editing) {
        const actions: SafeboxFileAction[] = files.map(f => (
          f.existing
            ? { kind: 'keep', fid: f.fid }
            : { kind: 'add', fid: f.fid, name: f.name, mime: f.mime, size: f.size, data: f.data! }
        ));
        await onSave({
          title, login, url, note,
          // NO password action ⇒ the store carries the old one over verbatim.
          ...(passwordTouched ? { password: { kind: 'replace' as const, value: password } } : {}),
          files: actions,
        });
      } else {
        await onCreate({
          title, login, url, note, password,
          files: files.map(f => ({ name: f.name, mime: f.mime, size: f.size, data: f.data! })),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить запись.');
      return;
    }
    onClose();
  }

  function requestClose() {
    // The form has NO draft persistence by design (a safebox draft on disk
    // would defeat the point) — so an accidental close must be confirmed.
    if (dirty && !confirmClose) { setConfirmClose(true); return; }
    onClose();
  }

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div
        ref={containerRef}
        className="modal safebox-form"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Изменить запись сейфа' : 'Новая запись сейфа'}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{editing ? 'Изменить запись' : 'Новая запись'}</h2>
          <button className="icon-btn" onClick={requestClose} title="Закрыть" aria-label="Закрыть">✕</button>
        </div>

        <label className="settings-hint" htmlFor="sbx-f-title">Название</label>
        <input
          id="sbx-f-title" name="sbx-f-title" type="text" className="invite-input"
          value={title} onChange={e => { setTitle(e.target.value); markDirty(); }}
          {...SECRET_FIELD_PROPS}
        />

        <label className="settings-hint" htmlFor="sbx-f-acct">Логин</label>
        <input
          id="sbx-f-acct" name="sbx-f-acct" type="text" className="invite-input"
          value={login} onChange={e => { setLogin(e.target.value); markDirty(); }}
          {...SECRET_FIELD_PROPS}
        />

        <label className="settings-hint" htmlFor="sbx-f-secret">Пароль</label>
        <div className="safebox-password-row">
          <input
            id="sbx-f-secret" name="sbx-f-secret"
            type={showPassword ? 'text' : 'password'}
            className="invite-input"
            placeholder={editing && !passwordTouched ? 'без изменений' : 'Пароль'}
            value={password}
            onChange={e => { setPassword(e.target.value); setPasswordTouched(true); markDirty(); }}
            {...SECRET_PASSWORD_FIELD_PROPS}
          />
          <button
            type="button" className="icon-btn"
            onClick={() => setShowPassword(v => !v)}
            aria-pressed={showPassword}
            aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
            title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
          >
            {showPassword ? '🙈' : '👁'}
          </button>
          <button
            type="button" className="icon-btn"
            onClick={() => setShowGenerator(v => !v)}
            aria-pressed={showGenerator}
            aria-label="Генератор паролей"
            title="Генератор паролей"
          >
            🎲
          </button>
        </div>
        {editing && !passwordTouched && (
          <p className="settings-hint">
            Текущий пароль не расшифровывается при открытии формы. Оставьте поле
            пустым — он сохранится без изменений.
          </p>
        )}
        {showGenerator && (
          <PasswordGenerator onGenerate={pw => {
            setPassword(pw);
            setPasswordTouched(true);
            setShowPassword(true);
            markDirty();
          }} />
        )}

        <label className="settings-hint" htmlFor="sbx-f-site">URL</label>
        <input
          id="sbx-f-site" name="sbx-f-site" type="text" className="invite-input"
          value={url} onChange={e => { setUrl(e.target.value); markDirty(); }}
          {...SECRET_FIELD_PROPS}
        />

        <label className="settings-hint" htmlFor="sbx-f-memo">Заметка</label>
        <textarea
          id="sbx-f-memo" name="sbx-f-memo" className="invite-input"
          rows={3}
          value={note} onChange={e => { setNote(e.target.value); markDirty(); }}
          {...SECRET_FIELD_PROPS}
        />

        <div className="safebox-files">
          <div className="settings-hint">
            Вложения (до {Math.floor(MAX_SAFEBOX_ATTACHMENTS_RAW_BYTES / 1024)} КБ суммарно)
          </div>
          {files.map(f => (
            <div className="safebox-file-row" key={f.fid}>
              <span className="safebox-file-name">{f.name}</span>
              <span className="safebox-file-size">{f.size} Б</span>
              <button
                type="button" className="icon-btn"
                onClick={() => removeFile(f.fid)}
                aria-label={`Удалить вложение ${f.name}`}
                title="Удалить"
              >
                ✕
              </button>
            </div>
          ))}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={e => { void handleFiles(e.target.files); e.target.value = ''; }}
            aria-label="Добавить вложения"
          />
        </div>

        <div className={`safebox-size ${overLimit ? 'text-red' : ''}`} role="status">
          Размер записи: {estimatedBytes} из {MAX_UPLOAD_BODY_BYTES} байт
        </div>

        {error && <div className="error-msg" role="alert">{error}</div>}
        {confirmClose && (
          <div className="seed-warning">
            Изменения не сохранены и будут потеряны. Нажмите «Закрыть» ещё раз,
            чтобы выйти без сохранения.
          </div>
        )}

        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={requestClose} disabled={busy}>Отмена</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || overLimit}>
            {busy ? '...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
