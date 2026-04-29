import './styles.css';
import './phone/styles.css';
import './title/styles.css';

import { changeDependency, submitMessage, type ActionContext } from './actions';
import { setupStreamingHooks } from './actions/streaming';
import { getReaderMessages } from './message-format';
import { bindFloatingPhoneEvents, loadFloatingPhonePosition, syncFloatingPhoneAfterResize } from './phone/floating';
import {
  closePhoneRoute,
  getRouteForTab,
  navigatePhoneBack as navigatePhoneBackRoute,
  navigatePhoneRoute,
  openPhoneRoute,
  resetPhoneRoute as resetPhoneRouteState,
} from './phone/routes';
import { refreshWeatherForCurrentState } from './phone/weather';
import { renderApp } from './render';
import {
  clearActiveSaveId,
  createManualSave,
  createSave,
  deleteSave,
  getActiveRunId,
  getActiveSaveId,
  loadSave,
  setActiveRunId,
  setActiveSaveId,
  writeAutosave,
} from './state/saves';
import {
  clampFocusedMessageIndex,
  createInitialState,
  deleteReaderMessage,
  deserializeMessages,
  getReaderMessageByIndex,
  getSourceUserTextForReaderIndex,
  replaceConversationMessages,
  rollbackConversation,
  serializeMessages,
  syncFocusedMessage,
} from './state/store';
import {
  loadSummaryApiConfig,
  rerollSummaryEntry,
  resumeAutoSummary,
  runSummary,
  saveSummaryApiConfig,
} from './summary';
import type { SummaryApiConfig } from './summary/types';
import { bindCharacterCreationEvents, bindTitleHomeEvents, type TitleCallbacks } from './title/events';
import { renderCharacterCreation, renderTitleHome } from './title/render';
import type {
  GameState,
  NotificationState,
  StatusData,
  TabKey,
  TavernWindow,
} from './types';
import type { PhoneRoute } from './phone/types';
import { getActiveTarget } from './types';
import { createVariableAdapter, type VariableAdapter } from './variables/adapter';
import { clamp } from './variables/normalize';

const win = window as TavernWindow;
const root = document.querySelector<HTMLDivElement>('#app');

const READER_CONTEXT_MENU_GAP = 12;
const READER_CONTEXT_MENU_WIDTH = 240;
const READER_CONTEXT_MENU_HEIGHT = 176;
const STATUS_CACHE_KEY_PREFIX = 'islandmilfcode:status-cache:v2:';

let flipDirection: 'forward' | 'backward' | '' = '';

let readerDragState: {
  pointerId: number;
  startX: number;
  startY: number;
  startedInBody: boolean;
  intentLocked: boolean;
  scrolling: boolean;
  moved: boolean;
} | null = null;

function canFlipReader(direction: 'prev' | 'next') {
  const readerMessages = getReaderMessages(state.uiMessages);
  if (direction === 'prev') return state.focusedMessageIndex > 0;
  return state.focusedMessageIndex < readerMessages.length - 1;
}

function resetReaderCardTransform(reader: HTMLElement) {
  const card = reader.querySelector<HTMLElement>('.reader-card');
  if (!card) return;
  card.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s ease';
  card.style.transform = '';
  card.style.opacity = '';
}

// ── State & adapter ──

let adapter: VariableAdapter;
const state = createInitialState(loadFloatingPhonePosition());
const eventStops: Array<() => void> = [];

// ── StatusData localStorage cache ──
// Our in-memory state.statusData is the source of truth during a session.
// We cache to localStorage so it persists reliably across page loads and
// doesn't get overwritten by stale MVU round-trip echoes.

function getStatusCacheKey() {
  return state.activeRunId ? `${STATUS_CACHE_KEY_PREFIX}${state.activeRunId}` : null;
}

function cacheStatusData(data: StatusData) {
  const key = getStatusCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function loadCachedStatusData(): StatusData | null {
  const key = getStatusCacheKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StatusData) : null;
  } catch {
    return null;
  }
}

