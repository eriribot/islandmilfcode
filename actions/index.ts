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
import { createRollbackSnapshot, pushMessage } from '../state/store';
import { buildFactAnchorFromStatus, runSummary, type SummaryContext } from '../summary';
import type { SummaryApiConfig, SummaryStore } from '../summary/types';
import { getActiveTarget } from '../types';
import type { PhoneChatMessage, PhoneProactiveState, PlayerProfile, PlayerStats, PlotLibrary, TargetStatus } from '../types';
import type { VariableAdapter } from '../variables/adapter';
import { affinityStage, applyProgressUpdate, clamp, formatTime } from '../variables/normalize';
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

function mergeMissingAffinity(
  primary: ProgressUpdate | null,
  fallback: ProgressUpdate | null,
  ctx?: ActionContext,
) {
  if (!primary) return fallback;
  const primaryHasAffinity = primary.affinityDelta !== undefined || primary.affinityDeltas.length > 0;
  const fallbackHasAffinity = fallback?.affinityDelta !== undefined || Boolean(fallback?.affinityDeltas.length);
  if (!fallbackHasAffinity) return primary;
  if (!primaryHasAffinity) {
    return {
      ...primary,
      affinityDelta: fallback!.affinityDelta,
      affinityDeltas: fallback!.affinityDeltas,
    };
  }

  // 预检：如果 primary 的好感度变化在当前正文语境中全部会被判为 'absent'，允许 fallback 接管。
  if (ctx) {
    const allPrimaryAbsent =
      primary.affinityDeltas.length > 0 &&
      primary.affinityDeltas.every(item => {
        const target = findProgressTarget(ctx, item.target);
        return target ? classifyAffinityVerdict(ctx, target) === 'absent' : true;
      });
    const legacyAbsent =
      primary.affinityDelta !== undefined && primary.affinityDelta !== 0
        ? (() => {
            const active = getActiveTarget(ctx.state.statusData);
            return active ? classifyAffinityVerdict(ctx, active) === 'absent' : true;
          })()
        : true;
    if (allPrimaryAbsent && legacyAbsent) {
      console.warn('[progress] primary affinity fully absent — fallback to secondary affinity');
      return {
        ...primary,
        affinityDelta: fallback!.affinityDelta,
        affinityDeltas: fallback!.affinityDeltas,
      };
    }
  }

  return primary;
}

const DEFAULT_PLAYER_STATS: PlayerStats = {
  knowledge: 0,
  charm: 0,
  proficiency: 0,
  kindness: 0,
  courage: 0,
};

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

