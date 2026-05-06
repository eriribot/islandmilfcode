import { extractContextReply } from '../message-format';
import { syncFocusedMessage } from '../state/store';
import type { AppState, NotificationState, TavernWindow, UiMessage } from '../types';
import { getActiveTarget } from '../types';
import { formatTime } from '../variables/normalize';

export type StreamingContext = {
  state: AppState;
  win: TavernWindow;
  render: () => void;
  showNotification: (n: NotificationState) => void;
  persistConversation: () => void;
};

export function recordGenerationDebug(
  ctx: Pick<StreamingContext, 'state' | 'win'>,
  event: string,
  detail: Record<string, unknown> = {},
) {
  const { state, win } = ctx;
  const last = state.uiMessages[state.uiMessages.length - 1];
  const entry = {
    at: new Date().toISOString(),
    event,
    currentGenerationId: state.currentGenerationId,
    finalizedGenerationId: state.finalizedGenerationId,
    generating: state.generating,
    uiMessageCount: state.uiMessages.length,
    lastRole: last?.role ?? '',
    lastStreaming: Boolean(last?.streaming),
    lastTextLength: String(last?.text ?? '').length,
    lastVisibleLength: last?.role === 'assistant' ? extractContextReply(last.text).length : String(last?.text ?? '').length,
    ...detail,
  };

  // 保留最近 120 条生成诊断，复现吞楼层后可在控制台查看 window.__islandmilfcodeDebug。
  const flags = (state.runtimeFlags ??= {});
  const list = Array.isArray(flags.generationDebug) ? flags.generationDebug : [];
  list.push(entry);
  flags.generationDebug = list.slice(-120);
  (win as TavernWindow & { __islandmilfcodeDebug?: unknown }).__islandmilfcodeDebug = flags.generationDebug;
}

