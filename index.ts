import './styles.css';
import './title/styles.css';

import { changeDependency, submitMessage, type ActionContext } from './actions';
import { setupStreamingHooks } from './actions/streaming';
import { getReaderMessages } from './message-format';
import { renderApp } from './render';
import { createSave, deleteSave, loadSave, writeSave } from './state/saves';
import {
  clampFocusedMessageIndex,
  createInitialState,
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
import type { FloatingPhonePosition, NotificationState, StatusData, TabKey, TavernWindow } from './types';
import { getActiveTarget } from './types';
import { createVariableAdapter, type VariableAdapter } from './variables/adapter';
import { clamp } from './variables/normalize';

const win = window as TavernWindow;
const root = document.querySelector<HTMLDivElement>('#app');

const FLOATING_PHONE_STORAGE_KEY = 'islandmilfcode-floating-phone-position-v3';
const FLOATING_PHONE_CUSTOMIZED_KEY = 'islandmilfcode-floating-phone-customized-v3';
const FLOATING_PHONE_EDGE_GAP = 18;
const FLOATING_PHONE_DRAG_THRESHOLD = 6;
const READER_CONTEXT_MENU_GAP = 12;
const READER_CONTEXT_MENU_WIDTH = 240;
const READER_CONTEXT_MENU_HEIGHT = 176;
const STATUS_CACHE_KEY = 'islandmilfcode-status-cache-v1';

let dragState: {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
} | null = null;
let suppressFloatingPhoneClick = false;
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

function getFloatingPhoneSize() {
  const isCompact = window.innerWidth <= 720;
  return {
    width: isCompact ? 84 : 82,
    height: isCompact ? 98 : 96,
    edgeGap: isCompact ? 12 : FLOATING_PHONE_EDGE_GAP,
  };
}

function clampFloatingPhonePosition(position: FloatingPhonePosition): FloatingPhonePosition {
  const { width, height, edgeGap } = getFloatingPhoneSize();
  const maxX = Math.max(edgeGap, window.innerWidth - width - edgeGap);
  const maxY = Math.max(edgeGap, window.innerHeight - height - edgeGap);
  return {
    x: clamp(position.x, edgeGap, maxX),
    y: clamp(position.y, edgeGap, maxY),
  };
}

function getDefaultFloatingPhonePosition(): FloatingPhonePosition {
  const { width, height, edgeGap } = getFloatingPhoneSize();
  return clampFloatingPhonePosition({
    x: window.innerWidth - width - edgeGap,
    y: window.innerHeight * 0.5 - height * 0.5,
  });
}

function loadFloatingPhonePosition(): FloatingPhonePosition {
  try {
    const customized = window.localStorage.getItem(FLOATING_PHONE_CUSTOMIZED_KEY) === '1';
    if (!customized) return getDefaultFloatingPhonePosition();
    const raw = window.localStorage.getItem(FLOATING_PHONE_STORAGE_KEY);
    if (!raw) return getDefaultFloatingPhonePosition();
    const parsed = JSON.parse(raw) as Partial<FloatingPhonePosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
      return getDefaultFloatingPhonePosition();
    }
    return clampFloatingPhonePosition({ x: parsed.x, y: parsed.y });
  } catch {
    return getDefaultFloatingPhonePosition();
  }
}

function persistFloatingPhonePosition(position: FloatingPhonePosition) {
  try {
    window.localStorage.setItem(FLOATING_PHONE_STORAGE_KEY, JSON.stringify(position));
  } catch {
    /* ignore */
  }
}

function markFloatingPhoneCustomized() {
  try {
    window.localStorage.setItem(FLOATING_PHONE_CUSTOMIZED_KEY, '1');
  } catch {
    /* ignore */
  }
}

function hasCustomizedFloatingPhonePosition() {
  try {
    return window.localStorage.getItem(FLOATING_PHONE_CUSTOMIZED_KEY) === '1';
  } catch {
    return false;
  }
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
  return STATUS_CACHE_KEY;
}

