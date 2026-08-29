import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotes } from '../lib/store';
import { SettingsBlock } from '../components/SettingsBlock';
import { saveText } from '../lib/download';
import { BACKUP_VIEWER_SHA256, BACKUP_VIEWER_HASH_IS_PLACEHOLDER } from '../lib/backup-viewer-hash';
import {
  backupActions,
  backupErrorMessage,
  freshnessSummary,
  importPreview,
  importSummary,
  sizeNotice,
  verifySummary,
  PHASE_ONE_SCOPE,
  VIEWER_INSTRUCTION,
  type BackupFreshness,
  type ImportPreview,
  type ImportSummary,
  type VerifySummary,
} from '../lib/backup-ui';
import type { PreparedImport } from '../lib/backup-adapter';
import type { VerifyReport } from '../lib/backup-actions';

/**
 * «Резервная копия» — the block, §7.
 *
 * Three things here are load-bearing and none of them is layout:
 *
 *  1. The whole block is absent when both release flags are off. Not disabled,
 *     not greyed — absent, including the viewer instruction: asking someone to
 *     download a thing the interface does not offer is worse than silence.
 *  2. The import is TWO steps with the user's decision between them, and the
 *     second step applies the session the first produced. It is never given a
 *     fresh one (see `PreparedImport`).
 *  3. A blocking warning is one the user is actually shown: `role="alert"`,
 *     and it precedes the button it is about.
 *
 * The words themselves live in `backup-ui` — which sentence is allowed next to
 * which state is a decision, and decisions are checked one at a time.
 */
