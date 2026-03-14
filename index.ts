import './styles.css';

import { buildPrompt, extractContextReply, getReaderMessages, getVisibleMessageText } from './message-format';
import { renderApp } from './render';
import { clamp, dependencyStage, formatTime, loadStatusData, saveStatusData } from './status-data';
import type { AppState, FloatingPhonePosition, NotificationState, TabKey, TavernWindow, UiMessage } from './types';

const win = window as TavernWindow;
const root = document.querySelector<HTMLDivElement>('#app');

const FLOATING_PHONE_STORAGE_KEY = 'antiml-floating-phone-position-v3';
const FLOATING_PHONE_CUSTOMIZED_KEY = 'antiml-floating-phone-customized-v3';
const FLOATING_PHONE_EDGE_GAP = 18;
const FLOATING_PHONE_DRAG_THRESHOLD = 6;

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

  if (direction === 'prev') {
    return state.focusedMessageIndex > 0;
  }

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
    // ignore storage failures
  }
}

function markFloatingPhoneCustomized() {
  try {
    window.localStorage.setItem(FLOATING_PHONE_CUSTOMIZED_KEY, '1');
  } catch {
    // ignore storage failures
  }
}

function hasCustomizedFloatingPhonePosition() {
  try {
    return window.localStorage.getItem(FLOATING_PHONE_CUSTOMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

const state: AppState = {
  activeTab: 'summary',
  phoneOpen: false,
  floatingPhone: loadFloatingPhonePosition(),
  focusedMessageIndex: 0,
  focusedMessagePage: 0,
  draft: '',
  generating: false,
  currentGenerationId: '',
  finalizedGenerationId: '',
  uiMessages: [
    {
      id: crypto.randomUUID(),
      role: 'system',
      speaker: '记录',
      text: '',
    },
  ],
  statusData: loadStatusData(win),
  notification: null,
};

const eventStops: Array<() => void> = [];

function clampFocusedMessageIndex(index: number) {
  return clamp(index, 0, Math.max(getReaderMessages(state.uiMessages).length - 1, 0));
}

function syncFocusedMessage(options: { keepLatest?: boolean } = {}) {
  const { keepLatest = false } = options;
  const readerMessages = getReaderMessages(state.uiMessages);

  state.focusedMessageIndex = keepLatest
    ? Math.max(readerMessages.length - 1, 0)
    : clampFocusedMessageIndex(state.focusedMessageIndex);
  state.focusedMessagePage = 0;
}

function showNotification(notification: NotificationState) {
  state.notification = notification;
  render();
}

function clearNotification(shouldRender = false) {
  if (!state.notification) return;
  state.notification = null;
  if (shouldRender) render();
}

function ensureStreamingMessage() {
  const current = state.uiMessages[state.uiMessages.length - 1];
  if (current?.streaming) {
    return current;
  }

  const message: UiMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    speaker: '白娅',
    text: '',
    streaming: true,
  };
  state.uiMessages = [...state.uiMessages, message];
  return message;
}

function updateStreamingText(text: string) {
  const current = ensureStreamingMessage();
  current.text = extractContextReply(text, { streaming: true });
  syncFocusedMessage({ keepLatest: true });
  render();
}

function finalizeStreamingText(text: string, generationId = state.currentGenerationId) {
  if (generationId && state.finalizedGenerationId === generationId) {
    return;
  }

  if (generationId) {
    state.finalizedGenerationId = generationId;
  }

  const current = ensureStreamingMessage();
  current.text = extractContextReply(text) || current.text;
  current.streaming = false;
  state.currentGenerationId = '';
  syncFocusedMessage({ keepLatest: true });

  if (current.text) {
    showNotification({
      kind: 'message',
      title: '白娅发来一条新记录',
      preview: current.text,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }

  render();
}

function pushMessage(message: UiMessage) {
  state.uiMessages = [...state.uiMessages, message];
  syncFocusedMessage({ keepLatest: true });
}

async function appendHiddenLog(role: 'system' | 'assistant' | 'user', message: string) {
  try {
    await win.createChatMessages?.([{ role, message, is_hidden: false }], { refresh: 'none' });
  } catch {
    // ignore outside Tavern
  }
}

async function simulateGeneration(userInput: string) {
  const lines = [
    `${userInput}`,
    `${state.statusData.world.currentLocation} 依旧安静，纸页上的字迹缓慢向下延伸。`,
    '白鸦没有立刻抬头，只让这段记录继续留在纸上。',
  ];

  let built = '';
  for (const line of lines) {
    built = built ? `${built}\n${line}` : line;
    updateStreamingText(`<content>${built}</content>`);
    await new Promise(resolve => window.setTimeout(resolve, 240));
  }

  finalizeStreamingText(`<content>${built}</content>`);
  await appendHiddenLog('assistant', built);
}

async function submitMessage() {
  const userInput = state.draft.trim();
  if (!userInput || state.generating) {
    return;
  }

  state.generating = true;
  state.draft = '';
  state.currentGenerationId = crypto.randomUUID();
  state.finalizedGenerationId = '';
  state.focusedMessagePage = 0;
  clearNotification(false);

  pushMessage({
    id: crypto.randomUUID(),
    role: 'user',
    speaker: '我',
    text: userInput,
  });
  render();

  await appendHiddenLog('user', userInput);

  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  if (!hasTavernGenerate) {
    await simulateGeneration(userInput);
    state.generating = false;
    render();
    return;
  }

  try {
    ensureStreamingMessage();
    render();

    const generator = win.generate ?? win.generateRaw;
    const baseConfig: Record<string, unknown> = {
      should_stream: true,
      should_silence: true,
      generation_id: state.currentGenerationId,
    };

    const result = await generator?.(
      generator === win.generateRaw
        ? {
            ...baseConfig,
            ordered_prompts: [
              {
                role: 'system',
                content: buildPrompt(state.statusData, ''),
              },
              {
                role: 'user',
                content: userInput,
              },
            ],
          }
        : {
            ...baseConfig,
            user_input: buildPrompt(state.statusData, userInput),
          },
    );

    const rawText = String(result ?? '');
    const replyText = extractContextReply(rawText);
    finalizeStreamingText(rawText, state.currentGenerationId);
    await appendHiddenLog('assistant', replyText || rawText);
  } catch (error) {
    finalizeStreamingText(
      `<content>续写失败：${error instanceof Error ? error.message : String(error)}</content>`,
      state.currentGenerationId,
    );
  } finally {
    state.generating = false;
    render();
  }
}

function focusMessage(delta: number) {
  const nextIndex = clampFocusedMessageIndex(state.focusedMessageIndex + delta);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = delta > 0 ? 'forward' : 'backward';
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

function jumpMessage(index: number) {
  const nextIndex = clampFocusedMessageIndex(index);
  if (nextIndex === state.focusedMessageIndex) return;
  flipDirection = nextIndex > state.focusedMessageIndex ? 'forward' : 'backward';
  state.focusedMessageIndex = nextIndex;
  state.focusedMessagePage = 0;
  render();
  flipDirection = '';
}

function switchTab(tab: TabKey) {
  state.activeTab = tab;
  if (tab === state.notification?.targetTab) {
    clearNotification(false);
  }
  render();
}

function openPhone(targetTab?: TabKey) {
  state.phoneOpen = true;
  state.activeTab = targetTab ?? state.activeTab ?? 'summary';
  if (state.activeTab === state.notification?.targetTab) {
    clearNotification(false);
  }
  render();
}

function closePhone() {
  if (!state.phoneOpen) return;
  state.phoneOpen = false;
  render();
}

function openNotification() {
  if (!state.notification) return;
  openPhone(state.notification.targetTab);
}

function changeDependency(delta: number) {
  state.statusData.baiya.dependency = clamp(state.statusData.baiya.dependency + delta, 0, 100);
  state.statusData.baiya.stage = dependencyStage(state.statusData.baiya.dependency);
  saveStatusData(win, state.statusData);
  showNotification({
    kind: 'status',
    title: '角色状态已更新',
    preview: `白鸦当前阶段：${state.statusData.baiya.stage} · 依赖度 ${state.statusData.baiya.dependency}%`,
    targetTab: 'status',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
}

function syncStatusData() {
  const next = loadStatusData(win);
  if (JSON.stringify(next) !== JSON.stringify(state.statusData)) {
    state.statusData = next;
    showNotification({
      kind: 'status',
      title: '状态数据同步完成',
      preview: `${next.world.currentLocation} · ${next.baiya.stage}`,
      targetTab: 'status',
      timestamp: formatTime(next.world.currentTime),
    });
  }
}

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

    state.floatingPhone = clampFloatingPhonePosition({
      x: dragState.originX + dx,
      y: dragState.originY + dy,
    });
    applyFloatingPhonePosition(button, state.floatingPhone);
  });

  const finishDrag = (event: PointerEvent) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    if (button.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId);
    }

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

function bindReaderDragEvents() {
  const reader = root?.querySelector<HTMLElement>('.paper-reader');
  if (!reader) return;

  reader.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // Don't capture if clicking on a preview button
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

    if (reader.hasPointerCapture(event.pointerId)) {
      reader.releasePointerCapture(event.pointerId);
    }

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

function bindEvents() {
  const textarea = root?.querySelector<HTMLTextAreaElement>('.composer-input');
  textarea?.addEventListener('input', event => {
    state.draft = (event.target as HTMLTextAreaElement).value;
  });
  textarea?.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitMessage();
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

  root?.querySelectorAll<HTMLButtonElement>('[data-action="close-phone"]').forEach(button => {
    button.addEventListener('click', () => closePhone());
  });
  root?.querySelector<HTMLButtonElement>('[data-action="send"]')?.addEventListener('click', () => {
    void submitMessage();
  });
  root
    ?.querySelector<HTMLButtonElement>('[data-action="dep-down"]')
    ?.addEventListener('click', () => changeDependency(-1));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="dep-up"]')
    ?.addEventListener('click', () => changeDependency(1));
  root
    ?.querySelector<HTMLButtonElement>('[data-action="open-notification"]')
    ?.addEventListener('click', () => openNotification());

  bindFloatingPhoneEvents();
  bindReaderDragEvents();
}

function syncScrollPositions() {
  const chatList = root?.querySelector<HTMLElement>('[data-scroll-region="chat"]');
  if (!chatList) return;
  chatList.scrollTop = chatList.scrollHeight;
}

function render() {
  if (!root) return;
  syncFocusedMessage();
  root.innerHTML = renderApp(state, flipDirection);
  bindEvents();
}

function setupStreamingHooks() {
  if (typeof win.eventOn !== 'function' || !win.iframe_events) {
    return;
  }

  const fully = win.iframe_events.STREAM_TOKEN_RECEIVED_FULLY;
  const ended = win.iframe_events.GENERATION_ENDED;

  if (fully) {
    const stop = win.eventOn(fully, (fullText: string, generationId: string) => {
      if (
        state.finalizedGenerationId !== generationId &&
        (!state.currentGenerationId || generationId === state.currentGenerationId)
      ) {
        updateStreamingText(String(fullText ?? ''));
      }
    });
    eventStops.push(stop.stop);
  }

  if (ended) {
    const stop = win.eventOn(ended, (text: string, generationId: string) => {
      if (
        state.finalizedGenerationId !== generationId &&
        (!state.currentGenerationId || generationId === state.currentGenerationId)
      ) {
        finalizeStreamingText(String(text ?? ''), generationId);
      }
    });
    eventStops.push(stop.stop);
  }
}

window.addEventListener('resize', () => {
  state.floatingPhone = hasCustomizedFloatingPhonePosition()
    ? clampFloatingPhonePosition(state.floatingPhone)
    : getDefaultFloatingPhonePosition();

  if (hasCustomizedFloatingPhonePosition()) {
    persistFloatingPhonePosition(state.floatingPhone);
  }
  render();
});

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    focusMessage(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    focusMessage(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    focusMessage(-1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusMessage(1);
  }
});

setupStreamingHooks();
render();
window.setInterval(syncStatusData, 1500);

(window as any).render_game_to_text = () =>
  JSON.stringify({
    screen: 'antiml diary paper page with draggable floating phone',
    phoneOpen: state.phoneOpen,
    phoneTab: state.activeTab,
    generating: state.generating,
    focusedMessageIndex: state.focusedMessageIndex,
    focusedMessagePage: state.focusedMessagePage,
    floatingPhone: state.floatingPhone,
    world: state.statusData.world,
    baiya: {
      dependency: state.statusData.baiya.dependency,
      stage: state.statusData.baiya.stage,
      titles: Object.keys(state.statusData.baiya.titles),
    },
    notification: state.notification,
    messageCount: state.uiMessages.length,
    lastMessage: state.uiMessages[state.uiMessages.length - 1]
      ? getVisibleMessageText(state.uiMessages[state.uiMessages.length - 1]!)
      : '',
  });

(window as any).advanceTime = () => {
  syncStatusData();
};