function clampLegacyAffinityDelta(ctx: ActionContext, update: ProgressUpdate, targetId?: string | null): number | undefined {
  if (update.affinityDelta === undefined || update.affinityDelta === 0) return update.affinityDelta;
  if (targetId) return update.affinityDelta;

  const target = getActiveTarget(ctx.state.statusData);
  if (!target) return undefined;

  const verdict = classifyAffinityVerdict(ctx, target);
  const clamped = clampAffinityByVerdict(update.affinityDelta, verdict);
  if (verdict === 'unmentioned' && clamped !== update.affinityDelta) {
    console.warn('[progress] clamp legacy affinity for unmentioned target:', target.name, update.affinityDelta, '→', clamped);
  }
  if (verdict === 'absent') {
    console.warn('[progress] drop legacy affinity for absent target:', target.name);
    return undefined;
  }
  return clamped || undefined;
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
    if (verdict === 'unmentioned' && effectiveDelta !== item.delta) {
      console.warn('[progress] clamp affinity for unmentioned target:', item.target, item.delta, '→', effectiveDelta);
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
  const contextualized: ProgressUpdate = { ...sanitized, affinityDelta: legacyDelta };
  applyProgressUpdate(
    ctx.state.statusData,
    contextualized,
    targetId ?? ctx.state.statusData.activeTargetId,
    ctx.state.plotLibrary,
  );
  const targetedAffinityChanged = applyTargetedAffinityDeltas(ctx, contextualized, targetId);
  const statsChanged = applyPlayerStatDeltas(ctx.state.playerProfile, contextualized);
  ctx.adapter.save(ctx.state.statusData);
  return targetedAffinityChanged || statsChanged || true;
}

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
  let phoneDirective = extractPhoneMessageDirective(ctx, userInput);
  recordGenerationDebug(ctx, 'submit:start', {
    userInputLength: userInput.length,
    keepDraft: Boolean(options.keepDraft),
    phoneDirectiveTargetId: phoneDirective?.target.id ?? null,
    phoneDirectiveSource: phoneDirective ? 'fallback-parser' : null,
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

  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  if (hasTavernGenerate && !phoneDirective && hasExplicitPhoneSendIntent(userInput)) {
    const llmDirective = await detectPhoneDirectiveWithLlm(ctx, userInput).catch(error => {
      console.warn('[phone-directive] detector failed:', error);
      return null;
    });
    if (llmDirective) {
      phoneDirective = llmDirective;
      recordGenerationDebug(ctx, 'submit:phone-directive-detected', {
        targetId: llmDirective.target.id,
        textLength: llmDirective.text.length,
      });
    }
  }
  const eventBeforeGeneration = getLatestRecentEvent(ctx)?.key ?? null;
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
                content: buildPrompt(state.statusData, promptHistory, '', ctx.summaryStore, {
                  playerProfile: state.playerProfile,
                  plotLibrary: state.plotLibrary,
                  skipProgress: !!ctx.summaryApiConfig,
                  suppressPhoneMessageContent: Boolean(phoneDirective),
                  phoneMessageTargetName: phoneDirective?.target.name,
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
            }),
          },
    );

    recordGenerationDebug(ctx, 'submit:generate-returned', {
      requestGenerationId,
      resultLength: String(result ?? '').length,
    });
    finalizeStreamingText(ctx, String(result ?? ''), requestGenerationId);

    // 解析 <progress> 并应用变量更新。
    if (ctx.summaryApiConfig) {
      // 副 API 负责变量提取。
      try {
        const mainProgressUpdate = parseProgressUpdate(String(result ?? ''));
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
        const progressUpdate = mergeMissingAffinity(parseProgressUpdate(progressRaw), mainProgressUpdate, ctx);
        if (progressUpdate) {
          applyFullProgressUpdate(ctx, progressUpdate);
        }
      } catch (e) {
        console.warn('[progress] secondary API failed:', e);
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
    if (generationSucceeded && typeof win.generateRaw === 'function') {
      recordGenerationDebug(ctx, 'submit:summary-start');
      const summaryCtx: SummaryContext = {
        win,
        summaryStore: ctx.summaryStore,
        summaryApiConfig: ctx.summaryApiConfig,
        uiMessages: state.uiMessages,
        onStoreUpdated: () => {
          ctx.onSummaryStoreUpdated();
          ctx.render();
        },
        getFactAnchor: () => buildFactAnchorFromStatus(ctx.state.statusData),
      };
      await runSummary(summaryCtx).catch(() => {
        /* 摘要错误在内部处理 */
      });
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
    .replace(/[・·.\s　]+/g, '');
}

function hasExplicitPhoneSendIntent(text: string) {
  const normalizedInput = normalizeForDirectiveMatch(text);
  return /(发消息|发送消息|发短信|发送短信|手机联系|短信|私聊|微信|打开手机|用手机)/.test(normalizedInput);
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
    builtInTerms.push('霞之丘', '霞之丘诗羽', '霞之诗羽', '霞ヶ丘', '诗羽', '詩羽', '霞诗子', '霞詩子', 'utaha', 'kasumigaoka');
  }
  if (/加藤|惠|恵|megumi|katou|kato/.test(haystack)) {
    builtInTerms.push('加藤', '加藤惠', '加藤恵', '惠', '恵', 'megumi', 'katou', 'kato');
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

function isExplicitPhoneTargetMention(target: TargetStatus, text: string) {
  const normalizedText = normalizeForDirectiveMatch(text);
  if (!normalizedText) return false;

  return getPhoneTargetSearchTerms(target)
    .map(term => normalizeForDirectiveMatch(term))
    .filter(term => term.length >= 2)
    .some(term => normalizedText.includes(term));
}

function buildPhoneActionDetectorPrompt(ctx: ActionContext, userInput: string) {
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

  return [
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
    '',
    `玩家输入：${userInput}`,
  ].join('\n');
}

function parsePhoneActionDetectorResult(ctx: ActionContext, rawResult: string, userInput: string): PhoneDirective | null {
  const tagged = extractTaggedReply(rawResult, 'phone_action', false);
  if (!tagged) return null;

  const action = tagged.match(/^action[:：]\s*(.+)$/im)?.[1]?.trim().toLowerCase() ?? '';
  if (action !== 'send') return null;

  const targetId = tagged.match(/^target_id[:：]\s*(.+)$/im)?.[1]?.trim() ?? '';
  const message = stripDirectiveQuotes(tagged.match(/^message[:：]\s*([\s\S]*?)(?:\nconfidence[:：]|\n?$)/im)?.[1] ?? '');
  const confidence = tagged.match(/^confidence[:：]\s*(.+)$/im)?.[1]?.trim().toLowerCase() ?? '';
  if (!targetId || !message || !PHONE_ACTION_DETECTOR_CONFIDENCE.has(confidence)) return null;

  const target = getPhoneThreadTarget(ctx, targetId) ?? findPhoneDirectiveTarget(ctx, targetId);
  // 中文注释：LLM 检测器只能确认明确点名的联系人，不能凭当前攻略对象或剧情联想代替玩家选择。
  if (target && !isExplicitPhoneTargetMention(target, userInput)) return null;
  return target ? { target, text: message } : null;
}

async function detectPhoneDirectiveWithLlm(ctx: ActionContext, userInput: string): Promise<PhoneDirective | null> {
  const { win } = ctx;
  if (!ctx.state.statusData.targets.length) return null;

  const prompt = buildPhoneActionDetectorPrompt(ctx, userInput);
  const generationId = `phone-directive-detect-${crypto.randomUUID()}`;
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

  return parsePhoneActionDetectorResult(ctx, String(rawResult ?? ''), userInput);
}

function extractPhoneMessageDirective(ctx: ActionContext, userInput: string): PhoneDirective | null {
  if (!hasExplicitPhoneSendIntent(userInput)) return null;

  const patterns = [
    /(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*(?:发消息|发送消息|发短信|发送短信|发个消息|发条消息|手机联系|私聊|微信)\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:发消息|发送消息|发短信|发送短信|发个消息|发条消息|短信|私聊|微信)\s*(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:用手机|打开手机)\s*(?:给|向|对)\s*([^，。！？\n,!?]{1,32})\s*(?:说|发送|发)\s*[：:，,]?\s*([\s\S]*)/i,
    /(?:用手机|打开手机)\s*(?:发送消息|发消息|发短信|发送短信|私聊|微信)?\s*(?:问|询问|告诉)\s*([^，。！？\n,!?]{1,32})\s*([\s\S]*)/i,
  ];

  for (const pattern of patterns) {
    const match = userInput.match(pattern);
    if (!match) continue;

    const target = findPhoneDirectiveTarget(ctx, match[1] ?? '');
    if (!target) continue;

    const explicitText = stripDirectiveQuotes(match[2] ?? '');
    const fallbackText = stripDirectiveQuotes(userInput);
    return {
      target,
      text: explicitText || fallbackText,
    };
  }

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
  if (!isExplicitPhoneTargetMention(target, latestEvent.text)) return;
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
      '根据刚刚正文发生的事件，判断你是否会主动发一条手机消息。如果事件与你有关、你有话想说、或者你有理由关心，就生成这条消息；如果事件和你无关、你没有理由主动联系、或者当前情境不适合发消息，就只输出 <message></message> 表示不发送。不要为了发消息而发消息。',
    summaryStore: ctx.summaryStore,
    playerProfile: state.playerProfile,
    plotLibrary: state.plotLibrary,
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

    // 正文触发的手机发送也走手机变量分析，保证好感度和近期事件会生效。
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
          applyFullProgressUpdate(ctx, progressUpdate, target.id);
        }
      } catch (e) {
        console.warn('[phone-progress] directive analysis failed:', e);
      }
    } else {
      const progressUpdate = parseProgressUpdate(rawResult);
      if (progressUpdate) {
        applyFullProgressUpdate(ctx, progressUpdate, target.id);
      }
    }

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
          applyFullProgressUpdate(ctx, progressUpdate, target.id);
        }
      } catch (e) {
        console.warn('[phone-progress] analysis failed:', e);
      }
    } else {
      const progressUpdate = parseProgressUpdate(rawResult);
      if (progressUpdate) {
        applyFullProgressUpdate(ctx, progressUpdate, target.id);
      }
    }

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