function guardedAdapterSave(data: StatusData) {
  adapter.save(data);
  cacheStatusData(data);
}

/** Wrapped adapter whose save() also writes to localStorage cache */
const guardedAdapter: VariableAdapter = {
  get source() {
    return adapter.source;
  },
  load() {
    return adapter.load();
  },
  save(data: StatusData) {
    guardedAdapterSave(data);
  },
  onUpdate(cb: (data: StatusData) => void) {
    return adapter.onUpdate(cb);
  },
};

// Action context — lazily references adapter (set during init)
const ctx: ActionContext = {
  get state() {
    return state;
  },
  get win() {
    return win;
  },
  get adapter() {
    return guardedAdapter;
  },
  render: () => render(),
  showNotification: (n: NotificationState) => {
    state.notification = n;
    render();
  },
  clearNotification: (shouldRender: boolean) => {
    if (!state.notification) return;
    state.notification = null;
    if (shouldRender) render();
  },
  persistConversation: () => {
    persistToSave();
  },
  closeReaderContextMenu: (shouldRender: boolean) => {
    if (!state.readerContextMenu) return;
    state.readerContextMenu = null;
    if (shouldRender) render();
  },
  get summaryStore() {
    return state.summaryStore;
  },
  get summaryApiConfig() {
    return state.summaryApiConfig;
  },
  onSummaryStoreUpdated: () => {
    persistToSave();
  },
};

// ── Save system ──

function buildGameState(statusData: StatusData = state.statusData): GameState {
  return {
    runId: state.activeRunId ?? crypto.randomUUID(),
    statusData: JSON.parse(JSON.stringify(statusData)),
    currentMessageIndex: Math.max(getReaderMessages(state.uiMessages).length - 1, 0),
    runtimeFlags: {
      playerProfile: JSON.parse(JSON.stringify(state.playerProfile)),
    },
  };
}

function persistToSave() {
  if (!state.activeRunId) return;
  const meta = writeAutosave({
    runId: state.activeRunId,
    gameState: buildGameState(),
    chatLog: serializeMessages(state.uiMessages),
    summaryStore: state.summaryStore,
  });
  if (meta) {
    state.activeSaveId = meta.saveId;
    setActiveSaveId(meta.saveId);
  }
}

function persistManualSave() {
  if (!state.activeRunId) return;
  const meta = createManualSave({
    runId: state.activeRunId,
    label: '手动存档',
    gameState: buildGameState(),
    chatLog: serializeMessages(state.uiMessages),
    summaryStore: state.summaryStore,
  });
  state.activeSaveId = meta.saveId;
  setActiveSaveId(meta.saveId);
}

function rebuildRuntimeAfterRestore() {
  state.draft = '';
  state.generating = false;
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;
  state.readerContextMenu = null;
  resetPhoneRouteState(state);
  state.focusedMessagePage = 0;
}

function enterSave(saveId: string) {
  const save = loadSave(saveId);
  if (!save) return;
  state.activeRunId = save.payload.runId;
  state.activeSaveId = saveId;
  setActiveRunId(save.payload.runId);
  setActiveSaveId(saveId);
  state.creatingCharacter = false;
  const msgs = deserializeMessages(save.payload.chatLog);
  replaceConversationMessages(state, msgs);
  state.statusData = save.payload.gameState.statusData;
  state.playerProfile =
    ((save.payload.gameState.runtimeFlags?.playerProfile as typeof state.playerProfile | undefined) ?? {
      name: save.meta.playerProfile?.name ?? save.meta.characterName ?? '',
      gender: save.meta.playerProfile?.gender ?? '男',
      personality: save.meta.playerProfile?.personality ?? save.meta.personality ?? '',
      appearance: save.meta.playerProfile?.appearance ?? save.meta.appearance ?? '',
      className: save.meta.playerProfile?.className ?? '2年A班',
    });
  state.summaryStore = save.payload.summaryStore;
  cacheStatusData(state.statusData);
  guardedAdapterSave(state.statusData);
  rebuildRuntimeAfterRestore();
  render();
}

