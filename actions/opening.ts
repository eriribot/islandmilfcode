import { buildPrompt, extractCompleteVisibleReply } from '../message-format';
import {
  inspectCommittedShujukuBinding,
  restoreShujukuTablesForHandoff,
  runShujukuVirtualTurn,
} from '../shujuku/adapter';
import { hydrateArchiveMessages } from '../state/archive-repository';
import { buildShujukuVirtualTimeline } from '../shujuku/virtual-timeline';
import { createRollbackSnapshot } from '../state/store';
import type { SummaryStore } from '../summary/types';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { AppState } from '../types';
import { formatTime } from '../variables/normalize';
import {
  buildIslandBodyContextFromPlanning,
  buildIslandPlanningIdentityPayload,
  buildShujukuPlanningDisplaySnapshot,
  ISLAND_PLANNING_CONTEXT_PLUGIN_KEY,
  SHUJUKU_PLANNING_DISPLAY_PLUGIN_KEY,
} from '../shujukuinject';
import {
  discardStreamingMessage,
  ensureStreamingMessage,
  finalizeStreamingText,
  recordGenerationDebug,
  type StreamingContext,
} from './streaming';

type OpeningActionContext = StreamingContext & {
  summaryStore: SummaryStore;
  readonly memoryDB: IslandMemoryDB;
  clearNotification: (shouldRender: boolean) => void;
  persistConversationImmediately?: () => Promise<void>;
};

const OPENING_USER_INPUT =
  '新建角色后的 AI 自动开场生成请求。这里没有玩家角色的主动发言、指令或行动；请只根据已经创建好的玩家档案与当前世界状态生成第一幕开场正文。';

function buildOpeningPresetInput(state: AppState, ctx: Pick<OpeningActionContext, 'summaryStore' | 'memoryDB'>) {
  const shujukuBinding = inspectCommittedShujukuBinding(state.runtimeFlags, {
    saveId: state.activeSaveId,
    runId: state.activeRunId,
  });
  const promptHistory = state.uiMessages[state.uiMessages.length - 1]?.streaming
    ? state.uiMessages.slice(0, -1)
    : state.uiMessages;
  const basePrompt = buildPrompt(state.statusData, promptHistory, OPENING_USER_INPUT, ctx.summaryStore, {
    playerProfile: state.playerProfile,
    plotLibrary: state.plotLibrary,
    characterCardLibrary: state.characterCardLibrary,
    skipProgress: true,
    suppressUserInputLine: true,
    memoryDB: ctx.memoryDB,
    drawingSettings: state.drawingSettings,
    narrativeRoute: shujukuBinding.kind === 'active' ? 'shujuku' : 'island',
    messageStartIndex: state.messageWindow.startMessage,
  });

  const openingContract = [
    '你正在执行“新建角色后的 AI 自动开场生成”。这是系统级开场请求，不是玩家角色在剧情中的发言。',
    '',
    '任务：根据当前玩家档案、班级、背景经历、初始世界状态、剧情卡、角色卡和关系指导，生成游戏第一幕开场正文。',
    '',
    '必须做到：',
    '- 只写自然的开场剧情，不要提到“帮我生成开场白”“按钮”“系统”“玩家请求”等元信息。',
    '- 玩家角色已经存在于世界中，但本回合没有主动说话或行动；不要替玩家做重大决定。',
    '- 开场要把玩家放入一个可继续互动的具体场景，结尾留下明确可接话的位置。',
    '- 可以描写时间、地点、环境、在场角色的自然反应。',
    '- 可见正文必须放在 <content>...</content> 中。',
    '',
    '禁止：',
    '- 不要结算好感度、执念度、亲密计数、物品、数值或时间推进。',
    '- 不要生成手机聊天内容。',
    '- 不要输出 <progress>、规划、分析、解释、摘要或调试文本。',
  ].join('\n');

  return `${openingContract}\n\n${basePrompt}`;
}

