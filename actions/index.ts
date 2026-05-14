import {
  buildPhoneChatPrompt,
  buildPhoneProgressPrompt,
  buildProgressPrompt,
  buildPrompt,
  extractPhoneChatReply,
  extractTaggedReply,
  type ProgressUpdate,
  getVisibleMessageText,
  parseProgressUpdate,
} from '../message-format';
import { clearBackgroundTask, setBackgroundTaskFailed, setBackgroundTaskRunning } from '../background-tasks';
import { generateSecondaryRaw } from '../secondary-api';
import { createRollbackSnapshot, pushMessage } from '../state/store';
import { buildFactAnchorFromStatus, runSummary, shouldRunMinorSummary, type SummaryContext } from '../summary';
import type { SummaryApiConfig, SummaryStore } from '../summary/types';
import type {
  PhoneChatMessage,
  PhoneProactiveState,
  PlayerProfile,
  PlayerStats,
  PlotLibrary,
  ScenePresence,
  TargetStatus,
  UiMessage,
} from '../types';
import type { VariableAdapter } from '../variables/adapter';
import {
  affinityStage,
  applyProgressUpdate,
  clamp,
  formatTime,
  normalizeIncomingTime,
  syncMainEvents,
} from '../variables/normalize';
import {
  discardStreamingMessage,
  ensureStreamingMessage,
  finalizeStreamingText,
  recordGenerationDebug,
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
const PHONE_ACTION_DETECTOR_CONFIDENCE = new Set(['high', 'medium', '中', '高', '确定', '较高']);

type PhoneDirective = {
  target: TargetStatus;
  text: string;
};

type ScenePhoneMessage = {
  target: TargetStatus;
  role: 'user' | 'assistant';
  text: string;
};

type RawPrompt = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

const DEFAULT_PLAYER_STATS: PlayerStats = {
  knowledge: 0,
  charm: 0,
  proficiency: 0,
  kindness: 0,
  courage: 0,
};

const LOCAL_LOCATION_KEYWORDS = [
  '视听教室',
  '家庭餐厅',
  '美术教室',
  '侦探坡',
  '天台',
  '走廊',
  '教室',
  '校门',
  '校园',
  '丰之崎学园',
  '学园',
  '街道',
  '公园',
  '伦也家',
  '电车',
  '出版社',
  '签名会现场',
];

function detectLocalTimeFromUserInput(userInput: string, currentTime: string): string | null {
  const text = userInput.trim();
  if (!text) return null;

  const hasExplicitDate =
    /\d{4}\s*[-年\/]\s*\d{1,2}\s*[-月\/]\s*\d{1,2}/.test(text) || /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(text);
  const hasAdvanceIntent = /(推进|跳到|快进|到了|来到|转到|时间|次日|翌日|第二天|明天|后天)/.test(text);
  if (!hasExplicitDate && !hasAdvanceIntent) return null;

  const nextTime = normalizeIncomingTime(text, currentTime);
  return nextTime !== currentTime ? nextTime : null;
}

function getScheduledLocationKeywords(plotLibrary: PlotLibrary | null | undefined): string[] {
  const values = new Set<string>();
  for (const event of Object.values(plotLibrary?.events ?? {})) {
    for (const location of event.schedule?.locations ?? []) {
      const loc = String(location ?? '').trim();
      if (!loc) continue;
      values.add(loc);
      for (const keyword of LOCAL_LOCATION_KEYWORDS) {
        if (loc.includes(keyword)) values.add(keyword);
      }
    }
  }
  for (const keyword of LOCAL_LOCATION_KEYWORDS) values.add(keyword);
  return Array.from(values).sort((a, b) => b.length - a.length);
}

function detectLocalLocationFromUserInput(
  userInput: string,
  plotLibrary: PlotLibrary | null | undefined,
): string | null {
  const text = userInput.trim();
  if (!text) return null;
  return getScheduledLocationKeywords(plotLibrary).find(location => text.includes(location)) ?? null;
}

function applyLocalWorldHintsFromUserInput(ctx: ActionContext, userInput: string): boolean {
  const { statusData, plotLibrary } = ctx.state;
  const nextTime = detectLocalTimeFromUserInput(userInput, statusData.world.currentTime);
  const nextLocation = detectLocalLocationFromUserInput(userInput, plotLibrary);
  let changed = false;

  if (nextTime && nextTime !== statusData.world.currentTime) {
    statusData.world.currentTime = nextTime;
    changed = true;
  }
  if (nextLocation && nextLocation !== statusData.world.currentLocation) {
    statusData.world.currentLocation = nextLocation;
    changed = true;
  }

  if (changed) {
    ctx.adapter.save(statusData);
    recordGenerationDebug(ctx, 'submit:local-world-hints', {
      time: nextTime ?? '',
      location: nextLocation ?? '',
    });
  }

  return changed;
}

// 把 AI 给的主线事件 id 跟剧情库（世界书里第一卷/第二卷/第三卷条目合并后的 plotLibrary.events）对一遍，
// 不在白名单里的整条丢掉。这样即使模型在空档期自造 SAE_2-1 之类的野 id，也只会影响正文叙述，不会污染 statusData。
function sanitizeProgressAgainstPlotLibrary(
  update: ProgressUpdate,
  plotLibrary: PlotLibrary | null | undefined,
): ProgressUpdate {
  const whitelist = plotLibrary ? new Set(Object.keys(plotLibrary.events)) : null;
  // 没有加载到剧情库（初始化中 / 世界书未挂载）时放行，避免误伤正常流程。
  if (!whitelist || whitelist.size === 0) return update;

  const sanitizedMainEvents: Record<string, string> = {};
  for (const [id, status] of Object.entries(update.mainEvents)) {
    if (whitelist.has(id)) {
      sanitizedMainEvents[id] = status;
    } else {
      console.warn('[progress-guard] drop unknown mainEvent id:', id);
    }
  }

  let sanitizedCurrentId = update.currentMainEventId;
  if (sanitizedCurrentId && !whitelist.has(sanitizedCurrentId)) {
    console.warn('[progress-guard] drop unknown currentMainEventId:', sanitizedCurrentId);
    sanitizedCurrentId = undefined;
  }

  return {
    ...update,
    mainEvents: sanitizedMainEvents,
    currentMainEventId: sanitizedCurrentId,
  };
}

function applyPlayerStatDeltas(playerProfile: PlayerProfile, update: ProgressUpdate | null) {
  if (!update || !Object.keys(update.statDeltas).length) return false;
  const current = { ...DEFAULT_PLAYER_STATS, ...(playerProfile.stats ?? {}) };
  let changed = false;

  for (const [key, delta] of Object.entries(update.statDeltas) as Array<[keyof PlayerStats, number]>) {
    if (!delta) continue;
    const nextValue = clamp((current[key] ?? 0) + delta, 0, 100);
    if (nextValue === current[key]) continue;
    current[key] = nextValue;
    changed = true;
  }

  if (changed) {
    playerProfile.stats = current;
  }
  return changed;
}

function findProgressTarget(ctx: ActionContext, targetHint: string): TargetStatus | null {
  const normalizedHint = normalizeForDirectiveMatch(targetHint);
  if (!normalizedHint) return null;

  return (
    ctx.state.statusData.targets.find(target => target.id === targetHint) ??
    ctx.state.statusData.targets.find(target =>
      getPhoneTargetSearchTerms(target)
        .map(term => normalizeForDirectiveMatch(term))
        .filter(Boolean)
        .some(term => term === normalizedHint),
    ) ??
    ctx.state.statusData.targets.find(target =>
      getPhoneTargetSearchTerms(target)
        .map(term => normalizeForDirectiveMatch(term))
        .filter(term => term.length >= 2)
        .some(term => term.includes(normalizedHint) || normalizedHint.includes(term)),
    ) ??
    null
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLatestAssistantSceneText(ctx: ActionContext) {
  for (let index = ctx.state.uiMessages.length - 1; index >= 0; index -= 1) {
    const message = ctx.state.uiMessages[index];
    if (message?.role !== 'assistant' || message.streaming) continue;
    return (getVisibleMessageText(message) || message.text || '').trim();
  }
  return '';
}

function getLatestCompletedTurnMessages(messages: UiMessage[]) {
  let latestAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && !message.streaming) {
      latestAssistantIndex = index;
      break;
    }
  }
  if (latestAssistantIndex < 0) return [];

  for (let index = latestAssistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return [message, messages[latestAssistantIndex]];
    if (message?.role === 'assistant') break;
  }

  return [messages[latestAssistantIndex]];
}

function targetTermsForPresence(target: TargetStatus) {
  return getPhoneTargetSearchTerms(target)
    .map(term => term.trim())
    .filter(term => term.length >= 2);
}

function textMentionsTarget(text: string, target: TargetStatus) {
  const normalizedText = normalizeForDirectiveMatch(text);
  if (!normalizedText) return false;

  return targetTermsForPresence(target)
    .map(term => normalizeForDirectiveMatch(term))
    .filter(Boolean)
    .some(term => normalizedText.includes(term));
}

function textMarksTargetFirmlyAbsent(text: string, target: TargetStatus) {
  // 只保留强不在场信号，且要求与目标名紧邻（4 字内），降低误判。
  // 移除了 "不在 / 没在 / 未在 / 离开 / 走开" — 这些常出现在正文末端位移或无关否定，不应当作绝对不在场。
  const strongAbsentWords = '不在场|不在这里|不在身边|缺席|没有出现|没有来|请假|今天没来';
  return targetTermsForPresence(target).some(term => {
    const escaped = escapeRegExp(term);
    const targetThenAbsent = new RegExp(`${escaped}.{0,4}(?:${strongAbsentWords})`);
    const absentThenTarget = new RegExp(`(?:${strongAbsentWords}).{0,4}${escaped}`);
    return targetThenAbsent.test(text) || absentThenTarget.test(text);
  });
}

function textContainsTargetActiveSignals(text: string, target: TargetStatus) {
  // 发声/动作反证：目标名紧跟发言动词或直接引用，即视为在场。
  const activeVerbs = '说|道|问|答|笑|叹|看|回头|点头|摇头|转身|开口|应道|回应|沉默|叹气|冷哼|哼|嘀咕|低声|喊|叫|皱眉';
  const quoteStarters = '[:：「『"“【]';
  return targetTermsForPresence(target).some(term => {
    const escaped = escapeRegExp(term);
    const verbPattern = new RegExp(`${escaped}\\s*(?:${activeVerbs})`);
    const quotePattern = new RegExp(`${escaped}\\s*${quoteStarters}`);
    return verbPattern.test(text) || quotePattern.test(text);
  });
}

type AffinityVerdict = 'forced' | 'mention' | 'unmentioned' | 'absent';

function classifyAffinityVerdict(
  ctx: ActionContext,
  target: TargetStatus,
  forcedTargetId?: string | null,
): AffinityVerdict {
  if (forcedTargetId) return target.id === forcedTargetId ? 'forced' : 'absent';

  const latestSceneText = getLatestAssistantSceneText(ctx);
  if (!latestSceneText) return 'unmentioned';

  // 发声反证优先级最高：哪怕后半段写了"离开"，只要目标前半段有发声，依然判在场。
  if (textContainsTargetActiveSignals(latestSceneText, target)) return 'mention';
  if (textMarksTargetFirmlyAbsent(latestSceneText, target)) return 'absent';
  if (textMentionsTarget(latestSceneText, target)) return 'mention';
  return 'unmentioned';
}

function clampAffinityByVerdict(delta: number, verdict: AffinityVerdict): number {
  if (!delta) return 0;
  if (verdict === 'absent') return 0;
  if (verdict === 'unmentioned') {
    return Math.sign(delta) * Math.min(Math.abs(delta), 1);
  }
  return delta;
}

function clampLegacyAffinityDelta(
  ctx: ActionContext,
  update: ProgressUpdate,
  targetId?: string | null,
): number | undefined {
  if (update.affinityDelta === undefined || update.affinityDelta === 0) return update.affinityDelta;
  if (targetId) return update.affinityDelta;

  // 主场景不再使用 activeTargetId 兜底，避免旧格式好感度长期落到加藤惠。
  console.warn('[progress] drop legacy affinity without explicit target');
  return undefined;
}

function applyTargetedAffinityDeltas(ctx: ActionContext, update: ProgressUpdate, forcedTargetId?: string | null) {
  let changed = false;

  for (const item of update.affinityDeltas) {
    if (!item.delta) continue;
    const target = findProgressTarget(ctx, item.target);
    if (!target) {
      console.warn('[progress] unknown affinity target:', item.target);
      continue;
    }

    const verdict = classifyAffinityVerdict(ctx, target, forcedTargetId);
    const effectiveDelta = clampAffinityByVerdict(item.delta, verdict);
    if (verdict === 'absent') {
      console.warn('[progress] drop affinity for absent target:', item.target);
      continue;
    }
    if (verdict === 'unmentioned') {
      console.warn('[progress] drop affinity for unmentioned target:', item.target);
      continue;
    }
    if (!effectiveDelta) continue;

    const nextAffinity = clamp((target.affinity ?? 0) + effectiveDelta, 0, 100);
    if (nextAffinity === target.affinity) continue;
    target.affinity = nextAffinity;
    target.stage = affinityStage(nextAffinity);
    changed = true;
  }

  return changed;
}

function applyFullProgressUpdate(ctx: ActionContext, update: ProgressUpdate | null, targetId?: string | null) {
  if (!update) return false;
  const sanitized = sanitizeProgressAgainstPlotLibrary(update, ctx.state.plotLibrary);
  const legacyDelta = clampLegacyAffinityDelta(ctx, sanitized, targetId);
  // 主场景没有明确对象时，丢弃旧单目标着装更新，避免误写到 activeTargetId。
  const outfitChanges = targetId ? sanitized.outfitChanges : {};
  const contextualized: ProgressUpdate = { ...sanitized, affinityDelta: legacyDelta, outfitChanges };
  applyProgressUpdate(ctx.state.statusData, contextualized, targetId ?? null, ctx.state.plotLibrary);
  const targetedAffinityChanged = applyTargetedAffinityDeltas(ctx, contextualized, targetId);
  const statsChanged = applyPlayerStatDeltas(ctx.state.playerProfile, contextualized);
  ctx.adapter.save(ctx.state.statusData);
  return targetedAffinityChanged || statsChanged || true;
}

async function simulateGeneration(ctx: ActionContext, userInput: string) {
  const { state } = ctx;
  const lines = [
    userInput,
    `${state.statusData.world.currentLocation} has gone quiet for a moment.`,
    'The scene reacts to what you just said and continues.',
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
  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  let phoneDirective: PhoneDirective | null = null;
  let phoneDirectiveSource: string | null = null;
  if (hasTavernGenerate && hasExplicitPhoneSendIntent(userInput)) {
    phoneDirective = await detectPhoneDirectiveWithLlm(ctx, userInput).catch(error => {
      console.warn('[phone-directive] detector failed:', error);
      return null;
    });
    if (phoneDirective) {
      phoneDirectiveSource = 'llm-detector';
    }
  }
  if (!phoneDirective) {
    phoneDirective = extractPhoneMessageDirective(ctx, userInput);
    if (phoneDirective) {
      phoneDirectiveSource = 'fallback-parser';
    }
  }
  recordGenerationDebug(ctx, 'submit:start', {
    userInputLength: userInput.length,
    keepDraft: Boolean(options.keepDraft),
    phoneDirectiveTargetId: phoneDirective?.target.id ?? null,
    phoneDirectiveSource,
  });
  ctx.clearNotification(false);
  ctx.closeReaderContextMenu(false);

  pushMessage(state, {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: 'User',
    text: userInput,
    statusSnapshot: createRollbackSnapshot(state),
  });
  ctx.persistConversation();
  ctx.render();

  if (phoneDirective) {
    recordGenerationDebug(ctx, 'submit:phone-directive-detected', {
      targetId: phoneDirective.target.id,
      textLength: phoneDirective.text.length,
      source: phoneDirectiveSource,
    });
  }
  const eventBeforeGeneration = getLatestRecentEvent(ctx)?.key ?? null;

  applyLocalWorldHintsFromUserInput(ctx, userInput);

  // 生成前基于当前时间/地点刷新事件状态。即使上一轮 AI 没输出状态增量,
  // 只要时间/地点已经对齐某个未触发事件,这里也能自动标记进行中,
  // 避免出现"日期已到但事件不触发"的问题。
  if (syncMainEvents(state.statusData, state.plotLibrary)) {
    ctx.adapter.save(state.statusData);
    recordGenerationDebug(ctx, 'submit:pre-sync-main-events', {
      currentMainEventId: state.statusData.world.currentMainEventId,
    });
  }

  if (!hasTavernGenerate) {
    await simulateGeneration(ctx, userInput);
    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    state.generating = false;
    if (phoneDirective) {
      await sendPhoneMessageFromDirective(ctx, phoneDirective);
    } else {
      await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration);
    }
    ctx.render();
    return;
  }

  let generationSucceeded = false;
  let deferProgressToMinorSummary = false;
  let summaryAppliedProgress = false;
  try {
    ensureStreamingMessage(ctx);
    ctx.render();

    const promptHistory = state.uiMessages.slice(0, -1);
    const scenePresence = await detectScenePresence(ctx, promptHistory, userInput);
    const requestGenerationId = state.currentGenerationId;
    const generator = win.generate ?? win.generateRaw;
    const baseConfig: Record<string, unknown> = {
      should_stream: true,
      should_silence: true,
      generation_id: requestGenerationId,
    };

    recordGenerationDebug(ctx, 'submit:before-generate', {
      requestGenerationId,
      generator: generator === win.generateRaw ? 'generateRaw' : 'generate',
    });
    const result = await generator?.(
      generator === win.generateRaw
        ? {
            ...baseConfig,
            ordered_prompts: [
              {
                role: 'system',
                content: buildPrompt(state.statusData, promptHistory, userInput, ctx.summaryStore, {
                  playerProfile: state.playerProfile,
                  plotLibrary: state.plotLibrary,
                  skipProgress: !!ctx.summaryApiConfig,
                  suppressPhoneMessageContent: Boolean(phoneDirective),
                  phoneMessageTargetName: phoneDirective?.target.name,
                  suppressUserInputLine: true,
                  scenePresence,
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
              plotLibrary: state.plotLibrary,
              skipProgress: !!ctx.summaryApiConfig,
              suppressPhoneMessageContent: Boolean(phoneDirective),
              phoneMessageTargetName: phoneDirective?.target.name,
              scenePresence,
            }),
          },
    );

    recordGenerationDebug(ctx, 'submit:generate-returned', {
      requestGenerationId,
      resultLength: String(result ?? '').length,
    });
    finalizeStreamingText(ctx, String(result ?? ''), requestGenerationId);

    // 解析并应用变量更新。配置了副 API 时，变量只走后台入口；小摘要触发时由摘要顺手输出 state_delta。
    if (ctx.summaryApiConfig) {
      deferProgressToMinorSummary = shouldRunMinorSummary(
        ctx.summaryStore,
        countCompletedConversationMessages(state.uiMessages),
      );
      if (!deferProgressToMinorSummary) {
        await runSecondaryProgressUpdate(
          ctx,
          `progress-${crypto.randomUUID()}`,
          buildProgressPrompt(state.statusData, getLatestCompletedTurnMessages(state.uiMessages)),
        );
      }
    } else {
      // 主 API 的回复中已经包含 <progress>。
      const mainRaw = String(result ?? '');
      const progressUpdate = parseProgressUpdate(mainRaw);
      if (progressUpdate) {
        applyFullProgressUpdate(ctx, progressUpdate);
      }
    }

    // 在最新助手消息上保存 statusData 快照，供回溯使用。
    const lastMsg = state.uiMessages[state.uiMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.statusSnapshot = createRollbackSnapshot(state);
      ctx.persistConversation();
    }

    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    generationSucceeded = true;
    state.generating = false;
    recordGenerationDebug(ctx, 'submit:main-success-before-phone', { requestGenerationId });
    if (phoneDirective) {
      await sendPhoneMessageFromDirective(ctx, phoneDirective);
    } else {
      await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration);
    }
  } catch (error) {
    recordGenerationDebug(ctx, 'submit:catch', {
      error: error instanceof Error ? error.message : String(error),
    });
    const currentStreamingMessage = state.uiMessages[state.uiMessages.length - 1];
    const hasStreamingText = Boolean(currentStreamingMessage?.streaming && currentStreamingMessage.text.trim());
    const removedStreamingMessage = discardStreamingMessage(ctx);
    state.currentGenerationId = '';
    if (hasStreamingText && !removedStreamingMessage) {
      // 流式正文已经写入时，把它当作成功楼层处理；不要再回填草稿或弹失败。
      const lastMsg = state.uiMessages[state.uiMessages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.statusSnapshot = createRollbackSnapshot(state);
        ctx.persistConversation();
      }
      if (ctx.summaryApiConfig) {
        deferProgressToMinorSummary = shouldRunMinorSummary(
          ctx.summaryStore,
          countCompletedConversationMessages(state.uiMessages),
        );
        if (!deferProgressToMinorSummary) {
          await runSecondaryProgressUpdate(
            ctx,
            `progress-${crypto.randomUUID()}`,
            buildProgressPrompt(state.statusData, getLatestCompletedTurnMessages(state.uiMessages)),
          );
        }
      } else if (lastMsg?.role === 'assistant') {
        const progressUpdate = parseProgressUpdate(lastMsg.text);
        if (progressUpdate) {
          applyFullProgressUpdate(ctx, progressUpdate);
        }
      }
      if (options.clearDraftOnSuccess) {
        state.draft = '';
      }
      generationSucceeded = true;
      state.generating = false;
      recordGenerationDebug(ctx, 'submit:catch-preserved-as-success');
      if (phoneDirective) {
        await sendPhoneMessageFromDirective(ctx, phoneDirective);
      } else {
        await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration);
      }
    } else {
      state.draft = userInput;
      ctx.persistConversation();
      ctx.showNotification({
        kind: 'status',
        title: '生成失败',
        preview: error instanceof Error ? error.message : String(error),
        targetTab: 'summary',
        timestamp: formatTime(state.statusData.world.currentTime),
      });
    }
  } finally {
    state.generating = false;
    recordGenerationDebug(ctx, 'submit:finally-before-render', { generationSucceeded });
    ctx.render();

    // 正文和主动小手机都结束后再顺序执行摘要，避免后台 generateRaw 抢占正文流。
    if (generationSucceeded && (typeof win.generateRaw === 'function' || typeof win.generate === 'function')) {
      recordGenerationDebug(ctx, 'submit:summary-start');
      const summaryCtx: SummaryContext = {
        win,
        state,
        summaryStore: ctx.summaryStore,
        summaryApiConfig: ctx.summaryApiConfig,
        uiMessages: state.uiMessages,
        onTaskUpdated: () => ctx.render(),
        onStoreUpdated: () => {
          ctx.onSummaryStoreUpdated();
          ctx.render();
        },
        getFactAnchor: () => buildFactAnchorFromStatus(ctx.state.statusData),
        onProgressUpdate: update => {
          if (!deferProgressToMinorSummary) return;
          applyFullProgressUpdate(ctx, update);
          summaryAppliedProgress = true;
        },
      };
      await runSummary(summaryCtx).catch(() => {
        /* 摘要错误在内部处理 */
      });
      if (deferProgressToMinorSummary && !summaryAppliedProgress) {
        await runSecondaryProgressUpdate(
          ctx,
          `progress-fallback-${crypto.randomUUID()}`,
          buildProgressPrompt(state.statusData, getLatestCompletedTurnMessages(state.uiMessages)),
        );
      }
      recordGenerationDebug(ctx, 'submit:summary-finished');
    }
  }
}

function getPhoneThreadTarget(ctx: ActionContext, targetId: string): TargetStatus | null {
  return ctx.state.statusData.targets.find(target => target.id === targetId) ?? null;
}

function normalizeForDirectiveMatch(text: string) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[・·.\s　"'“”‘’《》【】「」『』（）()]+/g, '');
}

function hasExplicitPhoneSendIntent(text: string) {
  const normalizedInput = normalizeForDirectiveMatch(text);
  return /(发消息|发送消息|发短信|发送短信|手机联系|短信|私聊|微信|打开手机|用手机)/.test(normalizedInput);
}

function debugPhoneFlow(ctx: ActionContext, event: string, detail: Record<string, unknown> = {}) {
  recordGenerationDebug(ctx, `phone:${event}`, detail);
  console.log(`[islandmilfcode:phone] ${event}`, detail);
}

function stripDirectiveQuotes(text: string) {
  return text
    .trim()
    .replace(/^[「『“"']\s*/, '')
    .replace(/\s*[」』”"']$/, '')
    .trim();
}

function getPhoneTargetSearchTerms(target: TargetStatus) {
  const baseTerms = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  const haystack = baseTerms.join('\n').toLowerCase();
  const builtInTerms: string[] = [];

  if (/英梨梨|泽村|澤村|eriri|sawamura/.test(haystack)) {
    builtInTerms.push('英梨梨', '泽村', '澤村', 'eriri', 'sawamura');
  }
  if (/霞之丘|霞之诗羽|霞ヶ丘|诗羽|詩羽|霞诗子|霞詩子|utaha|kasumigaoka/.test(haystack)) {
    builtInTerms.push(
      '霞之丘',
      '霞之丘诗羽',
      '霞之诗羽',
      '霞ヶ丘',
      '诗羽',
      '詩羽',
      '霞诗子',
      '霞詩子',
      'utaha',
      'kasumigaoka',
    );
  }
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) {
    builtInTerms.push('加藤', '加藤惠', '加藤恵', '惠', '恵', 'megumi', 'katou', 'kato');
  }
  if (/波岛|波島|出海|izumi|hashima/.test(haystack)) {
    builtInTerms.push('波岛', '波岛出海', '波島', '波島出海', '出海', 'izumi', 'hashima');
  }
  if (/冰堂|氷堂|美智留|michiru|hyodo|hyoudou/.test(haystack)) {
    builtInTerms.push('冰堂', '冰堂美智留', '氷堂', '氷堂美智留', '美智留', 'michiru', 'hyodo', 'hyoudou');
  }

  return Array.from(new Set([...baseTerms, ...builtInTerms]));
}

function findPhoneDirectiveTarget(ctx: ActionContext, rawName: string) {
  const needle = normalizeForDirectiveMatch(rawName);
  if (!needle) return null;

  return (
    ctx.state.statusData.targets.find(target =>
      getPhoneTargetSearchTerms(target).some(term => {
        const normalizedTerm = normalizeForDirectiveMatch(term);
        return normalizedTerm && (normalizedTerm.includes(needle) || needle.includes(normalizedTerm));
      }),
    ) ?? null
  );
}

function isMissingPhoneTargetHint(targetHint: string) {
  const normalized = normalizeForDirectiveMatch(targetHint);
  return !normalized || /^(?:none|null|unknown|n\/a|无|未知|不明|不确定|无法确定)$/.test(normalized);
}

function isExplicitPhoneTargetMention(target: TargetStatus, text: string) {
  const normalizedText = normalizeForDirectiveMatch(text);
  if (!normalizedText) return false;

  return getPhoneTargetSearchTerms(target)
    .map(term => normalizeForDirectiveMatch(term))
    .filter(term => term.length >= 2)
    .some(term => normalizedText.includes(term));
}

function sceneExplicitlyReceivedPhoneMessage(target: TargetStatus, text: string) {
  const normalizedText = normalizeForDirectiveMatch(text);
  if (!normalizedText) return false;

  const receiveWords =
    '(?:接到|收到|看见|看到|弹到|弹出|跳出|推送|手机(?:上)?(?:收到|弹出|传来)|屏幕(?:上)?(?:亮起|弹出))';
  const phoneWords = '(?:line消息|LINE消息|手机消息|消息|短信|通知|未读消息)';
  const fromWords = '(?:来自|发自)';
  const pronounMessagePattern = new RegExp(
    `${receiveWords}.{0,24}(?:她|他|对方)(?:发来|传来|发来的|发了).{0,12}${phoneWords}`,
  );
  if (textMentionsTarget(text, target) && pronounMessagePattern.test(normalizedText)) return true;

  return getPhoneTargetSearchTerms(target)
    .map(term => normalizeForDirectiveMatch(term))
    .filter(term => term.length >= 2)
    .some(term => {
      const escaped = escapeRegExp(term);
      return (
        new RegExp(`${receiveWords}.{0,24}${escaped}.{0,12}${phoneWords}`).test(normalizedText) ||
        new RegExp(`${receiveWords}.{0,24}${phoneWords}.{0,24}${escaped}`).test(normalizedText) ||
        new RegExp(`${escaped}.{0,24}(?:发来|传来|发来的|发了).{0,12}${phoneWords}`).test(normalizedText) ||
        new RegExp(`${phoneWords}.{0,12}${fromWords}.{0,12}${escaped}`).test(normalizedText) ||
        new RegExp(`${fromWords}.{0,12}${escaped}.{0,12}(?:的)?${phoneWords}`).test(normalizedText) ||
        new RegExp(`${fromWords}.{0,12}${escaped}.{0,30}${receiveWords}`).test(normalizedText)
      );
    });
}

function extractScenePhoneMessageText(sceneText: string) {
  const bracketMatches = Array.from(sceneText.matchAll(/【([^】]{1,1000})】/g))
    .map(match => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (bracketMatches.length) return bracketMatches[bracketMatches.length - 1];

  const lineMatch = sceneText.match(/(?:消息|短信|通知|Line|LINE)[^：:]{0,20}[：:]\s*([^\n<]{1,1000})/i);
  return lineMatch?.[1]?.trim() || null;
}

function sceneTextMentionsIncomingPhoneFromTarget(target: TargetStatus, sceneText: string) {
  const normalizedText = normalizeForDirectiveMatch(sceneText);
  if (!normalizedText) return false;
  const hasPhoneSignal = /line消息|手机消息|短信|通知|未读消息|消息/.test(normalizedText);
  const hasIncomingSignal = /来自|发自|发来|传来|收到|接到|弹到|弹出|跳出|推送/.test(normalizedText);
  return hasPhoneSignal && hasIncomingSignal && isExplicitPhoneTargetMention(target, sceneText);
}

function sceneTextMentionsOutgoingPhoneToTarget(target: TargetStatus, sceneText: string) {
  const normalizedText = normalizeForDirectiveMatch(sceneText);
  if (!normalizedText) return false;

  const phoneWords = '(?:line|手机|短信|私聊|微信|消息)';
  const sendWords = '(?:发|发送|传|回复|回覆|回信|告诉|联系)';
  return getPhoneTargetSearchTerms(target)
    .map(term => normalizeForDirectiveMatch(term))
    .filter(term => term.length >= 2)
    .some(term => {
      const escaped = escapeRegExp(term);
      return (
        new RegExp(`(?:给|向|对|发给|发送给|传给).{0,12}${escaped}.{0,16}${sendWords}.{0,12}${phoneWords}`).test(
          normalizedText,
        ) ||
        new RegExp(`${sendWords}.{0,12}${phoneWords}.{0,16}(?:给|向|对|发给|发送给|传给).{0,12}${escaped}`).test(
          normalizedText,
        ) ||
        new RegExp(`(?:回复|回覆|回信).{0,12}${escaped}.{0,12}(?:的)?${phoneWords}`).test(normalizedText)
      );
    });
}

function scenePhoneMessageIsExplicitlyBoundToTarget(
  target: TargetStatus,
  sceneText: string,
  role: ScenePhoneMessage['role'],
) {
  if (role === 'assistant') {
    return (
      sceneExplicitlyReceivedPhoneMessage(target, sceneText) ||
      sceneTextMentionsIncomingPhoneFromTarget(target, sceneText)
    );
  }
  return sceneTextMentionsOutgoingPhoneToTarget(target, sceneText);
}

function hasScenePhoneMessageHint(sceneText: string) {
  const normalizedText = normalizeForDirectiveMatch(sceneText);
  if (!normalizedText) return false;
  return /(手机|line|短信|私聊|消息|通知|未读|发来|发给|回复|屏幕亮起|弹出)/i.test(normalizedText);
}

function findScenePhoneMessage(ctx: ActionContext, text: string): ScenePhoneMessage | null {
  const target =
    ctx.state.statusData.targets.find(item => sceneExplicitlyReceivedPhoneMessage(item, text)) ??
    ctx.state.statusData.targets.find(item => sceneTextMentionsIncomingPhoneFromTarget(item, text)) ??
    null;
  const messageText = extractScenePhoneMessageText(text);
  return target && messageText ? { target, role: 'assistant', text: messageText } : null;
}

function buildPhoneActionDetectorPrompts(ctx: ActionContext, userInput: string): RawPrompt[] {
  const contacts = ctx.state.statusData.targets
    .map(target => {
      const aliases = getPhoneTargetSearchTerms(target)
        .filter(term => term !== target.id && term !== target.name)
        .join('、');
      return `- id=${target.id}；姓名=${target.name}${target.alias ? `；别名=${target.alias}` : ''}${
        aliases ? `；可匹配线索=${aliases}` : ''
      }`;
    })
    .join('\n');

  const systemPrompt = [
    '你是一个手机动作意图识别器，只判断玩家这句话是否要求“用手机给某个联系人发送一条消息”。',
    '不要续写剧情，不要扮演角色，不要解释。',
    '',
    '可聊天联系人：',
    contacts || '无',
    '',
    '判定规则：',
    '1. 只有玩家明确想用手机、短信、私聊、微信、聊天软件联系某人时，才输出 send。',
    '2. “打开手机发送消息询问英梨梨今天吃什么”“给诗羽学姐发个短信说我晚点到”属于 send。',
    '3. “怎么和英梨梨对话”“问英梨梨这件事该怎么办”这类没有明确手机/短信/私聊动作的输入，不属于 send。',
    '4. target_id 必须从联系人列表选择，不能编造。无法确定联系人时输出 none。',
    '5. message 要改写成真正发给对方的手机文本，不要包含“打开手机/发消息/询问某某”等动作描述。',
    '6. 如果只是正文里提到手机、提到某人，或角色主动发消息，不算玩家发送。',
    '7. 括号内旁白、系统说明、意图说明、元评论，尤其是“这不是手机消息”“原来如此”等解释，绝对不能放进 message。',
    '8. 如果玩家输入同时包含剧情行动和手机消息，只提取玩家明确想发送给联系人的那一句；没有明确短信正文时，把询问/告知意图改写成一句自然短消息。',
    '',
    '只输出以下 XML 之一：',
    '<phone_action>',
    'action: send',
    'target_id: 联系人id',
    'message: 要发送的手机消息',
    'confidence: high|medium|low',
    '</phone_action>',
    '',
    '<phone_action>',
    'action: none',
    '</phone_action>',
  ].join('\n');

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: `玩家输入：${userInput}`,
    },
  ];
}

function parsePhoneActionDetectorResult(
  ctx: ActionContext,
  rawResult: string,
  userInput: string,
): PhoneDirective | null {
  const tagged = extractTaggedReply(rawResult, 'phone_action', false);
  if (!tagged) return null;

  const action =
    tagged
      .match(/^action[:：]\s*(.+)$/im)?.[1]
      ?.trim()
      .toLowerCase() ?? '';
  if (action !== 'send') return null;

  const targetId = tagged.match(/^target_id[:：]\s*(.+)$/im)?.[1]?.trim() ?? '';
  const message = stripDirectiveQuotes(
    tagged.match(/^message[:：]\s*([\s\S]*?)(?:\nconfidence[:：]|\n?$)/im)?.[1] ?? '',
  );
  const confidence =
    tagged
      .match(/^confidence[:：]\s*(.+)$/im)?.[1]
      ?.trim()
      .toLowerCase() ?? '';
  if (!targetId || !message || !PHONE_ACTION_DETECTOR_CONFIDENCE.has(confidence)) return null;

  const target = getPhoneThreadTarget(ctx, targetId) ?? findPhoneDirectiveTarget(ctx, targetId);
  // 中文注释：LLM 检测器只能确认明确点名的联系人，不能凭默认变量目标或剧情联想代替玩家选择。
  if (target && !isExplicitPhoneTargetMention(target, userInput)) return null;
  return target ? { target, text: message } : null;
}

async function generateSilentAnalysis(ctx: ActionContext, generationId: string, prompts: RawPrompt[]): Promise<string> {
  return generateSecondaryRaw({
    win: ctx.win,
    generationId,
    prompts,
    apiConfig: ctx.summaryApiConfig,
  }).catch(() => '');
}

function countCompletedConversationMessages(messages: UiMessage[]): number {
  return messages.filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .length;
}

function normalizeScenePresenceIds(ids: unknown, allowedIds: Set<string>) {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids
        .map(id => String(id ?? '').trim())
        .filter(id => allowedIds.has(id)),
    ),
  );
}

function buildScenePresencePrompts(ctx: ActionContext, promptHistory: UiMessage[], userInput: string): RawPrompt[] {
  const recentVisible = promptHistory
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .slice(-4)
    .map(message => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const text = message.role === 'assistant' ? getVisibleMessageText(message) || message.text : message.text;
      return `[${role}] ${text}`;
    })
    .join('\n\n');

  const targets = ctx.state.statusData.targets
    .map(target => {
      const aliases = getPhoneTargetSearchTerms(target)
        .filter(term => term !== target.id && term !== target.name)
        .join('、');
      return `- id=${target.id}；姓名=${target.name}${target.alias ? `；别名=${target.alias}` : ''}${
        aliases ? `；可匹配线索=${aliases}` : ''
      }`;
    })
    .join('\n');

  const systemPrompt = [
    '现在需要对目前的场景进行判断,在正文开始生成时”哪些角色处于当前镜头内',
    '只做判定，不续写剧情，不扮演角色，不输出思考过程。',
    '',
    '角色名单：',
    targets || '无',
    '',
    '判定定义：',
    '- present：角色明确处于当前镜头内，能立刻说话、行动、沉默、吃醋或产生即时反应。',
    '- focus：玩家当前输入正在追上、寻找、靠近、转向或当面处理该角色；下一轮正文允许转场到她。',
    '- absent：角色已明确离开、不在场、没来、无法即时反应。',
    '- uncertain：只是被提到、回忆、议论或出现在旧信息里，不能证明当前在镜头内。',
    '',
    '硬规则：',
    '1. 只能使用角色名单里的 id。',
    '2. 第一次输入若没有最近正文，只看玩家当前输入；没有明确点名/寻找/靠近任何角色时，present 和 focus 都为空。',
    '3. 不要因为角色好感度、剧情常识、世界书设定或你觉得她应该在场而加入 present。',
    '4. 玩家当前输入若明确“追上去安慰她/去找某人/转向某人/和某人说话”，该角色进入 focus。',
    '5. 输出必须是一个 JSON 对象，不要使用 Markdown 代码块。',
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        '最近4条可见正文：',
        recentVisible || '（无）',
        '',
        `玩家当前输入：${userInput || '（无）'}`,
        '',
        '请输出 JSON，格式如下：',
        '{"present":["角色id"],"focus":["角色id"],"absent":["角色id"],"uncertain":["角色id"],"evidence":{"角色id":"一句话依据"}}',
      ].join('\n'),
    },
  ];
}

