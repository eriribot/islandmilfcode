import { buildPrompt, extractCompleteVisibleReply } from '../message-format';
import { createRollbackSnapshot } from '../state/store';
import type { SummaryStore } from '../summary/types';
import type { IslandMemoryDB } from '../memorydatabase/types';
import type { AppState } from '../types';
import { formatTime } from '../variables/normalize';
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
};

const OPENING_USER_INPUT =
  '新建角色后的 AI 自动开场生成请求。这里没有玩家角色的主动发言、指令或行动；请只根据已经创建好的玩家档案与当前世界状态生成第一幕开场正文。';

function buildOpeningPresetInput(state: AppState, ctx: Pick<OpeningActionContext, 'summaryStore' | 'memoryDB'>) {
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

  ctx.clearNotification(false);
  recordGenerationDebug(ctx, 'opening:start', {
    generationId,
    hasPresetGenerate,
    hasRawGenerate,
    playerName: state.playerProfile.name,
    className: state.playerProfile.className ?? '',
    backgroundCount: state.playerProfile.backgrounds?.length ?? 0,
  });

  try {
    const streamingMessage = ensureStreamingMessage(ctx);
    const openingAssistantMessageId = streamingMessage.id;
    ctx.render();

    if (!hasPresetGenerate) {
      throw new Error('真实 AI 开场生成接口不可用。');
    }
    const userInput = buildOpeningPresetInput(state, ctx);
    // Opening generation must enter Tavern's preset stack; never use generateRaw/ordered_prompts here.
    const generateOpening = win.generate;
    const result = await generateOpening({
      should_stream: true,
      should_silence: true,
      generation_id: generationId,
      user_input: userInput,
    });

    if (abandonIfStale()) return false;
    recordGenerationDebug(ctx, 'opening:generate-returned', {
      generationId,
      resultLength: String(result ?? '').length,
    });
    const rawResult = String(result ?? '');

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
