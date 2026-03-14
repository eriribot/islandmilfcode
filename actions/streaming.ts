import { extractContextReply } from '../message-format';
import { syncFocusedMessage } from '../state/store';
import { formatTime } from '../variables/normalize';
import type { AppState, NotificationState, TavernWindow, UiMessage } from '../types';
import { getActiveTarget } from '../types';

export type StreamingContext = {
  state: AppState;
  win: TavernWindow;
  render: () => void;
  showNotification: (n: NotificationState) => void;
};

export function ensureStreamingMessage(ctx: StreamingContext) {
  const { state } = ctx;
  const current = state.uiMessages[state.uiMessages.length - 1];
  if (current?.streaming) {
    return current;
  }

  const target = getActiveTarget(state.statusData);
  const message: UiMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    speaker: target?.name ?? '助手',
    text: '',
    streaming: true,
  };
  state.uiMessages = [...state.uiMessages, message];
  return message;
}

export function updateStreamingText(ctx: StreamingContext, text: string) {
  const current = ensureStreamingMessage(ctx);
  current.text = extractContextReply(text, { streaming: true });
  syncFocusedMessage(ctx.state, { keepLatest: true });
  ctx.render();
}

export function finalizeStreamingText(ctx: StreamingContext, text: string, generationId = ctx.state.currentGenerationId) {
  const { state } = ctx;
  if (generationId && state.finalizedGenerationId === generationId) {
    return;
  }

  if (generationId) {
    state.finalizedGenerationId = generationId;
  }

  const current = ensureStreamingMessage(ctx);
  current.text = extractContextReply(text) || current.text;
  current.streaming = false;
  state.currentGenerationId = '';
  syncFocusedMessage(state, { keepLatest: true });

  if (current.text) {
    const target = getActiveTarget(state.statusData);
    const targetAlias = target?.alias ?? target?.name ?? '角色';
    ctx.showNotification({
      kind: 'message',
      title: `${targetAlias}发来一条新记录`,
      preview: current.text,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return;
  }

  ctx.render();
}

export function setupStreamingHooks(ctx: StreamingContext, eventStops: Array<() => void>) {
  const { win, state } = ctx;
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
        updateStreamingText(ctx, String(fullText ?? ''));
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
        finalizeStreamingText(ctx, String(text ?? ''), generationId);
      }
    });
    eventStops.push(stop.stop);
  }
}