function parseScenePresenceResult(ctx: ActionContext, rawResult: string): ScenePresence {
  const allowedIds = new Set(ctx.state.statusData.targets.map(target => target.id));
  const fallback: ScenePresence = { presentIds: [], focusIds: [], absentIds: [], uncertainIds: [], evidence: {} };
  const text = String(rawResult ?? '').trim();
  if (!text) return fallback;

  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? '';
  if (!jsonText) return fallback;

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const evidenceRaw = parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : {};
    const evidence: Record<string, string> = {};
    for (const [id, reason] of Object.entries(evidenceRaw as Record<string, unknown>)) {
      if (allowedIds.has(id)) evidence[id] = String(reason ?? '').trim();
    }
    return {
      presentIds: normalizeScenePresenceIds(parsed.present, allowedIds),
      focusIds: normalizeScenePresenceIds(parsed.focus, allowedIds),
      absentIds: normalizeScenePresenceIds(parsed.absent, allowedIds),
      uncertainIds: normalizeScenePresenceIds(parsed.uncertain, allowedIds),
      evidence,
    };
  } catch (error) {
    console.warn('[scene-presence] parse failed:', error);
    return fallback;
  }
}

async function detectScenePresence(
  ctx: ActionContext,
  promptHistory: UiMessage[],
  userInput: string,
): Promise<ScenePresence> {
  // 中文注释：镜头判定只服务本轮 prompt 注入，不写入存档；失败时保守地不注入任何角色强规则。
  if (!ctx.state.statusData.targets.length) {
    return { presentIds: [], focusIds: [], absentIds: [], uncertainIds: [], evidence: {} };
  }
  const generationId = `scene-presence-${crypto.randomUUID()}`;
  const rawResult = await generateSilentAnalysis(ctx, generationId, buildScenePresencePrompts(ctx, promptHistory, userInput));
  const parsed = parseScenePresenceResult(ctx, rawResult);
  recordGenerationDebug(ctx, 'scene-presence:detected', {
    generationId,
    rawLength: String(rawResult ?? '').length,
    presentIds: parsed.presentIds,
    focusIds: parsed.focusIds,
    absentIds: parsed.absentIds,
    uncertainIds: parsed.uncertainIds,
  });
  return parsed;
}

