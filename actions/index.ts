import {
  buildPhoneChatPrompt,
  buildPhoneProgressPrompt,
  buildProgressPrompt,
  buildPrompt,
  extractPhoneChatReply,
  parseProgressUpdate,
} from '../message-format';
import { pushMessage } from '../state/store';
import { runSummary, type SummaryContext } from '../summary';
import type { SummaryApiConfig, SummaryStore } from '../summary/types';
import { getActiveTarget } from '../types';
import type { PhoneChatMessage, PhoneProactiveState, TargetStatus } from '../types';
import type { VariableAdapter } from '../variables/adapter';
import { affinityStage, applyProgressUpdate, clamp, formatTime } from '../variables/normalize';
import {
  discardStreamingMessage,
  ensureStreamingMessage,
  finalizeStreamingText,
  type StreamingContext,
  updateStreamingText,
} from './streaming';

export type ActionContext = StreamingContext & {
  adapter: VariableAdapter;
  clearNotification: (shouldRender: boolean) => void;
  closeReaderContextMenu: (shouldRender: boolean) => void;
  persistConversation: () => void;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  onSummaryStoreUpdated: () => void;
};

const PHONE_PROACTIVE_COOLDOWN_MS = 3 * 60 * 1000;

async function simulateGeneration(ctx: ActionContext, userInput: string) {
  const { state } = ctx;
  const target = getActiveTarget(state.statusData);
  const alias = target?.alias ?? target?.name ?? 'Target';
  const lines = [
    userInput,
    `${state.statusData.world.currentLocation} has gone quiet for a moment.`,
    `${alias} seems to react to what you just said and continues the scene.`,
  ];

  let built = '';
  for (const line of lines) {
    built = built ? `${built}\n${line}` : line;
    updateStreamingText(ctx, `<content>${built}</content>`);
    await new Promise(resolve => window.setTimeout(resolve, 240));
  }

  finalizeStreamingText(ctx, `<content>${built}</content>`);
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
    speaker: 'User',
    text: userInput,
    statusSnapshot: JSON.parse(JSON.stringify(state.statusData)),
  });
  ctx.persistConversation();
  ctx.render();

  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  const eventBeforeGeneration = getLatestRecentEvent(ctx)?.key ?? null;
  if (!hasTavernGenerate) {
    await simulateGeneration(ctx, userInput);
    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    state.generating = false;
    await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration);
    ctx.render();
    return;
  }

  let generationSucceeded = false;
  try {
    ensureStreamingMessage(ctx);
    ctx.render();

    const promptHistory = state.uiMessages.slice(0, -1);
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
                content: buildPrompt(state.statusData, promptHistory, '', ctx.summaryStore, {
                  playerProfile: state.playerProfile,
                  skipProgress: !!ctx.summaryApiConfig,
                }),
              },
              {
                role: 'user',
                content: userInput,
              },
            ],
          }
        : {
            ...baseConfig,
            user_input: buildPrompt(state.statusData, promptHistory, userInput, ctx.summaryStore, {
              playerProfile: state.playerProfile,
              skipProgress: !!ctx.summaryApiConfig,
            }),
          },
    );

    finalizeStreamingText(ctx, String(result ?? ''), requestGenerationId);

    // 解析 <progress> 并应用变量更新。
    if (ctx.summaryApiConfig) {
      // 副 API 负责变量提取。
      try {
        const progressPrompts = buildProgressPrompt(state.statusData, state.uiMessages.slice(-6));
        const progressConfig: Record<string, unknown> = {
          should_silence: true,
          should_stream: false,
          generation_id: `progress-${crypto.randomUUID()}`,
          ordered_prompts: progressPrompts,
          custom_api: {
            apiurl: ctx.summaryApiConfig.apiurl,
            key: ctx.summaryApiConfig.key,
            model: ctx.summaryApiConfig.model,
            source: ctx.summaryApiConfig.source,
          },
        };
        const progressResult = await win.generateRaw?.(progressConfig);
        const progressRaw = String(progressResult ?? '');
        const progressUpdate = parseProgressUpdate(progressRaw);
        if (progressUpdate) {
          applyProgressUpdate(state.statusData, progressUpdate);
          ctx.adapter.save(state.statusData);
        }
      } catch (e) {
        console.warn('[progress] secondary API failed:', e);
      }
    } else {
      // 主 API 的回复中已经包含 <progress>。
      const mainRaw = String(result ?? '');
      const progressUpdate = parseProgressUpdate(mainRaw);
      if (progressUpdate) {
        applyProgressUpdate(state.statusData, progressUpdate);
        ctx.adapter.save(state.statusData);
      }
    }

    // 在最新助手消息上保存 statusData 快照，供回溯使用。
    const lastMsg = state.uiMessages[state.uiMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.statusSnapshot = JSON.parse(JSON.stringify(state.statusData));
      ctx.persistConversation();
    }

    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    generationSucceeded = true;
    state.generating = false;
    await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration);
  } catch (error) {
    discardStreamingMessage(ctx);
    state.draft = userInput;
    state.currentGenerationId = '';
    ctx.persistConversation();
    ctx.showNotification({
      kind: 'status',
      title: '生成失败',
      preview: error instanceof Error ? error.message : String(error),
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
  } finally {
    state.generating = false;
    ctx.render();

    // 后台触发摘要，不阻塞当前生成流程。
    if (generationSucceeded && typeof win.generateRaw === 'function') {
      const summaryCtx: SummaryContext = {
        win,
        summaryStore: ctx.summaryStore,
        summaryApiConfig: ctx.summaryApiConfig,
        uiMessages: state.uiMessages,
        onStoreUpdated: () => {
          ctx.onSummaryStoreUpdated();
          ctx.render();
        },
      };
      runSummary(summaryCtx).catch(() => {
        /* 摘要错误在内部处理 */
      });
    }
  }
}

function getPhoneThreadTarget(ctx: ActionContext, targetId: string): TargetStatus | null {
  return ctx.state.statusData.targets.find(target => target.id === targetId) ?? null;
}

function ensurePhoneThread(ctx: ActionContext, target: TargetStatus) {
  const existing = ctx.state.phoneMessages.threads[target.id];
  if (existing) return existing;

  const thread = {
    targetId: target.id,
    messages: [] as PhoneChatMessage[],
    unread: 0,
    updatedAt: Date.now(),
  };
  ctx.state.phoneMessages.threads = {
    ...ctx.state.phoneMessages.threads,
    [target.id]: thread,
  };
  return thread;
}

async function simulatePhoneGeneration(target: TargetStatus, userInput: string) {
  await new Promise(resolve => window.setTimeout(resolve, 240));
  return `<message>${target.alias ?? target.name}：我看到消息了。关于“${userInput}”，等见面时再继续说吧。</message>`;
}

function getLatestRecentEvent(ctx: ActionContext) {
  const [name, description] = Object.entries(ctx.state.statusData.world.recentEvents)[0] ?? [];
  if (!name || !description) return null;
  return {
    key: `${name}:${description}`,
    text: `${name}：${description}`,
  };
}

function getPhoneProactiveState(ctx: ActionContext): PhoneProactiveState {
  const flags = (ctx.state.runtimeFlags ??= {});
  const raw = flags.phoneProactive;
  if (raw && typeof raw === 'object') {
    return raw as PhoneProactiveState;
  }
  const next: PhoneProactiveState = {};
  flags.phoneProactive = next;
  return next;
}

function shouldQueueProactivePhoneMessage(
  ctx: ActionContext,
  target: TargetStatus,
  eventKey: string,
  previousEventKey?: string | null,
) {
  if (previousEventKey === eventKey) return false;
  if (ctx.state.phoneMessages.generating || ctx.state.generating) return false;
  const proactiveState = getPhoneProactiveState(ctx);
  if (proactiveState.lastEventKey === eventKey) return false;
  const lastQueuedAt = Number(proactiveState.lastQueuedAt ?? 0) || 0;
  if (Date.now() - lastQueuedAt < PHONE_PROACTIVE_COOLDOWN_MS) return false;
  const thread = ctx.state.phoneMessages.threads[target.id];
  const lastMessage = thread?.messages[thread.messages.length - 1];
  if (lastMessage?.role === 'assistant' && Date.now() - thread.updatedAt < PHONE_PROACTIVE_COOLDOWN_MS) return false;
  return true;
}

async function maybeQueueProactivePhoneMessage(ctx: ActionContext, previousEventKey?: string | null) {
  const { state, win } = ctx;
  const target = getActiveTarget(state.statusData);
  const latestEvent = getLatestRecentEvent(ctx);
  const hasTavernGenerate = typeof win.generateRaw === 'function' || typeof win.generate === 'function';
  if (!target || !latestEvent || !hasTavernGenerate) return;
  if (!shouldQueueProactivePhoneMessage(ctx, target, latestEvent.key, previousEventKey)) return;

  const proactiveState = getPhoneProactiveState(ctx);
  proactiveState.lastEventKey = latestEvent.key;
  proactiveState.lastQueuedAt = Date.now();

  const thread = ensurePhoneThread(ctx, target);
  const prompt = buildPhoneChatPrompt({
    statusData: state.statusData,
    target,
    history: thread.messages,
    userInput:
      '根据刚刚正文发生的事件，如果你会主动发一条手机消息，就生成这条消息；如果完全不该主动联系，也要用角色口吻发一条很短的试探或回避消息。',
    playerProfile: state.playerProfile,
    skipProgress: true,
    triggerEvent: latestEvent.text,
  });

  try {
    const generationId = `phone-proactive-${crypto.randomUUID()}`;
    const rawResult =
      typeof win.generateRaw === 'function'
        ? await win.generateRaw({
            should_silence: true,
            should_stream: false,
            generation_id: generationId,
            ordered_prompts: [
              {
                role: 'system',
                content: prompt,
              },
            ],
          })
        : await win.generate?.({
            should_silence: true,
            should_stream: false,
            generation_id: generationId,
            user_input: prompt,
          });
    const replyText = extractPhoneChatReply(String(rawResult ?? '')).trim();
    if (!replyText) return;

    const assistantMessage: PhoneChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      speaker: target.alias ?? target.name,
      text: replyText,
      timestamp: formatTime(state.statusData.world.currentTime),
      statusSnapshot: JSON.parse(JSON.stringify(state.statusData)),
    };

    thread.messages = [...thread.messages, assistantMessage];
    thread.updatedAt = Date.now();
    if (!(state.phoneOpen && state.phoneRoute === 'app:chat' && state.phoneMessages.activeThreadId === target.id)) {
      thread.unread += 1;
    }
    ctx.persistConversation();
    ctx.showNotification({
      kind: 'message',
      title: `${target.alias ?? target.name} 发来一条消息`,
      preview: replyText,
      targetTab: 'summary',
      phoneRoute: 'app:chat',
      targetId: target.id,
      timestamp: formatTime(state.statusData.world.currentTime),
    });
  } catch (e) {
    console.warn('[phone-proactive] generation failed:', e);
  }
}