function cacheStatusData(data: StatusData) {
  try {
    localStorage.setItem(getStatusCacheKey(), JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function loadCachedStatusData(): StatusData | null {
  try {
    const raw = localStorage.getItem(getStatusCacheKey());
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

function persistToSave() {
  if (!state.activeSaveId) return;
  writeSave(state.activeSaveId, {
    messages: serializeMessages(state.uiMessages),
    statusData: state.statusData,
    summaryStore: state.summaryStore,
  });
}

function enterSave(saveId: string) {
  const save = loadSave(saveId);
  if (!save) return;
  state.activeSaveId = saveId;
  state.creatingCharacter = false;
  const msgs = deserializeMessages(save.messages);
  replaceConversationMessages(state, msgs);
  state.statusData = save.statusData;
  state.summaryStore = save.summaryStore;
  cacheStatusData(state.statusData);
  state.draft = '';
  state.generating = false;
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.notification = null;
  state.readerContextMenu = null;
  render();
}

function returnToTitle() {
  if (state.activeSaveId) {
    persistToSave();
  }
  state.activeSaveId = null;
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
    x: clamp(clientX, READER_CONTEXT_MENU_GAP, maxX),
    y: clamp(clientY, READER_CONTEXT_MENU_GAP, maxY),
  };
  render();
}

function focusComposer(placeCursorAtEnd = true) {
  window.requestAnimationFrame(() => {
    const textarea = root?.querySelector<HTMLTextAreaElement>('.composer-input');
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

function switchTab(tab: TabKey) {
  ctx.closeReaderContextMenu(false);
  state.activeTab = tab;
  if (tab === state.notification?.targetTab) ctx.clearNotification(false);
  render();
}

function openPhone(targetTab?: TabKey) {
  ctx.closeReaderContextMenu(false);
  state.phoneOpen = true;
  state.activeTab = targetTab ?? state.activeTab ?? 'summary';
  if (state.activeTab === state.notification?.targetTab) ctx.clearNotification(false);
  render();
}

function closePhone() {
  if (!state.phoneOpen) return;
  ctx.closeReaderContextMenu(false);
  state.phoneOpen = false;
  render();
}

function openNotification() {
  if (!state.notification) return;
  openPhone(state.notification.targetTab);
}

// ── Floating phone drag ──

function applyFloatingPhonePosition(button: HTMLElement, position: FloatingPhonePosition) {
  button.style.left = `${position.x}px`;
  button.style.top = `${position.y}px`;
}

function bindFloatingPhoneEvents() {
  const button = root?.querySelector<HTMLButtonElement>('[data-action="open-phone"]');
  if (!button) return;
  applyFloatingPhonePosition(button, state.floatingPhone);

  button.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.floatingPhone.x,
      originY: state.floatingPhone.y,
      moved: false,
    };
    suppressFloatingPhoneClick = false;
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-dragging');
    document.body.classList.add('floating-phone-dragging');
  });

  button.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) > FLOATING_PHONE_DRAG_THRESHOLD || Math.abs(dy) > FLOATING_PHONE_DRAG_THRESHOLD) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;
    state.floatingPhone = clampFloatingPhonePosition({ x: dragState.originX + dx, y: dragState.originY + dy });
    applyFloatingPhonePosition(button, state.floatingPhone);
  });

  const finishDrag = (event: PointerEvent) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    button.classList.remove('is-dragging');
    document.body.classList.remove('floating-phone-dragging');
    if (dragState.moved) {
      markFloatingPhoneCustomized();
      persistFloatingPhonePosition(state.floatingPhone);
      suppressFloatingPhoneClick = true;
    }
    dragState = null;
  };
  button.addEventListener('pointerup', finishDrag);
  button.addEventListener('pointercancel', finishDrag);

  button.addEventListener('click', event => {
    if (suppressFloatingPhoneClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressFloatingPhoneClick = false;
      return;
    }
    openPhone();
  });
}

// ── Reader drag ──

function bindReaderDragEvents() {
  const reader = root?.querySelector<HTMLElement>('.paper-reader');
  if (!reader) return;

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
}

// ── Context menu ──

function bindReaderContextMenuEvents() {
  root?.querySelector<HTMLElement>('.reader-card')?.addEventListener('contextmenu', event => {
    event.preventDefault();
    const readerCard = event.currentTarget as HTMLElement;
    openReaderContextMenu(
      Number(readerCard.dataset.readerIndex ?? state.focusedMessageIndex),
      event.clientX,
      event.clientY,
    );
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
  const textarea = root?.querySelector<HTMLTextAreaElement>('.composer-input');
  textarea?.addEventListener('input', event => {
    state.draft = (event.target as HTMLTextAreaElement).value;
  });
  textarea?.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitMessage(ctx);
    }
  });

  root?.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab as TabKey));
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
  root?.querySelectorAll<HTMLButtonElement>('[data-action="close-phone"]').forEach(button => {
    button.addEventListener('click', () => closePhone());
  });
  root?.querySelector<HTMLButtonElement>('[data-action="return-to-title"]')?.addEventListener('click', () => {
    returnToTitle();
  });
  root?.querySelector<HTMLButtonElement>('[data-action="send"]')?.addEventListener('click', () => {
    void submitMessage(ctx);
  });
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

  bindFloatingPhoneEvents();
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
    const saveId = createSave(opts);
    enterSave(saveId);
  },
  deleteSave: id => {
    deleteSave(id);
  },
  render: () => render(),
};

function render() {
  if (!root) return;
  if (state.activeSaveId) {
    // Game screen
    syncFocusedMessage(state);
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
  state.floatingPhone = hasCustomizedFloatingPhonePosition()
    ? clampFloatingPhonePosition(state.floatingPhone)
    : getDefaultFloatingPhonePosition();
  if (hasCustomizedFloatingPhonePosition()) persistFloatingPhonePosition(state.floatingPhone);
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
  // Start at title screen (activeSaveId is null)
  render();
}
init();

// ── Debug interfaces ──

(window as any).render_game_to_text = () => {
  const target = getActiveTarget(state.statusData);
  return JSON.stringify({
    screen: state.activeSaveId ? 'game' : 'title',
    activeSaveId: state.activeSaveId,
    phoneOpen: state.phoneOpen,
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