async function runSecondaryProgressUpdate(
  ctx: ActionContext,
  generationId: string,
  prompts: RawPrompt[],
  targetId?: string | null,
  options: { showTask?: boolean } = {},
): Promise<boolean> {
  const showTask = options.showTask ?? true;
  if (showTask) {
    setBackgroundTaskRunning(ctx.state, 'progress');
    ctx.render();
  }
  try {
    const raw = await generateSecondaryRaw({
      win: ctx.win,
      generationId,
      prompts,
      apiConfig: ctx.summaryApiConfig,
    });
    const update = parseProgressUpdate(raw);
    if (update) {
      applyFullProgressUpdate(ctx, update, targetId);
      if (showTask) clearBackgroundTask(ctx.state, 'progress');
      return true;
    }
    if (showTask) clearBackgroundTask(ctx.state, 'progress');
  } catch (error) {
    console.warn('[progress] secondary analysis failed:', error);
    if (showTask) setBackgroundTaskFailed(ctx.state, 'progress', error);
  }
  if (showTask) ctx.render();
  return false;
}

export async function retryBackgroundProgressUpdate(ctx: ActionContext) {
  if (ctx.state.generating || ctx.state.phoneMessages.generating) return;
  await runSecondaryProgressUpdate(
    ctx,
    `progress-retry-${crypto.randomUUID()}`,
    buildProgressPrompt(ctx.state.statusData, getLatestCompletedTurnMessages(ctx.state.uiMessages)),
  );
}

