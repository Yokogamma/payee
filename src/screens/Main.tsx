import { useState, useRef, useEffect } from 'react';
import { useNotes } from '../lib/store';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import { SettingsSection } from './SettingsSection';
import { NoteComposer } from '../components/NoteComposer';
import { Fab } from '../components/Fab';
import { NoteMarkdown } from '../components/NoteMarkdown';
import { EditNoteModal } from '../components/EditNoteModal';
import { VersionHistoryModal, RestoreVersionDialog } from '../components/VersionHistoryModal';
import { SafeboxSection } from '../components/SafeboxSection';
import { badgeFor } from '../components/syncBadge';
import { V3_WRITER_ENABLED } from '../lib/flags';
import { useRoute, navigate, canonicalHash } from '../lib/route';
import { AppNav } from '../components/AppNav';
import { StatusLine } from '../components/StatusLine';
import type { ThemePref } from '../lib/theme';
import { copyTextToClipboard } from '../lib/clipboard';
import { subscribeToPwaUpdate, applyPwaUpdate } from '../lib/pwa';
import type { NoteData } from '../lib/crypto';

// Draft survives an accidental tab close / PWA eviction, ENCRYPTED at rest
// (draft.ts envelope, keyed to the current vault). The store owns the
// storage/crypto; this screen only hydrates on mount and mirrors edits.
// The feed shows one card per version CHAIN (chains/filteredChains); the raw
// per-version list still backs search counters and reset accounting.

/** Long-content clamp heuristic for feed cards. */
function isLongNote(text: string): boolean {
  return text.length > 600 || text.split('\n').length > 12;
}

interface MainProps {
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
}