function returnToTitle() {
  if (state.activeRunId) {
    persistToSave();
  }
  state.activeRunId = null;
  state.activeSaveId = null;
  setActiveRunId(null);
  clearActiveSaveId();
  state.creatingCharacter = false;
  render();
}

// ── UI actions (thin wrappers that stay in index.ts) ──

function openReaderContextMenu(readerIndex: number, clientX: number, clientY: number) {
  const message = getReaderMessageByIndex(state, readerIndex);
  if (!message) return;
  const maxX = Math.max(
    READER_CONTEXT_MENU_GAP,
    window.innerWidth - READER_CONTEXT_MENU_WIDTH - READER_CONTEXT_MENU_GAP,
  );
  const maxY = Math.max(
    READER_CONTEXT_MENU_GAP,
    window.innerHeight - READER_CONTEXT_MENU_HEIGHT - READER_CONTEXT_MENU_GAP,
  );
  state.readerContextMenu = {
    readerIndex,
    sourceUserText: getSourceUserTextForReaderIndex(state, readerIndex),
    canDeleteMessage: Boolean(message),
    x: clamp(clientX, READER_CONTEXT_MENU_GAP, maxX),
    y: clamp(clientY, READER_CONTEXT_MENU_GAP, maxY),
  };
  render();
}

function focusComposer(placeCursorAtEnd = true) {
  window.requestAnimationFrame(() => {
    const textarea =
      root?.querySelector<HTMLTextAreaElement>('.phone-modal.is-open .composer-input') ??
      root?.querySelector<HTMLTextAreaElement>('.composer-input');
    if (!textarea) return;
    textarea.focus();
    if (placeCursorAtEnd) {
      const offset = textarea.value.length;
      textarea.setSelectionRange(offset, offset);
    }
  });
}