async function detectPhoneDirectiveWithLlm(ctx: ActionContext, userInput: string): Promise<PhoneDirective | null> {
  if (!ctx.state.statusData.targets.length) {
    debugPhoneFlow(ctx, 'directive-llm:skip-no-targets');
    return null;
  }

  const prompts = buildPhoneActionDetectorPrompts(ctx, userInput);
  const generationId = `phone-directive-detect-${crypto.randomUUID()}`;
  debugPhoneFlow(ctx, 'directive-llm:start', { generationId, inputLength: userInput.length });
  const rawResult = await generateSilentAnalysis(ctx, generationId, prompts);

  const parsed = parsePhoneActionDetectorResult(ctx, String(rawResult ?? ''), userInput);
  debugPhoneFlow(ctx, parsed ? 'directive-llm:matched' : 'directive-llm:no-match', {
    generationId,
    rawLength: String(rawResult ?? '').length,
    targetId: parsed?.target.id ?? null,
    textLength: parsed?.text.length ?? 0,
  });
  return parsed;
}

function buildScenePhoneMessageExtractorPrompts(ctx: ActionContext, sceneText: string): RawPrompt[] {
  const contacts = ctx.state.statusData.targets
    .map(target => {
      const aliases = getPhoneTargetSearchTerms(target)
        .filter(term => term !== target.id && term !== target.name)
        .join('、');
      return `- id=${target.id}；姓名=${target.name}${target.alias ? `；别名=${target.alias}` : ''}${
        aliases ? `；可匹配线索=${aliases}` : ''
      }`;
    })
    .join('\n');

  const systemPrompt = [
    '你是一个正文手机消息提取器。只判断“最新正文”里是否已经出现手机/LINE/短信/私聊消息，并把已出现的消息结构化输出。',
    '不要续写剧情，不要扮演角色，不要解释，不要自行创造正文没有出现或没有明确描述的消息。',
    '',
    '可聊天联系人：',
    contacts || '无',
    '',
    '提取规则：',
    '1. incoming 表示联系人发给玩家的消息，例如“英梨梨发来 LINE 消息：【...】”“收到来自诗羽的短信：...”。',
    '2. outgoing 表示玩家在正文中发给联系人的消息，例如“我给加藤发消息：【...】”“玩家用手机告诉英梨梨...”。',
    '3. target_id 必须是正文明确关联这条手机消息的联系人 id；不能因为联系人列表存在某人就猜测归属。',
    '4. 如果正文只写“她/对方/有人/手机弹出消息”等，无法确定联系人时就不要输出该条；不要硬选一个 target_id。',
    '5. message 优先使用正文里明确写出的消息正文（引号、【】、冒号后的内容）。如果正文只明确概括了消息内容，可以用一句自然手机文本重构；如果连内容也不明确，就不要输出。',
    '6. 只提取手机/LINE/短信/私聊等远程消息；面对面对话、旁白、心理活动、系统通知、普通叙述都不要输出。',
    '7. 可以输出多条，按正文发生顺序排列。没有可提取消息时输出空的 <phone_messages></phone_messages>。',
    '',
    '输出格式：',
    '<phone_messages>',
    'direction: incoming|outgoing',
    'target_id: 联系人id',
    'message: 消息正文',
    '---',
    'direction: incoming|outgoing',
    'target_id: 联系人id',
    'message: 消息正文',
    '</phone_messages>',
  ].join('\n');

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: `最新正文：\n${sceneText}`,
    },
  ];
}

