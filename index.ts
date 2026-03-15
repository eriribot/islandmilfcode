import './styles.css';

import { getReaderMessages, getVisibleMessageText } from './message-format';
import { renderApp } from './render';
import { clamp } from './variables/normalize';
import { formatTime } from './variables/normalize';
import {
  createInitialState,
  clampFocusedMessageIndex,
  syncFocusedMessage,
  getReaderMessageByIndex,
  getSourceUserTextForReaderIndex,
  loadConversationHistory,
  replaceConversationMessages,
  rollbackConversation,
  saveMessagesToVariables,
} from './state/store';
import { createVariableAdapter, type VariableAdapter } from './variables/adapter';
import { submitMessage, changeDependency, type ActionContext } from './actions';
import { setupStreamingHooks } from './actions/streaming';
import type { FloatingPhonePosition, NotificationState, TabKey, TavernWindow } from './types';
import { getActiveTarget } from './types';

const win = window as TavernWindow;
const root = document.querySelector<HTMLDivElement>('#app');

const FLOATING_PHONE_STORAGE_KEY = 'antiml-floating-phone-position-v3';
const FLOATING_PHONE_CUSTOMIZED_KEY = 'antiml-floating-phone-customized-v3';
const FLOATING_PHONE_EDGE_GAP = 18;
const FLOATING_PHONE_DRAG_THRESHOLD = 6;
const READER_CONTEXT_MENU_GAP = 12;
const READER_CONTEXT_MENU_WIDTH = 240;
const READER_CONTEXT_MENU_HEIGHT = 176;

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
  } catch { /* ignore */ }
}

function markFloatingPhoneCustomized() {
  try {
    window.localStorage.setItem(FLOATING_PHONE_CUSTOMIZED_KEY, '1');
  } catch { /* ignore */ }
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

// Action context — lazily references adapter (set during init)
const ctx: ActionContext = {
  get state() { return state; },
  get win() { return win; },
  get adapter() { return adapter; },
  render: () => render(),
  showNotification: (n: NotificationState) => { state.notification = n; render(); },
  clearNotification: (shouldRender: boolean) => {
    if (!state.notification) return;
    state.notification = null;
    if (shouldRender) render();
  },
  persistConversation: () => {
    saveMessagesToVariables(win, state.uiMessages);
  },
  closeReaderContextMenu: (shouldRender: boolean) => {
    if (!state.readerContextMenu) return;
    state.readerContextMenu = null;
    if (shouldRender) render();
  },
};

// ── UI actions (thin wrappers that stay in index.ts) ──

function openReaderContextMenu(readerIndex: number, clientX: number, clientY: number) {
  const message = getReaderMessageByIndex(state, readerIndex);
  if (!message) return;
  const maxX = Math.max(READER_CONTEXT_MENU_GAP, window.innerWidth - READER_CONTEXT_MENU_WIDTH - READER_CONTEXT_MENU_GAP);
  const maxY = Math.max(READER_CONTEXT_MENU_GAP, window.innerHeight - READER_CONTEXT_MENU_HEIGHT - READER_CONTEXT_MENU_GAP);
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
      startX: event.clientX, startY: event.clientY,
      originX: state.floatingPhone.x, originY: state.floatingPhone.y,
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
      startX: event.clientX, startY: event.clientY,
      startedInBody: Boolean((event.target as HTMLElement).closest('.reader-card__body')),
      intentLocked: false, scrolling: false, moved: false,
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
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { readerDragState.scrolling = true; return; }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        readerDragState.intentLocked = true;
        reader.setPointerCapture(event.pointerId);
      } else { return; }
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
      if (dx < 0 && canFlipReader('next')) { focusMessage(1); return; }
      if (dx > 0 && canFlipReader('prev')) { focusMessage(-1); return; }
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
    openReaderContextMenu(Number(readerCard.dataset.readerIndex ?? state.focusedMessageIndex), event.clientX, event.clientY);
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
  textarea?.addEventListener('input', event => { state.draft = (event.target as HTMLTextAreaElement).value; });
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
  root?.querySelector<HTMLButtonElement>('[data-action="send"]')?.addEventListener('click', () => {
    void submitMessage(ctx);
  });
  root?.querySelector<HTMLButtonElement>('[data-action="dep-down"]')?.addEventListener('click', () => changeDependency(ctx, -1));
  root?.querySelector<HTMLButtonElement>('[data-action="dep-up"]')?.addEventListener('click', () => changeDependency(ctx, 1));
  root?.querySelector<HTMLButtonElement>('[data-action="open-notification"]')?.addEventListener('click', () => openNotification());

  bindFloatingPhoneEvents();
  bindReaderDragEvents();
  bindReaderContextMenuEvents();
}