function focusMessage(delta: number) {
  const nextIndex = clampFocusedMessageIndex(state, state.focusedMessageIndex + delta);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = delta > 0 ? 'forward' : 'backward';
  ctx.closeReaderContextMenu(false);
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

function jumpMessage(index: number) {
  const nextIndex = clampFocusedMessageIndex(state, index);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = nextIndex > state.focusedMessageIndex ? 'forward' : 'backward';
  ctx.closeReaderContextMenu(false);
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

async function rollbackToReaderInput(readerIndex: number) {
  const target = await rollbackConversation(state, readerIndex, win);
  if (!target?.sourceUserText) return;
  state.draft = target.sourceUserText;
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
  focusComposer();
}

async function regenerateReaderMessage(readerIndex: number) {
  if (state.generating) return;
  const target = await rollbackConversation(state, readerIndex, win);
  if (!target?.sourceUserText) return;
  state.draft = target.sourceUserText;
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
  await submitMessage(ctx, { text: target.sourceUserText, keepDraft: true, clearDraftOnSuccess: true });
}

async function deleteReaderFloor(readerIndex: number) {
  if (state.generating) return;
  const deleted = await deleteReaderMessage(state, readerIndex, win);
  if (!deleted) return;
  guardedAdapterSave(state.statusData);
  ctx.persistConversation();
  ctx.closeReaderContextMenu(false);
  render();
}

function navigatePhone(route: PhoneRoute) {
  navigatePhoneRoute(state, route, ctx);
}

function navigatePhoneBack() {
  navigatePhoneBackRoute(state, ctx);
}

function switchTab(tab: TabKey) {
  navigatePhone(getRouteForTab(tab));
}

function openPhone(targetRoute?: PhoneRoute) {
  openPhoneRoute(state, ctx, targetRoute);
}

function closePhone() {
  closePhoneRoute(state, ctx);
}

function openNotification() {
  if (!state.notification) return;
  openPhone(getRouteForTab(state.notification.targetTab));
}

// ── Reader drag ──

function bindReaderDragEvents() {
  root?.querySelectorAll<HTMLElement>('.paper-reader').forEach(reader => {

  reader.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-action="jump-message"]')) return;
    readerDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedInBody: Boolean((event.target as HTMLElement).closest('.reader-card__body')),
      intentLocked: false,
      scrolling: false,
      moved: false,
    };
    if (!readerDragState.startedInBody) {
      reader.setPointerCapture(event.pointerId);
      readerDragState.intentLocked = true;
    }
  });

  reader.addEventListener('pointermove', event => {
    if (!readerDragState || event.pointerId !== readerDragState.pointerId) return;
    const dx = event.clientX - readerDragState.startX;
    const dy = event.clientY - readerDragState.startY;
    if (readerDragState.scrolling) return;
    if (!readerDragState.intentLocked && readerDragState.startedInBody) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        readerDragState.scrolling = true;
        return;
      }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        readerDragState.intentLocked = true;
        reader.setPointerCapture(event.pointerId);
      } else {
        return;
      }
    }
    if (Math.abs(dx) > 6) readerDragState.moved = true;
    if (!readerDragState.moved) return;
    const card = reader.querySelector<HTMLElement>('.reader-card');
    if (!card) return;
    const tryingDirection = dx < 0 ? 'next' : 'prev';
    const canFlip = canFlipReader(tryingDirection);
    if (!canFlip) {
      const resistedOffset = Math.sign(dx) * Math.min(Math.abs(dx), 18) * 0.18;
      card.style.transition = 'none';
      card.style.transform = `perspective(1200px) translateX(${resistedOffset}px)`;
      card.style.opacity = '1';
      return;
    }
    const progress = Math.min(Math.abs(dx) / 160, 1);
    const tilt = dx > 0 ? -6 * progress : 6 * progress;
    card.style.transition = 'none';
    card.style.transform = `perspective(1200px) translateX(${dx * 0.28}px) rotateY(${tilt}deg)`;
    card.style.opacity = String(Math.max(1 - progress * 0.32, 0.6));
  });

  const finishReaderDrag = (event: PointerEvent) => {
    if (!readerDragState || event.pointerId !== readerDragState.pointerId) return;
    if (reader.hasPointerCapture(event.pointerId)) reader.releasePointerCapture(event.pointerId);
    const dx = event.clientX - readerDragState.startX;
    const moved = readerDragState.moved;
    const scrolling = readerDragState.scrolling;
    readerDragState = null;
    if (scrolling) return;
    const THRESHOLD = 60;
    if (moved && Math.abs(dx) >= THRESHOLD) {
      if (dx < 0 && canFlipReader('next')) {
        focusMessage(1);
        return;
      }
      if (dx > 0 && canFlipReader('prev')) {
        focusMessage(-1);
        return;
      }
      resetReaderCardTransform(reader);
    } else {
      resetReaderCardTransform(reader);
    }
  };
  reader.addEventListener('pointerup', finishReaderDrag);
  reader.addEventListener('pointercancel', finishReaderDrag);
  });
}

// ── Context menu ──

function bindReaderContextMenuEvents() {
  root?.querySelectorAll<HTMLElement>('.reader-card').forEach(card => {
    card.addEventListener('contextmenu', event => {
    event.preventDefault();
    const readerCard = event.currentTarget as HTMLElement;
    openReaderContextMenu(
      Number(readerCard.dataset.readerIndex ?? state.focusedMessageIndex),
      event.clientX,
      event.clientY,
    );
  });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-message"]').forEach(button => {
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      openReaderContextMenu(Number(button.dataset.index ?? 0), event.clientX, event.clientY);
    });
  });
}

// ── Event binding ──