function parseScenePhoneMessageExtractorResult(
  ctx: ActionContext,
  rawResult: string,
  sceneText: string,
): ScenePhoneMessage[] {
  const tagged = extractTaggedReply(rawResult, 'phone_messages', false);
  if (!tagged) return [];

  return tagged
    .split(/\n\s*---\s*\n/g)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const direction =
        block
          .match(/^direction[:：]\s*(.+)$/im)?.[1]
          ?.trim()
          .toLowerCase() ?? '';
      const targetHint = block.match(/^target_id[:：]\s*(.+)$/im)?.[1]?.trim() ?? '';
      const message = stripDirectiveQuotes(block.match(/^message[:：]\s*([\s\S]*)$/im)?.[1] ?? '');
      const role = direction === 'outgoing' ? 'user' : direction === 'incoming' ? 'assistant' : null;
      if (isMissingPhoneTargetHint(targetHint) || !role || !message) return null;

      const target = getPhoneThreadTarget(ctx, targetHint);
      if (!target) {
        debugPhoneFlow(ctx, 'scene-extract:drop-non-id-target', { targetHint, direction });
        return null;
      }
      if (!scenePhoneMessageIsExplicitlyBoundToTarget(target, sceneText, role)) {
        debugPhoneFlow(ctx, 'scene-extract:drop-unbound-target', {
          targetId: target.id,
          direction,
          messagePreview: message.slice(0, 80),
        });
        return null;
      }

      return { target, role, text: message } satisfies ScenePhoneMessage;
    })
    .filter((item): item is ScenePhoneMessage => Boolean(item));
}