export function ensureStreamingMessage(ctx: StreamingContext) {
  const { state } = ctx;
  const current = state.uiMessages[state.uiMessages.length - 1];
  if (current?.streaming) {
    recordGenerationDebug(ctx, 'ensureStreamingMessage:reuse');
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
  recordGenerationDebug(ctx, 'ensureStreamingMessage:create', { messageId: message.id });
  return message;
}

export function updateStreamingText(ctx: StreamingContext, text: string) {
  const current = ensureStreamingMessage(ctx);
  const visibleText = extractContextReply(text, { streaming: true });
  recordGenerationDebug(ctx, 'stream:update', {
    rawLength: String(text ?? '').length,
    visibleLength: visibleText.length,
    keptExisting: !visibleText && Boolean(current.text),
  });
  // 酒馆后台生成偶尔会冒出没有正文标签的流式事件；不要用空解析结果吞掉已经写出的正文。
  if (visibleText || !current.text) {
    current.text = visibleText;
  }
  syncFocusedMessage(ctx.state, { keepLatest: true });
  ctx.render();
}

export function discardStreamingMessage(ctx: StreamingContext) {
  const { state } = ctx;
  const current = state.uiMessages[state.uiMessages.length - 1];
  if (!current?.streaming) {
    recordGenerationDebug(ctx, 'discard:skip-no-streaming');
    return false;
  }

  // 主请求偶尔会在流式正文已经到达后再抛错；此时不能删楼层，否则会出现“实际生成了但少一层”。
  if (current.text.trim()) {
    current.streaming = false;
    state.currentGenerationId = '';
    syncFocusedMessage(state, { keepLatest: true });
    ctx.persistConversation();
    recordGenerationDebug(ctx, 'discard:preserve-streaming-text');
    return false;
  }

  state.uiMessages = state.uiMessages.slice(0, -1);
  state.currentGenerationId = '';
  syncFocusedMessage(state, { keepLatest: true });
  ctx.persistConversation();
  recordGenerationDebug(ctx, 'discard:removed-empty-streaming');
  return true;
}

export function finalizeStreamingText(
  ctx: StreamingContext,
  text: string,
  generationId = ctx.state.currentGenerationId,
  options: { allowEmpty?: boolean } = {},
) {
  const { state } = ctx;
  if (generationId && state.finalizedGenerationId === generationId) {
    recordGenerationDebug(ctx, 'finalize:skip-already-finalized', { generationId });
    return;
  }

  const current = ensureStreamingMessage(ctx);
  const visibleText = extractContextReply(text);
  recordGenerationDebug(ctx, 'finalize:attempt', {
    generationId,
    rawLength: String(text ?? '').length,
    visibleLength: visibleText.length,
    allowEmpty: Boolean(options.allowEmpty),
  });

  // 流式结束事件有时只包含思考标签或前置文本，真正的 <content> 会在 generate() 返回值里。
  // 这种空正文不能标记 finalized，否则后续真实正文会被同一个 generationId 跳过。
  if (!visibleText && !current.text && !options.allowEmpty) {
    recordGenerationDebug(ctx, 'finalize:defer-empty-visible', { generationId });
    ctx.render();
    return;
  }

  if (generationId) {
    state.finalizedGenerationId = generationId;
  }

  current.text = visibleText || current.text;
  current.streaming = false;
  state.currentGenerationId = '';
  syncFocusedMessage(state, { keepLatest: true });
  ctx.persistConversation();
  recordGenerationDebug(ctx, 'finalize:committed', {
    generationId,
    committedTextLength: current.text.length,
  });

  if (current.text) {
    // 正文更新只显示简短提示
    ctx.showNotification({
      kind: 'message',
      title: '新消息',
      preview: '',
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

  // 判断是否为后台任务（摘要/变量提取/手机聊天）的 generationId。
  function isBackgroundGeneration(generationId: unknown): boolean {
    return (
      typeof generationId === 'string' &&
      (generationId.startsWith('summary-') ||
        generationId.startsWith('progress-') ||
        generationId.startsWith('phone-'))
    );
  }

  // 判断该事件是否属于当前正在进行的主生成。
  // 有 id 时必须匹配当前正文；没有 id 时也要求正文 id 仍存在，
  // 这样正文 finalize 清掉 currentGenerationId 后，变量提取/手机/总结都不会再写正文卡片。
  function isActiveMainGeneration(generationId: unknown): boolean {
    if (typeof generationId === 'string' && generationId) {
      if (state.finalizedGenerationId === generationId) return false;
      return Boolean(state.currentGenerationId && generationId === state.currentGenerationId);
    }
    return Boolean(state.generating && state.currentGenerationId);
  }

  if (fully) {
    const stop = win.eventOn(fully, (fullText: string, generationId: string) => {
      if (isBackgroundGeneration(generationId)) {
        recordGenerationDebug(ctx, 'event:fully-ignore-background', { generationId, rawLength: String(fullText ?? '').length });
        return;
      }
      if (isActiveMainGeneration(generationId)) {
        recordGenerationDebug(ctx, 'event:fully-accept', { generationId, rawLength: String(fullText ?? '').length });
        updateStreamingText(ctx, String(fullText ?? ''));
      } else {
        recordGenerationDebug(ctx, 'event:fully-ignore-inactive', {
          generationId,
          rawLength: String(fullText ?? '').length,
        });
      }
    });
    eventStops.push(stop.stop);
  }

  if (ended) {
    const stop = win.eventOn(ended, (text: string, generationId: string) => {
      if (isBackgroundGeneration(generationId)) {
        recordGenerationDebug(ctx, 'event:ended-ignore-background', { generationId, rawLength: String(text ?? '').length });
        return;
      }
      // 无 id 的结束事件容易和后续显式 finalize 重复，只让主请求返回值负责最终落正文。
      if (typeof generationId !== 'string' || !generationId) {
        recordGenerationDebug(ctx, 'event:ended-ignore-no-id', { rawLength: String(text ?? '').length });
        return;
      }
      if (isActiveMainGeneration(generationId)) {
        recordGenerationDebug(ctx, 'event:ended-accept', { generationId, rawLength: String(text ?? '').length });
        finalizeStreamingText(ctx, String(text ?? ''), generationId, { allowEmpty: false });
      } else {
        recordGenerationDebug(ctx, 'event:ended-ignore-inactive', {
          generationId,
          rawLength: String(text ?? '').length,
        });
      }
    });
    eventStops.push(stop.stop);
  }
}
