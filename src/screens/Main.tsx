import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useNotes } from '../lib/store';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import { SettingsSection } from './SettingsSection';
import { NoteComposer } from '../components/NoteComposer';
import { Fab } from '../components/Fab';
import { NoteMarkdown } from '../components/NoteMarkdown';
import { NotePreview } from '../components/NotePreview';
import { EditNoteModal } from '../components/EditNoteModal';
import { VersionHistoryModal, RestoreVersionDialog } from '../components/VersionHistoryModal';
import { SafeboxSection } from '../components/SafeboxSection';
import { badgeFor } from '../components/syncBadge';
import { SyncStateBadge } from '../components/SyncStateBadge';
import { CardMenu } from '../components/CardMenu';
import { formatNoteDate, formatNoteDateFull } from '../lib/format-date';
import { noteSearchText } from '../lib/note-search-text';
import { IconCopy, IconEdit, IconHistory, IconLink, IconClose, IconNote, IconChevronLeft } from '../components/icons';
import { V3_WRITER_ENABLED } from '../lib/flags';
import { useRoute, navigate, canonicalHash, type RouteHistoryState } from '../lib/route';
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

/* The long-note heuristic that used to live here is gone. It guessed from the
   raw markdown source (`length > 600 || lines > 12`), which is wrong in both
   directions — a note long only because of table pipes clamped though it
   rendered short. The preview now MEASURES its rendered height; see
   `useTruncation`. `expandedCards` went with it: there is nothing to expand in
   the feed any more, the note opens. */

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
    v3Paused,
    safeboxLockGeneration,
    restoring,
  } = useNotes();

  // The section lives in the address, not in local state: the Android system
  // Back gesture and a reload both have to land where the user was. `hash` is
  // kept alongside `view` because the canonicaliser below needs to see a
  // change that `view` alone would hide (`#/notes` → `#/garbage` parses to the
  // same section).
  const { hash, section: view, param } = useRoute();
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
  /**
   * The note being read, resolved from the ADDRESS.
   *
   * Against `chains`, never `filteredChains`: an active search must not close
   * a note that is already open. A param that resolves to nothing (a stale
   * link, a chain quarantined while it was open) simply leaves `readingRoot`
   * null, and the canonicaliser below strips it from the bar — no second
   * redirect effect.
   */
  const readingChain = param && view === 'notes' ? chains.find(c => c.root === param) ?? null : null;
  const readingRoot = readingChain?.root ?? null;
  const reading = readingChain !== null;
  /* Derived at the top level, not inside the JSX: reading `chain.current`
     inside a callback is what react-hooks/refs flags by property name. */
  const readingNote = readingChain?.current ?? null;
  const readingInfo = readingNote
    ? syncStatuses[readingNote.id] ?? { status: 'queued' as const }
    : null;
  // FULL SCREEN, and by UNMOUNTING the rest — not by hiding it.
  //
  // The mockup gives writing the whole screen: no status line, no search, no
  // feed, no FAB, no tab bar. Hiding those visually would leave every one of
  // them in the tab order and in the accessibility tree, so a keyboard user
  // would tab from the composer into a feed they cannot see.
  //
  // It is a GRID STATE, not an overlay. `.lock-gate` sits at z-index 100 and
  // beats every modal on source order; a composer layered above it would put
  // plaintext over the privacy gate — see the note in AppNav.
  //
  // READING WINS OVER WRITING. Both are fullscreen grid states, and without
  // the `!reading` guard they can be true at once: a cold start on
  // `#/notes/<root>` with a stored draft renders the composer (the auto-expand
  // effect fires on hydration) AND the reader, both subtrees at the same time.
  // The composer is restored, draft intact, on the way back.
  const composing = view === 'notes' && composerOpen && !reading;
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
  /**
   * One ref object per card's ⋯ trigger, handed to CardMenu and reused by
   * `confirmRestore` to land focus after the modal stack closes.
   *
   * Created lazily and CACHED: a fresh `{ current: null }` on every render
   * would hand CardMenu a new object each time, and the ref the restore flow
   * reads would never be the one React filled in.
   */
  const menuBtnRefs = useRef(new Map<string, React.RefObject<HTMLButtonElement | null>>());
  function menuTriggerRef(root: string) {
    let ref = menuBtnRefs.current.get(root);
    if (!ref) {
      ref = { current: null };
      menuBtnRefs.current.set(root, ref);
    }
    return ref;
  }

  /** Same pattern, same reason, for the card's open control: leaving a note
   *  lands focus back on the card it came from. */
  const previewBtnRefs = useRef(new Map<string, React.RefObject<HTMLButtonElement | null>>());
  function previewTriggerRef(root: string) {
    let ref = previewBtnRefs.current.get(root);
    if (!ref) {
      ref = { current: null };
      previewBtnRefs.current.set(root, ref);
    }
    return ref;
  }

  /**
   * Generation token for the restore flow.
   *
   * `confirmRestore` awaits `editNote` and then, unconditionally, closes the
   * dialogs and moves focus. If the user left in the meantime — Back out of the
   * note, or a section switch — the feed is mounted again by the time that
   * resolves, so the late tail would yank focus off the card and onto its ⋯
   * button. The WRITE is never cancelled; only its tail is invalidated.
   */
  const restoreOpRef = useRef(0);

  /** The feed's scroll position across a trip into a note (it unmounts). */
  const feedElRef = useRef<HTMLDivElement | null>(null);
  const feedScrollRef = useRef(0);
  /**
   * Armed by `openNote`, disarmed by the restore. WITHOUT IT the position is
   * replayed on every composer close as well — the feed unmounts for the
   * composer too — so saving a note dropped the user back at the offset some
   * earlier note-open had recorded, while the note they just wrote sat at the
   * top of the list off-screen.
   */
  const restoreFeedScrollRef = useRef(false);

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

  /**
   * Where this note is about to live, said plainly.
   *
   * Going fullscreen unmounts the status line, so this sentence is the ONLY
   * thing left that can answer it — which means it has to answer for every
   * state the status line would have covered, not just the easy two.
   *
   * `v3Paused` is the one that hides: sync is on, the key is registered, and
   * the upload queue is still stopped until the user resumes it by hand. A
   * text that only checked enabled/registered promised the blockchain in
   * exactly the state where nothing is being sent — see the matching rung in
   * StatusLine, which is the warning this paragraph replaces on this screen.
   *
   * Three ways to stay local, and they are NOT interchangeable. Collapsing the
   * unregistered case into «синхронизация выключена» was accurate about the
   * outcome and wrong about the cause: sync is on, and what is missing is an
   * invite code — which is a thing the user can go and fix, unlike a switch
   * they deliberately turned off. A destination line that misnames the reason
   * sends them to the wrong screen.
   */
  const composerDestination = !arweave.enabled
    ? 'Синхронизация выключена — запись останется только на этом устройстве.'
    : !arweave.registered
      ? 'Устройство не подключено к хранилищу — до ввода invite-кода запись останется только на нём.'
      : v3Paused
        ? 'Загрузка приостановлена — запись останется на устройстве до возобновления.'
        : 'Она отправится в блокчейн и станет вечной после подтверждения сети.';

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

  /**
   * Leaving the fullscreen composer takes the pressed button with it, so focus
   * has to be placed deliberately — otherwise it lands on `<body>` and a
   * keyboard user loses their position in an interface that just replaced
   * itself entirely. The FAB is the right landing: it is what reopens the
   * composer, so the user is left holding the door they came through.
   *
   * Through a REF, not `document.querySelector('.fab')`. The safebox renders a
   * FAB too, and a save is async: if the route changes while one is in flight
   * — a Back gesture, a hash edit — the global lookup would find the safebox's
   * button and yank focus off the safebox heading that had just claimed it.
   * With a ref, an unmounted notes FAB is simply `null` and nothing moves.
   */
  const notesFabRef = useRef<HTMLButtonElement | null>(null);

  function focusFabAfterCollapse() {
    requestAnimationFrame(() => notesFabRef.current?.focus());
  }

  function collapseComposer() {
    // Never clears `text`: collapsing hides, it does not discard. Clearing here
    // would let the debounced mirror persist '' and DELETE the stored draft.
    userCollapsedRef.current = true;
    setComposerOpen(false);
    focusFabAfterCollapse();
  }

  // Focus follows the section. Losing the modal's «focus returns to the
  // trigger» is fine, but a routed section with no focus management drops a
  // keyboard or screen-reader user at the top of the document with nothing
  // announced. This is the invariant that replaces the focus trap.
  //
  // A DOM query rather than three threaded refs: the sections are independent
  // components and the shared class is the contract between them.
  const firstSectionRender = useRef(true);
  const prevReadingRootRef = useRef<string | null>(null);
  useEffect(() => {
    const leftReading = prevReadingRootRef.current;
    prevReadingRootRef.current = readingRoot;
    // Not on the very first render — that would steal focus at app start,
    // including a cold start straight into a note.
    if (firstSectionRender.current) { firstSectionRender.current = false; return; }
    // Coming BACK from a note: focus the card it was opened from, not the
    // section title. Same contract as the modal stack — the control that
    // started the trip gets the focus that ends it.
    if (!readingRoot && leftReading) {
      const back = previewBtnRefs.current.get(leftReading)?.current;
      if (back) { back.focus(); return; }
    }
    (document.querySelector('.main-content .section-title') as HTMLElement | null)?.focus();
  }, [view, readingRoot]);

  /**
   * A route transition closes every modal and DISCARDS its unwritten buffer.
   *
   * The three dialogs render as unconditional siblings at the end of this
   * component, outside the routed section, and none of them listens to
   * `popstate`. Without this, Back out of a note would leave an edit dialog
   * standing over the restored feed — and today the same thing already happens
   * when the section changes, which this closes too.
   *
   * `useLayoutEffect`, not `useEffect`: a passive one would let a frame paint
   * with the dialog still on top of the feed.
   */
  const routeKey = `${view}|${readingRoot ?? ''}`;
  const [modalRouteKey, setModalRouteKey] = useState(routeKey);
  if (modalRouteKey !== routeKey) {
    // ADJUSTED DURING RENDER, not in an effect — the same shape EditNoteModal
    // uses to re-prefill per chain. An effect would paint one frame with the
    // dialog still standing over the restored feed, and React flags the
    // cascading re-render it causes.
    setModalRouteKey(routeKey);
    setEditChainRoot(null);
    setHistoryChainRoot(null);
    setHistoryFocusVersionId(null);
    setRestoreTarget(null);
    setOpenMenuId(null);
  }

  // Invalidate any restore still in flight: the WRITE is never cancelled, but
  // its UI tail must not steal focus after we have left. See `confirmRestore`.
  // In an effect rather than in the block above, because a ref may not be
  // touched during render — and an effect is early enough regardless: the tail
  // it guards resolves on a later task, never between render and effect.
  useEffect(() => {
    restoreOpRef.current++;
  }, [view, readingRoot]);

  /**
   * Put the feed back where it was standing.
   *
   * The feed UNMOUNTS while a note is open, so its scroll position is not
   * preserved for us. A layout effect, not `requestAnimationFrame`: the jump
   * is visible for one frame otherwise. The card heights it scrolls against
   * are already final — `useTruncation` measures in a layout effect of its
   * own, and children run before parents.
   */
  useLayoutEffect(() => {
    // Not mounted yet — and the arming flag is deliberately left alone, so a
    // Back that lands in the composer (a stored draft re-expands it) still
    // restores once the composer closes.
    if (reading || composing) return;
    const el = feedElRef.current;
    if (el && restoreFeedScrollRef.current && feedScrollRef.current > 0) {
      el.scrollTop = feedScrollRef.current;
    }
    restoreFeedScrollRef.current = false;
  }, [reading, composing]);

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
  //
  // It is also the ONLY place a bad note id is dealt with: `readingRoot` is
  // null for a param that resolves to nothing, so the same line strips it.
  // While a restore sweep is still filling the store, though, an id that has
  // not arrived YET is not the same as a bad one — the address is held until
  // the sweep ends, or the deep link would bounce out from under the user.
  useEffect(() => {
    if (restoring && param && !readingRoot) return;
    const wanted = view === 'notes' ? readingRoot : null;
    if (hash !== canonicalHash(view, wanted)) navigate(view, { replace: true, param: wanted });
  }, [hash, view, param, readingRoot, restoring]);

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
    // Same reason as «Свернуть»: the save button unmounts under the press.
    focusFabAfterCollapse();
  }

  /** Clipboard write with visible success/error feedback — a rejected promise
   *  must not look identical to a successful copy. On failure the menu stays
   *  open so the text can still be selected manually. */
  /** Returns `false` on failure, which CardMenu reads as «keep the menu open»
   *  — the fallback for a rejected clipboard write is selecting the text by
   *  hand, and that needs the note still on screen. */
  async function handleCopyNote(noteText: string): Promise<void | false> {
    const ok = await copyTextToClipboard(noteText);
    setCopyFeedback(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyFeedback(null), 2000);
    return ok ? undefined : false;
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

  /** Open a note: push an entry so the system Back gesture closes it, and
   *  remember where the feed was standing. */
  function openNote(root: string) {
    feedScrollRef.current = feedElRef.current?.scrollTop ?? 0;
    restoreFeedScrollRef.current = true;
    navigate('notes', { param: root });
  }

  /**
   * Leave the note.
   *
   * NOT a bare `history.back()`: on a cold start into `#/notes/<root>` the
   * entry behind us belongs to another site, and Back would leave the app.
   * NOT a bare `navigate` either: over an entry WE pushed that would grow the
   * stack the user then has to Back through twice. `enSection` — written on
   * every entry this app creates since before the reader existed — is what
   * tells the two apart, and this is its first real reader.
   */
  function closeNote() {
    const state = window.history.state as RouteHistoryState | null;
    if (state?.enSection === true) window.history.back();
    else navigate('notes', { replace: true });
  }

  const editChain = editChainRoot ? chains.find(c => c.root === editChainRoot) ?? null : null;
  const historyChain = historyChainRoot ? chains.find(c => c.root === historyChainRoot) ?? null : null;

  function requestRestore(version: NoteData) {
    if (!historyChainRoot) return;
    // A NEW flow invalidates the previous one's tail — otherwise a restore the
    // user backed out of could still steal focus from the one they started
    // instead.
    restoreOpRef.current++;
    // Modal-stack discipline: close history BEFORE the confirm opens.
    setRestoreTarget({ root: historyChainRoot, version });
    setHistoryChainRoot(null);
  }

  function cancelRestore() {
    if (!restoreTarget) return;
    restoreOpRef.current++;
    // Reopen history with focus back on the version row the user came from.
    setHistoryFocusVersionId(restoreTarget.version.id);
    setHistoryChainRoot(restoreTarget.root);
    setRestoreTarget(null);
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    const op = ++restoreOpRef.current;
    // Preserve the SOURCE version's fmt: restoring a plain note must not
    // re-interpret its literal *stars* as markdown forever.
    await editNote(restoreTarget.root, restoreTarget.version.text, { fmt: restoreTarget.version.fmt });
    // Success: close the whole stack, focus the card's stable ⋯ trigger (the
    // «Восстановить» button that opened this no longer exists in the DOM).
    const root = restoreTarget.root;
    // The write is done and permanent. Everything below is UI, and it belongs
    // to a flow the user may already have left — see `restoreOpRef`.
    if (op !== restoreOpRef.current) return;
    setRestoreTarget(null);
    setHistoryFocusVersionId(null);
    requestAnimationFrame(() => {
      // Re-checked inside the frame: the cleanup effect can fire between the
      // state updates above and this callback.
      if (op === restoreOpRef.current) menuBtnRefs.current.get(root)?.current?.focus();
    });
  }


  return (
    <div className={`main-screen${composing ? ' main-screen--composing' : ''}${reading ? ' main-screen--reading' : ''}`}>
      {/* Grid areas, not a flat flex column: on a wide screen the nav becomes a
          full-height left rail, and three loose siblings would each turn into a
          column instead. Toasts and modal overlays are position:fixed, so they
          never become grid items. */}
      {!composing && !reading && (
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
              ? 'PIN уже установлен на этом устройстве (в другой вкладке) — ваш новый PIN не применён. Сменить PIN можно в настройках.'
              : 'Не удалось сохранить PIN. Вход выполнен; установите PIN в настройках.'}
          </span>
          <button
            className="banner-btn banner-close"
            onClick={dismissPinSetupNotice}
            title="Скрыть"
            aria-label="Скрыть сообщение о PIN"
          >
            <IconClose />
          </button>
        </div>
      )}
      </div>
      )}

      <div className="main-content">
      {/* KEYED ON THE LOCK GENERATION: every section lock (including a
          hidden/pagehide edge with the section already locked) remounts the
          whole subtree, so no local secret state — a half-typed PIN, or the
          seed-reset grid holding all 12 words — can survive it. */}
      {view === 'safebox' && (
        <SafeboxSection key={safeboxLockGeneration} />
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
      {/* READING HAS ITS OWN HEADER, and the difference is not cosmetic.
          «Свернуть» sits on the RIGHT because it cancels what you are doing;
          a return to the list is NAVIGATION and belongs on the left, where
          every platform puts it. Reading also has no need for the word
          «Заметка» — the date is what names this particular entry, so the date
          IS the screen title: same 15px as the back control, quiet in tone
          because it labels rather than leads. */}
      {reading && readingNote ? (
        <div className="notes-topbar notes-topbar--reading">
          <button className="btn btn-ghost note-back" onClick={closeNote}>
            <IconChevronLeft />
            Заметки
          </button>
          <span className="note-meta-gap" />
          <h2 className="section-title note-reader-title" tabIndex={-1}>
            {formatNoteDate(readingNote.createdAt)}
          </h2>
        </div>
      ) : (
      <div className="notes-topbar">
        <h2 className="section-title" tabIndex={-1}>
          {composing ? 'Новая заметка' : 'Заметки'}
        </h2>
        {composing && (
          <button className="btn btn-ghost" onClick={collapseComposer}>
            Свернуть
          </button>
        )}
      </div>
      )}

      {composing && (
        // TWO SENTENCES, and only the first is unconditional.
        //
        // The mockup prints «Запись сохранится навечно» flat, and for one
        // commit so did this. That is false with sync off — the note stays on
        // this device — and false-until-`confirmed` with sync on. It was also
        // the worst possible place to overpromise: going fullscreen unmounts
        // the status line, so this paragraph is the ONLY thing on screen that
        // could have told the user where their note is about to live.
        <p className="composer-intro">
          Запись нельзя удалить — только дополнить новой версией.{' '}
          {composerDestination}
        </p>
      )}

      {/* The composer takes the whole screen, so the search field goes with the
          feed it filters. */}
      {!composing && !reading && (
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
              <IconClose />
            </button>
          </>
        )}
      </div>
      )}

      {/* Draft hydration/persistence stays in the shell (value/onChange above),
          so collapsing or unmounting the composer never touches the draft. */}
      {composing && (
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
            ? 'Сохранено и зашифровано'
            : <span className="mono">зашифровано · AES-256</span>}
        />
      </div>
      )}

      {/* Reading one note, full screen. The chain is re-resolved on every
          render rather than snapshotted into state, so a version arriving from
          sync — or a restore performed right here — updates the text and the
          version count under the reader instead of going stale. */}
      {reading && readingChain && readingNote && readingInfo && (
          <>
            {/* FACTS ONLY. The date left this row for the header, the ⋯ menu
                left for the action bar; what remains states where the note
                lives. The transaction link belongs here for the same reason —
                it answers «where is it», not «what can I do». */}
            <div className="note-reader-meta">
              <SyncStateBadge
                badge={badgeFor(readingInfo, arweave.enabled && arweave.registered)}
                onRetry={
                  readingInfo.status === 'error' && arweave.enabled && arweave.registered
                    ? retrySync
                    : undefined
                }
              />
              {readingChain.versions.length > 1 && (
                <span className="state state--quiet">
                  {readingChain.versions.length}-я версия
                </span>
              )}
              <span className="note-meta-gap" />
              {readingInfo.status === 'confirmed' && readingInfo.txId && (
                <a
                  className="note-reader-tx"
                  href={`https://viewblock.io/arweave/tx/${readingInfo.txId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IconLink />
                  Транзакция
                </a>
              )}
            </div>
            <div className="note-reader-body">
              {/* `.note-text` is the wrapper here too — it carries the 18px
                  reading size AND the `pre-wrap` that unformatted notes depend
                  on. `.note-reading` only opens the line-height and sets the
                  measure. */}
              <div className="note-text note-reading">
                {readingNote.fmt === 'md'
                  ? <NoteMarkdown text={readingNote.text} />
                  : readingNote.text}
              </div>
            </div>
            {/*
              ACTIONS AT THE BOTTOM, NAMED IN WORDS.
              They used to sit in three different places along the right edge —
              «Назад» at the top, ⋯ in the facts row, a nib in the corner — so
              finding out what a note could do meant scanning that edge. Here
              they are one row, in the thumb's reach, and the bottom of the
              screen means the same thing in both modes: this is where you tap.
              The corner the nib occupied goes back to «Новая заметка», which is
              what it means in the feed.
            */}
            <div className="note-reader-actions">
              {V3_WRITER_ENABLED && (
                <button
                  type="button"
                  className="note-action"
                  onClick={() => setEditChainRoot(readingChain.root)}
                >
                  <IconEdit />
                  <span>Изменить</span>
                </button>
              )}
              <button
                type="button"
                className="note-action note-action--quiet"
                onClick={() => void handleCopyNote(readingNote.text)}
              >
                <IconCopy />
                <span>{copyFeedback === 'ok' ? 'Скопировано' : copyFeedback === 'fail' ? 'Не вышло' : 'Копировать'}</span>
              </button>
              {V3_WRITER_ENABLED && readingChain.versions.length > 1 && (
                <button
                  type="button"
                  className="note-action note-action--quiet"
                  onClick={() => {
                    setHistoryFocusVersionId(null);
                    setHistoryChainRoot(readingChain.root);
                  }}
                >
                  <IconHistory />
                  <span>История</span>
                </button>
              )}
            </div>
          </>
      )}

      {/* Feed — one card per version chain; fields come from chain.current. */}
      {!composing && !reading && (
      <div className="notes-feed" ref={feedElRef}>
        {filteredChains.length === 0 && !searchQuery ? (
          <div className="empty-state">
            <div className="empty-icon"><IconNote /></div>
            <p>Первая заметка — самая важная.</p>
            <p className="empty-sub">Просто начните печатать.</p>
          </div>
        ) : filteredChains.length === 0 && searchQuery ? (
          <div className="empty-state">
            <p>Ничего не найдено по «{searchQuery}»</p>
          </div>
        ) : (
          // `chain.current` is the HEAD OF A NOTE VERSION CHAIN, not a React
          // ref — react-hooks/refs (eslint-plugin-react-hooks >= 7.1) flags any
          // `.current` access during render by property name alone. On the
          // current 7.0.x the unused directive is only a warning, so lint
          // stays green on both sides of the plugin upgrade.
          // eslint-disable-next-line react-hooks/refs
          filteredChains.map(chain => {
            const note = chain.current;
            // Sync info is derived UNCONDITIONALLY — a confirmed TX stays
            // linkable from the menu even with auto-sync switched off; the
            // enabled flag gates only the live status badge.
            const info = syncStatuses[note.id] ?? { status: 'queued' as const };
            const badge = badgeFor(info, arweave.enabled && arweave.registered);
            const rendersMarkdown = note.fmt === 'md' && !searchQuery.trim();
            return (
              <div className="note-card" key={chain.root}>
                {/* The date leads the entry instead of trailing it. A line in
                    a ledger is found by when it was written; putting the date
                    under the text made every entry start with an unanchored
                    sentence. It is inside the open control now: the whole
                    entry is one target, and the date is the first thing its
                    accessible name says. */}
                <NotePreview
                  date={formatNoteDate(note.createdAt)}
                  dateFull={formatNoteDateFull(note.createdAt)}
                  /* The measurement's invalidator. `note.id` is the CURRENT
                     version's id, so an edit or a version arriving from sync
                     changes it; the render mode covers the markdown ⇄ search
                     switch. Neither changes the width, and the observer
                     ignores height-only changes. */
                  contentKey={`${note.id}|${rendersMarkdown ? 'md' : 'plain'}`}
                  onOpen={() => openNote(chain.root)}
                  openRef={previewTriggerRef(chain.root)}
                >
                  {/* While a query is active the card renders PLAIN text so the
                      matches can be wrapped in <mark> — but a markdown note's
                      plain text is its SOURCE, and typing a query turned
                      «Первая мадаун **заметка**» into exactly that on screen.
                      `noteSearchText` is what the STORE filtered on, so what is
                      highlighted here is exactly what was matched there; the
                      stored note is untouched either way. */}
                  {rendersMarkdown
                    ? <NoteMarkdown text={note.text} preview />
                    : highlight(noteSearchText(note), searchQuery)}
                </NotePreview>
                <div className="note-meta">
                  {/* Status in words. The 🔒 that used to sit here is gone with
                      the rest of the emoji: every note is encrypted, so a
                      padlock on each one carried no information — it was a
                      property of the app repeated per row. */}
                  {/* No `info &&` guard: `info` falls back to
                      `{ status: 'queued' }` above, so the condition was always
                      true and read as if a card could have no sync state. */}
                  <SyncStateBadge
                    badge={badge}
                    onRetry={
                      info.status === 'error' && arweave.enabled && arweave.registered
                        ? retrySync
                        : undefined
                    }
                  />
                  {chain.versions.length > 1 && (
                    <span className="state state--quiet">
                      {chain.versions.length}-я версия
                    </span>
                  )}
                  <span className="note-meta-gap" />
                  <CardMenu
                    open={openMenuId === chain.root}
                    onOpenChange={next => setOpenMenuId(next ? chain.root : null)}
                    label="Меню заметки"
                    id={`note-menu-${chain.root}`}
                    triggerRef={menuTriggerRef(chain.root)}
                    items={[
                      {
                        key: 'copy',
                        icon: <IconCopy />,
                        label: 'Копировать текст',
                        onSelect: () => handleCopyNote(note.text),
                      },
                      ...(V3_WRITER_ENABLED
                        ? [{
                            key: 'edit',
                            icon: <IconEdit />,
                            label: 'Редактировать',
                            onSelect: () => setEditChainRoot(chain.root),
                          }]
                        : []),
                      ...(V3_WRITER_ENABLED && chain.versions.length > 1
                        ? [{
                            key: 'history',
                            icon: <IconHistory />,
                            label: `История версий (${chain.versions.length})`,
                            onSelect: () => {
                              setHistoryFocusVersionId(null);
                              setHistoryChainRoot(chain.root);
                            },
                          }]
                        : []),
                      ...(info.status === 'confirmed' && info.txId
                        ? [{
                            key: 'tx',
                            icon: <IconLink />,
                            label: 'Транзакция в блокчейне',
                            href: `https://viewblock.io/arweave/tx/${info.txId}`,
                          }]
                        : []),
                    ]}
                    /* О НЕИЗМЕНЯЕМОСТИ ОПУБЛИКОВАННОГО, а не о том, что
                       публикация состоялась. Прежний текст обещал «каждая
                       версия навсегда сохраняется в блокчейне» под КАЖДОЙ
                       заметкой — включая ту, что лежит только на устройстве
                       при выключенной синхронизации, и ту, что ещё в очереди
                       или упала с ошибкой. Та же ошибка, что была в композере;
                       здесь я не заметил её по аналогии. Где запись находится
                       сейчас, говорит её статус — он в той же строке. */
                    hint={V3_WRITER_ENABLED
                      ? 'Редактирование добавляет новую версию — старые остаются в истории. Версию, уже опубликованную в блокчейне, изменить или удалить невозможно.'
                      : 'Опубликованная в блокчейне копия неизменяема: её нельзя отредактировать или удалить.'}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
      )}

      {!composing && !reading && (
        // The dot is the only thing standing between a collapsed composer and
        // silently hiding an unsaved draft.
        <Fab
          ref={notesFabRef}
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
            <IconClose />
          </button>
        </div>
      )}

      {/* Prominent save confirmation (2.5) */}
      {justSaved && (
        <div className="toast toast--success" role="status">
          Сохранено и зашифровано
        </div>
      )}


      {/* Clipboard feedback — success and failure must look different */}
      {copyFeedback === 'ok' && (
        <div className="toast toast--success" role="status">Скопировано</div>
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

      />

      <RestoreVersionDialog
        open={restoreTarget !== null}
        version={restoreTarget?.version ?? null}
        onConfirm={confirmRestore}
        onCancel={cancelRestore}
      />

      {/* Unmounted while composing. The composer is a place you finish or
          leave by «Свернуть», and a tab bar under it is both a distraction and
          a tab stop past the save button. */}
      {!composing && !reading && <AppNav safeboxDimmed={safeboxDimmed} />}
    </div>
  );
}