async function extractScenePhoneMessagesWithLlm(ctx: ActionContext, sceneText: string): Promise<ScenePhoneMessage[]> {
  if (!sceneText.trim()) {
    debugPhoneFlow(ctx, 'scene-extract-llm:skip-empty-scene');
    return [];
  }
  if (!ctx.state.statusData.targets.length) {
    debugPhoneFlow(ctx, 'scene-extract-llm:skip-no-targets');
    return [];
  }

  const prompts = buildScenePhoneMessageExtractorPrompts(ctx, sceneText);
  const generationId = `phone-scene-extract-${crypto.randomUUID()}`;
  debugPhoneFlow(ctx, 'scene-extract-llm:start', { generationId, sceneLength: sceneText.length });
  const rawResult = await generateSilentAnalysis(ctx, generationId, prompts);

  const parsed = parseScenePhoneMessageExtractorResult(ctx, String(rawResult ?? ''), sceneText);
  debugPhoneFlow(ctx, parsed.length ? 'scene-extract-llm:matched' : 'scene-extract-llm:no-match', {
    generationId,
    rawLength: String(rawResult ?? '').length,
    count: parsed.length,
  });
  return parsed;
}

function extractPhoneMessageDirective(ctx: ActionContext, userInput: string): PhoneDirective | null {
  if (!hasExplicitPhoneSendIntent(userInput)) {
    debugPhoneFlow(ctx, 'directive-regex:skip-no-intent', { inputLength: userInput.length });
    return null;
  }

  const patterns = [
    /(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*(?:发消息|发送消息|发短信|发送短信|发个消息|发条消息|手机联系|私聊|微信)\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:发消息|发送消息|发短信|发送短信|发个消息|发条消息|短信|私聊|微信)\s*(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:用手机|打开手机)\s*(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*(?:说|发送|发)\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:用手机|打开手机)\s*(?:发送消息|发消息|发短信|发送短信|私聊|微信)?\s*(?:问|询问|告诉)\s*([^，。！？\n,!?]{1,32})\s*([\s\S]*)/i,
  ];

  for (const [index, pattern] of patterns.entries()) {
    const match = userInput.match(pattern);
    if (!match) continue;

    const target = findPhoneDirectiveTarget(ctx, match[1] ?? '');
    if (!target) {
      debugPhoneFlow(ctx, 'directive-regex:target-not-found', {
        patternIndex: index,
        rawTarget: match[1] ?? '',
      });
      continue;
    }

    const explicitText = stripDirectiveQuotes(match[2] ?? '');
    const fallbackText = stripDirectiveQuotes(userInput);
    debugPhoneFlow(ctx, 'directive-regex:matched', {
      patternIndex: index,
      targetId: target.id,
      targetName: target.name,
      explicitTextLength: explicitText.length,
      fallbackUsed: !explicitText,
    });
    return {
      target,
      text: explicitText || fallbackText,
    };
  }

  debugPhoneFlow(ctx, 'directive-regex:no-pattern-match', { inputLength: userInput.length });
  return null;
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

function appendAssistantPhoneMessage(
  ctx: ActionContext,
  target: TargetStatus,
  thread: ReturnType<typeof ensurePhoneThread>,
  text: string,
) {
  const { state } = ctx;
  const assistantMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    speaker: target.alias ?? target.name,
    text,
    timestamp: formatTime(state.statusData.world.currentTime),
    statusSnapshot: createRollbackSnapshot(state),
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
    preview: text,
    targetTab: 'summary',
    phoneRoute: 'app:chat',
    targetId: target.id,
    timestamp: formatTime(state.statusData.world.currentTime),
  });
}