export function BackupSettings() {
  const {
    exportBackupFile,
    verifyBackupFile,
    prepareBackupImport,
    applyBackupImport,
    readBackupFreshness,
    estimateBackupSize,
    downloadBackupViewer,
  } = useNotes();

  const actions = backupActions();

  const [freshness, setFreshness] = useState<BackupFreshness>({});
  const [size, setSize] = useState<{ text: string; warning?: string; overCap: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verified, setVerified] = useState<VerifyReport | null>(null);
  const [pending, setPending] = useState<{ prepared: PreparedImport; preview: ImportPreview } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const verifyInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const refreshFreshness = useCallback(() => readBackupFreshness().then(
    setFreshness,
    // A chip that cannot be read is a chip that says «не создавалась» — the
    // conservative reading, and never a reason to take the block away.
    // A read that FAILED is «unknown», not «nothing was ever exported». The
    // adapter already draws that distinction for a marker it cannot believe;
    // turning a rejection into `{}` here threw it away again and put the same
    // false claim back on screen.
    () => setFreshness({ unreadable: true }),
  ), [readBackupFreshness]);

  useEffect(() => {
    if (!actions.anyVisible) return;
    void refreshFreshness();
    if (!actions.canExport) return;
    void estimateBackupSize()
      .then(report => setSize(sizeNotice(report.expectedFileBytes, report.overCap)))
      // Silence here is right: an unmeasurable store is not a reason to warn
      // about a size, and the export itself refuses loudly if it cannot fit.
      .catch(() => setSize(null));
  }, [actions.anyVisible, actions.canExport, refreshFreshness, estimateBackupSize]);

  if (!actions.anyVisible) return null;

  const summarized = freshnessSummary(freshness);

  /** One place where every action's failure becomes a sentence, and where the
   *  previous run's output is cleared before the next one starts — a stale
   *  success line above a fresh failure is a lie by adjacency. */
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    // Every operation bumps the cancellation token, which silently invalidates
    // a preview prepared before it (D15). Leaving that preview on screen would
    // offer a «Восстановить» button whose session is already dead — and the
    // refusal would arrive as an error the user cannot connect to anything
    // they did.
    setPending(null);
    setVerified(null);
    // …and the previous import's report. Leaving it up means a verify or an
    // export shows its own result NEXT TO the outcome of an import that
    // finished minutes ago, and the two read as one screen.
    setSummary(null);
    try {
      await work();
    } catch (e) {
      setError(backupErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onExport = () => run('export', async () => {
    const { exported, markerRecorded } = await exportBackupFile();
    saveText(exported.text, exported.fileName, 'application/json');
    await refreshFreshness();
    // «Передан браузеру», not «сохранён»: `<a download>.click()` starts a
    // download and reports nothing about how it ended. Claiming the file is
    // saved is the app asserting something only the browser knows — and the
    // sentence would be a lie for a download the user cancelled.
    setNotice(markerRecorded
      ? 'Файл передан браузеру. Проверьте, что он появился в папке загрузок.'
      : 'Файл передан браузеру, но отметку о нём записать не удалось — чип ниже может отставать.');
  });

  const onDownloadViewer = () => run('viewer', async () => {
    const delivered = await downloadBackupViewer();
    saveText(delivered.text, delivered.fileName, 'text/html');
  });

  const onVerify = (file: File) => run('verify', async () => {
    const { report, markerRecorded } = await verifyBackupFile(file);
    setVerified(report);
    await refreshFreshness();
    // A verify whose mark could not be stored is a verify that happened and
    // will not be remembered. Silence here would leave the chip saying «не
    // проверена» about a file the user just checked, with no way to tell that
    // from «the check failed».
    if (report.ok && !markerRecorded) {
      setNotice('Файл проверен, но отметку об этом записать не удалось — чип ниже её не покажет.');
    }
  });

  const onPrepare = (file: File) => run('prepare', async () => {
    setSummary(null);
    const prepared = await prepareBackupImport(file);
    setPending({ prepared, preview: importPreview(prepared.report) });
  });

  const onApply = (prepared: PreparedImport) => run('apply', async () => {
    // The session from stage A, never a new one: it carries the vault the
    // preview was computed against.
    //
    // The file's own completeness claim comes from stage A's report, not from
    // the import's: `ImportReport.incompleteRestore` is the state of the local
    // MARKER afterwards, which is also raised by anything this import left
    // unapplied. Explaining that as «the device that made this file was itself
    // partially restored» would be a fact about somebody else's device,
    // invented here.
    const sourceIncomplete = prepared.report.incompleteRestore;
    const { report, viewRefreshed } = await applyBackupImport(prepared);
    setSummary(importSummary(report, sourceIncomplete));
    if (!viewRefreshed) {
      setNotice('Данные восстановлены, но экран обновить не удалось — перезагрузите страницу.');
    }
    // The store just grew. A cap warning computed before the import describes
    // a store that no longer exists, and this is the one direction that
    // matters: imports only add.
    if (actions.canExport) {
      await estimateBackupSize()
        .then(report2 => setSize(sizeNotice(report2.expectedFileBytes, report2.overCap)))
        .catch(() => setSize(null));
    }
  });

  const pick = (input: HTMLInputElement | null, then: (file: File) => void) => {
    const file = input?.files?.[0];
    if (input) input.value = ''; // re-picking the SAME file must fire again
    if (file) then(file);
  };

  return (
    <SettingsBlock title="Резервная копия" chip={summarized.chip}>
      <div className="settings-info">
        {summarized.lines.map(line => <div key={line}>{line}</div>)}
        {size && <div>{size.text}</div>}
      </div>

      {size?.warning && (
        <div className={size.overCap ? 'error-msg' : 'settings-info'} role="alert">{size.warning}</div>
      )}

      {/* The instruction, not a readiness label (D19). Always here while any
          button is — including before the first export, which is exactly when
          it is worth reading. */}
      <div className="settings-info">
        {VIEWER_INSTRUCTION.map(line => <div key={line}>{line}</div>)}
        {!BACKUP_VIEWER_HASH_IS_PLACEHOLDER && (
          <div className="backup-digest">Контрольная сумма просмотрщика: <code>{BACKUP_VIEWER_SHA256}</code></div>
        )}
      </div>

      <div className="backup-actions">
        {actions.canExport && (
          <>
            <button
              type="button"
              className="btn btn-outline full-width"
              onClick={onExport}
              disabled={busy !== null}
            >
              {busy === 'export' ? 'Готовим копию…' : 'Скачать резервную копию'}
            </button>
            <button
              type="button"
              className="btn btn-outline full-width"
              onClick={onDownloadViewer}
              disabled={busy !== null}
            >
              {busy === 'viewer' ? 'Загружаем…' : 'Скачать просмотрщик'}
            </button>
          </>
        )}

        {actions.canImport && (
          <>
            <button
              type="button"
              className="btn btn-outline full-width"
              onClick={() => verifyInput.current?.click()}
              disabled={busy !== null}
            >
              {busy === 'verify' ? 'Проверяем…' : 'Проверить файл копии'}
            </button>
            <button
              type="button"
              className="btn btn-outline full-width"
              onClick={() => importInput.current?.click()}
              disabled={busy !== null}
            >
              {busy === 'prepare' ? 'Читаем файл…' : 'Импортировать из файла'}
            </button>
            {/* Hidden inputs rather than styled ones: the picker has to open
                from the button's own user activation. */}
            <input
              ref={verifyInput} type="file" accept="application/json,.json" hidden
              aria-label="Файл резервной копии для проверки"
              onChange={() => pick(verifyInput.current, onVerify)}
            />
            <input
              ref={importInput} type="file" accept="application/json,.json" hidden
              aria-label="Файл резервной копии для импорта"
              onChange={() => pick(importInput.current, onPrepare)}
            />
          </>
        )}
      </div>

      {error && <div className="error-msg" role="alert">{error}</div>}
      {notice && <div className="settings-info" role="status">{notice}</div>}

      {verified && <VerifyResult summary={verifySummary(verified)} />}

      {pending && (
        <ImportPreviewPanel
          preview={pending.preview}
          busy={busy === 'apply'}
          onConfirm={() => onApply(pending.prepared)}
          onCancel={() => setPending(null)}
        />
      )}

      {summary && <ImportResult summary={summary} />}

      <div className="settings-info">{PHASE_ONE_SCOPE}</div>
    </SettingsBlock>
  );
}

/**
 * The dry-run's answer — THREE outcomes, not two.
 *
 * `report.ok` folds «intact», «complete» and «every record readable» into one
 * boolean, which is right for deciding whether to write a freshness marker and
 * wrong for talking to a person. A file that is cryptographically perfect and
 * merely narrower than the vault it came from used to land in the same red box
 * as a corrupted one, under the same advice to look for a newer app version —
 * advice true for exactly one of the reasons a file can fail.
 */
function VerifyResult({ summary }: { summary: VerifySummary }) {
  const blocking = summary.tone !== 'ok';
  return (
    <div
      className={blocking ? 'error-msg' : 'settings-info'}
      role={blocking ? 'alert' : 'status'}
    >
      <div>{summary.headline}</div>
      {/* Orthogonal to everything else: «where this file came from» is a
          different question from «what is wrong inside it», and a damaged file
          used to lose the origin warning entirely because the worse verdict
          won. */}
      {summary.sourceIncomplete && <div>{summary.sourceIncomplete}</div>}
      {summary.issues.map(issue => <div key={issue.text}>{issue.text}</div>)}
    </div>
  );
}

/** Stage A's result, and the decision the user makes between the stages. */
function ImportPreviewPanel({ preview, busy, onConfirm, onCancel }: {
  preview: ImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="settings-info">
      {/* FIRST, and an alert: this is the sentence that decides whether the
          user keeps the file they restored from (D11a). */}
      {preview.blocking && <div className="error-msg" role="alert">{preview.blocking}</div>}
      <div><strong>{preview.headline}</strong></div>
      {preview.body.map(line => <div key={line}>{line}</div>)}
      {preview.issues.map(issue => (
        // Blocking ones are ALERTS: those records are not restored by this
        // import, so a user who deletes the file afterwards deletes the only
        // copy of them. The rest are prose — true, but not decision-changing.
        <div
          key={issue.text}
          className={issue.blocking ? 'error-msg' : undefined}
          role={issue.blocking ? 'alert' : undefined}
        >
          {issue.text}
        </div>
      ))}
      <div className="backup-actions">
        <button type="button" className="btn btn-primary full-width" onClick={onConfirm} disabled={busy}>
          {busy ? 'Восстанавливаем…' : 'Восстановить из файла'}
        </button>
        <button type="button" className="btn btn-ghost full-width" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/** Three lines by what the user did, not eleven internal counters (§7). */
function ImportResult({ summary }: { summary: ImportSummary }) {
  return (
    <div className="settings-info">
      {summary.blocking && <div className="error-msg" role="alert">{summary.blocking}</div>}
      {summary.storeIncomplete && (
        <div className="error-msg" role="alert">{summary.storeIncomplete}</div>
      )}
      <div role="status">{summary.restored}</div>
      {summary.notApplied && <div className="error-msg" role="alert">{summary.notApplied}</div>}
      {summary.notAppliedReasons && (
        // Behind a disclosure, not in the alert: the headline is the number,
        // and the reasons are what the user opens when they want to know what
        // to DO — the three of them have three different answers.
        <details className="backup-reasons">
          <summary>Почему не восстановлено</summary>
          <ul>
            {summary.notAppliedReasons.map(reason => (
              <li key={reason.label}>
                <strong>{reason.label}: {reason.count}.</strong> {reason.advice}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.retryable && <div>{summary.retryable}</div>}
      {summary.success && <div className="text-green">{summary.success}</div>}
    </div>
  );
}