export async function submitPhoneMessage(ctx: ActionContext, targetId: string) {
  const { state, win } = ctx;
  const target = getPhoneThreadTarget(ctx, targetId);
  const userInput = state.phoneMessages.draft.trim();
  if (!target || !userInput || state.phoneMessages.generating) return;

  const thread = ensurePhoneThread(ctx, target);
  const now = formatTime(state.statusData.world.currentTime);
  const userMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: state.playerProfile.name.trim() || '我',
    text: userInput,
    timestamp: now,
    statusSnapshot: JSON.parse(JSON.stringify(state.statusData)),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  state.phoneMessages.draft = '';
  state.phoneMessages.generating = true;
  state.phoneMessages.activeThreadId = target.id;
  ctx.persistConversation();
  ctx.render();

  const hasTavernGenerate = typeof win.generateRaw === 'function' || typeof win.generate === 'function';
  let rawResult = '';

  try {
    if (hasTavernGenerate) {
      const generationId = `phone-${crypto.randomUUID()}`;
      const prompt = buildPhoneChatPrompt({
        statusData: state.statusData,
        target,
        history: thread.messages,
        userInput,
        playerProfile: state.playerProfile,
        skipProgress: true,
      });

      if (typeof win.generateRaw === 'function') {
        rawResult = String(
          (await win.generateRaw({
            should_silence: true,
            should_stream: false,
            generation_id: generationId,
            ordered_prompts: [
              {
                role: 'system',
                content: prompt,
              },
            ],
          })) ?? '',
        );
      } else {
        rawResult = String(
          (await win.generate?.({
            should_silence: true,
            should_stream: false,
            generation_id: generationId,
            user_input: prompt,
          })) ?? '',
        );
      }
    } else {
      rawResult = await simulatePhoneGeneration(target, userInput);
    }

    const replyText = extractPhoneChatReply(rawResult) || '……';
    const assistantMessage: PhoneChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      speaker: target.alias ?? target.name,
      text: replyText,
      timestamp: formatTime(state.statusData.world.currentTime),
    };

    thread.messages = [...thread.messages, assistantMessage];
    thread.updatedAt = Date.now();

    if (hasTavernGenerate) {
      try {
        const progressPrompts = buildPhoneProgressPrompt({
          statusData: state.statusData,
          target,
          messages: thread.messages,
        });
        let progressRaw = '';

        if (ctx.summaryApiConfig && typeof win.generateRaw === 'function') {
          progressRaw = String(
            (await win.generateRaw({
              should_silence: true,
              should_stream: false,
              generation_id: `phone-progress-${crypto.randomUUID()}`,
              ordered_prompts: progressPrompts,
              custom_api: {
                apiurl: ctx.summaryApiConfig.apiurl,
                key: ctx.summaryApiConfig.key,
                model: ctx.summaryApiConfig.model,
                source: ctx.summaryApiConfig.source,
              },
            })) ?? '',
          );
        } else if (typeof win.generateRaw === 'function') {
          progressRaw = String(
            (await win.generateRaw({
              should_silence: true,
              should_stream: false,
              generation_id: `phone-progress-${crypto.randomUUID()}`,
              ordered_prompts: progressPrompts,
            })) ?? '',
          );
        } else if (typeof win.generate === 'function') {
          progressRaw = String(
            (await win.generate({
              should_silence: true,
              should_stream: false,
              generation_id: `phone-progress-${crypto.randomUUID()}`,
              user_input: progressPrompts.map(prompt => prompt.content).join('\n\n'),
            })) ?? '',
          );
        }

        const progressUpdate = parseProgressUpdate(progressRaw);
        if (progressUpdate) {
          applyProgressUpdate(state.statusData, progressUpdate, target.id);
          ctx.adapter.save(state.statusData);
        }
      } catch (e) {
        console.warn('[phone-progress] analysis failed:', e);
      }
    } else {
      const progressUpdate = parseProgressUpdate(rawResult);
      if (progressUpdate) {
        applyProgressUpdate(state.statusData, progressUpdate, target.id);
        ctx.adapter.save(state.statusData);
      }
    }

    assistantMessage.statusSnapshot = JSON.parse(JSON.stringify(state.statusData));
    ctx.persistConversation();
  } catch (error) {
    thread.messages = thread.messages.filter(message => message.id !== userMessage.id);
    thread.updatedAt = Date.now();
    state.phoneMessages.draft = userInput;
    ctx.showNotification({
      kind: 'status',
      title: '消息发送失败',
      preview: error instanceof Error ? error.message : String(error),
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
  } finally {
    state.phoneMessages.generating = false;
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
    title: 'Relationship updated',
    preview: `${alias}: ${target.stage} · ${target.affinity}%`,
    targetTab: 'status',
    timestamp: formatTime(state.statusData.world.currentTime),
  });
}