function appendUserPhoneMessage(
  ctx: ActionContext,
  target: TargetStatus,
  thread: ReturnType<typeof ensurePhoneThread>,
  text: string,
) {
  const { state } = ctx;
  const userMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: state.playerProfile.name.trim() || '我',
    text,
    timestamp: formatTime(state.statusData.world.currentTime),
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  ctx.persistConversation();
}

function appendExtractedScenePhoneMessage(ctx: ActionContext, item: ScenePhoneMessage) {
  const thread = ensurePhoneThread(ctx, item.target);
  const lastMessage = thread.messages[thread.messages.length - 1];
  if (lastMessage?.role === item.role && lastMessage.text.trim() === item.text.trim()) return false;

  if (item.role === 'user') {
    appendUserPhoneMessage(ctx, item.target, thread, item.text.trim());
  } else {
    appendAssistantPhoneMessage(ctx, item.target, thread, item.text.trim());
  }
  return true;
}

function shouldQueueProactivePhoneMessage(
  ctx: ActionContext,
  target: TargetStatus,
  eventKey: string,
  previousEventKey?: string | null,
  forceMessage = false,
) {
  if (previousEventKey === eventKey) return false;
  if (ctx.state.phoneMessages.generating || ctx.state.generating) return false;
  const proactiveState = getPhoneProactiveState(ctx);
  if (proactiveState.lastEventKey === eventKey) return false;
  const lastQueuedAt = Number(proactiveState.lastQueuedAt ?? 0) || 0;
  if (!forceMessage && Date.now() - lastQueuedAt < PHONE_PROACTIVE_COOLDOWN_MS) return false;
  const thread = ctx.state.phoneMessages.threads[target.id];
  const lastMessage = thread?.messages[thread.messages.length - 1];
  if (
    !forceMessage &&
    lastMessage?.role === 'assistant' &&
    Date.now() - thread.updatedAt < PHONE_PROACTIVE_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}

async function maybeQueueProactivePhoneMessage(ctx: ActionContext, previousEventKey?: string | null) {
  const { state, win } = ctx;
  const latestEvent = getLatestRecentEvent(ctx);
  const latestSceneText = getLatestAssistantSceneText(ctx);
  const hasTavernGenerate = typeof win.generateRaw === 'function' || typeof win.generate === 'function';
  const shouldRunPhoneExtractor = hasTavernGenerate && hasScenePhoneMessageHint(latestSceneText);
  debugPhoneFlow(ctx, 'scene-extract:gate', {
    hasTavernGenerate,
    hasPhoneHint: hasScenePhoneMessageHint(latestSceneText),
    willRun: shouldRunPhoneExtractor,
    sceneLength: latestSceneText.length,
  });
  const extractedMessages = shouldRunPhoneExtractor
    ? await extractScenePhoneMessagesWithLlm(ctx, latestSceneText).catch(error => {
        console.warn('[phone-scene-extract] detector failed:', error);
        return [] as ScenePhoneMessage[];
      })
    : [];
  let appendedFromScene = false;

  for (const item of extractedMessages) {
    appendedFromScene = appendExtractedScenePhoneMessage(ctx, item) || appendedFromScene;
  }
  if (extractedMessages.length) return;

  const scenePhoneMessage = extractedMessages.length ? null : findScenePhoneMessage(ctx, latestSceneText);

  if (scenePhoneMessage) {
    const eventKey = `scene-phone:${scenePhoneMessage.target.id}:${latestSceneText.slice(-180)}`;
    const proactiveState = getPhoneProactiveState(ctx);
    if (proactiveState.lastEventKey === eventKey) return;
    proactiveState.lastEventKey = eventKey;
    proactiveState.lastQueuedAt = Date.now();
    appendExtractedScenePhoneMessage(ctx, scenePhoneMessage);
    return;
  }

  if (!hasTavernGenerate) {
    debugPhoneFlow(ctx, 'proactive:skip-no-generate');
    return;
  }

  if (!latestEvent) {
    debugPhoneFlow(ctx, 'proactive:skip-no-latest-event');
    return;
  }

  const target =
    state.statusData.targets.find(candidate => isExplicitPhoneTargetMention(candidate, latestEvent.text)) ?? null;
  if (!target) {
    debugPhoneFlow(ctx, 'proactive:skip-no-target-in-event', {
      eventKey: latestEvent.key,
      eventText: latestEvent.text.slice(0, 160),
    });
    return;
  }

  const triggerText = latestEvent.text;
  const eventKey = latestEvent.key;
  if (!shouldQueueProactivePhoneMessage(ctx, target, eventKey, previousEventKey, false)) {
    debugPhoneFlow(ctx, 'proactive:skip-queue-guard', {
      targetId: target.id,
      eventKey,
      previousEventKey: previousEventKey ?? null,
    });
    return;
  }

  const proactiveState = getPhoneProactiveState(ctx);
  proactiveState.lastEventKey = eventKey;
  proactiveState.lastQueuedAt = Date.now();

  const thread = ensurePhoneThread(ctx, target);
  const prompt = buildPhoneChatPrompt({
    statusData: state.statusData,
    target,
    history: thread.messages,
    userInput:
      '根据刚刚正文发生的事件，判断你是否会主动发一条手机消息。如果事件与你有关、你有话想说、或者你有理由关心，就生成这条消息；如果事件和你无关、你没有理由主动联系、或者当前情境不适合发消息，就只输出 <message></message> 表示不发送。不要为了发消息而发消息。',
    summaryStore: ctx.summaryStore,
    playerProfile: state.playerProfile,
    plotLibrary: state.plotLibrary,
    skipProgress: true,
    triggerEvent: triggerText,
    forceMessage: false,
  });

  try {
    const generationId = `phone-proactive-${crypto.randomUUID()}`;
    debugPhoneFlow(ctx, 'proactive:start', { generationId, targetId: target.id, eventKey });
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
    debugPhoneFlow(ctx, replyText ? 'proactive:message' : 'proactive:empty', {
      generationId,
      targetId: target.id,
      rawLength: String(rawResult ?? '').length,
      replyLength: replyText.length,
    });
    if (!replyText) return;

    appendAssistantPhoneMessage(ctx, target, thread, replyText);
  } catch (e) {
    console.warn('[phone-proactive] generation failed:', e);
  }
}

async function sendPhoneMessageFromDirective(ctx: ActionContext, directive: PhoneDirective) {
  const { state, win } = ctx;
  const target = directive.target;
  const userInput = directive.text.trim();
  if (!userInput || state.phoneMessages.generating) return;

  const thread = ensurePhoneThread(ctx, target);
  const now = formatTime(state.statusData.world.currentTime);
  const userMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: state.playerProfile.name.trim() || '我',
    text: userInput,
    timestamp: now,
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  state.phoneMessages.activeThreadId = target.id;
  state.phoneMessages.generating = true;
  ctx.persistConversation();
  ctx.render();

  const hasTavernGenerate = typeof win.generateRaw === 'function' || typeof win.generate === 'function';
  let rawResult = '';

  try {
    if (hasTavernGenerate) {
      const prompt = buildPhoneChatPrompt({
        statusData: state.statusData,
        target,
        history: thread.messages,
        userInput,
        summaryStore: ctx.summaryStore,
        playerProfile: state.playerProfile,
        plotLibrary: state.plotLibrary,
        skipProgress: true,
      });
      const generationId = `phone-directive-${crypto.randomUUID()}`;

      rawResult =
        typeof win.generateRaw === 'function'
          ? String(
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
            )
          : String(
              (await win.generate?.({
                should_silence: true,
                should_stream: false,
                generation_id: generationId,
                user_input: prompt,
              })) ?? '',
            );
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

    await runSecondaryProgressUpdate(
      ctx,
      `phone-progress-${crypto.randomUUID()}`,
      buildPhoneProgressPrompt({
        statusData: state.statusData,
        target,
        messages: thread.messages,
      }),
      target.id,
    );

    assistantMessage.statusSnapshot = createRollbackSnapshot(state);
    if (!(state.phoneOpen && state.phoneRoute === 'app:chat' && state.phoneMessages.activeThreadId === target.id)) {
      thread.unread += 1;
    }
    ctx.persistConversation();
    ctx.showNotification({
      kind: 'message',
      title: `${target.alias ?? target.name} 回复了手机消息`,
      preview: replyText,
      targetTab: 'summary',
      phoneRoute: 'app:chat',
      targetId: target.id,
      timestamp: formatTime(state.statusData.world.currentTime),
    });
  } catch (error) {
    // 正文指令失败时回滚这条手机用户消息，避免界面显示已发但实际未生成回复。
    thread.messages = thread.messages.filter(message => message.id !== userMessage.id);
    thread.updatedAt = Date.now();
    ctx.showNotification({
      kind: 'status',
      title: '正文手机指令失败',
      preview: error instanceof Error ? error.message : String(error),
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
  } finally {
    state.phoneMessages.generating = false;
    ctx.render();
  }
}

export async function submitPhoneMessage(ctx: ActionContext, targetId: string) {
  const { state, win } = ctx;
  const target = getPhoneThreadTarget(ctx, targetId);
  const userInput = state.phoneMessages.draft.trim();
  // 正文生成时不并发发手机消息，避免两个 generateRaw 的流式事件在酒馆侧串到同一个正文楼层。
  if (!target || !userInput || state.phoneMessages.generating || state.generating) return;

  const thread = ensurePhoneThread(ctx, target);
  const now = formatTime(state.statusData.world.currentTime);
  const userMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: state.playerProfile.name.trim() || '我',
    text: userInput,
    timestamp: now,
    statusSnapshot: createRollbackSnapshot(state),
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
        summaryStore: ctx.summaryStore,
        playerProfile: state.playerProfile,
        plotLibrary: state.plotLibrary,
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

    await runSecondaryProgressUpdate(
      ctx,
      `phone-progress-${crypto.randomUUID()}`,
      buildPhoneProgressPrompt({
        statusData: state.statusData,
        target,
        messages: thread.messages,
      }),
      target.id,
    );

    assistantMessage.statusSnapshot = createRollbackSnapshot(state);
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
  // 中文注释：调试加减好感只允许明确激活对象，不能从目标数组首项兜底。
  const target = state.statusData.activeTargetId
    ? (state.statusData.targets.find(item => item.id === state.statusData.activeTargetId) ?? null)
    : null;
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