function bindEvents() {
  root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(textarea => {
  textarea.addEventListener('input', event => {
    state.draft = (event.target as HTMLTextAreaElement).value;
    root?.querySelectorAll<HTMLTextAreaElement>('.composer-input').forEach(other => {
      if (other !== event.target) other.value = state.draft;
    });
  });
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitMessage(ctx);
    }
  });
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab as TabKey));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-phone-route]').forEach(button => {
    button.addEventListener('click', () => navigatePhone(button.dataset.phoneRoute as PhoneRoute));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="phone-back"]').forEach(button => {
    button.addEventListener('click', () => navigatePhoneBack());
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="focus-message"]').forEach(button => {
    button.addEventListener('click', () => focusMessage(Number(button.dataset.direction ?? 0)));
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="jump-message"]').forEach(button => {
    button.addEventListener('click', () => jumpMessage(Number(button.dataset.index ?? 0)));
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-rollback"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void rollbackToReaderInput(state.readerContextMenu.readerIndex);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-regenerate"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void regenerateReaderMessage(state.readerContextMenu.readerIndex);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="reader-delete"]')?.addEventListener('click', () => {
    if (!state.readerContextMenu) return;
    void deleteReaderFloor(state.readerContextMenu.readerIndex);
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="close-phone"]').forEach(button => {
    button.addEventListener('click', () => closePhone());
  });
  root?.querySelector<HTMLButtonElement>('[data-action="return-to-title"]')?.addEventListener('click', () => {
    returnToTitle();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="manual-save"]')?.addEventListener('click', () => {
    persistManualSave();
    render();
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-action="send"]').forEach(button => button.addEventListener('click', () => {
    void submitMessage(ctx);
  }));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="dep-down"]')
    ?.addEventListener('click', () => changeDependency(ctx, -1));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="dep-up"]')
    ?.addEventListener('click', () => changeDependency(ctx, 1));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="open-notification"]')
    ?.addEventListener('click', () => openNotification());

  // Summary actions
  function triggerSummary(mode: 'auto' | 'minor' | 'major') {
    if (state.summarizing) return;
    state.summarizing = true;
    render();
    runSummary(
      {
        win,
        summaryStore: state.summaryStore,
        summaryApiConfig: state.summaryApiConfig,
        uiMessages: state.uiMessages,
        onStoreUpdated: () => {
          persistToSave();
          state.summarizing = false;
          render();
        },
      },
      mode,
    ).catch(() => {
      state.summarizing = false;
      render();
    });
  }

  root
    ?.querySelector<HTMLButtonElement>('[data-action="summary-minor"]')
    ?.addEventListener('click', () => triggerSummary('minor'));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="summary-major"]')
    ?.addEventListener('click', () => triggerSummary('major'));
  root?.querySelectorAll<HTMLButtonElement>('[data-action="summary-reroll"]').forEach(button => {
    button.addEventListener('click', () => {
      const level = button.dataset.rerollLevel as 'minor' | 'major';
      const index = parseInt(button.dataset.rerollIndex ?? '', 10);
      if (!level || isNaN(index)) return;
      if (state.summarizing) return;
      state.summarizing = true;
      render();
      rerollSummaryEntry(
        {
          win,
          summaryStore: state.summaryStore,
          summaryApiConfig: state.summaryApiConfig,
          uiMessages: state.uiMessages,
          onStoreUpdated: () => {
            persistToSave();
            state.summarizing = false;
            render();
          },
        },
        level,
        index,
      ).catch(() => {
        state.summarizing = false;
        render();
      });
    });
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-retry"]')?.addEventListener('click', () => {
    state.summaryStore.lastError = null;
    state.summaryStore.consecutiveFailures = 0;
    triggerSummary('auto');
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-resume"]')?.addEventListener('click', () => {
    resumeAutoSummary(state.summaryStore);
    persistToSave();
    render();
  });
  root?.querySelector<HTMLInputElement>('[data-action="summary-toggle-custom"]')?.addEventListener('change', event => {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) {
      state.summaryApiConfig = { apiurl: '', key: '', model: '', source: 'openai' };
    } else {
      state.summaryApiConfig = null;
      saveSummaryApiConfig(null);
    }
    render();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="summary-save-config"]')?.addEventListener('click', () => {
    const apiurl = root?.querySelector<HTMLInputElement>('[data-field="summary-apiurl"]')?.value ?? '';
    const key = root?.querySelector<HTMLInputElement>('[data-field="summary-key"]')?.value ?? '';
    const model = root?.querySelector<HTMLInputElement>('[data-field="summary-model"]')?.value ?? '';
    const source = root?.querySelector<HTMLInputElement>('[data-field="summary-source"]')?.value ?? 'openai';
    const config: SummaryApiConfig = { apiurl, key, model, source };
    state.summaryApiConfig = config;
    saveSummaryApiConfig(config);
    render();
  });

  bindFloatingPhoneEvents(root, state, openPhone);
  bindReaderDragEvents();
  bindReaderContextMenuEvents();
}

