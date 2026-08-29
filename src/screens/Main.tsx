import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useNotes } from '../lib/store';
import { classifySaveError, SAVE_FALLBACK } from '../lib/save-errors';
import { SettingsSection } from './SettingsSection';
import { NoteComposer } from '../components/NoteComposer';
import { Fab } from '../components/Fab';
import { NoteMarkdown } from '../components/NoteMarkdown';
import { NotePreview } from '../components/NotePreview';
import { EditNoteModal, type EditSeed } from '../components/EditNoteModal';
import { VersionHistoryModal, RestoreVersionDialog } from '../components/VersionHistoryModal';
import { SafeboxSection } from '../components/SafeboxSection';
import { badgeFor } from '../components/syncBadge';
import { SyncStateBadge } from '../components/SyncStateBadge';
import { CardMenu } from '../components/CardMenu';
import { formatNoteDate, formatNoteDateFull, formatVersionStamp } from '../lib/format-date';
import { noteSearchText } from '../lib/note-search-text';
import { IconCopy, IconEdit, IconHistory, IconLink, IconClose, IconNote, IconChevronLeft, IconRestore } from '../components/icons';
import { V3_WRITER_ENABLED } from '../lib/flags';
import { useRoute, navigate, canonicalHash, parseHash, noteTarget, parseNoteTarget, type RouteHistoryState } from '../lib/route';
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
    updateCheck,
    lastSweepOutcome,
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
  /**
   * What the ADDRESS names, parsed — before asking whether the store has it.
   *
   * `#/notes/<root>` or `#/notes/<root>/v/<n>`. Everything downstream keys off
   * THIS and not off the chain we managed to find: during a sweep the chain may
   * not have arrived yet, and a route identity that collapses whenever a lookup
   * misses would let the held address and the lifecycle drift apart.
   */
  const target = view === 'notes' ? parseNoteTarget(hash) : null;
  const targetRoot = target?.root ?? null;
  const targetOrdinal = target?.ordinal ?? null;

  /** The chain, looked up against `chains` and never `filteredChains`: an
   *  active search must not close a note that is already open. */
  const readingChain = targetRoot ? chains.find(c => c.root === targetRoot) ?? null : null;
  const readingRoot = readingChain?.root ?? null;

  /**
   * IS A SWEEP RUNNING — the only honest form of «the snapshot is still moving».
   *
   * `restoring` alone is not it. `checkForUpdates` shares `restoringRef` with
   * restore but deliberately never calls `setRestoring` (see its comment in
   * store.tsx), while publishing versions as it merges them. A partial restore,
   * meanwhile, ends with `setRestoring(false)` like any other. So both flags
   * are needed — and NEITHER means «the snapshot is complete». That question is
   * answered by `lastSweepOutcome`, and answering it is all it does: it gates
   * nothing.
   */
  const sweepInFlight = restoring || updateCheck.status === 'checking';

  /* Derived at the top level, not inside the JSX: reading `chain.current`
     inside a callback is what react-hooks/refs flags by property name. */
  const readingCurrent = readingChain?.current ?? null;

  const versionTotal = readingChain?.versions.length ?? 0;
  /* The ordinal counts from the OLDEST (1) while `versions` runs current-first,
     which is why this is a subtraction and not an index. */
  const versionByOrdinal = readingChain && targetOrdinal !== null && targetOrdinal <= versionTotal
    ? readingChain.versions[versionTotal - targetOrdinal] ?? null
    : null;

  /**
   * THE PIN: the version this page resolved to, held by ID for as long as the
   * page stays open.
   *
   * The address carries a POSITION, and a position is only as stable as the
   * snapshot it was read from — a version arriving out of order (a second
   * device with a lagging clock) shifts the ordinals of everything newer than
   * itself. Without the pin the text would change under the reader. With it,
   * only the caption moves: it is recomputed from where the pinned version
   * sits NOW, so it never lies either.
   *
   * Keyed by the full route target and cleared on every route change (see the
   * reset block below), so leaving and re-entering the same address resolves it
   * afresh instead of resurrecting whatever was shown last time.
   */
  const [versionPin, setVersionPin] = useState<{ key: string; versionId: string } | null>(null);
  const routeKey = `${view}|${target ? noteTarget(target.root, target.ordinal) : ''}`;
  const pinnedVersion = versionPin && versionPin.key === routeKey && readingChain
    ? readingChain.versions.find(v => v.id === versionPin.versionId) ?? null
    : null;
  const shownVersion = pinnedVersion ?? versionByOrdinal;
  const shownIsCurrent = shownVersion !== null && shownVersion.id === readingCurrent?.id;

  /**
   * WHICH SCREEN — and it follows the ADDRESS, not the lookup.
   *
   *   feed     — the address names no note
   *   holding  — it names one that cannot be shown yet (or any more): the
   *              reader is HELD until the canonicaliser rewrites the hash
   *   note     — the ordinary reader (#121)
   *   version  — one older version, on its own page
   *
   * `holding` exists because the alternative is a frame of the FEED under a
   * note address — and, with a stored draft, a frame of the COMPOSER, since
   * `composing` is gated on `!reading`. That frame appears twice: while a sweep
   * is still filling the store, and again between the render that ends the
   * sweep and the passive effect that rewrites the address.
   *
   * An ordinal that resolves to the CURRENT version renders the note rather
   * than the version page: `#/notes/<root>/v/<N>` is on its way to
   * `#/notes/<root>`, so the destination is what to draw — and drawing it means
   * no frame ever offers «Вернуть» for a version that is already current.
   */
  const screen: 'feed' | 'holding' | 'note' | 'version' =
    targetRoot === null ? 'feed'
      : readingChain === null ? 'holding'
        : targetOrdinal === null ? 'note'
          : shownVersion === null ? (sweepInFlight ? 'holding' : 'note')
            : shownIsCurrent ? 'note'
              : 'version';

  const reading = screen !== 'feed';
  /** Actions that WRITE are offered only once the snapshot has stopped moving:
   *  acting on a version the next merge may re-resolve is the one mistake this
   *  page must not allow. */
  const versionActionable = screen === 'version' && !sweepInFlight;
  /** «Версия k из N», recomputed from where the pinned version sits now. */
  const shownOrdinal = screen === 'version' && readingChain && shownVersion
    ? versionTotal - readingChain.versions.findIndex(v => v.id === shownVersion.id)
    : null;

  const readingNote = screen === 'version' ? shownVersion : readingCurrent;
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
  /** Which version the editor was seeded from. `null` = the current one, the
   *  ordinary edit; set only when the editor was opened from a version page. */
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);
  const [historyChainRoot, setHistoryChainRoot] = useState<string | null>(null);
  /**
   * «Open the index once the route has settled on this note.»
   *
   * Entering the history from the feed's card menu has to open the NOTE first,
   * or Back from a version page would land in the feed while the control on it
   * says «‹ Заметка». But `openNote()` and `setHistoryChainRoot()` in one
   * handler are batched into a single update, and the render-phase reset below
   * — which clears `historyChainRoot` on every route change — would then wipe
   * the index in the very commit that was supposed to open it.
   *
   * So the intent is parked with the route key it is waiting for and consumed
   * on a later render, in that same reset block. An EFFECT cannot do this:
   * `react-hooks/set-state-in-effect` is an error here (eslint.config.js), and
   * `npm run lint` is a gate.
   */
  const [historyIntent, setHistoryIntent] = useState<{ key: string; root: string } | null>(null);
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

  /**
   * The same token for the EDIT flow, and it needs saying why a second one.
   *
   * `editNote` does not throw when the vault epoch changed under it — it
   * returns, quietly (store.tsx). So `await editNote(...)` resolves normally
   * even when the app has locked mid-save, and everything written after that
   * await runs regardless: closing a dialog, navigating, moving focus. Over a
   * PIN screen, that is a stranger's app being driven by a finished operation.
   *
   * Both tokens are bumped from three places, and all three are needed:
   *   - the route-change effect below (the backstop for system Back, which
   *     reaches us through popstate and not through any handler of ours);
   *   - every handler that opens, closes or cancels a dialog, or navigates —
   *     synchronously, because a passive effect is NOT a barrier a promise
   *     continuation has to wait behind;
   *   - the unmount cleanup right here, in a LAYOUT effect, which runs in the
   *     same commit that takes this screen away.
   */
  const editSessionRef = useRef(0);
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    // The ref OBJECTS are copied, not their values: the cleanup wants the live
    // counters, which is the opposite of the DOM-node case exhaustive-deps
    // warns about.
    const mounted = mountedRef;
    const editSession = editSessionRef;
    const restoreOp = restoreOpRef;
    mounted.current = true;
    return () => {
      mounted.current = false;
      editSession.current++;
      restoreOp.current++;
    };
  }, []);

  /** «История» in the reader's action bar — where focus goes when the index is
   *  closed and whatever opened it (a card menu in a feed that has since
   *  unmounted) is gone. */
  const historyBtnRef = useRef<HTMLButtonElement>(null);

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
    // Tracked from the ADDRESS, not from the resolved chain: during a sweep the
    // chain arrives later than the address does, and a lookup-based «where were
    // we» would read null for a note that was on screen the whole time.
    const leftReading = prevReadingRootRef.current;
    prevReadingRootRef.current = targetRoot;
    // Not on the very first render — that would steal focus at app start,
    // including a cold start straight into a note.
    if (firstSectionRender.current) { firstSectionRender.current = false; return; }
    // Coming BACK from a note: focus the card it was opened from, not the
    // section title. Same contract as the modal stack — the control that
    // started the trip gets the focus that ends it.
    if (!targetRoot && leftReading) {
      const back = previewBtnRefs.current.get(leftReading)?.current;
      if (back) { back.focus(); return; }
    }
    (document.querySelector('.main-content .section-title') as HTMLElement | null)?.focus();
    // Keyed on the FULL target, not on the root: note → version → note keeps
    // one root throughout, and focus has to follow all three moves. `targetRoot`
    // is a function of `routeKey` and cannot move on its own — it is listed to
    // satisfy the dependency check, not because it adds a trigger.
  }, [routeKey, targetRoot]);

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
  const [modalRouteKey, setModalRouteKey] = useState(routeKey);
  if (modalRouteKey !== routeKey) {
    // ADJUSTED DURING RENDER, not in an effect — the same shape EditNoteModal
    // uses to re-prefill per chain. An effect would paint one frame with the
    // dialog still standing over the restored feed, and React flags the
    // cascading re-render it causes.
    setModalRouteKey(routeKey);
    setEditChainRoot(null);
    setEditSeed(null);
    setHistoryChainRoot(null);
    setRestoreTarget(null);
    setOpenMenuId(null);
    // THE PIN GOES WITH THEM. Its key is a string, and the same address visited
    // twice produces the same string — so a pin left standing across the trip
    // away would match again on re-entry and resurrect the version that was
    // shown last time, ignoring everything that arrived in between. Clearing it
    // on every transition is what makes a second visit identical to a first.
    setVersionPin(null);
    // The parked intent survives exactly the transition it was created for.
    if (historyIntent && historyIntent.key !== routeKey) setHistoryIntent(null);
  } else if (historyIntent && historyIntent.key === routeKey) {
    // The route has settled and the reset above has already run for this key,
    // so opening the index now cannot be undone by it.
    setHistoryIntent(null);
    setHistoryChainRoot(historyIntent.root);
  }

  // Pin the version this address resolved to — once per visit, and only once
  // the snapshot has stopped moving. Pinning mid-sweep would hold whichever
  // version happened to occupy the position at that instant, which is exactly
  // the guess this pin exists to avoid.
  if (screen === 'version' && !sweepInFlight && shownVersion
      && (versionPin === null || versionPin.key !== routeKey)) {
    setVersionPin({ key: routeKey, versionId: shownVersion.id });
  }

  // The route-change backstop for both generation tokens. System Back arrives
  // as a popstate and passes through no handler of ours, so this is the only
  // place that hears it — every in-app navigation bumps them synchronously as
  // well, because a passive effect is not a barrier a promise continuation has
  // to wait behind. A ref may not be written during render, which is why this
  // is an effect and not part of the block above.
  useEffect(() => {
    restoreOpRef.current++;
    editSessionRef.current++;
  }, [routeKey]);

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
  // null for a param that resolves to nothing, so the same line strips it, and
  // an ordinal that names no version (or names the CURRENT one) is dropped the
  // same way.
  //
  // While a sweep is still filling the store, though, an id that has not
  // arrived YET is not the same as a bad one, and neither is an ordinal that
  // does not resolve yet — the whole note address is held until the sweep ends,
  // or a deep link would bounce out from under the user. `sweepInFlight` and
  // not `restoring`: the manual check publishes versions without ever setting
  // that flag, so watching it alone would both bounce a live deep link AND —
  // because `checking → done` moves nothing else this effect depends on —
  // leave a genuinely dead address standing forever once the check finished.
  useEffect(() => {
    if (sweepInFlight && targetRoot) return;
    const wanted = view === 'notes' && readingRoot
      // The ordinal is carried over AS WRITTEN. This effect never renumbers it:
      // a rewrite is indistinguishable from a user's own move to another
      // version, and it would take the open dialogs, the buffer and the focus
      // with it. See the pin above for how the caption stays truthful instead.
      ? noteTarget(readingRoot, screen === 'version' ? targetOrdinal : null)
      : null;
    if (hash !== canonicalHash(view, wanted)) navigate(view, { replace: true, param: wanted });
  }, [hash, view, targetRoot, targetOrdinal, readingRoot, screen, sweepInFlight]);

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

  /** Every in-app navigation ends the sessions of whatever was in flight.
   *  Synchronously, in the handler: a promise continuation does not wait for a
   *  passive effect, so the effect keyed on the route is a backstop for system
   *  Back and nothing more. */
  function endSessions() {
    restoreOpRef.current++;
    editSessionRef.current++;
  }

  /** Open a note: push an entry so the system Back gesture closes it, and
   *  remember where the feed was standing. */
  function openNote(root: string) {
    endSessions();
    feedScrollRef.current = feedElRef.current?.scrollTop ?? 0;
    restoreFeedScrollRef.current = true;
    navigate('notes', { param: root });
  }

  /** Open one version, by its position in the index. The CURRENT version has
   *  no page of its own — there is nothing to bring back from it — so it routes
   *  to the note itself. The index is closed HERE and not left to the route
   *  reset: navigating to the note we already stand on is a no-op inside
   *  `navigate` (same hash, no push, no emit), and then nothing would close it. */
  function openVersion(ordinal: number) {
    if (!readingChain) return;
    setHistoryChainRoot(null);
    endSessions();
    const isCurrent = ordinal === readingChain.versions.length;
    navigate('notes', { param: noteTarget(readingChain.root, isCurrent ? null : ordinal) });
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
    endSessions();
    const state = window.history.state as RouteHistoryState | null;
    if (state?.enSection === true) window.history.back();
    else navigate('notes', { replace: true });
  }

  /**
   * Leave a version page for its note — the same two cases as `closeNote`, one
   * step shallower.
   *
   * Used by «‹ Заметка» AND by a successful restore/edit, and the latter is why
   * it must not be a plain push: pushing `#/notes/<root>` would leave the stale
   * version page sitting directly behind the note the user just changed, one
   * Back away.
   */
  function leaveVersionPage() {
    endSessions();
    const state = window.history.state as RouteHistoryState | null;
    if (state?.enSection === true) window.history.back();
    else navigate('notes', { replace: true, param: targetRoot });
  }

  const editChain = editChainRoot ? chains.find(c => c.root === editChainRoot) ?? null : null;
  const historyChain = historyChainRoot ? chains.find(c => c.root === historyChainRoot) ?? null : null;

  /**
   * The address AS IT IS RIGHT NOW, re-read rather than remembered.
   *
   * The third guard on every async tail, and the only one that survives a
   * `popstate`: the browser changes the address without passing through any
   * handler of ours, and the effect that would bump the session tokens is
   * passive — a promise continuation does not wait behind it. Comparing the
   * live address with the one captured before the await closes that window.
   *
   * The shape matches `routeKey` exactly, so the two are comparable.
   */
  function liveRoute(): { key: string; onVersion: boolean } {
    const h = window.location.hash;
    const live = parseNoteTarget(h);
    return {
      key: `${parseHash(h)}|${live ? noteTarget(live.root, live.ordinal) : ''}`,
      onVersion: live?.ordinal != null,
    };
  }

  function openEditor(root: string, seed: EditSeed | null) {
    endSessions();
    setEditSeed(seed);
    setEditChainRoot(root);
  }

  function closeEditor() {
    endSessions();
    setEditSeed(null);
    setEditChainRoot(null);
  }

  /**
   * The editor's ENTIRE success tail lives here, not in the dialog.
   *
   * `EditNoteModal` deliberately stops after the write: its `onClose` is a
   * closure over this live component, so a save resolving after the user has
   * closed that dialog and opened another would close the NEW one and take its
   * unsaved buffer along. Unmounting the dialog does not help — a prop outlives
   * the component that received it.
   *
   * The three guards below are three different failures, and none of them
   * covers another: the screen may be gone (a lock unmounts Main while
   * `editNote` returns quietly on the epoch change), the dialog may have been
   * closed and reopened, or the address may have moved.
   */
  async function saveEdit(rootId: string, newText: string) {
    const session = editSessionRef.current;
    const from = liveRoute();
    // No fmt: the editor is markdown, and a plain old version edited in it must
    // be saved as what it now is — otherwise the markup just typed would render
    // as literal text. «Вернуть» is the path that preserves the source format.
    await editNote(rootId, newText);
    if (!mountedRef.current) return;
    if (session !== editSessionRef.current) return;
    if (liveRoute().key !== from.key) return;
    closeEditor();
    // ONLY from a version page. The same editor opens from the reader and from
    // the feed's card menu, and leaving from either of those would close a note
    // the user never asked to leave, or spend a Back they still needed.
    if (from.onVersion) leaveVersionPage();
  }

  function requestRestore(version: NoteData) {
    if (!readingChain) return;
    // A NEW flow invalidates the previous one's tail — otherwise a restore the
    // user backed out of could still steal focus from the one they started
    // instead.
    endSessions();
    setRestoreTarget({ root: readingChain.root, version });
  }

  function cancelRestore() {
    if (!restoreTarget) return;
    endSessions();
    // No reopening to arrange: the confirm stood over the version PAGE, not
    // over the index, and `useModalA11y` puts focus back on «Вернуть» itself.
    setRestoreTarget(null);
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    const op = ++restoreOpRef.current;
    const from = liveRoute();
    // Preserve the SOURCE version's fmt: restoring a plain note must not
    // re-interpret its literal *stars* as markdown forever.
    await editNote(restoreTarget.root, restoreTarget.version.text, { fmt: restoreTarget.version.fmt });
    // The write is done and permanent. Everything below is UI, and it belongs
    // to a flow the user may already have left — same three guards as `saveEdit`.
    if (!mountedRef.current) return;
    if (op !== restoreOpRef.current) return;
    if (liveRoute().key !== from.key) return;
    setRestoreTarget(null);
    // Back to the note, whose current version now carries this text. Focus is
    // the route effect's job from here — it lands on the note's title, and the
    // card's ⋯ trigger this used to aim at is not even mounted.
    if (from.onVersion) leaveVersionPage();
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
      {/* A VERSION PAGE NAMES ITSELF DIFFERENTLY, on purpose. A note is named
          by its date (above); a version is named by which one it is — the exact
          moment moves down into the facts row, where «where does this live»
          already lives. Its way out is one step shallower: back to the note,
          not to the list. */}
      {reading ? (
        <div className="notes-topbar notes-topbar--reading">
          <button
            className="btn btn-ghost note-back"
            onClick={screen === 'version' ? leaveVersionPage : closeNote}
          >
            <IconChevronLeft />
            {screen === 'version' ? 'Заметка' : 'Заметки'}
          </button>
          <span className="note-meta-gap" />
          <h2 className="section-title note-reader-title" tabIndex={-1}>
            {screen === 'version' && shownOrdinal !== null
              ? `Версия ${shownOrdinal} из ${versionTotal}`
              : readingNote
                ? formatNoteDate(readingNote.createdAt)
                : 'Заметка'}
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

      {/* HELD. The address names a note this screen cannot draw yet — the chain
          has not arrived, or the version has not — and the address is what the
          screen follows. Drawing the feed here would flash the wrong screen
          under a live address; with a stored draft it would flash the COMPOSER,
          since `composing` is only gated on `!reading`. */}
      {screen === 'holding' && (
        <div className="note-reader-body">
          <p className="note-holding" role="status">
            {sweepInFlight
              ? 'Загружаем заметку…'
              : 'Заметка не найдена.'}
          </p>
        </div>
      )}

      {/* Reading one note, full screen. The chain is re-resolved on every
          render rather than snapshotted into state, so a version arriving from
          sync — or a restore performed right here — updates the text and the
          version count under the reader instead of going stale. */}
      {(screen === 'note' || screen === 'version') && readingChain && readingNote && readingInfo && (
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
              {/* On a version page the moment is a FACT about this version and
                  belongs here; on the note it is the header's job and what
                  belongs here is how many versions there are. */}
              {screen === 'version' ? (
                <span className="state state--quiet">
                  {formatVersionStamp(readingNote.createdAt)}
                </span>
              ) : readingChain.versions.length > 1 && (
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
            {/* AN ADMISSION, NOT A GATE. Nothing here is blocked on it: «the
                snapshot may be missing something» is the permanent condition of
                an app whose other device can be offline for a week. It is worth
                SAYING on a page that counts versions, though — «Версия 2 из 3»
                is a claim about a list, and the last sweep already told us the
                list may be short. */}
            {screen === 'version' && (lastSweepOutcome === 'partial' || lastSweepOutcome === 'error') && (
              <p className="note-reader-caveat">
                Список версий может быть неполным — последняя сверка прошла не до конца.
              </p>
            )}
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
              {/* WRITING ACTIONS EXIST ONLY WHEN THE SNAPSHOT HAS SETTLED.
                  Acting on a version the next merge may re-resolve is the one
                  mistake this page must not let anyone make, so while a sweep
                  is running the version can be read and copied and nothing
                  else. */}
              {screen === 'version' ? (
                <>
                  {V3_WRITER_ENABLED && versionActionable && (
                    <button
                      type="button"
                      className="note-action"
                      onClick={() => requestRestore(readingNote)}
                    >
                      <IconRestore />
                      <span>Вернуть</span>
                    </button>
                  )}
                  {V3_WRITER_ENABLED && versionActionable && shownOrdinal !== null && (
                    <button
                      type="button"
                      className="note-action note-action--quiet"
                      onClick={() => openEditor(readingChain.root, {
                        versionId: readingNote.id,
                        text: readingNote.text,
                        ordinal: shownOrdinal,
                        total: versionTotal,
                      })}
                    >
                      <IconEdit />
                      <span>Изменить</span>
                    </button>
                  )}
                </>
              ) : V3_WRITER_ENABLED && (
                <button
                  type="button"
                  className="note-action"
                  onClick={() => openEditor(readingChain.root, null)}
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
              {screen === 'note' && V3_WRITER_ENABLED && readingChain.versions.length > 1 && (
                <button
                  ref={historyBtnRef}
                  type="button"
                  className="note-action note-action--quiet"
                  onClick={() => setHistoryChainRoot(readingChain.root)}
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
                            onSelect: () => openEditor(chain.root, null),
                          }]
                        : []),
                      ...(V3_WRITER_ENABLED && chain.versions.length > 1
                        ? [{
                            key: 'history',
                            icon: <IconHistory />,
                            label: `История версий (${chain.versions.length})`,
                            // OPEN THE NOTE FIRST, then the index on top of it.
                            // Otherwise the stack reads feed → version, and Back
                            // from a version page would drop into the feed while
                            // the control on that page says «‹ Заметка».
                            // The index cannot be opened in this handler: the
                            // two updates are batched and the route reset would
                            // wipe it in the same commit. It is parked as an
                            // intent and consumed once the route has settled.
                            onSelect: () => {
                              setHistoryIntent({ key: `notes|${chain.root}`, root: chain.root });
                              openNote(chain.root);
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



      {/* W3: edit + history + restore-version (one aria-modal layer at a time).
          RENDERED ONLY WHILE OPEN. They used to be unconditional siblings that
          returned null when closed, which meant the INSTANCE outlived every
          closing: a save resolving after the user had closed one dialog and
          opened another wrote its `busy`/`error` into the new one. Unmounting
          settles the component's own state; the tail that reaches ACROSS
          components — closing, navigating, focus — is guarded by the session
          tokens instead, because a prop outlives the component it was given to. */}
      {editChain !== null && (
        <EditNoteModal
          open
          chain={editChain}
          seed={editSeed}
          onClose={closeEditor}
          onSave={saveEdit}
        />
      )}

      {historyChain !== null && restoreTarget === null && (
        <VersionHistoryModal
          open
          chain={historyChain}
          syncStatuses={syncStatuses}
          syncActive={arweave.enabled && arweave.registered}
          onClose={() => setHistoryChainRoot(null)}
          onOpenVersion={openVersion}
          returnFocusRef={historyBtnRef}
        />
      )}

      {restoreTarget !== null && (
        <RestoreVersionDialog
          open
          version={restoreTarget.version}
          onConfirm={confirmRestore}
          onCancel={cancelRestore}
        />
      )}

      {/* Unmounted while composing. The composer is a place you finish or
          leave by «Свернуть», and a tab bar under it is both a distraction and
          a tab stop past the save button. */}
      {!composing && !reading && <AppNav safeboxDimmed={safeboxDimmed} />}
    </div>
  );
}
