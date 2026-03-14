import { buildPrompt, extractContextReply } from '../message-format';
import { pushMessage } from '../state/store';
import { clamp, serializeStatusData } from '../variables/normalize';
import { affinityStage, formatTime } from '../variables/normalize';
import type { VariableAdapter } from '../variables/adapter';
import type { AppState, NotificationState, TavernWindow } from '../types';
import { getActiveTarget } from '../types';
import {
  ensureStreamingMessage,
  updateStreamingText,
  finalizeStreamingText,
  type StreamingContext,
} from './streaming';

export type ActionContext = StreamingContext & {
  adapter: VariableAdapter;
  clearNotification: (shouldRender: boolean) => void;
  closeReaderContextMenu: (shouldRender: boolean) => void;
};

async function appendHiddenLog(
  win: TavernWindow,
  role: 'system' | 'assistant' | 'user',
  message: string,
  data?: Record<string, unknown>,
) {
  try {
    await win.createChatMessages?.([{ role, message, is_hidden: false, data }], { refresh: 'none' });
  } catch {
    // ignore outside Tavern
  }
}

function getMvuData(ctx: ActionContext): Record<string, unknown> | undefined {
  if (ctx.adapter.source !== 'mvu') return undefined;
  return { stat_data: serializeStatusData(ctx.state.statusData) };
}

async function simulateGeneration(ctx: ActionContext, userInput: string) {
  const { state } = ctx;
  const target = getActiveTarget(state.statusData);
  const alias = target?.alias ?? target?.name ?? '角色';
  const lines = [
    `${userInput}`,
    `${state.statusData.world.currentLocation} 依旧安静，纸页上的字迹缓慢向下延伸。`,
    `${alias}没有立刻抬头，只让这段记录继续留在纸上。`,
  ];

  let built = '';
  for (const line of lines) {
    built = built ? `${built}\n${line}` : line;
    updateStreamingText(ctx, `<content>${built}</content>`);
    await new Promise(resolve => window.setTimeout(resolve, 240));
  }

  finalizeStreamingText(ctx, `<content>${built}</content>`);
  await appendHiddenLog(ctx.win, 'assistant', built, getMvuData(ctx));
}

export async function submitMessage(
  ctx: ActionContext,
  options: { text?: string; keepDraft?: boolean; clearDraftOnSuccess?: boolean } = {},
) {
  const { state, win } = ctx;
  const userInput = (options.text ?? state.draft).trim();
  if (!userInput || state.generating) {
    return;
  }

  state.generating = true;
  if (!options.keepDraft || options.text == null) {
    state.draft = '';
  }
  state.currentGenerationId = crypto.randomUUID();
  state.finalizedGenerationId = '';
  state.focusedMessagePage = 0;
  ctx.clearNotification(false);
  ctx.closeReaderContextMenu(false);

  pushMessage(state, {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: '我',
    text: userInput,
  });
  ctx.render();

  await appendHiddenLog(win, 'user', userInput, getMvuData(ctx));

  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  if (!hasTavernGenerate) {
    await simulateGeneration(ctx, userInput);
    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    state.generating = false;
    ctx.render();
    return;
  }

  try {
    ensureStreamingMessage(ctx);
    ctx.render();

    const requestGenerationId = state.currentGenerationId;
    const generator = win.generate ?? win.generateRaw;
    const baseConfig: Record<string, unknown> = {
      should_stream: true,
      should_silence: true,
      generation_id: requestGenerationId,
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
    finalizeStreamingText(ctx, rawText, requestGenerationId);
    await appendHiddenLog(win, 'assistant', replyText || rawText, getMvuData(ctx));
    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
  } catch (error) {
    const requestGenerationId = state.currentGenerationId;
    finalizeStreamingText(
      ctx,
      `<content>续写失败：${error instanceof Error ? error.message : String(error)}</content>`,
      requestGenerationId,
    );
  } finally {
    state.generating = false;
    ctx.render();
  }
}

export function changeDependency(ctx: ActionContext, delta: number) {
  const { state } = ctx;
  const target = getActiveTarget(state.statusData);
  if (!target) return;
  target.affinity = clamp(target.affinity + delta, 0, 100);
  target.stage = affinityStage(target.affinity);
  ctx.adapter.save(state.statusData);
  const alias = target.alias ?? target.name;
  ctx.showNotification({
    kind: 'status',
    title: '角色状态已更新',
    preview: `${alias}当前阶段：${target.stage} · 依赖度 ${target.affinity}%`,
    targetTab: 'status',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
}
