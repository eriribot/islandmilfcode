import {
  buildPhoneChatPrompt,
  buildPhoneProgressPrompt,
  buildProgressPrompt,
  buildPrompt,
  extractPhoneChatReply,
  extractTaggedReply,
  getReaderMessages,
  getPromptMessageText,
  type ProgressUpdate,
  getVisibleMessageText,
  parseProgressUpdate,
  sanitizePromptInputText,
} from '../message-format';
import { clearBackgroundTask, setBackgroundTaskFailed, setBackgroundTaskRunning } from '../background-tasks';
import { SecondaryTaskCancelledError, runSecondaryTask, type SecondaryTaskKind } from '../secondary-api';
import { createRollbackSnapshot, pushMessage } from '../state/store';
import {
  buildFactAnchorFromStatus,
  runSummary,
  shouldRunGlobalCompression,
  shouldRunMajorSummary,
  shouldRunMinorSummary,
  type SummaryContext,
} from '../summary';
import type { SummaryApiConfig, SummaryStore } from '../summary/types';
import type {
  ImageRerollContext,
  PhoneChatMessage,
  PhoneProactiveState,
  PlayerProfile,
  PlayerStats,
  PlotLibrary,
  ScenePresence,
  StatusData,
  TargetStatus,
  UiMessage,
} from '../types';
import type { VariableAdapter } from '../variables/adapter';
import {
  affinityStage,
  applyProgressUpdate,
  clamp,
  commitWorldTimeCandidate,
  formatTime,
  normalizeIncomingTime,
  obsessionStage,
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
import { getCharacterCanonicalClass, getCharacterRelationToTomoya } from '../relationship';
import { commitProgressToMemoryDB } from '../memorydatabase/commit-points';
import { indexPhoneMessage } from '../memorydatabase/phone-repository';
import type { IslandMemoryDB } from '../memorydatabase/types';
import { isPlotEventAllowedByRoute } from '../plot-routing';
import { isPlayerPhonePseudoTarget } from '../phone/types';
import { emitCharacterDataImportFromResponse } from '../plugins/character-data-import';
import {
  extractImageGenerationPrompts,
  isImageGenerationPluginAvailable,
  requestImageGeneration,
} from '../plugins/image-generation';

export type ActionContext = StreamingContext & {
  adapter: VariableAdapter;
  clearNotification: (shouldRender: boolean) => void;
  closeReaderContextMenu: (shouldRender: boolean) => void;
  persistConversation: () => void;
  summaryStore: SummaryStore;
  summaryApiConfig: SummaryApiConfig | null;
  onSummaryStoreUpdated: () => void;
  readonly memoryDB: IslandMemoryDB;
};

const PHONE_PROACTIVE_COOLDOWN_MS = 3 * 60 * 1000;
const PHONE_ACTION_DETECTOR_CONFIDENCE = new Set(['high', 'medium', '中', '高', '确定', '较高']);
const IMAGE_GENERATION_REQUEST_INTERVAL_MS = 45_000;

type PhoneDirective = {
  target: TargetStatus;
  text: string;
};

type ScenePhoneMessage = {
  target: TargetStatus;
  role: 'user' | 'assistant';
  text: string;
};

function isPlayerPseudoTarget(target: TargetStatus | null | undefined) {
  return isPlayerPhonePseudoTarget(target);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPhoneContactTargets(ctx: Pick<ActionContext, 'state'>) {
  return ctx.state.statusData.targets.filter(target => !isPlayerPseudoTarget(target));
}

// 合并版 progress prompt 解析出的手机消息暂存：同回合 maybeQueueProactivePhoneMessage 会读它并清空，跳过 phone-scene-extract 副 API。
// 不放进 state（属于一次性流转数据，不需要存档），也不放进 ctx 类型（避免侵入）。流程顺序执行无竞态。
let lastProgressPhoneMessages: ScenePhoneMessage[] | null = null;

const GENERATION_CANCEL_TOKEN_KEY = 'generationCancelToken';

function getGenerationCancelToken(ctx: Pick<ActionContext, 'state'>): number {
  return Number(ctx.state.runtimeFlags?.[GENERATION_CANCEL_TOKEN_KEY] ?? 0) || 0;
}

function beginGenerationRun(ctx: Pick<ActionContext, 'state'>): number {
  const token = getGenerationCancelToken(ctx) + 1;
  ctx.state.runtimeFlags[GENERATION_CANCEL_TOKEN_KEY] = token;
  ctx.state.runtimeFlags.generationCancelRequested = false;
  return token;
}

function isGenerationRunCancelled(ctx: Pick<ActionContext, 'state'>, token: number): boolean {
  return (
    Boolean(ctx.state.runtimeFlags?.generationCancelRequested) ||
    getGenerationCancelToken(ctx) !== token
  );
}

export function cancelCurrentGeneration(ctx: ActionContext) {
  const { state } = ctx;
  if (!state.generating && !state.currentGenerationId && !state.phoneMessages.generating) return;

  state.runtimeFlags[GENERATION_CANCEL_TOKEN_KEY] = getGenerationCancelToken(ctx) + 1;
  state.runtimeFlags.generationCancelRequested = true;
  state.generating = false;
  state.phoneMessages.generating = false;
  state.currentGenerationId = '';
  lastProgressPhoneMessages = null;
  clearBackgroundTask(state, 'progress');
  clearBackgroundTask(state, 'summary');
  discardStreamingMessage(ctx);
  ctx.persistConversation();
  ctx.render();
  recordGenerationDebug(ctx, 'submit:cancel-requested');
}

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

// 生成前只做地点 hint，不再推断时间。
// 历史教训：旧的生成前时间推断把整段玩家叙事丢给 normalizeIncomingTime，其 cnShort 正则只取
// 文本里第一个 "M月D日"，导致"提到 8月12日party、实际推进到 8月13日"被写成 12 日，且绕过
// <state_delta>/<progress> 全部防线、在生成前就 save。时间推进统一交给生成后管线
// （detectTimeAdvanceIntent → AI 读完整上下文输出 时间:YYYY-MM-DD HH:mm），写入再过 enforceMonotonicTime 单调闸。
function applyLocalWorldHintsFromUserInput(ctx: ActionContext, userInput: string): boolean {
  const { statusData, plotLibrary } = ctx.state;
  const nextLocation = detectLocalLocationFromUserInput(userInput, plotLibrary);
  let changed = false;

  if (nextLocation && nextLocation !== statusData.world.currentLocation) {
    statusData.world.currentLocation = nextLocation;
    changed = true;
  }

  if (changed) {
    ctx.adapter.save(statusData);
    recordGenerationDebug(ctx, 'submit:local-world-hints', {
      location: nextLocation ?? '',
    });
  }

  return changed;
}

function getProgressDatePart(value: string | undefined): string {
  return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
}

// 主线事件激活（进行中 / 设为当前事件）必须等当前游戏日期到达事件触发日。
// 终态（已结束/跳过/延后）对未来事件仍然放行——User 主动跳过本就需要把后续事件结算掉。
// 这是 syncMainEvents 之外的第二道闸：模型把未来卷的事件写成"进行中"是
// "莫名跳到第三卷 / 日历显示未来事件进行中"的根因，且一旦写入会强制结算前序事件、难以回退。
function isMainEventActivatableByDate(
  eventId: string,
  plotLibrary: PlotLibrary,
  currentDate: string,
): boolean {
  if (!currentDate) return true; // 没有可比对的当前日期时放行，避免误伤初始化流程。
  const scheduleDate = getProgressDatePart(plotLibrary.events[eventId]?.schedule?.date);
  if (!scheduleDate) return true; // 没有排期日期的事件不参与时间闸。
  return currentDate >= scheduleDate;
}

function isActivatingStatus(status: string): boolean {
  return String(status ?? '').trim() === '进行中';
}

function isTerminalMainEventStatus(status: string): boolean {
  return /已结束|跳过|延后|已完成/.test(String(status ?? '').trim());
}

function getMainEventWindowEndDate(eventId: string, plotLibrary: PlotLibrary): string {
  const schedule = plotLibrary.events[eventId]?.schedule;
  return getProgressDatePart(schedule?.endDate) || getProgressDatePart(schedule?.date);
}

function isMainEventClosableByDate(eventId: string, plotLibrary: PlotLibrary, currentDate: string): boolean {
  if (!currentDate) return true; // 没有可比对的当前日期时放行，避免误伤初始化流程。
  const endDate = getMainEventWindowEndDate(eventId, plotLibrary);
  if (!endDate) return true; // 没有排期日期的事件不参与时间闸。
  return currentDate > endDate;
}

function hasActivatableRouteSuccessor(
  currentEventId: string,
  plotLibrary: PlotLibrary,
  statusData: StatusData | null | undefined,
  currentDate: string,
): boolean {
  if (!statusData || !currentDate) return false;
  const nextIds = plotLibrary.events[currentEventId]?.nextIds ?? [];
  if (!nextIds.length) return false;
  const nextIdSet = new Set(nextIds);

  return Object.values(plotLibrary.events).some(event => {
    if (event.id === currentEventId) return false;
    if (!nextIdSet.has(event.id)) return false;
    if (!event.schedule?.date) return false;
    if (!isMainEventActivatableByDate(event.id, plotLibrary, currentDate)) return false;

    const successorEndDate = getMainEventWindowEndDate(event.id, plotLibrary);
    if (successorEndDate && currentDate > successorEndDate) return false;

    return isPlotEventAllowedByRoute(event.id, statusData);
  });
}

function canCloseCurrentMainEventByScheduleOrRoute(
  eventId: string,
  plotLibrary: PlotLibrary,
  statusData: StatusData | null | undefined,
  currentDate: string,
): boolean {
  return (
    isMainEventClosableByDate(eventId, plotLibrary, currentDate) ||
    hasActivatableRouteSuccessor(eventId, plotLibrary, statusData, currentDate)
  );
}

function findRouteCheckTarget(statusData: StatusData, targetHint: string): TargetStatus | null {
  const normalizedHint = normalizeForDirectiveMatch(targetHint);
  if (!normalizedHint) return null;

  return (
    statusData.targets.find(target => target.id === targetHint) ??
    statusData.targets.find(target =>
      getPhoneTargetSearchTerms(target)
        .map(term => normalizeForDirectiveMatch(term))
        .filter(Boolean)
        .some(term => term === normalizedHint),
    ) ??
    statusData.targets.find(target =>
      getPhoneTargetSearchTerms(target)
        .map(term => normalizeForDirectiveMatch(term))
        .filter(term => term.length >= 2)
        .some(term => term.includes(normalizedHint) || normalizedHint.includes(term)),
    ) ??
    null
  );
}

function buildRouteCheckTargets(statusData: StatusData, update: ProgressUpdate): TargetStatus[] {
  const targets = statusData.targets.map(target => ({
    ...target,
    titles: { ...target.titles },
    outfits: { ...target.outfits },
    meta: target.meta ? { ...target.meta } : undefined,
  }));
  const routeStatusData: StatusData = { ...statusData, targets };

  for (const item of update.affinityDeltas) {
    if (!item.delta) continue;
    const target = findRouteCheckTarget(routeStatusData, item.target);
    if (!target) continue;
    target.affinity = clamp((target.affinity ?? 0) + item.delta, 0, 100);
  }

  for (const item of update.obsessionDeltas) {
    if (!item.delta) continue;
    const target = findRouteCheckTarget(routeStatusData, item.target);
    if (!target) continue;
    target.obsession = clamp((target.obsession ?? 0) + item.delta, 0, 100);
  }

  return targets;
}

function buildRouteCheckStatus(
  statusData: StatusData | null | undefined,
  update: ProgressUpdate,
): StatusData | null | undefined {
  if (!statusData) return statusData;

  return {
    ...statusData,
    targets: buildRouteCheckTargets(statusData, update),
    world: {
      ...statusData.world,
      currentTime: update.time
        ? normalizeIncomingTime(update.time, statusData.world.currentTime)
        : statusData.world.currentTime,
      mainEvents: {
        ...(statusData.world.mainEvents ?? {}),
        ...(update.mainEvents ?? {}),
      },
      currentMainEventId:
        update.currentMainEventId !== undefined
          ? update.currentMainEventId
          : statusData.world.currentMainEventId,
    },
  };
}

// 把 AI 给的主线事件 id 跟剧情库（世界书里第一卷/第二卷/第三卷条目合并后的 plotLibrary.events）对一遍，
// 不在白名单里的整条丢掉。这样即使模型在空档期自造 SAE_2-1 之类的野 id，也只会影响正文叙述，不会污染 statusData。
function sanitizeProgressAgainstPlotLibrary(
  update: ProgressUpdate,
  plotLibrary: PlotLibrary | null | undefined,
  statusData?: StatusData | null,
): ProgressUpdate {
  const whitelist = plotLibrary ? new Set(Object.keys(plotLibrary.events)) : null;
  // 没有加载到剧情库（初始化中 / 世界书未挂载）时放行，避免误伤正常流程。
  if (!whitelist || whitelist.size === 0 || !plotLibrary) return update;

  const routeStatusData = buildRouteCheckStatus(statusData, update);
  const currentDate = getProgressDatePart(routeStatusData?.world.currentTime);

  const sanitizedMainEvents: Record<string, string> = {};
  for (const [id, status] of Object.entries(update.mainEvents)) {
    if (!whitelist.has(id)) {
      console.warn('[progress-guard] drop unknown mainEvent id:', id);
      continue;
    }
    if (!isPlotEventAllowedByRoute(id, routeStatusData)) {
      console.warn('[progress-guard] drop route-blocked mainEvent id:', id);
      continue;
    }
    // 时间闸：未到触发日期的事件不允许被标记为"进行中"，但允许终态（跳过/延后/已结束）以支持主动跳关。
    if (isActivatingStatus(status) && !isMainEventActivatableByDate(id, plotLibrary, currentDate)) {
      console.warn('[progress-guard] drop premature mainEvent activation:', id, 'currentDate:', currentDate);
      continue;
    }
    // 日期 + 路由闸：仍处在事件日期/持续至当天，且没有可激活后续事件时，当前事件不能被正文后 progress 提前结算。
    // 例如 SAE_04-8 是 2012-10-27 的单日事件，10-27 当天没有后续可接，始终保持进行中；
    // 但 SAE_03-7A/7B 到 2012-08-13 时，plot-routing 已解锁 SAE_03-8，可以同日收束并接续。
    if (
      id === statusData?.world.currentMainEventId &&
      isTerminalMainEventStatus(status) &&
      !canCloseCurrentMainEventByScheduleOrRoute(id, plotLibrary, routeStatusData, currentDate)
    ) {
      console.warn('[progress-guard] drop same-window terminal current mainEvent:', id, status, 'currentDate:', currentDate);
      continue;
    }
    sanitizedMainEvents[id] = status;
  }

  let sanitizedCurrentId = update.currentMainEventId;
  if (
    sanitizedCurrentId === '' &&
    statusData?.world.currentMainEventId &&
    !canCloseCurrentMainEventByScheduleOrRoute(
      statusData.world.currentMainEventId,
      plotLibrary,
      routeStatusData,
      currentDate,
    )
  ) {
    console.warn(
      '[progress-guard] drop same-window currentMainEvent clear:',
      statusData.world.currentMainEventId,
      'currentDate:',
      currentDate,
    );
    sanitizedCurrentId = undefined;
  }
  if (sanitizedCurrentId && !isPlotEventAllowedByRoute(sanitizedCurrentId, routeStatusData)) {
    console.warn('[progress-guard] drop route-blocked currentMainEventId:', sanitizedCurrentId);
    sanitizedCurrentId = undefined;
  } else if (sanitizedCurrentId && !whitelist.has(sanitizedCurrentId)) {
    console.warn('[progress-guard] drop unknown currentMainEventId:', sanitizedCurrentId);
    sanitizedCurrentId = undefined;
  } else if (
    sanitizedCurrentId &&
    !isMainEventActivatableByDate(sanitizedCurrentId, plotLibrary, currentDate)
  ) {
    // 设为当前事件等价于激活：未到触发日期时丢弃，防止游标跳到未来卷。
    console.warn(
      '[progress-guard] drop premature currentMainEventId:',
      sanitizedCurrentId,
      'currentDate:',
      currentDate,
    );
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
    const text = getPromptMessageText(message).trim();
    if (text) return text;
  }
  return '';
}

function buildDrawingHistoryContext(ctx: ActionContext, userInput: string) {
  const count = ctx.state.drawingSettings.contextMessageCount;
  const cleanUserInput = sanitizePromptInputText(userInput);
  const completed = ctx.state.uiMessages.filter(
    message => !message.streaming && (message.role === 'user' || message.role === 'assistant'),
  );
  const lines = completed
    .slice(-Math.max(0, count))
    .map(message => {
      const speaker = message.speaker || (message.role === 'assistant' ? 'Assistant' : 'User');
      const text = getPromptMessageText(message).trim();
      return text ? `[${speaker}]\n${text}` : '';
    })
    .filter(Boolean);
  if (cleanUserInput.trim() && !lines.some(line => line.includes(cleanUserInput.trim()))) {
    lines.push(`[玩家当前输入]\n${cleanUserInput.trim()}`);
  }
  return lines.join('\n\n');
}

function attachIllustrationToMessage(
  ctx: ActionContext,
  messageId: string,
  imageData: string,
  prompt?: string,
  anchorIndex?: number,
  rerollContext?: ImageRerollContext,
) {
  const message = ctx.state.uiMessages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant' || !imageData.trim()) return false;

  const illustrations = message.illustrations ?? [];
  if (illustrations.some(illustration => illustration.imageData === imageData)) return false;
  message.illustrations = [
    ...illustrations,
    {
      id: crypto.randomUUID(),
      imageData,
      prompt,
      anchorIndex,
      rerollContext,
      createdAt: Date.now(),
    },
  ];
  ctx.persistConversation();
  return true;
}

function queueDrawingPluginTasks(ctx: ActionContext, userInput: string) {
  if (!ctx.state.drawingSettings.enabled) return;
  if (!isImageGenerationPluginAvailable(ctx.win)) return;
  const cleanUserInput = sanitizePromptInputText(userInput);
  const latest = ctx.state.uiMessages[ctx.state.uiMessages.length - 1];
  if (!latest || latest.role !== 'assistant') return;

  const rawText = String(latest.rawText || latest.text || '');
  const sceneText = getVisibleMessageText(latest).trim();
  const historyContext = buildDrawingHistoryContext(ctx, userInput);
  const metadata = {
    generationContext: historyContext || cleanUserInput,
    generationWorldBook: [
      `时间: ${ctx.state.statusData.world.currentTime}`,
      `地点: ${ctx.state.statusData.world.currentLocation}`,
      `当前事件: ${ctx.state.statusData.world.currentMainEventId || '无'}`,
      ctx.state.drawingSettings.qualityPrompt ? `画风/质量: ${ctx.state.drawingSettings.qualityPrompt}` : '',
      ctx.state.drawingSettings.characterAnchors.length
        ? [
            '角色外貌锚定:',
            ...ctx.state.drawingSettings.characterAnchors.map(anchor => `- ${anchor.name}: ${anchor.prompt}`),
          ].join('\n')
        : '',
      ctx.state.drawingSettings.systemPrompt ? `系统指令: ${ctx.state.drawingSettings.systemPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };

  void emitCharacterDataImportFromResponse(ctx.win, rawText, metadata)
    .then(result => {
      if (result.blockCount > 0) {
        recordGenerationDebug(ctx, 'character-data-import:emit', result);
      }
    })
    .catch(error => {
      console.warn('[character-data-import] emit failed:', error);
      recordGenerationDebug(ctx, 'character-data-import:error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  const explicitImagePrompts = extractImageGenerationPrompts(rawText);
  const imagePrompts = explicitImagePrompts.filter(prompt => !prompt.prompt);
  if (!explicitImagePrompts.length && (sceneText || cleanUserInput.trim())) {
    imagePrompts.push({ prompt: '' });
  }
  if (!imagePrompts.length) return;

  const targetMessageId = latest.id;
  void (async () => {
    let sentCount = 0;
    let failedCount = 0;
    let attachedCount = 0;
    let timeoutCount = 0;
    let lastError = '';

    for (const [index, prompt] of imagePrompts.entries()) {
      if (prompt.prompt) continue;
      if (index > 0) {
        ctx.showNotification({
          kind: 'message',
          title: `等待发送生图 ${index + 1}/${imagePrompts.length}`,
          preview: '为避免插件队列拥堵，下一张将在 45 秒后发送。',
          targetTab: 'summary',
          timestamp: formatTime(ctx.state.statusData.world.currentTime),
        });
        ctx.render();
        await sleep(IMAGE_GENERATION_REQUEST_INTERVAL_MS);
      }

      const result = await requestImageGeneration(ctx.win, prompt.prompt, ctx.state.drawingSettings, prompt.change, {
        sceneText,
        rawText,
        generationContext: metadata.generationContext,
        generationWorldBook: metadata.generationWorldBook,
        userInput: cleanUserInput,
        summaryApiConfig: ctx.summaryApiConfig,
      });

      recordGenerationDebug(ctx, 'image-generation:request', {
        index: index + 1,
        total: imagePrompts.length,
        sent: result.sent,
        reason: result.reason ?? '',
        error: result.error ?? '',
        prompt: result.prompt ?? prompt.prompt,
        hasImageData: Boolean(result.imageData),
      });

      if (result.sent) sentCount += 1;
      if (result.error) {
        failedCount += 1;
        lastError = result.error;
      }
      if (result.reason === 'timeout') timeoutCount += 1;
      if (!result.error && result.imageData) {
        const attached = attachIllustrationToMessage(
          ctx,
          targetMessageId,
          result.imageData,
          result.prompt ?? prompt.prompt,
          prompt.anchorIndex,
          {
            prompt: result.prompt ?? prompt.prompt,
            negativePrompt: ctx.state.drawingSettings.negativePrompt?.trim() || '',
            change: prompt.change,
            sceneText,
            rawText,
            generationContext: metadata.generationContext,
            generationWorldBook: metadata.generationWorldBook,
            userInput: cleanUserInput,
          },
        );
        if (attached) attachedCount += 1;
      }

      ctx.showNotification({
        kind: 'message',
        title:
          imagePrompts.length > 1
            ? `生图 ${index + 1}/${imagePrompts.length}`
            : result.error
              ? '生图失败'
              : '生图请求已发送',
        preview:
          result.error ||
          (result.reason === 'timeout' ? '智绘姬生成较慢，请到插件图片面板查看。' : ''),
        targetTab: 'summary',
        timestamp: formatTime(ctx.state.statusData.world.currentTime),
      });
      ctx.render();
    }

    if (imagePrompts.length > 1) {
      ctx.showNotification({
        kind: 'message',
        title: failedCount ? '部分生图失败' : '多张生图已处理',
        preview:
          lastError ||
          (timeoutCount
            ? `已发送 ${sentCount}/${imagePrompts.length} 张，部分生成较慢，请到插件图片面板查看。`
            : attachedCount
              ? `已挂载 ${attachedCount} 张图片。`
              : `已发送 ${sentCount}/${imagePrompts.length} 张。`),
        targetTab: 'summary',
        timestamp: formatTime(ctx.state.statusData.world.currentTime),
      });
      ctx.render();
    }
  })()
    .catch(error => {
      console.warn('[image-generation] emit failed:', error);
      recordGenerationDebug(ctx, 'image-generation:error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
  scenePresence?: ScenePresence | null,
): AffinityVerdict {
  if (forcedTargetId) return target.id === forcedTargetId ? 'forced' : 'absent';

  const latestSceneText = getLatestAssistantSceneText(ctx);
  if (latestSceneText) {
    // 发声反证优先级最高：哪怕后半段写了"离开"，只要目标前半段有发声，依然判在场。
    if (textContainsTargetActiveSignals(latestSceneText, target)) return 'mention';
    if (textMarksTargetFirmlyAbsent(latestSceneText, target)) return 'absent';
    if (textMentionsTarget(latestSceneText, target)) return 'mention';
  }

  if (scenePresence?.presentIds?.includes(target.id) || scenePresence?.focusIds?.includes(target.id)) {
    return 'mention';
  }
  if (scenePresence?.absentIds?.includes(target.id)) {
    return 'absent';
  }

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

function applyTargetedAffinityDeltas(
  ctx: ActionContext,
  update: ProgressUpdate,
  forcedTargetId?: string | null,
  scenePresence?: ScenePresence | null,
) {
  let changed = false;

  for (const item of update.affinityDeltas) {
    if (!item.delta) continue;
    const target = findProgressTarget(ctx, item.target);
    if (!target) {
      console.warn('[progress] unknown affinity target:', item.target);
      continue;
    }

    const verdict = classifyAffinityVerdict(ctx, target, forcedTargetId, scenePresence);
    if (verdict === 'absent') {
      console.warn('[progress] drop affinity for absent target:', item.target);
      continue;
    }
    // unmentioned 不再硬 drop：state_delta 多角色批量评估时（如群体场景）经常没在叙事里点名，
    // 走 clampAffinityByVerdict 的软上限（±1）既保留 LLM 的判定又避免被夸大。
    const effectiveDelta = clampAffinityByVerdict(item.delta, verdict);
    if (!effectiveDelta) continue;

    const nextAffinity = clamp((target.affinity ?? 0) + effectiveDelta, 0, 100);
    if (nextAffinity === target.affinity) continue;
    target.affinity = nextAffinity;
    target.stage = affinityStage(nextAffinity);
    changed = true;
  }

  return changed;
}

function applyTargetedObsessionDeltas(
  ctx: ActionContext,
  update: ProgressUpdate,
  forcedTargetId?: string | null,
  scenePresence?: ScenePresence | null,
) {
  let changed = false;

  for (const item of update.obsessionDeltas) {
    if (!item.delta) continue;
    const target = findProgressTarget(ctx, item.target);
    if (!target) {
      console.warn('[progress] unknown obsession target:', item.target);
      continue;
    }

    const verdict = classifyAffinityVerdict(ctx, target, forcedTargetId, scenePresence);
    if (verdict === 'absent') {
      console.warn('[progress] drop obsession for absent target:', item.target);
      continue;
    }
    // 旧情度专门的语义允许间接通道（替代位 / 吐露旧事 / 回忆性提及伦也），
    // 即使角色当回合不在镜头中央也可能合理变化；这里不再做幅度软上限，
    // 在场判定（textContainsTargetActiveSignals / textMarksTargetFirmlyAbsent）已经把绝对不可能的情况挡掉。
    const nextObsession = clamp((target.obsession ?? 0) + item.delta, 0, 100);
    if (nextObsession === target.obsession) continue;
    target.obsession = nextObsession;
    target.obsessionStage = obsessionStage(nextObsession);
    changed = true;
  }

  return changed;
}

function applyVirginityFlags(ctx: ActionContext, update: ProgressUpdate) {
  let changed = false;

  for (const flag of update.virginityFlags) {
    const target = findProgressTarget(ctx, flag.target);
    if (!target) {
      console.warn('[progress] unknown virginity target:', flag.target);
      continue;
    }
    target.meta ??= {};
    if (target.meta.intimacyStatusMode === 'adult-married') {
      console.warn('[progress] drop virginity flag for adult-married target:', flag.target);
      continue;
    }
    // 单向闩锁：一旦置为 lost 就不可前向复位；只有回滚快照（整体替换 statusData）能恢复。
    if (target.meta.virginity === 'lost') continue;
    target.meta.virginity = 'lost';
    changed = true;
  }

  return changed;
}

function applyIntimacyCounters(ctx: ActionContext, update: ProgressUpdate) {
  let changed = false;

  for (const item of update.intimacyCounters) {
    if (item.delta <= 0) continue;
    const target = findProgressTarget(ctx, item.target);
    if (!target) {
      console.warn('[progress] unknown intimacy-counter target:', item.target);
      continue;
    }
    target.meta ??= {};
    const counters = (target.meta.bodyCounters ??= {}) as Record<string, number>;
    const previous = Number(counters[item.field]) || 0;
    // 单调递增：只接受正增量，拒绝任何回退。
    counters[item.field] = previous + item.delta;
    changed = true;
  }

  return changed;
}

function filterAdultMarriedVirginityFlags(ctx: ActionContext, update: ProgressUpdate): ProgressUpdate {
  const virginityFlags = update.virginityFlags.filter(flag => {
    const target = findProgressTarget(ctx, flag.target);
    return target?.meta?.intimacyStatusMode !== 'adult-married';
  });
  return virginityFlags.length === update.virginityFlags.length ? update : { ...update, virginityFlags };
}

function applyFullProgressUpdate(
  ctx: ActionContext,
  update: ProgressUpdate | null,
  targetId?: string | null,
  scenePresence?: ScenePresence | null,
) {
  if (!update) return false;
  const sanitized = sanitizeProgressAgainstPlotLibrary(update, ctx.state.plotLibrary, ctx.state.statusData);
  const legacyDelta = clampLegacyAffinityDelta(ctx, sanitized, targetId);
  // 主场景没有明确对象时，丢弃旧单目标着装更新，避免误写到 activeTargetId。
  const outfitChanges = targetId ? sanitized.outfitChanges : {};
  const contextualized: ProgressUpdate = { ...sanitized, affinityDelta: legacyDelta, outfitChanges };
  applyProgressUpdate(ctx.state.statusData, contextualized, targetId ?? null, ctx.state.plotLibrary);
  const targetedAffinityChanged = applyTargetedAffinityDeltas(ctx, contextualized, targetId, scenePresence);
  const targetedObsessionChanged = applyTargetedObsessionDeltas(ctx, contextualized, targetId, scenePresence);
  const virginityChanged = applyVirginityFlags(ctx, contextualized);
  const countersChanged = applyIntimacyCounters(ctx, contextualized);
  const statsChanged = applyPlayerStatDeltas(ctx.state.playerProfile, contextualized);
  ctx.adapter.save(ctx.state.statusData);
  commitProgressToMemoryDB(ctx.memoryDB, filterAdultMarriedVirginityFlags(ctx, contextualized));
  return targetedAffinityChanged || targetedObsessionChanged || virginityChanged || countersChanged || statsChanged || true;
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
  const cleanUserInput = sanitizePromptInputText(userInput).trim();

  const drawingEnabledAtSubmit = Boolean(state.drawingSettings.enabled);
  state.generating = true;
  if (!options.keepDraft || options.text == null) {
    state.draft = '';
  }
  state.currentGenerationId = crypto.randomUUID();
  const generationToken = beginGenerationRun(ctx);
  let requestGenerationId = state.currentGenerationId;
  state.finalizedGenerationId = '';
  state.focusedMessagePage = 0;
  const hasTavernGenerate = typeof win.generate === 'function' || typeof win.generateRaw === 'function';
  let phoneDirective: PhoneDirective | null = null;
  let phoneDirectiveSource: string | null = null;
  if (hasTavernGenerate && hasExplicitPhoneSendIntent(cleanUserInput)) {
    phoneDirective = await detectPhoneDirectiveWithLlm(ctx, cleanUserInput).catch(error => {
      console.warn('[phone-directive] detector failed:', error);
      return null;
    });
    if (phoneDirective) {
      phoneDirectiveSource = 'llm-detector';
    }
  }
  if (!phoneDirective) {
    phoneDirective = extractPhoneMessageDirective(ctx, cleanUserInput);
    if (phoneDirective) {
      phoneDirectiveSource = 'fallback-parser';
    }
  }
  if (isGenerationRunCancelled(ctx, generationToken)) {
    recordGenerationDebug(ctx, 'submit:cancelled-before-push', { requestGenerationId });
    return;
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

  applyLocalWorldHintsFromUserInput(ctx, cleanUserInput);

  // 生成前预判（preflight）：用在场判定那一发副 API 顺带判时间推进，结果只有 high 置信、且明确推进才采纳。
  // 这一步必须在 syncMainEvents 之前——把世界游标推进到正确日期后，syncMainEvents 才能当场激活对应事件，
  // 恢复“玩家明确跳到某天 → 本回合立刻触发事件”的手感；同时全程过统一时间门，杜绝旧正则被叙事多日期带偏。
  let scenePresence: ScenePresence | null = null;
  if (hasTavernGenerate) {
    const preflightHistory = state.uiMessages.slice(0, -1);
    scenePresence = await detectScenePresence(ctx, preflightHistory, cleanUserInput);
    if (isGenerationRunCancelled(ctx, generationToken)) {
      recordGenerationDebug(ctx, 'submit:cancelled-after-preflight', { requestGenerationId });
      return;
    }
    commitPreGenerationTimeProposal(ctx, scenePresence);
  }

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
    await simulateGeneration(ctx, cleanUserInput || userInput);
    if (isGenerationRunCancelled(ctx, generationToken)) {
      recordGenerationDebug(ctx, 'submit:cancelled-after-simulate', { requestGenerationId });
      return;
    }
    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    state.generating = false;
    if (phoneDirective) {
      await sendPhoneMessageFromDirective(ctx, phoneDirective, () => isGenerationRunCancelled(ctx, generationToken));
    } else {
      await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration, () =>
        isGenerationRunCancelled(ctx, generationToken),
      );
    }
    ctx.render();
    return;
  }

  let generationSucceeded = false;
  try {
    ensureStreamingMessage(ctx);
    ctx.render();

    // 流式占位助手消息已压入，正文 prompt 的历史要剔除它（preflight 用的是占位前的历史，二者一致）。
    const promptHistory = state.uiMessages.slice(0, -1);
    requestGenerationId = state.currentGenerationId;
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
                content: buildPrompt(state.statusData, promptHistory, cleanUserInput, ctx.summaryStore, {
                  playerProfile: state.playerProfile,
                  plotLibrary: state.plotLibrary,
                  characterCardLibrary: state.characterCardLibrary,
                  // 正文永不内嵌 <progress>：变量更新统一由 finally 的合并 progress 负责（配/不配副 API 都是）。
                  skipProgress: true,
                  suppressPhoneMessageContent: Boolean(phoneDirective),
                  phoneMessageTargetName: phoneDirective?.target.name,
                  suppressUserInputLine: true,
                  scenePresence,
                  memoryDB: ctx.memoryDB,
                  drawingSettings: state.drawingSettings,
                }),
              },
              {
                role: 'user',
                content: cleanUserInput,
              },
            ],
          }
        : {
            ...baseConfig,
            user_input: buildPrompt(state.statusData, promptHistory, cleanUserInput, ctx.summaryStore, {
              playerProfile: state.playerProfile,
              plotLibrary: state.plotLibrary,
              characterCardLibrary: state.characterCardLibrary,
              // 正文永不内嵌 <progress>：变量更新统一由 finally 的合并 progress 负责（配/不配副 API 都是）。
              skipProgress: true,
              suppressPhoneMessageContent: Boolean(phoneDirective),
              phoneMessageTargetName: phoneDirective?.target.name,
              scenePresence,
              memoryDB: ctx.memoryDB,
              drawingSettings: state.drawingSettings,
            }),
          },
    );

    recordGenerationDebug(ctx, 'submit:generate-returned', {
      requestGenerationId,
      resultLength: String(result ?? '').length,
    });
    if (isGenerationRunCancelled(ctx, generationToken)) {
      recordGenerationDebug(ctx, 'submit:cancelled-after-generate-returned', { requestGenerationId });
      return;
    }
    finalizeStreamingText(ctx, String(result ?? ''), requestGenerationId);

    // 变量更新（含手机消息提取）统一移到 finally：正文后发一次合并 progress，配/不配副 API 都走同一条路。
    // 不再依赖主 API 在正文里内嵌 <progress>（skipProgress 现恒为 true）。

    // 在最新助手消息上保存 statusData 快照，供回溯使用。
    const lastMsg = state.uiMessages[state.uiMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.statusSnapshot = createRollbackSnapshot(state);
      ctx.persistConversation();
    }
    queueDrawingPluginTasks(ctx, userInput);

    if (options.clearDraftOnSuccess) {
      state.draft = '';
    }
    generationSucceeded = true;
    state.generating = false;
    recordGenerationDebug(ctx, 'submit:main-success-before-phone', { requestGenerationId });
    // 手机消息/主动手机 与 变量更新 的顺序依赖统一在 finally 处理（progress → phone → summary）。
  } catch (error) {
    if (isGenerationRunCancelled(ctx, generationToken) || error instanceof SecondaryTaskCancelledError) {
      recordGenerationDebug(ctx, 'submit:catch-cancelled', {
        requestGenerationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
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
      queueDrawingPluginTasks(ctx, userInput);
      if (options.clearDraftOnSuccess) {
        state.draft = '';
      }
      generationSucceeded = true;
      state.generating = false;
      recordGenerationDebug(ctx, 'submit:catch-preserved-as-success');
      // 变量更新 + 手机消息统一在 finally 处理（progress → phone → summary）。
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
    if (drawingEnabledAtSubmit && !state.drawingSettings.enabled) {
      state.drawingSettings.enabled = true;
      recordGenerationDebug(ctx, 'drawing:restore-enabled-after-generation');
      ctx.persistConversation();
    }
    if (getGenerationCancelToken(ctx) === generationToken) {
      state.generating = false;
    }
    recordGenerationDebug(ctx, 'submit:finally-before-render', { generationSucceeded });
    ctx.render();

    // 正文结束后统一顺序执行：① 变量更新(含手机消息提取) → ② 消费手机消息 → ③ 总结历史。
    // 顺序是关键：合并版 progress 必须先于 maybeQueueProactivePhoneMessage 跑，才能填好
    // lastProgressPhoneMessages 供其消费——旧代码把 progress 放在 phone 之后，导致 phone 永远读到 null、
    // 退回独立的 phone-scene-extract 副 API，形成"正文 + 手机提取 + 含手机的progress"三发请求。
    if (
      generationSucceeded &&
      !isGenerationRunCancelled(ctx, generationToken) &&
      (typeof win.generateRaw === 'function' || typeof win.generate === 'function')
    ) {
      recordGenerationDebug(ctx, 'submit:summary-start');
      lastProgressPhoneMessages = null;

      // ① 变量更新：配/不配副 API 都走同一条合并 progress（无副 API 时 runSecondaryTask 回落主 API）。
      //    含 includePhoneMessages，结果里的 <phone_messages> 暂存到 lastProgressPhoneMessages。
      await runSecondaryProgressUpdate(
        ctx,
        `progress-after-text-${crypto.randomUUID()}`,
        buildProgressPrompt(state.statusData, getLatestCompletedTurnMessages(state.uiMessages), {
          includePhoneMessages: !phoneDirective,
        }),
        null,
        { scenePresence, isCancelled: () => isGenerationRunCancelled(ctx, generationToken) },
      );
      if (isGenerationRunCancelled(ctx, generationToken)) {
        recordGenerationDebug(ctx, 'submit:cancelled-after-progress', { requestGenerationId });
        return;
      }

      // ② 手机消息：directive 走专用聊天流；否则消费上一步暂存的 phone_messages（无则正则兜底）。
      if (phoneDirective) {
        await sendPhoneMessageFromDirective(ctx, phoneDirective, () => isGenerationRunCancelled(ctx, generationToken));
      } else {
        await maybeQueueProactivePhoneMessage(ctx, eventBeforeGeneration, () =>
          isGenerationRunCancelled(ctx, generationToken),
        );
      }
      if (isGenerationRunCancelled(ctx, generationToken)) {
        recordGenerationDebug(ctx, 'submit:cancelled-after-phone', { requestGenerationId });
        return;
      }

      // ③ 总结历史：按优先级单选触发（global > major > minor），不回写变量；没到阈值不触发。
      //    历史教训：旧设计让 minor 分支用小总结回写变量，但小总结读的是滞后历史块
      //    （lastSummarizedIndex+5），把几轮前的旧时间/旧事件写回权威状态（8月13日退回8月11日 /
      //    SAE_03-8 退回 SAE_03-6）。现在总结链路只压缩历史，变量永远由上面 ① 的最新回合 progress 负责。
      const postTurnMode = ctx.summaryApiConfig
        ? pickPostTurnBackgroundMode(ctx.summaryStore, countCompletedConversationMessages(state.uiMessages))
        : 'auto';
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
        memoryDB: ctx.memoryDB,
        getFactAnchor: () => buildFactAnchorFromStatus(ctx.state.statusData),
        isCancelled: () => isGenerationRunCancelled(ctx, generationToken),
      };
      if (postTurnMode === 'minor') {
        await runSummary(summaryCtx, 'minor').catch(() => null);
      } else if (ctx.summaryApiConfig && (postTurnMode === 'major' || postTurnMode === 'global')) {
        await runSummary(summaryCtx, postTurnMode).catch(() => {
          /* 摘要错误在内部处理 */
        });
      } else if (!ctx.summaryApiConfig) {
        await runSummary(summaryCtx).catch(() => {
          /* 摘要错误在内部处理 */
        });
      }
      recordGenerationDebug(ctx, 'submit:summary-finished');
    }
    if (drawingEnabledAtSubmit && !state.drawingSettings.enabled) {
      state.drawingSettings.enabled = true;
      recordGenerationDebug(ctx, 'drawing:restore-enabled-after-post-turn');
      ctx.persistConversation();
      ctx.render();
    }
  }
}

function getPhoneThreadTarget(ctx: ActionContext, targetId: string): TargetStatus | null {
  const target = getPhoneContactTargets(ctx).find(item => item.id === targetId) ?? null;
  return isPlayerPseudoTarget(target) ? null : target;
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

function isSayuriSearchTarget(target: TargetStatus) {
  const identityHaystack = [target.id, target.name, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').toLowerCase())
    .join('\n');
  return /泽村小百合|澤村小百合|小百合|sayuri/.test(identityHaystack);
}

function getPhoneTargetSearchTerms(target: TargetStatus) {
  const baseTerms = [target.id, target.name, target.alias, target.meta?.worldbookEntryName]
    .map(value => String(value ?? '').trim())
    .filter(Boolean);
  const haystack = baseTerms.join('\n').toLowerCase();
  const builtInTerms: string[] = [];

  if (isSayuriSearchTarget(target)) {
    builtInTerms.push(
      '泽村小百合',
      '澤村小百合',
      '小百合',
      '小百合太太',
      '泽村夫人',
      '澤村夫人',
      '英梨梨的妈妈',
      '英梨梨的母亲',
      '泽村伯母',
      '小百合小姐',
      'sayuri',
    );
  } else if (/英梨梨|泽村|澤村|eriri|sawamura/.test(haystack)) {
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
    getPhoneContactTargets(ctx).find(target =>
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

function scenePhoneMessageIsExplicitlyBoundToTarget(
  target: TargetStatus,
  sceneText: string,
  role: ScenePhoneMessage['role'],
) {
  if (isPlayerPseudoTarget(target)) return false;
  if (role === 'assistant') {
    return (
      sceneExplicitlyReceivedPhoneMessage(target, sceneText) ||
      sceneTextMentionsIncomingPhoneFromTarget(target, sceneText)
    );
  }
  return false;
}

function findScenePhoneMessage(ctx: ActionContext, text: string): ScenePhoneMessage | null {
  const target =
    getPhoneContactTargets(ctx).find(item => sceneExplicitlyReceivedPhoneMessage(item, text)) ??
    getPhoneContactTargets(ctx).find(item => sceneTextMentionsIncomingPhoneFromTarget(item, text)) ??
    null;
  const messageText = extractScenePhoneMessageText(text);
  return target && messageText ? { target, role: 'assistant', text: messageText } : null;
}

function buildPhoneActionDetectorPrompts(ctx: ActionContext, userInput: string): RawPrompt[] {
  const cleanUserInput = sanitizePromptInputText(userInput);
  const contacts = getPhoneContactTargets(ctx)
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
      content: `玩家输入：${cleanUserInput}`,
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

function commitPhoneDirectiveAnalysis(
  ctx: ActionContext,
  raw: string,
  userInput: string,
): { directive: PhoneDirective | null } {
  return {
    directive: parsePhoneActionDetectorResult(ctx, raw, userInput),
  };
}

async function generateSilentAnalysis(
  ctx: ActionContext,
  generationId: string,
  prompts: RawPrompt[],
  kind: Extract<SecondaryTaskKind, 'phone-directive-detect' | 'scene-presence' | 'phone-scene-extract'>,
): Promise<string> {
  return runSecondaryTask({
    win: ctx.win,
    kind,
    generationId,
    prompts,
    apiConfig: ctx.summaryApiConfig,
  }).catch(() => '');
}

function countCompletedConversationMessages(messages: UiMessage[]): number {
  return messages.filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .length;
}

function pickPostTurnBackgroundMode(
  summaryStore: SummaryStore,
  messageCount: number,
): 'progress' | 'minor' | 'major' | 'global' {
  if (shouldRunGlobalCompression(summaryStore)) return 'global';
  if (shouldRunMajorSummary(summaryStore)) return 'major';
  if (shouldRunMinorSummary(summaryStore, messageCount)) return 'minor';
  return 'progress';
}

function normalizeScenePresenceIds(ids: unknown, allowedIds: Set<string>) {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.map(id => String(id ?? '').trim()).filter(id => allowedIds.has(id))));
}

function buildScenePresencePrompts(ctx: ActionContext, promptHistory: UiMessage[], userInput: string): RawPrompt[] {
  const cleanUserInput = sanitizePromptInputText(userInput);
  const recentVisible = promptHistory
    .filter(message => !message.streaming && (message.role === 'user' || message.role === 'assistant'))
    .slice(-4)
    .map(message => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const text = getPromptMessageText(message);
      return `[${role}] ${text}`;
    })
    .filter(line => line.trim() !== '[assistant]' && line.trim() !== '[user]')
    .join('\n\n');

  const targets = ctx.state.statusData.targets
    .map(target => {
      const aliases = getPhoneTargetSearchTerms(target)
        .filter(term => term !== target.id && term !== target.name)
        .join('、');
      const charClass = getCharacterCanonicalClass(target);
      const relation = getCharacterRelationToTomoya(target);
      return `- id=${target.id}；姓名=${target.name}${target.alias ? `；别名=${target.alias}` : ''}${
        aliases ? `；可匹配线索=${aliases}` : ''
      }${charClass ? `；班级=${charClass}` : ''}${relation ? `；原作关系=${relation}` : ''}`;
    })
    .join('\n');

  const playerClass = String(ctx.state.playerProfile?.className ?? '').trim();

  const systemPrompt = [
    '现在需要对目前的场景进行预判：① 哪些角色处于当前镜头内；② 玩家这一步是否明确推进了世界时间。',
    '只做判定，不续写剧情，不扮演角色，不输出思考过程。',
    '',
    '角色名单：',
    targets || '无',
    '',
    `玩家(user)班级：${playerClass || '未知'}`,
    '',
    `当前世界时间（时间锚点）：${ctx.state.statusData.world.currentTime}`,
    '',
    '判定定义（在场）：',
    '- present：角色明确处于当前镜头内，能立刻说话、行动、沉默、吃醋或产生即时反应。',
    '- focus：玩家当前输入正在追上、寻找、靠近、转向或当面处理该角色；下一轮正文允许转场到她。',
    '- absent：角色已明确离开、不在场、没来、无法即时反应。',
    '- uncertain：只是被提到、回忆、议论或出现在旧信息里，不能证明当前在镜头内。',
    '',
    '判定定义（时间推进 timeProposal）：',
    '- 只有当玩家输入或其叙述明确把场景【推进/跳转】到某个新日期或新时段时，才输出 timeProposal。',
    '- 触发词例：跳到/快进到/来到/到了/隔天/翌日/次日/第二天/第二天早上/当天夜里转入次日 等明确推进。',
    '- 「隔天/第二天/次日」必须以上面的“当前世界时间”为锚点 +1 天推算出具体日期。',
    '- 多个日期同时出现时（例如同时提到某个 party 日期和实际推进到的日期），只取【玩家实际把场景推进到】的那个目标日期；',
    '  被提及的 party 日期、计划日期、回忆日期、别人生日等一律【不是】目标，不要被先出现的日期带偏。',
    '- 倒叙/闪回/回忆/做梦【不改世界游标】：这类内容不要输出 timeProposal。',
    '- 纯粹提到时间词但没有真正跨日/跨时段（如对话里说“都傍晚了”而场景没推进），不输出。',
    '- time 必须是完整 `YYYY-MM-DD HH:mm`（HH:mm 按剧情合理给，缺信息给该时段的代表时刻）。',
    '- confidence：目标日期/时段非常明确取 "high"；含糊、需要猜测、多日期无法确定目标时取 "low"。只有 high 会被系统采纳。',
    '- 没有任何明确时间推进时，省略 timeProposal 或给 null。',
    '',
    '硬规则：',
    '1. 只能使用角色名单里的 id。',
    '2. 第一次输入若没有最近正文，只看玩家当前输入；没有明确点名/寻找/靠近任何角色时，present 和 focus 都为空。',
    '3. 不要因为角色好感度、剧情常识、世界书设定或你觉得她应该在场而加入 present。',
    '4. 玩家当前输入若明确“追上去安慰她/去找某人/转向某人/和某人说话”，该角色进入 focus。',
    '5. 输出必须是一个 JSON 对象，不要使用 Markdown 代码块。',
    '6. 班级消歧：玩家输入若用班级/学年指人（如“去G班”“找同班同学”“B班那个”），用上面的“玩家班级”和角色“班级”做匹配——同字符串=同班；只有班级里的角色才算同班。仅“同班/同年级”这类泛指、又能唯一对应到名单里某个角色时，才把该角色判为 focus；对应不唯一就不要硬塞。',
    '7. 原作关系只锚定到“安艺伦也”：名单里的“原作关系”（青梅竹马/学姐/表姐等）描述的是该角色与伦也的关系，不是与 user 的关系。不要因为这些原作关系就默认该角色与 user 亲近、在场或应进入 focus；user 与角色的关系以实际剧情与好感度为准。',
  ].join('\n');

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        '最近4条可见正文：',
        recentVisible || '（无）',
        '',
        `玩家当前输入：${cleanUserInput || '（无）'}`,
        '',
        '请输出 JSON，格式如下（无时间推进时省略 timeProposal 或置 null）：',
        '{"present":["角色id"],"focus":["角色id"],"absent":["角色id"],"uncertain":["角色id"],"evidence":{"角色id":"一句话依据"},"timeProposal":{"time":"YYYY-MM-DD HH:mm","confidence":"high|low","source":"explicit_player_transition|narrative_transition|none","reason":"一句话依据"}}',
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
      timeProposal: parseTimeProposal(parsed.timeProposal),
    };
  } catch (error) {
    console.warn('[scene-presence] parse failed:', error);
    return fallback;
  }
}

/** 解析 preflight 的 timeProposal；只接受带完整日期的对象，其余（null/缺字段/格式不符）一律丢弃返回 undefined。 */
function parseTimeProposal(raw: unknown): ScenePresence['timeProposal'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const time = String(obj.time ?? '').trim();
  // 至少要有 YYYY-MM-DD 才算有效建议；没有日期的（仅时段）不在 preflight 处理，留给生成后 progress。
  if (!/\d{4}-\d{2}-\d{2}/.test(time)) return undefined;
  const confidence = String(obj.confidence ?? '').trim().toLowerCase() === 'high' ? 'high' : 'low';
  return {
    time,
    confidence,
    source: String(obj.source ?? '').trim() || 'unknown',
    reason: String(obj.reason ?? '').trim(),
  };
}

function commitScenePresenceAnalysis(ctx: ActionContext, raw: string): { presence: ScenePresence } {
  return {
    presence: parseScenePresenceResult(ctx, raw),
  };
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
  const rawResult = await generateSilentAnalysis(
    ctx,
    generationId,
    buildScenePresencePrompts(ctx, promptHistory, userInput),
    'scene-presence',
  );
  const committed = commitScenePresenceAnalysis(ctx, rawResult);
  const { presence } = committed;
  recordGenerationDebug(ctx, 'scene-presence:detected', {
    generationId,
    rawLength: String(rawResult ?? '').length,
    presentIds: presence.presentIds,
    focusIds: presence.focusIds,
    absentIds: presence.absentIds,
    uncertainIds: presence.uncertainIds,
  });
  return presence;
}

// preflight 时间建议的统一提交：只收 high 置信的明确推进，过统一时间门（normalize + 单调闸），
// 真正前进了才落库 + 记 debug。low 置信、缺失、被单调闸挡回都不写——剩下交给生成后的 progress 兜底。
function commitPreGenerationTimeProposal(ctx: ActionContext, presence: ScenePresence | null): void {
  const proposal = presence?.timeProposal;
  if (!proposal || proposal.confidence !== 'high' || !proposal.time) return;

  const before = ctx.state.statusData.world.currentTime;
  const { changed, time } = commitWorldTimeCandidate(ctx.state.statusData, proposal.time);
  if (!changed) {
    recordGenerationDebug(ctx, 'submit:preflight-time-rejected', {
      proposed: proposal.time,
      current: before,
      source: proposal.source,
      reason: proposal.reason,
    });
    return;
  }
  ctx.adapter.save(ctx.state.statusData);
  recordGenerationDebug(ctx, 'submit:preflight-time-committed', {
    from: before,
    to: time,
    source: proposal.source,
    reason: proposal.reason,
  });
}

async function runSecondaryProgressUpdate(
  ctx: ActionContext,
  generationId: string,
  prompts: RawPrompt[],
  targetId?: string | null,
  options: { showTask?: boolean; scenePresence?: ScenePresence | null; isCancelled?: () => boolean } = {},
): Promise<boolean> {
  const showTask = options.showTask ?? true;
  if (options.isCancelled?.()) return false;
  if (showTask) {
    setBackgroundTaskRunning(ctx.state, 'progress');
    ctx.render();
  }
  try {
    const raw = await runSecondaryTask({
      win: ctx.win,
      kind: targetId ? 'phone-progress' : 'progress',
      generationId,
      prompts,
      apiConfig: ctx.summaryApiConfig,
      isCancelled: options.isCancelled,
    });
    if (options.isCancelled?.()) {
      if (showTask) clearBackgroundTask(ctx.state, 'progress');
      return false;
    }
    const committed = commitProgressAnalysis(ctx, raw, targetId, options.scenePresence);
    if (showTask) clearBackgroundTask(ctx.state, 'progress');
    if (committed.applied) {
      // 成功路径也要重渲染：否则徽章在 state 里清了、变量也更新了，但 UI 不刷新，
      // 一直卡在"变量更新中"直到玩家点手机触发别的渲染路径。
      if (showTask) ctx.render();
      return true;
    }
  } catch (error) {
    if (error instanceof SecondaryTaskCancelledError || options.isCancelled?.()) {
      if (showTask) clearBackgroundTask(ctx.state, 'progress');
      return false;
    }
    console.warn('[progress] secondary analysis failed:', error);
    if (showTask) setBackgroundTaskFailed(ctx.state, 'progress', error);
  }
  if (showTask) ctx.render();
  return false;
}

function commitProgressAnalysis(
  ctx: ActionContext,
  raw: string,
  targetId?: string | null,
  scenePresence?: ScenePresence | null,
): { applied: boolean; update: ProgressUpdate | null } {
  // 主回合 progress 现在合并了 phone_messages 提取；如果 raw 里带 <phone_messages> 块，
  // 解析并暂存，由 maybeQueueProactivePhoneMessage 接力消费、跳过原本 phone-scene-extract 副 API。
  if (!targetId) {
    const latestSceneText = getLatestAssistantSceneText(ctx);
    if (latestSceneText) {
      const phoneMessages = parseScenePhoneMessageExtractorResult(ctx, raw, latestSceneText);
      lastProgressPhoneMessages = phoneMessages.length ? phoneMessages : null;
    }
  }

  const update = parseProgressUpdate(raw);
  if (!update) return { applied: false, update: null };
  applyFullProgressUpdate(ctx, update, targetId, scenePresence);
  return { applied: true, update };
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
  const rawResult = await generateSilentAnalysis(ctx, generationId, prompts, 'phone-directive-detect');

  const committed = commitPhoneDirectiveAnalysis(ctx, rawResult, userInput);
  const { directive } = committed;
  debugPhoneFlow(ctx, directive ? 'directive-llm:matched' : 'directive-llm:no-match', {
    generationId,
    rawLength: String(rawResult ?? '').length,
    targetId: directive?.target.id ?? null,
    textLength: directive?.text.length ?? 0,
  });
  return directive;
}

function parseScenePhoneMessageExtractorResult(
  ctx: ActionContext,
  rawResult: string,
  sceneText: string,
): ScenePhoneMessage[] {
  const tagged = extractTaggedReply(rawResult, 'phone_messages', false);
  const rawFallback = /^target_id[:：]/im.test(rawResult) && /^message[:：]/im.test(rawResult) ? rawResult : '';
  const sourceText = (tagged || rawFallback).trim();
  if (!sourceText) return [];

  return sourceText
    .split(/\n\s*---\s*\n/g)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const direction =
        block
          .match(/^direction[:：]\s*(.+)$/im)?.[1]
          ?.trim()
          .toLowerCase() ?? '';
      if (direction !== 'incoming') {
        debugPhoneFlow(ctx, 'scene-extract:drop-outgoing', { direction });
        return null;
      }
      const targetHint = block.match(/^target_id[:：]\s*(.+)$/im)?.[1]?.trim() ?? '';
      const message = stripDirectiveQuotes(
        block.match(/^message[:：]\s*([\s\S]*?)(?=\n(?:direction|target_id|message)[:：]|\s*$)/im)?.[1] ?? '',
      );
      const role: ScenePhoneMessage['role'] = 'assistant';
      if (isMissingPhoneTargetHint(targetHint) || !role || !message) return null;

      const target = getPhoneThreadTarget(ctx, targetHint) ?? findPhoneDirectiveTarget(ctx, targetHint);
      if (!target) {
        debugPhoneFlow(ctx, 'scene-extract:drop-non-id-target', { targetHint, direction });
        return null;
      }
      if (!scenePhoneMessageIsExplicitlyBoundToTarget(target, sceneText, role)) {
        debugPhoneFlow(ctx, 'scene-extract:drop-unbound-target', {
          targetId: target.id,
          targetHint,
          direction,
        });
        return null;
      }

      return { target, role, text: message } satisfies ScenePhoneMessage;
    })
    .filter((item): item is ScenePhoneMessage => Boolean(item));
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
  const [name, description] =
    Object.entries(ctx.state.statusData.world.recentEvents).find(
      ([eventName, eventDescription]) => eventName !== '初始记录' && String(eventDescription ?? '').trim(),
    ) ?? [];
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

function getCurrentReaderFloorIndex(ctx: ActionContext) {
  const readerMessages = getReaderMessages(ctx.state.uiMessages);
  return clamp(ctx.state.focusedMessageIndex, 0, Math.max(readerMessages.length - 1, 0));
}

function appendAssistantPhoneMessage(
  ctx: ActionContext,
  target: TargetStatus,
  thread: ReturnType<typeof ensurePhoneThread>,
  text: string,
  source: 'phone-directive' | 'phone-scene-extract' = 'phone-directive',
) {
  const { state } = ctx;
  const assistantMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    speaker: target.alias ?? target.name,
    text,
    timestamp: formatTime(state.statusData.world.currentTime),
    floorIndex: getCurrentReaderFloorIndex(ctx),
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, assistantMessage];
  thread.updatedAt = Date.now();
  if (!(state.phoneOpen && state.phoneRoute === 'app:chat' && state.phoneMessages.activeThreadId === target.id)) {
    thread.unread += 1;
  }
  indexPhoneMessage(ctx.memoryDB, assistantMessage, target.id, source);
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
  source: 'phone-directive' | 'phone-scene-extract' = 'phone-directive',
) {
  const { state } = ctx;
  const userMessage: PhoneChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    speaker: state.playerProfile.name.trim() || '我',
    text,
    timestamp: formatTime(state.statusData.world.currentTime),
    floorIndex: getCurrentReaderFloorIndex(ctx),
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  indexPhoneMessage(ctx.memoryDB, userMessage, target.id, source);
  ctx.persistConversation();
}

function appendExtractedScenePhoneMessage(ctx: ActionContext, item: ScenePhoneMessage) {
  if (item.role !== 'assistant' || isPlayerPseudoTarget(item.target)) {
    debugPhoneFlow(ctx, 'scene-extract:drop-non-incoming-or-player-target', {
      targetId: item.target.id,
      role: item.role,
    });
    return false;
  }
  const thread = ensurePhoneThread(ctx, item.target);
  const lastMessage = thread.messages[thread.messages.length - 1];
  if (lastMessage?.role === item.role && lastMessage.text.trim() === item.text.trim()) return false;

  appendAssistantPhoneMessage(ctx, item.target, thread, item.text.trim(), 'phone-scene-extract');
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

async function maybeQueueProactivePhoneMessage(
  ctx: ActionContext,
  previousEventKey?: string | null,
  isCancelled?: () => boolean,
) {
  if (isCancelled?.()) return;
  const { state, win } = ctx;
  const latestEvent = getLatestRecentEvent(ctx);
  const latestSceneText = getLatestAssistantSceneText(ctx);
  const hasTavernGenerate = typeof win.generateRaw === 'function' || typeof win.generate === 'function';

  // 手机消息提取统一由合并版 progress（buildProgressPrompt includePhoneMessages）一并完成，
  // 结果暂存在 lastProgressPhoneMessages，这里消费即可。已删除独立的 phone-scene-extract 副 API。
  // 消费不到时（如 dev/mock 路径无 progress），退回正则兜底 findScenePhoneMessage。
  const prefilled = lastProgressPhoneMessages;
  lastProgressPhoneMessages = null;

  let extractedMessages: ScenePhoneMessage[] = [];
  if (prefilled && prefilled.length) {
    extractedMessages = prefilled;
    debugPhoneFlow(ctx, 'scene-extract:reuse-from-progress', { count: prefilled.length });
  }
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
    getPhoneContactTargets(ctx).find(candidate => isExplicitPhoneTargetMention(candidate, latestEvent.text)) ?? null;
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
    characterCardLibrary: state.characterCardLibrary,
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
    if (isCancelled?.()) return;
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
    if (isCancelled?.() || e instanceof SecondaryTaskCancelledError) return;
    console.warn('[phone-proactive] generation failed:', e);
  }
}

async function sendPhoneMessageFromDirective(
  ctx: ActionContext,
  directive: PhoneDirective,
  isCancelled?: () => boolean,
) {
  if (isCancelled?.()) return;
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
    floorIndex: getCurrentReaderFloorIndex(ctx),
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  state.phoneMessages.activeThreadId = target.id;
  state.phoneMessages.generating = true;
  indexPhoneMessage(ctx.memoryDB, userMessage, target.id, 'phone-directive');
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
        characterCardLibrary: state.characterCardLibrary,
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
    if (isCancelled?.()) {
      throw new SecondaryTaskCancelledError('phone-directive-detect', String(state.currentGenerationId || target.id));
    }

    const replyText = extractPhoneChatReply(rawResult) || '……';
    const assistantMessage: PhoneChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      speaker: target.alias ?? target.name,
      text: replyText,
      timestamp: formatTime(state.statusData.world.currentTime),
      floorIndex: getCurrentReaderFloorIndex(ctx),
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
      isCancelled ? { isCancelled } : undefined,
    );
    if (isCancelled?.()) {
      throw new SecondaryTaskCancelledError('phone-progress', String(state.currentGenerationId || target.id));
    }

    assistantMessage.statusSnapshot = createRollbackSnapshot(state);
    if (!(state.phoneOpen && state.phoneRoute === 'app:chat' && state.phoneMessages.activeThreadId === target.id)) {
      thread.unread += 1;
    }
    indexPhoneMessage(ctx.memoryDB, assistantMessage, target.id, 'phone-directive');
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
    if (error instanceof SecondaryTaskCancelledError || isCancelled?.()) return;
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
    floorIndex: getCurrentReaderFloorIndex(ctx),
    statusSnapshot: createRollbackSnapshot(state),
  };

  thread.messages = [...thread.messages, userMessage];
  thread.updatedAt = Date.now();
  thread.unread = 0;
  state.phoneMessages.draft = '';
  state.phoneMessages.generating = true;
  state.phoneMessages.activeThreadId = target.id;
  indexPhoneMessage(ctx.memoryDB, userMessage, target.id, 'phone-directive');
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
        characterCardLibrary: state.characterCardLibrary,
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
      floorIndex: getCurrentReaderFloorIndex(ctx),
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
    indexPhoneMessage(ctx.memoryDB, assistantMessage, target.id, 'phone-directive');
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