export function Main({ theme, onThemeChange }: MainProps) {
  const {
    filteredChains,
    chains,
    isEncrypting,
    searchQuery,
    addNote,
    editNote,
    setSearchQuery,
    arweave,
    retrySync,
    pinSetupNotice,
    dismissPinSetupNotice,
    syncStatuses,
    persistDraft,
    readDraft,
    clearDraft,
    safeboxPinConfigured,
    safeboxDataPresent,
    safeboxLockGeneration,
  } = useNotes();

  // The section lives in the address, not in local state: the Android system
  // Back gesture and a reload both have to land where the user was. `hash` is
  // kept alongside `view` because the canonicaliser below needs to see a
  // change that `view` alone would hide (`#/notes` → `#/garbage` parses to the
  // same section).
  const { hash, section: view } = useRoute();
  // The safebox item is ALWAYS in the nav — the visibility formula is gone.
  // A section that appears and disappears makes the layout jump the moment a
  // user activates it, and it hid the only route to activation. It is dimmed
  // (never disabled) while there is nothing behind it yet.
  const safeboxDimmed = !safeboxPinConfigured && !safeboxDataPresent;
  const notesVisible = view === 'notes';

  const [text, setText] = useState('');
  // Blocks the persist mirror from CLEARING the stored draft while the initial
  // hydration read is still in flight (text starts '' — a 300ms debounce could
  // otherwise wipe the very draft being decrypted).
  const draftSettledRef = useRef(false);
  // True after ANY user edit. `text === ''` alone cannot distinguish a pristine
  // composer from «набрал и стёр» — hydration must lose to both (§2 dirty guard).
  const draftDirtyRef = useRef(false);
  // The composer is collapsed by default — it used to occupy the top of the
  // screen permanently, competing with the feed for the only vertical space a
  // phone has.
  const [composerOpen, setComposerOpen] = useState(false);
  // Set by an explicit «Свернуть». Blocks auto-expansion until the user LEAVES
  // and re-enters the section; without it a manually collapsed composer would
  // re-open by itself as soon as hydration resolves.
  const userCollapsedRef = useRef(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<'ok' | 'fail' | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  // Edit/history/restore UI (W3). Only ONE aria-modal layer at a time: opening
  // the restore confirm CLOSES the history modal; cancelling reopens history
  // with focus restored onto the same version row.
  const [editChainRoot, setEditChainRoot] = useState<string | null>(null);
  const [historyChainRoot, setHistoryChainRoot] = useState<string | null>(null);
  const [historyFocusVersionId, setHistoryFocusVersionId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ root: string; version: NoteData } | null>(null);

  // PWA update toast (Phase 8): the waiting SW activates only on user consent.
  useEffect(() => subscribeToPwaUpdate(setUpdateReady), []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const menuBtnRefs = useRef(new Map<string, HTMLButtonElement>());

  // The «Получено с других устройств» toast and its handled-run bookkeeping are
  // gone. They existed for ONE reason, stated in their own comment: the result
  // was shown in two places, and the toast had to avoid popping out of context
  // when the settings panel closed. With one always-visible status line there
  // is no second place, so there is nothing to reconcile.

  // ── Composer open/collapse ──────────────────────────────────────
  //
  // Presence of a draft is `text.length > 0`, NOT `text.trim()`: DraftStore
  // clears storage only on an exactly-empty string, so a draft of whitespace
  // really is stored. With trim() the indicator would go dark and the composer
  // would stay shut over a draft that exists.
  const hasDraft = text.length > 0;
  const wasNotesVisible = useRef(notesVisible);

  useEffect(() => {
    const entered = notesVisible && !wasNotesVisible.current;
    wasNotesVisible.current = notesVisible;
    // Re-entering the section is a fresh intent — an earlier «Свернуть» does
    // not follow the user around forever.
    if (entered) userCollapsedRef.current = false;
    // Covers BOTH the return-with-a-draft case and the one that only shows up
    // in practice: hydration is async, so on the first render `text` is still
    // empty and this effect has to fire again when the draft lands.
    if (notesVisible && hasDraft && !userCollapsedRef.current) setComposerOpen(true);
  }, [notesVisible, hasDraft]);

  function openComposer() {
    userCollapsedRef.current = false;
    setComposerOpen(true);
    // Focus ONLY on an explicit press. Doing it on auto-expansion would pop the
    // mobile keyboard every time the user merely returns to the section.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function collapseComposer() {
    // Never clears `text`: collapsing hides, it does not discard. Clearing here
    // would let the debounced mirror persist '' and DELETE the stored draft.
    userCollapsedRef.current = true;
    setComposerOpen(false);
  }

  // Focus follows the section. Losing the modal's «focus returns to the
  // trigger» is fine, but a routed section with no focus management drops a
  // keyboard or screen-reader user at the top of the document with nothing
  // announced. This is the invariant that replaces the focus trap.
  //
  // A DOM query rather than three threaded refs: the sections are independent
  // components and the shared class is the contract between them.
  const firstSectionRender = useRef(true);
  useEffect(() => {
    // Not on the very first render — that would steal focus at app start.
    if (firstSectionRender.current) { firstSectionRender.current = false; return; }
    (document.querySelector('.main-content .section-title') as HTMLElement | null)?.focus();
  }, [view]);

  // Canonicalise the address. An empty hash (first load, or an old build that
  // never wrote one) and an unknown hash (typo, or a section a newer build had
  // and this one does not) both PARSE to the default — this rewrites the bar to
  // match what is actually on screen, so the two can never disagree.
  //
  // Keyed on the RAW hash: `#/notes → #/garbage` leaves `view` unchanged, and
  // an effect watching only `view` would never run.
  //
  // `replace`, not push: a junk entry the user never chose must not become a
  // stop on the way back.
  useEffect(() => {
    if (hash !== canonicalHash(view)) navigate(view, { replace: true });
  }, [hash, view]);

  // Hydrate the encrypted draft on mount — dirty-guarded (§2): it only fills a
  // composer the user has NOT touched (typing and deleting counts as touched),
  // and an unmount (lock!) cancels the application entirely.
  useEffect(() => {
    let cancelled = false;
    void readDraft()
      .then(draft => {
        if (cancelled) return;
        draftSettledRef.current = true;
        if (draft && !draftDirtyRef.current) setText(prev => (prev === '' ? draft : prev));
      })
      .catch(() => { draftSettledRef.current = true; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the draft (debounced, encrypted at rest) so it survives a reload.
  // An empty text clears the draft. Skipped only for the PRISTINE pre-hydration
  // emptiness — a user who typed and deleted everything intends a clear.
  useEffect(() => {
    if (!draftSettledRef.current && !draftDirtyRef.current && text === '') return;
    const t = setTimeout(() => {
      void persistDraft(text);
    }, 300);
    return () => clearTimeout(t);
  }, [text, persistDraft]);

  async function handleSave() {
    if (!text.trim() || isEncrypting) return;
    setSaveError('');
    try {
      await addNote(text);
    } catch (err) {
      const outcome = classifySaveError(err, SAVE_FALLBACK.add);
      // in_flight: a double submit raced past the disabled button — the FIRST
      // call owns the outcome, change nothing. Otherwise the note is still in
      // the input; show why and never let it silently vanish.
      if (outcome.kind === 'message') setSaveError(outcome.text);
      return;
    }
    setText('');
    clearDraft(); // don't wait out the debounce (also invalidates in-flight persists)
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
    setComposerOpen(false);
    userCollapsedRef.current = false; // saved, not dismissed
  }

  function formatDate(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();

    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;

    const isThisYear = d.getFullYear() === now.getFullYear();
    const day = d.getDate().toString().padStart(2, '0');
    const month = d.toLocaleString('ru', { month: 'short' });

    if (isThisYear) return `${day} ${month}`;
    return `${day} ${month} ${d.getFullYear()}`;
  }

  /** Clipboard write with visible success/error feedback — a rejected promise
   *  must not look identical to a successful copy. On failure the menu stays
   *  open so the text can still be selected manually. */
  async function handleCopyNote(noteText: string) {
    if (await copyTextToClipboard(noteText)) {
      setOpenMenuId(null);
      setCopyFeedback('ok');
    } else {
      setCopyFeedback('fail');
    }
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  /** Wrap query matches in <mark> (8.1) — case-insensitive, plain text only.
   *  While a query is active, EVERY card renders as plain text through this
   *  (markdown rendering resumes when the search closes) — injecting <mark>
   *  into the react-markdown element tree is not worth the fragility. */
  function highlight(noteText: string, query: string): React.ReactNode {
    const q = query.trim();
    if (!q) return noteText;
    const lower = noteText.toLowerCase();
    const ql = q.toLowerCase();
    const parts: React.ReactNode[] = [];
    let i = 0;
    let idx: number;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) parts.push(noteText.slice(i, idx));
      parts.push(<mark key={idx}>{noteText.slice(idx, idx + q.length)}</mark>);
      i = idx + q.length;
    }
    parts.push(noteText.slice(i));
    return parts;
  }

  function toggleExpanded(root: string) {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }

  const editChain = editChainRoot ? chains.find(c => c.root === editChainRoot) ?? null : null;
  const historyChain = historyChainRoot ? chains.find(c => c.root === historyChainRoot) ?? null : null;

  function requestRestore(version: NoteData) {
    if (!historyChainRoot) return;
    // Modal-stack discipline: close history BEFORE the confirm opens.
    setRestoreTarget({ root: historyChainRoot, version });
    setHistoryChainRoot(null);
  }

  function cancelRestore() {
    if (!restoreTarget) return;
    // Reopen history with focus back on the version row the user came from.
    setHistoryFocusVersionId(restoreTarget.version.id);
    setHistoryChainRoot(restoreTarget.root);
    setRestoreTarget(null);
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    // Preserve the SOURCE version's fmt: restoring a plain note must not
    // re-interpret its literal *stars* as markdown forever.
    await editNote(restoreTarget.root, restoreTarget.version.text, { fmt: restoreTarget.version.fmt });
    // Success: close the whole stack, focus the card's stable ⋯ trigger (the
    // «Восстановить» button that opened this no longer exists in the DOM).
    const root = restoreTarget.root;
    setRestoreTarget(null);
    setHistoryFocusVersionId(null);
    requestAnimationFrame(() => menuBtnRefs.current.get(root)?.focus());
  }


  return (
    <div className="main-screen">
      {/* Grid areas, not a flat flex column: on a wide screen the nav becomes a
          full-height left rail, and three loose siblings would each turn into a
          column instead. Toasts and modal overlays are position:fixed, so they
          never become grid items. */}
      <div className="main-top">
        {/* One line replaces the restore banners, both pause banners, the
            offline banner, the Arweave badge, the note count and the ↻
            button. Up to three of those used to stack and push the feed. */}
        <StatusLine />

      {/* A PIN was requested during restore but is NOT the PIN of this device.
          The restore screen is long gone by now (restore switches to Main
          before the sweep), so the honest report has to live here — silence
          would leave the user believing a PIN is set. */}
      {pinSetupNotice && (
        <div className="error-banner" role="alert">
          <span>
            {pinSetupNotice === 'already-set'
              ? '⚠️ PIN уже установлен на этом устройстве (в другой вкладке) — ваш новый PIN не применён. Сменить PIN можно в настройках.'
              : '⚠️ Не удалось сохранить PIN. Вход выполнен; установите PIN в настройках.'}
          </span>
          <button
            className="banner-btn banner-close"
            onClick={dismissPinSetupNotice}
            title="Скрыть"
            aria-label="Скрыть сообщение о PIN"
          >
            ✕
          </button>
        </div>
      )}
      </div>

      <div className="main-content">
      {/* KEYED ON THE LOCK GENERATION: every section lock (including a
          hidden/pagehide edge with the section already locked) remounts the
          whole subtree, so no local secret state — a half-typed PIN, or the
          seed-reset grid holding all 12 words — can survive it. */}
      {view === 'safebox' && (
        <SafeboxSection key={safeboxLockGeneration} formatDate={formatDate} />
      )}

      {view === 'settings' && (
        <SettingsSection theme={theme} onThemeChange={onThemeChange} />
      )}

      {/* The notes section is UNMOUNTED when another section is open, not
          hidden. It could stay mounted safely — the draft lives in this shell,
          not in the composer — but a mounted feed keeps re-rendering markdown
          behind a section the user is not looking at. */}
      {notesVisible && (
      <>
      {/* «+ Заметка» used to be a full `.btn` in the header — 44px tall, with
          `min-height` and 20px of side padding, sitting where the section name
          goes. The mockup puts creation on a round button at the bottom of the
          list, within thumb reach, and gives the header back to the title. */}
      <div className="notes-topbar">
        <h2 className="section-title" tabIndex={-1}>
          {composerOpen ? 'Новая заметка' : 'Заметки'}
        </h2>
        {composerOpen && (
          <button className="btn-tiny" onClick={collapseComposer}>
            Свернуть
          </button>
        )}
      </div>

      {/* Always on screen — its own field, scoped to this section. The old
          Ctrl+K toggle is gone with the toggle it drove. */}
      <div className="search-bar">
        <input
          type="text"
          placeholder="Поиск по заметкам"
          aria-label="Поиск по заметкам"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setSearchQuery(''); }}
        />
        {searchQuery && (
          <>
            <span className="search-count">
              {filteredChains.length} из {chains.length}
            </span>
            <button className="search-clear" onClick={() => setSearchQuery('')} title="Очистить" aria-label="Очистить поиск">
              ✕
            </button>
          </>
        )}
      </div>

      {/* Draft hydration/persistence stays in the shell (value/onChange above),
          so collapsing or unmounting the composer never touches the draft. */}
      {composerOpen && (
      <div className="note-input-wrap">
        <NoteComposer
          value={text}
          onChange={next => { draftDirtyRef.current = true; setText(next); }}
          onSubmit={() => void handleSave()}
          submitLabel="Сохранить"
          submitBusyLabel="Сохраняем…"
          busy={isEncrypting}
          placeholder="Быстрая заметка..."
          markdown={V3_WRITER_ENABLED}
          textareaRef={inputRef}
          error={saveError}
          hint={justSaved
            ? '✓ Сохранено и зашифровано'
            : <span className="kbd-hint">Ctrl+Enter — сохранить</span>}
        />
      </div>
      )}

      {/* Feed — one card per version chain; fields come from chain.current. */}
      <div className="notes-feed">
        {filteredChains.length === 0 && !searchQuery ? (
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <p>Первая заметка — самая важная.</p>
            <p className="empty-sub">Просто начните печатать.</p>
          </div>
        ) : filteredChains.length === 0 && searchQuery ? (
          <div className="empty-state">
            <p>Ничего не найдено по «{searchQuery}»</p>
          </div>
        ) : (
          filteredChains.map(chain => {
            const note = chain.current;
            // Sync info is derived UNCONDITIONALLY — a confirmed TX stays
            // linkable from the menu even with auto-sync switched off; the
            // enabled flag gates only the live status badge.
            const info = syncStatuses[note.id] ?? { status: 'queued' as const };
            const badge = badgeFor(info, arweave.enabled && arweave.registered);
            const long = isLongNote(note.text);
            const expanded = expandedCards.has(chain.root);
            const clamped = long && !expanded;
            return (
              <div className="note-card" key={chain.root}>
                <div className={`note-text ${clamped ? 'note-text--clamped' : ''}`}>
                  {note.fmt === 'md' && !searchQuery.trim()
                    ? <NoteMarkdown text={note.text} />
                    : highlight(note.text, searchQuery)}
                </div>
                {long && (
                  <button className="note-expand-btn" onClick={() => toggleExpanded(chain.root)}>
                    {expanded ? 'Свернуть' : 'Развернуть'}
                  </button>
                )}
                <div className="note-meta">
                  <span className="note-time">{formatDate(note.createdAt)}</span>
                  {chain.versions.length > 1 && (
                    <span
                      className="note-rev-badge"
                      title={`Версий: ${chain.versions.length}`}
                      aria-label={`Версий: ${chain.versions.length}`}
                    >
                      v{chain.versions.length}
                    </span>
                  )}
                  {badge && info && (
                    info.status === 'error' && arweave.enabled && arweave.registered ? (
                      <button
                        className={`sync-badge ${badge.className}`}
                        onClick={retrySync}
                        title={badge.label}
                        aria-label={badge.label}
                      >
                        {badge.icon} повторить
                      </button>
                    ) : (
                      <span
                        className={`sync-badge ${badge.className}`}
                        title={badge.label}
                        role="status"
                        aria-label={badge.label}
                      >
                        {badge.icon}
                      </span>
                    )
                  )}
                  <span className="note-lock" aria-hidden="true">🔒</span>
                  <button
                    ref={el => {
                      if (el) menuBtnRefs.current.set(chain.root, el);
                      else menuBtnRefs.current.delete(chain.root);
                    }}
                    className="icon-btn icon-btn--ring note-menu-btn"
                    onClick={() => setOpenMenuId(openMenuId === chain.root ? null : chain.root)}
                    title="Меню заметки"
                    aria-label="Меню заметки"
                    aria-expanded={openMenuId === chain.root}
                  >
                    ⋯
                  </button>
                </div>
                {openMenuId === chain.root && (
                  <div className="note-menu">
                    <button
                      className="note-menu-item"
                      onClick={() => void handleCopyNote(note.text)}
                    >
                      📋 Копировать текст
                    </button>
                    {V3_WRITER_ENABLED && (
                      <button
                        className="note-menu-item"
                        onClick={() => { setOpenMenuId(null); setEditChainRoot(chain.root); }}
                      >
                        ✏️ Редактировать
                      </button>
                    )}
                    {V3_WRITER_ENABLED && chain.versions.length > 1 && (
                      <button
                        className="note-menu-item"
                        onClick={() => {
                          setOpenMenuId(null);
                          setHistoryFocusVersionId(null);
                          setHistoryChainRoot(chain.root);
                        }}
                      >
                        🕓 История версий ({chain.versions.length})
                      </button>
                    )}
                    {info?.status === 'confirmed' && info.txId && (
                      <a
                        className="note-menu-item"
                        href={`https://viewblock.io/arweave/tx/${info.txId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpenMenuId(null)}
                      >
                        🔗 Транзакция в блокчейне
                      </a>
                    )}
                    <div className="note-menu-hint">
                      {V3_WRITER_ENABLED
                        ? 'Каждая версия навсегда сохраняется в блокчейне: редактирование добавляет новую версию, старые остаются в истории. Удалить опубликованные данные невозможно.'
                        : 'Опубликованная в блокчейне копия неизменяема: её нельзя отредактировать или удалить.'}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {!composerOpen && (
        // The dot is the only thing standing between a collapsed composer and
        // silently hiding an unsaved draft.
        <Fab
          label={hasDraft ? 'Новая заметка, есть несохранённый черновик' : 'Новая заметка'}
          onClick={openComposer}
          marked={hasDraft}
        />
      )}
      </>
      )}
      </div>

      {/* PWA update toast (Phase 8): controlled activation, never silent */}
      {updateReady && !updateDismissed && (
        <div className="toast toast--update" role="status">
          <span>Доступна новая версия приложения</span>
          <button className="banner-btn" onClick={applyPwaUpdate}>Обновить</button>
          <button
            className="banner-btn banner-close"
            onClick={() => setUpdateDismissed(true)}
            title="Позже"
            aria-label="Отложить обновление"
          >
            ✕
          </button>
        </div>
      )}

      {/* Prominent save confirmation (2.5) */}
      {justSaved && (
        <div className="toast toast--success" role="status">
          ✓ Сохранено и зашифровано
        </div>
      )}


      {/* Clipboard feedback — success and failure must look different */}
      {copyFeedback === 'ok' && (
        <div className="toast toast--success" role="status">✓ Скопировано</div>
      )}
      {copyFeedback === 'fail' && (
        <div className="toast toast--error" role="alert">
          Не удалось скопировать — выделите текст вручную
        </div>
      )}


      {/* Settings Modal (extracted — 7.3) */}
      {/* Derived from the route, not from its own boolean: with two sources of
          truth the address, the Back gesture and the panel drift apart, which
          is the very confusion this redesign removes. Becomes a real section in
          stage 4; the modal is the intermediate. */}



      {/* W3: edit + history + restore-version (one aria-modal layer at a time) */}
      <EditNoteModal
        open={editChain !== null}
        chain={editChain}
        onClose={() => setEditChainRoot(null)}
        onSave={(rootId, newText) => editNote(rootId, newText)}
      />

      <VersionHistoryModal
        open={historyChain !== null && restoreTarget === null}
        chain={historyChain}
        syncStatuses={syncStatuses}
        syncActive={arweave.enabled && arweave.registered}
        onClose={() => { setHistoryChainRoot(null); setHistoryFocusVersionId(null); }}
        onRequestRestore={requestRestore}
        focusVersionId={historyFocusVersionId}
        formatDate={formatDate}
      />

      <RestoreVersionDialog
        open={restoreTarget !== null}
        version={restoreTarget?.version ?? null}
        onConfirm={confirmRestore}
        onCancel={cancelRestore}
      />

      <AppNav safeboxDimmed={safeboxDimmed} />
    </div>
  );
}