// ── Render ──

const titleCallbacks: TitleCallbacks = {
  enterSave,
  returnToTitle,
  startCreating: () => {
    state.creatingCharacter = true;
    render();
  },
  createAndEnter: opts => {
    const save = createSave(opts);
    enterSave(save.saveId);
  },
  deleteSave: id => {
    deleteSave(id);
    if (state.activeSaveId === id) {
      state.activeRunId = null;
      state.activeSaveId = null;
      setActiveRunId(null);
      clearActiveSaveId();
    }
  },
  render: () => render(),
};

function render() {
  if (!root) return;
  if (state.activeRunId) {
    // Game screen
    syncFocusedMessage(state);
    refreshWeatherForCurrentState(state, render);
    root.innerHTML = renderApp(state, flipDirection);
    bindEvents();
  } else if (state.creatingCharacter) {
    // Character creation screen
    root.innerHTML = renderCharacterCreation();
    bindCharacterCreationEvents(root, titleCallbacks);
  } else {
    // Title home screen
    root.innerHTML = renderTitleHome();
    bindTitleHomeEvents(root, titleCallbacks);
  }
}

// ── Global events ──

window.addEventListener('resize', () => {
  ctx.closeReaderContextMenu(false);
  syncFloatingPhoneAfterResize(state);
  render();
});

window.addEventListener(
  'pointerdown',
  event => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('[data-reader-context-menu="true"]')) return;
    ctx.closeReaderContextMenu(true);
  },
  true,
);

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.readerContextMenu) {
    event.preventDefault();
    ctx.closeReaderContextMenu(true);
    return;
  }
  if (event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusMessage(-1);
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    focusMessage(1);
  }
});

// ── Async init ──

async function init() {
  adapter = await createVariableAdapter(win);
  state.summaryApiConfig = loadSummaryApiConfig();
  setupStreamingHooks(ctx, eventStops);
  const persistedRunId = getActiveRunId();
  const persistedSaveId = getActiveSaveId();
  if (persistedSaveId && loadSave(persistedSaveId)) {
    enterSave(persistedSaveId);
    return;
  }
  if (persistedRunId) {
    const autosaveId = `autosave_${persistedRunId}`;
    if (loadSave(autosaveId)) {
      enterSave(autosaveId);
      return;
    }
    setActiveRunId(null);
    clearActiveSaveId();
  }
  render();
}
init();

// ── Debug interfaces ──

(window as any).render_game_to_text = () => {
  const target = getActiveTarget(state.statusData);
  return JSON.stringify({
    screen: state.activeRunId ? 'game' : 'title',
    activeRunId: state.activeRunId,
    activeSaveId: state.activeSaveId,
    phoneOpen: state.phoneOpen,
    phoneRoute: state.phoneRoute,
    phoneRouteHistory: state.phoneRouteHistory,
    phoneTab: state.activeTab,
    generating: state.generating,
    focusedMessageIndex: state.focusedMessageIndex,
    draft: state.draft,
    world: state.statusData.world,
    activeTarget: target ? { id: target.id, name: target.name, affinity: target.affinity, stage: target.stage } : null,
    messageCount: state.uiMessages.length,
  });
};

(window as any).advanceTime = () => {
  if (adapter) {
    const data = adapter.load();
    if (JSON.stringify(data) !== JSON.stringify(state.statusData)) {
      state.statusData = data;
      cacheStatusData(data);
      render();
    }
  }
};