export async function generateOpeningScene(ctx: OpeningActionContext) {
  const { state, win } = ctx;
  if (state.generating) return false;
  state.generating = true;
  state.openingGenerationError = null;
  state.currentGenerationId = `opening-${crypto.randomUUID()}`;
  state.finalizedGenerationId = '';
  state.focusedMessagePage = 0;
  const generationId = state.currentGenerationId;
  const openingRunId = state.activeRunId;
  const openingSaveId = state.activeSaveId;
  let ownsOpeningState = true;
  const isSameRunIdentity = () =>
    state.activeRunId === openingRunId && state.activeSaveId === openingSaveId;
  const isCurrentOpening = () =>
    isSameRunIdentity()
    && (state.currentGenerationId === generationId || state.finalizedGenerationId === generationId);
  const abandonIfStale = () => {
    if (isCurrentOpening()) return false;
    ownsOpeningState = false;
    return true;
  };
  const hasPresetGenerate = typeof win.generate === 'function';
  const hasRawGenerate = typeof win.generateRaw === 'function';
  const shujukuBinding = inspectCommittedShujukuBinding(state.runtimeFlags, {
    saveId: state.activeSaveId,
    runId: state.activeRunId,
  });
  const rawCompatibility = state.runtimeFlags.shujukuCompatibility;
  const shujukuRequested = Boolean(
    rawCompatibility
    && typeof rawCompatibility === 'object'
    && !Array.isArray(rawCompatibility)
    && (rawCompatibility as Record<string, unknown>).route === 'shujuku',
  );
  const narrativeRoute = shujukuBinding.kind === 'active'
    ? 'shujuku'
    : shujukuRequested
      ? 'blocked'
      : 'island';

  ctx.clearNotification(false);
  recordGenerationDebug(ctx, 'opening:start', {
    generationId,
    hasPresetGenerate,
    hasRawGenerate,
    route: narrativeRoute,
    playerName: state.playerProfile.name,
    className: state.playerProfile.className ?? '',
    backgroundCount: state.playerProfile.backgrounds?.length ?? 0,
  });

  try {
    const streamingMessage = ensureStreamingMessage(ctx);
    const openingAssistantMessageId = streamingMessage.id;
    ctx.render();

    if (narrativeRoute === 'blocked') {
      throw new Error(
        shujukuBinding.kind === 'invalid'
          ? `shujuku 路线需要复核：${shujukuBinding.reason}`
          : 'shujuku 路线需要复核：当前 handoff 尚未完成。',
      );
    }
    if (narrativeRoute === 'island' && !hasPresetGenerate) {
      throw new Error('真实 AI 开场生成接口不可用。');
    }
    const userInput = buildOpeningPresetInput(state, ctx);
    let rawResult = '';
    let shujukuTurnResult: Awaited<ReturnType<typeof runShujukuVirtualTurn>> | null = null;
    if (narrativeRoute === 'shujuku') {
      if (shujukuBinding.kind !== 'active') throw new Error('shujuku handoff 已失效；开场未发送。');
      const sourceIsolationKey = shujukuBinding.binding.compatibility.isolationKey?.trim();
      if (!sourceIsolationKey) throw new Error('shujuku handoff 缺少稳定 isolationKey；开场未发送。');
      const tableRestore = await restoreShujukuTablesForHandoff(
        win,
        sourceIsolationKey,
        shujukuBinding.binding.tableSnapshot,
      );
      if (abandonIfStale()) return false;
      const promptHistory = state.uiMessages.filter(message =>
        (message.role === 'user' || message.role === 'assistant') && !message.streaming,
      );
      const planningIdentity = buildIslandPlanningIdentityPayload(
        state.playerProfile,
        state.statusData.world.currentTime,
      );
      const openingUserId = `opening-user:${generationId}`;
      const openingExchangeId = `opening-exchange:${generationId}`;
      const openingUser = {
        id: openingUserId,
        role: 'user',
        speaker: state.playerProfile.name || '用户',
        text: OPENING_USER_INPUT,
        exchangeId: openingExchangeId,
        pluginData: {
          [ISLAND_PLANNING_CONTEXT_PLUGIN_KEY]: planningIdentity,
        },
      } as const;
      const archiveMessages = openingSaveId ? await hydrateArchiveMessages(openingSaveId) : [];
      if (abandonIfStale()) return false;
      const virtualTimeline = buildShujukuVirtualTimeline({
        archiveMessages,
        runtimeMessages: [...promptHistory, openingUser],
        promptMessages: promptHistory,
        currentUserId: openingUserId,
      });
      const currentVirtualUser = virtualTimeline.messages.at(-1);
      if (
        !currentVirtualUser
        || currentVirtualUser.current !== true
        || typeof currentVirtualUser.exchangeId !== 'string'
        || !Number.isInteger(currentVirtualUser.floorIndex)
      ) {
        throw new Error('shujuku 开场完整虚拟时间线缺少当前 user 身份。');
      }
      shujukuTurnResult = await runShujukuVirtualTurn(win, {
        rootMessage: virtualTimeline.rootMessage,
        messages: virtualTimeline.messages,
        promptMessages: virtualTimeline.promptMessages,
        assistantTarget: {
          logicalId: openingAssistantMessageId,
          exchangeId: currentVirtualUser.exchangeId,
          floorIndex: currentVirtualUser.floorIndex as number,
          name: '助手',
        },
        userInput: OPENING_USER_INPUT,
        systemPrompt: userInput,
        generationId,
        mode: 'opening',
        isolationKeyHandoff: {
          sourceIsolationKey,
          targetIsolationKey: tableRestore.resolvedIsolationKey,
        },
      }, {
        onPlanningReady: async progress => {
          if (abandonIfStale()) throw new Error('shujuku 开场规划投影已失效。');
          const openingMessage = state.uiMessages.find(message => message.id === openingAssistantMessageId);
          if (!openingMessage || openingMessage.role !== 'assistant' || !openingMessage.streaming) {
            throw new Error('shujuku 开场规划无法写回当前开场页。');
          }
          openingMessage.plannedText = progress.plannedText;
          openingMessage.pluginData = {
            ...(openingMessage.pluginData ?? {}),
            ...(progress.userPluginData ?? {}),
            [SHUJUKU_PLANNING_DISPLAY_PLUGIN_KEY]: buildShujukuPlanningDisplaySnapshot(
              progress.plannedText,
              state.runtimeFlags.shujukuTableSnapshot ?? null,
            ),
          };
          const bodyContext = buildIslandBodyContextFromPlanning({
            plannedText: progress.plannedText,
            statusData: state.statusData,
            playerProfile: state.playerProfile,
            plotLibrary: state.plotLibrary,
            characterCardLibrary: state.characterCardLibrary,
          });
          if (!bodyContext.content.trim()) throw new Error('shujuku 开场规划没有形成正文上下文。');
          ctx.persistConversation();
          await ctx.persistConversationImmediately?.();
          ctx.render();
          recordGenerationDebug(ctx, 'shujuku:opening-planning-projected', {
            generationId,
            bodyContextVersion: bodyContext.version,
            bodyContextLength: bodyContext.content.length,
          });
          return {
            bodyContext: bodyContext.content,
            projectionCommitted: true,
          };
        },
      });
      if (!shujukuTurnResult.planningObserved || !shujukuTurnResult.databaseCommitted) {
        throw new Error('shujuku 开场规划或数据库提交未完成。');
      }
      rawResult = shujukuTurnResult.rawText;
      recordGenerationDebug(ctx, 'shujuku:opening-virtual-turn', {
        generationId,
        planning: shujukuTurnResult.planningObserved ? 'observed' : 'missing',
        tableCommit: shujukuTurnResult.databaseCommitted ? 'committed' : 'missing',
        diagnostics: shujukuTurnResult.diagnostics,
      });
    } else {
      // Opening generation enters Tavern's preset stack on the Island route.
      const result = await win.generate!({
        should_stream: true,
        should_silence: true,
        generation_id: generationId,
        user_input: userInput,
      });
      rawResult = String(result ?? '');
    }

    if (abandonIfStale()) return false;
    recordGenerationDebug(ctx, 'opening:generate-returned', {
      generationId,
      resultLength: rawResult.length,
    });
    const completeSceneText = extractCompleteVisibleReply(rawResult).trim();
    if (!completeSceneText) {
      throw new Error('开场未返回完整且非空的可见正文标签。');
    }
    state.currentGenerationId = generationId;
    state.finalizedGenerationId = '';
    finalizeStreamingText(ctx, rawResult, generationId, { deferCommit: true });
    const provisionalAssistant = state.uiMessages.find(message => message.id === openingAssistantMessageId);
    if (
      !provisionalAssistant
      || provisionalAssistant.role !== 'assistant'
      || !provisionalAssistant.streaming
      || provisionalAssistant.text.trim() !== completeSceneText
    ) {
      throw new Error('开场待提交楼层与完整可见正文标签不一致。');
    }
    finalizeStreamingText(ctx, rawResult, generationId);
    if (shujukuTurnResult) {
      if (shujukuTurnResult.assistantPluginData) {
        provisionalAssistant.pluginData = {
          ...(provisionalAssistant.pluginData ?? {}),
          ...shujukuTurnResult.assistantPluginData,
        };
      }
      if (shujukuTurnResult.tableSnapshot) {
        state.runtimeFlags.shujukuTableSnapshot = shujukuTurnResult.tableSnapshot;
        const compatibility = state.runtimeFlags.shujukuCompatibility;
        if (compatibility && typeof compatibility === 'object' && !Array.isArray(compatibility)) {
          state.runtimeFlags.shujukuCompatibility = {
            ...(compatibility as Record<string, unknown>),
            lastTableHash: shujukuTurnResult.tableSnapshot.tableHash,
            lastCheckedAt: new Date().toISOString(),
          };
        }
      }
    }
    provisionalAssistant.statusSnapshot = createRollbackSnapshot(state);
    ctx.persistConversation();
    state.openingGenerationError = null;
    recordGenerationDebug(ctx, 'opening:success', {
      generationId,
      storage: 'iframe-v3-archive',
    });
    return true;
  } catch (error) {
    if (!isSameRunIdentity()) {
      ownsOpeningState = false;
      return false;
    }
    recordGenerationDebug(ctx, 'opening:catch', {
      generationId,
      error: error instanceof Error ? error.message : String(error),
    });
    discardStreamingMessage(ctx);
    state.openingGenerationError =
      (error instanceof Error ? error.message : String(error ?? '')).trim() || '开场生成失败，请重新试一次。';
    ctx.showNotification({
      kind: 'status',
      title: 'AI 开场生成失败',
      preview: state.openingGenerationError,
      targetTab: 'summary',
      timestamp: formatTime(state.statusData.world.currentTime),
    });
    return false;
  } finally {
    const canFinalizeOpeningState =
      ownsOpeningState
      && isSameRunIdentity()
      && (!state.currentGenerationId || state.currentGenerationId === generationId)
      && (!state.finalizedGenerationId || state.finalizedGenerationId === generationId);
    if (canFinalizeOpeningState) {
      if (state.currentGenerationId === generationId) {
        state.currentGenerationId = '';
      }
      state.generating = false;
      ctx.render();
    }
  }
}