// ── Render ──

function render() {
  if (!root) return;
  syncFocusedMessage(state);
  root.innerHTML = renderApp(state, flipDirection);
  bindEvents();
}

async function reloadConversation(options: { resetDraft?: boolean } = {}) {
  const { resetDraft = false } = options;
  const loadedMessages = await loadConversationHistory(win);
  replaceConversationMessages(state, loadedMessages);
  state.currentGenerationId = '';
  state.finalizedGenerationId = '';
  state.generating = false;
  state.notification = null;
  state.readerContextMenu = null;
  if (resetDraft) {
    state.draft = '';
  }
  render();
}

function setupConversationSyncHooks() {
  if (typeof win.eventOn !== 'function' || !win.tavern_events) {
    return;
  }

  const { CHAT_CHANGED } = win.tavern_events;

  if (CHAT_CHANGED) {
    const stop = win.eventOn(CHAT_CHANGED, async () => {
      state.statusData = adapter.load();
      await reloadConversation({ resetDraft: true });
    });
    eventStops.push(stop.stop);
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

window.addEventListener('pointerdown', event => {
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target.closest('[data-reader-context-menu="true"]')) return;
  ctx.closeReaderContextMenu(true);
}, true);

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.readerContextMenu) {
    event.preventDefault();
    ctx.closeReaderContextMenu(true);
    return;
  }
  if (event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusMessage(-1); }
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusMessage(1); }
});

// ── Async init ──

async function init() {
  adapter = await createVariableAdapter(win);
  state.statusData = adapter.load();
  setupStreamingHooks(ctx, eventStops);
  await reloadConversation();
  setupConversationSyncHooks();
  const stopAdapterUpdate = adapter.onUpdate(data => {
    if (JSON.stringify(data) !== JSON.stringify(state.statusData)) {
      state.statusData = data;
      const target = getActiveTarget(data);
      ctx.showNotification({
        kind: 'status',
        title: 'Status updated',
        preview: `${data.world.currentLocation} · ${target?.stage ?? ''}`,
        targetTab: 'status',
        timestamp: formatTime(data.world.currentTime),
      });
    }
  });
  eventStops.push(stopAdapterUpdate);
}
init();

// ── Debug interfaces ──

(window as any).render_game_to_text = () => {
  const target = getActiveTarget(state.statusData);
  return JSON.stringify({
    screen: 'antiml diary paper page with draggable floating phone',
    phoneOpen: state.phoneOpen,
    phoneTab: state.activeTab,
    generating: state.generating,
    focusedMessageIndex: state.focusedMessageIndex,
    focusedMessagePage: state.focusedMessagePage,
    draft: state.draft,
    floatingPhone: state.floatingPhone,
    world: state.statusData.world,
    activeTarget: target ? {
      id: target.id, name: target.name, affinity: target.affinity,
      stage: target.stage, titles: Object.keys(target.titles),
    } : null,
    notification: state.notification,
    readerContextMenu: state.readerContextMenu ? {
      readerIndex: state.readerContextMenu.readerIndex,
      sourceUserText: state.readerContextMenu.sourceUserText,
    } : null,
    messageCount: state.uiMessages.length,
    lastMessage: state.uiMessages[state.uiMessages.length - 1]
      ? getVisibleMessageText(state.uiMessages[state.uiMessages.length - 1]!)
      : '',
  });
};

(window as any).advanceTime = () => {
  if (adapter) {
    const data = adapter.load();
    if (JSON.stringify(data) !== JSON.stringify(state.statusData)) {
      state.statusData = data;
      render();
    }
  }
};
